"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCategorizedMenuList,
  buildMenuWelcome,
  buildGuidedMenuList,
  getDisplayOrderedMenuItems,
} = require("../src/domain/templates/messages");

// ── buildCategorizedMenuList ───────────────────────────────────────────────

test("single uncategorized items: flat numbered list with no header", () => {
  const items = [
    { name: "Jollof Rice", price: 1500, available: true },
    { name: "Chicken", price: 2000, available: true },
  ];
  const result = buildCategorizedMenuList(items);
  // No category header expected
  assert.doesNotMatch(result, /OTHERS/i);
  assert.match(result, /1\. Jollof Rice/);
  assert.match(result, /2\. Chicken/);
});

test("items with categories: grouped by uppercase section headers", () => {
  const items = [
    { name: "Classic Pancakes", price: 2500, available: true, category: "pancakes" },
    { name: "Banana Pancakes", price: 3000, available: true, category: "pancakes" },
    { name: "Zobo", price: 700, available: true, category: "drinks" },
    { name: "Water", price: 300, available: true, category: "drinks" },
  ];
  const result = buildCategorizedMenuList(items);
  assert.match(result, /^PANCAKES/m, "PANCAKES section header expected");
  assert.match(result, /^DRINKS/m, "DRINKS section header expected");
  assert.match(result, /1\. Classic Pancakes/);
  assert.match(result, /2\. Banana Pancakes/);
  assert.match(result, /3\. Zobo/);
  assert.match(result, /4\. Water/);
});

test("global numbering is preserved across categories", () => {
  const items = [
    { name: "Item A", price: 100, available: true, category: "Cat1" },
    { name: "Item B", price: 200, available: true, category: "Cat2" },
    { name: "Item C", price: 300, available: true, category: "Cat1" },
  ];
  const result = buildCategorizedMenuList(items);
  // Items are grouped by category with sequential numbers across the full display order.
  // Display order: CAT1 → Item A (#1), Item C (#2) | CAT2 → Item B (#3)
  // Numbers are sequential in display order so customers can type the number they see.
  assert.match(result, /1\. Item A/, "Item A must be #1");
  assert.match(result, /2\. Item C/, "Item C must be #2 (2nd in display order)");
  assert.match(result, /3\. Item B/, "Item B must be #3 (3rd in display order)");
  // CAT1 section contains both A and C
  const cat1Idx = result.indexOf("CAT1");
  const cat2Idx = result.indexOf("CAT2");
  assert.ok(cat1Idx < cat2Idx, "CAT1 appears before CAT2 (first seen wins)");
  assert.ok(result.indexOf("Item A") < result.indexOf("Item B"), "Item A (Cat1) appears before Item B (Cat2)");
  assert.ok(result.indexOf("Item C") < result.indexOf("Item B"), "Item C (Cat1) appears before Item B (Cat2)");
});

test("items without category fall under OTHERS when mixed with categorized items", () => {
  const items = [
    { name: "Pancakes", price: 2500, available: true, category: "pancakes" },
    { name: "Mystery Item", price: 500, available: true }, // no category
  ];
  const result = buildCategorizedMenuList(items);
  assert.match(result, /PANCAKES/i);
  assert.match(result, /OTHERS/i, "Uncategorized items must fall under OTHERS");
  assert.match(result, /Mystery Item/);
});

test("unavailable items are excluded from menu", () => {
  const items = [
    { name: "Available", price: 100, available: true, category: "food" },
    { name: "SoldOut", price: 200, available: false, category: "food" },
  ];
  const result = buildCategorizedMenuList(items);
  assert.match(result, /Available/);
  assert.doesNotMatch(result, /SoldOut/);
});

test("empty menu returns empty string", () => {
  assert.equal(buildCategorizedMenuList([]), "");
  assert.equal(buildCategorizedMenuList([{ name: "X", price: 100, available: false }]), "");
});

test("buildGuidedMenuList delegates to categorized list", () => {
  const items = [
    { name: "Waffle", price: 2800, available: true, category: "waffles" },
    { name: "OJ", price: 600, available: true, category: "drinks" },
  ];
  const list = buildGuidedMenuList(items);
  assert.match(list, /WAFFLES/i);
  assert.match(list, /DRINKS/i);
});

test("buildMenuWelcome contains category sections and reply instruction", () => {
  const items = [
    { name: "Shawarma", price: 3000, available: true, category: "Meals" },
    { name: "Coke", price: 400, available: true, category: "Drinks" },
  ];
  const welcome = buildMenuWelcome(items, "Test Kitchen");
  assert.match(welcome, /Welcome to Test Kitchen/i);
  assert.match(welcome, /MEALS/i);
  assert.match(welcome, /DRINKS/i);
  assert.match(welcome, /1\. Shawarma/);
  assert.match(welcome, /2\. Coke/);
  assert.match(welcome, /Reply with the item name or number/i);
});

test("menu item numbers map correctly to selection index", () => {
  // Simulates resolveMenuSelection logic: pick by 1-based index from getDisplayOrderedMenuItems
  const items = [
    { id: "a", name: "Pancakes", price: 2500, available: true, category: "pancakes" },
    { id: "b", name: "Waffles", price: 2800, available: true, category: "waffles" },
    { id: "c", name: "Zobo", price: 700, available: true, category: "drinks" },
  ];
  const displayOrdered = getDisplayOrderedMenuItems(items);
  const result = buildCategorizedMenuList(items);

  // Find what number Zobo appears as in the output
  const zoboMatch = result.match(/(\d+)\. Zobo/);
  assert.ok(zoboMatch, "Zobo must appear in menu");
  const zoboNumber = Number(zoboMatch[1]);

  // That number minus 1 should index into displayOrdered to give Zobo
  const selected = displayOrdered[zoboNumber - 1];
  assert.equal(selected.id, "c", "Item number in menu must map to correct item via display-ordered lookup");
});

test("categories are case-insensitive — 'Pancakes' and 'pancakes' merge", () => {
  const items = [
    { name: "Classic", price: 2500, available: true, category: "Pancakes" },
    { name: "Banana", price: 3000, available: true, category: "pancakes" },
  ];
  const result = buildCategorizedMenuList(items);
  // Should have exactly one PANCAKES section
  const matches = [...result.matchAll(/^PANCAKES/gm)];
  assert.equal(matches.length, 1, "Category should appear only once regardless of input case");
  assert.match(result, /1\. Classic/);
  assert.match(result, /2\. Banana/);
});
