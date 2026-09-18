const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =====================================================
// PAYSTACK
// =====================================================

const PAYSTACK_SECRET_KEY =
    process.env.PAYSTACK_SECRET_KEY || "";

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform-1.onrender.com";

// =====================================================
// POSTGRESQL DATABASE
// =====================================================

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not configured.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

// =====================================================
// VIP PLANS
// =====================================================

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

// =====================================================
// PASSWORD HASHING
// Uses Node.js built-in crypto.
// No password is stored as plain text.
// =====================================================

function hashPassword(password) {

    return new Promise((resolve, reject) => {

        const salt =
            crypto.randomBytes(16).toString("hex");

        crypto.scrypt(
            password,
            salt,
            64,
            (error, derivedKey) => {

                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    salt +
                    ":" +
                    derivedKey.toString("hex")
                );
            }
        );
    });
}

function verifyPassword(password, storedPassword) {

    return new Promise((resolve, reject) => {

        try {

            const parts =
                String(storedPassword).split(":");

            if (parts.length !== 2) {
                resolve(false);
                return;
            }

            const salt = parts[0];
            const storedHash =
                Buffer.from(parts[1], "hex");

            crypto.scrypt(
                password,
                salt,
                64,
                (error, derivedKey) => {

                    if (error) {
                        reject(error);
                        return;
                    }

                    if (
                        storedHash.length !==
                        derivedKey.length
                    ) {
                        resolve(false);
                        return;
                    }

                    resolve(
                        crypto.timingSafeEqual(
                            storedHash,
                            derivedKey
                        )
                    );
                }
            );

        } catch (error) {
            resolve(false);
        }
    });
}

// =====================================================
// DATABASE SETUP
// =====================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance NUMERIC(14,2) NOT NULL DEFAULT 0,
            vip_level INTEGER NOT NULL DEFAULT 0,
            last_vip_claim TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            reference VARCHAR(255) UNIQUE NOT NULL,
            email VARCHAR(255) NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'success',
            verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    console.log("Zavero PostgreSQL database is ready.");
}

// =====================================================
// HOME / TEST
// =====================================================

app.get("/", (req, res) => {

    res.send("Zavero backend is working");
});

app.get("/test", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            success: true,
            message: "Zavero connection test is working",
            database: "connected"
        });

    } catch (error) {

        console.error("Database test error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed."
        });
    }
});

// =====================================================
// SIGN UP
// =====================================================

app.post("/signup", async (req, res) => {

    try {

        const name =
            String(req.body.name || "").trim();

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        if (!name || !email || !password) {

            return res.json({
                success: false,
                message:
                    "Name, email and password are required."
            });
        }

        if (name.length < 2) {

            return res.json({
                success: false,
                message:
                    "Name must contain at least 2 characters."
            });
        }

        if (password.length < 6) {

            return res.json({
                success: false,
                message:
                    "Password must contain at least 6 characters."
            });
        }

        const existing =
            await pool.query(
                "SELECT id FROM users WHERE email = $1",
                [email]
            );

        if (existing.rows.length > 0) {

            return res.json({
                success: false,
                message:
                    "An account with this email already exists."
            });
        }

        const passwordHash =
            await hashPassword(password);

        const result =
            await pool.query(
                `
                INSERT INTO users
                    (name, email, password_hash)
                VALUES
                    ($1, $2, $3)
                RETURNING
                    id,
                    name,
                    email,
                    balance,
                    vip_level
                `,
                [
                    name,
                    email,
                    passwordHash
                ]
            );

        const user =
            result.rows[0];

        res.json({
            success: true,
            message:
                "Zavero account created successfully.",
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance),
                vipLevel: user.vip_level
            }
        });

    } catch (error) {

        console.error("Signup error:", error);

        res.status(500).json({
            success: false,
            message:
                "Could not create your account."
        });
    }
});

// =====================================================
// LOGIN
// =====================================================

