// The glasses mic. MemoMind records Opus (16 kHz mono, 20 ms packets); the
// shop's transcriber (Deepgram, behind the Supabase functions) takes 16 kHz
// 16-bit PCM, the same audio the G2 sent. So the recording is decoded here,
// on the phone, and the servers don't change.
//
// The decoder is opusscript (libopus compiled to plain JavaScript, no WASM,
// which the MemoMind app doesn't allow), from the MemoMind SDK's examples.
import type { Glasses } from "./glasses";

/** The SDK's short-recording helper holds at most 15 seconds. */
export const MAX_MS = 14_000;
const SAMPLES_PER_PACKET = 320;   // 20 ms at 16 kHz
const MAX_PACKET = 3828;

export interface Recording {
  data: Uint8Array;
  frameLengths: number[];
}

interface RecordingSession {
  stop(): Promise<Recording & { durationMs?: number }>;
}

/** One press-to-talk recording from the glasses mic. */
export class Mic {
  private session: RecordingSession | null = null;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;

  private readonly glasses: Glasses;

  constructor(glasses: Glasses) { this.glasses = glasses; }

  get on() { return this.session !== null; }

  /** Open the mic. onLimit runs if the wearer talks past the limit, so the app can stop and send. */
  async start(onLimit: () => void): Promise<void> {
    if (this.session) return;
    const audio = this.glasses.gm.audio as unknown as {
      openRecording(o: Record<string, unknown>): Promise<RecordingSession>;
    };
    this.session = await audio.openRecording({ pickupMode: "frontFocus", noiseReduction: true, maxDurationMs: 15_000 });
    this.timer = setTimeout(onLimit, MAX_MS);
  }

  /** Close the mic and give back the audio as base64 PCM ("" when there was next to nothing). */
  async stop(): Promise<string> {
    const s = this.session;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.session = null;
    if (!s) return "";
    const rec = await s.stop();
    // Under a quarter second is a slip, not speech.
    if (rec.frameLengths.length < 13) return "";
    return pcmBase64(await opusToPcm(rec));
  }

  /** Drop a recording without using it (the app was hidden, the wearer backed out). */
  cancel(): void {
    const s = this.session;
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.session = null;
    s?.stop().catch(() => {});
  }
}

interface OpusModule {
  OpusScriptHandler: { new (rate: number, channels: number, app: number): { _decode(i: number, n: number, o: number): number }; destroy_handler(h: unknown): void };
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
}

let decoder: Promise<OpusModule> | null = null;

/** Opus packets to 16-bit little-endian PCM. */
export async function opusToPcm(rec: Recording): Promise<Uint8Array> {
  const { data, frameLengths } = rec;
  let total = 0;
  for (const n of frameLengths) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PACKET) throw new Error("The recording came back damaged.");
    total += n;
  }
  if (total !== data.length) throw new Error("The recording came back damaged.");
  decoder ??= import("./vendor/opus-decoder.esm.js").then((m) => (m.default as () => { ready: Promise<OpusModule> })().ready);
  const mod = await decoder;
  const handle = new mod.OpusScriptHandler(16000, 1, 2049);
  const input = mod._malloc(MAX_PACKET);
  // opusscript writes each PCM byte into its own uint16 slot: 4 heap bytes per sample.
  const output = mod._malloc(1920 * 4);
  const pcm = new Uint8Array(frameLengths.length * SAMPLES_PER_PACKET * 2);
  try {
    let offset = 0, at = 0;
    for (let i = 0; i < frameLengths.length; i += 1) {
      const n = frameLengths[i];
      mod.HEAPU8.set(data.subarray(offset, offset + n), input);
      const samples = handle._decode(input, n, output);
      offset += n;
      if (samples <= 0) { at += SAMPLES_PER_PACKET * 2; continue; }   // a bad packet becomes 20 ms of silence
      for (let k = 0; k < Math.min(samples, SAMPLES_PER_PACKET); k += 1) {
        const slot = (output >> 1) + k * 2;
        pcm[at + k * 2] = mod.HEAPU16[slot] & 255;
        pcm[at + k * 2 + 1] = mod.HEAPU16[slot + 1] & 255;
      }
      at += SAMPLES_PER_PACKET * 2;
      // Let the screen keep up on older phones.
      if (i % 50 === 49) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    mod.OpusScriptHandler.destroy_handler(handle);
    mod._free(input);
    mod._free(output);
  }
  return pcm;
}

export function pcmBase64(pcm: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < pcm.length; i += 0x8000) bin += String.fromCharCode(...pcm.subarray(i, i + 0x8000));
  return btoa(bin);
}
