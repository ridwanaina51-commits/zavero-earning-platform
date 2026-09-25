const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/*
==================================================
ZAVERO EARNING PLATFORM
MANUAL OPAY VIP PAYMENT SYSTEM
==================================================

Flow:

USER
1. Login
2. Select VIP
3. See OPay account details
4. Transfer money manually
5. Enter OPay transaction reference
6. Submit payment

MODERATOR
1. Login with MODERATOR_KEY
2. See valid pending payments
3. Check OPay manually
4. Approve or Reject
5. Approval activates VIP

NO MONETA
NO AUTOMATIC OPAY API
NO DIRECT VIP UPGRADE FROM WALLET
==================================================
*/


/*
==================================================
CORS
==================================================
*/

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "x-moderator-key",
      "Authorization"
    ]
  })
);

app.use(express.json());


/*
==================================================
ENVIRONMENT VARIABLES
==================================================
*/

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const SITE_URL =
  process.env.SITE_URL ||
  "https://zavero-earning-platform.onrender.com";

const OPAY_ACCOUNT_NAME =
  process.env.OPAY_ACCOUNT_NAME || "";

const OPAY_ACCOUNT_NUMBER =
  process.env.OPAY_ACCOUNT_NUMBER || "";

const MODERATOR_KEY =
  process.env.MODERATOR_KEY || "";


/*
==================================================
DATABASE
==================================================
*/

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


/*
==================================================
VIP PLANS
==================================================
*/

const VIP_PLANS = {
  1: {
    level: 1,
    name: "VIP 1",
    price: 1500,
    daily: 200
  },

  2: {
    level: 2,
    name: "VIP 2",
    price: 5000,
    daily: 800
  },

  3: {
    level: 3,
    name: "VIP 3",
    price: 10000,
    daily: 1750
  },

  4: {
    level: 4,
    name: "VIP 4",
    price: 25000,
    daily: 4100
  },

  5: {
    level: 5,
    name: "VIP 5",
    price: 50000,
    daily: 7500
  },

  6: {
    level: 6,
    name: "VIP 6",
    price: 100000,
    daily: 15000
  }
};


/*
==================================================
HELPER FUNCTIONS
==================================================
*/


function getVipPlan(level) {
  return VIP_PLANS[Number(level)] || null;
}


function getVipLevelFromAmount(amount) {
  const numericAmount = Number(amount);

  for (const key of Object.keys(VIP_PLANS)) {
    if (VIP_PLANS[key].price === numericAmount) {
      return Number(key);
    }
  }

  return null;
}


function isValidVipPayment(level, amount) {
  const plan = getVipPlan(level);

  if (!plan) {
    return false;
  }

  return Number(amount) === plan.price;
}


function safeModeratorKey(providedKey) {
  if (!MODERATOR_KEY || !providedKey) {
    return false;
  }

  const a = Buffer.from(String(providedKey));
  const b = Buffer.from(String(MODERATOR_KEY));

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}


function moderatorAuth(req, res, next) {
  const providedKey = req.headers["x-moderator-key"];

  if (!safeModeratorKey(providedKey)) {
    return res.status(401).json({
      success: false,
      message: "Invalid moderator key"
    });
  }

  next();
}


function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");

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


