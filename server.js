const express = require("express");

const app = express();

app.use(express.json());

/* Allow Zavero website to connect */
app.use((req, res, next) => {
res.header("Access-Control-Allow-Origin", "*");
res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
res.header("Access-Control-Allow-Headers", "Content-Type");
next();
});

/* Temporary server-side balances */
const userBalances = {};
const verifiedPayments = new Set();
const userVIP = {};
/* VIP daily claim tracking */
const lastVIPClaim = {};
/* VIP plans */
const vipPlans = {
1: { price: 1500, dailyReward: 200 },
2: { price: 5000, dailyReward: 800 },
3: { price: 10000, dailyReward: 1750 },
4: { price: 25000, dailyReward: 4100 },
5: { price: 50000, dailyReward: 7500 },
6: { price: 100000, dailyReward: 15000 }
};

/* Home */
app.get("/", (req, res) => {
res.send("Zavero backend is working!");
});

/* Connection test */
app.get("/test", (req, res) => {
res.json({
success: true,
message: "Zavero connection test is working!"
});
});

/* Get user balance */
app.get("/balance", (req, res) => {
const email = req.query.email;

if (!email) {
    return res.status(400).json({
        success: false,
        message: "Email is required."
    });
}

res.json({
    success: true,
    balance: userBalances[email] || 0
});

});

/* Payment success page */
app.get("/payment-success", (req, res) => {
res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Zavero Payment</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>

    <body style="font-family: Arial; text-align: center; padding: 40px;">
        <h2>Checking payment...</h2>
        <p id="message">Please wait.</p>

        <script>
            const params =
                new URLSearchParams(window.location.search);

            const reference =
                params.get("reference");

            if (!reference) {
                document.getElementById("message").innerText =
                    "Payment reference was not found.";
            } else {

                fetch("/verify-payment", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        reference: reference
                    })
                })
                .then(response => response.json())
                .then(data => {

                    if (data.success) {
                        document.getElementById("message").innerText =
                            data.message +
                            " Your balance is ₦" +
                            Number(data.balance || 0).toLocaleString();
                    } else {
                        document.getElementById("message").innerText =
                            data.message ||
                            "Payment could not be verified.";
                    }

                })
                .catch(error => {

                    console.error(
                        "Payment verification error:",
                        error
                    );

                    document.getElementById("message").innerText =
                        "Could not verify payment.";
                });
            }
        </script>
    </body>
    </html>
