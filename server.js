const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

const SITE_URL =
  process.env.SITE_URL ||
  "https://zavero-earning-platform.onrender.com";

const COMMUNITY_REWARD = 400;
const REFERRAL_REWARD = 500;

const VIP_PLANS = {
  1: {
    name: "VIP 1",
    price: 1500,
    dailyReward: 200
  },
  2: {
    name: "VIP 2",
    price: 5000,
    dailyReward: 800
  },
  3: {
    name: "VIP 3",
    price: 10000,
    dailyReward: 1750
  },
  4: {
    name: "VIP 4",
    price: 25000,
    dailyReward: 4100
  },
  5: {
    name: "VIP 5",
    price: 50000,
    dailyReward: 7500
  },
  6: {
    name: "VIP 6",
    price: 100000,
    dailyReward: 15000
  }
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
==================================================
CORS
==================================================
*/

app.use(
  cors({
    origin: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],
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
DATABASE SETUP
==================================================
*/

async function setupDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

  /*
  USERS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      vip_level INTEGER NOT NULL DEFAULT 0,
      last_vip_claim TIMESTAMPTZ,
      referred_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
  Make sure older databases receive the newer columns.
  */

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2) NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS vip_level INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_vip_claim TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referred_by INTEGER
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  /*
  PAYMENTS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      reference TEXT,
      payment_type TEXT DEFAULT 'vip',
      vip_level INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reference TEXT
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'vip'
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS vip_level INTEGER
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
  `);

  /*
  TRANSACTIONS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS type TEXT
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS description TEXT
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS reference TEXT
  `);

  await pool.query(`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  /*
  COMMUNITY REWARDS
  One user can only have one community reward.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_rewards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL,
      amount NUMERIC(14,2) NOT NULL DEFAULT 400,
      status TEXT NOT NULL DEFAULT 'claimed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
  REFERRAL REWARDS
  One referred user can generate only one referral reward.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_rewards (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      referred_user_id INTEGER UNIQUE NOT NULL,
      amount NUMERIC(14,2) NOT NULL DEFAULT 500,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("Zavero database setup completed.");
}

/*
==================================================
HELPERS
==================================================
*/

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");

    crypto.scrypt(
      String(password),
      salt,
      64,
      (err, derivedKey) => {
        if (err) return reject(err);

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
        return resolve(false);
      }

      const salt = parts[0];
      const storedKey = Buffer.from(parts[1], "hex");

      crypto.scrypt(
        String(password),
        salt,
        64,
        (err, derivedKey) => {
          if (err) return reject(err);

          try {
            resolve(
              crypto.timingSafeEqual(
                storedKey,
                derivedKey
              )
            );
          } catch {
            resolve(false);
          }
        }
      );
    } catch {
      resolve(false);
    }
  });
}

function getVIPLevelFromAmount(amount) {
  const numericAmount = Number(amount);

  for (const level of Object.keys(VIP_PLANS)) {
    if (
      Number(VIP_PLANS[level].price) ===
      numericAmount
    ) {
      return Number(level);
    }
  }

  return null;
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
    site: SITE_URL
  });
});

/*
==================================================
TEST
==================================================
*/

app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Zavero connection test is working"
  });
});

/*
==================================================
SIGN UP
==================================================
*/

