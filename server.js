const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform-1.onrender.com";

const OPAY_ACCOUNT_NAME =
    process.env.OPAY_ACCOUNT_NAME || "";

const OPAY_ACCOUNT_NUMBER =
    process.env.OPAY_ACCOUNT_NUMBER || "";

const MODERATOR_KEY =
    process.env.MODERATOR_KEY || "";


// ======================================================
// DATABASE
// ======================================================

if (!DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});


// ======================================================
// VIP PLANS
// ======================================================

const VIP_PLANS = {
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


// ======================================================
// PASSWORD FUNCTIONS
// ======================================================

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(16, (err, salt) => {
            if (err) {
                return reject(err);
            }

            crypto.scrypt(
                password,
                salt,
                64,
                (err, derivedKey) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve(
                        `${salt.toString("hex")}:${derivedKey.toString("hex")}`
                    );
                }
            );
        });
    });
}


function verifyPassword(password, storedHash) {
    return new Promise((resolve, reject) => {
        try {
            const parts = storedHash.split(":");

            if (parts.length !== 2) {
                return resolve(false);
            }

            const salt = Buffer.from(parts[0], "hex");
            const storedKey = Buffer.from(parts[1], "hex");

            crypto.scrypt(
                password,
                salt,
                storedKey.length,
                (err, derivedKey) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve(
                        crypto.timingSafeEqual(
                            storedKey,
                            derivedKey
                        )
                    );
                }
            );
        } catch (error) {
            reject(error);
        }
    });
}


// ======================================================
// REFERENCE GENERATOR
// ======================================================

function createTransactionReference() {
    return (
        "ZAV-" +
        Date.now().toString(36).toUpperCase() +
        "-" +
        crypto.randomBytes(4).toString("hex").toUpperCase()
    );
}


// ======================================================
// MODERATOR AUTHENTICATION
// ======================================================