app.post("/login", async (req, res) => {

    try {

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        if (!email || !password) {

            return res.json({
                success: false,
                message:
                    "Email and password are required."
            });
        }

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    name,
                    email,
                    password_hash,
                    balance,
                    vip_level
                FROM users
                WHERE email = $1
                `,
                [email]
            );

        if (result.rows.length === 0) {

            return res.json({
                success: false,
                message:
                    "Invalid email or password."
            });
        }

        const user =
            result.rows[0];

        const passwordCorrect =
            await verifyPassword(
                password,
                user.password_hash
            );

        if (!passwordCorrect) {

            return res.json({
                success: false,
                message:
                    "Invalid email or password."
            });
        }

        res.json({
            success: true,
            message:
                "Login successful.",
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance),
                vipLevel: user.vip_level
            }
        });

    } catch (error) {

        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message:
                "Could not log in."
        });
    }
});

// =====================================================
// GET BALANCE
// =====================================================

app.get("/balance", async (req, res) => {

    try {

        const email =
            String(req.query.email || "")
                .trim()
                .toLowerCase();

        if (!email) {

            return res.json({
                success: false,
                message:
                    "Email is required."
            });
        }

        const result =
            await pool.query(
                `
                SELECT
                    balance,
                    vip_level
                FROM users
                WHERE email = $1
                `,
                [email]
            );

        if (result.rows.length === 0) {

            return res.json({
                success: false,
                message:
                    "User account not found."
            });
        }

        const user =
            result.rows[0];

        res.json({
            success: true,
            balance: Number(user.balance),
            vipLevel: Number(user.vip_level)
        });

    } catch (error) {

        console.error("Balance error:", error);

        res.status(500).json({
            success: false,
            message:
                "Could not load wallet balance."
        });
    }
});

// =====================================================
// INITIALIZE PAYSTACK PAYMENT
// =====================================================

app.post("/initialize-payment", async (req, res) => {

    try {

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const amount =
            Number(req.body.amount);

        if (!email || !amount) {

            return res.json({
                success: false,
                message:
                    "Email and amount are required."
            });
        }

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.json({
                success: false,
                message:
                    "Invalid deposit amount."
            });
        }

        const user =
            await pool.query(
                "SELECT id FROM users WHERE email = $1",
                [email]
            );

        if (user.rows.length === 0) {

            return res.json({
                success: false,
                message:
                    "User account not found."
            });
        }

        if (!PAYSTACK_SECRET_KEY) {

            return res.json({
                success: false,
                message:
                    "Paystack secret key is not configured."
            });
        }

        const response =
            await fetch(
                "https://api.paystack.co/transaction/initialize",
                {
                    method: "POST",

                    headers: {
                        Authorization:
                            "Bearer " +
                            PAYSTACK_SECRET_KEY,

                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        email: email,

                        amount: Math.round(
                            amount * 100
                        ),

                        callback_url:
                            SITE_URL +
                            "/payment-success"
                    })
                }
            );

        const data =
            await response.json();

        if (!data.status) {

            return res.json({
                success: false,
                message:
                    data.message ||
                    "Could not initialize payment."
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
            "Initialize payment error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not connect to Paystack."
        });
    }
});

// =====================================================
// VERIFY PAYSTACK PAYMENT
// =====================================================

app.get("/verify-payment", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const reference =
            String(
                req.query.reference || ""
            ).trim();

        const email =
            String(
                req.query.email || ""
            )
                .trim()
                .toLowerCase();

        if (!reference || !email) {

            return res.json({
                success: false,
                message:
                    "Payment reference and email are required."
            });
        }

        if (!PAYSTACK_SECRET_KEY) {

            return res.json({
                success: false,
                message:
                    "Paystack secret key is not configured."
            });
        }

        const response =
            await fetch(
                "https://api.paystack.co/transaction/verify/" +
                encodeURIComponent(reference),
                {
                    method: "GET",

                    headers: {
                        Authorization:
                            "Bearer " +
                            PAYSTACK_SECRET_KEY
                    }
                }
            );

        const data =
            await response.json();

        if (
            !data.status ||
            !data.data ||
            data.data.status !== "success"
        ) {

            return res.json({
                success: false,
                message:
                    "Payment has not been verified."
            });
        }

        const paidEmail =
            String(
                data.data.customer &&
                data.data.customer.email
                    ? data.data.customer.email
                    : ""
            )
                .trim()
                .toLowerCase();

        if (
            paidEmail &&
            paidEmail !== email
        ) {

            return res.json({
                success: false,
                message:
                    "Payment email does not match."
            });
        }

        const amount =
            Number(data.data.amount) / 100;

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.json({
                success: false,
                message:
                    "Invalid payment amount."
            });
        }

        await client.query("BEGIN");

        const existingPayment =
            await client.query(
                `
                SELECT
                    amount,
                    email
                FROM payments
                WHERE reference = $1
                FOR UPDATE
                `,
                [reference]
            );

        if (existingPayment.rows.length > 0) {

            const existing =
                existingPayment.rows[0];

            const currentUser =
                await client.query(
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
                message:
                    "Payment was already verified.",
                balance:
                    currentUser.rows.length
                        ? Number(currentUser.rows[0].balance)
                        : 0
            });
        }

        const user =
            await client.query(
                `
                SELECT balance
                FROM users
                WHERE email = $1
                FOR UPDATE
                `,
                [email]
            );

        if (user.rows.length === 0) {

            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "User account not found."
            });
        }

        const newBalance =
            Number(user.rows[0].balance) +
            amount;

        await client.query(
            `
            UPDATE users
            SET balance = $1
            WHERE email = $2
            `,
            [
                newBalance,
                email
            ]
        );

        await client.query(
            `
            INSERT INTO payments
                (reference, email, amount, status)
            VALUES
                ($1, $2, $3, 'success')
            `,
            [
                reference,
                email,
                amount
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message:
                "Payment verified successfully.",
            amount: amount,
            balance: newBalance
        });

    } catch (error) {

        try {
            await client.query("ROLLBACK");
        } catch (_) {}

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

// =====================================================
// PAYMENT SUCCESS PAGE
// =====================================================

app.get("/payment-success", (req, res) => {

    res.send(`
        <!DOCTYPE html>
        <html>

        <head>

            <meta charset="UTF-8">

            <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
            >

            <title>Zavero Payment</title>

            <style>

                body {
                    font-family: Arial, sans-serif;
                    background: #101426;
                    color: white;
                    text-align: center;
                    padding: 40px 20px;
                }

                .box {
                    max-width: 450px;
                    margin: auto;
                    background: #1b2140;
                    padding: 30px;
                    border-radius: 20px;
                }

                h1 {
                    color: #45e68b;
                }

                a {
                    display: inline-block;
                    margin-top: 20px;
                    padding: 14px 22px;
                    background: #5865f2;
                    color: white;
                    text-decoration: none;
                    border-radius: 10px;
                }

            </style>

        </head>

        <body>

            <div class="box">

                <h1>Payment Successful</h1>

                <p>
                    Your Paystack payment was received.
                </p>

                <p>
                    Return to Zavero and verify your payment
                    to update your wallet balance.
                </p>

                <a href="${SITE_URL}">
                    Return to Zavero
                </a>

            </div>

        </body>

        </html>
    `);
});

// =====================================================
// VIP UPGRADE
// =====================================================

app.post("/upgrade-vip", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const level =
            Number(req.body.level);

        if (!email || !level) {

            return res.json({
                success: false,
                message:
                    "Invalid VIP request."
            });
        }

        const vip =
            vipPlans[level];

        if (!vip) {

            return res.json({
                success: false,
                message:
                    "Invalid VIP level."
            });
        }

        await client.query("BEGIN");

        const result =
            await client.query(
                `
                SELECT
                    balance,
                    vip_level
                FROM users
                WHERE email = $1
                FOR UPDATE
                `,
                [email]
            );

        if (result.rows.length === 0) {

            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "User account not found."
            });
        }

        const user =
            result.rows[0];

        const balance =
            Number(user.balance);

        const price =
            Number(vip.price);

        if (balance < price) {

            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "Insufficient funds. " +
                    "You need ₦" +
                    price.toLocaleString() +
                    " to upgrade to VIP " +
                    level +
                    ".",
                balance: balance
            });
        }

        const newBalance =
            balance - price;

        await client.query(
            `
            UPDATE users
            SET
                balance = $1,
                vip_level = $2,
                last_vip_claim = NULL
            WHERE email = $3
            `,
            [
                newBalance,
                level,
                email
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,

            message:
                "VIP " +
                level +
                " upgrade successful! " +
                "₦" +
                price.toLocaleString() +
                " has been deducted from your wallet.",

            balance:
                newBalance,

            vipLevel:
                level,

            dailyReward:
                vip.dailyReward
        });

    } catch (error) {

        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error(
            "VIP upgrade error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not upgrade VIP."
        });

    } finally {

        client.release();
    }
});

// =====================================================
// CLAIM VIP DAILY REWARD
// =====================================================

app.post("/claim-vip", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        if (!email) {

            return res.json({
                success: false,
                message:
                    "Email is required."
            });
        }

        await client.query("BEGIN");

        const result =
            await client.query(
                `
                SELECT
                    balance,
                    vip_level,
                    last_vip_claim
                FROM users
                WHERE email = $1
                FOR UPDATE
                `,
                [email]
            );

        if (result.rows.length === 0) {

            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "User account not found."
            });
        }

        const user =
            result.rows[0];

        const level =
            Number(user.vip_level || 0);

        if (!level) {

            await client.query("ROLLBACK");

            return res.json({
                success: false,
                message:
                    "You do not have an active VIP."
            });
        }

        const vip =
            vipPlans[level];

        const now =
            Date.now();

        const previousClaim =
            user.last_vip_claim
                ? new Date(
                    user.last_vip_claim
                  ).getTime()
                : 0;

        const twentyFourHours =
            24 * 60 * 60 * 1000;

        if (
            previousClaim &&
            now - previousClaim <
                twentyFourHours
        ) {

            const remaining =
                twentyFourHours -
                (now - previousClaim);

            const hours =
                Math.ceil(
                    remaining /
                    (60 * 60 * 1000)
                );

            await client.query("ROLLBACK");

            return res.json({
                success: false,

                message:
                    "You have already claimed your VIP reward. " +
                    "Please wait about " +
                    hours +
                    " hour(s).",

                balance:
                    Number(user.balance)
            });
        }

        const newBalance =
            Number(user.balance) +
            Number(vip.dailyReward);

        await client.query(
            `
            UPDATE users
            SET
                balance = $1,
                last_vip_claim = NOW()
            WHERE email = $2
            `,
            [
                newBalance,
                email
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,

            message:
                "VIP " +
                level +
                " daily reward of ₦" +
                vip.dailyReward.toLocaleString() +
                " has been added to your wallet.",

            reward:
                vip.dailyReward,

            balance:
                newBalance,

            vipLevel:
                level
        });

    } catch (error) {

        try {
            await client.query("ROLLBACK");
        } catch (_) {}

        console.error(
            "VIP claim error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not claim VIP reward."
        });

    } finally {

        client.release();
    }
});

// =====================================================
// START SERVER
// =====================================================

async function startServer() {

    try {

        await setupDatabase();

        app.listen(PORT, () => {

            console.log(
                "Zavero backend running on port " +
                PORT
            );

        });

    } catch (error) {

        console.error(
            "Could not start Zavero backend:",
            error
        );

        process.exit(1);
    }
}

startServer();
