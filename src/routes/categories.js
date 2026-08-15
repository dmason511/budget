const express = require("express");
const { randomUUID } = require("node:crypto");
const { all, get, run } = require("../db/database");

const router = express.Router();

function parseDefaultAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const amount = Number(value);
  return Number.isFinite(amount) ? amount : Number.NaN;
}

function parseBudgetAmount(value) {
  return parseDefaultAmount(value);
}

function parseDefaultDueDay(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return Number.NaN;
  }

  return day;
}

function parseNotes(value) {
  if (value === undefined || value === null) {
    return { value: null, invalid: false };
  }

  if (typeof value !== "string") {
    return { value: null, invalid: true };
  }

  const notes = value.trim();
  return { value: notes === "" ? null : notes, invalid: false };
}

function parseCategoryType(value) {
  if (value === undefined || value === null || value === "") {
    return { value: "expense", invalid: false };
  }

  if (typeof value !== "string") {
    return { value: null, invalid: true };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized !== "income" && normalized !== "expense") {
    return { value: null, invalid: true };
  }

  return { value: normalized, invalid: false };
}

function parseCategoryUpdateInput(body, existing) {
  const defaultAmount = parseDefaultAmount(body?.defaultAmount);
  if (Number.isNaN(defaultAmount)) {
    return { error: "defaultAmount must be a valid number" };
  }

  const defaultDueDay = parseDefaultDueDay(body?.defaultDueDay);
  if (Number.isNaN(defaultDueDay)) {
    return { error: "defaultDueDay must be an integer from 1 to 31" };
  }

  const budgetAmount =
    body && Object.hasOwn(body, "budgetAmount")
      ? parseBudgetAmount(body?.budgetAmount)
      : (existing?.budget_amount ?? defaultAmount);
  if (Number.isNaN(budgetAmount)) {
    return { error: "budgetAmount must be a valid number" };
  }

  const notesResult =
    body && Object.hasOwn(body, "notes")
      ? parseNotes(body?.notes)
      : { value: existing?.notes ?? null, invalid: false };
  if (notesResult.invalid) {
    return { error: "notes must be a string" };
  }

  const categoryTypeResult =
    body && Object.hasOwn(body, "categoryType")
      ? parseCategoryType(body?.categoryType)
      : {
          value: existing?.category_type ?? "expense",
          invalid: false,
        };
  if (categoryTypeResult.invalid) {
    return { error: "categoryType must be either income or expense" };
  }

  return {
    error: null,
    values: {
      defaultAmount,
      budgetAmount,
      defaultDueDay,
      notes: notesResult.value,
      categoryType: categoryTypeResult.value,
    },
  };
}

async function processCategoryRename(
  existing,
  requestedName,
  shouldRenameTransactions,
) {
  const isRename = requestedName.toLowerCase() !== existing.name.toLowerCase();
  if (!isRename) {
    return { errorStatus: null, payload: null, renamedTransactionCount: 0 };
  }

  const duplicate = await get(
    "SELECT id FROM categories WHERE lower(name) = lower(?) AND id != ?",
    [requestedName, existing.id],
  );
  if (duplicate) {
    return {
      errorStatus: 409,
      payload: { error: "Category already exists" },
      renamedTransactionCount: 0,
    };
  }

  const usage = await get(
    "SELECT COUNT(*) AS count FROM transactions WHERE category = ?",
    [existing.name],
  );

  const transactionCount = usage?.count || 0;
  if (transactionCount > 0 && !shouldRenameTransactions) {
    return {
      errorStatus: 409,
      payload: {
        error:
          "Category is in use by existing transactions. Confirm to update transaction categories.",
        code: "CATEGORY_IN_USE",
        transactionCount,
        currentName: existing.name,
        requestedName,
      },
      renamedTransactionCount: 0,
    };
  }

  if (transactionCount > 0) {
    await run("UPDATE transactions SET category = ? WHERE category = ?", [
      requestedName,
      existing.name,
    ]);
  }

  return {
    errorStatus: null,
    payload: null,
    renamedTransactionCount: transactionCount,
  };
}