function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    try {
      const parts = String(storedHash).split(":");

      if (parts.length !== 2) {
        resolve(false);
        return;
      }

      const salt = parts[0];
      const storedKey = Buffer.from(parts[1], "hex");

      crypto.scrypt(
        password,
        salt,
        64,
        (err, derivedKey) => {
          if (err) {
            reject(err);
            return;
          }

          if (storedKey.length !== derivedKey.length) {
            resolve(false);
            return;
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


function getUserIdFromRequest(req) {
  return (
    req.body?.userId ||
    req.body?.user_id ||
    req.query?.userId ||
    req.query?.user_id ||
    null
  );
}


/*
==================================================
DATABASE SETUP
==================================================
*/

async function setupDatabase() {
  console.log("Starting database setup...");

  /*
  USERS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance NUMERIC(12,2) DEFAULT 0,
      vip_level INTEGER DEFAULT 0,
      last_vip_claim TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  /*
  Make sure older database versions have these columns.
  */

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS balance NUMERIC(12,2) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS vip_level INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_vip_claim TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);


  /*
  PAYMENTS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reference TEXT,
      payment_type TEXT NOT NULL DEFAULT 'manual_opay',
      vip_level INTEGER,
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT,
      rejection_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  /*
  Older payments table compatibility.
  */

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS user_id INTEGER
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2)
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reference TEXT
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'manual_opay'
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS vip_level INTEGER
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);


  /*
  TRANSACTIONS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) DEFAULT 0,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);


  /*
  Fix old pending payments that have a valid VIP amount
  but no vip_level.
  */

  for (const level of Object.keys(VIP_PLANS)) {
    const plan = VIP_PLANS[level];

    await pool.query(
      `
      UPDATE payments
      SET vip_level = $1
      WHERE vip_level IS NULL
      AND amount = $2
      AND status = 'pending'
      `,
      [plan.level, plan.price]
    );
  }


  /*
  INDEXES
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_status
    ON payments(status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_user_id
    ON payments(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_payments_reference
    ON payments(reference)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_user_id
    ON transactions(user_id)
  `);


  console.log("Database setup completed.");
}


/*
==================================================
HOME
==================================================
*/

app.get("/", (req, res) => {
  res.send(`
    <h1>Zavero backend is working!</h1>
    <p>Manual OPay VIP payment system is active.</p>
  `);
});


/*
==================================================
TEST
==================================================
*/

app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Zavero connection test is working",
    manualOpay: true,
    databaseConfigured: Boolean(DATABASE_URL),
    opayConfigured: Boolean(
      OPAY_ACCOUNT_NAME &&
      OPAY_ACCOUNT_NUMBER
    ),
    moderatorConfigured: Boolean(MODERATOR_KEY),
    siteUrl: SITE_URL
  });
});


/*
==================================================
SIGN UP
==================================================
*/

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
        message: "Name, email and password are required"
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail =
      String(email).trim().toLowerCase();

    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [cleanEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email already exists"
      });
    }

    const passwordHash =
      await hashPassword(String(password));

    const result = await pool.query(
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
        cleanName,
        cleanEmail,
        passwordHash
      ]
    );

    const user = result.rows[0];

    res.json({
      success: true,
      message: "Account created successfully",
      user,
      userId: user.id
    });

  } catch (error) {
    console.error("SIGNUP ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create account"
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
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const cleanEmail =
      String(email).trim().toLowerCase();

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
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
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
        message: "Invalid email or password"
      });
    }

    delete user.password_hash;

    res.json({
      success: true,
      message: "Login successful",
      user,
      userId: user.id
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to login"
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
    const userId =
      req.query.userId ||
      req.query.user_id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
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
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user,
      balance: Number(user.balance || 0),
      vipLevel: Number(user.vip_level || 0)
    });

  } catch (error) {
    console.error("BALANCE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Unable to get balance"
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
    plans: Object.values(VIP_PLANS)
  });
});


/*
==================================================
OPAY DETAILS
==================================================
*/

app.get("/opay-details", (req, res) => {
  res.json({
    success: true,
    paymentMethod: "OPay",
    accountName: OPAY_ACCOUNT_NAME,
    accountNumber: OPAY_ACCOUNT_NUMBER,
    instructions: [
      "Select the VIP plan you want.",
      "Transfer the exact VIP amount to the OPay account shown.",
      "Complete the transfer from your own payment account.",
      "Copy your OPay transaction/reference number.",
      "Submit the reference on Zavero.",
      "Wait for moderator approval."
    ]
  });
});


/*
==================================================
SUBMIT VIP PAYMENT
==================================================
*/

