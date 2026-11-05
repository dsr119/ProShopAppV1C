// Pure helpers: turn appointment and ticket rows into the short lines the
// glasses can show. No SDK or network here, so the tests can run them as-is.

export type Place = "Valley" | "South Side" | "Both";

export interface Appointment {
  id: string;
  customer_name: string;
  phone: string | null;
  service: string;
  location: string | null;
  appt_date: string;          // YYYY-MM-DD
  appt_time: string | null;   // HH:MM:SS
  completed: boolean;
  notes: string | null;
  staff_member?: string | null;
  paid?: boolean;
}

export interface Ticket {
  id: string;
  title: string;
  details: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  location: string | null;
  assigned_to: string | null;
}

// A line on the home list, and what pressing it opens.
export interface Row {
  label: string;
  detail?: string;
}

const LIST_MAX = 20;          // firmware list limit
const ITEM_MAX = 64;          // characters per list item
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The shop's calendar day, whatever time zone the phone is in.
export function shopToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// "Thu Nov 5"
export function longDate(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return longDate(day);
}

// "18:30:00" -> "6:30p"; null for no time.
export function shortTime(t: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return "";
  const h = Number(m[1]);
  const ap = h < 12 ? "a" : "p";
  return `${h % 12 || 12}${m[2] === "00" ? "" : `:${m[2]}`}${ap}`;
}

export function clip(s: string, max = ITEM_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

// "Both" or no location shows in either house, as on the day board.
export function inHouse(location: string | null, place: Place): boolean {
  return place === "Both" || !location || location === "Both" || location === place;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

// Open tickets the way the board pins them: urgent and overdue first, then by due date.
export function sortTickets(tickets: Ticket[], today: string): Ticket[] {
  const late = (t: Ticket) => (t.due_date && t.due_date <= today ? 0 : 1);
  return [...tickets].sort((a, b) =>
    (a.priority === "urgent" ? 0 : 1) - (b.priority === "urgent" ? 0 : 1)
    || late(a) - late(b)
    || (a.due_date || "9999").localeCompare(b.due_date || "9999")
    || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2));
}

function apptDetail(a: Appointment, today: string): string {
  return [
    `${dayLabel(a.appt_date, today)}${a.appt_time ? ` at ${shortTime(a.appt_time)}` : ""}${a.location ? ` · ${a.location}` : ""}`,
    a.customer_name,
    a.phone ? `Phone ${a.phone}` : "No phone on file",
    a.service,
    a.staff_member ? `With ${a.staff_member}` : "",
    a.paid ? "Paid" : "",
    a.completed ? "Done" : "",
    a.notes ? `Note: ${a.notes}` : "",
  ].filter(Boolean).join("\n");
}

function ticketDetail(t: Ticket, today: string): string {
  return [
    t.title,
    `${t.priority === "normal" ? "" : `${t.priority.toUpperCase()} · `}${t.status.replace("_", " ")}${t.assigned_to ? ` · ${t.assigned_to}` : ""}`,
    t.due_date ? `Due ${dayLabel(t.due_date, today)}` : "",
    t.details || "",
  ].filter(Boolean).join("\n");
}

// The home list: appointments (today first, then the next few days), then
// open tickets. Headers are rows too, with no detail. Fits the 20-item list.
export function homeRows(appts: Appointment[], tickets: Ticket[], place: Place, today: string): Row[] {
  const mine = appts
    .filter((a) => inHouse(a.location, place) && !a.completed)
    .sort((a, b) => (a.appt_date + (a.appt_time || "99")).localeCompare(b.appt_date + (b.appt_time || "99")));
  const todays = mine.filter((a) => a.appt_date === today);
  const later = mine.filter((a) => a.appt_date > today);
  const open = sortTickets(tickets.filter((t) => t.status !== "done" && inHouse(t.location, place)), today);

  const rows: Row[] = [{ label: `── Today: ${todays.length || "no"} appointment${todays.length === 1 ? "" : "s"} ──` }];
  for (const a of todays) rows.push({ label: clip(`${shortTime(a.appt_time) || "—"} ${a.customer_name}: ${a.service}`), detail: apptDetail(a, today) });

  // Leave room for the tickets: at most half the list goes to later appointments.
  const ticketRoom = Math.min(open.length + 1, Math.floor(LIST_MAX / 2));
  const laterRoom = Math.max(0, LIST_MAX - rows.length - ticketRoom - 1);
  if (later.length && laterRoom > 0) {
    rows.push({ label: "── Coming up ──" });
    for (const a of later.slice(0, laterRoom)) {
      const when = `${dayLabel(a.appt_date, today).replace(/ \w+ \d+$/, "")} ${shortTime(a.appt_time)}`.trim();
      rows.push({ label: clip(`${when} ${a.customer_name}: ${a.service}`), detail: apptDetail(a, today) });
    }
  }

  rows.push({ label: `── Open tickets: ${open.length} ──` });
  for (const t of open.slice(0, LIST_MAX - rows.length)) {
    const flag = t.priority === "urgent" ? "!! " : t.priority === "high" || (t.due_date && t.due_date <= today) ? "! " : "";
    rows.push({ label: clip(`${flag}${t.title}`), detail: ticketDetail(t, today) });
  }
  return rows.slice(0, LIST_MAX);
}

// Base64 of the recorded PCM, in chunks so a 30 second clip doesn't blow the stack.
export function toBase64(chunks: Uint8Array[]): string {
  let bin = "";
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 0x8000) bin += String.fromCharCode(...c.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Word-wrap is the firmware's job; this only keeps a reply page inside the
// 1,000 characters a rebuild accepts.
export function fitPage(text: string, max = 950): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
