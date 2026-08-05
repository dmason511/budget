const { verifyAuthToken } = require("../auth/token");
const { getUserById } = require("../db/auth-store");

const AUTH_COOKIE_NAME = "budget_auth";
const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) {
    return cookies;
  }

  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    cookies[rawName] = decodeURIComponent(rawValue.join("=") || "");
  }

  return cookies;
}

function getAuthClaims(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[AUTH_COOKIE_NAME];
  return verifyAuthToken(token);
}

function setAuthCookie(res, token, options = {}) {
  const isSecure = process.env.NODE_ENV === "production";
  const secureAttr = isSecure ? "; Secure" : "";
  const maxAgeSeconds = Number(options.maxAgeSeconds || 0);
  const maxAgeAttr =
    Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0
      ? `; Max-Age=${Math.floor(maxAgeSeconds)}`
      : "";

  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secureAttr}${maxAgeAttr}`,
  );
}

function clearAuthCookie(res) {
  const isSecure = process.env.NODE_ENV === "production";
  const secureAttr = isSecure ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=0`,
  );
}

function requireApiAuth(req, res, next) {
  if (req.path === "/health" || req.path.startsWith("/auth")) {
    next();
    return;
  }

  const claims = getAuthClaims(req);
  if (!claims) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  getUserById(claims.sub)
    .then((user) => {
      if (!user?.isActive) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      req.user = {
        id: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      };

      next();
    })
    .catch(next);
}

function requirePageAuth(req, res, next) {
  const claims = getAuthClaims(req);
  if (!claims) {
    const encodedNext = encodeURIComponent(req.originalUrl || "/menu");
    res.redirect(`/login?next=${encodedNext}`);
    return;
  }

  getUserById(claims.sub)
    .then((user) => {
      if (!user?.isActive) {
        const encodedNext = encodeURIComponent(req.originalUrl || "/menu");
        res.redirect(`/login?next=${encodedNext}`);
        return;
      }

      req.user = {
        id: user.id,
        username: user.username,
        tenantId: user.tenantId,
        role: user.role,
      };

      next();
    })
    .catch(next);
}

function requireAdminApi(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  next();
}

function requireAdminPage(req, res, next) {
  if (req.user?.role !== "admin") {
    res.redirect("/menu");
    return;
  }

  next();
}

module.exports = {
  AUTH_COOKIE_NAME,
  FOURTEEN_DAYS_SECONDS,
  clearAuthCookie,
  getAuthClaims,
  requireAdminApi,
  requireAdminPage,
  requireApiAuth,
  requirePageAuth,
  setAuthCookie,
};