app.post("/submit-vip-payment", async (req, res) => {
  try {
    const userId =
      req.body.userId ||
      req.body.user_id;

    const vipLevel = Number(
      req.body.vipLevel ||
      req.body.vip_level
    );

    const amount = Number(
      req.body.amount
    );

    const reference = String(
      req.body.reference ||
      req.body.opayReference ||
      req.body.opay_reference ||
      ""
    ).trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required"
      });
    }

    if (!vipLevel || !amount || !reference) {
      return res.status(400).json({
        success: false,
        message:
          "VIP plan, amount and OPay reference are required"
      });
    }

    /*
    IMPORTANT:
    The amount must exactly match the selected VIP.
    */

    if (!isValidVipPayment(vipLevel, amount)) {
      const plan = getVipPlan(vipLevel);

      return res.status(400).json({
        success: false,
        message: plan
          ? `VIP ${vipLevel} requires exactly ₦${plan.price.toLocaleString()}`
          : "Invalid VIP plan"
      });
    }

    /*
    Make sure user exists.
    */

    const userResult = await pool.query(
      `
      SELECT
        id,
        name,
        email
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    /*
    Prevent duplicate OPay references.
    */

    const duplicate = await pool.query(
      `
      SELECT id
      FROM payments
      WHERE LOWER(reference) = LOWER($1)
      LIMIT 1
      `,
      [reference]
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This OPay reference has already been submitted"
      });
    }

    /*
    Prevent multiple pending requests for the
    same user and same VIP.
    */

    const existingPending = await pool.query(
      `
      SELECT id
      FROM payments
      WHERE user_id = $1
      AND status = 'pending'
      AND vip_level = $2
      LIMIT 1
      `,
      [userId, vipLevel]
    );

    if (existingPending.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "You already have a pending payment for this VIP"
      });
    }

    const payment = await pool.query(
      `
      INSERT INTO payments
      (
        user_id,
        amount,
        status,
        reference,
        payment_type,
        vip_level
      )
      VALUES
      ($1, $2, 'pending', $3, 'manual_opay', $4)
      RETURNING
        id,
        user_id,
        amount,
        status,
        reference,
        payment_type,
        vip_level,
        created_at
      `,
      [
        userId,
        amount,
        reference,
        vipLevel
      ]
    );

    const row = payment.rows[0];
    const plan = getVipPlan(vipLevel);

    res.json({
      success: true,
      message:
        "Payment submitted successfully. Waiting for moderator approval.",
      payment: {
        ...row,
        vipName: plan.name,
        vipLevel: plan.level,
        amount: Number(row.amount)
      }
    });

  } catch (error) {
    console.error(
      "SUBMIT VIP PAYMENT ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Unable to submit payment"
    });
  }
});


/*
==================================================
MY PAYMENTS
==================================================
*/

app.get("/my-payments", async (req, res) => {
  try {
    const userId =
      req.query.userId ||
      req.query.user_id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    /*
    The CASE below also fixes old valid payments
    that were saved without vip_level.
    */

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.user_id,
        p.amount,
        p.status,
        p.reference,
        p.payment_type,
        COALESCE(
          p.vip_level,
          CASE
            WHEN p.amount = 1500 THEN 1
            WHEN p.amount = 5000 THEN 2
            WHEN p.amount = 10000 THEN 3
            WHEN p.amount = 25000 THEN 4
            WHEN p.amount = 50000 THEN 5
            WHEN p.amount = 100000 THEN 6
            ELSE NULL
          END
        ) AS vip_level,
        p.reviewed_at,
        p.reviewed_by,
        p.rejection_reason,
        p.created_at
      FROM payments p
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
      `,
      [userId]
    );

    const payments = result.rows.map(row => {
      const vipLevel =
        row.vip_level
          ? Number(row.vip_level)
          : null;

      const plan =
        vipLevel
          ? getVipPlan(vipLevel)
          : null;

      return {
        ...row,
        amount: Number(row.amount),
        vipLevel,
        vipName: plan ? plan.name : "Unknown",
        dailyReward: plan ? plan.daily : 0
      };
    });

    res.json({
      success: true,
      payments
    });

  } catch (error) {
    console.error(
      "MY PAYMENTS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Unable to get payments"
    });
  }
});


/*
==================================================
DIRECT VIP UPGRADE DISABLED
==================================================
*/

app.post("/upgrade-vip", (req, res) => {
  res.status(410).json({
    success: false,
    message:
      "Direct VIP upgrade is disabled. Pay through OPay and wait for moderator approval."
  });
});


/*
==================================================
CLAIM VIP DAILY REWARD
==================================================
*/

