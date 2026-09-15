const express = require("express");

const app = express();

app.use(express.json());

/* Allow the website to connect */
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

/* Deposit request */
app.post("/deposit", (req, res) => {

    const { name, email, amount } = req.body;

    if (!name || !amount) {
        return res.status(400).json({
            success: false,
            message: "Name and amount are required."
        });
    }

    res.json({
        success: true,
        message: "Deposit request received.",
        name: name,
        email: email || "",
        amount: amount
    });

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

        return res.json({
            success: true,
            message: "Payment verified successfully.",
            reference: transaction.reference,
            amount: transaction.amount / 100,
            currency: transaction.currency
        });

    } catch (error) {

        console.error("Verify payment error:", error);

        return res.status(500).json({
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
