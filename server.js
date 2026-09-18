const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform-1.onrender.com";

if (!DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
    process.exit(1);
}

/* =========================================================
   POSTGRESQL DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/* =========================================================
   VIP PLANS
========================================================= */

const vipPlans = {
    1: {
        price: 1500,
        dailyReward: 200
    },
    2: {
        price: 5000,
        dailyReward: 800
    },
    3: {
        price: 10000,
        dailyReward: 1750
    },
    4: {
        price: 25000,
        dailyReward: 4100
    },
    5: {
        price: 50000,
        dailyReward: 7500
    },
    6: {
        price: 100000,
        dailyReward: 15000
    }
};

/* =========================================================
   DATABASE SETUP
========================================================= */

async function createTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance NUMERIC(15,2) NOT NULL DEFAULT 0,
            vip_level INTEGER NOT NULL DEFAULT 0,
            last_vip_claim TIMESTAMP NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            reference VARCHAR(255) UNIQUE NOT NULL,
            amount NUMERIC(15,2) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            verified_at TIMESTAMP NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            amount NUMERIC(15,2) NOT NULL,
            description TEXT,
            reference VARCHAR(255),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log("Database tables are ready.");
}

/* =========================================================
   PASSWORD SECURITY
========================================================= */

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(
                salt +
                ":" +
                derivedKey.toString("hex")
            );
        });
    });
}

function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        const parts = storedHash.split(":");

        if (parts.length !== 2) {
            resolve(false);
            return;
        }

        const salt = parts[0];
        const originalHash = Buffer.from(parts[1], "hex");

        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) {
                reject(err);
                return;
            }

            if (originalHash.length !== derivedKey.length) {
                resolve(false);
                return;
            }

            resolve(
                crypto.timingSafeEqual(
                    originalHash,
                    derivedKey
                )
            );
        });
    });
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Zavero backend is working"
    });
});

app.get("/test", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            success: true,
            message: "Zavero connection test is working",
            databaseTime: result.rows[0].now
        });
    } catch (error) {
        console.error("Database test error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});

/* =========================================================
   SIGN UP
========================================================= */

app.post("/signup", async (req, res) => {
    try {
        const {
            name,
            email,
            password
        } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required."
            });
        }

        const cleanName = String(name).trim();
        const cleanEmail = String(email).trim().toLowerCase();

        if (cleanName.length < 2) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid name."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters."
            });
        }

        const existingUser = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [cleanEmail]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            `
            INSERT INTO users
                (name, email, password_hash)
            VALUES
                ($1, $2, $3)
            RETURNING id, name, email, balance, vip_level
            `,
            [
                cleanName,
                cleanEmail,
                passwordHash
            ]
        );

        const user = result.rows[0];

        res.json({
            success: true,
            message: "Account created successfully.",
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance),
                vipLevel: Number(user.vip_level)
            }
        });

    } catch (error) {
        console.error("Signup error:", error);

        res.status(500).json({
            success: false,
            message: "Could not create account."
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/login", async (req, res) => {
    try {
        const {
            email,
            password
        } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required."
            });
        }

        const cleanEmail = String(email).trim().toLowerCase();

        const result = await pool.query(
            `
            SELECT
                id,
                name,
                email,
                password_hash,
                balance,
                vip_level,
                last_vip_claim
            FROM users
            WHERE email = $1
            `,
            [cleanEmail]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = result.rows[0];

        const passwordCorrect = await verifyPassword(
            password,
            user.password_hash
        );

        if (!passwordCorrect) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        res.json({
            success: true,
            message: "Login successful.",
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance),
                vipLevel: Number(user.vip_level),
                lastVIPClaim: user.last_vip_claim
            }
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Could not log in."
        });
    }
});

/* =========================================================
   GET BALANCE + VIP STATUS
========================================================= */

