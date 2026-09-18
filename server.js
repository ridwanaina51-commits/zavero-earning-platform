const express = require("express");
const cors = require("cors");

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
// TEMPORARY USER DATA
// NOTE: This is stored in memory and resets if Render
// restarts or redeploys the server.
// =====================================================

const userBalances = {};
const verifiedPayments = {};
const userVIP = {};
const lastVIPClaim = {};

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
// HOME / TEST
// =====================================================

app.get("/", (req, res) => {
    res.send("Zavero backend is working");
});

app.get("/test", (req, res) => {
    res.json({
        success: true,
        message: "Zavero connection test is working"
    });
});

// =====================================================
// GET BALANCE
// =====================================================

app.get("/balance", (req, res) => {

    const email = String(req.query.email || "")
        .trim()
        .toLowerCase();

    if (!email) {
        return res.json({
            success: false,
            message: "Email is required."
        });
    }

    if (userBalances[email] === undefined) {
        userBalances[email] = 0;
    }

    res.json({
        success: true,
        balance: userBalances[email],
        vipLevel: userVIP[email] || 0
    });
});

// =====================================================
// INITIALIZE PAYSTACK PAYMENT
// =====================================================

app.post("/initialize-payment", async (req, res) => {

    try {

        const { email, amount } = req.body;

        if (!email || !amount) {
            return res.json({
                success: false,
                message: "Email and amount are required."
            });
        }

        const numericAmount = Number(amount);

        if (
            !Number.isFinite(numericAmount) ||
            numericAmount <= 0
        ) {
            return res.json({
                success: false,
                message: "Invalid deposit amount."
            });
        }

        if (!PAYSTACK_SECRET_KEY) {
            return res.json({
                success: false,
                message: "Paystack secret key is not configured."
            });
        }

        const response = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
                method: "POST",

                headers: {
                    Authorization:
                        "Bearer " + PAYSTACK_SECRET_KEY,

                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    email: email,
                    amount: Math.round(
                        numericAmount * 100
                    ),

                    callback_url:
                        SITE_URL + "/payment-success"
                })
            }
        );

        const data = await response.json();

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

        const response = await fetch(
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

        const data = await response.json();

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

        // Prevent the same payment from being
        // credited more than once.
        if (verifiedPayments[reference]) {
            return res.json({
                success: true,
                message:
                    "Payment was already verified.",
                balance:
                    userBalances[email] || 0
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

        if (userBalances[email] === undefined) {
            userBalances[email] = 0;
        }

        userBalances[email] += amount;

        verifiedPayments[reference] = {
            email: email,
            amount: amount,
            verifiedAt: new Date().toISOString()
        };

        res.json({
            success: true,
            message:
                "Payment verified successfully.",
            amount: amount,
            balance:
                userBalances[email]
        });

    } catch (error) {

        console.error(
            "Verify payment error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Could not verify payment."
        });
    }
});

// =====================================================
// PAYMENT SUCCESS PAGE
// =====================================================

app.get("/payment-success", (req, res) => {

    const reference =
        String(
            req.query.reference || ""
        ).trim();

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

app.post("/upgrade-vip", (req, res) => {

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

    if (userBalances[email] === undefined) {
        userBalances[email] = 0;
    }

    const balance =
        Number(userBalances[email]);

    const price =
        Number(vip.price);

    // ================================================
    // INSUFFICIENT FUNDS CHECK
    // ================================================

    if (balance < price) {

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

    // ================================================
    // DEDUCT MONEY
    // ================================================

    userBalances[email] =
        balance - price;

    // ================================================
    // ACTIVATE VIP
    // ================================================

    userVIP[email] =
        level;

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
            userBalances[email],

        vipLevel:
            level,

        dailyReward:
            vip.dailyReward
    });
});

// =====================================================
// CLAIM VIP DAILY REWARD
// =====================================================

app.post("/claim-vip", (req, res) => {

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

    const level =
        Number(userVIP[email] || 0);

    if (!level) {
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
        Number(lastVIPClaim[email] || 0);

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

        return res.json({
            success: false,

            message:
                "You have already claimed your VIP reward. " +
                "Please wait about " +
                hours +
                " hour(s).",

            balance:
                userBalances[email] || 0
        });
    }

    if (userBalances[email] === undefined) {
        userBalances[email] = 0;
    }

    userBalances[email] +=
        vip.dailyReward;

    lastVIPClaim[email] =
        now;

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
            userBalances[email],

        vipLevel:
            level
    });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, () => {

    console.log(
        "Zavero backend running on port " +
        PORT
    );

});
