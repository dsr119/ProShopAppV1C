import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBox, heightFor, linesIn, listText, step, wrap } from "../common/screen.ts";
import { inputOf } from "../common/input.ts";

test("boxes hold whole lines", () => {
  assert.equal(linesIn(heightFor(5)), 5);
  assert.equal(linesIn(10), 1);
});

test("wrap keeps paragraphs and breaks long words", () => {
  assert.deepEqual(wrap("one two three\n\nfour", 8), ["one two", "three", "", "four"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("fitBox cuts the end, or keeps the end for a conversation", () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const top = fitBox(text, 600, heightFor(4)).split("\n");
  assert.equal(top.length, 4);
  assert.equal(top[0], "line 0");
  assert.match(top[3], /…$/);
  const end = fitBox(text, 600, heightFor(4), true).split("\n");
  assert.deepEqual(end, ["…", "line 27", "line 28", "line 29"]);
});

test("a short list shows every row and marks the cursor", () => {
  assert.equal(listText(["a", "b", "c"], 1, 600, heightFor(5)), "   a\n▶ b\n   c");
});

test("a long list scrolls to keep the cursor on screen", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `row ${i}`);
  const lines = listText(rows, 12, 600, heightFor(7)).split("\n");
  assert.equal(lines.length, 7);
  assert.ok(lines.some((l) => l === "▶ row 12"));
  assert.match(lines[0], /▲ \d+ more/);
  assert.match(lines[6], /▼ \d+ more/);
  const first = listText(rows, 0, 600, heightFor(7)).split("\n");
  assert.equal(first[0], "");
  assert.equal(first[1], "▶ row 0");
});

test("the cursor wraps round", () => {
  assert.equal(step(0, 5, -1), 4);
  assert.equal(step(4, 5, 1), 0);
  assert.equal(step(0, 0, 1), 0);
});

test("glasses events become inputs", () => {
  assert.equal(inputOf("button", { action: "single" }), "tap");
  assert.equal(inputOf("button", { action: "double" }), "double");
  assert.equal(inputOf("button", { action: "long" }), "hold");
  assert.equal(inputOf("gesture", { gesture: "headLower", active: true }), "down");
  assert.equal(inputOf("gesture", { gesture: "headRaise" }), "up");
  assert.equal(inputOf("gesture", { gesture: "left", active: false }), null);
  assert.equal(inputOf("gesture", { gesture: "headRaiseTimeout", active: true }), null);
});
