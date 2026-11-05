import { test } from "node:test";
import assert from "node:assert/strict";
import { PhraseCatcher, rms, wakeSplit } from "../src/listen.ts";

// 100 ms of 16 kHz 16-bit audio at a steady loudness, as the glasses send it.
function chunk(level: number): Uint8Array {
  const out = new Uint8Array(3200);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 1600; i++) v.setInt16(i * 2, i % 2 ? level : -level, true);
  return out;
}
const quiet = () => chunk(80);
const voice = () => chunk(4000);

function run(catcher: PhraseCatcher, chunks: Uint8Array[]) {
  const phrases: Uint8Array[][] = [];
  for (const c of chunks) { const p = catcher.feed(c); if (p) phrases.push(p); }
  return phrases;
}
const seconds = (p: Uint8Array[]) => p.reduce((s, c) => s + c.length, 0) / 32000;

test("loudness of PCM", () => {
  assert.equal(Math.round(rms(chunk(1000))), 1000);
  assert.equal(rms(new Uint8Array(0)), 0);
});

test("a spoken phrase is caught with a little lead-in, and ends after the pause", () => {
  const c = new PhraseCatcher();
  const phrases = run(c, [...Array(20).fill(0).map(quiet), ...Array(15).fill(0).map(voice), ...Array(12).fill(0).map(quiet)]);
  assert.equal(phrases.length, 1);
  // 3 quiet chunks of lead-in, 1.5 s of speech, then the 0.9 s pause that ended it
  assert.equal(seconds(phrases[0]), 0.3 + 1.5 + 0.9);
});

test("a single bump or a short cough is not a phrase", () => {
  const c = new PhraseCatcher();
  assert.equal(run(c, [...Array(10).fill(0).map(quiet), voice(), ...Array(10).fill(0).map(quiet)]).length, 0);
  assert.equal(run(c, [voice(), voice(), voice(), ...Array(12).fill(0).map(quiet)]).length, 0);
});

test("a short pause inside a sentence doesn't cut it", () => {
  const c = new PhraseCatcher();
  const said = [...Array(8).fill(0).map(voice), ...Array(5).fill(0).map(quiet), ...Array(8).fill(0).map(voice), ...Array(10).fill(0).map(quiet)];
  assert.equal(run(c, said).length, 1);
});

test("someone who never stops talking is cut at 15 seconds", () => {
  const c = new PhraseCatcher();
  const phrases = run(c, Array(200).fill(0).map(voice));
  assert.ok(phrases.length >= 1);
  assert.ok(seconds(phrases[0]) <= 15.1);
});

test("a loud room raises the bar: steady machine noise isn't speech", () => {
  const c = new PhraseCatcher();
  assert.equal(run(c, Array(100).fill(0).map(() => chunk(450))).length, 0);
  assert.ok(c.threshold() >= 500);
});

test("wake word: Hey EDITH, and the ways speech-to-text writes it", () => {
  assert.deepEqual(wakeSplit("Hey EDITH, make a work order for Joe."), { woke: true, rest: "Make a work order for Joe." });
  assert.deepEqual(wakeSplit("hey edith"), { woke: true, rest: "" });
  assert.deepEqual(wakeSplit("Hey Eddie what's on Tuesday"), { woke: true, rest: "What's on Tuesday" });
  assert.deepEqual(wakeSplit("Okay, Edith. Order shoes for Ann Lee"), { woke: true, rest: "Order shoes for Ann Lee" });
  assert.deepEqual(wakeSplit("Edith, invoice Doug Smith"), { woke: true, rest: "Invoice Doug Smith" });
  assert.deepEqual(wakeSplit("so anyway, hey Edith, book Joe Sutton Monday"), { woke: true, rest: "Book Joe Sutton Monday" });
});

test("wake word: shop talk without it does nothing", () => {
  assert.equal(wakeSplit("edit Mike's ticket").woke, false);
  assert.equal(wakeSplit("I told Eddie to drill it").woke, false);
  assert.equal(wakeSplit("Meredith is on the lanes").woke, false);
  assert.equal(wakeSplit("").woke, false);
});
