const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());

/*
====================================================
IMPORTANT
====================================================

The webhook uses JSON, so express.json() is fine here.
Flutterwave sends the webhook signature in the
"verif-hash" header.
*/
app.use(express.json());

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const FLW_SECRET_KEY =
    process.env.FLW_SECRET_KEY;

const FLW_SECRET_HASH =
    process.env.FLW_SECRET_HASH;

const SITE_URL =
    process.env.SITE_URL ||
    "https://zavero-earning-platform-1.onrender.com";


if (!DATABASE_URL) {
    console.log(
        "WARNING: DATABASE_URL is not configured."
    );
}

if (!FLW_SECRET_KEY) {
    console.log(
        "WARNING: FLW_SECRET_KEY is not configured."
    );
}

if (!FLW_SECRET_HASH) {
    console.log(
        "WARNING: FLW_SECRET_HASH is not configured."
    );
}


const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


// ==================================================
// VIP PLANS
// ==================================================

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


// ==================================================
// FIND VIP BY PAYMENT AMOUNT
// ==================================================

function getVipLevelFromAmount(amount) {

    const paidAmount = Number(amount);

    for (const level of Object.keys(vipPlans)) {

        if (
            paidAmount >=
            vipPlans[level].price
        ) {
            return Number(level);
        }
    }

    return null;
}


// ==================================================
// PASSWORD FUNCTIONS
// ==================================================

