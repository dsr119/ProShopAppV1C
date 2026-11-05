// Hands-free: the mic stays open, and this cuts the stream into spoken
// phrases by loudness, so only actual speech is sent to be transcribed.
// Pure (no SDK, no network) so the tests can drive it with made-up audio.

const BYTES_PER_SECOND = 32000;          // 16 kHz, 16-bit, mono

export interface CatcherOptions {
  startChunks: number;    // loud chunks in a row that start a phrase
  silenceMs: number;      // quiet that ends it
  minMs: number;          // shorter than this is a cough or a bump
  maxMs: number;          // longest phrase before it's cut and sent anyway
  preRollChunks: number;  // quiet chunks kept from just before the start
  minLevel: number;       // RMS below this is never speech
  overFloor: number;      // speech is this many times the room's noise floor
}

const DEFAULTS: CatcherOptions = {
  startChunks: 2, silenceMs: 900, minMs: 500, maxMs: 15000, preRollChunks: 3, minLevel: 500, overFloor: 3,
};

// Loudness of one chunk of 16-bit little-endian PCM.
export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sum += s * s; }
  return Math.sqrt(sum / n);
}

const ms = (bytes: number) => (bytes / BYTES_PER_SECOND) * 1000;

export class PhraseCatcher {
  private o: CatcherOptions;
  private floor = 0;                 // running estimate of the room's noise
  private pre: Uint8Array[] = [];    // recent quiet chunks
  private loudRun: Uint8Array[] = [];
  private phrase: Uint8Array[] | null = null;
  private phraseBytes = 0;
  private quietBytes = 0;
  private leadBytes = 0;             // pre-roll at the front of the phrase

  constructor(options: Partial<CatcherOptions> = {}) {
    this.o = { ...DEFAULTS, ...options };
  }

  threshold(): number {
    return Math.max(this.o.minLevel, this.floor * this.o.overFloor);
  }

  reset() {
    this.pre = []; this.loudRun = []; this.phrase = null; this.phraseBytes = 0; this.quietBytes = 0; this.leadBytes = 0;
  }

  // Feed the next chunk. Returns a finished phrase (its chunks) or null.
  feed(pcm: Uint8Array): Uint8Array[] | null {
    const level = rms(pcm);
    const loud = level >= this.threshold();

    if (!this.phrase) {
      if (loud) {
        this.loudRun.push(pcm);
        if (this.loudRun.length >= this.o.startChunks) {
          this.phrase = [...this.pre, ...this.loudRun];
          this.leadBytes = this.pre.reduce((s, c) => s + c.length, 0);
          this.phraseBytes = this.phrase.reduce((s, c) => s + c.length, 0);
          this.quietBytes = 0;
          this.pre = []; this.loudRun = [];
        }
        return null;
      }
      // A lone loud chunk was a bump: it goes back into the pre-roll.
      for (const c of this.loudRun) this.keepPre(c);
      this.loudRun = [];
      this.keepPre(pcm);
      // Learn the room only while nobody is talking; first chunk sets it.
      this.floor = this.floor ? this.floor * 0.95 + level * 0.05 : level;
      return null;
    }

    this.phrase.push(pcm);
    this.phraseBytes += pcm.length;
    this.quietBytes = loud ? 0 : this.quietBytes + pcm.length;
    const ended = ms(this.quietBytes) >= this.o.silenceMs;
    if (!ended && ms(this.phraseBytes) < this.o.maxMs) return null;

    const done = this.phrase;
    const spoken = ms(this.phraseBytes - this.quietBytes - this.leadBytes);
    this.reset();
    return spoken >= this.o.minMs ? done : null;
  }

  private keepPre(c: Uint8Array) {
    this.pre.push(c);
    if (this.pre.length > this.o.preRollChunks) this.pre.shift();
  }
}

// "Hey EDITH, make a work order" -> { woke: true, rest: "Make a work order" }.
// Loose on purpose: speech-to-text writes the name a few ways. "Hey EDITH"
// counts anywhere in the phrase (chatter can come first); a bare "EDITH"
// only at the start. "Edit" and "Eddie" only count after "hey", so
// "edit Mike's ticket" doesn't wake it.
const HEY = /\b(?:hey|hi|hay|ok|okay|yo)[\s,.!-]+(?:edith|edit|edie|eddie)(?=\W|$)[\s,.!?-]*/i;
const BARE = /^\W*edith(?=\W|$)[\s,.!?-]*/i;

export function wakeSplit(transcript: string): { woke: boolean; rest: string } {
  const t = transcript || "";
  const m = HEY.exec(t) || BARE.exec(t);
  if (!m) return { woke: false, rest: "" };
  const rest = t.slice(m.index + m[0].length).trim();
  return { woke: true, rest: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "" };
}
