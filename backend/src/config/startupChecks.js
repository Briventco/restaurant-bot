function runStartupChecks({ env, logger }) {
  const whatsappProvider = String(env.WHATSAPP_PROVIDER || "").trim().toLowerCase();
  const usingWebjsProvider =
    whatsappProvider === "webjs" || whatsappProvider === "whatsapp-web";
  const usingExternalRuntimeProvider =
    whatsappProvider === "runtime-http" || whatsappProvider === "external-runtime";

  if (whatsappProvider === "meta") {
    if (!env.META_ACCESS_TOKEN) {
      const error = new Error(
        "Invalid Meta config: META_ACCESS_TOKEN is required when WHATSAPP_PROVIDER=meta."
      );
      error.statusCode = 500;
      throw error;
    }

    if (!env.META_PHONE_NUMBER_ID) {
      const error = new Error(
        "Invalid Meta config: META_PHONE_NUMBER_ID is required when WHATSAPP_PROVIDER=meta."
      );
      error.statusCode = 500;
      throw error;
    }
  }

  if (
    env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME &&
    env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME
  ) {
    const error = new Error(
      "Invalid runtime config: both BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME and BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME are enabled."
    );
    error.statusCode = 500;
    throw error;
  }

  if (env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME || usingExternalRuntimeProvider) {
    if (!env.WHATSAPP_RUNTIME_BASE_URL) {
      const error = new Error(
        "Invalid runtime config: WHATSAPP_RUNTIME_BASE_URL is required when external runtime is enabled."
      );
      error.statusCode = 500;
      throw error;
    }

    if (!env.WHATSAPP_RUNTIME_API_KEY) {
      const error = new Error(
        "Invalid runtime config: WHATSAPP_RUNTIME_API_KEY is required when external runtime is enabled."
      );
      error.statusCode = 500;
      throw error;
    }
  }

  if (
    !usingWebjsProvider &&
    whatsappProvider !== "meta" &&
    !usingExternalRuntimeProvider &&
    !env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME &&
    !env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME
  ) {
    logger.warn("WhatsApp runtime is disabled in backend config", {
      recommendation:
        "Set WHATSAPP_PROVIDER=webjs or configure an external runtime for production multi-tenant messaging.",
    });
  }

  if (!env.OUTBOX_INLINE_SEND_ENABLED && !env.OUTBOX_WORKER_ENABLED) {
    logger.warn("Outbound delivery is effectively disabled", {
      recommendation:
        "Enable OUTBOX_INLINE_SEND_ENABLED or OUTBOX_WORKER_ENABLED to deliver outbound messages.",
    });
  }
}

module.exports = {
  runStartupChecks,
};
