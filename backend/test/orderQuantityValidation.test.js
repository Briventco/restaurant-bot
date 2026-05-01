const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateTotal,
  matchMenuItems,
} = require("../src/domain/services/orderService");

test("pricing uses each item quantity instead of any global total quantity", () => {
  const { matched, invalidQuantities } = matchMenuItems(
    [
      { name: "Jollof Rice", quantity: 2 },
      { name: "Chicken", quantity: 1 },
      { name: "Water", quantity: 2 },
      { name: "Chapman", quantity: 1 },
    ],
    [
      { id: "m1", name: "Jollof Rice", price: 1500, available: true },
      { id: "m2", name: "Chicken", price: 1000, available: true },
      { id: "m3", name: "Water", price: 500, available: true },
      { id: "m4", name: "Chapman", price: 1200, available: true },
    ]
  );

  assert.deepEqual(invalidQuantities, []);
  assert.deepEqual(matched, [
    { menuItemId: "m1", name: "Jollof Rice", price: 1500, quantity: 2, subtotal: 3000 },
    { menuItemId: "m2", name: "Chicken", price: 1000, quantity: 1, subtotal: 1000 },
    { menuItemId: "m3", name: "Water", price: 500, quantity: 2, subtotal: 1000 },
    { menuItemId: "m4", name: "Chapman", price: 1200, quantity: 1, subtotal: 1200 },
  ]);
  assert.equal(calculateTotal(matched), 6200);
});

test("pricing rejects item quantities less than 1 before subtotal calculation", () => {
  const { matched, invalidQuantities } = matchMenuItems(
    [
      { name: "Water", quantity: 0 },
      { name: "Chapman", quantity: -1 },
      { name: "Chicken", quantity: 1 },
    ],
    [
      { id: "m2", name: "Chicken", price: 1000, available: true },
      { id: "m3", name: "Water", price: 500, available: true },
      { id: "m4", name: "Chapman", price: 1200, available: true },
    ]
  );

  assert.deepEqual(invalidQuantities, ["Water", "Chapman"]);
  assert.deepEqual(matched, [
    { menuItemId: "m2", name: "Chicken", price: 1000, quantity: 1, subtotal: 1000 },
  ]);
  assert.equal(calculateTotal(matched), 1000);
});
