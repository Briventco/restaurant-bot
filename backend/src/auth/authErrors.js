const { createHttpError } = require("../domain/utils/httpError");

function authError(statusCode, code, message, details) {
  return createHttpError(statusCode, message, {
    code,
    ...(details ? { details } : {}),
  });
}

function sendAuthError(res, error) {
  const statusCode =
    error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const details = error && error.details ? error.details : {};

  res.status(statusCode).json({
    success: false,
    error: {
      code: details.code || "auth_error",
      message: error && error.message ? error.message : "Authentication failed",
      ...(details.details ? { details: details.details } : {}),
    },
  });
}

module.exports = {
  authError,
  sendAuthError,
};
