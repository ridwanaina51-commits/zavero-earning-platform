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


// ==================================================
// MONETA ENVIRONMENT VARIABLES
// ==================================================
// These are stored securely in Render.
// Payment processing is not enabled in this version
// until Moneta confirms Zavero is approved.
// ==================================================

const MONETA_CLIENT_ID =
    process.env.MONETA_CLIENT_ID;

const MONETA_CLIENT_SECRET =
    process.env.MONETA_CLIENT_SECRET;

const MONETA_SERVICE_KEY =
    process.env.MONETA_SERVICE_KEY;

const MONETA_MAC_KEY =
    process.env.MONETA_MAC_KEY;


// ==================================================
// STARTUP CHECKS
// ==================================================

if (!DATABASE_URL) {
    console.log(
        "WARNING: DATABASE_URL is not configured."
    );
}

if (!MONETA_CLIENT_ID) {
    console.log(
        "WARNING: MONETA_CLIENT_ID is not configured."
    );
}

if (!MONETA_CLIENT_SECRET) {
    console.log(
        "WARNING: MONETA_CLIENT_SECRET is not configured."
    );
}

if (!MONETA_SERVICE_KEY) {
    console.log(
        "WARNING: MONETA_SERVICE_KEY is not configured."
    );
}

if (!MONETA_MAC_KEY) {
    console.log(
        "WARNING: MONETA_MAC_KEY is not configured."
    );
}


// ==================================================
// DATABASE
// ==================================================

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
// FIND VIP LEVEL FROM PAYMENT AMOUNT
// ==================================================
// Highest matching plan wins.
// Example:
// ₦100,000 -> VIP 6
// ₦50,000  -> VIP 5
// ₦1,500   -> VIP 1
// ==================================================

function getVipLevelFromAmount(amount) {

    const paidAmount = Number(amount);

    const levels =
        Object.keys(vipPlans)
            .map(Number)
            .sort((a, b) => b - a);

    for (const level of levels) {

        if (
            paidAmount >=
            vipPlans[level].price
        ) {
            return level;
        }
    }

    return null;
}


// ==================================================
// PASSWORD HASHING
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


// ==================================================
// PASSWORD VERIFICATION
// ==================================================

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
// DATABASE TABLES
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

            email VARCHAR(255)
                UNIQUE NOT NULL,

            password_hash TEXT NOT NULL,

            balance NUMERIC(14,2)
                DEFAULT 0,

            vip_level INTEGER
                DEFAULT 0,

            last_vip_claim TIMESTAMP NULL,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
            id SERIAL PRIMARY KEY,

            user_id INTEGER
                REFERENCES users(id),

            reference VARCHAR(255)
                UNIQUE NOT NULL,

            amount NUMERIC(14,2)
                NOT NULL,

            status VARCHAR(50)
                DEFAULT 'pending',

            provider VARCHAR(50)
                DEFAULT 'moneta',

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,

            user_id INTEGER
                REFERENCES users(id),

            type VARCHAR(50)
                NOT NULL,

            amount NUMERIC(14,2)
                NOT NULL,

            description TEXT,

            reference VARCHAR(255),

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
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
            "Zavero backend is working",

        site:
            SITE_URL
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
            )
            .trim()
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

                id:
                    user.id,

                name:
                    user.name,

                email:
                    user.email,

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

                id:
                    user.id,

                name:
                    user.name,

                email:
                    user.email,

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
// VIP INFORMATION
// ==================================================

app.get("/vip-plans", (req, res) => {

    res.json({

        success: true,

        plans: vipPlans

    });

});


// ==================================================
// CLAIM VIP DAILY REWARD
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
                Number(
                    user.vip_level
                );


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


            if (!email) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required."

                });

            }


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
// PAYMENT STATUS PLACEHOLDER
// ==================================================
// This intentionally does not process payments yet.
// We will replace it with the approved Moneta flow
// after Moneta confirms Zavero.
// ==================================================

app.get(
    "/payment-status",
    (req, res) => {

        res.json({

            success: true,

            provider:
                "moneta",

            status:
                "pending_integration",

            message:
                "Payment integration is waiting for merchant approval."

        });

    }
);


// ==================================================
// SERVER START
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
