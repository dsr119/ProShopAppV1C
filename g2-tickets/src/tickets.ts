// Turns IU19 Lansweeper helpdesk emails into a to-do list.
//
// Every helpdesk email carries the ticket number in its subject ("[[TIC #1478]] Title")
// and one event line in its body:
//   "<who> opened ticket 1478 under the type IT Support."        (team-wide, unassigned)
//   "<who> updated ticket 1478. The state is currently set to In Progress."
//   "The state of ticket 1478 was set to Closed."
// followed by the note history, newest first. Pure functions only, so the same code runs
// in the backend (Deno) and in the tests (Node).

export type TicketState = "Open" | "In Progress" | "Awaiting Reply" | "Closed";

export interface Mail {
  subject: string;
  from: string; // "IU19 Helpdesk <helpdesk@iu19.org>"
  to: string[]; // addresses
  cc: string[];
  date: string; // ISO
  text: string; // plain-text body
  messageId?: string;
}

export interface Note {
  author: string;
  date: string; // as written in the email
  text: string;
}

export interface TicketEvent {
  id: number;
  title: string;
  kind: "opened" | "updated" | "closed";
  state: TicketState;
  requester: string | null; // "User:" line
  actor: string | null; // "From:" line, who made the change
  type: string | null; // "IT Support"
  toMe: boolean; // sent to me alone or cc'd, rather than to the whole team
  note: Note | null; // newest entry in the note history
  date: string;
  messageId?: string;
}

export interface Ticket {
  id: number;
  title: string;
  state: TicketState;
  requester: string | null;
  type: string | null;
  mine: boolean; // I've been sent updates on it, so I'm on it
  note: Note | null;
  opened: string; // date of the first email seen
  updated: string; // date of the newest email
  done: boolean; // closed in Lansweeper, or checked off by me since the last update
  replyTo?: string; // messageId of the newest email, to reply on
}

const SUBJECT = /\[\[TIC #(\d+)\]\]\s*(.*)$/;
const AUTO_REPLY = /^\s*(RE:\s*)?Automatic reply:/i;
const LINE = "### Everything above this line is added to your ticket ###";
const STATES: TicketState[] = ["In Progress", "Awaiting Reply", "Closed"];

const email = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim().toLowerCase();

/** Lines of the body, trimmed, blanks dropped. Graph's HTML-to-text and Outlook differ on whitespace. */
const lines = (text: string) =>
  text.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ ﻿]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);

