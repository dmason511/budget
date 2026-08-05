const express = require("express");
const adminAuthRouter = require("./admin-auth");
const categoriesRouter = require("./categories");
const reportsRouter = require("./reports");
const transactionsRouter = require("./transactions");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

router.use("/transactions", transactionsRouter);
router.use("/categories", categoriesRouter);
router.use("/reports", reportsRouter);
router.use("/admin", adminAuthRouter);

module.exports = router;
