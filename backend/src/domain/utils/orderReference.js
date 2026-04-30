function buildShortOrderCode(orderId) {
  const raw = String(orderId || "").trim();
  if (!raw) {
    return "";
  }

  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = (hash * 31 + raw.charCodeAt(index)) % 1000003;
  }

  const letter = String.fromCharCode(65 + (hash % 26));
  const number = String((Math.floor(hash / 26) % 100) + 1);
  return `${letter}${number}`;
}

function isShortOrderCode(value) {
  return /^[a-z]\d{1,2}$/i.test(String(value || "").trim());
}

module.exports = {
  buildShortOrderCode,
  isShortOrderCode,
};
