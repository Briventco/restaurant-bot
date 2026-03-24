function runStartupChecks({ env, logger }) {
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

  if (env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME) {
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
    !env.BACKEND_ENABLE_INTERNAL_WHATSAPP_RUNTIME &&
    !env.BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME
  ) {
    logger.warn("WhatsApp runtime is disabled in backend config", {
      recommendation:
        "Enable BACKEND_ENABLE_EXTERNAL_WHATSAPP_RUNTIME for production multi-tenant runtime.",
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
