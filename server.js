const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform-1.onrender.com";

if (!DATABASE_URL) {
    console.log("WARNING: DATABASE_URL is not configured.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


// ============================================
// VIP PLANS
// ============================================

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


// ============================================
// PASSWORD FUNCTIONS
// ============================================

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(
                `${salt}:${derivedKey.toString("hex")}`
            );
        });
    });
}


function verifyPassword(password, storedPassword) {
    return new Promise((resolve, reject) => {
        try {
            const parts = storedPassword.split(":");

            if (parts.length !== 2) {
                resolve(false);
                return;
            }

            const salt = parts[0];
            const storedHash = Buffer.from(parts[1], "hex");

            crypto.scrypt(password, salt, 64, (err, derivedKey) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(
                    crypto.timingSafeEqual(
                        storedHash,
                        derivedKey
                    )
                );
            });
        } catch (error) {
            resolve(false);
        }
    });
}


// ============================================
// DATABASE SETUP
// ============================================

async function createTables() {
    if (!DATABASE_URL) {
        console.log("Database not configured.");
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance NUMERIC(14,2) DEFAULT 0,
            vip_level INTEGER DEFAULT 0,
            last_vip_claim TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            reference VARCHAR(255) UNIQUE NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            type VARCHAR(50) NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            description TEXT,
            reference VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log("Database tables are ready.");
}


// ============================================
// HOME
// ============================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Zavero backend is working"
    });
});


// ============================================
// TEST
// ============================================

app.get("/test", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS database_time"
        );

        res.json({
            success: true,
            message: "Zavero connection test is working",
            databaseTime: result.rows[0].database_time
        });

    } catch (error) {
        console.error("TEST ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});


// ============================================
// SIGN UP
// ============================================

app.post("/signup", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Please fill all fields."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters."
            });
        }

        const existing = await pool.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = $1
               OR LOWER(name) = $2
            LIMIT 1
            `,
            [email, name.toLowerCase()]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Name or email already exists."
            });
        }

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            `
            INSERT INTO users
            (name, email, password_hash, balance, vip_level)
            VALUES ($1, $2, $3, 0, 0)
            RETURNING
                id,
                name,
                email,
                balance,
                vip_level
            `,
            [name, email, passwordHash]
        );

        res.json({
            success: true,
            message: "Account created successfully.",
            user: result.rows[0]
        });

    } catch (error) {
        console.error("SIGNUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create account."
        });
    }
});


// ============================================
// LOGIN
// ============================================

app.post("/login", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim();
        const password = String(req.body.password || "");

        const loginValue = email || name;

        if (!loginValue || !password) {
            return res.status(400).json({
                success: false,
                message: "Enter your name/email and password."
            });
        }

        const value = loginValue.toLowerCase();

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
            WHERE LOWER(email) = $1
               OR LOWER(name) = $1
            LIMIT 1
            `,
            [value]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Account not found."
            });
        }

        const user = result.rows[0];

        const correctPassword = await verifyPassword(
            password,
            user.password_hash
        );

        if (!correctPassword) {
            return res.status(401).json({
                success: false,
                message: "Incorrect password."
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
                vip_level: user.vip_level,
                last_vip_claim: user.last_vip_claim
            }
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to login."
        });
    }
});


// ============================================
// BALANCE
// ============================================

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
                id,
                name,
                email,
                balance,
                vip_level,
                last_vip_claim
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
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

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance),
                vip_level: user.vip_level,
                last_vip_claim: user.last_vip_claim
            }
        });

    } catch (error) {
        console.error("BALANCE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load balance."
        });
    }
});


// ============================================
// PAYSTACK INITIALIZE PAYMENT
// ============================================

