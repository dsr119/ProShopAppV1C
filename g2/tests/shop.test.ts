import { test } from "node:test";
import assert from "node:assert/strict";
import { homeRows, shortTime, clip, sortTickets, dayLabel, toBase64, shopToday, type Appointment, type Ticket } from "../src/shop.ts";

const appt = (o: Partial<Appointment>): Appointment => ({ id: "a", customer_name: "Joe Sutton", phone: "570-555-1234", service: "Drill",
  location: "Valley", appt_date: "2026-11-05", appt_time: "18:30:00", completed: false, notes: null, ...o });
const ticket = (o: Partial<Ticket>): Ticket => ({ id: "t", title: "Plug thumb", details: null, status: "new", priority: "normal",
  due_date: null, location: "Valley", assigned_to: null, ...o });

test("times read like the counter says them", () => {
  assert.equal(shortTime("18:30:00"), "6:30p");
  assert.equal(shortTime("09:00:00"), "9a");
  assert.equal(shortTime("12:00:00"), "12p");
  assert.equal(shortTime(null), "");
});

test("days: today, tomorrow, then the date", () => {
  assert.equal(dayLabel("2026-11-05", "2026-11-05"), "Today");
  assert.equal(dayLabel("2026-11-06", "2026-11-05"), "Tomorrow");
  assert.equal(dayLabel("2026-11-09", "2026-11-05"), "Mon Nov 9");
});

test("the shop day is New York's, not the phone's", () => {
  assert.equal(shopToday(new Date("2026-11-06T03:00:00Z")), "2026-11-05");
});

test("list items fit the firmware's 64 characters", () => {
  assert.equal(clip("x".repeat(80)).length, 64);
  assert.equal(clip("  a   b "), "a b");
});

test("home: today's bookings, then coming up, then tickets; other house and done ones left out", () => {
  const rows = homeRows([
    appt({ id: "1", appt_time: "18:30:00" }),
    appt({ id: "2", appt_time: "10:00:00", customer_name: "Ann Lee", service: "Fitting" }),
    appt({ id: "3", location: "South Side" }),
    appt({ id: "4", completed: true }),
    appt({ id: "5", appt_date: "2026-11-06", appt_time: null, location: null }),
  ], [ticket({}), ticket({ title: "Lane 4 pinsetter", priority: "urgent" }), ticket({ status: "done", title: "old" })], "Valley", "2026-11-05");
  assert.deepEqual(rows.map((r) => r.label), [
    "── Today: 2 appointments ──",
    "10a Ann Lee: Fitting",
    "6:30p Joe Sutton: Drill",
    "── Coming up ──",
    "Tomorrow Joe Sutton: Drill",
    "── Open tickets: 2 ──",
    "!! Lane 4 pinsetter",
    "Plug thumb",
  ]);
  assert.match(rows[2].detail!, /Today at 6:30p · Valley\nJoe Sutton\nPhone 570-555-1234\nDrill/);
  assert.equal(rows[0].detail, undefined);
});

test("home: never more than the list's 20 items, and tickets keep their room", () => {
  const many = Array.from({ length: 30 }, (_, i) => appt({ id: `a${i}`, appt_date: "2026-11-06" }));
  const tix = Array.from({ length: 30 }, (_, i) => ticket({ id: `t${i}` }));
  const rows = homeRows(many, tix, "Both", "2026-11-05");
  assert.equal(rows.length, 20);
  assert.ok(rows.filter((r) => r.label === "Plug thumb").length >= 8);
});

test("tickets: urgent, then overdue, then by due date", () => {
  const out = sortTickets([ticket({ id: "later", due_date: "2026-11-20" }), ticket({ id: "late", due_date: "2026-11-01" }),
    ticket({ id: "urgent", priority: "urgent" }), ticket({ id: "none" })], "2026-11-05");
  assert.deepEqual(out.map((t) => t.id), ["urgent", "late", "later", "none"]);
});

test("audio goes out as base64 of every chunk in order", () => {
  assert.equal(toBase64([new Uint8Array([1, 2]), new Uint8Array([3])]), Buffer.from([1, 2, 3]).toString("base64"));
  const big = new Uint8Array(100000).fill(7);
  assert.equal(Buffer.from(toBase64([big]), "base64").length, 100000);
});
