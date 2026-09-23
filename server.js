const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());

/*
==================================================
IMPORTANT:
Webhook must receive the RAW request body.
Therefore this route is registered BEFORE express.json().
==================================================
*/

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const MONETA_BASE_URL =
    process.env.MONETA_BASE_URL ||
    "https://api.moneta.ng/api/v2";

const MONETA_SERVICE_KEY = process.env.MONETA_SERVICE_KEY;
const MONETA_MAC_KEY = process.env.MONETA_MAC_KEY;

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform.onrender.com";

if (!DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
}

if (!MONETA_SERVICE_KEY) {
    console.error("MONETA_SERVICE_KEY is missing.");
}

if (!MONETA_MAC_KEY) {
    console.error("MONETA_MAC_KEY is missing.");
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

/*
==================================================
NORMAL JSON ROUTES
==================================================
*/

app.use(express.json());


/*
==================================================
VIP PLANS
==================================================
*/

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


/*
==================================================
DATABASE SETUP
==================================================
*/

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT,
            email TEXT UNIQUE,
            password_hash TEXT,
            balance NUMERIC(14,2) DEFAULT 0,
            vip_level INTEGER DEFAULT 0,
            last_vip_claim TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS name TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS email TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_hash TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2) DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS last_vip_claim TIMESTAMP NULL
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
        ON users (LOWER(email))
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,
            reference TEXT UNIQUE,
            email TEXT,
            amount_kobo BIGINT,
            amount_naira NUMERIC(14,2),
            status TEXT DEFAULT 'pending',
            provider TEXT DEFAULT 'moneta',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS reference TEXT
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS email TEXT
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS amount_kobo BIGINT
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS amount_naira NUMERIC(14,2)
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'moneta'
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
    `);

    await pool.query(`
        ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_unique
        ON payments(reference)
        WHERE reference IS NOT NULL
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            email TEXT,
            type TEXT,
            amount NUMERIC(14,2),
            reference TEXT,
            description TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS email TEXT
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS type TEXT
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2)
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS reference TEXT
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS description TEXT
    `);

    await pool.query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
    `);

    console.log("DATABASE READY");
}


/*
==================================================
PASSWORD FUNCTIONS
==================================================
*/

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString("hex");

        crypto.scrypt(password, salt, 64, (error, derivedKey) => {
            if (error) {
                reject(error);
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


function verifyPassword(password, storedPassword) {
    return new Promise((resolve, reject) => {
        try {
            const parts = String(storedPassword).split(":");

            if (parts.length !== 2) {
                resolve(false);
                return;
            }

            const salt = parts[0];
            const storedKey = Buffer.from(parts[1], "hex");

            crypto.scrypt(password, salt, 64, (error, derivedKey) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(
                    crypto.timingSafeEqual(
                        storedKey,
                        derivedKey
                    )
                );
            });
        } catch {
            resolve(false);
        }
    });
}


/*
==================================================
CREATE TRANSACTION REFERENCE
==================================================
*/

function createTransactionReference() {
    const randomPart = crypto
        .randomBytes(8)
        .toString("hex")
        .toUpperCase();

    return `ZAVERO-${Date.now()}-${randomPart}`;
}


/*
==================================================
MONETA HASH
==================================================
*/

function generateMonetaHash(
    email,
    amountKobo,
    paymentType,
    callbackUrl
) {
    const textToHash =
        email +
        String(amountKobo) +
        paymentType +
        callbackUrl;

    return crypto
        .createHmac("sha512", MONETA_MAC_KEY)
        .update(textToHash)
        .digest("hex");
}


/*
==================================================
ROOT
==================================================
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Zavero backend is working",
        provider: "Moneta",
        environment: "production"
    });
});


/*
==================================================
TEST
==================================================
*/

app.get("/test", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW() AS time");

        res.json({
            success: true,
            message: "Zavero connection test is working",
            databaseTime: result.rows[0].time
        });
    } catch (error) {
        console.error("TEST ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed."
        });
    }
});


