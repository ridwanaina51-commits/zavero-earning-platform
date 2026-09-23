const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const MONETA_BASE_URL =
    process.env.MONETA_BASE_URL ||
    "https://api.moneta.ng/api/v2";

const MONETA_SERVICE_KEY =
    process.env.MONETA_SERVICE_KEY;

const MONETA_MAC_KEY =
    process.env.MONETA_MAC_KEY;

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform.onrender.com";

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    SITE_URL;


/* =========================================================
   CONFIGURATION CHECK
========================================================= */

if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is missing.");
}

if (!MONETA_SERVICE_KEY) {
    console.warn("WARNING: MONETA_SERVICE_KEY is missing.");
}

if (!MONETA_MAC_KEY) {
    console.warn("WARNING: MONETA_MAC_KEY is missing.");
}


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


/* =========================================================
   MONETA WEBHOOK
   IMPORTANT:
   This MUST come before express.json()
========================================================= */

app.post(
    "/moneta-webhook",
    express.raw({
        type: "application/json"
    }),
    async (req, res) => {

        try {

            let payload;

            if (Buffer.isBuffer(req.body)) {

                payload = JSON.parse(
                    req.body.toString("utf8")
                );

            } else {

                payload = req.body;

            }

            console.log(
                "MONETA WEBHOOK:",
                JSON.stringify(payload)
            );

            const reference =
                payload?.reference ||
                payload?.txnref ||
                payload?.data?.reference ||
                payload?.data?.txnref;

            if (reference) {

                try {

                    await creditVerifiedPayment(
                        String(reference)
                    );

                } catch (error) {

                    console.error(
                        "WEBHOOK CREDIT ERROR:",
                        error.message
                    );

                }

            }

            return res.status(200).json({
                success: true
            });

        } catch (error) {

            console.error(
                "WEBHOOK ERROR:",
                error
            );

            return res.status(200).json({
                success: false
            });
        }
    }
);


/* =========================================================
   JSON BODY PARSER
   THIS WAS MISSING BEFORE
========================================================= */

app.use(express.json());


/* =========================================================
   DATABASE SETUP
========================================================= */

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
        );
    `);
await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type TEXT;
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
        );
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
        );
    `);

    console.log("Database tables are ready.");
}


/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {

    return new Promise((resolve, reject) => {

        crypto.randomBytes(
            16,
            (error, salt) => {

                if (error) {
                    return reject(error);
                }

                crypto.scrypt(
                    password,
                    salt,
                    64,
                    (error, derivedKey) => {

                        if (error) {
                            return reject(error);
                        }

                        resolve(
                            `${salt.toString("hex")}:${derivedKey.toString("hex")}`
                        );
                    }
                );
            }
        );
    });
}


function verifyPassword(
    password,
    storedPassword
) {

    return new Promise((resolve, reject) => {

        try {

            const parts =
                String(storedPassword).split(":");

            if (parts.length !== 2) {
                return resolve(false);
            }

            const salt =
                Buffer.from(parts[0], "hex");

            const storedKey =
                Buffer.from(parts[1], "hex");

            crypto.scrypt(
                password,
                salt,
                64,
                (error, derivedKey) => {

                    if (error) {
                        return reject(error);
                    }

                    if (
                        storedKey.length !==
                        derivedKey.length
                    ) {
                        return resolve(false);
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

            resolve(false);
        }
    });
}


/* =========================================================
   TRANSACTION REFERENCE
========================================================= */

function createTransactionReference() {

    return (
        "ZAVERO-" +
        Date.now() +
        "-" +
        crypto
            .randomBytes(5)
            .toString("hex")
            .toUpperCase()
    );
}


/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "Zavero backend is working!",
        status: "online"
    });
});


/* =========================================================
   TEST
========================================================= */