app.post("/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
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
      `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    /*
    Referral code can be sent as:
    referredBy
    referred_by
    referralCode
    */

    const referralInput =
      req.body.referredBy ||
      req.body.referred_by ||
      req.body.referralCode ||
      null;

    let referrerId = null;

    if (referralInput) {
      const referrerResult = await pool.query(
        `SELECT id
         FROM users
         WHERE id::text = $1
            OR LOWER(email) = LOWER($1)
         LIMIT 1`,
        [String(referralInput).trim()]
      );

      if (referrerResult.rows.length > 0) {
        referrerId = referrerResult.rows[0].id;
      }
    }

    const passwordHash =
      await hashPassword(password);

    const result = await pool.query(
      `INSERT INTO users
       (name, email, password_hash, balance, vip_level, referred_by)
       VALUES ($1, $2, $3, 0, 0, $4)
       RETURNING id, name, email, balance, vip_level`,
      [
        name,
        email,
        passwordHash,
        referrerId
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
        vip_level: Number(user.vip_level)
      }
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
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const result = await pool.query(
      `SELECT
        id,
        name,
        email,
        password_hash,
        balance,
        vip_level,
        last_vip_claim,
        referred_by
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
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
        password,
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
        balance: Number(user.balance),
        vip_level: Number(user.vip_level),
        last_vip_claim: user.last_vip_claim,
        referred_by: user.referred_by
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
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const result = await pool.query(
      `SELECT
        id,
        name,
        email,
        balance,
        vip_level,
        last_vip_claim,
        referred_by
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
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
      balance: Number(user.balance),
      vip_level: Number(user.vip_level),
      last_vip_claim: user.last_vip_claim,
      name: user.name,
      email: user.email,
      referred_by: user.referred_by
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
OPAY DETAILS
==================================================
*/

app.get("/opay-details", (req, res) => {
  res.json({
    success: true,
    account_name:
      process.env.OPAY_ACCOUNT_NAME || "",
    account_number:
      process.env.OPAY_ACCOUNT_NUMBER || ""
  });
});

/*
==================================================
SUBMIT VIP PAYMENT
==================================================
*/

app.post("/submit-vip-payment", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const vipLevel = Number(req.body.vipLevel);
    const reference = String(
      req.body.reference || ""
    ).trim();

    if (!email || !vipLevel || !reference) {
      return res.status(400).json({
        success: false,
        message:
          "Email, VIP level and OPay transaction reference are required."
      });
    }

    if (!VIP_PLANS[vipLevel]) {
      return res.status(400).json({
        success: false,
        message: "Invalid VIP plan."
      });
    }

    if (reference.length < 3) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid OPay transaction reference."
      });
    }

    const userResult = await pool.query(
      `SELECT id, name, email, vip_level
       FROM users
       WHERE LOWER(email) = $1
       LIMIT 1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found."
      });
    }

    const user = userResult.rows[0];

    /*
    Prevent duplicate pending references.
    */

    const duplicateReference =
      await pool.query(
        `SELECT id
         FROM payments
         WHERE LOWER(reference) = LOWER($1)
           AND status IN ('pending', 'approved')
         LIMIT 1`,
        [reference]
      );

    if (duplicateReference.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message:
          "This OPay transaction reference has already been submitted."
      });
    }

    /*
    If user already has this VIP or higher,
    do not submit another identical VIP request.
    */

    if (
      Number(user.vip_level) >= vipLevel
    ) {
      return res.status(400).json({
        success: false,
        message:
          "You already have this VIP level or a higher VIP level."
      });
    }

    const amount =
      VIP_PLANS[vipLevel].price;

    const result = await pool.query(
      `INSERT INTO payments
       (user_id, amount, reference, payment_type, vip_level, status)
       VALUES ($1, $2, $3, 'vip', $4, 'pending')
       RETURNING id, amount, reference, vip_level, status, created_at`,
      [
        user.id,
        amount,
        reference,
        vipLevel
      ]
    );

    res.json({
      success: true,
      message:
        "VIP payment submitted. Please wait for moderator approval.",
      payment: result.rows[0]
    });
  } catch (error) {
    console.error(
      "SUBMIT VIP PAYMENT ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to submit VIP payment."
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
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const result = await pool.query(
      `SELECT
        p.id,
        p.amount,
        p.reference,
        p.payment_type,
        p.vip_level,
        p.status,
        p.rejection_reason,
        p.created_at,
        p.approved_at
       FROM payments p
       JOIN users u ON u.id = p.user_id
       WHERE LOWER(u.email) = $1
       ORDER BY p.created_at DESC`,
      [email]
    );

    res.json({
      success: true,
      payments: result.rows.map(p => ({
        ...p,
        amount: Number(p.amount)
      }))
    });
  } catch (error) {
    console.error(
      "MY PAYMENTS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Unable to load payment history."
    });
  }
});

