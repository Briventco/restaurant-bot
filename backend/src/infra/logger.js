const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold() {
  const raw = String(process.env.BACKEND_LOG_LEVEL || "info").trim().toLowerCase();
  return LOG_LEVELS[raw] || LOG_LEVELS.info;
}

const ACTIVE_THRESHOLD = resolveThreshold();

function format(meta) {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (_error) {
    return "";
  }
}

function shouldLog(level) {
  return (LOG_LEVELS[level] || LOG_LEVELS.info) >= ACTIVE_THRESHOLD;
}

function debug(message, meta) {
  if (!shouldLog("debug")) return;
  console.log(`[DEBUG] ${message}${format(meta)}`);
}

function info(message, meta) {
  if (!shouldLog("info")) return;
  console.log(`[INFO] ${message}${format(meta)}`);
}

function warn(message, meta) {
  if (!shouldLog("warn")) return;
  console.warn(`[WARN] ${message}${format(meta)}`);
}

function error(message, meta) {
  if (!shouldLog("error")) return;
  console.error(`[ERROR] ${message}${format(meta)}`);
}

module.exports = {
  debug,
  info,
  warn,
  error,
};
