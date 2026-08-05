const express = require("express");
const { randomUUID } = require("node:crypto");
const { all, get, run } = require("../db/database");

const router = express.Router();

function parseAmount(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function normalizeDateToZulu(value) {
  const result = {
    value: null,
    invalid: false,
  };

  if (value === undefined || value === null || value === "") {
    return result;
  }

  if (typeof value !== "string") {
    result.invalid = true;
    return result;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return result;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const localMidnight = new Date(`${trimmed}T00:00:00`);
    if (Number.isNaN(localMidnight.getTime())) {
      result.invalid = true;
      return result;
    }

    result.value = localMidnight.toISOString();
    return result;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    result.invalid = true;
    return result;
  }

  result.value = parsed.toISOString();
  return result;
}

function toResponse(transaction) {
  return {
    id: transaction.id,
    description: transaction.description,
    amount: transaction.amount,
    category: transaction.category,
    date: transaction.date,
    createdAt: transaction.created_at,
    updatedAt: transaction.updated_at,
  };
}

function validatePayload(body) {
  if (!body || typeof body !== "object") {
    return "Request body is required";
  }

  if (body.description !== undefined && typeof body.description !== "string") {
    return "description must be a string";
  }

  const amount = parseAmount(body.amount);
  if (amount === null) {
    return "amount is required and must be a valid number greater than 0";
  }

  if (amount <= 0) {
    return "amount must be greater than 0";
  }

  if (body.category !== undefined && typeof body.category !== "string") {
    return "category must be a string";
  }

  if (body.date !== undefined) {
    const normalizedDate = normalizeDateToZulu(body.date);
    if (normalizedDate.invalid) {
      return "date must be a valid ISO date/time or YYYY-MM-DD";
    }
  }

  return null;
}

router.get("/", async (_req, res, next) => {
  try {
    const rows = await all(
      `
      SELECT id, description, amount, category, date, created_at, updated_at
      FROM transactions
      ORDER BY created_at DESC
      `,
    );

    const data = rows.map(toResponse);

    res.status(200).json({
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const transaction = await get(
      `
      SELECT id, description, amount, category, date, created_at, updated_at
      FROM transactions
      WHERE id = ?
      `,
      [req.params.id],
    );

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.status(200).json({ data: toResponse(transaction) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const validationError = validatePayload(req.body);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const now = new Date().toISOString();
    const normalizedDate = normalizeDateToZulu(req.body?.date);
    const transaction = {
      id: randomUUID(),
      description:
        typeof req.body.description === "string"
          ? req.body.description.trim()
          : "",
      amount: Number(req.body.amount),
      category: req.body.category ? req.body.category.trim() : "uncategorized",
      date: normalizedDate.value || now,
      createdAt: now,
      updatedAt: null,
    };

    await run(
      `
      INSERT INTO transactions (
        id,
        description,
        amount,
        category,
        date,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        transaction.id,
        transaction.description,
        transaction.amount,
        transaction.category,
        transaction.date,
        transaction.createdAt,
        transaction.updatedAt,
      ],
    );

    return res.status(201).json({ data: transaction });
  } catch (error) {
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const existing = await get(
      `
      SELECT id, description, amount, category, date, created_at, updated_at
      FROM transactions
      WHERE id = ?
      `,
      [req.params.id],
    );

    if (!existing) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const validationError = validatePayload(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const updated = {
      id: existing.id,
      description:
        typeof req.body.description === "string"
          ? req.body.description.trim()
          : "",
      amount: Number(req.body.amount),
      category: req.body.category ? req.body.category.trim() : "uncategorized",
      date: normalizeDateToZulu(req.body?.date).value || existing.date,
      createdAt: existing.created_at,
      updatedAt: new Date().toISOString(),
    };

    await run(
      `
      UPDATE transactions
      SET description = ?, amount = ?, category = ?, date = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        updated.description,
        updated.amount,
        updated.category,
        updated.date,
        updated.updatedAt,
        updated.id,
      ],
    );

    return res.status(200).json({ data: updated });
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await get(
      `
      SELECT id, description, amount, category, date, created_at, updated_at
      FROM transactions
      WHERE id = ?
      `,
      [req.params.id],
    );

    if (!existing) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    await run("DELETE FROM transactions WHERE id = ?", [req.params.id]);

    return res.status(200).json({ data: toResponse(existing) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
