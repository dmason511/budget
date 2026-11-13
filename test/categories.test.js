const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "budget-categories-test-"));
process.env.DB_FILE = path.join(directory, "budget.sqlite");

const { all, get, initializeDatabase, run } = require("../src/db/database");
const categoriesRouter = require("../src/routes/categories");

test("monthly report category selection", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/categories", categoriesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.unlinkSync(process.env.DB_FILE);
    fs.rmdirSync(directory);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/categories`;
  async function request(method, suffix = "", body) {
    const response = await fetch(`${baseUrl}${suffix}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  await t.test("migration defaults legacy categories and is repeatable", async () => {
    await initializeDatabase();
    await run("ALTER TABLE categories DROP COLUMN include_in_monthly_report");
    await run("DELETE FROM schema_migrations WHERE id = ?", [
      "016_add_category_include_in_monthly_report",
    ]);
    await run("INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)", [
      "legacy",
      "Legacy expense",
      new Date().toISOString(),
    ]);

    await initializeDatabase();
    await initializeDatabase();
    const rows = await all("SELECT include_in_monthly_report FROM categories");
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((row) => row.include_in_monthly_report === 1));
    const listed = await request("GET");
    assert.equal(listed.status, 200);
    assert.ok(listed.body.data.every((row) => row.includeInMonthlyReport === true));
  });

  await t.test("creation, toggling, reload, and omitted updates preserve selection", async () => {
    const created = await request("POST", "", { name: "Utilities" });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.includeInMonthlyReport, true);
    const id = created.body.data.id;

    const unchecked = await request("PUT", `/${id}`, {
      includeInMonthlyReport: false,
    });
    assert.equal(unchecked.status, 200);
    assert.equal(unchecked.body.data.includeInMonthlyReport, false);
    assert.equal(
      (await get("SELECT include_in_monthly_report FROM categories WHERE id = ?", [id]))
        .include_in_monthly_report,
      0,
    );

    await initializeDatabase();
    const renamed = await request("PUT", `/${id}`, {
      name: "Household utilities",
      notes: "Keep excluded",
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.includeInMonthlyReport, false);
    const listed = await request("GET");
    assert.equal(
      listed.body.data.find((row) => row.id === id).includeInMonthlyReport,
      false,
    );

    const checked = await request("PUT", `/${id}`, {
      includeInMonthlyReport: true,
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.data.includeInMonthlyReport, true);
    const excluded = await request("POST", "", {
      name: "Excluded expense",
      includeInMonthlyReport: false,
    });
    assert.equal(excluded.status, 201);
    assert.equal(excluded.body.data.includeInMonthlyReport, false);
    const deleted = await request("DELETE", `/${excluded.body.data.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.includeInMonthlyReport, false);
  });

  await t.test("rejects non-booleans without modifying categories or transactions", async () => {
    await run(
      "INSERT INTO transactions (id, description, amount, category, date, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["legacy-use", "Expense", 10, "Legacy expense", new Date().toISOString(), new Date().toISOString()],
    );
    for (const value of [null, 0, 1, "false", "true", [], {}]) {
      const created = await request("POST", "", {
        name: "Invalid selection",
        includeInMonthlyReport: value,
      });
      assert.equal(created.status, 400);
      assert.equal(created.body.error, "includeInMonthlyReport must be a boolean");
      const updated = await request("PUT", "/legacy", {
        name: "Renamed legacy",
        renameTransactions: true,
        includeInMonthlyReport: value,
      });
      assert.equal(updated.status, 400);
      assert.equal(updated.body.error, "includeInMonthlyReport must be a boolean");
    }
    assert.equal(
      (await get("SELECT category FROM transactions WHERE id = ?", ["legacy-use"])).category,
      "Legacy expense",
    );
    const category = await get("SELECT name, include_in_monthly_report FROM categories WHERE id = ?", ["legacy"]);
    assert.equal(category.name, "Legacy expense");
    assert.equal(category.include_in_monthly_report, 1);
    assert.equal(await get("SELECT id FROM categories WHERE name = ?", ["Invalid selection"]), null);
  });
});
