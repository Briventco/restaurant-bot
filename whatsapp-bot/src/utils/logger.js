function createLogger(scope = "app") {
  function line(level, message, meta) {
    const base = `[${level}] [${scope}] ${message}`;

    if (!meta) {
      console.log(base);
      return;
    }

    try {
      console.log(`${base} ${JSON.stringify(meta)}`);
    } catch (_error) {
      console.log(base);
    }
  }

  return {
    info: (message, meta) => line("INFO", message, meta),
    warn: (message, meta) => line("WARN", message, meta),
    error: (message, meta) => line("ERROR", message, meta),
  };
}

module.exports = {
  createLogger,
};
