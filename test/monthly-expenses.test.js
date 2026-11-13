const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const express = require("express");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "budget-monthly-test-"));
process.env.DB_FILE = path.join(directory, "budget.sqlite");
process.env.TZ = "America/New_York";

const { initializeDatabase, run } = require("../src/db/database");
const reportsRouter = require("../src/routes/reports");
const categoriesRouter = require("../src/routes/categories");

test("monthly expense report", async (t) => {
  await initializeDatabase();
  await run("DELETE FROM categories");
  for (const [name, type, included] of [
    ["Groceries", "expense", 1],
    ["Housing", "expense", 1],
    ["No spending", "expense", 1],
    ["Excluded", "expense", 0],
    ["Salary", "income", 1],
  ]) {
    await run(
      "INSERT INTO categories (id, name, category_type, include_in_monthly_report, created_at) VALUES (?, ?, ?, ?, ?)",
      [name, name, type, included, new Date().toISOString()],
    );
  }
  let id = 0;
  for (const [category, amount, date] of [
    [" groceries ", -10.1, "2026-01-10"],
    ["GROCERIES", 0.2, "2026-01-11"],
    ["Groceries", -2.25, "2026-02-10"],
    ["Housing", -100, "2026-01-01T05:00:00.000Z"],
    ["Housing", -20, "2027-01-01T04:59:59.000Z"],
    ["Housing", -900, "2026-01-01T04:59:59.000Z"],
    ["Housing", -800, "2027-01-01T05:00:00.000Z"],
    ["Excluded", -500, "2026-01-10"],
    ["Salary", 1000, "2026-01-10"],
    ["Unknown category", -700, "2026-01-10"],
  ]) {
    await run(
      "INSERT INTO transactions (id, description, amount, category, date, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [String(++id), "Test transaction", amount, category, date, new Date().toISOString()],
    );
  }

  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportsRouter);
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

  await t.test("monthly expense page loads years, changes year, and clears stale data on failure", async () => {
    const elements = new Map();
    for (const id of ["yearSelect", "loadBtn", "status", "expensesHead", "expensesBody", "expensesFoot"]) {
      elements.set(id, {
        value: "",
        innerHTML: "",
        style: {},
        disabled: true,
        children: [],
        listeners: {},
        appendChild(child) { this.children.push(child); },
        addEventListener(event, handler) { this.listeners[event] = handler; },
      });
    }
    const requests = [];
    let failReport = false;
    const context = vm.createContext({
      document: {
        getElementById: (id) => elements.get(id),
        createElement: () => ({ value: "", textContent: "" }),
      },
      fetch: async (url) => {
        requests.push(url);
        if (url === "/api/reports/available-periods") {
          return { ok: true, json: async () => ({ data: { years: [2025] } }) };
        }
        if (failReport) {
          return { ok: false, json: async () => ({ error: "Report unavailable" }) };
        }
        return {
          ok: true,
          json: async () => ({
            period: { year: Number(new URL(url, "http://localhost").searchParams.get("year")) },
            count: 1,
            data: [{ category: "<Example & expense>", months: Array(12).fill(0), totalAmount: 0 }],
            totals: { months: Array(12).fill(0), totalAmount: 0 },
          }),
        };
      },
    });
    const html = fs.readFileSync(
      path.join(__dirname, "../src/public/reports-monthly-expenses.html"),
      "utf8",
    );
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    await new Promise(setImmediate);

    const yearSelect = elements.get("yearSelect");
    assert.ok(yearSelect.children.some((option) => option.value === "2025"));
    assert.equal(yearSelect.value, String(new Date().getFullYear()));
    assert.equal((elements.get("expensesHead").innerHTML.match(/scope="col"/g) || []).length, 14);
    assert.ok(elements.get("expensesBody").innerHTML.includes("&lt;Example &amp; expense&gt;"));
    assert.equal((elements.get("expensesBody").innerHTML.match(/\$0\.00/g) || []).length, 14);
    assert.ok(elements.get("expensesBody").innerHTML.includes("Monthly average: $0.00"));
    assert.ok(elements.get("expensesBody").innerHTML.includes("(0 non-zero months)"));

    vm.runInContext(`renderReport({
      data: [
        { category: "Some months", months: [10, 0, 20, ...Array(9).fill(0)], totalAmount: 30 },
        { category: "One month", months: [0, 0, 9, ...Array(9).fill(0)], totalAmount: 9 }
      ],
      totals: { months: [10, 0, 29, ...Array(9).fill(0)], totalAmount: 39 }
    })`, context);
    assert.ok(elements.get("expensesBody").innerHTML.includes("Monthly average: $15.00"));
    assert.ok(elements.get("expensesBody").innerHTML.includes("(2 non-zero months)"));
    assert.ok(elements.get("expensesBody").innerHTML.includes("Monthly average: $9.00"));
    assert.ok(elements.get("expensesBody").innerHTML.includes("(1 non-zero month)"));
    assert.ok(elements.get("expensesFoot").innerHTML.includes("Monthly average: $19.50"));
    assert.ok(elements.get("expensesFoot").innerHTML.includes("(2 non-zero months)"));
    assert.equal((elements.get("expensesBody").innerHTML.match(/<details class="annual-total">/g) || []).length, 2);
    assert.ok(elements.get("expensesFoot").innerHTML.includes('<summary>$39.00</summary>'));
    assert.equal(yearSelect.disabled, false);

    yearSelect.value = "2025";
    await yearSelect.listeners.change();
    assert.equal(requests.at(-1), "/api/reports/monthly-expenses?year=2025");
    assert.ok(elements.get("status").textContent.includes("2025"));

    failReport = true;
    await elements.get("loadBtn").listeners.click();
    assert.equal(elements.get("status").textContent, "Report unavailable");
    assert.equal(elements.get("expensesBody").innerHTML, "");
    assert.equal(elements.get("expensesFoot").innerHTML, "");
    assert.equal(elements.get("loadBtn").disabled, false);
    assert.equal(yearSelect.disabled, false);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function report(query = "?year=2026") {
    const response = await fetch(`${baseUrl}/api/reports/monthly-expenses${query}`);
    return { status: response.status, body: await response.json() };
  }

  await t.test("selected expense categories, all twelve months, and exact totals", async () => {
    const { status, body } = await report();
    assert.equal(status, 200);
    assert.deepEqual(body.period, { year: 2026 });
    assert.equal(body.count, 3);
    assert.deepEqual(body.data, [
      {
        category: "Groceries",
        months: [10.3, 2.25, ...Array(10).fill(0)],
        totalAmount: 12.55,
      },
      {
        category: "Housing",
        months: [100, ...Array(10).fill(0), 20],
        totalAmount: 120,
      },
      {
        category: "No spending",
        months: Array(12).fill(0),
        totalAmount: 0,
      },
    ]);
    assert.deepEqual(body.totals, {
      months: [110.3, 2.25, ...Array(9).fill(0), 20],
      totalAmount: 132.55,
    });
    const nextYear = await report("?year=2027");
    assert.equal(nextYear.body.totals.totalAmount, 800);
    assert.equal(nextYear.body.totals.months[0], 800);

    const existing = await fetch(`${baseUrl}/api/reports/category-monthly?year=2026`);
    const trends = await existing.json();
    assert.ok(trends.categories.includes("Excluded"));
    assert.ok(trends.categories.includes("Salary"));
  });

  await t.test("years without transactions retain selected categories with zeros", async () => {
    const { status, body } = await report("?year=2024");
    assert.equal(status, 200);
    assert.equal(body.count, 3);
    assert.ok(body.data.every((row) =>
      row.totalAmount === 0 && row.months.length === 12 && row.months.every((value) => value === 0),
    ));
    assert.deepEqual(body.totals, { months: Array(12).fill(0), totalAmount: 0 });
  });

  await t.test("saved checkbox changes drive the report and empty selection", async () => {
    async function setSelection(name, included) {
      const response = await fetch(`${baseUrl}/api/categories/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeInMonthlyReport: included }),
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    await setSelection("Groceries", false);
    let result = await report();
    assert.deepEqual(result.body.data.map((row) => row.category), ["Housing", "No spending"]);
    assert.equal(result.body.totals.totalAmount, 120);
    await setSelection("Groceries", true);
    result = await report();
    assert.equal(result.body.totals.totalAmount, 132.55);
    for (const name of ["Groceries", "Housing", "No spending"]) {
      await setSelection(name, false);
    }
    result = await report();
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 0);
    assert.deepEqual(result.body.data, []);
    assert.deepEqual(result.body.totals, { months: Array(12).fill(0), totalAmount: 0 });
  });

  await t.test("invalid years return explicit validation errors", async () => {
    for (const query of ["", "?year=", "?year=nope", "?year=2026.5", "?year=1969", "?year=10000"]) {
      const result = await report(query);
      assert.equal(result.status, 400);
      assert.equal(result.body.error, "year is required and must be a 4-digit year");
    }
  });
});