/*
==================================================
SIGN UP
==================================================
*/

app.post("/signup", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body.password || "");

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required."
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
            LIMIT 1
            `,
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        const passwordHash = await hashPassword(password);

        const result = await pool.query(
            `
            INSERT INTO users
            (name, email, password_hash, balance, vip_level)
            VALUES ($1, $2, $3, 0, 0)
            RETURNING id, name, email, balance, vip_level
            `,
            [
                name,
                email,
                passwordHash
            ]
        );

        res.json({
            success: true,
            message: "Account created successfully.",
            name: result.rows[0].name,
            email: result.rows[0].email
        });

    } catch (error) {
        console.error("SIGNUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create account."
        });
    }
});


/*
==================================================
LOGIN
==================================================
*/

app.post("/login", async (req, res) => {
    try {
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const password = String(req.body.password || "");

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                name,
                email,
                password_hash,
                balance,
                vip_level
            FROM users
            WHERE LOWER(email) = $1
            LIMIT 1
            `,
            [email]
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
            name: user.name,
            email: user.email,
            balance: Number(user.balance || 0),
            vip_level: Number(user.vip_level || 0),

            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                balance: Number(user.balance || 0),
                vip_level: Number(user.vip_level || 0)
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


/*
==================================================
BALANCE
==================================================
*/

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
                vip_level
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
            balance: Number(user.balance || 0),
            earnings: Number(user.balance || 0),
            vip_level: Number(user.vip_level || 0),
            name: user.name,
            email: user.email,

            user: {
                name: user.name,
                email: user.email,
                balance: Number(user.balance || 0),
                vip_level: Number(user.vip_level || 0)
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


/*
==================================================
VIP PLANS
==================================================
*/

app.get("/vip-plans", (req, res) => {
    res.json({
        success: true,
        plans: VIP_PLANS
    });
});


/*
==================================================
INITIALIZE MONETA PAYMENT
==================================================
*/

app.post("/initialize-payment", async (req, res) => {
    try {
        const email = String(req.body.email || "")
            .trim()
            .toLowerCase();

        const amountNaira = Number(req.body.amount || 0);

        const paymentTypeInput =
            String(req.body.payment_type || "card")
                .trim()
                .toLowerCase();

        const allowedPaymentTypes = [
            "card",
            "ussd",
            "bank-transfer"
        ];

        const paymentType =
            allowedPaymentTypes.includes(paymentTypeInput)
                ? paymentTypeInput
                : "card";

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        if (
            !Number.isFinite(amountNaira) ||
            amountNaira <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid amount."
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
                message: "User account was not found."
            });
        }

        /*
        Moneta expects amount in KOBO.
        Example:
        ₦1,000 = 100000 kobo
        */

        const amountKobo = Math.round(
            amountNaira * 100
        );

        const reference =
            createTransactionReference();

        const callbackUrl =
            `${SITE_URL}/payment-callback`;

        const hash = generateMonetaHash(
            email,
            amountKobo,
            paymentType,
            callbackUrl
        );

        /*
        Save pending payment before contacting Moneta.
        */

        await pool.query(
            `
            INSERT INTO payments
            (
                reference,
                email,
                amount_kobo,
                amount_naira,
                status,
                provider
            )
            VALUES ($1, $2, $3, $4, 'pending', 'moneta')
            `,
            [
                reference,
                email,
                amountKobo,
                amountNaira
            ]
        );

        const monetaResponse = await fetch(
            `${MONETA_BASE_URL}/transaction/initialize`,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",
                    "X-Service-Token": MONETA_SERVICE_KEY
                },

                body: JSON.stringify({
                    txnref: reference,
                    amount: amountKobo,
                    email: email,
                    payment_type: paymentType,
                    hash: hash,
                    callback_url: callbackUrl,
                    json: true
                })
            }
        );

        const responseText =
            await monetaResponse.text();

        let monetaData;

        try {
            monetaData =
                JSON.parse(responseText);
        } catch {
            console.error(
                "MONETA NON-JSON RESPONSE:",
                responseText
            );

            return res.status(502).json({
                success: false,
                message:
                    "Moneta returned an invalid response."
            });
        }

        console.log(
            "MONETA INITIALIZE RESPONSE:",
            JSON.stringify(monetaData)
        );

        if (
            !monetaResponse.ok ||
            monetaData.status !== "success"
        ) {
            await pool.query(
                `
                UPDATE payments
                SET status = 'initialize_failed',
                    updated_at = NOW()
                WHERE reference = $1
                `,
                [reference]
            );

            return res.status(502).json({
                success: false,
                message:
                    monetaData.message ||
                    "Unable to initialize Moneta payment.",
                providerResponse: monetaData
            });
        }

        let authorizationUrl =
            monetaData.authorization_url ||
            monetaData.data?.authorization_url;

        /*
        Moneta's example returns authorization_url
        as a relative path such as:

        /api/v2/txn/isw/REFERENCE

        Convert it to a full HTTPS URL.
        */

        if (
            authorizationUrl &&
            authorizationUrl.startsWith("/")
        ) {
            authorizationUrl =
                `https://api.moneta.ng${authorizationUrl}`;
        }

        if (!authorizationUrl) {
            await pool.query(
                `
                UPDATE payments
                SET status = 'missing_checkout_url',
                    updated_at = NOW()
                WHERE reference = $1
                `,
                [reference]
            );

            return res.status(502).json({
                success: false,
                message:
                    "Moneta did not return a checkout URL.",
                providerResponse: monetaData
            });
        }

        res.json({
            success: true,
            message: "Payment initialized.",
            reference: reference,
            amount: amountNaira,
            authorization_url: authorizationUrl
        });

    } catch (error) {
        console.error(
            "INITIALIZE PAYMENT ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to initialize payment."
        });
    }
});


