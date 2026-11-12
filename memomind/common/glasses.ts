// The MemoMind glasses, as the apps see them: text boxes on a 600x350 screen,
// the glasses button and head movements as input, the glasses mic, and a
// small private key-value store in the phone app.
//
// Everything goes through the MemoMind Web SDK (Bridge 2.0). Its file is not
// in this repo (it comes with the MemoMind SDK under its own terms): run
// `node memomind/get-sdk.mjs` once to copy it in.
import { createGMPlugin } from "./vendor/gm-plugin-web-sdk.esm.js";
import { inputOf, type Input } from "./input.ts";

export type { Input };

export const W = 600;
export const H = 350;

/** One text box on the glasses. ids run 0-255; reusing an id updates that box. */
export interface Box {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  border?: number;
  radius?: number;
}

type GM = ReturnType<typeof createGMPlugin>;
type Ev = Record<string, unknown>;

export interface GlassesHandlers {
  onInput(input: Input): void;
  /** The glasses came back (or the app was resumed): draw the current page again. */
  onRedraw(): void;
  /** The app was hidden or stopped: stop the mic, timers that talk to the glasses. */
  onPause(): void;
}

export class Glasses {
  readonly gm: GM = createGMPlugin();
  audio = false;
  private lastPage: Box[] = [];

  async start(h: GlassesHandlers): Promise<void> {
    await this.gm.ready();
    const caps = (await this.gm.runtime.getCapabilities()) as { audio?: unknown; methods?: string[] } | null;
    this.audio = Boolean(caps?.audio && caps.methods?.includes("audio.openCapture") && caps.methods?.includes("audio.stopCapture"));
    try {
      await this.gm.device.subscribeEvents(["button", "imuGesture", "connection"]);
    } catch (err) {
      console.warn("No glasses input:", (err as Error).message);
    }
    this.gm.on("device.button", (d: Ev) => { const i = inputOf("button", d); if (i) h.onInput(i); });
    this.gm.on("device.imuGesture", (d: Ev) => { const i = inputOf("gesture", d); if (i) h.onInput(i); });
    this.gm.on("device.connection", (d: Ev) => { if (d.connected) h.onRedraw(); });
    this.gm.on("runtime.lifecycleChanged", (d: Ev) => {
      const s = String(d.state);
      if (s === "running") h.onRedraw();
      else if (s === "suspended" || s === "stopped") h.onPause();
    });
  }

  /** Clear the screen and draw these boxes. */
  async page(boxes: Box[]): Promise<void> {
    this.lastPage = boxes;
    await this.gm.display.rebuildPage(boxes.map((b) => ({ type: "text", ...normal(b) })));
  }

  /** Draw the last page again, after the glasses reconnect or the app resumes. */
  async redraw(): Promise<void> {
    if (this.lastPage.length) await this.page(this.lastPage);
  }

  /** Change one box in place (no flicker). */
  async update(box: Box): Promise<void> {
    this.lastPage = this.lastPage.map((b) => (b.id === box.id ? box : b));
    await this.gm.display.updateText(normal(box));
  }

  async get(key: string): Promise<string> {
    try {
      const r = (await this.gm.storage.get(key)) as { value?: unknown };
      return typeof r?.value === "string" ? r.value : "";
    } catch { return ""; }
  }

  async set(key: string, value: string): Promise<void> {
    try { await this.gm.storage.set(key, value); } catch (err) { console.warn("Couldn't save", key, (err as Error).message); }
  }
}

// The bridge wants every field, whole numbers, inside the screen, and text that isn't empty.
function normal(b: Box) {
  const x = clampInt(b.x, 0, W - 1), y = clampInt(b.y, 0, H - 1);
  return {
    id: clampInt(b.id, 0, 255), x, y,
    width: clampInt(b.width, 1, W - x), height: clampInt(b.height, 1, H - y),
    border: clampInt(b.border ?? 0, 0, 4), radius: clampInt(b.radius ?? 0, 0, 40),
    text: b.text && b.text.trim() ? b.text : " ",
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
