const crypto = require("node:crypto");

const KEY_LENGTH = 64;

function hashPassword(password) {
  const normalized = String(password || "");
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto
    .scryptSync(normalized, salt, KEY_LENGTH)
    .toString("hex");

  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) {
    return false;
  }

  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) {
    return false;
  }

  const actual = crypto
    .scryptSync(String(password || ""), salt, KEY_LENGTH)
    .toString("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  hashPassword,
  verifyPassword,
};
