function createChatQueue() {
  const queueByChat = new Map();

  function enqueue(chatId, task) {
    const previous = queueByChat.get(chatId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);

    queueByChat.set(chatId, next);

    next.finally(() => {
      if (queueByChat.get(chatId) === next) {
        queueByChat.delete(chatId);
      }
    });

    return next;
  }

  return {
    enqueue,
    size: () => queueByChat.size,
  };
}

module.exports = {
  createChatQueue,
};