function moderatorKeyIsValid(req) {
    const expected = String(MODERATOR_KEY || "");
    const provided = String(
        req.headers["x-moderator-key"] || ""
    );

    if (!expected || !provided) {
        return false;
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}


// ======================================================
// DATABASE SETUP
// ======================================================

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance NUMERIC(14,2) DEFAULT 0,
            vip_level INTEGER DEFAULT 0,
            last_vip_claim TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            reference TEXT UNIQUE NOT NULL,
            email TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            payment_type TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW(),
            completed_at TIMESTAMP NULL
        )
    `);


    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS vip_level INTEGER
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NULL
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS reviewed_by TEXT NULL
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT NULL
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            type TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            reference TEXT,
            description TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);


    console.log("Database setup completed.");
}


// ======================================================
// BASIC ROUTES
// ======================================================

app.get("/", (req, res) => {
    res.send("Zavero backend is working!");
});


app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "Zavero connection test is working"
    });
});


// ======================================================
// SIGN UP
// ======================================================

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
                message: "Please fill all fields."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters."
            });
        }

        const cleanName = String(name).trim();
        const cleanEmail = String(email)
            .trim()
            .toLowerCase();

        const existing = await pool.query(
            `SELECT id FROM users WHERE email = $1`,
            [cleanEmail]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        const passwordHash =
            await hashPassword(String(password));

        await pool.query(
            `
            INSERT INTO users
            (name, email, password_hash, balance, vip_level)
            VALUES ($1, $2, $3, 0, 0)
            `,
            [
                cleanName,
                cleanEmail,
                passwordHash
            ]
        );

        res.json({
            success: true,
            message: "Account created successfully."
        });

    } catch (error) {
        console.error("SIGNUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create account."
        });
    }
});


// ======================================================
// LOGIN
// ======================================================

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

        const cleanEmail = String(email)
            .trim()
            .toLowerCase();

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

        const valid =
            await verifyPassword(
                String(password),
                user.password_hash
            );

        if (!valid) {
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
                balance: Number(user.balance || 0),
                vip_level: Number(user.vip_level || 0),
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


// ======================================================
// BALANCE
// ======================================================

app.get("/balance", async (req, res) => {
    try {
        const email = String(
            req.query.email || ""
        )
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

        res.json({
            success: true,
            balance: Number(user.balance || 0),
            vip_level: Number(user.vip_level || 0),
            last_vip_claim: user.last_vip_claim,
            name: user.name,
            email: user.email
        });

    } catch (error) {
        console.error("BALANCE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to get balance."
        });
    }
});


// ======================================================
// VIP PLANS
// ======================================================

app.get("/vip-plans", (req, res) => {
    res.json({
        success: true,
        plans: VIP_PLANS
    });
});


// ======================================================
// OPAY ACCOUNT DETAILS
// ======================================================

app.get("/opay-details", (req, res) => {
    if (
        !OPAY_ACCOUNT_NAME ||
        !OPAY_ACCOUNT_NUMBER
    ) {
        return res.status(500).json({
            success: false,
            message: "OPay payment details have not been configured."
        });
    }

    res.json({
        success: true,
        accountName: OPAY_ACCOUNT_NAME,
        accountNumber: OPAY_ACCOUNT_NUMBER
    });
});


// ======================================================
// SUBMIT MANUAL OPAY VIP PAYMENT
// ======================================================

app.post("/submit-vip-payment", async (req, res) => {
    try {
        const {
            email,
            level,
            reference
        } = req.body;

        if (!email || !level || !reference) {
            return res.status(400).json({
                success: false,
                message:
                    "Email, VIP level and payment reference are required."
            });
        }

        const cleanEmail = String(email)
            .trim()
            .toLowerCase();

        const vipLevel = Number(level);

        const paymentReference = String(reference)
            .trim();

        if (!VIP_PLANS[vipLevel]) {
            return res.status(400).json({
                success: false,
                message: "Invalid VIP level."
            });
        }

        if (
            paymentReference.length < 3 ||
            paymentReference.length > 150
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid payment reference."
            });
        }

        const userResult = await pool.query(
            `
            SELECT
                id,
                email,
                vip_level
            FROM users
            WHERE email = $1
            `,
            [cleanEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user = userResult.rows[0];

        const currentVIP =
            Number(user.vip_level || 0);

        if (currentVIP >= vipLevel) {
            return res.status(400).json({
                success: false,
                message:
                    "You already have this VIP level or a higher VIP level."
            });
        }


        // Prevent duplicate pending payment
        const pendingResult = await pool.query(
            `
            SELECT
                id,
                reference,
                vip_level,
                amount,
                status,
                created_at
            FROM payments
            WHERE email = $1
              AND vip_level = $2
              AND status = 'pending'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [
                cleanEmail,
                vipLevel
            ]
        );

        if (pendingResult.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message:
                    "You already have a pending payment for this VIP level.",
                payment: pendingResult.rows[0]
            });
        }


        // Check reference has not already been used
        const referenceResult = await pool.query(
            `
            SELECT id, status
            FROM payments
            WHERE reference = $1
            `,
            [paymentReference]
        );

        if (referenceResult.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message:
                    "This payment reference has already been submitted."
            });
        }


        const amount =
            VIP_PLANS[vipLevel].price;


        await pool.query(
            `
            INSERT INTO payments
            (
                reference,
                email,
                amount,
                payment_type,
                status,
                vip_level
            )
            VALUES
            ($1, $2, $3, 'opay_manual', 'pending', $4)
            `,
            [
                paymentReference,
                cleanEmail,
                amount,
                vipLevel
            ]
        );


        res.json({
            success: true,
            message:
                "Payment submitted and is waiting for moderator approval.",
            payment: {
                reference: paymentReference,
                email: cleanEmail,
                vip_level: vipLevel,
                amount: amount,
                status: "pending"
            }
        });

    } catch (error) {
        console.error(
            "SUBMIT VIP PAYMENT ERROR:",
            error
        );

        if (error.code === "23505") {
            return res.status(400).json({
                success: false,
                message:
                    "This payment reference has already been submitted."
            });
        }

        res.status(500).json({
            success: false,
            message:
                "Unable to submit payment."
        });
    }
});


// ======================================================
// USER PAYMENT HISTORY
// ======================================================

