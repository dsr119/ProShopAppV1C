// Network: everything goes through the work-tickets Supabase function, which
// holds the Microsoft sign-in and the Deepgram key. The app holds only the
// password typed on the phone.
import type { Mail } from "./tickets";
import { demoMail, isDemo } from "./demo";

const FN_URL = "https://ngghyuvykqqklztvvmld.supabase.co/functions/v1/work-tickets";

export interface MailBox {
  me: string;
  mails: Mail[];
  checked: Record<number, string>;
}

async function call<T>(password: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tickets-secret": password },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error || `The ticket service said ${res.status}`);
  return out;
}

export async function loadMail(password: string): Promise<MailBox> {
  if (isDemo()) return demoMail(new Date());
  return call<MailBox>(password, { action: "mail", days: 30 });
}

export async function checkOff(password: string, id: number, undo = false): Promise<void> {
  if (isDemo()) return;
  await call(password, { action: "check", id, undo });
}

export async function transcribe(password: string, audio: string): Promise<string> {
  if (isDemo()) return "I'll be down after lunch to swap the power supply.";
  return (await call<{ heard: string }>(password, { action: "transcribe", audio })).heard;
}

export async function sendReply(password: string, messageId: string, text: string): Promise<void> {
  if (isDemo()) return;
  await call(password, { action: "reply", messageId, text });
}

export async function connectStart(password: string): Promise<{ code: string; url: string }> {
  return call(password, { action: "connect" });
}

export async function connectCheck(password: string): Promise<{ connected: boolean; say: string }> {
  return call(password, { action: "connect_check" });
}
