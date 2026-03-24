const test = require("node:test");
const assert = require("node:assert/strict");

const { createRequireApiKey, hashSecret } = require("../src/middleware/requireApiKey");

function createMockReq({ restaurantId = "rest-1", key = "key1.secret1" } = {}) {
  return {
    params: { restaurantId },
    context: {},
    header: (name) => (String(name).toLowerCase() === "x-api-key" ? key : ""),
  };
}

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

function createMiddleware(scopes) {
  const requireApiKey = createRequireApiKey({
    apiKeyRepo: {
      getApiKeyById: async () => ({
        isActive: true,
        revokedAt: null,
        expiresAt: null,
        secretHash: hashSecret("secret1"),
        scopes,
        name: "test",
      }),
    },
    logger: {
      error: () => {},
    },
  });

  return requireApiKey({
    allOf: ["orders.read"],
    anyOf: ["channels.session.read", "whatsapp.session.read"],
  });
}

test("requireApiKey accepts anyOf when one optional scope exists", async () => {
  const middleware = createMiddleware(["orders.read", "channels.session.read"]);
  const req = createMockReq();
  const res = createMockRes();

  let calledNext = false;
  await middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.equal(res.statusCode, 200);
});

test("requireApiKey rejects when anyOf scopes are missing", async () => {
  const middleware = createMiddleware(["orders.read"]);
  const req = createMockReq();
  const res = createMockRes();

  let calledNext = false;
  await middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "API key does not have the required scope");
});
