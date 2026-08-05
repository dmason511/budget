const express = require("express");

const {
  adminResetUserPassword,
  createUser,
  listTenants,
  listUsers,
  updateUserAccess,
} = require("../db/auth-store");
const { initializeTenantDatabase } = require("../db/database");
const { requireAdminApi } = require("../middleware/auth");

const router = express.Router();

router.use(requireAdminApi);

router.get("/users", async (_req, res, next) => {
  try {
    const users = await listUsers();
    res.status(200).json({ data: users });
  } catch (error) {
    next(error);
  }
});

router.get("/tenants", async (_req, res, next) => {
  try {
    const tenantIds = await listTenants();
    res.status(200).json({ data: tenantIds });
  } catch (error) {
    next(error);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const created = await createUser({
      username: req.body?.username,
      password: req.body?.password,
      tenantId: req.body?.tenantId,
      role: req.body?.role,
    });

    await initializeTenantDatabase(created.tenantId);

    res.status(201).json({ data: created });
  } catch (error) {
    if (error && /exists|required|least 8/i.test(String(error.message))) {
      res.status(400).json({ error: error.message });
      return;
    }

    next(error);
  }
});

router.patch("/users/:id", async (req, res, next) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (req.user?.id === userId) {
      if (req.body?.role && String(req.body.role).toLowerCase() !== "admin") {
        return res
          .status(400)
          .json({ error: "You cannot remove your own admin access" });
      }

      if (req.body?.isActive === false || req.body?.isActive === 0) {
        return res
          .status(400)
          .json({ error: "You cannot disable your own account" });
      }
    }

    const updated = await updateUserAccess({
      userId,
      role: req.body?.role,
      tenantId: req.body?.tenantId,
      isActive: req.body?.isActive,
    });

    await initializeTenantDatabase(updated.tenantId);

    return res.status(200).json({ data: updated });
  } catch (error) {
    if (
      error &&
      /role|not found|required|admin|disable/i.test(String(error.message))
    ) {
      return res.status(400).json({ error: error.message });
    }

    return next(error);
  }
});

router.patch("/users/:id/password", async (req, res, next) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "User id is required" });
    }

    await adminResetUserPassword({
      userId,
      newPassword: req.body?.newPassword,
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error && /password|not found|least 8/i.test(String(error.message))) {
      return res.status(400).json({ error: error.message });
    }

    return next(error);
  }
});

module.exports = router;
