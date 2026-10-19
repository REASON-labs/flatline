// The recorder in a real Chromium. The fake microphone plays: 1 s of quiet, 1.2 s of a tone
// (standing in for speech), then quiet. Run with `npm run test:browser`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, micBrowser } from "./helpers.mjs";

let site, browser, context;
before(async () => {
  site = await serve();
  ({ browser, context } = await micBrowser([[1, 0], [1.2, 0.5], [4, 0]]));
});
after(async () => { await browser?.close(); site?.close(); });

/** A fresh page; `init` runs before the page's own scripts (to stub browser APIs). */
async function page(init, arg) {
  const p = await context.newPage();
  if (init) await p.addInitScript(init, arg);
  await p.goto(site.url);
  return p;
}

test("records, hears the speech, stops on the silence after it", { timeout: 60_000 }, async () => {
  const p = await page();
  const r = await p.evaluate(async () => {
    const { record, canRecord } = await import("/dist/browser/index.js");
    const states = [];
    let peak = 0;
    const rec = record({ silenceMs: 800, onState: (s) => states.push(s), onLevel: (l) => { peak = Math.max(peak, l); } });
    const out = await rec.done;
    return { canRecord: canRecord(), ok: out.ok, reason: out.reason, code: out.code, size: out.ok ? out.audio.size : 0, type: out.type, ms: out.ms, states, peak };
  });
  assert.equal(r.canRecord, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, "silence");
  assert.ok(r.size > 1000, `audio size ${r.size}`);
  assert.match(r.type, /^audio\/(webm|ogg|mp4)/);
  assert.ok(r.states.includes("speaking") && r.states.includes("trailing"), r.states.join());
  assert.ok(r.ms > 2000 && r.ms < 6000, `stopped after ${r.ms} ms`);
  assert.ok(r.peak > 0.05, `peak ${r.peak}`);
});

test("a hard limit stops it mid-answer", { timeout: 60_000 }, async () => {
  const p = await page();
  const r = await p.evaluate(async () => {
    const { record } = await import("/dist/browser/index.js");
    const out = await record({ maxMs: 1600 }).done;
    return { ok: out.ok, reason: out.reason, ms: out.ms };
  });
  assert.deepEqual([r.ok, r.reason], [true, "max"]);
  assert.ok(r.ms >= 1500 && r.ms < 3000, `stopped after ${r.ms} ms`);
});

test("answers are tuned for speech: 60 s at most, 1.5 s of quiet ends it", async () => {
  const p = await page();
  const d = await p.evaluate(async () => (await import("/dist/browser/index.js")).ANSWER_DEFAULTS);
  assert.deepEqual(d, { maxMs: 60000, silenceMs: 1500, noSpeechMs: 8000 });
});

test("stop() keeps what was said; cancel() throws it away", { timeout: 60_000 }, async () => {
  const p = await page();
  const r = await p.evaluate(async () => {
    const { record } = await import("/dist/browser/index.js");
    const a = record(); await new Promise((x) => setTimeout(x, 700)); a.stop();
    const b = record(); await new Promise((x) => setTimeout(x, 300)); b.cancel();
    const [ra, rb] = [await a.done, await b.done];
    return { a: { ok: ra.ok, reason: ra.reason }, b: { ok: rb.ok, code: rb.code } };
  });
  assert.deepEqual(r, { a: { ok: true, reason: "stopped" }, b: { ok: false, code: "cancelled" } });
});

// The mic's failures, each as a clear code (the page's getUserMedia stubbed to fail that way).
for (const [name, error, code] of [
  ["not allowed", "NotAllowedError", "denied"],
  ["blocked by the page's permissions", "SecurityError", "denied"],
  ["no microphone", "NotFoundError", "no_mic"],
  ["something else", "AbortError", "failed"],
]) {
  test(`mic ${name}: "${code}"`, async () => {
    const p = await page((err) => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("stubbed", err));
    }, error);
    const r = await p.evaluate(async () => (await (await import("/dist/browser/index.js")).record().done));
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.ok(r.error.length > 5);
  });
}

test('no microphone API at all (old browser, or not https): "unsupported"', async () => {
  const p = await page(() => { Object.defineProperty(navigator, "mediaDevices", { value: undefined }); });
  const r = await p.evaluate(async () => {
    const m = await import("/dist/browser/index.js");
    return { can: m.canRecord(), out: await m.record().done };
  });
  assert.equal(r.can, false);
  assert.deepEqual([r.out.ok, r.out.code], [false, "unsupported"]);
});
