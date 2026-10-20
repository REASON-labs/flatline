// The voice: the sound chain (pure), the voice service with stand-in piper and ffmpeg, and
// flatline/server's createSpeaker against that service.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(join(tmpdir(), "flatline-voice-"));
const LOG = join(work, "calls.log");
await writeFile(join(work, "presets.json"), JSON.stringify({
  dixie: { voice: "en_US-test-medium", speaker: 7, lengthScale: 1.2, effects: { pitch: 0.9, drive: 6, lowpass: 5000 } },
  plain: { voice: "en_US-test-medium", effects: {} },
  "bad name!": { voice: "x" },
  sneaky: { voice: "../../etc/passwd" },
}));
Object.assign(process.env, {
  NODE_ENV: "test", FAKE_LOG: LOG, FLATLINE_VOICE_QUEUE: "3",
  PIPER_BIN: join(HERE, "fixtures/fake-piper.mjs"), FFMPEG_BIN: join(HERE, "fixtures/fake-ffmpeg.mjs"),
  FLATLINE_VOICES_DIR: work, FLATLINE_VOICE_PRESETS: join(work, "presets.json"), FLATLINE_VOICE_MAX_CHARS: "200",
});
const { buildFilter, mergeEffects, FORMATS } = await import("../server/voice/chain.mjs");
const { createVoiceServer, loadPresets, cleanText, stopPipers } = await import("../server/voice/server.mjs");
const { createSpeaker } = await import("../dist/server/index.js");

let server, url;
before(async () => {
  server = createVoiceServer(loadPresets());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { stopPipers(); server.close(); });
const calls = async () => (await readFile(LOG, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- the sound chain ---------------------------------------------------------------------

test("the chain: pitch keeps the pace, each effect in order, the level last", () => {
  const f = buildFilter({ pitch: 0.9, highpass: 110, lowpass: 5200, presence: { freq: 1900, gain: 3 }, compress: { threshold: -22, ratio: 4 }, drive: 6, echo: { delay: 16, decay: 0.15 }, loudness: -16 }, 22050);
  assert.equal(f, [
    "asetrate=19845", "aresample=22050", "atempo=1.1111", "highpass=f=110", "lowpass=f=5200",
    "equalizer=f=1900:t=q:w=1:g=3", "acompressor=threshold=-22dB:ratio=4:attack=5:release=80:makeup=2",
    "volume=6dB", "asoftclip=type=tanh", "aecho=0.9:0.9:16:0.15", "loudnorm=I=-16:TP=-1.5:LRA=7",
  ].join(","));
});

test("the chain: nothing set is just the level; out-of-range numbers are clamped", () => {
  assert.equal(buildFilter({}), "loudnorm=I=-16:TP=-1.5:LRA=7");
  const f = buildFilter({ pitch: 0.1, lowpass: 99999, drive: 100, loudness: -100 });
  assert.match(f, /asetrate=15435/);       // pitch clamped to 0.7
  assert.match(f, /lowpass=f=12000/);
  assert.match(f, /volume=24dB/);
  assert.match(f, /loudnorm=I=-30/);
});

test("the chain: only numbers get in, whatever a preset or a tune says", () => {
  const f = buildFilter({ pitch: "0.8,volume=99", highpass: "1;rm -rf /", presence: { freq: "x", gain: 3 }, echo: { delay: "1:2", decay: 0.2 } });
  assert.doesNotMatch(f, /rm -rf|;|volume=99/);
  assert.doesNotMatch(f, /aecho/);         // a non-number delay switches the echo off
  assert.match(f, /equalizer=f=1800/);     // a bad freq falls back to its default
});

test("mergeEffects: a tune overrides known keys only, nested ones field by field", () => {
  const m = mergeEffects({ pitch: 0.9, echo: { delay: 16, decay: 0.15 } }, { pitch: 0.85, echo: { decay: 0.3 }, evil: "x" });
  assert.deepEqual(m, { pitch: 0.85, echo: { delay: 16, decay: 0.3 } });
});

test("formats and content types", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.type])), { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" });
});

test("cleanText and loadPresets: one line of text; bad preset names and voice paths dropped", () => {
  assert.equal(cleanText("  Hello\n\tthere\u0007 you "), "Hello there you");
  assert.deepEqual(Object.keys(loadPresets()).sort(), ["dixie", "plain"]);
});

// --- the service, with stand-ins ------------------------------------------------------------

