const express = require("express");

const app = express();

app.use(express.json());

/* Allow website to connect */
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

/* Home */
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
                const params = new URLSearchParams(window.location.search);
                const reference = params.get("reference");

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
                                "Payment verified successfully. You can return to Zavero.";
                        } else {
                            document.getElementById("message").innerText =
                                data.message || "Payment could not be verified.";
                        }
                    })
                    .catch(error => {
                        document.getElementById("message").innerText =
                            "Could not verify payment.";
                    });
                }
            </script>
        </body>
        </html>
    `);
});
app.get("/payment-success", (req, res) => {
    res.send("Payment completed. You can return to Zavero.");
});
/* Connection test */
app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "Zavero connection test is working!"
    });
});

/* Paystack: Start payment */
app.post("/initialize-payment", async (req, res) => {
    const { name, email, amount } = req.body;

    if (!name || !email || !amount) {
        return res.status(400).json({
            success: false,
            message: "Name, email and amount are required."
        });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

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
                    "Authorization": "Bearer " + secretKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
    email: email,
    amount: Math.round(Number(amount) * 100),
    currency: "NGN",
    callback_url: "https://zavero-earning-platform.onrender.com/payment-success"
})
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Could not start payment."
            });
        }

        res.json({
            success: true,
            authorization_url: data.data.authorization_url,
            reference: data.data.reference
        });

    } catch (error) {
        console.error("Payment initialization error:", error);

        res.status(500).json({
            success: false,
            message: "Could not connect to Paystack."
        });
    }
});

/* Verify Paystack payment */
/* Store verified balances */
const userBalances = {};
const verifiedPayments = new Set();

/* Verify Paystack payment */
app.post("/verify-payment", async (req, res) => {
    const { reference } = req.body;

    if (!reference) {
        return res.status(400).json({
            success: false,
            message: "Payment reference is required."
        });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            success: false,
            message: "Paystack secret key is not configured."
        });
    }

    try {
        const response = await fetch(
            "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(reference),
            {
                method: "GET",
                headers: {
                    "Authorization": "Bearer " + secretKey
                }
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Payment verification failed."
            });
        }

        const transaction = data.data;

        if (transaction.status !== "success") {
            return res.json({
                success: false,
                message: "Payment is not successful yet."
            });
        }

        if (transaction.currency !== "NGN") {
            return res.json({
                success: false,
                message: "Wrong payment currency."
            });
        }

        const email = transaction.customer.email;
        const amount = transaction.amount / 100;

        /* Stop the same payment being credited twice */
        if (verifiedPayments.has(reference)) {
            return res.json({
                success: true,
                message: "Payment was already credited.",
                reference: reference,
                amount: amount,
                currency: "NGN",
                balance: userBalances[email] || 0
            });
        }

        /* Credit the verified payment */
        userBalances[email] =
            (userBalances[email] || 0) + amount;

        verifiedPayments.add(reference);

        res.json({
            success: true,
            message: "Payment verified and balance credited.",
            reference: reference,
            amount: amount,
            currency: "NGN",
            balance: userBalances[email]
        });

    } catch (error) {
        console.error(
            "Verify payment error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Could not verify payment."
        });
    }
});
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            success: false,
            message: "Paystack secret key is not configured."
        });
    }

    try {
        const response = await fetch(
            "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(reference),
            {
                method: "GET",
                headers: {
                    "Authorization": "Bearer " + secretKey
                }
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Payment verification failed."
            });
        }

        const transaction = data.data;

        if (transaction.status !== "success") {
            return res.json({
                success: false,
                message: "Payment is not successful yet."
            });
        }

        if (transaction.currency !== "NGN") {
            return res.json({
                success: false,
                message: "Wrong payment currency."
            });
        }

        if (
            amount &&
            Number(transaction.amount) !== Number(amount) * 100
        ) {
            return res.json({
                success: false,
                message: "Payment amount does not match."
            });
        }

        res.json({
            success: true,
            message: "Payment verified successfully.",
            reference: transaction.reference,
            amount: transaction.amount / 100,
            currency: transaction.currency
        });

    } catch (error) {
        console.error("Verify payment error:", error);

        res.status(500).json({
            success: false,
            message: "Could not verify payment."
        });
    }
});

/* Start server */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Zavero backend running on port ${PORT}`);
});