/** End of a note: Lansweeper's footer, a quoted Outlook reply, or the next note header. */
const NOTE_END = /^(\[newlogo|\[Lansweeper|Helpdesk Solution$|Powered By Lansweeper$|_{8,}|From: .*<[^>]+@[^>]+>$|-----Original Message|NOTICE OF CONFIDENTIALITY|Get Outlook for)/i;

function firstNote(ls: string[]): Note | null {
  for (let i = 0; i < ls.length - 1; i++) {
    const from = ls[i].match(/^From: (.+?) <[^>]+>$/);
    const date = ls[i + 1].match(/^Date: (.+)$/);
    if (!from || !date) continue;
    const body: string[] = [];
    for (let j = i + 2; j < ls.length && !NOTE_END.test(ls[j]); j++) {
      if (/^\[cid:/.test(ls[j])) continue;
      body.push(ls[j]);
    }
    const author = from[1].replace(/^\[Internal\]\s*/, "");
    return { author, date: date[1], text: body.join("\n") };
  }
  return null;
}

/** One helpdesk email to an event, or null for anything else (auto-replies, other mail). */
export function parseTicketEmail(m: Mail, me: string): TicketEvent | null {
  if (AUTO_REPLY.test(m.subject)) return null;
  const subj = m.subject.match(SUBJECT);
  if (!subj) return null;
  const id = Number(subj[1]);
  const ls = lines(m.text);
  const start = ls.indexOf(LINE);
  const head = ls.slice(start + 1, start + 12);

  const field = (name: string) => head.find((l) => l.startsWith(name + ": "))?.slice(name.length + 2).trim() || null;
  let kind: TicketEvent["kind"] | null = null;
  let state: TicketState = "Open";
  let type: string | null = null;
  for (const l of head) {
    let x: RegExpMatchArray | null;
    if ((x = l.match(new RegExp(`opened ticket ${id} under the type (.+?)\\.?$`)))) {
      kind = "opened";
      type = x[1];
      break;
    }
    if ((x = l.match(new RegExp(`updated ticket ${id}\\. The state is currently set to (.+?)\\.?$`)))) {
      state = STATES.find((s) => s === x![1]) ?? "In Progress";
      kind = state === "Closed" ? "closed" : "updated";
      break;
    }
    if (new RegExp(`The state of ticket ${id} was set to Closed`).test(l)) {
      kind = "closed";
      state = "Closed";
      break;
    }
  }
  if (!kind) return null;

  const meL = me.toLowerCase();
  const to = m.to.map(email);
  const cc = m.cc.map(email);
  // Team-wide notices go to every agent; an email to me alone (or cc) means I'm on the ticket.
  const toMe = [...to, ...cc].includes(meL) && to.length < 3;

  return {
    id,
    title: subj[2].trim() || "(no subject)",
    kind,
    state,
    requester: field("User"),
    actor: field("From"),
    type,
    toMe: toMe && kind !== "opened",
    note: firstNote(ls.slice(start + 1)),
    date: m.date,
    messageId: m.messageId,
  };
}

/**
 * Folds events into one item per ticket. The newest email sets the state, title and note.
 * `checked` holds the time I checked each ticket off on the glasses; a later update
 * (someone replied) puts it back on the list.
 */
export function buildTodo(events: TicketEvent[], checked: Record<number, string> = {}): Ticket[] {
  const byId = new Map<number, Ticket>();
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const t = byId.get(e.id);
    if (!t) {
      byId.set(e.id, {
        id: e.id, title: e.title, state: e.state, requester: e.requester, type: e.type, mine: e.toMe,
        note: e.note, opened: e.date, updated: e.date, done: false, replyTo: e.messageId,
      });
      continue;
    }
    t.title = e.title || t.title;
    t.requester = t.requester ?? e.requester;
    t.type = t.type ?? e.type;
    t.mine ||= e.toMe;
    // A late-arriving "opened" email must not reopen a ticket that's further along.
    if (e.kind !== "opened" || t.state === "Open") t.state = e.state;
    t.note = e.note ?? t.note;
    t.updated = e.date;
    t.replyTo = e.messageId ?? t.replyTo;
  }
  const out = [...byId.values()];
  for (const t of out) t.done = t.state === "Closed" || (checked[t.id] !== undefined && checked[t.id] >= t.updated);
  return out;
}

/**
 * What's left to do. Mine: everything I'm on that isn't closed or checked off.
 * Queue: new unassigned tickets from the last few days. The team gets no email when
 * someone else picks one up, so older queue items would only be noise.
 */
export function openTodo(tickets: Ticket[], now: Date, queueDays = 3): { mine: Ticket[]; queue: Ticket[] } {
  const since = new Date(now.getTime() - queueDays * 86400000).toISOString();
  const newest = (a: Ticket, b: Ticket) => b.updated.localeCompare(a.updated);
  const open = tickets.filter((t) => !t.done);
  return {
    // Waiting on the other person goes to the bottom of my list.
    mine: open.filter((t) => t.mine).sort((a, b) => Number(a.state === "Awaiting Reply") - Number(b.state === "Awaiting Reply") || newest(a, b)),
    queue: open.filter((t) => !t.mine && t.state === "Open" && t.updated >= since).sort(newest),
  };
}

// ---------------------------------------------------------------------------
// Glasses text. List items hold 64 characters; a text page about 1,000.
// ---------------------------------------------------------------------------

export const ITEM_MAX = 64;

export function clip(s: string, max = ITEM_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function fitPage(text: string, max = 950): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const STATE_TAG: Record<TicketState, string> = { Open: "new", "In Progress": "", "Awaiting Reply": "waiting", Closed: "closed" };

/** "Ann Levandoski" -> "A. Levandoski", to leave room for the title. */
export function shortName(name: string | null): string {
  if (!name) return "";
  if (name.includes("@")) return name.split("@")[0];
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? parts[0] : `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

export function rowLabel(t: Ticket): string {
  const tag = STATE_TAG[t.state];
  const who = shortName(t.requester);
  return clip(`${t.id} ${t.title}${who ? ` · ${who}` : ""}${tag ? ` · ${tag}` : ""}`);
}

/** "Wed, 04 Nov 2026 08:38:54 (UTC -05:00)" -> "Nov 4 8:38a"; anything else as written. */
export function noteDate(s: string): string {
  const m = s.match(/(\d{1,2}) (\w{3}) \d{4} (\d{2}):(\d{2})/);
  if (!m) return s;
  const h = Number(m[3]);
  return `${m[2]} ${Number(m[1])} ${h % 12 || 12}:${m[4]}${h < 12 ? "a" : "p"}`;
}

export function detailText(t: Ticket): string {
  const head = `#${t.id} ${t.title}\n${t.requester ?? "?"} · ${t.state}${t.mine ? "" : " · unassigned"}`;
  const note = t.note ? `\n\n${t.note.author}, ${noteDate(t.note.date)}:\n${t.note.text}` : "";
  // About 7 lines fit above the two action buttons.
  return fitPage(head + note, 330);
}

export function toBase64(chunks: Uint8Array[]): string {
  let bin = "";
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 0x8000) bin += String.fromCharCode(...c.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