app.get("/balance", async (req, res) => {
    try {
        const email = String(req.query.email || "")
            .trim()
            .toLowerCase();

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                name,
                email,
                balance,
                vip_level,
                last_vip_claim
            FROM users
            WHERE email = $1
            `,
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = result.rows[0];

        const level = Number(user.vip_level);

        res.json({
            success: true,
            name: user.name,
            email: user.email,
            balance: Number(user.balance),
            vipLevel: level,
            dailyReward:
                level > 0
                    ? vipPlans[level].dailyReward
                    : 0,
            lastVIPClaim: user.last_vip_claim
        });

    } catch (error) {
        console.error("Balance error:", error);

        res.status(500).json({
            success: false,
            message: "Could not load balance."
        });
    }
});

/* =========================================================
   PAYSTACK INITIALIZE PAYMENT
========================================================= */

app.post("/initialize-payment", async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                message: "Paystack secret key is not configured."
            });
        }

        const {
            email,
            amount
        } = req.body;

        if (!email || !amount) {
            return res.status(400).json({
                success: false,
                message: "Email and amount are required."
            });
        }

        const numericAmount = Number(amount);

        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment amount."
            });
        }

        const cleanEmail = String(email)
            .trim()
            .toLowerCase();

        const userResult = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [cleanEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found."
            });
        }

        const response = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
                method: "POST",
                headers: {
                    Authorization:
                        "Bearer " + PAYSTACK_SECRET_KEY,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: cleanEmail,
                    amount: Math.round(numericAmount * 100),
                    callback_url:
                        SITE_URL + "/payment-success"
                })
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            console.error("Paystack initialize error:", data);

            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Could not initialize payment."
            });
        }

        await pool.query(
            `
            INSERT INTO payments
                (user_email, reference, amount, status)
            VALUES
                ($1, $2, $3, 'pending')
            ON CONFLICT (reference)
            DO NOTHING
            `,
            [
                cleanEmail,
                data.data.reference,
                numericAmount
            ]
        );

        res.json({
            success: true,
            authorization_url:
                data.data.authorization_url,
            access_code:
                data.data.access_code,
            reference:
                data.data.reference
        });

    } catch (error) {
        console.error("Initialize payment error:", error);

        res.status(500).json({
            success: false,
            message: "Payment initialization failed."
        });
    }
});

/* =========================================================
   PAYSTACK VERIFY PAYMENT
========================================================= */

app.get("/verify-payment", async (req, res) => {
    const client = await pool.connect();

    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                message: "Paystack secret key is not configured."
            });
        }

        const reference = String(
            req.query.reference || ""
        ).trim();

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: "Payment reference is required."
            });
        }

        const response = await fetch(
            "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(reference),
            {
                method: "GET",
                headers: {
                    Authorization:
                        "Bearer " + PAYSTACK_SECRET_KEY
                }
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Payment verification failed."
            });
        }

        const payment = data.data;

        if (payment.status !== "success") {
            return res.json({
                success: false,
                message: "Payment has not been completed.",
                paymentStatus: payment.status
            });
        }

        const paidAmount =
            Number(payment.amount) / 100;

        const email =
            String(payment.customer.email)
                .trim()
                .toLowerCase();

        await client.query("BEGIN");

        const existingPayment =
            await client.query(
                `
                SELECT
                    id,
                    user_email,
                    amount,
                    status
                FROM payments
                WHERE reference = $1
                FOR UPDATE
                `,
                [reference]
            );

        if (existingPayment.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "Payment record not found."
            });
        }

        const paymentRecord =
            existingPayment.rows[0];

        if (paymentRecord.status === "verified") {
            const userResult = await client.query(
                `
                SELECT balance
                FROM users
                WHERE email = $1
                `,
                [email]
            );

            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Payment was already verified.",
                reference,
                amount: paidAmount,
                balance:
                    userResult.rows.length
                        ? Number(userResult.rows[0].balance)
                        : 0
            });
        }

        if (
            paymentRecord.user_email !== email
        ) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "Payment email does not match the account."
            });
        }

        if (
            Number(paymentRecord.amount) !==
            paidAmount
        ) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "Payment amount does not match the payment record."
            });
        }

        const userResult = await client.query(
            `
            UPDATE users
            SET balance = balance + $1
            WHERE email = $2
            RETURNING balance
            `,
            [
                paidAmount,
                email
            ]
        );

        if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "User account not found."
            });
        }

        await client.query(
            `
            UPDATE payments
            SET
                status = 'verified',
                verified_at = CURRENT_TIMESTAMP
            WHERE reference = $1
            `,
            [reference]
        );

        await client.query(
            `
            INSERT INTO transactions
                (
                    user_email,
                    type,
                    amount,
                    description,
                    reference
                )
            VALUES
                (
                    $1,
                    'deposit',
                    $2,
                    'Paystack deposit',
                    $3
                )
            `,
            [
                email,
                paidAmount,
                reference
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Payment verified successfully.",
            reference,
            amount: paidAmount,
            balance:
                Number(userResult.rows[0].balance)
        });

    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("Verify payment error:", error);

        res.status(500).json({
            success: false,
            message: "Payment verification failed."
        });

    } finally {
        client.release();
    }
});

/* =========================================================
   PAYMENT SUCCESS PAGE
========================================================= */

app.get("/payment-success", (req, res) => {
    const reference =
        req.query.reference || "";

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport"
                content="width=device-width, initial-scale=1.0">
            <title>Zavero Payment</title>

            <style>
                body {
                    margin: 0;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background:
                        linear-gradient(
                            135deg,
                            #07152f,
                            #24105c,
                            #003f5c
                        );
                    color: white;
                    font-family: Arial, sans-serif;
                    text-align: center;
                }

                .box {
                    width: 85%;
                    max-width: 450px;
                    padding: 35px;
                    border-radius: 22px;
                    background: rgba(255,255,255,0.08);
                    box-shadow:
                        0 20px 50px rgba(0,0,0,0.4);
                }

                h1 {
                    color: #43e487;
                }

                p {
                    line-height: 1.6;
                }

                a {
                    display: inline-block;
                    margin-top: 20px;
                    padding: 13px 25px;
                    border-radius: 12px;
                    background: #43e487;
                    color: #061526;
                    text-decoration: none;
                    font-weight: bold;
                }
            </style>
        </head>

        <body>
            <div class="box">
                <h1>Payment Successful</h1>

                <p>
                    Your Paystack payment has been
                    completed.
                </p>

                <p>
                    Reference:
                    ${escapeHtml(String(reference))}
                </p>

                <a href="${escapeHtml(SITE_URL)}">
                    Return to Zavero
                </a>
            </div>
        </body>
        </html>
    `);
});