/*
==================================================
VERIFY MONETA TRANSACTION
==================================================
*/

async function verifyMonetaTransaction(reference) {
    const response = await fetch(
        `${MONETA_BASE_URL}/transaction/charge/verify/reference`,
        {
            method: "POST",

            headers: {
                "X-Service-Token": MONETA_SERVICE_KEY,
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                reference: reference
            })
        }
    );

    const responseText =
        await response.text();

    let data;

    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(
            "Moneta verification returned invalid JSON."
        );
    }

    return data;
}


/*
==================================================
CREDIT VERIFIED PAYMENT
==================================================
*/

async function creditVerifiedPayment(reference) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        /*
        Lock the payment row so two webhook/callback
        requests cannot credit it simultaneously.
        */

        const paymentResult = await client.query(
            `
            SELECT
                id,
                reference,
                email,
                amount_kobo,
                amount_naira,
                status
            FROM payments
            WHERE reference = $1
            FOR UPDATE
            `,
            [reference]
        );

        if (paymentResult.rows.length === 0) {
            throw new Error(
                "Payment reference was not found."
            );
        }

        const payment =
            paymentResult.rows[0];

        /*
        Already credited = do nothing.
        */

        if (payment.status === "completed") {
            await client.query("COMMIT");

            return {
                success: true,
                alreadyCredited: true,
                message: "Payment was already credited."
            };
        }

        /*
        Get fresh verification from Moneta.
        */

        const verification =
            await verifyMonetaTransaction(
                reference
            );

        console.log(
            "MONETA VERIFY RESPONSE:",
            JSON.stringify(verification)
        );

        const providerStatus = String(
            verification?.data?.status ||
            verification?.status ||
            ""
        ).toLowerCase();

        /*
        Only completed/success/paid transactions
        are allowed to credit the balance.
        */

        const successfulStatuses = [
            "completed",
            "success",
            "successful",
            "paid"
        ];

        if (
            !successfulStatuses.includes(
                providerStatus
            )
        ) {
            await client.query(
                `
                UPDATE payments
                SET status = $1,
                    updated_at = NOW()
                WHERE reference = $2
                `,
                [
                    providerStatus || "pending",
                    reference
                ]
            );

            await client.query("COMMIT");

            return {
                success: false,
                credited: false,
                status:
                    providerStatus || "pending",
                message:
                    "Payment has not been confirmed yet."
            };
        }

        /*
        Credit the exact amount that was stored when
        the payment was initialized.

        This prevents a client/browser from changing
        the amount during the payment process.
        */

        const amountNaira =
            Number(payment.amount_naira);

        const userResult =
            await client.query(
                `
                UPDATE users
                SET balance = balance + $1
                WHERE LOWER(email) = LOWER($2)
                RETURNING
                    id,
                    name,
                    email,
                    balance,
                    vip_level
                `,
                [
                    amountNaira,
                    payment.email
                ]
            );

        if (userResult.rows.length === 0) {
            throw new Error(
                "User account for payment was not found."
            );
        }

        const user =
            userResult.rows[0];

        /*
        Mark payment completed.
        */

        await client.query(
            `
            UPDATE payments
            SET status = 'completed',
                updated_at = NOW()
            WHERE reference = $1
            `,
            [reference]
        );

        /*
        Record the deposit transaction.
        */

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
            ($1, 'deposit', $2, $3, 'Moneta deposit')
            `,
            [
                payment.email,
                amountNaira,
                reference
            ]
        );

        await client.query("COMMIT");

        return {
            success: true,
            credited: true,
            amount: amountNaira,
            balance: Number(user.balance || 0),
            email: user.email
        };

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(
            "CREDIT PAYMENT ERROR:",
            error
        );

        throw error;

    } finally {
        client.release();
    }
}


/*
==================================================
MANUAL VERIFY ENDPOINT
==================================================
*/

app.post("/verify-payment", async (req, res) => {
    try {
        const reference =
            String(req.body.reference || "")
                .trim();

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: "Payment reference is required."
            });
        }

        const result =
            await creditVerifiedPayment(
                reference
            );

        res.json(result);

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


/*
==================================================
MONETA CALLBACK
==================================================
*/

app.get("/payment-callback", async (req, res) => {
    try {
        const reference =
            String(
                req.query.reference ||
                req.query.txnref ||
                ""
            ).trim();

        if (!reference) {
            return res.status(400).send(`
                <html>
                <body style="font-family:Arial;text-align:center;padding:40px">
                    <h2>Payment reference missing</h2>
                    <p>Please return to Zavero.</p>
                </body>
                </html>
            `);
        }

        const result =
            await creditVerifiedPayment(
                reference
            );

        if (result.credited || result.alreadyCredited) {
            return res.send(`
                <html>
                <head>
                    <meta name="viewport"
                          content="width=device-width, initial-scale=1">
                </head>
                <body style="
                    font-family:Arial;
                    text-align:center;
                    padding:40px;
                    background:#090a24;
                    color:white;
                ">
                    <h2>Payment Confirmed</h2>
                    <p>Your Zavero balance has been updated.</p>
                    <p>You can return to Zavero.</p>
                </body>
                </html>
            `);
        }

        return res.send(`
            <html>
            <head>
                <meta name="viewport"
                      content="width=device-width, initial-scale=1">
            </head>
            <body style="
                font-family:Arial;
                text-align:center;
                padding:40px;
                background:#090a24;
                color:white;
            ">
                <h2>Payment Processing</h2>
                <p>Your payment has not been confirmed yet.</p>
                <p>Please return to Zavero and check your balance shortly.</p>
            </body>
            </html>
        `);

    } catch (error) {
        console.error(
            "PAYMENT CALLBACK ERROR:",
            error
        );

        res.status(500).send(`
            <html>
            <body style="font-family:Arial;text-align:center;padding:40px">
                <h2>Payment verification error</h2>
                <p>Please return to Zavero and try again.</p>
            </body>
            </html>
        `);
    }
});


/*
==================================================
MONETA WEBHOOK
==================================================
*/

/*
IMPORTANT:
We do NOT trust the webhook payload itself to credit
money. We use the reference from the webhook and then
ask Moneta's Verify API to confirm it.
*/

app.post(
    "/moneta-webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        try {
            const rawBody =
                req.body.toString("utf8");

            let payload;

            try {
                payload =
                    JSON.parse(rawBody);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook JSON."
                });
            }

            console.log(
                "MONETA WEBHOOK:",
                JSON.stringify(payload)
            );

            const reference =
                String(
                    payload?.data?.reference ||
                    ""
                ).trim();

            if (!reference) {
                return res.status(200).json({
                    success: true,
                    message:
                        "Webhook received without a transaction reference."
                });
            }

            /*
            Verify directly with Moneta before crediting.
            */

            const result =
                await creditVerifiedPayment(
                    reference
                );

            res.status(200).json({
                success: true,
                processed: result.success,
                reference: reference
            });

        } catch (error) {
            console.error(
                "MONETA WEBHOOK ERROR:",
                error
            );

            /*
            Return 200 only if you intentionally want
            Moneta to consider the webhook delivered.
            */

            res.status(500).json({
                success: false,
                message: "Webhook processing failed."
            });
        }
    }
);


/*
==================================================
BUY VIP
==================================================
*/

async function buyVip(email, vipLevel) {
    const plan =
        VIP_PLANS[vipLevel];

    if (!plan) {
        throw new Error(
            "Invalid VIP level."
        );
    }

    const client =
        await pool.connect();

    try {
        await client.query("BEGIN");

        const result =
            await client.query(
                `
                SELECT
                    id,
                    name,
                    email,
                    balance,
                    vip_level
                FROM users
                WHERE LOWER(email) = LOWER($1)
                FOR UPDATE
                `,
                [email]
            );

        if (result.rows.length === 0) {
            throw new Error(
                "User account was not found."
            );
        }

        const user =
            result.rows[0];

        const balance =
            Number(user.balance || 0);

        if (balance < plan.price) {
            await client.query("ROLLBACK");

            return {
                success: false,
                message:
                    "Insufficient Zavero balance.",
                balance: balance,
                required: plan.price
            };
        }

        const newBalance =
            balance - plan.price;

        const updated =
            await client.query(
                `
                UPDATE users
                SET
                    balance = $1,
                    vip_level = $2
                WHERE id = $3
                RETURNING
                    name,
                    email,
                    balance,
                    vip_level
                `,
                [
                    newBalance,
                    vipLevel,
                    user.id
                ]
            );

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
            ($1, 'vip_purchase', $2, $3, $4)
            `,
            [
                email,
                plan.price,
                `VIP-${Date.now()}`,
                `VIP ${vipLevel} purchase`
            ]
        );

        await client.query("COMMIT");

        return {
            success: true,
            message:
                `VIP ${vipLevel} purchased successfully.`,
            balance:
                Number(updated.rows[0].balance || 0),
            vip_level:
                Number(updated.rows[0].vip_level || 0),
            price: plan.price
        };

    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}