app.get("/test", (req, res) => {

    res.json({
        success: true,
        message: "Zavero connection test is working!"
    });
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
        } = req.body || {};


        if (
            !name ||
            !email ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Name, email and password are required."
            });
        }


        const cleanName =
            String(name).trim();

        const cleanEmail =
            String(email)
                .trim()
                .toLowerCase();

        const cleanPassword =
            String(password);


        if (cleanName.length < 2) {

            return res.status(400).json({
                success: false,
                message:
                    "Please enter your name."
            });
        }


        if (cleanPassword.length < 6) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 6 characters."
            });
        }


        const existingUser =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE email = $1
                `,
                [cleanEmail]
            );


        if (existingUser.rows.length > 0) {

            return res.status(409).json({
                success: false,
                message:
                    "An account with this email already exists."
            });
        }


        const passwordHash =
            await hashPassword(
                cleanPassword
            );


        await pool.query(
            `
            INSERT INTO users
            (
                name,
                email,
                password_hash,
                balance,
                vip_level
            )
            VALUES
            ($1, $2, $3, 0, 0)
            `,
            [
                cleanName,
                cleanEmail,
                passwordHash
            ]
        );


        return res.json({
            success: true,
            message:
                "Account created successfully."
        });


    } catch (error) {

        console.error(
            "SIGNUP ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Unable to create account."
        });
    }
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/login", async (req, res) => {

    try {

        console.log(
            "LOGIN REQUEST RECEIVED"
        );

        const {
            email,
            password
        } = req.body || {};


        if (!email || !password) {

            return res.status(400).json({
                success: false,
                message:
                    "Email and password are required."
            });
        }


        const cleanEmail =
            String(email)
                .trim()
                .toLowerCase();


        const result =
            await pool.query(
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
                message:
                    "Invalid email or password."
            });
        }


        const user =
            result.rows[0];


        const passwordCorrect =
            await verifyPassword(
                String(password),
                user.password_hash
            );


        if (!passwordCorrect) {

            return res.status(401).json({
                success: false,
                message:
                    "Invalid email or password."
            });
        }


        console.log(
            "LOGIN SUCCESS:",
            cleanEmail
        );


        return res.json({

            success: true,

            message:
                "Login successful.",

            name:
                user.name,

            email:
                user.email,

            balance:
                Number(user.balance || 0),

            vip_level:
                Number(user.vip_level || 0),

            last_vip_claim:
                user.last_vip_claim,

            user: {

                id:
                    user.id,

                name:
                    user.name,

                email:
                    user.email,

                balance:
                    Number(user.balance || 0),

                vip_level:
                    Number(user.vip_level || 0),

                last_vip_claim:
                    user.last_vip_claim
            }
        });


    } catch (error) {

        console.error(
            "LOGIN ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Unable to login.",
            error:
                error.message
        });
    }
});


/* =========================================================
   BALANCE
========================================================= */

app.get("/balance", async (req, res) => {

    try {

        const email =
            String(
                req.query.email || ""
            )
                .trim()
                .toLowerCase();


        if (!email) {

            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }


        const result =
            await pool.query(
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
                message:
                    "User not found."
            });
        }


        const user =
            result.rows[0];


        return res.json({

            success: true,

            name:
                user.name,

            email:
                user.email,

            balance:
                Number(user.balance || 0),

            vip_level:
                Number(user.vip_level || 0),

            last_vip_claim:
                user.last_vip_claim
        });


    } catch (error) {

        console.error(
            "BALANCE ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Unable to load balance."
        });
    }
});


/* =========================================================
   VIP PLANS
========================================================= */

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


/* =========================================================
   GET VIP PLANS
========================================================= */

app.get("/vip-plans", (req, res) => {

    res.json({
        success: true,
        plans: VIP_PLANS
    });
});


/* =========================================================
   PURCHASE VIP
========================================================= */

app.post("/upgrade-vip", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const {
            email,
            level
        } = req.body || {};


        const cleanEmail =
            String(email || "")
                .trim()
                .toLowerCase();


        const vipLevel =
            Number(level);


        if (
            !cleanEmail ||
            !VIP_PLANS[vipLevel]
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Invalid VIP request."
            });
        }


        const plan =
            VIP_PLANS[vipLevel];


        await client.query(
            "BEGIN"
        );


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
                WHERE email = $1
                FOR UPDATE
                `,
                [cleanEmail]
            );


        if (result.rows.length === 0) {

            await client.query(
                "ROLLBACK"
            );

            return res.status(404).json({
                success: false,
                message:
                    "User not found."
            });
        }


        const user =
            result.rows[0];


        const balance =
            Number(user.balance || 0);


        const currentVip =
            Number(user.vip_level || 0);


        if (
            vipLevel <= currentVip
        ) {

            await client.query(
                "ROLLBACK"
            );

            return res.status(400).json({
                success: false,
                message:
                    "You already have this VIP level or a higher level."
            });
        }


        if (
            balance < plan.price
        ) {

            await client.query(
                "ROLLBACK"
            );

            return res.status(400).json({
                success: false,
                message:
                    `Insufficient balance. VIP ${vipLevel} costs ₦${plan.price.toLocaleString()}.`,
                balance:
                    balance,
                required:
                    plan.price
            });
        }


        /* Deduct VIP price */

        await client.query(
            `
            UPDATE users
            SET
                balance = balance - $1,
                vip_level = $2,
                last_vip_claim = NULL
            WHERE email = $3
            `,
            [
                plan.price,
                vipLevel,
                cleanEmail
            ]
        );


        const reference =
            createTransactionReference();


        /* Record VIP purchase */

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
                'vip_purchase',
                $2,
                $3,
                $4
            )
            `,
            [
                cleanEmail,
                plan.price,
                reference,
                `VIP ${vipLevel} purchase`
            ]
        );


        await client.query(
            "COMMIT"
        );


        const newBalance =
            balance - plan.price;


        console.log(
            `VIP ${vipLevel} PURCHASED BY ${cleanEmail}`
        );


        return res.json({

            success: true,

            message:
                `VIP ${vipLevel} activated successfully.`,

            vip_level:
                vipLevel,

            balance:
                newBalance,

            price:
                plan.price,

            dailyReward:
                plan.dailyReward
        });


    } catch (error) {

        try {
            await client.query(
                "ROLLBACK"
            );
        } catch {}


        console.error(
            "VIP UPGRADE ERROR:",
            error
        );


        return res.status(500).json({
            success: false,
            message:
                "Unable to upgrade VIP."
        });


    } finally {

        client.release();
    }
});


/* =========================================================
   CLAIM DAILY VIP REWARD
========================================================= */

app.post("/claim-vip", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const {
            email
        } = req.body || {};


        const cleanEmail =
            String(email || "")
                .trim()
                .toLowerCase();


        if (!cleanEmail) {

            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }


        await client.query(
            "BEGIN"
        );


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
                [cleanEmail]
            );


        if (result.rows.length === 0) {

            await client.query(
                "ROLLBACK"
            );

            return res.status(404).json({
                success: false,
                message:
                    "User not found."
            });
        }


        const user =
            result.rows[0];


        const vipLevel =
            Number(user.vip_level || 0);


        if (!VIP_PLANS[vipLevel]) {

            await client.query(
                "ROLLBACK"
            );

            return res.status(400).json({
                success: false,
                message:
                    "You do not have an active VIP plan."
            });
        }


        if (user.last_vip_claim) {

            const lastClaim =
                new Date(
                    user.last_vip_claim
                );

            const now =
                new Date();


            const hours =
                (
                    now.getTime() -
                    lastClaim.getTime()
                ) /
                (1000 * 60 * 60);


            if (hours < 24) {

                await client.query(
                    "ROLLBACK"
                );


                const remaining =
                    24 - hours;


                return res.status(400).json({

                    success: false,

                    message:
                        "Your VIP reward is not available yet.",

                    nextClaimInHours:
                        Number(
                            remaining.toFixed(2)
                        )
                });
            }
        }


        const reward =
            VIP_PLANS[
                vipLevel
            ].dailyReward;


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
            (
                $1,
                'vip_reward',
                $2,
                $3,
                $4
            )
            `,
            [
                cleanEmail,
                reward,
                reference,
                `VIP ${vipLevel} daily reward`
            ]
        );


        await client.query(
            "COMMIT"
        );


        const updated =
            await pool.query(
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


        const updatedUser =
            updated.rows[0];


        return res.json({

            success: true,

            message:
                `₦${reward.toLocaleString()} VIP reward claimed.`,

            reward:
                reward,

            balance:
                Number(
                    updatedUser.balance || 0
                ),

            vip_level:
                Number(
                    updatedUser.vip_level || 0
                ),

            last_vip_claim:
                updatedUser.last_vip_claim
        });


    } catch (error) {

        try {
            await client.query(
                "ROLLBACK"
            );
        } catch {}


        console.error(
            "VIP CLAIM ERROR:",
            error
        );


        return res.status(500).json({
            success: false,
            message:
                "Unable to claim VIP reward."
        });


    } finally {

        client.release();
    }
});


