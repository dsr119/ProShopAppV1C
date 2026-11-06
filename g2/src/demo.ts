// Made-up rows for trying the app in the simulator without the shop's data:
// open http://localhost:5173/?demo
// Add &heard=pull+up+the+spec+sheet+for+sample to make "what EDITH heard" that.
import type { Appointment, Ticket } from "./shop";
import { addDays } from "./shop";
import type { SpecBowler } from "./api";
import type { SpecSheet } from "./spec";

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

// Two made-up bowlers with spec sheets: say "spec sheet for Sample Bowler".
const DEMO_BOWLERS: SpecBowler[] = [
  { id: "s1", name: "Sample Bowler", phone: "555-555-0100", last_spec_at: "2026-10-30", has_specs: true },
  { id: "s2", name: "Sample Lefty", phone: "555-555-0101", last_spec_at: "2026-09-12", has_specs: true },
];

export function demoBowlers(query: string): SpecBowler[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return DEMO_BOWLERS.filter((b) => words.every((w) => b.name.toLowerCase().includes(w)));
}

const n = (entered: string, dir?: string) => ({ entered, ...(dir ? { dir } : {}) });

export function demoSheet(b: SpecBowler): SpecSheet {
  const lefty = b.id === "s2";
  return {
    name: b.name,
    saved: b.last_spec_at,
    snapshot: {
      hand: lefty ? "left" : "right", thumb_mode: "fingertip", play_style: "one_handed",
      finger_grips: "grips", grip_type: "vaccu",
      middle_grip_brand: "Turbo", ring_grip_brand: "Turbo", middle_inserts: "Oval No Mesh", ring_inserts: "Oval No Mesh",
      middle_grip_size: { entered: "25/32", n: 25, d: 32 }, ring_grip_size: { entered: "47/64", n: 47, d: 64 },
      middle_hole: n("31/32"), ring_hole: n("31/32"),
      middle_fr_pitch: n("5/16", "reverse"), middle_lateral_pitch: n("5/16", "left"),
      ring_fr_pitch: n("5/16", "reverse"), ring_lateral_pitch: n("7/16", "right"),
      bridge: n("1/4"),
      span_type: "cut_to_cut",
      middle_cut_to_cut: n("4 15/32"), ring_cut_to_cut: n("4 9/16"),
      middle_full_span: n("5 1/8"), ring_full_span: n("5 3/16"),
      middle_cut_to_outer: lefty ? n("4 13/16") : null, ring_cut_to_outer: lefty ? n("4 7/8") : null,
      thumb_od: n("1 1/4"), thumb_hole: null, thumb_insert_type: "Thumb Slug",
      thumb_fr_pitch: n("1/8", "forward"), thumb_lateral_pitch: n("1/8", "right"),
    },
  };
}