app.post("/claim-vip", async (req, res) => {
  const client = await pool.connect();

  try {
    const userId =
      req.body.userId ||
      req.body.user_id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required"
      });
    }

    await client.query("BEGIN");

    const userResult = await client.query(
      `
      SELECT
        id,
        name,
        email,
        balance,
        vip_level,
        last_vip_claim
      FROM users
      WHERE id = $1
      FOR UPDATE
      `,
      [userId]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = userResult.rows[0];

    const vipLevel =
      Number(user.vip_level || 0);

    const plan =
      getVipPlan(vipLevel);

    if (!plan) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message:
          "You do not have an active VIP plan"
      });
    }

    /*
    Check 24-hour waiting period.
    */

    if (user.last_vip_claim) {
      const lastClaim =
        new Date(user.last_vip_claim).getTime();

      const now =
        Date.now();

      const elapsed =
        now - lastClaim;

      const twentyFourHours =
        24 * 60 * 60 * 1000;

      if (elapsed < twentyFourHours) {
        const remaining =
          twentyFourHours - elapsed;

        const hours =
          Math.floor(
            remaining /
            (60 * 60 * 1000)
          );

        const minutes =
          Math.floor(
            (remaining %
              (60 * 60 * 1000)) /
              (60 * 1000)
          );

        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            `You can claim again in ${hours}h ${minutes}m`
        });
      }
    }

    /*
    Add daily reward to wallet.
    */

    const balanceResult =
      await client.query(
        `
        UPDATE users
        SET
          balance = COALESCE(balance, 0) + $1,
          last_vip_claim = NOW()
        WHERE id = $2
        RETURNING
          id,
          name,
          email,
          balance,
          vip_level,
          last_vip_claim
        `,
        [
          plan.daily,
          userId
        ]
      );

    /*
    Record transaction.
    */

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
      ($1, 'vip_claim', $2, $3)
      `,
      [
        userId,
        plan.daily,
        `${plan.name} daily reward`
      ]
    );

    await client.query("COMMIT");

    const updatedUser =
      balanceResult.rows[0];

    res.json({
      success: true,
      message:
        `₦${plan.daily.toLocaleString()} VIP reward claimed successfully`,
      reward: plan.daily,
      balance:
        Number(updatedUser.balance || 0),
      vipLevel:
        Number(updatedUser.vip_level || 0),
      lastVipClaim:
        updatedUser.last_vip_claim
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error(
      "CLAIM VIP ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Unable to claim VIP reward"
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
    const userId =
      req.query.userId ||
      req.query.user_id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        type,
        amount,
        description,
        created_at
      FROM transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    res.json({
      success: true,
      transactions:
        result.rows.map(row => ({
          ...row,
          amount: Number(row.amount || 0)
        }))
    });

  } catch (error) {
    console.error(
      "TRANSACTIONS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Unable to get transactions"
    });
  }
});


/*
==================================================
MODERATOR
PENDING PAYMENTS
==================================================

IMPORTANT:

Only payments that:
- are still pending
- have a valid VIP level
- have the exact matching VIP amount

are returned.

This means an old invalid payment such as
₦1,000 will NOT appear here.
==================================================
*/

app.get(
  "/moderator/pending-payments",
  moderatorAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          p.id,
          p.user_id,

          COALESCE(
            u.name,
            'Unknown'
          ) AS user_name,

          COALESCE(
            u.email,
            'Unknown'
          ) AS user_email,

          p.amount,
          p.status,
          p.reference,
          p.payment_type,

          COALESCE(
            p.vip_level,
            CASE
              WHEN p.amount = 1500 THEN 1
              WHEN p.amount = 5000 THEN 2
              WHEN p.amount = 10000 THEN 3
              WHEN p.amount = 25000 THEN 4
              WHEN p.amount = 50000 THEN 5
              WHEN p.amount = 100000 THEN 6
              ELSE NULL
            END
          ) AS vip_level,

          p.created_at,
          p.reviewed_at,
          p.reviewed_by,
          p.rejection_reason

        FROM payments p

        LEFT JOIN users u
          ON u.id = p.user_id

        WHERE p.status = 'pending'

        /*
        ONLY VALID VIP PAYMENTS
        */

        AND (
          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 1
            AND p.amount = 1500
          )

          OR

          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 2
            AND p.amount = 5000
          )

          OR

          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 3
            AND p.amount = 10000
          )

          OR

          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 4
            AND p.amount = 25000
          )

          OR

          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 5
            AND p.amount = 50000
          )

          OR

          (
            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) = 6
            AND p.amount = 100000
          )
        )

        ORDER BY p.created_at ASC
        `
      );

      const payments =
        result.rows.map(row => {
          const vipLevel =
            Number(row.vip_level);

          const plan =
            getVipPlan(vipLevel);

          return {
            id: row.id,
            userId: row.user_id,

            user:
              row.user_name || "Unknown",

            name:
              row.user_name || "Unknown",

            email:
              row.user_email || "Unknown",

            amount:
              Number(row.amount),

            status:
              row.status,

            reference:
              row.reference,

            opayReference:
              row.reference,

            paymentType:
              row.payment_type,

            vipLevel,

            vipName:
              plan
                ? plan.name
                : "Unknown",

            dailyReward:
              plan
                ? plan.daily
                : 0,

            createdAt:
              row.created_at,

            submitted:
              row.created_at,

            reviewedAt:
              row.reviewed_at,

            reviewedBy:
              row.reviewed_by,

            rejectionReason:
              row.rejection_reason
          };
        });

      res.json({
        success: true,
        payments
      });

    } catch (error) {
      console.error(
        "MODERATOR PENDING ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load pending payments"
      });
    }
  }
);


/*
==================================================
MODERATOR APPROVE PAYMENT
==================================================
*/