router.get("/", async (_req, res, next) => {
  try {
    const rows = await all(
      `
      SELECT id, name, created_at, default_amount, budget_amount, default_due_date, default_due_day, notes, category_type
      FROM categories
      ORDER BY name COLLATE NOCASE ASC
      `,
    );

    res.status(200).json({
      count: rows.length,
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        defaultAmount: row.default_amount,
        budgetAmount: row.budget_amount,
        defaultDueDay: row.default_due_day,
        defaultDueDate: row.default_due_date,
        notes: row.notes,
        categoryType: row.category_type,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : "";
    const name = rawName.trim();

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const defaultAmount = parseDefaultAmount(req.body?.defaultAmount);
    if (Number.isNaN(defaultAmount)) {
      return res
        .status(400)
        .json({ error: "defaultAmount must be a valid number" });
    }

    const parsedBudgetAmount = parseBudgetAmount(req.body?.budgetAmount);
    if (Number.isNaN(parsedBudgetAmount)) {
      return res
        .status(400)
        .json({ error: "budgetAmount must be a valid number" });
    }

    const budgetAmount =
      req.body && Object.hasOwn(req.body, "budgetAmount")
        ? parsedBudgetAmount
        : defaultAmount;

    const defaultDueDay = parseDefaultDueDay(req.body?.defaultDueDay);
    if (Number.isNaN(defaultDueDay)) {
      return res
        .status(400)
        .json({ error: "defaultDueDay must be an integer from 1 to 31" });
    }

    const notesResult = parseNotes(req.body?.notes);
    if (notesResult.invalid) {
      return res.status(400).json({ error: "notes must be a string" });
    }

    const categoryTypeResult = parseCategoryType(req.body?.categoryType);
    if (categoryTypeResult.invalid) {
      return res
        .status(400)
        .json({ error: "categoryType must be either income or expense" });
    }

    const existing = await get(
      "SELECT id FROM categories WHERE lower(name) = lower(?)",
      [name],
    );
    if (existing) {
      return res.status(409).json({ error: "Category already exists" });
    }

    const category = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      defaultAmount,
      budgetAmount,
      defaultDueDay,
      defaultDueDate: null,
      notes: notesResult.value,
      categoryType: categoryTypeResult.value,
    };

    await run(
      "INSERT INTO categories (id, name, created_at, default_amount, budget_amount, default_due_date, default_due_day, notes, category_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        category.id,
        category.name,
        category.createdAt,
        category.defaultAmount,
        category.budgetAmount,
        category.defaultDueDate,
        category.defaultDueDay,
        category.notes,
        category.categoryType,
      ],
    );

    return res.status(201).json({ data: category });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const existing = await get(
      "SELECT id, name, created_at, default_amount, budget_amount, default_due_date, default_due_day, notes, category_type FROM categories WHERE id = ?",
      [req.params.id],
    );

    if (!existing) {
      return res.status(404).json({ error: "Category not found" });
    }

    const rawName =
      req.body && typeof req.body.name === "string" ? req.body.name : null;
    const requestedName = rawName === null ? existing.name : rawName.trim();

    if (!requestedName) {
      return res.status(400).json({ error: "name is required" });
    }

    const shouldRenameTransactions = req.body?.renameTransactions === true;
    const renameResult = await processCategoryRename(
      existing,
      requestedName,
      shouldRenameTransactions,
    );
    if (renameResult.errorStatus) {
      return res.status(renameResult.errorStatus).json(renameResult.payload);
    }

    const parsedUpdate = parseCategoryUpdateInput(req.body, existing);
    if (parsedUpdate.error) {
      return res.status(400).json({ error: parsedUpdate.error });
    }

    const { defaultAmount, budgetAmount, defaultDueDay, notes, categoryType } =
      parsedUpdate.values;

    await run(
      "UPDATE categories SET name = ?, default_amount = ?, budget_amount = ?, default_due_day = ?, default_due_date = NULL, notes = ?, category_type = ? WHERE id = ?",
      [
        requestedName,
        defaultAmount,
        budgetAmount,
        defaultDueDay,
        notes,
        categoryType,
        existing.id,
      ],
    );

    return res.status(200).json({
      data: {
        id: existing.id,
        name: requestedName,
        createdAt: existing.created_at,
        defaultAmount,
        budgetAmount,
        defaultDueDay,
        defaultDueDate: null,
        notes,
        categoryType,
      },
      renamedTransactionCount: renameResult.renamedTransactionCount,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await get(
      "SELECT id, name, created_at, default_amount, budget_amount, default_due_date, default_due_day, notes, category_type FROM categories WHERE id = ?",
      [req.params.id],
    );

    if (!existing) {
      return res.status(404).json({ error: "Category not found" });
    }

    const usage = await get(
      "SELECT COUNT(*) AS count FROM transactions WHERE category = ?",
      [existing.name],
    );

    if (usage && usage.count > 0) {
      return res.status(409).json({
        error: "Cannot delete category in use by existing transactions",
        code: "CATEGORY_IN_USE",
        transactionCount: usage.count,
        currentName: existing.name,
      });
    }

    await run("DELETE FROM categories WHERE id = ?", [req.params.id]);

    return res.status(200).json({
      data: {
        id: existing.id,
        name: existing.name,
        createdAt: existing.created_at,
        defaultAmount: existing.default_amount,
        budgetAmount: existing.budget_amount,
        defaultDueDay: existing.default_due_day,
        defaultDueDate: existing.default_due_date,
        notes: existing.notes,
        categoryType: existing.category_type,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