/* =========================================================
   TRANSACTIONS
========================================================= */

app.get("/transactions", async (req, res) => {

    try {

        const email =
            String(
                req.query.email || ""
            )
                .trim()
                .toLowerCase();


        if (!email) {

            return res.status(400).json({
                success: false,
                message:
                    "Email is required."
            });
        }


        const result =
            await pool.query(
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
                LIMIT 100
                `,
                [email]
            );


        return res.json({

            success: true,

            transactions:
                result.rows
        });


    } catch (error) {

        console.error(
            "TRANSACTIONS ERROR:",
            error
        );


        return res.status(500).json({
            success: false,
            message:
                "Unable to load transactions."
        });
    }
});


/* =========================================================
   MONETA HASH
========================================================= */

function generateMonetaHash(
    email,
    amountKobo,
    paymentType,
    callbackUrl
) {

    if (!MONETA_MAC_KEY) {

        throw new Error(
            "MONETA_MAC_KEY is not configured."
        );
    }


    const payload =
        `${email}|${amountKobo}|${paymentType}|${callbackUrl}`;


    return crypto
        .createHmac(
            "sha512",
            MONETA_MAC_KEY
        )
        .update(payload)
        .digest("hex");
}


/* =========================================================
   MONETA URL
========================================================= */

function toAbsoluteMonetaUrl(url) {

    if (!url) {
        return null;
    }


    if (
        url.startsWith("http://") ||
        url.startsWith("https://")
    ) {

        return url;
    }


    if (url.startsWith("/")) {

        return (
            "https://api.moneta.ng" +
            url
        );
    }


    return url;
}


/* =========================================================
   INITIALIZE MONETA PAYMENT
========================================================= */

app.post(
    "/initialize-payment",
    async (req, res) => {

        try {

            const {
                email,
                amount,
                payment_type
            } = req.body || {};


            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();


            const numericAmount =
                Number(amount);


            if (
                !cleanEmail ||
                !Number.isFinite(
                    numericAmount
                ) ||
                numericAmount <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Enter a valid email and amount."
                });
            }


            if (
                !MONETA_SERVICE_KEY ||
                !MONETA_MAC_KEY
            ) {

                return res.status(500).json({
                    success: false,
                    message:
                        "Moneta payment configuration is missing on the server."
                });
            }


            const user =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE email = $1
                    `,
                    [cleanEmail]
                );


            if (user.rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User account was not found."
                });
            }


            const amountKobo =
                Math.round(
                    numericAmount * 100
                );


            const allowedTypes = [
                "card",
                "ussd",
                "bank-transfer"
            ];


            const cleanPaymentType =
                allowedTypes.includes(
                    payment_type
                )
                    ? payment_type
                    : "card";


            const reference =
                createTransactionReference();


            const callbackUrl =
                `${SITE_URL}/payment-callback`;


            const hash =
                generateMonetaHash(
                    cleanEmail,
                    amountKobo,
                    cleanPaymentType,
                    callbackUrl
                );


            await pool.query(
                `
                INSERT INTO payments
                (
                    reference,
                    email,
                    amount,
                    payment_type,
                    status
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    'pending'
                )
                `,
                [
                    reference,
                    cleanEmail,
                    numericAmount,
                    cleanPaymentType
                ]
            );


            const monetaResponse =
                await fetch(
                    `${MONETA_BASE_URL}/transaction/initialize`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "X-Service-Token":
                                MONETA_SERVICE_KEY
                        },

                        body:
                            JSON.stringify({

                                txnref:
                                    reference,

                                amount:
                                    amountKobo,

                                email:
                                    cleanEmail,

                                payment_type:
                                    cleanPaymentType,

                                hash:
                                    hash,

                                callback_url:
                                    callbackUrl,

                                json:
                                    true
                            })
                    }
                );


            const responseText =
                await monetaResponse.text();


            let data;


            try {

                data =
                    JSON.parse(
                        responseText
                    );

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
                "MONETA INITIALIZE:",
                JSON.stringify(data)
            );


            if (!monetaResponse.ok) {

                return res.status(502).json({

                    success: false,

                    message:
                        data.message ||
                        data.error ||
                        "Moneta payment initialization failed."
                });
            }


            const successful =
                data.status === true ||
                data.status === "success" ||
                data.success === true;


            if (!successful) {

                return res.status(400).json({

                    success: false,

                    message:
                        data.message ||
                        data.error ||
                        "Moneta could not initialize the payment."
                });
            }


            const authorizationUrl =
                data.authorization_url ||
                data.checkout_url ||
                data.data?.authorization_url ||
                data.data?.checkout_url ||
                data.data?.url;


            if (!authorizationUrl) {

                console.error(
                    "MONETA CHECKOUT URL MISSING:",
                    data
                );


                return res.status(502).json({
                    success: false,
                    message:
                        "Moneta did not return a checkout URL."
                });
            }


            return res.json({

                success: true,

                reference:
                    reference,

                authorization_url:
                    toAbsoluteMonetaUrl(
                        authorizationUrl
                    )
            });


        } catch (error) {

            console.error(
                "INITIALIZE PAYMENT ERROR:",
                error
            );


            return res.status(500).json({
                success: false,
                message:
                    "Unable to initialize payment."
            });
        }
    }
);


