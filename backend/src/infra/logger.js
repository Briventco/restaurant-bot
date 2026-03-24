function format(meta) {
  if (!meta) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (_error) {
    return "";
  }
}

function info(message, meta) {
  console.log(`[INFO] ${message}${format(meta)}`);
}

function warn(message, meta) {
  console.warn(`[WARN] ${message}${format(meta)}`);
}

function error(message, meta) {
  console.error(`[ERROR] ${message}${format(meta)}`);
}

module.exports = {
  info,
  warn,
  error,
};
