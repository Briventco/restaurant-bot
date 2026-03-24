function serializeValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item));
  }

  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      return value.toDate().toISOString();
    }

    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = serializeValue(inner);
    }
    return out;
  }

  return value;
}

function serializeDoc(doc) {
  return {
    id: doc.id,
    ...serializeValue(doc.data()),
  };
}

module.exports = {
  serializeValue,
  serializeDoc,
};
