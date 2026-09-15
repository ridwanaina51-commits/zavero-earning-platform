const express = require("express");

const app = express();

app.use(express.json());

/* Allow website to connect */
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

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

/* Paystack: Start payment */
app.post("/initialize-payment", async (req, res) => {
    const { name, email, amount } = req.body;

    if (!name || !email || !amount) {
        return res.status(400).json({
            success: false,
            message: "Name, email and amount are required."
        });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

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
                    "Authorization": "Bearer " + secretKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
    email: email,
    amount: Math.round(Number(amount) * 100),
    currency: "NGN",
    callback_url: "https://zavero-earning-platform.onrender.com/payment-success"
})
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Could not start payment."
            });
        }

        res.json({
            success: true,
            authorization_url: data.data.authorization_url,
            reference: data.data.reference
        });

    } catch (error) {
        console.error("Payment initialization error:", error);

        res.status(500).json({
            success: false,
            message: "Could not connect to Paystack."
        });
    }
});

/* Verify Paystack payment */
app.post("/verify-payment", async (req, res) => {
    const { reference, amount } = req.body;

    if (!reference) {
        return res.status(400).json({
            success: false,
            message: "Payment reference is required."
        });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
        return res.status(500).json({
            success: false,
            message: "Paystack secret key is not configured."
        });
    }

    try {
        const response = await fetch(
            "https://api.paystack.co/transaction/verify/" +
            encodeURIComponent(reference),
            {
                method: "GET",
                headers: {
                    "Authorization": "Bearer " + secretKey
                }
            }
        );

        const data = await response.json();

        if (!response.ok || !data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Payment verification failed."
            });
        }

        const transaction = data.data;

        if (transaction.status !== "success") {
            return res.json({
                success: false,
                message: "Payment is not successful yet."
            });
        }

        if (transaction.currency !== "NGN") {
            return res.json({
                success: false,
                message: "Wrong payment currency."
            });
        }

        if (
            amount &&
            Number(transaction.amount) !== Number(amount) * 100
        ) {
            return res.json({
                success: false,
                message: "Payment amount does not match."
            });
        }

        res.json({
            success: true,
            message: "Payment verified successfully.",
            reference: transaction.reference,
            amount: transaction.amount / 100,
            currency: transaction.currency
        });

    } catch (error) {
        console.error("Verify payment error:", error);

        res.status(500).json({
            success: false,
            message: "Could not verify payment."
        });
    }
});

/* Start server */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Zavero backend running on port ${PORT}`);
});
