const path = require("node:path");
const fs = require("node:fs");
const { AsyncLocalStorage } = require("node:async_hooks");
const sqlite3 = require("sqlite3");

const defaultDbPath = path.resolve(process.cwd(), "data", "budget.sqlite");
const dbFile = process.env.DB_FILE || defaultDbPath;
const tenantDataDirectory = path.resolve(process.cwd(), "data", "tenants");
const tenantContext = new AsyncLocalStorage();

const migrations = [
  {
    id: "001_create_transactions_table",
    sql: `
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        category TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `,
  },
  {
    id: "002_create_transactions_date_index",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_transactions_date
      ON transactions (date DESC)
    `,
  },
  {
    id: "003_create_categories_table",
    sql: `
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `,
  },
  {
    id: "004_seed_categories",
    sql: `
      INSERT OR IGNORE INTO categories (id, name, created_at)
      VALUES (lower(hex(randomblob(16))), 'uncategorized', datetime('now'))
    `,
  },
  {
    id: "005_import_transaction_categories",
    sql: `
      INSERT OR IGNORE INTO categories (id, name, created_at)
      SELECT lower(hex(randomblob(16))), category, datetime('now')
      FROM transactions
      WHERE category IS NOT NULL AND trim(category) != ''
    `,
  },
  {
    id: "006_add_category_default_amount",
    sql: `
      ALTER TABLE categories
      ADD COLUMN default_amount REAL
    `,
  },
  {
    id: "007_add_category_default_due_date",
    sql: `
      ALTER TABLE categories
      ADD COLUMN default_due_date TEXT
    `,
  },
  {
    id: "008_add_category_default_due_day",
    sql: `
      ALTER TABLE categories
      ADD COLUMN default_due_day INTEGER
    `,
  },
  {
    id: "009_backfill_category_default_due_day",
    sql: `
      UPDATE categories
      SET default_due_day = CAST(substr(default_due_date, 9, 2) AS INTEGER)
      WHERE default_due_day IS NULL
        AND default_due_date IS NOT NULL
        AND default_due_date != ''
    `,
  },
  {
    id: "010_add_category_notes",
    sql: `
      ALTER TABLE categories
      ADD COLUMN notes TEXT
    `,
  },
  {
    id: "011_add_category_type",
    sql: `
      ALTER TABLE categories
      ADD COLUMN category_type TEXT NOT NULL DEFAULT 'expense'
    `,
  },
  {
    id: "012_add_category_budget_amount",
    sql: `
      ALTER TABLE categories
      ADD COLUMN budget_amount REAL
    `,
  },
  {
    id: "013_backfill_category_budget_amount",
    sql: `
      UPDATE categories
      SET budget_amount = default_amount
      WHERE budget_amount IS NULL
    `,
  },
];

const dbByPath = new Map();
const LEGACY_DATE_NORMALIZATION_MIGRATION_ID =
  "014_normalize_legacy_transaction_dates_to_zulu";

function normalizeTenantId(tenantId) {
  const normalized = String(tenantId || "default").trim().toLowerCase();
  if (!normalized || !/^[a-z0-9_-]+$/.test(normalized)) {
    return "default";
  }

  return normalized;
}

function getDbPathForTenant(tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (normalizedTenantId === "default") {
    return dbFile;
  }

  return path.join(tenantDataDirectory, `${normalizedTenantId}.sqlite`);
}

function getCurrentTenantId() {
  const store = tenantContext.getStore();
  return normalizeTenantId(store?.tenantId || "default");
}

function ensureDbDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function openDatabase(filePath) {
  if (dbByPath.has(filePath)) {
    return dbByPath.get(filePath);
  }

  ensureDbDirectory(filePath);

  const opened = new sqlite3.Database(filePath);
  dbByPath.set(filePath, opened);
  return opened;
}

function runWithDb(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function getWithDb(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row || null);
    });
  });
}

function allWithDb(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

function run(sql, params = []) {
  const database = openDatabase(getDbPathForTenant(getCurrentTenantId()));
  return runWithDb(database, sql, params);
}

function get(sql, params = []) {
  const database = openDatabase(getDbPathForTenant(getCurrentTenantId()));
  return getWithDb(database, sql, params);
}

function all(sql, params = []) {
  const database = openDatabase(getDbPathForTenant(getCurrentTenantId()));
  return allWithDb(database, sql, params);
}

async function normalizeLegacyTransactionDatesToZulu() {
  const rows = await all(
    "SELECT id, date FROM transactions WHERE date GLOB '????-??-??'",
  );

  if (!rows.length) {
    return 0;
  }

  let normalizedCount = 0;

  for (const row of rows) {
    const localMidnight = new Date(`${row.date}T00:00:00`);
    if (Number.isNaN(localMidnight.getTime())) {
      continue;
    }

    await run("UPDATE transactions SET date = ? WHERE id = ?", [
      localMidnight.toISOString(),
      row.id,
    ]);
    normalizedCount += 1;
  }

  return normalizedCount;
}

async function initializeDatabaseForDb(database, tenantId) {
  await tenantContext.run({ tenantId }, async () => {
    await runWithDb(
      database,
      `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
      `,
    );

    for (const migration of migrations) {
      const applied = await getWithDb(
        database,
        "SELECT id FROM schema_migrations WHERE id = ?",
        [migration.id],
      );

      if (applied) {
        continue;
      }

      await runWithDb(database, "BEGIN");

      try {
        await runWithDb(database, migration.sql);
        await runWithDb(
          database,
          "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
          [migration.id, new Date().toISOString()],
        );
        await runWithDb(database, "COMMIT");
      } catch (error) {
        await runWithDb(database, "ROLLBACK");
        throw error;
      }
    }

    const normalizedApplied = await getWithDb(
      database,
      "SELECT id FROM schema_migrations WHERE id = ?",
      [LEGACY_DATE_NORMALIZATION_MIGRATION_ID],
    );

    if (!normalizedApplied) {
      await runWithDb(database, "BEGIN");

      try {
        await normalizeLegacyTransactionDatesToZulu();
        await runWithDb(
          database,
          "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
          [LEGACY_DATE_NORMALIZATION_MIGRATION_ID, new Date().toISOString()],
        );
        await runWithDb(database, "COMMIT");
      } catch (error) {
        await runWithDb(database, "ROLLBACK");
        throw error;
      }
    }
  });
}

async function initializeTenantDatabase(tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const dbPath = getDbPathForTenant(normalizedTenantId);
  const database = openDatabase(dbPath);
  await initializeDatabaseForDb(database, normalizedTenantId);
}

function withTenantContext(tenantId, fn) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  return tenantContext.run({ tenantId: normalizedTenantId }, fn);
}

async function initializeDatabase() {
  await initializeTenantDatabase("default");
}

module.exports = {
  all,
  get,
  initializeDatabase,
  initializeTenantDatabase,
  run,
  withTenantContext,
};