/* =========================================================
   UPGRADE VIP
========================================================= */

app.post("/upgrade-vip", async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            email,
            level
        } = req.body;

        const cleanEmail =
            String(email || "")
                .trim()
                .toLowerCase();

        const vipLevel = Number(level);

        if (!cleanEmail || !vipPlans[vipLevel]) {
            return res.status(400).json({
                success: false,
                message: "Valid email and VIP level are required."
            });
        }

        await client.query("BEGIN");

        const userResult = await client.query(
            `
            SELECT
                balance,
                vip_level
            FROM users
            WHERE email = $1
            FOR UPDATE
            `,
            [cleanEmail]
        );

        if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = userResult.rows[0];

        const currentVIP =
            Number(user.vip_level);

        const plan = vipPlans[vipLevel];

        if (currentVIP >= vipLevel) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "You already have this VIP level or a higher level."
            });
        }

        const balance =
            Number(user.balance);

        if (balance < plan.price) {
            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "Insufficient funds. Please add money to your wallet first."
            });
        }

        const newBalance =
            balance - plan.price;

        const updateResult =
            await client.query(
                `
                UPDATE users
                SET
                    balance = $1,
                    vip_level = $2,
                    last_vip_claim = NULL
                WHERE email = $3
                RETURNING balance, vip_level
                `,
                [
                    newBalance,
                    vipLevel,
                    cleanEmail
                ]
            );

        await client.query(
            `
            INSERT INTO transactions
                (
                    user_email,
                    type,
                    amount,
                    description
                )
            VALUES
                (
                    $1,
                    'vip_upgrade',
                    $2,
                    $3
                )
            `,
            [
                cleanEmail,
                plan.price,
                "VIP " + vipLevel + " upgrade"
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message:
                "VIP " + vipLevel + " activated successfully.",
            balance:
                Number(updateResult.rows[0].balance),
            vipLevel:
                Number(updateResult.rows[0].vip_level),
            dailyReward:
                plan.dailyReward
        });

    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("VIP upgrade error:", error);

        res.status(500).json({
            success: false,
            message: "Could not upgrade VIP."
        });

    } finally {
        client.release();
    }
});

