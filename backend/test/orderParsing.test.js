const test = require("node:test");
const assert = require("node:assert/strict");

const { parseWithRegex } = require("../src/domain/services/orderParsingService");

test("parseWithRegex extracts quantities and default quantity", () => {
  const items = parseWithRegex("2 jollof rice and chicken", [
    { name: "jollof rice", price: 1500, available: true },
    { name: "chicken", price: 1000, available: true },
  ]);

  assert.deepEqual(items, [
    { name: "jollof rice", quantity: 2 },
    { name: "chicken", quantity: 1 },
  ]);
});
