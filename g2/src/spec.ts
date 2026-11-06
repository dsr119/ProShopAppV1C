// Spec sheets on the glasses: pure helpers, no SDK or network, so the tests
// can run them as-is.
//
// The sheets live in the ProshopSpeccy app (its own Supabase project). Each
// bowler's current sheet is a snapshot of named fields; numbers carry the text
// as it was entered ("4 15/32") and pitches a direction as well.
//
// The glasses show a sheet in three parts, like the paper one read top to
// bottom: the fingers (pitches, grips, holes, bridge), the span, the thumb.

export interface Stored {
  entered: string;
  n?: number;
  d?: number;
  dir?: string;
}

export type SnapValue = Stored | string | null | undefined;
export type Snapshot = Record<string, SnapValue>;

export type SpanMode = "full_span" | "cut_to_cut" | "cut_to_outer";
export const SPAN_MODES: SpanMode[] = ["full_span", "cut_to_cut", "cut_to_outer"];
export const SPAN_LABELS: Record<SpanMode, string> = { full_span: "Full", cut_to_cut: "Cut to Cut", cut_to_outer: "Cut to Outer" };
export const SPAN_SHORT: Record<SpanMode, string> = { full_span: "F", cut_to_cut: "C", cut_to_outer: "CTO" };

export type SpecPart = "fingers" | "span" | "thumb";

export interface SpecSheet {
  name: string;
  snapshot: Snapshot;
  /** When the sheet was last saved, YYYY-MM-DD. */
  saved?: string | null;
}

// ---------------------------------------------------------------------------
// The voice request
// ---------------------------------------------------------------------------