/* =========================================================
   VERIFY MONETA PAYMENT
========================================================= */

async function verifyMonetaTransaction(
    reference
) {

    if (!MONETA_SERVICE_KEY) {

        throw new Error(
            "MONETA_SERVICE_KEY is not configured."
        );
    }


    const verifyUrl =
        `${MONETA_BASE_URL}/transaction/charge/verify/${encodeURIComponent(
            reference
        )}`;


    const response =
        await fetch(
            verifyUrl,
            {
                method: "GET",

                headers: {

                    "X-Service-Token":
                        MONETA_SERVICE_KEY,

                    "Accept":
                        "application/json"
                }
            }
        );


    const responseText =
        await response.text();


    let data;


    try {

        data =
            JSON.parse(
                responseText
            );

    } catch {

        throw new Error(
            "Moneta verification returned invalid JSON."
        );
    }


    console.log(
        "MONETA VERIFY:",
        JSON.stringify(data)
    );


    if (!response.ok) {

        throw new Error(
            data.message ||
            data.error ||
            "Moneta verification failed."
        );
    }


    return data;
}


/* =========================================================
   CREDIT VERIFIED PAYMENT
========================================================= */

async function creditVerifiedPayment(
    reference
) {

    const client =
        await pool.connect();


    try {

        await client.query(
            "BEGIN"
        );


        const paymentResult =
            await client.query(
                `
                SELECT *
                FROM payments
                WHERE reference = $1
                FOR UPDATE
                `,
                [reference]
            );


        if (
            paymentResult.rows.length === 0
        ) {

            throw new Error(
                "Payment reference was not found."
            );
        }


        const payment =
            paymentResult.rows[0];


        if (
            payment.status ===
            "completed"
        ) {

            await client.query(
                "COMMIT"
            );


            return {

                success: true,

                completed: true,

                alreadyCompleted: true,

                email:
                    payment.email,

                amount:
                    Number(
                        payment.amount
                    )
            };
        }


        const verification =
            await verifyMonetaTransaction(
                reference
            );


        const statusText =
            String(
                verification.status ||
                verification.data?.status ||
                verification.data?.payment_status ||
                verification.data?.transaction_status ||
                ""
            ).toLowerCase();


        const paidStatuses = [
            "success",
            "successful",
            "completed",
            "complete",
            "paid"
        ];


        const paid =
            paidStatuses.includes(
                statusText
            );


        if (!paid) {

            await client.query(
                "ROLLBACK"
            );


            return {

                success: false,

                completed: false,

                status:
                    statusText ||
                    "pending"
            };
        }


        const amount =
            Number(
                payment.amount
            );


        await client.query(
            `
            UPDATE users
            SET balance = balance + $1
            WHERE email = $2
            `,
            [
                amount,
                payment.email
            ]
        );


        await client.query(
            `
            UPDATE payments
            SET
                status = 'completed',
                completed_at = NOW()
            WHERE reference = $1
            `,
            [reference]
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
            (
                $1,
                'deposit',
                $2,
                $3,
                'Moneta deposit'
            )
            `,
            [
                payment.email,
                amount,
                reference
            ]
        );


        await client.query(
            "COMMIT"
        );


        return {

            success: true,

            completed: true,

            email:
                payment.email,

            amount:
                amount
        };


    } catch (error) {

        try {

            await client.query(
                "ROLLBACK"
            );

        } catch {}


        throw error;


    } finally {

        client.release();
    }
}


/* =========================================================
   VERIFY PAYMENT ROUTE
========================================================= */

app.get(
    "/verify-payment",
    async (req, res) => {

        try {

            const reference =
                String(
                    req.query.reference ||
                    ""
                ).trim();


            if (!reference) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Payment reference is required."
                });
            }


            const result =
                await creditVerifiedPayment(
                    reference
                );


            return res.json(
                result
            );


        } catch (error) {

            console.error(
                "VERIFY PAYMENT ERROR:",
                error
            );


            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Unable to verify payment."
            });
        }
    }
);


/* =========================================================
   PAYMENT STATUS
========================================================= */

app.get(
    "/payment-status",
    async (req, res) => {

        try {

            const reference =
                String(
                    req.query.reference ||
                    ""
                ).trim();


            if (!reference) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Reference is required."
                });
            }


            const result =
                await pool.query(
                    `
                    SELECT
                        reference,
                        email,
                        amount,
                        payment_type,
                        status,
                        created_at,
                        completed_at
                    FROM payments
                    WHERE reference = $1
                    `,
                    [reference]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "Payment not found."
                });
            }


            return res.json({

                success: true,

                payment:
                    result.rows[0]
            });


        } catch (error) {

            console.error(
                "PAYMENT STATUS ERROR:",
                error
            );


            return res.status(500).json({
                success: false,
                message:
                    "Unable to get payment status."
            });
        }
    }
);


/* =========================================================
   PAYMENT CALLBACK
========================================================= */

app.get(
    "/payment-callback",
    async (req, res) => {

        try {

            const reference =
                String(
                    req.query.reference ||
                    req.query.txnref ||
                    req.query.trxref ||
                    ""
                ).trim();


            if (!reference) {

                return res.redirect(
                    `${FRONTEND_URL}/?payment=failed`
                );
            }


            const result =
                await creditVerifiedPayment(
                    reference
                );


            if (result.success) {

                return res.redirect(
                    `${FRONTEND_URL}/?payment=success&reference=${encodeURIComponent(
                        reference
                    )}`
                );
            }


            return res.redirect(
                `${FRONTEND_URL}/?payment=pending&reference=${encodeURIComponent(
                    reference
                )}`
            );


        } catch (error) {

            console.error(
                "PAYMENT CALLBACK ERROR:",
                error
            );


            const reference =
                String(
                    req.query.reference ||
                    req.query.txnref ||
                    ""
                ).trim();


            return res.redirect(
                `${FRONTEND_URL}/?payment=error${
                    reference
                        ? `&reference=${encodeURIComponent(
                              reference
                          )}`
                        : ""
                }`
            );
        }
    }
);


/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

    try {

        await setupDatabase();


        app.listen(
            PORT,
            () => {

                console.log(
                    "================================="
                );

                console.log(
                    "ZAVERO SERVER IS ONLINE"
                );

                console.log(
                    `PORT: ${PORT}`
                );

                console.log(
                    `SITE_URL: ${SITE_URL}`
                );

                console.log(
                    `FRONTEND_URL: ${FRONTEND_URL}`
                );

                console.log(
                    `MONETA_BASE_URL: ${MONETA_BASE_URL}`
                );

                console.log(
                    "LOGIN: READY"
                );

                console.log(
                    "SIGNUP: READY"
                );

                console.log(
                    "VIP PURCHASE: READY"
                );

                console.log(
                    "VIP CLAIM: READY"
                );

                console.log(
                    "================================="
                );
            }
        );


    } catch (error) {

        console.error(
            "SERVER START ERROR:",
            error
        );

        process.exit(1);
    }
}


startServer();