app.post("/initialize-payment", async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            console.error(
                "PAYSTACK_SECRET_KEY is missing."
            );

            return res.status(500).json({
                success: false,
                message: "Paystack secret key is not configured."
            });
        }

        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const amount = Number(req.body.amount);

        if (!email || !amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid email and amount."
            });
        }

        const userResult = await pool.query(
            `
            SELECT id, name, email
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
            `,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found."
            });
        }

        const reference =
            "ZAVERO_" +
            Date.now() +
            "_" +
            crypto.randomBytes(5).toString("hex");

        const paystackResponse = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${PAYSTACK_SECRET_KEY}`,
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    email: email,
                    amount: Math.round(amount * 100),
                    reference: reference,

                    callback_url:
                        `${SITE_URL}/payment-success?reference=${encodeURIComponent(reference)}`
                })
            }
        );

        const data = await paystackResponse.json();

        console.log(
            "PAYSTACK INITIALIZE:",
            JSON.stringify(data)
        );

        if (!paystackResponse.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Paystack could not initialize payment."
            });
        }

        await pool.query(
            `
            INSERT INTO payments
            (user_id, reference, amount, status)
            VALUES ($1, $2, $3, 'pending')
            `,
            [
                userResult.rows[0].id,
                reference,
                amount
            ]
        );

        res.json({
            success: true,
            message: "Payment initialized.",
            authorization_url:
                data.data.authorization_url,
            reference: reference
        });

    } catch (error) {
        console.error(
            "INITIALIZE PAYMENT ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to connect to Paystack."
        });
    }
});


// ============================================
// VERIFY PAYSTACK PAYMENT
// ============================================

app.get("/verify-payment", async (req, res) => {
    try {
        if (!PAYSTACK_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                message: "Paystack secret key is not configured."
            });
        }

        const reference =
            String(req.query.reference || "").trim();

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: "Payment reference is required."
            });
        }

        const paystackResponse = await fetch(
            `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
            {
                method: "GET",
                headers: {
                    Authorization:
                        `Bearer ${PAYSTACK_SECRET_KEY}`
                }
            }
        );

        const data = await paystackResponse.json();

        if (!paystackResponse.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message:
                    data.message ||
                    "Unable to verify payment."
            });
        }

        const paymentData = data.data;

        if (paymentData.status !== "success") {
            return res.json({
                success: false,
                message:
                    `Payment status: ${paymentData.status}`
            });
        }

        const paymentResult = await pool.query(
            `
            SELECT *
            FROM payments
            WHERE reference = $1
            LIMIT 1
            `,
            [reference]
        );

        if (paymentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Payment record not found."
            });
        }

        const payment = paymentResult.rows[0];

        // Prevent double crediting
        if (payment.status === "success") {
            const userResult = await pool.query(
                `
                SELECT balance
                FROM users
                WHERE id = $1
                `,
                [payment.user_id]
            );

            return res.json({
                success: true,
                message: "Payment already verified.",
                balance:
                    Number(userResult.rows[0].balance)
            });
        }

        const amountNaira =
            Number(paymentData.amount) / 100;

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            await client.query(
                `
                UPDATE payments
                SET status = 'success'
                WHERE reference = $1
                `,
                [reference]
            );

            const updatedUser =
                await client.query(
                    `
                    UPDATE users
                    SET balance = balance + $1
                    WHERE id = $2
                    RETURNING balance
                    `,
                    [
                        amountNaira,
                        payment.user_id
                    ]
                );

            await client.query(
                `
                INSERT INTO transactions
                (user_id, type, amount, description, reference)
                VALUES
                ($1, 'deposit', $2, 'Paystack deposit', $3)
                `,
                [
                    payment.user_id,
                    amountNaira,
                    reference
                ]
            );

            await client.query("COMMIT");

            res.json({
                success: true,
                message:
                    "Payment verified and balance updated.",
                amount: amountNaira,
                balance:
                    Number(updatedUser.rows[0].balance)
            });

        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(
            "VERIFY PAYMENT ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to verify payment."
        });
    }
});


// ============================================
// PAYMENT SUCCESS PAGE
// ============================================

