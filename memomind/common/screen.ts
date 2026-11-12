// Fitting text to the MemoMind screen. The phone app draws text in boxes and
// wraps it itself; these helpers only keep each box to the lines it can show,
// so nothing important falls off the bottom.
//
// Studio draws 17px text on 21px lines with 4px padding, about 8px a
// character. Real glasses fonts may differ a little: check on the glasses and
// adjust LINE / CHAR here, everything else follows.
export const LINE = 21;
export const CHAR = 8;
export const PAD = 8;

/** Lines that fit in a box this tall. */
export const linesIn = (height: number) => Math.max(1, Math.floor((height - PAD) / LINE));
/** Characters that fit across a box this wide. */
export const charsIn = (width: number) => Math.max(8, Math.floor((width - PAD) / CHAR));
/** Height of a box that shows n lines. */
export const heightFor = (n: number) => n * LINE + PAD;

/** One line, cut with … when it's too long. */
export function clipLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Word-wrap text to a width, keeping blank lines and line breaks. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

/**
 * Text that fits a box: wrapped, and if too long, the end kept (keepEnd, for
 * a conversation where the newest is at the bottom) or the start kept.
 */
export function fitBox(text: string, width: number, height: number, keepEnd = false): string {
  const cols = charsIn(width), rows = linesIn(height);
  const lines = wrap(text, cols);
  if (lines.length <= rows) return lines.join("\n");
  if (keepEnd) return ["…", ...lines.slice(lines.length - rows + 1)].join("\n");
  return [...lines.slice(0, rows - 1), clipLine(`${lines[rows - 1]} …`, cols)].join("\n");
}

/**
 * A list with a cursor: the selected row marked ▶, scrolled so it's on screen,
 * with ▲ / ▼ when there is more above or below.
 */
export function listText(rows: string[], selected: number, width: number, height: number): string {
  if (!rows.length) return "";
  const cols = charsIn(width) - 2, n = linesIn(height);
  const sel = Math.min(Math.max(selected, 0), rows.length - 1);
  if (rows.length <= n) return rows.map((r, i) => `${i === sel ? "▶" : "  "} ${clipLine(r, cols)}`).join("\n");
  // Room for the ▲ / ▼ lines.
  const room = Math.max(1, n - 2);
  const top = Math.min(Math.max(0, sel - Math.floor(room / 2)), rows.length - room);
  const shown = rows.slice(top, top + room).map((r, i) => `${top + i === sel ? "▶" : "  "} ${clipLine(r, cols)}`);
  return [
    top > 0 ? `   ▲ ${top} more` : "",
    ...shown,
    top + room < rows.length ? `   ▼ ${rows.length - top - room} more` : "",
  ].join("\n");
}

/** Move a cursor through n rows, wrapping round at the ends. */
export function step(selected: number, n: number, by: number): number {
  if (n <= 0) return 0;
  return (((selected + by) % n) + n) % n;
}
