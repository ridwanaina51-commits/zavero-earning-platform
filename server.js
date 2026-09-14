const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.send("Zavero backend is working!");
});

app.listen(3000, () => {
    console.log("Zavero backend is running");
});
