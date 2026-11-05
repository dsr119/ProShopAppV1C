// Network: the shop database (read-only, with the same publishable key the
// web app ships) and Jarvis, the alexa-work-order function, which holds every
// real key and does all the writing.
import type { Appointment, Place, Ticket } from "./shop";
import { addDays } from "./shop";
import { demoAppointments, demoTickets, isDemo } from "./demo";

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
  if (isDemo()) return { ok: true, heard: "Hey EDITH, work order for Sample Bowler to plug his thumb on the NU Blue" };
  return jarvis(password, { audio, transcribe_only: true });
}

// Step 2: the confirmed words, carrying the conversation state.
export async function ask(password: string, text: string, state: string, location: Place): Promise<JarvisReply> {
  if (isDemo()) return { done: true, say: "Done: plug thumb on Sample Bowler's Storm NU Blue.", state: "" };
  return jarvis(password, { text, state, location: location === "Both" ? "Valley" : location });
}
