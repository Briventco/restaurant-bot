const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWhatsappRuntimeHttpAdapter,
} = require("../src/channels/whatsapp-runtime-http/whatsappRuntimeHttpAdapter");

function createLoggerStub() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("runtime adapter returns shard instance details on successful send", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () =>
      createJsonResponse(200, {
        accepted: true,
        status: "sent",
        deduped: false,
        providerMessageId: "provider-1",
        handledByRuntimeInstance: "wa-shard-1:host:111",
      });

    const adapter = createWhatsappRuntimeHttpAdapter({
      runtimeBaseUrl: "http://runtime.local",
      runtimeApiKey: "runtime-key",
      logger: createLoggerStub(),
      requestTimeoutMs: 12000,
    });

    const result = await adapter.sendMessage({
      restaurantId: "rest-1",
      to: "234000000000@c.us",
      text: "hello",
      metadata: { outboxMessageId: "msg-1" },
    });

    assert.equal(result.status, "sent");
    assert.equal(result.providerMessageId, "provider-1");
    assert.equal(result.handledByRuntimeInstance, "wa-shard-1:host:111");
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime adapter treats in_flight as retryable instead of success", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () =>
      createJsonResponse(200, {
        accepted: true,
        status: "in_flight",
        deduped: true,
        handledByRuntimeInstance: "wa-shard-2:host:222",
      });

    const adapter = createWhatsappRuntimeHttpAdapter({
      runtimeBaseUrl: "http://runtime.local",
      runtimeApiKey: "runtime-key",
      logger: createLoggerStub(),
      requestTimeoutMs: 12000,
    });

    await assert.rejects(
      () =>
        adapter.sendMessage({
          restaurantId: "rest-1",
          to: "234000000000@c.us",
          text: "hello",
          metadata: { outboxMessageId: "msg-2" },
        }),
      (error) => {
        assert.equal(error.code, "RUNTIME_SEND_IN_FLIGHT");
        assert.equal(error.retryable, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime adapter enforces strict request timeout with retryable error", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (_url, options = {}) =>
      new Promise((_resolve, reject) => {
        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });

    const adapter = createWhatsappRuntimeHttpAdapter({
      runtimeBaseUrl: "http://runtime.local",
      runtimeApiKey: "runtime-key",
      logger: createLoggerStub(),
      requestTimeoutMs: 5,
    });

    await assert.rejects(
      () =>
        adapter.sendMessage({
          restaurantId: "rest-1",
          to: "234000000000@c.us",
          text: "hello",
          metadata: { outboxMessageId: "msg-3" },
        }),
      (error) => {
        assert.equal(error.code, "RUNTIME_REQUEST_TIMEOUT");
        assert.equal(error.retryable, true);
        assert.equal(error.statusCode, 504);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});
