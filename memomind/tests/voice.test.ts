// The glasses send Opus; the transcriber wants PCM. Encode a tone the way the
// glasses would (16 kHz mono, 20 ms packets), decode it with opusToPcm, and
// check the tone comes back. Needs the SDK files: node memomind/get-sdk.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { opusToPcm, pcmBase64 } from "../common/voice.ts";

async function encodeTone(packets: number, hz = 440): Promise<{ data: Uint8Array; frameLengths: number[] }> {
  const m = await import("../common/vendor/opus-decoder.esm.js");
  const mod = await (m.default as () => { ready: Promise<any> })().ready;
  const enc = new mod.OpusScriptHandler(16000, 1, 2049);
  const input = mod._malloc(320 * 4);
  const output = mod._malloc(4000);
  const parts: Uint8Array[] = [];
  const frameLengths: number[] = [];
  try {
    for (let p = 0; p < packets; p += 1) {
      // Like opusscript: each PCM byte goes in its own uint16 slot.
      for (let k = 0; k < 320; k += 1) {
        const v = Math.round(8000 * Math.sin((2 * Math.PI * hz * (p * 320 + k)) / 16000)) & 0xffff;
        mod.HEAPU16[(input >> 1) + k * 2] = v & 255;
        mod.HEAPU16[(input >> 1) + k * 2 + 1] = v >> 8;
      }
      const n = enc._encode(input, 640, output, 320);
      assert.ok(n > 0, `encoder failed: ${n}`);
      parts.push(mod.HEAPU8.slice(output, output + n));
      frameLengths.push(n);
    }
  } finally {
    mod.OpusScriptHandler.destroy_handler(enc);
    mod._free(input);
    mod._free(output);
  }
  const data = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const part of parts) { data.set(part, at); at += part.length; }
  return { data, frameLengths };
}

test("a recorded tone decodes back to 16-bit PCM", async () => {
  const rec = await encodeTone(50);   // one second
  const pcm = await opusToPcm(rec);
  assert.equal(pcm.length, 50 * 320 * 2);
  const view = new DataView(pcm.buffer);
  // Skip the codec's start-up; then the level should be near the tone's (8000 peak = ~5657 RMS).
  let sum = 0, n = 0, crossings = 0, prev = 0;
  for (let i = 4000; i < pcm.length; i += 2) {
    const s = view.getInt16(i, true);
    sum += s * s; n += 1;
    if ((prev < 0 && s >= 0)) crossings += 1;
    prev = s;
  }
  const rms = Math.sqrt(sum / n);
  assert.ok(rms > 3500 && rms < 8000, `level ${rms}`);
  // 440 Hz over the remaining ~0.875 s: about 385 upward zero crossings.
  const seconds = n / 16000;
  assert.ok(Math.abs(crossings / seconds - 440) < 20, `pitch ${crossings / seconds} Hz`);
});

test("damaged recordings are refused", async () => {
  await assert.rejects(opusToPcm({ data: new Uint8Array(10), frameLengths: [5, 6] }));
  await assert.rejects(opusToPcm({ data: new Uint8Array(10), frameLengths: [0, 10] }));
});

test("base64 of PCM survives a long clip", () => {
  const pcm = new Uint8Array(15 * 32000).map((_, i) => i & 255);
  const back = Uint8Array.from(atob(pcmBase64(pcm)), (c) => c.charCodeAt(0));
  assert.deepEqual(back, pcm);
});
