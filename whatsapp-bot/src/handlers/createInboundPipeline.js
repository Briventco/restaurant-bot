function createInboundPipeline({
  normalizeInboundMessage,
  shouldIgnoreNormalizedMessage,
  dedupeStore,
  replyDedupeStore,
  chatQueue,
  messageService,
  sendText,
  constants,
  logger,
}) {
  async function handleRawMessage(rawMessage) {
    if (!constants.BOT_ENABLED) {
      return;
    }

    const inbound = normalizeInboundMessage(rawMessage);
    const dedupeKey =
      inbound.messageId ||
      `${inbound.chatId}:${inbound.timestamp || Date.now()}:${String(inbound.body || "").trim()}`;
    const filter = shouldIgnoreNormalizedMessage(inbound, constants);
    logger.info("Inbound received", {
      chatId: inbound.chatId,
      from: inbound.from,
      type: inbound.type,
      messageId: inbound.messageId || "",
      isFromMe: inbound.isFromMe,
      isStatus: inbound.isStatus,
      isBroadcast: inbound.isBroadcast,
    });

    if (filter.ignore) {
      logger.info("Inbound filtered", {
        reason: filter.reason,
        chatId: inbound.chatId,
        type: inbound.type,
        messageId: inbound.messageId || "",
      });
      return;
    }

    const isStaffCommand = Boolean(filter.isStaffCommand);

    if (dedupeStore.isDuplicate(dedupeKey)) {
      logger.warn("Inbound deduped", {
        messageId: inbound.messageId || dedupeKey,
        chatId: inbound.chatId,
      });
      return;
    }

    logger.info("Inbound queued", {
      chatId: inbound.chatId,
      messageId: inbound.messageId || dedupeKey,
      isStaffCommand,
    });

    await chatQueue.enqueue(inbound.chatId, async () => {
      try {
        logger.info("Inbound processing started", {
          chatId: inbound.chatId,
          type: inbound.type,
          messageId: inbound.messageId || dedupeKey,
          isStaffCommand,
        });

        const decision = isStaffCommand
          ? await messageService.processStaffCommand(inbound)
          : await messageService.processInbound(inbound);
        logger.info("Backend response received", {
          chatId: inbound.chatId,
          messageId: inbound.messageId || dedupeKey,
          isStaffCommand,
          responseType: decision && decision.type ? decision.type : "unknown",
          shouldReply: Boolean(decision && decision.shouldReply),
          duplicate: Boolean(decision && decision.duplicate),
          ignored: Boolean(decision && decision.ignored),
        });

        if (!decision || !decision.shouldReply || !decision.replyText) {
          return;
        }

        if (replyDedupeStore.isDuplicate(dedupeKey)) {
          logger.warn("Outbound deduped", {
            messageId: inbound.messageId || dedupeKey,
            chatId: inbound.chatId,
          });
          return;
        }

        await sendText(inbound.chatId, decision.replyText);
        logger.info("Outbound sent", {
          chatId: inbound.chatId,
          messageId: inbound.messageId || dedupeKey,
        });
      } catch (error) {
        logger.error("Inbound pipeline failed", {
          chatId: inbound.chatId,
          type: inbound.type,
          messageId: inbound.messageId || dedupeKey,
          error: error.message,
        });
      }
    });
  }

  return {
    handleRawMessage,
  };
}

module.exports = {
  createInboundPipeline,
};