app.post(
  "/moderator/payments/:id/approve",
  moderatorAuth,
  async (req, res) => {

    const client =
      await pool.connect();

    try {
      const paymentId =
        Number(req.params.id);

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment ID"
        });
      }

      await client.query("BEGIN");

      /*
      Lock the payment so two moderators
      cannot approve it at the same time.
      */

      const paymentResult =
        await client.query(
          `
          SELECT
            p.id,
            p.user_id,
            p.amount,
            p.status,
            p.reference,

            COALESCE(
              p.vip_level,
              CASE
                WHEN p.amount = 1500 THEN 1
                WHEN p.amount = 5000 THEN 2
                WHEN p.amount = 10000 THEN 3
                WHEN p.amount = 25000 THEN 4
                WHEN p.amount = 50000 THEN 5
                WHEN p.amount = 100000 THEN 6
                ELSE NULL
              END
            ) AS vip_level

          FROM payments p

          WHERE p.id = $1

          FOR UPDATE
          `,
          [paymentId]
        );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Payment not found"
        });
      }

      const payment =
        paymentResult.rows[0];

      /*
      Payment must still be pending.
      */

      if (payment.status !== "pending") {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "This payment has already been reviewed"
        });
      }

      const vipLevel =
        Number(payment.vip_level);

      const amount =
        Number(payment.amount);

      const plan =
        getVipPlan(vipLevel);

      /*
      SECURITY CHECK:
      Never approve an amount that doesn't
      exactly match the VIP price.
      */

      if (
        !plan ||
        amount !== plan.price
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "This payment does not match a valid VIP plan and cannot be approved"
        });
      }

      /*
      User must exist.
      */

      const userResult =
        await client.query(
          `
          SELECT
            id,
            name,
            email,
            vip_level
          FROM users
          WHERE id = $1
          FOR UPDATE
          `,
          [payment.user_id]
        );

      if (userResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "The user connected to this payment no longer exists"
        });
      }

      const user =
        userResult.rows[0];

      /*
      APPROVE:
      Activate VIP.

      We do NOT deduct the amount from
      the Zavero wallet because the user
      already paid manually through OPay.
      */

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
          payment.user_id
        ]
      );

      /*
      Mark payment approved.
      */

      await client.query(
        `
        UPDATE payments
        SET
          status = 'approved',
          vip_level = $1,
          reviewed_at = NOW(),
          reviewed_by = 'moderator'
        WHERE id = $2
        `,
        [
          vipLevel,
          paymentId
        ]
      );

      /*
      Record approval in transactions.

      Amount is ZERO because the OPay payment
      did not enter the Zavero wallet.
      */

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
        ($1, 'vip_approved', 0, $2)
        `,
        [
          payment.user_id,
          `${plan.name} activated after manual OPay payment of ₦${plan.price.toLocaleString()}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          `${plan.name} approved successfully for ${user.name}`,
        paymentId,
        userId: payment.user_id,
        userName: user.name,
        vipLevel,
        vipName: plan.name,
        dailyReward: plan.daily
      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      console.error(
        "MODERATOR APPROVE ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to approve payment"
      });

    } finally {
      client.release();
    }
  }
);


/*
==================================================
MODERATOR REJECT PAYMENT
==================================================
*/

app.post(
  "/moderator/payments/:id/reject",
  moderatorAuth,
  async (req, res) => {

    const client =
      await pool.connect();

    try {
      const paymentId =
        Number(req.params.id);

      const reason =
        String(
          req.body.reason ||
          "Payment rejected by moderator"
        ).trim();

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment ID"
        });
      }

      await client.query("BEGIN");

      const paymentResult =
        await client.query(
          `
          SELECT
            id,
            user_id,
            amount,
            status,
            reference,
            vip_level
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
          message: "Payment not found"
        });
      }

      const payment =
        paymentResult.rows[0];

      if (payment.status !== "pending") {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "This payment has already been reviewed"
        });
      }

      await client.query(
        `
        UPDATE payments
        SET
          status = 'rejected',
          reviewed_at = NOW(),
          reviewed_by = 'moderator',
          rejection_reason = $1
        WHERE id = $2
        `,
        [
          reason,
          paymentId
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          "Payment rejected successfully",
        paymentId,
        reason
      });

    } catch (error) {

      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      console.error(
        "MODERATOR REJECT ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to reject payment"
      });

    } finally {
      client.release();
    }
  }
);


/*
==================================================
START SERVER
==================================================
*/

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

      console.log(
        `Zavero backend is live at ${SITE_URL}`
      );
    });

  } catch (error) {

    console.error(
      "DATABASE SETUP ERROR:",
      error
    );

    process.exit(1);
  }
}


startServer();
