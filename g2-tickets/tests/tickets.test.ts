import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTodo, detailText, noteDate, openTodo, parseTicketEmail, rowLabel, shortName, type Mail } from "../src/tickets.ts";
import { demoMail, helpdeskMail } from "../src/demo.ts";

const ME = "dsmith@iu19.org";
const NOW = new Date("2026-11-05T15:00:00Z");

// Shaped like the real emails (whitespace, quoting and all), with made-up people.
const REAL_SHAPE: Mail = {
  subject: "Re: [[TIC #1209]] Computer Issue - Computer Stuck on Loading Screens",
  from: "IU19 Helpdesk <helpdesk@iu19.org>",
  to: ["dsmith@iu19.org"], cc: [], date: "2026-09-22T13:13:48Z", messageId: "m1",
  text: `﻿### Everything above this line is added to your ticket ###\r
From: Pat Manager\r
User: Sam Teacher\r
\r
Hi,\r
\r
Sam Teacher updated ticket 1209. The state is currently set to In Progress.\r
You can review the note history below. To respond, answer to this email or log in to the helpdesk.\r
From: Pat Manager <pmanager@iu19.org>\r
Date: Tue, 22 Sep 2026 09:13:43 (UTC -04:00)\r
We can order a new laptop. I added Amanda, thank you\r
[cid:998775b5-8f66-45dc-975c-cb1d4bf903c9]\r
________________________________\r
From: IU19 Helpdesk <helpdesk@iu19.org>\r
Sent: Tuesday, September 22, 2026 9:10 AM\r
[newlogo.jpg]\r
Helpdesk Solution\r
`,
};

test("an update: ticket, state, requester and the newest note, without the quoted reply", () => {
  const e = parseTicketEmail(REAL_SHAPE, ME)!;
  assert.equal(e.id, 1209);
  assert.equal(e.title, "Computer Issue - Computer Stuck on Loading Screens");
  assert.equal(e.kind, "updated");
  assert.equal(e.state, "In Progress");
  assert.equal(e.requester, "Sam Teacher");
  assert.equal(e.actor, "Pat Manager");
  assert.equal(e.toMe, true);
  assert.deepEqual(e.note, { author: "Pat Manager", date: "Tue, 22 Sep 2026 09:13:43 (UTC -04:00)", text: "We can order a new laptop. I added Amanda, thank you" });
});

test("opened, closed and awaiting reply", () => {
  const opened = parseTicketEmail(helpdeskMail({ id: 7, title: "Wifi", hoursAgo: 1, event: "opened", requester: "A B", note: "down" }, NOW), ME)!;
  assert.equal(opened.kind, "opened");
  assert.equal(opened.state, "Open");
  assert.equal(opened.type, "IT Support");
  assert.equal(opened.toMe, false);   // team-wide notice
  const closed = parseTicketEmail(helpdeskMail({ id: 7, title: "Wifi", hoursAgo: 0, event: "Closed", requester: "A B", note: "Ticket closed" }, NOW), ME)!;
  assert.equal(closed.state, "Closed");
  const waiting = parseTicketEmail(helpdeskMail({ id: 7, title: "Wifi", hoursAgo: 0, event: "Awaiting Reply", requester: "A B", note: "?" }, NOW), ME)!;
  assert.equal(waiting.state, "Awaiting Reply");
});

test("out-of-office replies and other mail are skipped", () => {
  assert.equal(parseTicketEmail({ ...REAL_SHAPE, subject: "Automatic reply: [[TIC #1362]] Printer" }, ME), null);
  assert.equal(parseTicketEmail({ ...REAL_SHAPE, subject: "RE: Automatic reply: [[TIC #1371]] No Subject" }, ME), null);
  assert.equal(parseTicketEmail({ ...REAL_SHAPE, subject: "Lunch?" }, ME), null);
  assert.equal(parseTicketEmail({ ...REAL_SHAPE, text: "no event line here" }, ME), null);
});

test("cc'd on an update counts as mine", () => {
  const e = parseTicketEmail({ ...REAL_SHAPE, to: [], cc: [ME] }, ME)!;
  assert.equal(e.toMe, true);
});

test("the demo inbox: mine sorted, closed gone, old queue items dropped", () => {
  const box = demoMail(NOW);
  const events = box.mails.map((m) => parseTicketEmail(m, ME)).filter((e) => e !== null);
  assert.equal(events.length, box.mails.length);
  const { mine, queue } = openTodo(buildTodo(events, box.checked), NOW);
  assert.deepEqual(mine.map((t) => t.id), [2090, 2095, 2088]);   // waiting-on-them last
  assert.deepEqual(queue.map((t) => t.id), [2101, 2102]);         // 1990 is 9 days old
  const printer = mine[0];
  assert.equal(printer.state, "In Progress");
  assert.equal(printer.note?.text, "Still offline this morning, can you come by?");
  assert.equal(printer.replyTo, "demo-2090-3");
});

test("checked off stays off until someone writes again", () => {
  const box = demoMail(NOW);
  const events = box.mails.map((m) => parseTicketEmail(m, ME)).filter((e) => e !== null);
  const later = new Date(NOW.getTime() + 60000).toISOString();
  assert.ok(!openTodo(buildTodo(events, { 2095: later }), NOW).mine.some((t) => t.id === 2095));
  const earlier = "2026-11-01T00:00:00Z";
  assert.ok(openTodo(buildTodo(events, { 2095: earlier }), NOW).mine.some((t) => t.id === 2095));
});

test("a late 'opened' email doesn't reopen a ticket", () => {
  const a = parseTicketEmail(helpdeskMail({ id: 9, title: "x", hoursAgo: 2, event: "In Progress", requester: "A B", note: "n" }, NOW), ME)!;
  const b = parseTicketEmail(helpdeskMail({ id: 9, title: "x", hoursAgo: 1, event: "opened", requester: "A B", note: "n" }, NOW), ME)!;
  assert.equal(buildTodo([a, b])[0].state, "In Progress");
});

test("glasses text fits", () => {
  assert.equal(shortName("Ann Marie Levandoski"), "A. Levandoski");
  assert.equal(shortName("febbol@dunmoresd.org"), "febbol");
  assert.equal(noteDate("Wed, 04 Nov 2026 08:38:54 (UTC -05:00)"), "Nov 4 8:38a");
  assert.equal(noteDate("Wed, 04 Nov 2026 13:05:00 (UTC -05:00)"), "Nov 4 1:05p");
  const events = demoMail(NOW).mails.map((m) => parseTicketEmail(m, ME)).filter((e) => e !== null);
  for (const t of buildTodo(events)) {
    assert.ok(rowLabel(t).length <= 64, rowLabel(t));
    assert.ok(detailText(t).length <= 330);
  }
  const t = buildTodo(events).find((x) => x.id === 2088)!;
  assert.equal(rowLabel(t), "2088 iPad app won't open · S. Therapist · waiting");
  assert.match(detailText(t), /^#2088 iPad app won't open\nSpeech Therapist · Awaiting Reply\n\nSpeech Therapist, Nov 4 /);
});