app.get("/my-payments", async (req, res) => {
    try {
        const email = String(
            req.query.email || ""
        )
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
                reference,
                amount,
                vip_level,
                status,
                created_at,
                reviewed_at,
                rejection_reason
            FROM payments
            WHERE email = $1
            ORDER BY created_at DESC
            LIMIT 20
            `,
            [email]
        );

        res.json({
            success: true,
            payments: result.rows
        });

    } catch (error) {
        console.error(
            "MY PAYMENTS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load payment history."
        });
    }
});


// ======================================================
// OLD DIRECT VIP UPGRADE DISABLED
// ======================================================

app.post("/upgrade-vip", async (req, res) => {
    res.status(410).json({
        success: false,
        message:
            "Direct VIP upgrade is disabled. Please make the OPay payment and wait for moderator approval."
    });
});


// ======================================================
// CLAIM VIP DAILY REWARD
// ======================================================

app.post("/claim-vip", async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            email
        } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        const cleanEmail = String(email)
            .trim()
            .toLowerCase();

        await client.query("BEGIN");

        const userResult = await client.query(
            `
            SELECT
                id,
                email,
                balance,
                vip_level,
                last_vip_claim
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

        const vipLevel =
            Number(user.vip_level || 0);

        if (vipLevel < 1) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "You do not have an active VIP plan."
            });
        }

        const plan =
            VIP_PLANS[vipLevel];

        if (!plan) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "Invalid VIP plan."
            });
        }


        if (user.last_vip_claim) {
            const lastClaim =
                new Date(user.last_vip_claim);

            const now =
                new Date();

            const hours =
                (now.getTime() -
                    lastClaim.getTime()) /
                (1000 * 60 * 60);

            if (hours < 24) {
                const remaining =
                    Math.ceil(24 - hours);

                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        `You have already claimed your VIP reward. Try again in about ${remaining} hour(s).`
                });
            }
        }


        const reward =
            Number(plan.dailyReward);

        await client.query(
            `
            UPDATE users
            SET
                balance = balance + $1,
                last_vip_claim = NOW()
            WHERE email = $2
            `,
            [
                reward,
                cleanEmail
            ]
        );


        const reference =
            createTransactionReference();

        await client.query(
            `
            INSERT INTO transactions
            (
                email,
                type,
                amount,
                reference,
                description
            )
            VALUES
            ($1, 'vip_reward', $2, $3, $4)
            `,
            [
                cleanEmail,
                reward,
                reference,
                `VIP ${vipLevel} daily reward`
            ]
        );


        const updatedUser =
            await client.query(
                `
                SELECT
                    balance,
                    vip_level,
                    last_vip_claim
                FROM users
                WHERE email = $1
                `,
                [cleanEmail]
            );


        await client.query("COMMIT");

        res.json({
            success: true,
            message:
                `VIP ${vipLevel} reward claimed successfully.`,
            reward: reward,
            balance:
                Number(
                    updatedUser.rows[0].balance
                ),
            vip_level:
                Number(
                    updatedUser.rows[0].vip_level
                ),
            last_vip_claim:
                updatedUser.rows[0].last_vip_claim
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "CLAIM VIP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to claim VIP reward."
        });

    } finally {
        client.release();
    }
});


// ======================================================
// TRANSACTIONS
// ======================================================