function hashPassword(password) {

    return new Promise((resolve, reject) => {

        const salt =
            crypto.randomBytes(16).toString("hex");

        crypto.scrypt(
            password,
            salt,
            64,
            (err, derivedKey) => {

                if (err) {
                    reject(err);
                    return;
                }

                resolve(
                    `${salt}:${derivedKey.toString("hex")}`
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
                storedPassword.split(":");

            if (parts.length !== 2) {
                resolve(false);
                return;
            }

            const salt = parts[0];

            const storedHash =
                Buffer.from(
                    parts[1],
                    "hex"
                );

            crypto.scrypt(
                password,
                salt,
                64,
                (err, derivedKey) => {

                    if (err) {
                        reject(err);
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


// ==================================================
// DATABASE SETUP
// ==================================================

async function createTables() {

    if (!DATABASE_URL) {
        console.log(
            "Database not configured."
        );
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


    /*
    This table prevents the same Flutterwave
    transaction from activating VIP twice.
    */

    await pool.query(`
        CREATE TABLE IF NOT EXISTS flutterwave_events (
            id SERIAL PRIMARY KEY,
            transaction_id VARCHAR(255) UNIQUE NOT NULL,
            event_type VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);


    console.log(
        "Database tables are ready."
    );
}


// ==================================================
// HOME
// ==================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message:
            "Zavero Flutterwave backend is working"
    });

});


// ==================================================
// TEST
// ==================================================

app.get("/test", async (req, res) => {

    try {

        const result =
            await pool.query(
                "SELECT NOW() AS database_time"
            );

        res.json({
            success: true,
            message:
                "Zavero connection test is working",
            databaseTime:
                result.rows[0].database_time
        });

    } catch (error) {

        console.error(
            "TEST ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Database connection failed"
        });
    }

});


// ==================================================
// SIGN UP
// ==================================================

app.post("/signup", async (req, res) => {

    try {

        const name =
            String(
                req.body.name || ""
            ).trim();

        const email =
            String(
                req.body.email || ""
            ).trim()
            .toLowerCase();

        const password =
            String(
                req.body.password || ""
            );


        if (
            !name ||
            !email ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Please fill all fields."
            });
        }


        if (password.length < 6) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 6 characters."
            });
        }


        const existing =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE LOWER(email) = $1
                   OR LOWER(name) = $2
                LIMIT 1
                `,
                [
                    email,
                    name.toLowerCase()
                ]
            );


        if (
            existing.rows.length > 0
        ) {

            return res.status(409).json({
                success: false,
                message:
                    "Name or email already exists."
            });
        }


        const passwordHash =
            await hashPassword(password);


        const result =
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


        res.json({
            success: true,
            message:
                "Account created successfully.",
            user:
                result.rows[0]
        });


    } catch (error) {

        console.error(
            "SIGNUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to create account."
        });

    }

});


// ==================================================
// LOGIN
// ==================================================

app.post("/login", async (req, res) => {

    try {

        const name =
            String(
                req.body.name || ""
            ).trim();

        const email =
            String(
                req.body.email || ""
            ).trim();

        const password =
            String(
                req.body.password || ""
            );


        const loginValue =
            email || name;


        if (
            !loginValue ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Enter your name/email and password."
            });
        }


        const value =
            loginValue.toLowerCase();


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
                WHERE LOWER(email) = $1
                   OR LOWER(name) = $1
                LIMIT 1
                `,
                [value]
            );


        if (
            result.rows.length === 0
        ) {

            return res.status(401).json({
                success: false,
                message:
                    "Account not found."
            });
        }


        const user =
            result.rows[0];


        const correctPassword =
            await verifyPassword(
                password,
                user.password_hash
            );


        if (!correctPassword) {

            return res.status(401).json({
                success: false,
                message:
                    "Incorrect password."
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
                balance:
                    Number(user.balance),
                vip_level:
                    Number(user.vip_level),
                last_vip_claim:
                    user.last_vip_claim
            }
        });


    } catch (error) {

        console.error(
            "LOGIN ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to login."
        });

    }

});


// ==================================================
// BALANCE
// ==================================================

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


        if (
            result.rows.length === 0
        ) {

            return res.status(404).json({
                success: false,
                message:
                    "User not found."
            });
        }


        const user =
            result.rows[0];


        res.json({
            success: true,

            user: {
                id: user.id,
                name: user.name,
                email: user.email,

                balance:
                    Number(user.balance),

                vip_level:
                    Number(user.vip_level),

                last_vip_claim:
                    user.last_vip_claim
            }
        });


    } catch (error) {

        console.error(
            "BALANCE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load balance."
        });

    }

});


// ==================================================
// FLUTTERWAVE WEBHOOK
// ==================================================

app.post(
    "/flutterwave-webhook",
    async (req, res) => {

        /*
        Check Flutterwave secret hash first.
        */

        const incomingHash =
            req.headers["verif-hash"];


        if (
            !FLW_SECRET_HASH ||
            !incomingHash ||
            incomingHash !== FLW_SECRET_HASH
        ) {

            console.log(
                "Rejected Flutterwave webhook."
            );

            return res.status(401).json({
                success: false,
                message:
                    "Invalid webhook signature."
            });
        }


        /*
        Respond quickly.
        Flutterwave expects a successful
        HTTP response from the webhook.
        */

        try {

            const payload =
                req.body || {};


            const event =
                payload.event || "";


            const data =
                payload.data || {};


            console.log(
                "FLUTTERWAVE WEBHOOK:",
                JSON.stringify(payload)
            );


            /*
            We only process completed charges.
            */

            if (
                event !==
                "charge.completed"
            ) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Event received."
                });
            }


            const transactionId =
                String(
                    data.id || ""
                );


            if (!transactionId) {

                return res.status(200).json({
                    success: true,
                    message:
                        "No transaction ID."
                });
            }


            /*
            Prevent duplicate processing.
            */

            const existingEvent =
                await pool.query(
                    `
                    SELECT id
                    FROM flutterwave_events
                    WHERE transaction_id = $1
                    LIMIT 1
                    `,
                    [transactionId]
                );


            if (
                existingEvent.rows.length > 0
            ) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Transaction already processed."
                });
            }


            /*
            Verify the transaction directly
            with Flutterwave.
            */

            if (!FLW_SECRET_KEY) {

                console.error(
                    "FLW_SECRET_KEY is missing."
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Flutterwave secret key missing."
                });
            }


            const verifyResponse =
                await fetch(
                    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
                    {
                        method: "GET",

                        headers: {
                            Authorization:
                                `Bearer ${FLW_SECRET_KEY}`,
                            "Content-Type":
                                "application/json"
                        }
                    }
                );


            const verifyData =
                await verifyResponse.json();


            console.log(
                "FLUTTERWAVE VERIFICATION:",
                JSON.stringify(verifyData)
            );


            if (
                !verifyResponse.ok ||
                !verifyData ||
                !verifyData.data
            ) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Transaction could not be verified."
                });
            }


            const payment =
                verifyData.data;


            /*
            Payment must be successful.
            */

            if (
                payment.status !==
                "successful"
            ) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Payment is not successful."
                });
            }


            /*
            Must be Nigerian Naira.
            */

            if (
                String(
                    payment.currency
                ).toUpperCase() !== "NGN"
            ) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Wrong payment currency."
                });
            }


            const amount =
                Number(payment.amount);


            /*
            Determine VIP from the amount.
            */

            const vipLevel =
                getVipLevelFromAmount(
                    amount
                );


            if (!vipLevel) {

                return res.status(200).json({
                    success: true,
                    message:
                        "Payment amount does not match a VIP plan."
                });
            }


            const plan =
                vipPlans[vipLevel];


            /*
            Customer email is used to locate
            the Zavero account.
            */

            const customerEmail =
                String(
                    payment.customer?.email ||
                    data.customer?.email ||
                    ""
                )
                .trim()
                .toLowerCase();


            if (!customerEmail) {

                console.log(
                    "Flutterwave payment has no customer email."
                );

                return res.status(200).json({
                    success: true,
                    message:
                        "Customer email missing."
                });
            }


            /*
            Find the Zavero account.
            */

            const userResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        email,
                        balance,
                        vip_level
                    FROM users
                    WHERE LOWER(email) = $1
                    LIMIT 1
                    `,
                    [customerEmail]
                );


            if (
                userResult.rows.length === 0
            ) {

                console.log(
                    "No Zavero account for:",
                    customerEmail
                );

                return res.status(200).json({
                    success: true,
                    message:
                        "No matching Zavero account."
                });
            }


            const user =
                userResult.rows[0];


            /*
            Use the Flutterwave transaction
            ID as our unique reference.
            */

            const reference =
                `FLW_${transactionId}`;


            /*
            Begin database transaction.
            */

            const client =
                await pool.connect();


            try {

                await client.query(
                    "BEGIN"
                );


                /*
                Record webhook event first.
                */

                await client.query(
                    `
                    INSERT INTO flutterwave_events
                    (
                        transaction_id,
                        event_type
                    )
                    VALUES
                    ($1, $2)
                    `,
                    [
                        transactionId,
                        event
                    ]
                );


                /*
                Record payment.
                */

                await client.query(
                    `
                    INSERT INTO payments
                    (
                        user_id,
                        reference,
                        amount,
                        status
                    )
                    VALUES
                    ($1, $2, $3, 'success')
                    ON CONFLICT (reference)
                    DO NOTHING
                    `,
                    [
                        user.id,
                        reference,
                        amount
                    ]
                );


                /*
                If the user already has this
                VIP level or higher, don't downgrade.
                */

                const currentVip =
                    Number(
                        user.vip_level || 0
                    );


                if (
                    currentVip < vipLevel
                ) {

                    await client.query(
                        `
                        UPDATE users
                        SET
                            vip_level = $1,
                            last_vip_claim = NULL
                        WHERE id = $2
                        `,
                        [
                            vipLevel,
                            user.id
                        ]
                    );


                    await client.query(
                        `
                        INSERT INTO transactions
                        (
                            user_id,
                            type,
                            amount,
                            description,
                            reference
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
                            user.id,
                            amount,
                            `Flutterwave VIP ${vipLevel} activation`,
                            reference
                        ]
                    );

                } else {

                    /*
                    The payment is still recorded,
                    but the account isn't downgraded.
                    */

                    await client.query(
                        `
                        INSERT INTO transactions
                        (
                            user_id,
                            type,
                            amount,
                            description,
                            reference
                        )
                        VALUES
                        (
                            $1,
                            'vip_payment',
                            $2,
                            $3,
                            $4
                        )
                        `,
                        [
                            user.id,
                            amount,
                            `Flutterwave payment for VIP ${vipLevel}`,
                            reference
                        ]
                    );
                }


                await client.query(
                    "COMMIT"
                );


                console.log(
                    `VIP ${vipLevel} activated for ${customerEmail}`
                );


                return res.status(200).json({
                    success: true,
                    message:
                        `VIP ${vipLevel} activated.`
                });


            } catch (error) {

                await client.query(
                    "ROLLBACK"
                );

                throw error;

            } finally {

                client.release();

            }


        } catch (error) {

            console.error(
                "FLUTTERWAVE WEBHOOK ERROR:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Webhook processing failed."
            });
        }

    }
);


// ==================================================
// FLUTTERWAVE PAYMENT STATUS
// ==================================================

app.get(
    "/flutterwave-status",
    async (req, res) => {

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
                    WHERE LOWER(email) = $1
                    LIMIT 1
                    `,
                    [email]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }


            const user =
                result.rows[0];


            res.json({
                success: true,

                balance:
                    Number(user.balance),

                vip_level:
                    Number(user.vip_level),

                last_vip_claim:
                    user.last_vip_claim
            });


        } catch (error) {

            console.error(
                "FLUTTERWAVE STATUS ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to check payment status."
            });
        }

    }
);


// ==================================================
// CLAIM VIP REWARD
// ==================================================

app.post(
    "/claim-vip",
    async (req, res) => {

        try {

            const email =
                String(
                    req.body.email || ""
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
                        balance,
                        vip_level,
                        last_vip_claim
                    FROM users
                    WHERE LOWER(email) = $1
                    LIMIT 1
                    `,
                    [email]
                );


            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }


            const user =
                result.rows[0];


            const level =
                Number(user.vip_level);


            if (!vipPlans[level]) {

                return res.status(400).json({
                    success: false,
                    message:
                        "You need an active VIP plan before claiming."
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
                        now - lastClaim
                    ) /
                    (1000 * 60 * 60);


                if (hours < 24) {

                    const remaining =
                        Math.ceil(
                            24 - hours
                        );


                    return res.status(400).json({
                        success: false,
                        message:
                            `Your next reward is available in about ${remaining} hour(s).`
                    });
                }
            }


            const reward =
                vipPlans[level]
                    .dailyReward;


            const client =
                await pool.connect();


            try {

                await client.query(
                    "BEGIN"
                );


                const updated =
                    await client.query(
                        `
                        UPDATE users
                        SET
                            balance =
                                balance + $1,
                            last_vip_claim =
                                CURRENT_TIMESTAMP
                        WHERE id = $2
                        RETURNING
                            balance,
                            last_vip_claim
                        `,
                        [
                            reward,
                            user.id
                        ]
                    );


                await client.query(
                    `
                    INSERT INTO transactions
                    (
                        user_id,
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
                        user.id,
                        reward,
                        `VIP ${level} daily reward`
                    ]
                );


                await client.query(
                    "COMMIT"
                );


                res.json({
                    success: true,

                    message:
                        `₦${reward.toLocaleString()} VIP reward claimed.`,

                    reward:
                        reward,

                    balance:
                        Number(
                            updated.rows[0]
                                .balance
                        ),

                    last_vip_claim:
                        updated.rows[0]
                            .last_vip_claim
                });


            } catch (error) {

                await client.query(
                    "ROLLBACK"
                );

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

    }
);


// ==================================================
// TRANSACTIONS
// ==================================================

app.get(
    "/transactions",
    async (req, res) => {

        try {

            const email =
                String(
                    req.query.email || ""
                )
                .trim()
                .toLowerCase();


            const userResult =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(email) = $1
                    LIMIT 1
                    `,
                    [email]
                );


            if (
                userResult.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }


            const result =
                await pool.query(
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
                    [
                        userResult.rows[0].id
                    ]
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

    }
);


// ==================================================
// START SERVER
// ==================================================

async function startServer() {

    try {

        await createTables();


        app.listen(
            PORT,
            () => {

                console.log(
                    `Zavero server running on port ${PORT}`
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
