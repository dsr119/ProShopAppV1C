// Made-up rows for trying the app in the simulator without the shop's data:
// open http://localhost:5173/?demo
import type { Appointment, Ticket } from "./shop";
import { addDays } from "./shop";

export const isDemo = () => typeof location !== "undefined" && /[?&]demo\b/.test(location.search);

export function demoAppointments(today: string): Appointment[] {
  const a = (id: string, day: string, time: string | null, customer_name: string, service: string, location = "Valley"): Appointment =>
    ({ id, customer_name, phone: "555-555-0100", service, location, appt_date: day, appt_time: time, completed: false, notes: null });
  return [
    a("1", today, "16:00:00", "Sample Bowler", "Conventional drill, Storm Phaze 6"),
    a("2", today, "18:30:00", "Test Customer", "Fitting, new span"),
    a("3", addDays(today, 1), "17:00:00", "Another Bowler", "Plug and redrill"),
    a("4", addDays(today, 2), null, "Weekend Bowler", "Resurface", "South Side"),
  ];
}

export function demoTickets(today: string): Ticket[] {
  const t = (id: string, title: string, priority: string, due_date: string | null): Ticket =>
    ({ id, title, details: null, status: "new", priority, due_date, location: "Valley", assigned_to: null });
  return [
    t("a", "Sample Bowler: Plug thumb, NU Blue", "high", today),
    t("b", "Lane 7 ball return jams", "urgent", null),
    t("c", "Test Customer: Bake and resurface Identity", "normal", addDays(today, 4)),
  ];
}
