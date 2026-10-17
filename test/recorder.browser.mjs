// The recorder in a real Chromium, with a fake microphone that plays a generated recording:
// quiet, a tone standing in for speech, then quiet. It must stop by itself on the silence and
// hand back audio. Run with `npm run test:browser` (needs `npx playwright install chromium`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A mono 16-bit WAV: [seconds, amplitude] segments, a 220 Hz tone where amplitude > 0. */
function wav(segments, rate = 16000) {
  const n = segments.reduce((a, [s]) => a + Math.round(s * rate), 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  let i = 0;
  for (const [s, amp] of segments) {
    for (let k = 0; k < Math.round(s * rate); k++, i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * amp * 32767), 44 + i * 2);
  }
  return buf;
}

let server, browser, context, base;
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".map": "application/json" };

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "flatline-"));
  const mic = join(dir, "mic.wav");
  await writeFile(mic, wav([[1, 0], [1.2, 0.5], [4, 0]]));
  server = createServer(async (req, res) => {
    const path = req.url === "/" ? "/test/page.html" : req.url.split("?")[0];
    try {
      const body = path === "/test/page.html" ? '<!doctype html><meta charset="utf-8"><title>flatline</title>' : await readFile(join(ROOT, path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic}%noloop`, "--autoplay-policy=no-user-gesture-required"],
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  });
  // The fake prompt still needs the permission granted, or getUserMedia never answers.
  context = await browser.newContext({ permissions: ["microphone"] });
});
after(async () => { await browser?.close(); server?.close(); });

test("records, hears the speech, stops on the silence after it", { timeout: 60_000 }, async () => {
  const page = await context.newPage();
  await page.goto(base);
  const r = await page.evaluate(async () => {
    const { record, canRecord } = await import("/dist/browser/index.js");
    const states = [];
    let peak = 0;
    const rec = record({ silenceMs: 800, noSpeechMs: 5000, maxMs: 15000, onState: (s) => states.push(s), onLevel: (l) => { peak = Math.max(peak, l); } });
    const out = await rec.done;
    return { canRecord: canRecord(), ok: out.ok, reason: out.reason, code: out.code, size: out.ok ? out.audio.size : 0, type: out.type, ms: out.ms, states, peak };
  });
  assert.equal(r.canRecord, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, "silence");
  assert.ok(r.size > 1000, `audio size ${r.size}`);
  assert.match(r.type, /^audio\//);
  assert.ok(r.states.includes("speaking") && r.states.includes("trailing"), r.states.join());
  assert.ok(r.ms > 2000 && r.ms < 6000, `stopped after ${r.ms} ms`);
  assert.ok(r.peak > 0.05, `peak ${r.peak}`);
});

test("stop() keeps what was said; cancel() throws it away", { timeout: 60_000 }, async () => {
  const page = await context.newPage();
  await page.goto(base);
  const r = await page.evaluate(async () => {
    const { record } = await import("/dist/browser/index.js");
    const a = record(); await new Promise((x) => setTimeout(x, 700)); a.stop();
    const b = record(); await new Promise((x) => setTimeout(x, 300)); b.cancel();
    const [ra, rb] = [await a.done, await b.done];
    return { a: { ok: ra.ok, reason: ra.reason }, b: { ok: rb.ok, code: rb.code } };
  });
  assert.deepEqual(r, { a: { ok: true, reason: "stopped" }, b: { ok: false, code: "cancelled" } });
});