app.get("/transactions", async (req, res) => {
    try {
        const email = String(
            req.query.email || ""
        )
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
                reference,
                description,
                created_at
            FROM transactions
            WHERE email = $1
            ORDER BY created_at DESC
            LIMIT 30
            `,
            [email]
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


// ======================================================
// MODERATOR: PENDING PAYMENTS ONLY
// ======================================================

app.get(
    "/moderator/pending-payments",
    async (req, res) => {

        try {
            if (!moderatorKeyIsValid(req)) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Unauthorized."
                });
            }

            const result = await pool.query(
                `
                SELECT
                    id,
                    reference,
                    email,
                    amount,
                    vip_level,
                    status,
                    created_at
                FROM payments
                WHERE status = 'pending'
                ORDER BY created_at ASC
                `
            );

            res.json({
                success: true,
                payments: result.rows
            });

        } catch (error) {
            console.error(
                "MODERATOR PENDING ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load pending payments."
            });
        }
    }
);


// ======================================================
// MODERATOR: APPROVE PAYMENT
// ======================================================

app.post(
    "/moderator/payments/:id/approve",
    async (req, res) => {

        const client =
            await pool.connect();

        try {

            if (!moderatorKeyIsValid(req)) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Unauthorized."
                });
            }

            const paymentId =
                Number(req.params.id);

            if (!Number.isInteger(paymentId)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid payment ID."
                });
            }

            await client.query("BEGIN");


            const paymentResult =
                await client.query(
                    `
                    SELECT
                        *
                    FROM payments
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [paymentId]
                );


            if (paymentResult.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message:
                        "Payment not found."
                });
            }


            const payment =
                paymentResult.rows[0];


            if (payment.status !== "pending") {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        `This payment has already been ${payment.status}.`
                });
            }


            const vipLevel =
                Number(payment.vip_level);

            const plan =
                VIP_PLANS[vipLevel];


            if (!plan) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid VIP level on payment."
                });
            }


            const userResult =
                await client.query(
                    `
                    SELECT
                        id,
                        email,
                        balance,
                        vip_level
                    FROM users
                    WHERE email = $1
                    FOR UPDATE
                    `,
                    [payment.email]
                );


            if (userResult.rows.length === 0) {
                await client.query("ROLLBACK");

                return res.status(404).json({
                    success: false,
                    message:
                        "User for this payment was not found."
                });
            }


            const user =
                userResult.rows[0];

            const currentVIP =
                Number(user.vip_level || 0);


            if (currentVIP >= vipLevel) {

                await client.query(
                    `
                    UPDATE payments
                    SET
                        status = 'approved',
                        reviewed_at = NOW(),
                        reviewed_by = 'moderator'
                    WHERE id = $1
                    `,
                    [paymentId]
                );

                await client.query("COMMIT");

                return res.json({
                    success: true,
                    message:
                        "Payment approved. User already has this VIP level or higher.",
                    vip_level:
                        currentVIP
                });
            }


            // Activate VIP.
            // IMPORTANT:
            // No wallet balance is deducted here because
            // the user already paid manually through OPay.

            await client.query(
                `
                UPDATE users
                SET
                    vip_level = $1,
                    last_vip_claim = NULL
                WHERE email = $2
                `,
                [
                    vipLevel,
                    payment.email
                ]
            );


            await client.query(
                `
                UPDATE payments
                SET
                    status = 'approved',
                    reviewed_at = NOW(),
                    reviewed_by = 'moderator',
                    completed_at = NOW()
                WHERE id = $1
                `,
                [paymentId]
            );


            const transactionReference =
                createTransactionReference();


            await client.query(
                `
                INSERT INTO transactions
                (
                    email,
                    type,
                    amount,
                    reference,
                    description
                )
                VALUES
                (
                    $1,
                    'vip_activation',
                    $2,
                    $3,
                    $4
                )
                `,
                [
                    payment.email,
                    Number(payment.amount),
                    transactionReference,
                    `VIP ${vipLevel} activated after OPay payment approval.`
                ]
            );


            await client.query("COMMIT");


            res.json({
                success: true,
                message:
                    `VIP ${vipLevel} has been activated successfully.`,
                vip_level:
                    vipLevel,
                email:
                    payment.email
            });

        } catch (error) {

            await client.query("ROLLBACK");

            console.error(
                "APPROVE PAYMENT ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to approve payment."
            });

        } finally {
            client.release();
        }
    }
);


// ======================================================
// MODERATOR: REJECT PAYMENT
// ======================================================

app.post(
    "/moderator/payments/:id/reject",
    async (req, res) => {

        try {

            if (!moderatorKeyIsValid(req)) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Unauthorized."
                });
            }

            const paymentId =
                Number(req.params.id);

            if (!Number.isInteger(paymentId)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid payment ID."
                });
            }

            const reason =
                String(
                    req.body?.reason ||
                    "Payment could not be confirmed."
                )
                    .trim()
                    .slice(0, 500);


            const result =
                await pool.query(
                    `
                    UPDATE payments
                    SET
                        status = 'rejected',
                        reviewed_at = NOW(),
                        reviewed_by = 'moderator',
                        rejection_reason = $1
                    WHERE id = $2
                      AND status = 'pending'
                    RETURNING
                        id,
                        reference,
                        email,
                        vip_level,
                        status
                    `,
                    [
                        reason,
                        paymentId
                    ]
                );


            if (result.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Payment was not found or has already been reviewed."
                });
            }


            res.json({
                success: true,
                message:
                    "Payment rejected.",
                payment:
                    result.rows[0]
            });

        } catch (error) {

            console.error(
                "REJECT PAYMENT ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to reject payment."
            });
        }
    }
);


// ======================================================
// START SERVER
// ======================================================

async function startServer() {
    try {

        await setupDatabase();

        console.log(
            "SITE_URL:",
            SITE_URL
        );

        console.log(
            "OPAY ACCOUNT CONFIGURED:",
            Boolean(
                OPAY_ACCOUNT_NAME &&
                OPAY_ACCOUNT_NUMBER
            )
        );

        console.log(
            "MODERATOR KEY CONFIGURED:",
            Boolean(MODERATOR_KEY)
        );

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
