const path = require("node:path");
const fs = require("node:fs");
const sqlite3 = require("sqlite3");

const { hashPassword, verifyPassword } = require("../auth/password");

const authDbPath = path.resolve(process.cwd(), "data", "auth.sqlite");
const ALLOWED_ROLES = new Set(["admin", "user"]);

let authDb;

function ensureDirectory() {
  fs.mkdirSync(path.dirname(authDbPath), { recursive: true });
}

function openAuthDatabase() {
  if (authDb) {
    return authDb;
  }

  ensureDirectory();
  authDb = new sqlite3.Database(authDbPath);
  return authDb;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    openAuthDatabase().run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    openAuthDatabase().get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    openAuthDatabase().all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows || []);
    });
  });
}

async function hasColumn(tableName, columnName) {
  const rows = await all(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
}

function normalizeRole(role) {
  const normalized = String(role || "user")
    .trim()
    .toLowerCase();
  if (!ALLOWED_ROLES.has(normalized)) {
    throw new Error("Role must be admin or user");
  }

  return normalized;
}

function normalizeIsActive(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === 1 || value === "1" || value === "true") {
    return true;
  }

  if (value === 0 || value === "0" || value === "false") {
    return false;
  }

  return true;
}

async function initializeAuthStore() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  const defaultUser = await get(
    "SELECT id FROM users WHERE lower(username) = lower(?)",
    ["admin"],
  );

  if (!defaultUser) {
    const defaultPassword = process.env.ADMIN_PASSWORD || "admin123";
    await run(
      "INSERT INTO users (id, username, password_hash, tenant_id, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)",
      [
        "admin",
        hashPassword(defaultPassword),
        "default",
        new Date().toISOString(),
      ],
    );
  }

  const hasRole = await hasColumn("users", "role");
  if (!hasRole) {
    await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  const hasIsActive = await hasColumn("users", "is_active");
  if (!hasIsActive) {
    await run(
      "ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
    );
  }

  const hasUpdatedAt = await hasColumn("users", "updated_at");
  if (!hasUpdatedAt) {
    await run("ALTER TABLE users ADD COLUMN updated_at TEXT");
  }

  await run(
    "UPDATE users SET role = 'admin', is_active = 1 WHERE lower(username) = lower(?)",
    ["admin"],
  );
}

async function authenticateUser(username, password) {
  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername || !password) {
    return null;
  }

  const user = await get(
    "SELECT id, username, password_hash, tenant_id, role, is_active FROM users WHERE lower(username) = lower(?)",
    [normalizedUsername],
  );

  if (!user) {
    return null;
  }

  if (!verifyPassword(password, user.password_hash)) {
    return null;
  }

  if (!normalizeIsActive(user.is_active)) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    tenantId: user.tenant_id,
    role: normalizeRole(user.role || "user"),
    isActive: normalizeIsActive(user.is_active),
  };
}

async function getUserById(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return null;
  }

  const user = await get(
    "SELECT id, username, tenant_id, role, is_active, created_at, updated_at FROM users WHERE id = ?",
    [normalizedUserId],
  );

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    tenantId: user.tenant_id,
    role: normalizeRole(user.role || "user"),
    isActive: normalizeIsActive(user.is_active),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function normalizeTenantId(tenantId) {
  const normalized = String(tenantId || "default")
    .trim()
    .toLowerCase();
  if (!normalized || !/^[a-z0-9_-]+$/.test(normalized)) {
    return "default";
  }

  return normalized;
}

async function listUsers() {
  const rows = await all(
    "SELECT id, username, tenant_id, role, is_active, created_at, updated_at FROM users ORDER BY username COLLATE NOCASE ASC",
  );

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    tenantId: row.tenant_id,
    role: normalizeRole(row.role || "user"),
    isActive: normalizeIsActive(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function listTenants() {
  const rows = await new Promise((resolve, reject) => {
    openAuthDatabase().all(
      "SELECT DISTINCT tenant_id AS tenantId FROM users ORDER BY tenant_id COLLATE NOCASE ASC",
      [],
      (err, resultRows) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(resultRows || []);
      },
    );
  });

  const tenantIds = new Set(rows.map((row) => row.tenantId));
  tenantIds.add("default");
  return [...tenantIds].sort((a, b) => a.localeCompare(b));
}

async function createUser({ username, password, tenantId, role = "user" }) {
  const normalizedUsername = String(username || "").trim();
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedPassword = String(password || "");
  const normalizedRole = normalizeRole(role);

  if (!normalizedUsername) {
    throw new Error("Username is required");
  }

  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const existing = await get(
    "SELECT id FROM users WHERE lower(username) = lower(?)",
    [normalizedUsername],
  );

  if (existing) {
    throw new Error("Username already exists");
  }

  await run(
    "INSERT INTO users (id, username, password_hash, tenant_id, role, is_active, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, 1, ?, ?)",
    [
      normalizedUsername,
      hashPassword(normalizedPassword),
      normalizedTenantId,
      normalizedRole,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  const created = await get(
    "SELECT id FROM users WHERE lower(username) = lower(?)",
    [normalizedUsername],
  );

  return getUserById(created.id);
}

async function updateUserAccess({ userId, role, tenantId, isActive }) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const nextRole = role === undefined ? user.role : normalizeRole(role);
  const nextTenantId =
    tenantId === undefined ? user.tenantId : normalizeTenantId(tenantId);
  const nextIsActive =
    isActive === undefined ? user.isActive : normalizeIsActive(isActive);

  await run(
    "UPDATE users SET role = ?, tenant_id = ?, is_active = ?, updated_at = ? WHERE id = ?",
    [
      nextRole,
      nextTenantId,
      nextIsActive ? 1 : 0,
      new Date().toISOString(),
      user.id,
    ],
  );

  return getUserById(user.id);
}

async function adminResetUserPassword({ userId, newPassword }) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const normalizedPassword = String(newPassword || "");
  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  await run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    hashPassword(normalizedPassword),
    new Date().toISOString(),
    user.id,
  ]);

  return { ok: true };
}

async function changeOwnPassword({ userId, currentPassword, newPassword }) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("User not found");
  }

  const user = await get("SELECT id, password_hash FROM users WHERE id = ?", [
    normalizedUserId,
  ]);

  if (!user) {
    throw new Error("User not found");
  }

  if (!verifyPassword(String(currentPassword || ""), user.password_hash)) {
    throw new Error("Current password is incorrect");
  }

  const normalizedNewPassword = String(newPassword || "");
  if (normalizedNewPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  await run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    hashPassword(normalizedNewPassword),
    new Date().toISOString(),
    normalizedUserId,
  ]);

  return { ok: true };
}

module.exports = {
  adminResetUserPassword,
  authenticateUser,
  changeOwnPassword,
  createUser,
  getUserById,
  initializeAuthStore,
  listTenants,
  listUsers,
  normalizeTenantId,
  updateUserAccess,
};