app.post("/buy-vip", async (req, res) => {
    try {
        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const vipLevel =
            Number(req.body.vip_level);

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        if (!Number.isInteger(vipLevel)) {
            return res.status(400).json({
                success: false,
                message: "Invalid VIP level."
            });
        }

        const result =
            await buyVip(
                email,
                vipLevel
            );

        res.json(result);

    } catch (error) {
        console.error(
            "BUY VIP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to purchase VIP."
        });
    }
});


/*
==================================================
ALIAS FOR OLDER FRONTEND
==================================================
*/

app.post("/upgrade-vip", async (req, res) => {
    try {
        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const vipLevel =
            Number(
                req.body.vip_level ||
                req.body.level
            );

        if (!email || !Number.isInteger(vipLevel)) {
            return res.status(400).json({
                success: false,
                message:
                    "Email and VIP level are required."
            });
        }

        const result =
            await buyVip(
                email,
                vipLevel
            );

        res.json(result);

    } catch (error) {
        console.error(
            "UPGRADE VIP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to upgrade VIP."
        });
    }
});


/*
==================================================
CLAIM VIP DAILY REWARD
==================================================
*/

app.post("/claim-vip", async (req, res) => {
    const client =
        await pool.connect();

    try {
        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        await client.query("BEGIN");

        const result =
            await client.query(
                `
                SELECT
                    id,
                    email,
                    balance,
                    vip_level,
                    last_vip_claim
                FROM users
                WHERE LOWER(email) = LOWER($1)
                FOR UPDATE
                `,
                [email]
            );

        if (result.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const user =
            result.rows[0];

        const vipLevel =
            Number(user.vip_level || 0);

        if (!VIP_PLANS[vipLevel]) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message:
                    "You need to purchase a VIP plan first."
            });
        }

        const now = new Date();

        if (user.last_vip_claim) {
            const lastClaim =
                new Date(user.last_vip_claim);

            const hours =
                (now - lastClaim) /
                (1000 * 60 * 60);

            if (hours < 24) {
                await client.query("ROLLBACK");

                return res.json({
                    success: false,
                    message:
                        "Your daily VIP reward has already been claimed.",
                    nextClaimInHours:
                        Number((24 - hours).toFixed(2))
                });
            }
        }

        const reward =
            VIP_PLANS[vipLevel].dailyReward;

        const newBalance =
            Number(user.balance || 0) +
            reward;

        const updated =
            await client.query(
                `
                UPDATE users
                SET
                    balance = $1,
                    last_vip_claim = NOW()
                WHERE id = $2
                RETURNING balance
                `,
                [
                    newBalance,
                    user.id
                ]
            );

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
                email,
                reward,
                `REWARD-${Date.now()}`,
                `VIP ${vipLevel} daily reward`
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message:
                "Daily VIP reward claimed successfully.",
            reward: reward,
            balance:
                Number(updated.rows[0].balance || 0),
            vip_level: vipLevel
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


/*
==================================================
TRANSACTIONS
==================================================
*/

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

        const result =
            await pool.query(
                `
                SELECT
                    type,
                    amount,
                    reference,
                    description,
                    created_at
                FROM transactions
                WHERE LOWER(email) = LOWER($1)
                ORDER BY created_at DESC
                LIMIT 100
                `,
                [email]
            );

        res.json({
            success: true,
            transactions:
                result.rows
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


/*
==================================================
PAYMENT STATUS
==================================================
*/

app.get("/payment-status", async (req, res) => {
    try {
        const reference =
            String(req.query.reference || "")
                .trim();

        if (!reference) {
            return res.status(400).json({
                success: false,
                message: "Reference is required."
            });
        }

        const result =
            await pool.query(
                `
                SELECT
                    reference,
                    email,
                    amount_naira,
                    status,
                    created_at,
                    updated_at
                FROM payments
                WHERE reference = $1
                LIMIT 1
                `,
                [reference]
            );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Payment not found."
            });
        }

        res.json({
            success: true,
            payment: result.rows[0]
        });

    } catch (error) {
        console.error(
            "PAYMENT STATUS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to check payment status."
        });
    }
});


/*
==================================================
START SERVER
==================================================
*/

setupDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `Zavero server running on port ${PORT}`
            );

            console.log(
                `Moneta production URL: ${MONETA_BASE_URL}`
            );

            console.log(
                `Site URL: ${SITE_URL}`
            );
        });
    })
    .catch((error) => {
        console.error(
            "DATABASE STARTUP ERROR:",
            error
        );

        process.exit(1);
    });
