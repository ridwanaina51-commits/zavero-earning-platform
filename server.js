const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Zavero backend is working!");
});

app.post("/deposit", async (req, res) => {

    const { name, amount, email } = req.body;

    if (!name || !amount || !email) {
        return res.status(400).json({
            success: false,
            message: "Name, email and amount are required."
        });
    }

    try {

        const response = await fetch(
            "https://api.paystack.co/transaction/initialize",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: email,
                    amount: Number(amount) * 100,
                    currency: "NGN"
                })
            }
        );

        const data = await response.json();

        if (!data.status) {
            return res.status(400).json({
                success: false,
                message: data.message || "Paystack initialization failed."
            });
        }

        res.json({
            success: true,
            message: "Paystack payment initialized.",
            authorization_url: data.data.authorization_url,
            reference: data.data.reference
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: "Could not connect to Paystack."
        });

    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Zavero backend running on port ${PORT}`);
});
