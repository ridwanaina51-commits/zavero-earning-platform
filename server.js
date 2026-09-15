const express = require("express");

const app = express();

app.use(express.json());

/* Allow the website to connect to this server */
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

/* Start server */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Zavero backend running on port ${PORT}`);
});