test("speaks: Piper gets the preset's settings and speaker, ffmpeg the chain and format", async () => {
  const res = await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up.\nNow.", format: "ogg" }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/ogg");
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), "RIFF");
  const log = await calls();
  const piper = log.find((c) => c.piper).piper;
  assert.ok(piper.includes("--json-input") && piper[piper.indexOf("--length_scale") + 1] === "1.2", piper.join(" "));
  assert.ok(piper[piper.indexOf("--model") + 1].endsWith("en_US-test-medium.onnx"));
  const line = log.find((c) => c.line).line;
  assert.deepEqual([line.text, line.speaker_id], ["Listen up. Now.", 7]);
  const ff = log.findLast((c) => c.ffmpeg).ffmpeg;
  assert.match(ff[ff.indexOf("-af") + 1], /^asetrate=.*loudnorm/);
  assert.ok(ff.includes("libopus"));
});

test("one Piper per preset, reused", async () => {
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Again.", format: "wav" }) });
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Plain.", preset: "plain", format: "wav" }) });
  const starts = (await calls()).filter((c) => c.piper);
  assert.equal(starts.length, 2);
});

test("a tune changes the sound for one request", async () => {
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Tuned.", format: "wav", tune: { pitch: 0.8, drive: 2 } }) });
  const ff = (await calls()).findLast((c) => c.ffmpeg).ffmpeg;
  const f = ff[ff.indexOf("-af") + 1];
  assert.match(f, /asetrate=17640/);
  assert.match(f, /volume=2dB/);
});

test("refusals: empty, too long, unknown preset, unknown format, not JSON, wrong route", async () => {
  const post = (b) => fetch(`${url}/speak`, { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) });
  const j = async (r) => [r.status, (await r.json()).code];
  assert.deepEqual(await j(await post({ text: "  " })), [400, "empty"]);
  assert.deepEqual(await j(await post({ text: "x".repeat(201) })), [413, "too_long"]);
  assert.deepEqual(await j(await post({ text: "hi", preset: "nope" })), [404, "unknown_preset"]);
  assert.deepEqual(await j(await post({ text: "hi", format: "flac" })), [400, "bad_format"]);
  assert.deepEqual(await j(await post("not json")), [400, "bad_request"]);
  assert.deepEqual(await j(await fetch(`${url}/nope`)), [404, "not_found"]);
});

test("GET / lists presets and formats", async () => {
  const b = await (await fetch(`${url}/`)).json();
  assert.deepEqual([b.ok, b.presets.sort(), b.formats], [true, ["dixie", "plain"], ["m4a", "mp3", "ogg", "wav"]]);
});

test("one at a time, with a short queue: past it, \"busy\"", async () => {
  const post = () => fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "SLOW one", format: "wav" }) });
  const rs = await Promise.all([post(), post(), post(), post(), post()]);
  const statuses = rs.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 503, 503]);
});

test("if Piper dies, that request fails and the next one starts a new Piper", async () => {
  const bad = await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "CRASH", format: "wav" }) });
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).code, "failed");
  const good = await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Back.", format: "wav" }) });
  assert.equal(good.status, 200);
});

// --- createSpeaker -------------------------------------------------------------------------------

test("createSpeaker: audio back, with its type", async () => {
  const s = createSpeaker({ url });
  assert.equal(s.configured, true);
  const r = await s.speak("Do what I say.", { format: "mp3" });
  assert.equal(r.ok, true);
  assert.equal(r.contentType, "audio/mpeg");
  assert.ok(r.audio.byteLength > 44 && r.ms >= 0);
  assert.deepEqual((await s.presets()).sort(), ["dixie", "plain"]);
  assert.equal(await s.health(), true);
});

test("createSpeaker: m4a by default, and the dixie preset", async () => {
  const r = await createSpeaker({ url }).speak("Default.");
  assert.equal(r.contentType, "audio/mp4");
  const line = (await calls()).findLast((c) => c.line).line;
  assert.equal(line.speaker_id, 7);
});

test("createSpeaker: its codes", async () => {
  const s = createSpeaker({ url, maxChars: 10 });
  assert.equal((await s.speak("   ")).code, "empty");
  assert.equal((await s.speak("this is too long")).code, "too_long");
  assert.equal((await createSpeaker({ url }).speak("hi", { preset: "nope" })).code, "unknown_preset");
  assert.equal((await createSpeaker({ url: "" }).speak("hi")).code, "unavailable");
  assert.equal((await createSpeaker({ url: "http://127.0.0.1:9" }).speak("hi")).code, "unavailable");
  assert.equal(await createSpeaker({ url: "http://127.0.0.1:9" }).health(), false);
  assert.equal(await createSpeaker({ url: "http://127.0.0.1:9" }).presets(), null);
  assert.equal((await createSpeaker({ url, timeoutMs: 50 }).speak("SLOW and steady")).code, "timeout");
});

test("createSpeaker: an ffmpeg failure is a plain bad_response", async () => {
  process.env.FAKE_FFMPEG_FAIL = "1";
  try {
    const r = await createSpeaker({ url }).speak("Broken.");
    assert.deepEqual([r.ok, r.code], [false, "bad_response"]);
  } finally { delete process.env.FAKE_FFMPEG_FAIL; }
});
