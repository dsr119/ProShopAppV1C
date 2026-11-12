// The glasses button and head movements, as one kind of input.

/**
 * What the wearer did. The glasses button gives tap, double and hold (one
 * event when the hold is recognised; there is no release). Head movements
 * give up / down (raise, lower), left / right (turn), nod and shake.
 */
export type Input = "tap" | "double" | "hold" | "up" | "down" | "left" | "right" | "nod" | "shake";

const GESTURES: Record<string, Input> = {
  headRaise: "up", headLower: "down", left: "left", right: "right", nod: "nod", shake: "shake",
};
const BUTTONS: Record<string, Input> = { single: "tap", double: "double", long: "hold" };

/** The button and gesture event names, turned into one Input (or null for anything else). */
export function inputOf(kind: "button" | "gesture", data: Record<string, unknown>): Input | null {
  if (kind === "button") return BUTTONS[String(data.action)] ?? null;
  if (data.active === false) return null;
  return GESTURES[String(data.gesture)] ?? null;
}

