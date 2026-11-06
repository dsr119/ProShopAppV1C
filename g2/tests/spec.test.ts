import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerHole, fingerPitch, firstSpanMode, gripNumber, nameQueries, nextSpanMode, spanBox, spanModes, spanSelector,
  specParts, specRequest, thumbPitch, upgradeSnapshot, type Snapshot } from "../src/spec.ts";

test("hears a spec sheet request and pulls out the name", () => {
  assert.equal(specRequest("Pull up the spec sheet for Joe Sutton"), "Joe Sutton");
  assert.equal(specRequest("show me Joe Sutton's specs."), "Joe Sutton");
  assert.equal(specRequest("Joe Sutton spec sheet"), "Joe Sutton");
  assert.equal(specRequest("Can you bring up specs for Ann Lee please"), "Ann Lee");
  assert.equal(specRequest("pull up a spec sheet"), "");
  assert.equal(specRequest("work order for Joe Sutton to plug the thumb"), null);
  assert.equal(specRequest("what's the special today"), null);
});

test("tries the whole name, then the last, then the first", () => {
  assert.deepEqual(nameQueries("Joe Sutton"), ["Joe Sutton", "Sutton", "Joe"]);
  assert.deepEqual(nameQueries("Sutton"), ["Sutton"]);
  assert.deepEqual(nameQueries(" "), []);
});

const n = (entered: string, num: number, d: number, dir?: string) => ({ entered, n: num, d, ...(dir ? { dir } : {}) });

const SHEET: Snapshot = {
  finger_grips: "grips", grip_type: "vaccu",
  middle_grip_size: n("25/32", 25, 32), ring_grip_size: n("47/64", 47, 64),
  middle_hole: n("31/32", 31, 32), middle_inserts: "Oval No Mesh",
  middle_fr_pitch: n("5/16", 5, 16, "reverse"), middle_lateral_pitch: n("5/16", 5, 16, "left"),
  span_type: "cut_to_cut",
  middle_cut_to_cut: n("4 15/32", 143, 32), ring_cut_to_cut: n("4 9/16", 73, 16),
  middle_full_span: null, ring_full_span: n("5 1/8", 41, 8),
  middle_cut_to_outer: null, ring_cut_to_outer: null,
  thumb_fr_pitch: n("1/8", 1, 8, "forward"), thumb_lateral_pitch: n("1/8", 1, 8, "right"),
};

test("grip numbers match the sheet's picker", () => {
  assert.equal(gripNumber(SHEET, "middle_grip_size"), "7");
  assert.equal(gripNumber(SHEET, "ring_grip_size"), "5.5");
  assert.equal(gripNumber({ g: n("29/32", 29, 32) }, "g"), "11");
  assert.equal(gripNumber({ g: n("9/16", 9, 16) }, "g"), "0");
});

test("finger pitch goes in the box its direction names", () => {
  assert.equal(fingerPitch(SHEET, "middle"), "REVERSE\n5/16\nLATERAL\n◀ 5/16\nFORWARD\n—");
  assert.match(fingerHole(SHEET, "middle"), /Grip 25\/32 \(7\)\nHole 31\/32\nTurbo\nOval No Mesh/);
});

test("span types: only the measured ones, starting on the sheet's", () => {
  assert.deepEqual(spanModes(SHEET), ["full_span", "cut_to_cut"]);
  assert.equal(firstSpanMode(SHEET), "cut_to_cut");
  assert.equal(nextSpanMode(SHEET, "cut_to_cut"), "full_span");
  assert.equal(nextSpanMode(SHEET, "full_span"), "cut_to_cut");
  assert.equal(nextSpanMode(SHEET, "full_span", -1), "cut_to_cut");
  assert.equal(spanSelector(SHEET, "cut_to_cut"), "F   [C]     Cut to Cut");
  assert.equal(spanBox(SHEET, "middle", "full_span"), "MIDDLE\n\n—");
  assert.equal(spanBox(SHEET, "ring", "full_span"), "RING\n\n5 1/8");
  assert.equal(firstSpanMode({}), null);
});

test("thumb pitches land on their side", () => {
  const p = thumbPitch(SHEET);
  assert.match(p.forward, /1\/8/);
  assert.match(p.reverse, /—/);
  assert.match(p.right, /1\/8/);
  assert.match(p.left, /—/);
});

test("no-thumb sheets have only the fingers", () => {
  assert.deepEqual(specParts({ thumb_mode: "no_thumb" }), ["fingers"]);
  assert.deepEqual(specParts(SHEET), ["fingers", "span", "thumb"]);
});

test("old sheets kept every span in the cut-to-cut fields", () => {
  const old = upgradeSnapshot({ span_type: "full_span", middle_cut_to_cut: n("5", 5, 1), ring_cut_to_cut: null });
  assert.equal((old.middle_full_span as { entered: string }).entered, "5");
  assert.equal(old.middle_cut_to_cut, null);
});
