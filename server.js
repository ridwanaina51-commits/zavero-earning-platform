const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Zavero backend is working!");
});

app.post("/deposit", (req, res) => {

    const { name, amount } = req.body;

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
        amount: amount
    });

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Zavero backend running on port ${PORT}`);
});
