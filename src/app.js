const express = require("express");
const path = require("node:path");

const indexRouter = require("./routes");
const authRouter = require("./routes/auth");
const {
  getAuthClaims,
  requireAdminPage,
  requireApiAuth,
  requirePageAuth,
} = require("./middleware/auth");
const applyTenantContext = require("./middleware/tenant-context");
const notFound = require("./middleware/not-found");
const errorHandler = require("./middleware/error-handler");

const app = express();

app.disable("x-powered-by");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (!req.path.endsWith(".html") || req.path === "/login.html") {
    return next();
  }

  const claims = getAuthClaims(req);
  if (claims) {
    req.user = {
      id: claims.sub,
      username: claims.username,
      tenantId: claims.tenantId,
    };
    return next();
  }

  const encodedNext = encodeURIComponent(req.originalUrl || "/menu");
  return res.redirect(`/login?next=${encodedNext}`);
});

app.use(express.static(path.join(__dirname, "public")));

app.set("trust proxy", true);

app.use("/api/auth", authRouter);
app.use("/api", requireApiAuth, applyTenantContext, indexRouter);

app.get("/login", (req, res) => {
  const claims = getAuthClaims(req);
  const nextPath = String(req.query.next || "/menu");
  if (claims) {
    return res.redirect(nextPath);
  }

  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/menu", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "menu.html"));
});

app.get("/admin", requirePageAuth, requireAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/categories", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "categories.html"));
});

app.get("/admin/categories", requirePageAuth, (_req, res) => {
  res.redirect("/categories");
});

app.get("/admin/users", requirePageAuth, requireAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-users.html"));
});

app.get("/reports", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports.html"));
});

app.get("/reports/trends", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports-trends.html"));
});

app.get("/reports/trends-data", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports-trends-data.html"));
});

app.get("/reports/budget-comparison", requirePageAuth, (_req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "reports-budget-comparison.html"),
  );
});

app.get("/reports/budget-comparison-data", requirePageAuth, (_req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "reports-budget-comparison-data.html"),
  );
});

app.get("/reports/current-year", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports-current-year.html"));
});

app.get("/reports/by-period", requirePageAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports-by-period.html"));
});

app.get("/", (req, res) => {
  const claims = getAuthClaims(req);
  if (!claims) {
    return res.redirect("/login");
  }

  return res.redirect("/menu");
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
