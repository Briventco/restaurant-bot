function validateValue(value, rule, fieldName) {
  if (value === undefined || value === null) {
    if (rule.required) {
      return `${fieldName} is required`;
    }
    return null;
  }

  if (rule.type === "string" && typeof value !== "string") {
    return `${fieldName} must be a string`;
  }

  if (rule.type === "number" && typeof value !== "number") {
    return `${fieldName} must be a number`;
  }

  if (rule.type === "boolean" && typeof value !== "boolean") {
    return `${fieldName} must be a boolean`;
  }

  if (rule.type === "array" && !Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }

  if (rule.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
    return `${fieldName} must be an object`;
  }

  if (rule.minLength && typeof value === "string" && value.trim().length < rule.minLength) {
    return `${fieldName} must be at least ${rule.minLength} characters`;
  }

  if (rule.minItems && Array.isArray(value) && value.length < rule.minItems) {
    return `${fieldName} must contain at least ${rule.minItems} item(s)`;
  }

  if (typeof rule.custom === "function") {
    const customError = rule.custom(value);
    if (customError) {
      return customError;
    }
  }

  return null;
}

function validateBody(schema) {
  return function bodyValidationMiddleware(req, res, next) {
    const body = req.body || {};

    for (const [fieldName, rule] of Object.entries(schema)) {
      const errorMessage = validateValue(body[fieldName], rule, fieldName);
      if (errorMessage) {
        res.status(400).json({ error: errorMessage });
        return;
      }
    }

    next();
  };
}

module.exports = {
  validateBody,
};
