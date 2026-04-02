function normalizeLaunchMessage(message) {
  return String(message || "").trim().toLowerCase();
}

function classifyLaunchFailure(error) {
  const message = normalizeLaunchMessage(error && error.message);

  if (
    message.includes("browser is already running") ||
    message.includes("userdatadir") ||
    message.includes("stop the running browser first")
  ) {
    return {
      code: "SESSION_CONFLICT",
      reconnectReason: "session_conflict",
      logMessage: "Tenant browser launch blocked by an active session lock",
    };
  }

  return {
    code: String((error && error.code) || "RUNTIME_START_FAILED"),
    reconnectReason: "start_failed",
    logMessage: "Tenant browser launch failed",
  };
}

module.exports = {
  classifyLaunchFailure,
};
