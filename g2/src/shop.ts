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

const upcoming = (appts: Appointment[], place: Place) => appts
  .filter((a) => inHouse(a.location, place) && !a.completed)
  .sort((a, b) => (a.appt_date + (a.appt_time || "99")).localeCompare(b.appt_date + (b.appt_time || "99")));

const openTickets = (tickets: Ticket[], place: Place, today: string) =>
  sortTickets(tickets.filter((t) => t.status !== "done" && inHouse(t.location, place)), today);

const ticketFlag = (t: Ticket, today: string) =>
  t.priority === "urgent" ? "!! " : t.priority === "high" || (t.due_date && t.due_date <= today) ? "! " : "";

// "Today", "Tmrw", "Mon", "Mon 11/16" for the short labels.
function shortDay(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tmrw";
  const d = new Date(`${day}T12:00:00Z`);
  const wd = WEEKDAYS[d.getUTCDay()];
  return day <= addDays(today, 6) ? wd : `${wd} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

const BOX = 27;   // characters across one half of the dashboard

// The dashboard's left box: today's bookings, then the next one after today.
export function dashAppointments(appts: Appointment[], place: Place, today: string): string {
  const mine = upcoming(appts, place);
  const todays = mine.filter((a) => a.appt_date === today);
  const lines = [`APPOINTMENTS · ${todays.length || "none"} today`];
  for (const a of todays.slice(0, 4)) lines.push(clip(`${shortTime(a.appt_time) || "—"} ${a.customer_name}`, BOX));
  if (todays.length > 4) lines.push(`+${todays.length - 4} more today`);
  const next = mine.find((a) => a.appt_date > today);
  if (next && lines.length < 6) lines.push(clip(`Next: ${shortDay(next.appt_date, today)} ${shortTime(next.appt_time)} ${next.customer_name}`.replace(/\s+/g, " "), BOX));
  return lines.join("\n");
}

// The dashboard's right box: open tickets, urgent and overdue first.
export function dashTickets(tickets: Ticket[], place: Place, today: string): string {
  const open = openTickets(tickets, place, today);
  const urgent = open.filter((t) => t.priority === "urgent").length;
  const lines = [`TICKETS · ${open.length} open${urgent ? ` · ${urgent} urgent` : ""}`];
  for (const t of open.slice(0, 4)) lines.push(clip(`${ticketFlag(t, today)}${t.title}`, BOX));
  if (open.length > 4) lines.push(`+${open.length - 4} more`);
  return lines.join("\n");
}

// "All appointments": everything booked from today on, a line each.
export function appointmentRows(appts: Appointment[], place: Place, today: string): Row[] {
  const mine = upcoming(appts, place);
  if (!mine.length) return [{ label: "Nothing booked" }];
  const rows = mine.map((a) => ({
    label: clip(`${shortDay(a.appt_date, today)} ${shortTime(a.appt_time)} ${a.customer_name}: ${a.service}`.replace(/\s+/g, " ")),
    detail: apptDetail(a, today),
  }));
  return rows.length <= LIST_MAX ? rows : [...rows.slice(0, LIST_MAX - 1), { label: `…${rows.length - LIST_MAX + 1} more in the app` }];
}

// "All tickets": every open ticket, urgent and overdue first.
export function ticketRows(tickets: Ticket[], place: Place, today: string): Row[] {
  const open = openTickets(tickets, place, today);
  if (!open.length) return [{ label: "No open tickets" }];
  const rows = open.map((t) => ({ label: clip(`${ticketFlag(t, today)}${t.title}`), detail: ticketDetail(t, today) }));
  return rows.length <= LIST_MAX ? rows : [...rows.slice(0, LIST_MAX - 1), { label: `…${rows.length - LIST_MAX + 1} more in the app` }];
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