/*
==================================================
CLAIM VIP DAILY REWARD
==================================================
*/

app.post("/claim-vip", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
        `SELECT
          id,
          balance,
          vip_level,
          last_vip_claim
         FROM users
         WHERE LOWER(email) = $1
         FOR UPDATE`,
        [email]
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
        Number(user.vip_level);

      if (
        !vipLevel ||
        !VIP_PLANS[vipLevel]
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "You must activate a VIP before claiming a daily reward."
        });
      }

      if (user.last_vip_claim) {
        const lastClaim =
          new Date(user.last_vip_claim);

        const now = new Date();

        const elapsed =
          now.getTime() -
          lastClaim.getTime();

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
              `Your next VIP reward is available in ${hours}h ${minutes}m.`
          });
        }
      }

      const reward =
        VIP_PLANS[vipLevel]
          .dailyReward;

      const newBalance =
        Number(user.balance) +
        Number(reward);

      await client.query(
        `UPDATE users
         SET balance = $1,
             last_vip_claim = NOW()
         WHERE id = $2`,
        [
          newBalance,
          user.id
        ]
      );

      await client.query(
        `INSERT INTO transactions
         (user_id, amount, type, description, reference)
         VALUES
         ($1, $2, 'vip_reward',
          $3, $4)`,
        [
          user.id,
          reward,
          `${VIP_PLANS[vipLevel].name} Daily Reward`,
          `VIP-${user.id}-${Date.now()}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          `₦${Number(reward).toLocaleString()} VIP reward added to your wallet.`,
        reward: Number(reward),
        balance: newBalance
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

/*
==================================================
TRANSACTIONS
==================================================
*/

app.get("/transactions", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const result = await pool.query(
      `SELECT
        t.id,
        t.amount,
        t.type,
        t.description,
        t.reference,
        t.created_at
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE LOWER(u.email) = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [email]
    );

    res.json({
      success: true,
      transactions: result.rows.map(t => ({
        ...t,
        amount: Number(t.amount)
      }))
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
COMMUNITY REWARD STATUS
==================================================
*/

app.get(
  "/community-reward-status",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(req.query.email);

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required."
        });
      }

      const userResult = await pool.query(
        `SELECT id
         FROM users
         WHERE LOWER(email) = $1
         LIMIT 1`,
        [email]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "User not found."
        });
      }

      const userId =
        userResult.rows[0].id;

      const rewardResult =
        await pool.query(
          `SELECT id
           FROM community_rewards
           WHERE user_id = $1
           LIMIT 1`,
          [userId]
        );

      res.json({
        success: true,
        claimed:
          rewardResult.rows.length > 0,
        amount: COMMUNITY_REWARD
      });
    } catch (error) {
      console.error(
        "COMMUNITY STATUS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load community reward status."
      });
    }
  }
);

/*
==================================================
CLAIM COMMUNITY ₦400
==================================================

This does NOT require VIP.

One account can claim only once.
*/

