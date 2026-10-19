// Shared by the browser tests: a page server for the built package, a Chromium with a fake
// microphone, and a WAV generator for what that microphone "hears".
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".map": "application/json" };

/** A mono 16-bit WAV from [seconds, amplitude] segments: a 220 Hz tone where amplitude > 0. */
export function wav(segments, rate = 16000) {
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

/** Serve the repository (so pages can import /dist/browser/index.js); "/" is an empty page. */
export async function serve() {
  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    try {
      const body = path === "/" ? '<!doctype html><meta charset="utf-8"><title>flatline</title>' : await readFile(join(ROOT, path));
      res.writeHead(200, { "content-type": path === "/" ? "text/html" : TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * Chromium whose microphone plays `segments` once per recording (or Chrome's own beeps when
 * none are given), with the mic permission granted: without it, getUserMedia never answers.
 */
export async function micBrowser(segments) {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  if (segments) {
    const mic = join(await mkdtemp(join(tmpdir(), "flatline-")), "mic.wav");
    await writeFile(mic, wav(segments));
    args.push(`--use-file-for-fake-audio-capture=${mic}%noloop`);
  }
  const browser = await chromium.launch({ args, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const context = await browser.newContext({ permissions: ["microphone"] });
  return { browser, context };
}
