const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

/* Allow Zavero website to connect */
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

/* Permanent PostgreSQL database */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/* Create database tables */
async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            email TEXT PRIMARY KEY,
            balance NUMERIC(12,2) NOT NULL DEFAULT 0
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            reference TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

/* Home */
app.get("/", (req, res) => {
    res.send("Zavero backend is working!");
});

/* Connection test */
app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "Zavero connection test is working!"
    });
});

/* Get user balance */
app.get("/balance", async (req, res) => {
    const email = req.query.email;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Email is required."
        });
    }

    try {
        const result = await pool.query(
            "SELECT balance FROM users WHERE email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            await pool.query(
                "INSERT INTO users (email, balance) VALUES ($1, 0)",
                [email]
            );

            return res.json({
                success: true,
                balance: 0
            });
        }

        res.json({
            success: true,
            balance: Number(result.rows[0].balance)
        });

    } catch (error) {
        console.error("Balance error:", error);

        res.status(500).json({
            success: false,
            message: "Could not get balance."
        });
    }
});

/* Payment success page */
app.get("/payment-success", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Zavero Payment</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>

        <body style="font-family: Arial; text-align: center; padding: 40px;">
            <h2>Checking payment...</h2>
            <p id="message">Please wait.</p>

            <script>
                const params =
                    new URLSearchParams(window.location.search);

                const reference =
                    params.get("reference");

                if (!reference) {
                    document.getElementById("message").innerText =
                        "Payment reference was not found.";
                } else {

                    fetch("/verify-payment", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            reference: reference
                        })
                    })
                    .then(response => response.json())
                    .then(data => {

                        if (data.success) {
                            document.getElementById("message").innerText =
                                data.message +
                                " Your balance is ₦" +
                                Number(data.balance || 0).toLocaleString();
                        } else {
                            document.getElementById("message").innerText =
                                data.message ||
                                "Payment could not be verified.";
                        }

                    })
                    .catch(error => {

                        console.error(
                            "Payment verification error:",
                            error
                        );

                        document.getElementById("message").innerText =
                            "Could not verify payment.";
                    });
                }
            </script>
        </body>
        </html>
    `);
});

/* Start Paystack payment */
app.post("/initialize-payment", async (req, res) => {

    const { name, email, amount } = req.body;

    if (!name || !email || !amount) {
        return res.status(400).json({
            success: false,
            message: "Name, email and amount are required."
        });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid amount."
        });
    }

    const secretKey =
        process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            success: false,
            message: "Paystack secret key is not configured."
        });
    }

    try {

        const response = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
                method: "POST",

                headers: {
                    "Authorization":
                        "Bearer " + secretKey,
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    email: email,
                    amount:
                        Math.round(numericAmount * 100),
                    currency: "NGN",

                    callback_url:
                        "https://zavero-earning-platform.onrender.com/payment-success"
                })
            }
        );

        const data =
            await response.json();

        if (!response.ok || !data.status) {

            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Could not start payment."
            });
        }

        res.json({
            success: true,

            authorization_url:
                data.data.authorization_url,

            reference:
                data.data.reference
        });

    } catch (error) {

        console.error(
            "Payment initialization error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not connect to Paystack."
        });
    }
});

/* Verify Paystack payment */
app.post("/verify-payment", async (req, res) => {

    const { reference } = req.body;

    if (!reference) {
        return res.status(400).json({
            success: false,
            message:
                "Payment reference is required."
        });
    }

    const secretKey =
        process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            success: false,
            message:
                "Paystack secret key is not configured."
        });
    }

    const client = await pool.connect();

    try {

        const response = await fetch(
            "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(reference),
            {
                method: "GET",

                headers: {
                    "Authorization":
                        "Bearer " + secretKey
                }
            }
        );

        const data =
            await response.json();

        if (!response.ok || !data.status) {

            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Payment verification failed."
            });
        }

        const transaction =
            data.data;

        if (transaction.status !== "success") {

            return res.json({
                success: false,
                message:
                    "Payment is not successful yet."
            });
        }

        if (transaction.currency !== "NGN") {

            return res.json({
                success: false,
                message:
                    "Wrong payment currency."
            });
        }

        const email =
            transaction.customer.email;

        const amount =
            transaction.amount / 100;

        await client.query("BEGIN");

        const existingPayment = await client.query(
            "SELECT reference FROM payments WHERE reference = $1",
            [reference]
        );

        if (existingPayment.rows.length > 0) {

            await client.query("ROLLBACK");

            const balanceResult = await pool.query(
                "SELECT balance FROM users WHERE email = $1",
                [email]
            );

            return res.json({
                success: true,
                message:
                    "Payment was already credited.",

                reference: reference,

                amount: amount,

                currency: "NGN",

                balance:
                    Number(
                        balanceResult.rows[0]?.balance || 0
                    )
            });
        }

        await client.query(
            `INSERT INTO users (email, balance)
             VALUES ($1, $2)
             ON CONFLICT (email)
             DO UPDATE SET balance =
                 users.balance + $2`,
            [email, amount]
        );

        await client.query(
            `INSERT INTO payments
             (reference, email, amount)
             VALUES ($1, $2, $3)`,
            [reference, email, amount]
        );

        const balanceResult =
            await client.query(
                "SELECT balance FROM users WHERE email = $1",
                [email]
            );

        await client.query("COMMIT");

        res.json({
            success: true,

            message:
                "Payment verified and balance credited.",

            reference: reference,

            amount: amount,

            currency: "NGN",

            balance:
                Number(balanceResult.rows[0].balance)
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "Verify payment error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not verify payment."
        });

    } finally {

        client.release();
    }
});

/* Start server */
const PORT =
    process.env.PORT || 3000;

app.listen(PORT, async () => {

    console.log(
        "Zavero backend running on port " + PORT
    );

    try {

        await setupDatabase();

        console.log(
            "PostgreSQL database is ready."
        );

    } catch (error) {

        console.error(
            "Database setup error:",
            error
        );
    }
});