`);

});

/* Start Paystack payment */
app.post("/initialize-payment", async (req, res) => {

const { name, email, amount } = req.body;

if (!name || !email || !amount) {
    return res.status(400).json({
        success: false,
        message: "Name, email and amount are required."
    });
}

const numericAmount = Number(amount);

if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({
        success: false,
        message: "Please enter a valid amount."
    });
}

const secretKey =
    process.env.PAYSTACK_SECRET_KEY;

if (!secretKey) {
    return res.status(500).json({
        success: false,
        message: "Paystack secret key is not configured."
    });
}

try {

    const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
            method: "POST",

            headers: {
                "Authorization":
                    "Bearer " + secretKey,
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({
                email: email,
                amount:
                    Math.round(numericAmount * 100),
                currency: "NGN",

                callback_url:
                    "https://zavero-earning-platform.onrender.com/payment-success"
            })
        }
    );

    const data =
        await response.json();

    if (!response.ok || !data.status) {

        return res.status(400).json({
            success: false,
            message:
                data.message ||
                "Could not start payment."
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
        "Payment initialization error:",
        error
    );

    res.status(500).json({
        success: false,
        message:
            "Could not connect to Paystack."
    });
}

});

/* Verify Paystack payment */
app.post("/verify-payment", async (req, res) => {

const { reference } = req.body;

if (!reference) {
    return res.status(400).json({
        success: false,
        message:
            "Payment reference is required."
    });
}

const secretKey =
    process.env.PAYSTACK_SECRET_KEY;

if (!secretKey) {
    return res.status(500).json({
        success: false,
        message:
            "Paystack secret key is not configured."
    });
}

try {

    const response = await fetch(
        "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
        {
            method: "GET",

            headers: {
                "Authorization":
                    "Bearer " + secretKey
            }
        }
    );

    const data =
        await response.json();

    if (!response.ok || !data.status) {

        return res.status(400).json({
            success: false,
            message:
                data.message ||
                "Payment verification failed."
        });
    }

    const transaction =
        data.data;

    if (transaction.status !== "success") {

        return res.json({
            success: false,
            message:
                "Payment is not successful yet."
        });
    }

    if (transaction.currency !== "NGN") {

        return res.json({
            success: false,
            message:
                "Wrong payment currency."
        });
    }

    const email =
        transaction.customer.email;

    const amount =
        transaction.amount / 100;

    /* Prevent duplicate credit */
    if (verifiedPayments.has(reference)) {

        return res.json({
            success: true,
            message:
                "Payment was already credited.",

            reference:
                reference,

            amount:
                amount,

            currency:
                "NGN",

            balance:
                userBalances[email] || 0
        });
    }

    /* Add verified payment to balance */
    userBalances[email] =
        (userBalances[email] || 0) + amount;

    verifiedPayments.add(reference);

    res.json({
        success: true,

        message:
            "Payment verified and balance credited.",

        reference:
            reference,

        amount:
            amount,

        currency:
            "NGN",

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

/* Upgrade VIP */
app.post("/upgrade-vip", (req, res) => {

const { email, level } = req.body;

if (!email || !level) {
    return res.status(400).json({
        success: false,
        message:
            "Email and VIP level are required."
    });
}

const vipLevel =
    Number(level);

const plan =
    vipPlans[vipLevel];

if (!plan) {
    return res.status(400).json({
        success: false,
        message:
            "Invalid VIP level."
    });
}

const currentBalance =
    userBalances[email] || 0;

/* Check balance */
if (currentBalance < plan.price) {

    return res.json({
        success: false,

        message:
            "Insufficient balance. You need ₦" +
            plan.price.toLocaleString() +
            " to upgrade to VIP " +
            vipLevel +
            ".",

        balance:
            currentBalance
    });
}

/* Deduct VIP price */
userBalances[email] =
    currentBalance - plan.price;

/* Save VIP membership */
userVIP[email] = {
    level:
        vipLevel,

    price:
        plan.price,

    dailyReward:
        plan.dailyReward,

    upgradedAt:
        new Date().toISOString()
};

res.json({

    success:
        true,

    message:
        "Successful! You are now a VIP " +
        vipLevel +
        " member.",

    vipLevel:
        vipLevel,

    dailyReward:
        plan.dailyReward,

    balance:
        userBalances[email]
});

});
/* VIP Daily Claim */
app.post("/claim-vip", (req, res) => {

    const { email } = req.body;

    if (!email) {
        return res.status(400).json({
            success: false,
            message: "Email is required."
        });
    }

    const membership = userVIP[email];

    if (!membership) {
        return res.json({
            success: false,
            message: "You are not a VIP member yet."
        });
    }

    const now = Date.now();
    const lastClaim = lastVIPClaim[email] || 0;

    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (now - lastClaim < twentyFourHours) {

        const remaining =
            twentyFourHours - (now - lastClaim);

        const hours =
            Math.floor(remaining / (60 * 60 * 1000));

        const minutes =
            Math.floor(
                (remaining % (60 * 60 * 1000)) /
                (60 * 1000)
            );

        return res.json({
            success: false,
            message:
                "You have already claimed your VIP reward. Try again in " +
                hours +
                " hours " +
                minutes +
                " minutes."
        });
    }

    const reward =
        membership.dailyReward;

    userBalances[email] =
        (userBalances[email] || 0) + reward;

    lastVIPClaim[email] = now;

    res.json({
        success: true,
        message:
            "VIP daily reward claimed successfully! You received ₦" +
            reward.toLocaleString() +
            ".",
        reward: reward,
        balance: userBalances[email]
    });
});
/* Start server */
const PORT =
process.env.PORT || 3000;

app.listen(PORT, () => {
console.log(
"Zavero backend running on port " +
PORT
);
});
