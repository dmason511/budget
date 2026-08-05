const crypto = require("node:crypto");

const DEFAULT_TTL_SECONDS = 60 * 60 * 12;
const SECRET =
  process.env.AUTH_TOKEN_SECRET ||
  "replace-this-default-auth-token-secret-in-production";

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replaceAll("-", "+")
    .replaceAll("_", "/");

  const paddingLength = normalized.length % 4;
  const padded =
    paddingLength === 0
      ? normalized
      : normalized + "=".repeat(4 - paddingLength);

  return Buffer.from(padded, "base64").toString("utf8");
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function createAuthToken(claims, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + Number(ttlSeconds || 0);
  const payloadJson = JSON.stringify({
    ...claims,
    exp: expiresAt,
  });

  const encodedPayload = base64UrlEncode(payloadJson);
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || !String(token).includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = String(token).split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.exp) || payload.exp <= now) {
      return null;
    }

    return payload;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  createAuthToken,
  verifyAuthToken,
};