app.post(
  "/claim-community-reward",
  async (req, res) => {
    const client = await pool.connect();

    try {
      const email =
        normalizeEmail(req.body.email);

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required."
        });
      }

      await client.query("BEGIN");

      const userResult =
        await client.query(
          `SELECT id, balance
           FROM users
           WHERE LOWER(email) = $1
           FOR UPDATE`,
          [email]
        );

      if (userResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "User not found."
        });
      }

      const user =
        userResult.rows[0];

      /*
      Attempt to create the reward record.
      UNIQUE(user_id) prevents duplicates.
      */

      const rewardInsert =
        await client.query(
          `INSERT INTO community_rewards
           (user_id, amount, status)
           VALUES ($1, $2, 'claimed')
           ON CONFLICT (user_id)
           DO NOTHING
           RETURNING id`,
          [
            user.id,
            COMMUNITY_REWARD
          ]
        );

      if (
        rewardInsert.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "You have already claimed your ₦400 community reward."
        });
      }

      const newBalance =
        Number(user.balance) +
        COMMUNITY_REWARD;

      await client.query(
        `UPDATE users
         SET balance = $1
         WHERE id = $2`,
        [
          newBalance,
          user.id
        ]
      );

      await client.query(
        `INSERT INTO transactions
         (user_id, amount, type, description, reference)
         VALUES
         ($1, $2, 'community_reward',
          'WhatsApp Community Reward', $3)`,
        [
          user.id,
          COMMUNITY_REWARD,
          `COMMUNITY-${user.id}-${Date.now()}`
        ]
      );

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          "₦400 community reward has been added to your wallet.",
        reward: COMMUNITY_REWARD,
        balance: newBalance
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "COMMUNITY REWARD ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to claim community reward."
      });
    } finally {
      client.release();
    }
  }
);

/*
==================================================
REFERRAL STATUS
==================================================
*/

app.get(
  "/referral-status",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(req.query.email);

      if (!email) {
        return res.status(400).json({
          success: false,
          message: "Email is required."
        });
      }

      const userResult =
        await pool.query(
          `SELECT id
           FROM users
           WHERE LOWER(email) = $1
           LIMIT 1`,
          [email]
        );

      if (userResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "User not found."
        });
      }

      const userId =
        userResult.rows[0].id;

      const countResult =
        await pool.query(
          `SELECT COUNT(*)::integer AS count
           FROM users
           WHERE referred_by = $1`,
          [userId]
        );

      const paidResult =
        await pool.query(
          `SELECT COUNT(*)::integer AS count
           FROM referral_rewards
           WHERE referrer_id = $1
             AND status = 'paid'`,
          [userId]
        );

      res.json({
        success: true,
        totalReferrals:
          Number(countResult.rows[0].count),
        paidReferrals:
          Number(paidResult.rows[0].count),
        rewardPerReferral:
          REFERRAL_REWARD
      });
    } catch (error) {
      console.error(
        "REFERRAL STATUS ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load referral information."
      });
    }
  }
);

/*
==================================================
OLD WALLET VIP UPGRADE
==================================================
*/

app.post("/upgrade-vip", (req, res) => {
  res.status(410).json({
    success: false,
    message:
      "VIP upgrades must be paid through the OPay payment process."
  });
});

/*
==================================================
MODERATOR: PENDING PAYMENTS
==================================================
*/

