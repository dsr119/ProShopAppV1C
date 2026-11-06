// Network: the shop database (read-only, with the same publishable key the
// web app ships) and Jarvis, the alexa-work-order function, which holds every
// real key and does all the writing.
import type { Appointment, Place, Ticket } from "./shop";
import { addDays } from "./shop";
import { demoAppointments, demoBowlers, demoSheet, demoTickets, isDemo } from "./demo";
import { upgradeSnapshot, type Snapshot, type SpecSheet } from "./spec";

export const SUPABASE_URL = "https://ngghyuvykqqklztvvmld.supabase.co";
const SUPABASE_KEY = "sb_publishable_X-ZHYha1P8FPVL2rvAk-bA_CdXD8g-g";
const JARVIS_URL = `${SUPABASE_URL}/functions/v1/alexa-work-order`;

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Database said ${res.status}`);
  return res.json();
}

export async function loadAppointments(today: string, days = 3): Promise<Appointment[]> {
  if (isDemo()) return demoAppointments(today);
  return rest<Appointment[]>(
    "appointments?select=id,customer_name,phone,service,location,appt_date,appt_time,completed,notes,staff_member,paid" +
    `&deleted_at=is.null&appt_date=gte.${today}&appt_date=lte.${addDays(today, days)}` +
    "&order=appt_date.asc,appt_time.asc.nullslast&limit=200");
}

export async function loadTickets(): Promise<Ticket[]> {
  if (isDemo()) return demoTickets(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  return rest<Ticket[]>(
    "tickets?select=id,title,details,status,priority,due_date,location,assigned_to" +
    "&deleted_at=is.null&status=neq.done&order=due_date.asc.nullslast,submitted_at.asc&limit=200");
}

export interface JarvisReply {
  say?: string;
  done?: boolean;
  state?: string;
  heard?: string;
  ok?: boolean;
  error?: string;
}

async function jarvis(password: string, body: Record<string, unknown>): Promise<JarvisReply> {
  const res = await fetch(JARVIS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-alexa-secret": password },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as JarvisReply;
  if (!res.ok) throw new Error(out.error || `Jarvis said ${res.status}`);
  return out;
}

// Step 1: audio to words, nothing done yet.
export async function transcribe(password: string, audio: string): Promise<JarvisReply> {
  if (isDemo()) return { ok: true, heard: new URLSearchParams(location.search).get("heard")
    || "Hey EDITH, work order for Sample Bowler to plug his thumb on the NU Blue" };
  return jarvis(password, { audio, transcribe_only: true });
}

// Step 2: the confirmed words, carrying the conversation state.
export async function ask(password: string, text: string, state: string, location: Place): Promise<JarvisReply> {
  if (isDemo()) return { done: true, say: "Done: plug thumb on Sample Bowler's Storm NU Blue.", state: "" };
  return jarvis(password, { text, state, location: location === "Both" ? "Valley" : location });
}

// ---------------------------------------------------------------------------
// Spec sheets: read-only from ProshopSpeccy, its own Supabase project. Its
// shop is in open-link mode, so the publishable key its web app ships (in the
// GitHub Pages build) can read sheets; nothing here can change one.
// ---------------------------------------------------------------------------

export const SPECCY_URL = "https://bkvijjqhyiyfkuavmerh.supabase.co";
const SPECCY_KEY = "sb_publishable_Vba54XSri6vewRcBO8qDXQ_uinwbMOy";

async function speccy<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SPECCY_URL}/rest/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { apikey: SPECCY_KEY, Authorization: `Bearer ${SPECCY_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Spec sheets said ${res.status}`);
  return res.json();
}

export interface SpecBowler {
  id: string;
  name: string;
  phone: string | null;
  last_spec_at: string | null;
  has_specs: boolean;
}

/** Bowlers whose name has every word of the query, last names A to Z. */
export async function findBowlers(query: string): Promise<SpecBowler[]> {
  if (isDemo()) return demoBowlers(query);
  return speccy<SpecBowler[]>("rpc/search_customers", { p_query: query, p_limit: 20, p_offset: 0, p_sort: "last_name" });
}

/** A bowler's current digital sheet, or null when there isn't one. */
export async function loadSpecSheet(bowler: SpecBowler): Promise<SpecSheet | null> {
  if (isDemo()) return demoSheet(bowler);
  const fits = await speccy<Array<{ current_revision_id: string | null }>>(
    `fits?select=current_revision_id&customer_id=eq.${bowler.id}&is_primary=eq.true&limit=1`);
  const rev = fits[0]?.current_revision_id;
  if (!rev) return null;
  const rows = await speccy<Array<{ snapshot: Snapshot; created_at: string }>>(
    `fit_revisions?select=snapshot,created_at&id=eq.${rev}&limit=1`);
  if (!rows[0]) return null;
  return { name: bowler.name, snapshot: upgradeSnapshot(rows[0].snapshot), saved: rows[0].created_at.slice(0, 10) };
}
