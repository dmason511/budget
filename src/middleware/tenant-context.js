const { withTenantContext } = require("../db/database");

function applyTenantContext(req, _res, next) {
  const tenantId = req.user?.tenantId || "default";
  withTenantContext(tenantId, next);
}

module.exports = applyTenantContext;
