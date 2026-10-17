// flatline/browser's pure parts: when to stop listening, which format to record, which voice
// Dixie uses, and the upload's request and answers (against a local server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SilenceDetector, rms, pickMimeType, chooseVoice, transcribeOnServer } from "../dist/browser/index.js";

/** Feed readings every 50 ms; return [reason, time it stopped]. */
function run(det, levels) {
  let t = 0;
  for (const l of levels) { const r = det.feed(l, t); if (r) return [r, t]; t += 50; }
  return [null, t];
}
const quiet = (ms) => Array(ms / 50).fill(0.003);
const talk = (ms) => Array(ms / 50).fill(0.2);

test("stops 1.5 s after speech ends", () => {
  const [why, at] = run(new SilenceDetector(), [...quiet(500), ...talk(1000), ...quiet(3000)]);
  assert.equal(why, "silence");
  assert.ok(at >= 1500 + 1500 && at <= 1500 + 1600, `stopped at ${at}`);
});

test("a pause shorter than silenceMs doesn't stop it", () => {
  const [why] = run(new SilenceDetector(), [...talk(600), ...quiet(1000), ...talk(600), ...quiet(500)]);
  assert.equal(why, null);
});

test("a click or bump isn't speech", () => {
  const det = new SilenceDetector({ noSpeechMs: 2000 });
  const [why] = run(det, [...quiet(300), 0.4, 0.4, ...quiet(3000)]);
  assert.equal(why, "no_speech");
});

test("a noisy room isn't speech: it learns the background", () => {
  const det = new SilenceDetector({ noSpeechMs: 3000 });
  const fan = Array(80).fill(0).map((_, i) => 0.02 + (i % 3) * 0.002);
  assert.equal(run(det, fan)[0], "no_speech");
});

test("nothing said: gives up after noSpeechMs", () => {
  const [why, at] = run(new SilenceDetector(), quiet(10000));
  assert.equal(why, "no_speech");
  assert.equal(at, 8000);
});

test("a hard limit, even mid-sentence", () => {
  const [why, at] = run(new SilenceDetector({ maxMs: 2000 }), talk(5000));
  assert.deepEqual([why, at], ["max", 2000]);
});

test("rms", () => {
  assert.equal(rms([]), 0);
  assert.equal(rms([0.5, -0.5, 0.5, -0.5]), 0.5);
});

test("pickMimeType: Opus where it can, mp4 on Safari, else let the browser choose", () => {
  assert.equal(pickMimeType((t) => t.startsWith("audio/webm")), "audio/webm;codecs=opus");
  assert.equal(pickMimeType((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(pickMimeType(() => false), "");
  assert.equal(pickMimeType(() => { throw new Error("old browser"); }), "");
});

test("chooseVoice: right language, better quality, on-device, no novelty voices", () => {
  const voices = [
    { name: "Zarvox", lang: "en-US", localService: true },
    { name: "Samantha", lang: "en-US", localService: true },
    { name: "Ava (Enhanced)", lang: "en-US", localService: true },
    { name: "Daniel", lang: "en-GB", localService: true },
    { name: "Thomas", lang: "fr-FR", localService: true },
  ];
  assert.equal(chooseVoice(voices, "en-US").name, "Ava (Enhanced)");
  assert.equal(chooseVoice(voices, "en-GB").name, "Daniel");
  assert.equal(chooseVoice(voices, "en").name, "Ava (Enhanced)");
  assert.equal(chooseVoice(voices, "fr-CA").name, "Thomas");
  assert.equal(chooseVoice(voices, "de-DE"), null);
  assert.equal(chooseVoice(voices, "en-US", "Daniel").name, "Daniel");
  assert.equal(chooseVoice([{ name: "Zarvox", lang: "en-US", localService: true }], "en-US"), null);
});

test("transcribeOnServer: posts the audio with its type, and reads the answer", async () => {
  let seen = null;
  const server = createServer(async (req, res) => {
    let n = 0; for await (const c of req) n += c.length;
    seen = { type: req.headers["content-type"], n, token: req.headers["x-session"] };
    res.writeHead(req.url === "/bad" ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/bad" ? { error: "No transcriber." } : { text: "hello" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const blob = new Blob([new Uint8Array(10)], { type: "audio/mp4" });
    assert.deepEqual(await transcribeOnServer(`${base}/ok`, blob, { headers: { "x-session": "s1" } }), { ok: true, text: "hello" });
    assert.deepEqual(seen, { type: "audio/mp4", n: 10, token: "s1" });
    assert.deepEqual(await transcribeOnServer(`${base}/bad`, blob), { ok: false, status: 503, error: "No transcriber." });
    const down = await transcribeOnServer("http://127.0.0.1:9/x", blob);
    assert.deepEqual([down.ok, down.status], [false, 0]);
  } finally { server.close(); }
});
