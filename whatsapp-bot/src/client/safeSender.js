const { sleep } = require("../utils/sleep");

function isTimeoutError(error) {
  const message = String(error && error.message ? error.message : "").toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("runtime.callfunctionon") ||
    message.includes("protocolerror")
  );
}

function createSafeSender({
  client,
  logger,
  sendDelayMs,
  retryAttempts,
  retryBackoffMs,
}) {
  async function sendText(chatId, text) {
    let lastError;

    for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
      try {
        if (sendDelayMs > 0) {
          await sleep(sendDelayMs);
        }

        await client.sendMessage(chatId, text);
        logger.info("Outbound send success", {
          chatId,
          attempt,
        });
        return;
      } catch (error) {
        lastError = error;

        if (!isTimeoutError(error) || attempt === retryAttempts) {
          logger.error("Failed to send outbound message", {
            chatId,
            attempt,
            error: error.message,
          });
          throw error;
        }

        logger.warn("Outbound send timed out, retrying", {
          chatId,
          attempt,
          error: error.message,
        });

        await sleep(retryBackoffMs);
      }
    }

    throw lastError;
  }

  return {
    sendText,
  };
}

module.exports = {
  createSafeSender,
};
