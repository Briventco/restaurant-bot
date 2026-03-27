const test = require("node:test");
const assert = require("node:assert/strict");

const { requirePermission } = require("../src/middleware/requirePermission");
const { requireRestaurantScope } = require("../src/middleware/requireRestaurantScope");
const {
  createRequirePortalOrApiKey,
} = require("../src/middleware/requirePortalOrApiKey");

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("requirePermission allows wildcard permission", () => {
  const middleware = requirePermission(["orders.read", "orders.write"]);
  const req = {
    user: {
      permissions: ["*"],
    },
  };
  const res = createMockRes();

  let calledNext = false;
  middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(res.statusCode, 200);
});

test("requirePermission enforces allOf and anyOf rules", () => {
  const middleware = requirePermission({
    allOf: ["orders.read"],
    anyOf: ["payments.read", "payments.review"],
  });
  const req = {
    user: {
      permissions: ["orders.read"],
    },
  };
  const res = createMockRes();

  middleware(req, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "forbidden");
});

test("requireRestaurantScope allows super_admin across restaurants", () => {
  const req = {
    params: { restaurantId: "lead_mall" },
    user: {
      role: "super_admin",
      restaurantId: null,
    },
  };
  const res = createMockRes();

  let calledNext = false;
  requireRestaurantScope(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(res.statusCode, 200);
});

test("requireRestaurantScope blocks non-matching restaurant user", () => {
  const req = {
    params: { restaurantId: "lead_mall" },
    user: {
      role: "restaurant_admin",
      restaurantId: "other_restaurant",
    },
  };
  const res = createMockRes();

  requireRestaurantScope(req, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, "forbidden_scope");
});

test("createRequirePortalOrApiKey falls back to API key middleware when no bearer auth", () => {
  let usedApiKey = false;
  let usedPortalAuth = false;

  const requirePortalOrApiKey = createRequirePortalOrApiKey({
    requireApiKey: () => (req, _res, next) => {
      usedApiKey = true;
      req.auth = { keyId: "legacy-key" };
      next();
    },
    requireAuth: (_req, _res, next) => {
      usedPortalAuth = true;
      next();
    },
    requirePermission: () => (_req, _res, next) => next(),
    requireRestaurantScope: (_req, _res, next) => next(),
  });

  const middleware = requirePortalOrApiKey(["orders.read"]);
  const req = {
    params: { restaurantId: "lead_mall" },
    header: () => "",
  };
  const res = createMockRes();

  let calledNext = false;
  middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(usedApiKey, true);
  assert.equal(usedPortalAuth, false);
});
