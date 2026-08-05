const express = require("express");

const { createAuthToken } = require("../auth/token");
const { authenticateUser, changeOwnPassword } = require("../db/auth-store");
const {
  FOURTEEN_DAYS_SECONDS,
  clearAuthCookie,
  getAuthClaims,
  setAuthCookie,
} = require("../middleware/auth");
const { initializeTenantDatabase } = require("../db/database");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const rememberMe = req.body?.rememberMe === true;

    const user = await authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    await initializeTenantDatabase(user.tenantId);

    const token = createAuthToken(
      {
        sub: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      },
      rememberMe ? FOURTEEN_DAYS_SECONDS : undefined,
    );

    setAuthCookie(res, token, {
      maxAgeSeconds: rememberMe ? FOURTEEN_DAYS_SECONDS : 0,
    });

    return res.status(200).json({
      data: {
        id: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ ok: true });
});

router.get("/me", (req, res) => {
  const claims = getAuthClaims(req);
  if (!claims) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.status(200).json({
    data: {
      id: claims.sub,
      username: claims.username,
      tenantId: claims.tenantId,
      role: claims.role || "user",
      expiresAt: claims.exp,
    },
  });
});

router.post("/change-password", async (req, res, next) => {
  try {
    const claims = getAuthClaims(req);
    if (!claims?.sub) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    await changeOwnPassword({
      userId: claims.sub,
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (
      error &&
      /incorrect|least 8|required|not found/i.test(String(error.message))
    ) {
      return res.status(400).json({ error: error.message });
    }

    return next(error);
  }
});

module.exports = router;