// Deepgram writes "spec sheet" a few ways: specs, spec's, speck, spec-sheet.
const SPEC_WORD = /\b(spec(?:'?s)?|specks?|specifications?)\b(?:[\s-]*sheets?)?/i;
const FILLER = new Set([
  "hey", "edith", "jarvis", "ok", "okay", "please", "can", "could", "would", "you", "i", "me", "us", "we", "let", "lets", "let's",
  "pull", "up", "bring", "show", "open", "get", "grab", "find", "look", "load", "display", "see", "view", "check", "give", "go",
  "the", "a", "an", "for", "of", "on", "to", "at", "is", "are", "what", "whats", "what's", "and", "my", "his", "her", "their",
  "spec", "specs", "speck", "specks", "sheet", "sheets", "specification", "specifications", "customer", "customers", "bowler",
  "bowlers", "called", "named", "name", "now", "real", "quick", "just",
]);

/**
 * The bowler named in "pull up the spec sheet for Joe Sutton", "show me Joe
 * Sutton's specs" or "Joe Sutton spec sheet". null when the words aren't
 * asking for a spec sheet; "" when they are but name nobody.
 */
export function specRequest(words: string): string | null {
  if (!SPEC_WORD.test(words)) return null;
  const name = words
    .replace(/[.,!?;:"“”]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/['’]s$/i, "").replace(/['’]$/, ""))
    .filter((w) => w && !FILLER.has(w.toLowerCase()))
    .join(" ");
  return name.trim();
}

/** Names to try in order: the whole name, then the last word, then the first. */
export function nameQueries(name: string): string[] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [words.join(" ")];
  if (words.length > 1) out.push(words[words.length - 1], words[0]);
  return [...new Set(out)];
}

/** "joe sutton" → "Joe Sutton", for messages. */
export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Sheets saved before each span type had its own fields kept every span in
 * the cut-to-cut fields, with span_type saying which kind it was. Read them in
 * today's shape (same as upgradeSnapshot in ProshopSpeccy).
 */
export function upgradeSnapshot(s: Snapshot): Snapshot {
  const type = s.span_type;
  if (s.middle_full_span !== undefined || (type !== "full_span" && type !== "cut_to_outer")) return s;
  const out = { ...s };
  for (const f of ["middle", "ring"]) {
    out[`${f}_${type}`] = out[`${f}_cut_to_cut`] ?? null;
    out[`${f}_cut_to_cut`] = null;
  }
  return out;
}

/** What a field shows: the number as entered, or the plain text. "" when blank. */
export function val(s: Snapshot, key: string): string {
  const v = s[key];
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  return (v.entered ?? "").trim();
}

export function dir(s: Snapshot, key: string): string {
  const v = s[key];
  return v && typeof v === "object" ? v.dir || "" : "";
}

/** The grip number beside a grip size, e.g. 25/32 → "7", 47/64 → "5.5". */
export function gripNumber(s: Snapshot, key: string): string {
  const v = s[key];
  if (!v || typeof v !== "object" || !v.n || !v.d) return "";
  const k = (v.n * 64) / v.d;
  if (k === 58) return "11";
  if (!Number.isInteger(k) || k < 34 || k > 56) return "";
  return String((k - 36) / 2);
}

const dash = (t: string) => t || "—";

export const noThumb = (s: Snapshot) => val(s, "thumb_mode") === "no_thumb";

/** The span types that have a measurement for either finger, in F, C, CTO order. */
export function spanModes(s: Snapshot): SpanMode[] {
  return SPAN_MODES.filter((m) => val(s, `middle_${m}`) || val(s, `ring_${m}`));
}

/** Where the span page opens: the type the sheet shows, if it has numbers. */
export function firstSpanMode(s: Snapshot): SpanMode | null {
  const modes = spanModes(s);
  const shown = val(s, "span_type") as SpanMode;
  return modes.includes(shown) ? shown : modes[0] ?? null;
}

/** The next (or, with step -1, the previous) span type that has numbers. */
export function nextSpanMode(s: Snapshot, mode: SpanMode | null, step = 1): SpanMode | null {
  const modes = spanModes(s);
  if (!modes.length) return null;
  const i = mode ? modes.indexOf(mode) : -1;
  return modes[(i + step + modes.length) % modes.length];
}

/** The parts this sheet has: no span or thumb on a no-thumb fit. */
export function specParts(s: Snapshot): SpecPart[] {
  return noThumb(s) ? ["fingers"] : ["fingers", "span", "thumb"];
}

// ---------------------------------------------------------------------------
// The three parts, as box contents. main.ts places the boxes.
// ---------------------------------------------------------------------------

const HAND: Record<string, string> = { right: "Right", left: "Left" };
const GRIP: Record<string, string> = { fingertip: "Fingertip", conventional: "Conventional", no_thumb: "No thumb", thumb_in: "" };
const STYLE: Record<string, string> = { one_handed: "", two_handed: "2-handed" };

/** "Joe Sutton · Right · Fingertip": the top line on every part. */
export function specTitle(sheet: SpecSheet): string {
  const s = sheet.snapshot;
  const bits = [sheet.name, HAND[val(s, "hand")], GRIP[val(s, "thumb_mode")], STYLE[val(s, "play_style")], val(s, "fit_label")];
  return bits.filter(Boolean).join(" · ");
}

/** A finger's pitch column: reverse on top, lateral with its arrow, forward below. */
export function fingerPitch(s: Snapshot, finger: "middle" | "ring"): string {
  const fr = val(s, `${finger}_fr_pitch`);
  const frDir = dir(s, `${finger}_fr_pitch`);
  const lat = val(s, `${finger}_lateral_pitch`);
  const latDir = dir(s, `${finger}_lateral_pitch`);
  const rev = fr && frDir === "reverse" ? fr : "";
  const fwd = fr && frDir !== "reverse" ? fr : "";
  const latText = !lat ? "—" : latDir === "left" ? `◀ ${lat}` : latDir === "right" ? `${lat} ▶` : lat;
  return ["REVERSE", dash(rev), "LATERAL", latText, "FORWARD", dash(fwd)].join("\n");
}

/** A finger hole: grip size over hole size when the fingers have grips. */
export function fingerHole(s: Snapshot, finger: "middle" | "ring"): string {
  const lines = [finger.toUpperCase()];
  const brand = val(s, `${finger}_grip_brand`);
  const inserts = val(s, `${finger}_inserts`);
  const oval = val(s, `${finger}_oval`);
  if (val(s, "finger_grips") === "grips") {
    const size = val(s, `${finger}_grip_size`);
    const num = gripNumber(s, `${finger}_grip_size`);
    lines.push(`Grip ${size ? (num ? `${size} (${num})` : size) : "—"}`);
    lines.push(`Hole ${dash(val(s, `${finger}_hole`))}`);
    lines.push(brand || "Turbo");
    if (inserts) lines.push(inserts);
  } else {
    lines.push(`Hole ${dash(val(s, `${finger}_hole`))}`);
    if (inserts) lines.push(inserts);
  }
  if (oval) lines.push(`Oval ${oval}`);
  return lines.join("\n");
}

/** Under the holes: grips or not, the grip type, and the bridge. */
export function fingerMiddle(s: Snapshot): string {
  const grips = val(s, "finger_grips");
  const type = val(s, "grip_type");
  const top = grips === "grips" ? ["Grips", type === "vaccu" ? "Vaccu" : type === "std" ? "STD" : ""] : grips === "no_grips" ? ["No grips"] : [];
  const line = top.filter(Boolean).join(" · ");
  return [line, `BRIDGE ${dash(val(s, "bridge"))}`].filter(Boolean).join("\n");
}

/** The selector over the span boxes: "F  [C]  CTO", only the types with numbers. */
export function spanSelector(s: Snapshot, mode: SpanMode | null): string {
  const modes = spanModes(s);
  if (!modes.length || !mode) return "No spans on this sheet";
  const chips = modes.map((m) => (m === mode ? `[${SPAN_SHORT[m]}]` : SPAN_SHORT[m])).join("   ");
  return `${chips}     ${SPAN_LABELS[mode]}`;
}

export function spanBox(s: Snapshot, finger: "middle" | "ring", mode: SpanMode | null): string {
  return `${finger.toUpperCase()}\n\n${mode ? dash(val(s, `${finger}_${mode}`)) : "—"}`;
}

/** The thumb's four pitch boxes: the amount goes in the box its direction names. */
export function thumbPitch(s: Snapshot): { forward: string; reverse: string; left: string; right: string } {
  const fr = val(s, "thumb_fr_pitch");
  const frDir = dir(s, "thumb_fr_pitch");
  const lat = val(s, "thumb_lateral_pitch");
  const latDir = dir(s, "thumb_lateral_pitch");
  return {
    forward: `FORWARD ▲\n${fr && frDir !== "reverse" ? fr : "—"}`,
    reverse: `REVERSE ▼\n${fr && frDir === "reverse" ? fr : "—"}`,
    left: `◀ LEFT\n${lat && latDir === "left" ? lat : lat && latDir !== "right" ? lat : "—"}`,
    right: `RIGHT ▶\n${lat && latDir === "right" ? lat : "—"}`,
  };
}

/** The thumb hole in the middle: slug size over hole size, or the insert. */
export function thumbHole(s: Snapshot): string {
  const lines = ["THUMB"];
  const slug = val(s, "thumb_od");
  const hole = val(s, "thumb_hole");
  if (slug) lines.push(`Slug ${slug}`);
  lines.push(`Hole ${dash(hole)}`);
  const oval = val(s, "thumb_oval");
  const angle = val(s, "thumb_oval_angle");
  if (oval) lines.push(`Oval ${oval}${angle ? ` @ ${angle}°` : ""}`);
  else if (angle) lines.push(`Angle ${angle}°`);
  return lines.join("\n");
}

export function thumbInsert(s: Snapshot): string {
  const type = val(s, "thumb_insert_type");
  const details = val(s, "thumb_system_details");
  return ["INSERT TYPE", dash(type), details].filter(Boolean).join("\n");
}

/** One line per bowler on the "which one?" list. */
export function pickLabel(name: string, phone: string | null, saved: string | null): string {
  const bits = [name];
  if (phone) bits.push(phone);
  if (saved) bits.push(`specs ${saved.slice(0, 10)}`);
  return bits.join(" · ").slice(0, 64);
}