/* =========================================================
   CLAIM VIP DAILY REWARD
========================================================= */

app.post("/claim-vip", async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            email
        } = req.body;

        const cleanEmail =
            String(email || "")
                .trim()
                .toLowerCase();

        if (!cleanEmail) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        await client.query("BEGIN");

        const result = await client.query(
            `
            SELECT
                balance,
                vip_level,
                last_vip_claim
            FROM users
            WHERE email = $1
            FOR UPDATE
            `,
            [cleanEmail]
        );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = result.rows[0];

        const level =
            Number(user.vip_level);

        if (level <= 0 || !vipPlans[level]) {
            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "You need an active VIP plan before claiming a reward."
            });
        }

        const reward =
            vipPlans[level].dailyReward;

        if (user.last_vip_claim) {
            const lastClaim =
                new Date(user.last_vip_claim);

            const now =
                new Date();

            const hoursPassed =
                (now - lastClaim) /
                (1000 * 60 * 60);

            if (hoursPassed < 24) {
                const remaining =
                    24 - hoursPassed;

                await client.query("ROLLBACK");

                return res.json({
                    success: false,
                    message:
                        "Your next VIP reward is not ready yet.",
                    hoursRemaining:
                        Math.ceil(remaining)
                });
            }
        }

        const updateResult =
            await client.query(
                `
                UPDATE users
                SET
                    balance = balance + $1,
                    last_vip_claim = CURRENT_TIMESTAMP
                WHERE email = $2
                RETURNING
                    balance,
                    vip_level,
                    last_vip_claim
                `,
                [
                    reward,
                    cleanEmail
                ]
            );

        await client.query(
            `
            INSERT INTO transactions
                (
                    user_email,
                    type,
                    amount,
                    description
                )
            VALUES
                (
                    $1,
                    'vip_reward',
                    $2,
                    $3
                )
            `,
            [
                cleanEmail,
                reward,
                "VIP " + level + " daily reward"
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message:
                "VIP daily reward claimed successfully.",
            reward,
            balance:
                Number(updateResult.rows[0].balance),
            vipLevel:
                Number(updateResult.rows[0].vip_level),
            lastVIPClaim:
                updateResult.rows[0].last_vip_claim
        });

    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error("VIP claim error:", error);

        res.status(500).json({
            success: false,
            message:
                "Could not claim VIP reward."
        });

    } finally {
        client.release();
    }
});

/* =========================================================
   TRANSACTION HISTORY
========================================================= */

app.get("/transactions", async (req, res) => {
    try {
        const email =
            String(req.query.email || "")
                .trim()
                .toLowerCase();

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                type,
                amount,
                description,
                reference,
                created_at
            FROM transactions
            WHERE user_email = $1
            ORDER BY created_at DESC
            LIMIT 100
            `,
            [email]
        );

        res.json({
            success: true,
            transactions:
                result.rows.map(row => ({
                    id: row.id,
                    type: row.type,
                    amount: Number(row.amount),
                    description: row.description,
                    reference: row.reference,
                    createdAt: row.created_at
                }))
        });

    } catch (error) {
        console.error("Transactions error:", error);

        res.status(500).json({
            success: false,
            message:
                "Could not load transactions."
        });
    }
});

/* =========================================================
   HELPER
========================================================= */

function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
    try {
        await pool.query("SELECT NOW()");
        console.log("PostgreSQL connection successful.");

        await createTables();

        app.listen(PORT, () => {
            console.log(
                "Zavero server running on port " + PORT
            );
        });

    } catch (error) {
        console.error(
            "Could not start Zavero server:",
            error
        );

        process.exit(1);
    }
}

startServer();
