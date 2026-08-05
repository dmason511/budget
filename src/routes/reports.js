const express = require("express");
const { all, get } = require("../db/database");

const router = express.Router();

function parseYear(value) {
  const year = Number(value);

  if (!Number.isInteger(year)) {
    return null;
  }

  if (year < 1970 || year > 9999) {
    return null;
  }

  return year;
}

function parseMonth(value) {
  if (value === undefined) {
    return undefined;
  }

  const month = Number(value);

  if (!Number.isInteger(month)) {
    return null;
  }

  if (month < 1 || month > 12) {
    return null;
  }

  return month;
}

function getPeriodRange(year, month) {
  const startMonth = month ?? 1;
  const start = new Date(Date.UTC(year, startMonth - 1, 1));
  const end =
    month === undefined
      ? new Date(Date.UTC(year + 1, 0, 1))
      : new Date(Date.UTC(year, startMonth, 1));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function getBudgetPeriodMultiplier(month) {
  return month === undefined ? 12 : 1;
}

function normalizedTransactionDateSql(columnExpression) {
  return `(CASE WHEN length(${columnExpression}) = 10 THEN ${columnExpression} ELSE date(${columnExpression}, 'localtime') END)`;
}

router.get("/available-periods", async (_req, res, next) => {
  try {
    const transactionDateSql = normalizedTransactionDateSql("date");
    const rows = await all(
      `
      SELECT DISTINCT
        CAST(strftime('%Y', ${transactionDateSql}) AS INTEGER) AS year,
        CAST(strftime('%m', ${transactionDateSql}) AS INTEGER) AS month
      FROM transactions
      WHERE date IS NOT NULL
        AND strftime('%Y', ${transactionDateSql}) IS NOT NULL
        AND strftime('%m', ${transactionDateSql}) IS NOT NULL
      ORDER BY year DESC, month ASC
      `,
    );

    const years = [];
    const monthsByYear = {};

    for (const row of rows) {
      const year = row.year;
      const month = row.month;

      if (!monthsByYear[year]) {
        monthsByYear[year] = [];
        years.push(year);
      }

      monthsByYear[year].push(month);
    }

    res.status(200).json({
      data: {
        years,
        monthsByYear,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/category-expenses", async (req, res, next) => {
  try {
    const year = parseYear(req.query.year);

    if (year === null) {
      return res
        .status(400)
        .json({ error: "year is required and must be a 4-digit year" });
    }

    const month = parseMonth(req.query.month);

    if (month === null) {
      return res
        .status(400)
        .json({ error: "month must be an integer from 1 to 12" });
    }

    const { startIso, endIso } = getPeriodRange(year, month);
    const transactionDateSql = normalizedTransactionDateSql("t.date");

    const params = [startIso, endIso];
    const whereSql = `WHERE julianday(${transactionDateSql}) >= julianday(?) AND julianday(${transactionDateSql}) < julianday(?)`;

    const rows = await all(
      `
      SELECT
        t.category AS category,
        COALESCE(c.category_type, 'expense') AS category_type,
        ROUND(SUM(ABS(t.amount)), 2) AS total_amount,
        COUNT(*) AS transaction_count
      FROM transactions t
      LEFT JOIN categories c ON c.name = t.category
      ${whereSql}
      GROUP BY t.category, COALESCE(c.category_type, 'expense')
      ORDER BY total_amount DESC, category COLLATE NOCASE ASC
      `,
      params,
    );

    const data = rows.map((row) => ({
      category: row.category,
      categoryType: row.category_type,
      totalAmount: row.total_amount,
      transactionCount: row.transaction_count,
    }));

    const incomeTotal = data
      .filter((row) => row.categoryType === "income")
      .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
    const expenseTotal = data
      .filter((row) => row.categoryType !== "income")
      .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
    const netTotal = incomeTotal - expenseTotal;

    const openingBalanceRow = await get(
      `
      SELECT ROUND(COALESCE(SUM(
        CASE
          WHEN COALESCE(c.category_type, 'expense') = 'income' THEN ABS(t.amount)
          ELSE -ABS(t.amount)
        END
      ), 0), 2) AS balance
      FROM transactions t
      LEFT JOIN categories c ON c.name = t.category
      WHERE julianday(${transactionDateSql}) < julianday(?)
      `,
      [startIso],
    );

    const periodNetRow = await get(
      `
      SELECT ROUND(COALESCE(SUM(
        CASE
          WHEN COALESCE(c.category_type, 'expense') = 'income' THEN ABS(t.amount)
          ELSE -ABS(t.amount)
        END
      ), 0), 2) AS balance
      FROM transactions t
      LEFT JOIN categories c ON c.name = t.category
      WHERE julianday(${transactionDateSql}) >= julianday(?)
        AND julianday(${transactionDateSql}) < julianday(?)
      `,
      [startIso, endIso],
    );

    const openingBalance = Number(openingBalanceRow?.balance || 0);
    const periodNetBalance = Number(periodNetRow?.balance || 0);
    const closingBalance = openingBalance + periodNetBalance;

    return res.status(200).json({
      count: data.length,
      period: {
        year,
        month: month ?? null,
      },
      totals: {
        income: Number(incomeTotal.toFixed(2)),
        expense: Number(expenseTotal.toFixed(2)),
        net: Number(netTotal.toFixed(2)),
      },
      balance: {
        opening: Number(openingBalance.toFixed(2)),
        periodNet: Number(periodNetBalance.toFixed(2)),
        closing: Number(closingBalance.toFixed(2)),
      },
      data,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/category-monthly", async (req, res, next) => {
  try {
    const year = parseYear(req.query.year);

    if (year === null) {
      return res
        .status(400)
        .json({ error: "year is required and must be a 4-digit year" });
    }

    const rows = await all(
      `
      SELECT
        t.category AS category,
        CAST(strftime('%m', ${normalizedTransactionDateSql("t.date")}) AS INTEGER) AS month,
        ROUND(
          SUM(
            CASE
              WHEN COALESCE(c.category_type, 'expense') = 'income' THEN ABS(t.amount)
              ELSE -ABS(t.amount)
            END
          ),
          2
        ) AS total_amount
      FROM transactions t
      LEFT JOIN categories c ON c.name = t.category
      WHERE strftime('%Y', ${normalizedTransactionDateSql("t.date")}) = ?
      GROUP BY t.category, CAST(strftime('%m', ${normalizedTransactionDateSql("t.date")}) AS INTEGER)
      ORDER BY t.category COLLATE NOCASE ASC, month ASC
      `,
      [String(year)],
    );

    const categories = [];
    const categorySet = new Set();

    for (const row of rows) {
      if (!categorySet.has(row.category)) {
        categorySet.add(row.category);
        categories.push(row.category);
      }
    }

    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const totalsByMonthAndCategory = new Map();

    for (const row of rows) {
      totalsByMonthAndCategory.set(
        `${row.month}::${row.category}`,
        Number(row.total_amount || 0),
      );
    }

    const datasets = monthNames.map((monthName, index) => {
      const month = index + 1;

      return {
        month,
        label: monthName,
        data: categories.map(
          (category) =>
            totalsByMonthAndCategory.get(`${month}::${category}`) || 0,
        ),
      };
    });

    res.status(200).json({
      period: { year },
      categories,
      datasets,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/category-budget-comparison", async (req, res, next) => {
  try {
    const year = parseYear(req.query.year);

    if (year === null) {
      return res
        .status(400)
        .json({ error: "year is required and must be a 4-digit year" });
    }

    const month = parseMonth(req.query.month);

    if (month === null) {
      return res
        .status(400)
        .json({ error: "month must be an integer from 1 to 12" });
    }

    const { startIso, endIso } = getPeriodRange(year, month);
    const transactionDateSql = normalizedTransactionDateSql("t.date");
    const budgetMultiplier = getBudgetPeriodMultiplier(month);

    const rows = await all(
      `
      WITH period_transactions AS (
        SELECT
          t.category AS category,
          ROUND(SUM(ABS(t.amount)), 2) AS actual_amount,
          COUNT(*) AS transaction_count
        FROM transactions t
        WHERE julianday(${transactionDateSql}) >= julianday(?)
          AND julianday(${transactionDateSql}) < julianday(?)
        GROUP BY t.category
      ),
      comparison_rows AS (
        SELECT
          c.name AS category,
          COALESCE(c.category_type, 'expense') AS category_type,
          ROUND(COALESCE(c.budget_amount, 0) * ?, 2) AS budget_amount,
          ROUND(COALESCE(pt.actual_amount, 0), 2) AS actual_amount,
          COALESCE(pt.transaction_count, 0) AS transaction_count
        FROM categories c
        LEFT JOIN period_transactions pt ON pt.category = c.name

        UNION ALL

        SELECT
          pt.category AS category,
          'expense' AS category_type,
          0 AS budget_amount,
          ROUND(pt.actual_amount, 2) AS actual_amount,
          pt.transaction_count AS transaction_count
        FROM period_transactions pt
        LEFT JOIN categories c ON c.name = pt.category
        WHERE c.id IS NULL
      )
      SELECT
        category,
        category_type,
        budget_amount,
        actual_amount,
        ROUND(actual_amount - budget_amount, 2) AS variance_amount,
        transaction_count
      FROM comparison_rows
      WHERE category_type != 'income'
        AND (budget_amount != 0 OR actual_amount != 0 OR transaction_count != 0)
      ORDER BY ABS(actual_amount - budget_amount) DESC, category COLLATE NOCASE ASC
      `,
      [startIso, endIso, budgetMultiplier],
    );

    const data = rows.map((row) => ({
      category: row.category,
      categoryType: row.category_type,
      budgetAmount: Number(row.budget_amount || 0),
      actualAmount: Number(row.actual_amount || 0),
      varianceAmount: Number(row.variance_amount || 0),
      transactionCount: Number(row.transaction_count || 0),
    }));

    const totals = data.reduce(
      (summary, row) => {
        const variance = Number(row.varianceAmount || 0);

        summary.budget += Number(row.budgetAmount || 0);
        summary.actual += Number(row.actualAmount || 0);
        summary.variance += variance;

        if (variance > 0) {
          summary.overBudgetCount += 1;
        } else if (variance < 0) {
          summary.underBudgetCount += 1;
        } else {
          summary.onBudgetCount += 1;
        }

        return summary;
      },
      {
        budget: 0,
        actual: 0,
        variance: 0,
        overBudgetCount: 0,
        underBudgetCount: 0,
        onBudgetCount: 0,
      },
    );

    return res.status(200).json({
      count: data.length,
      period: {
        year,
        month: month ?? null,
        budgetMultiplier,
      },
      totals: {
        budget: Number(totals.budget.toFixed(2)),
        actual: Number(totals.actual.toFixed(2)),
        variance: Number(totals.variance.toFixed(2)),
        overBudgetCount: totals.overBudgetCount,
        underBudgetCount: totals.underBudgetCount,
        onBudgetCount: totals.onBudgetCount,
      },
      data,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