app.get("/payment-success", (req, res) => {
    const reference =
        String(req.query.reference || "");

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport"
                content="width=device-width,initial-scale=1">
            <title>Zavero Payment</title>

            <style>
                body {
                    margin: 0;
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background:
                        linear-gradient(
                            135deg,
                            #08152f,
                            #17104b,
                            #063f56
                        );
                    font-family: Arial, sans-serif;
                    color: white;
                }

                .box {
                    width: 90%;
                    max-width: 420px;
                    text-align: center;
                    padding: 30px;
                    border-radius: 20px;
                    background: rgba(255,255,255,.10);
                    box-shadow:
                        0 20px 50px rgba(0,0,0,.35);
                }

                button {
                    border: 0;
                    padding: 14px 25px;
                    border-radius: 12px;
                    background: #00d4ff;
                    color: #06111f;
                    font-weight: bold;
                    cursor: pointer;
                }
            </style>
        </head>

        <body>

            <div class="box">
                <h2>Checking Payment...</h2>
                <p id="message">
                    Please wait while we verify your payment.
                </p>

                <button
                    onclick="window.history.back()">
                    Return
                </button>
            </div>

            <script>
                const reference =
                    ${JSON.stringify(reference)};

                async function verify() {
                    try {
                        const response =
                            await fetch(
                                "/verify-payment?reference=" +
                                encodeURIComponent(reference)
                            );

                        const data =
                            await response.json();

                        if (data.success) {
                            document.getElementById(
                                "message"
                            ).textContent =
                                "Payment successful! Your Zavero balance has been updated.";
                        } else {
                            document.getElementById(
                                "message"
                            ).textContent =
                                data.message ||
                                "Payment could not be verified.";
                        }

                    } catch (error) {
                        document.getElementById(
                            "message"
                        ).textContent =
                            "Unable to verify payment.";
                    }
                }

                verify();
            </script>

        </body>
        </html>
    `);
});


// ============================================
// UPGRADE VIP
// ============================================

app.post("/upgrade-vip", async (req, res) => {
    try {
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const level = Number(req.body.level);

        if (!email || !vipPlans[level]) {
            return res.status(400).json({
                success: false,
                message: "Invalid VIP request."
            });
        }

        const plan = vipPlans[level];

        const userResult = await pool.query(
            `
            SELECT id, balance, vip_level
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
            `,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = userResult.rows[0];

        if (Number(user.balance) < plan.price) {
            return res.status(400).json({
                success: false,
                message:
                    "Insufficient balance for this VIP plan."
            });
        }

        if (Number(user.vip_level) >= level) {
            return res.status(400).json({
                success: false,
                message:
                    "You already have this VIP level or higher."
            });
        }

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance = balance - $1,
                        vip_level = $2,
                        last_vip_claim = NULL
                    WHERE id = $3
                    RETURNING balance, vip_level
                    `,
                    [
                        plan.price,
                        level,
                        user.id
                    ]
                );

            await client.query(
                `
                INSERT INTO transactions
                (user_id, type, amount, description)
                VALUES
                ($1, 'vip_upgrade', $2, $3)
                `,
                [
                    user.id,
                    plan.price,
                    `VIP ${level} upgrade`
                ]
            );

            await client.query("COMMIT");

            res.json({
                success: true,
                message:
                    `VIP ${level} activated successfully.`,
                balance:
                    Number(updated.rows[0].balance),
                vip_level:
                    Number(updated.rows[0].vip_level)
            });

        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(
            "VIP UPGRADE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to upgrade VIP."
        });
    }
});


// ============================================
// CLAIM VIP REWARD
// ============================================

app.post("/claim-vip", async (req, res) => {
    try {
        const email = String(req.body.email || "")
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
                balance,
                vip_level,
                last_vip_claim
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
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

        if (!vipPlans[level]) {
            return res.status(400).json({
                success: false,
                message:
                    "You need an active VIP plan before claiming."
            });
        }

        if (user.last_vip_claim) {
            const lastClaim =
                new Date(user.last_vip_claim);

            const now = new Date();

            const hours =
                (now - lastClaim) /
                (1000 * 60 * 60);

            if (hours < 24) {
                const remaining =
                    Math.ceil(24 - hours);

                return res.status(400).json({
                    success: false,
                    message:
                        `Your next reward is available in about ${remaining} hour(s).`
                });
            }
        }

        const reward =
            vipPlans[level].dailyReward;

        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const updated =
                await client.query(
                    `
                    UPDATE users
                    SET
                        balance = balance + $1,
                        last_vip_claim = CURRENT_TIMESTAMP
                    WHERE id = $2
                    RETURNING balance, last_vip_claim
                    `,
                    [
                        reward,
                        user.id
                    ]
                );

            await client.query(
                `
                INSERT INTO transactions
                (user_id, type, amount, description)
                VALUES
                ($1, 'vip_reward', $2, $3)
                `,
                [
                    user.id,
                    reward,
                    `VIP ${level} daily reward`
                ]
            );

            await client.query("COMMIT");

            res.json({
                success: true,
                message:
                    `₦${reward.toLocaleString()} VIP reward claimed.`,
                reward: reward,
                balance:
                    Number(updated.rows[0].balance),
                last_vip_claim:
                    updated.rows[0].last_vip_claim
            });

        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(
            "CLAIM VIP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to claim VIP reward."
        });
    }
});


// ============================================
// TRANSACTIONS
// ============================================

app.get("/transactions", async (req, res) => {
    try {
        const email = String(req.query.email || "")
            .trim()
            .toLowerCase();

        const userResult = await pool.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
            `,
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
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
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100
            `,
            [userResult.rows[0].id]
        );

        res.json({
            success: true,
            transactions: result.rows
        });

    } catch (error) {
        console.error(
            "TRANSACTIONS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load transactions."
        });
    }
});


// ============================================
// START SERVER
// ============================================

async function startServer() {
    try {
        await createTables();

        app.listen(PORT, () => {
            console.log(
                `Zavero server running on port ${PORT}`
            );
        });

    } catch (error) {
        console.error(
            "SERVER START ERROR:",
            error
        );

        process.exit(1);
    }
}

startServer();