app.get(
  "/moderator/pending-payments",
  async (req, res) => {
    try {
      const moderatorKey =
        String(
          req.headers["x-moderator-key"] || ""
        );

      if (
        !process.env.MODERATOR_KEY ||
        moderatorKey !==
          process.env.MODERATOR_KEY
      ) {
        return res.status(401).json({
          success: false,
          message: "Invalid moderator key."
        });
      }

      const result = await pool.query(
        `SELECT
          p.id,
          p.user_id,
          u.name,
          u.email,
          p.amount,
          p.reference,
          p.vip_level,
          p.status,
          p.created_at
         FROM payments p
         JOIN users u ON u.id = p.user_id
         WHERE p.status = 'pending'
         ORDER BY p.created_at ASC`
      );

      /*
      Only show payments where the amount exactly
      matches the selected VIP plan.

      This hides old invalid payments such as ₦1,000.
      */

      const validPayments =
        result.rows.filter(payment => {
          const amount =
            Number(payment.amount);

          const levelFromAmount =
            getVIPLevelFromAmount(amount);

          const requestedLevel =
            Number(payment.vip_level);

          const level =
            requestedLevel &&
            VIP_PLANS[requestedLevel]
              ? requestedLevel
              : levelFromAmount;

          return (
            level &&
            Number(VIP_PLANS[level].price) ===
              amount
          );
        });

      res.json({
        success: true,
        payments: validPayments.map(
          payment => {
            const amount =
              Number(payment.amount);

            const derivedLevel =
              getVIPLevelFromAmount(
                amount
              );

            const vipLevel =
              Number(payment.vip_level) &&
              VIP_PLANS[
                Number(payment.vip_level)
              ]
                ? Number(payment.vip_level)
                : derivedLevel;

            return {
              id: payment.id,
              user_id: payment.user_id,
              name: payment.name,
              email: payment.email,
              amount,
              reference:
                payment.reference,
              vip_level: vipLevel,
              vip_name:
                VIP_PLANS[vipLevel]
                  ? VIP_PLANS[vipLevel].name
                  : "VIP",
              status:
                payment.status,
              created_at:
                payment.created_at
            };
          }
        )
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

/*
==================================================
MODERATOR: APPROVE PAYMENT
==================================================
*/

app.post(
  "/moderator/payments/:id/approve",
  async (req, res) => {
    const client = await pool.connect();

    try {
      const moderatorKey =
        String(
          req.headers["x-moderator-key"] || ""
        );

      if (
        !process.env.MODERATOR_KEY ||
        moderatorKey !==
          process.env.MODERATOR_KEY
      ) {
        return res.status(401).json({
          success: false,
          message: "Invalid moderator key."
        });
      }

      const paymentId =
        Number(req.params.id);

      if (!paymentId) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment ID."
        });
      }

      await client.query("BEGIN");

      const paymentResult =
        await client.query(
          `SELECT
            p.id,
            p.user_id,
            p.amount,
            p.reference,
            p.vip_level,
            p.status,
            u.email,
            u.name,
            u.vip_level AS current_vip_level
           FROM payments p
           JOIN users u ON u.id = p.user_id
           WHERE p.id = $1
           FOR UPDATE`,
          [paymentId]
        );

      if (
        paymentResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Payment not found."
        });
      }

      const payment =
        paymentResult.rows[0];

      if (
        payment.status !== "pending"
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "This payment has already been processed."
        });
      }

      const amount =
        Number(payment.amount);

      /*
      Determine VIP from exact amount.
      */

      let vipLevel =
        Number(payment.vip_level);

      if (
        !vipLevel ||
        !VIP_PLANS[vipLevel]
      ) {
        vipLevel =
          getVIPLevelFromAmount(amount);
      }

      if (
        !vipLevel ||
        !VIP_PLANS[vipLevel]
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "This payment amount does not match a valid VIP plan."
        });
      }

      if (
        Number(VIP_PLANS[vipLevel].price) !==
        amount
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Payment amount does not exactly match the VIP price."
        });
      }

      const oldVIP =
        Number(
          payment.current_vip_level
        );

      /*
      Only the FIRST successful VIP activation
      generates the referral reward.
      */

      const isFirstVIP =
        oldVIP === 0;

      /*
      Activate the requested VIP.
      */

      await client.query(
        `UPDATE users
         SET vip_level = $1,
             last_vip_claim = NULL
         WHERE id = $2`,
        [
          vipLevel,
          payment.user_id
        ]
      );

      /*
      Mark payment approved.
      */

      await client.query(
        `UPDATE payments
         SET status = 'approved',
             vip_level = $1,
             approved_at = NOW()
         WHERE id = $2`,
        [
          vipLevel,
          paymentId
        ]
      );

      /*
      Record VIP activation transaction.

      The VIP purchase itself does NOT add money
      to the user's wallet.
      */

      await client.query(
        `INSERT INTO transactions
         (user_id, amount, type, description, reference)
         VALUES
         ($1, $2, 'vip_activation',
          $3, $4)`,
        [
          payment.user_id,
          0,
          `${VIP_PLANS[vipLevel].name} activated`,
          payment.reference ||
            `VIP-ACTIVATION-${paymentId}`
        ]
      );

      /*
      REFERRAL REWARD
      */

      let referralPaid = false;
      let referralAmount = 0;

      if (isFirstVIP) {
        const referrerResult =
          await client.query(
            `SELECT referred_by
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [payment.user_id]
          );

        if (
          referrerResult.rows.length > 0
        ) {
          const referrerId =
            referrerResult.rows[0]
              .referred_by;

          /*
          Make sure the referred user has
          an actual referrer.
          */

          if (
            referrerId &&
            Number(referrerId) !==
              Number(payment.user_id)
          ) {
            /*
            The UNIQUE referred_user_id
            makes this one-time.
            */

            const referralInsert =
              await client.query(
                `INSERT INTO referral_rewards
                 (referrer_id, referred_user_id, amount, status)
                 VALUES ($1, $2, $3, 'paid')
                 ON CONFLICT (referred_user_id)
                 DO NOTHING
                 RETURNING id`,
                [
                  referrerId,
                  payment.user_id,
                  REFERRAL_REWARD
                ]
              );

            if (
              referralInsert.rows
                .length > 0
            ) {
              const referrerBalanceResult =
                await client.query(
                  `SELECT balance
                   FROM users
                   WHERE id = $1
                   FOR UPDATE`,
                  [referrerId]
                );

              if (
                referrerBalanceResult.rows
                  .length > 0
              ) {
                const referrerBalance =
                  Number(
                    referrerBalanceResult
                      .rows[0].balance
                  );

                const newReferrerBalance =
                  referrerBalance +
                  REFERRAL_REWARD;

                await client.query(
                  `UPDATE users
                   SET balance = $1
                   WHERE id = $2`,
                  [
                    newReferrerBalance,
                    referrerId
                  ]
                );

                await client.query(
                  `INSERT INTO transactions
                   (user_id, amount, type, description, reference)
                   VALUES
                   ($1, $2, 'referral_reward',
                    'Referral VIP Activation Reward',
                    $3)`,
                  [
                    referrerId,
                    REFERRAL_REWARD,
                    `REFERRAL-${payment.user_id}-${Date.now()}`
                  ]
                );

                referralPaid = true;
                referralAmount =
                  REFERRAL_REWARD;
              }
            }
          }
        }
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          "Payment approved and VIP activated.",
        vip_level: vipLevel,
        referral_reward_paid:
          referralPaid,
        referral_reward:
          referralAmount
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

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

/*
==================================================
MODERATOR: REJECT PAYMENT
==================================================
*/

app.post(
  "/moderator/payments/:id/reject",
  async (req, res) => {
    try {
      const moderatorKey =
        String(
          req.headers["x-moderator-key"] || ""
        );

      if (
        !process.env.MODERATOR_KEY ||
        moderatorKey !==
          process.env.MODERATOR_KEY
      ) {
        return res.status(401).json({
          success: false,
          message: "Invalid moderator key."
        });
      }

      const paymentId =
        Number(req.params.id);

      const reason = String(
        req.body.reason ||
          "Payment rejected by moderator."
      ).trim();

      const result =
        await pool.query(
          `UPDATE payments
           SET status = 'rejected',
               rejection_reason = $1
           WHERE id = $2
             AND status = 'pending'
           RETURNING id`,
          [
            reason,
            paymentId
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Pending payment not found."
        });
      }

      res.json({
        success: true,
        message:
          "Payment rejected successfully."
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

/*
==================================================
START SERVER
==================================================
*/

async function startServer() {
  try {
    await setupDatabase();

    app.listen(PORT, () => {
      console.log(
        `Zavero backend running on port ${PORT}`
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
