// Made-up helpdesk emails, in Lansweeper's exact format, for trying the app in the
// simulator without a mailbox: open http://localhost:5173/?demo
// No real tickets or names: this repo is public.
import type { Mail } from "./tickets";

export const isDemo = () => typeof location !== "undefined" && /[?&]demo\b/.test(location.search);

const ME = "dsmith@iu19.org";
const TEAM = [ME, "agent1@iu19.org", "agent2@iu19.org", "agent3@iu19.org"];
const FOOTER = "[newlogo.jpg]\n[Lansweeper.png]\nHelpdesk Solution\nPowered By Lansweeper";

interface Fake {
  id: number;
  title: string;
  hoursAgo: number;
  event: "opened" | "In Progress" | "Awaiting Reply" | "Closed";
  requester: string;
  note: string;
  team?: boolean;
}

export function helpdeskMail(f: Fake, now: Date): Mail {
  const date = new Date(now.getTime() - f.hoursAgo * 3600000);
  const line = f.event === "opened"
    ? `${f.requester} opened ticket ${f.id} under the type IT Support.\nWe would like to notify you and the other agents of your team that this ticket is currently unassigned.`
    : f.event === "Closed"
      ? `The state of ticket ${f.id} was set to Closed.`
      : `${f.requester} updated ticket ${f.id}. The state is currently set to ${f.event}.`;
  const email = `${f.requester.split(" ")[0].toLowerCase()}@example.org`;
  const text = [
    "### Everything above this line is added to your ticket ###",
    `From: ${f.requester}`, `User: ${f.requester}`, "Hi,", line,
    "To respond, answer to this email or log in to the helpdesk.",
    `From: ${f.requester} <${email}>`, `Date: ${date.toUTCString().replace("GMT", "(UTC +00:00)")}`,
    f.note, FOOTER,
  ].join("\n");
  return {
    messageId: `demo-${f.id}-${f.hoursAgo}`,
    subject: `${f.event === "opened" ? "" : "RE: "}[[TIC #${f.id}]] ${f.title}`,
    from: "IU19 Helpdesk <helpdesk@iu19.org>",
    to: f.team || f.event === "opened" ? TEAM : [ME],
    cc: [],
    date: date.toISOString(),
    text,
  };
}

export function demoMail(now: Date) {
  const fakes: Fake[] = [
    { id: 2101, title: "Laptop won't power on", hoursAgo: 1, event: "opened", requester: "Sample Teacher", note: "It clicks when I press the power button. Water got on the keyboard yesterday." },
    { id: 2102, title: "Room 12 projector", hoursAgo: 5, event: "opened", requester: "Test Person", note: "Projector says no signal from the laptop dock." },
    { id: 2090, title: "Printer offline", hoursAgo: 30, event: "opened", requester: "Office Staff", note: "Front office copier shows offline." },
    { id: 2090, title: "Printer offline", hoursAgo: 3, event: "In Progress", requester: "Office Staff", note: "Still offline this morning, can you come by?" },
    { id: 2085, title: "Voicemail reset", hoursAgo: 50, event: "In Progress", requester: "Another User", note: "The new PIN says invalid." },
    { id: 2085, title: "Voicemail reset", hoursAgo: 49, event: "Closed", requester: "Another User", note: "Ticket closed" },
    { id: 2088, title: "iPad app won't open", hoursAgo: 20, event: "Awaiting Reply", requester: "Speech Therapist", note: "Which iPad is it? The serial is on the back." },
    { id: 2095, title: "Wifi in room 207", hoursAgo: 8, event: "In Progress", requester: "Sample Teacher", note: "The dongle helped but it drops every hour." },
    { id: 1990, title: "Old unassigned ticket", hoursAgo: 24 * 9, event: "opened", requester: "Someone Else", note: "Probably picked up by a teammate." },
  ];
  return { me: ME, mails: fakes.map((f) => helpdeskMail(f, now)), checked: {} as Record<number, string> };
}
