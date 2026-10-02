const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
    return res.render("index.njk", {
        currentPage: "index"
    });
});

module.exports = router;
