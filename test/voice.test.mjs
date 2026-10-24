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
  flatline: { voice: "en_US-test-medium", speaker: 7, lengthScale: 1.2, effects: { pitch: 0.9, drive: 6, lowpass: 5000 } },
  dixie: { sameAs: "flatline" },
  plain: { voice: "en_US-test-medium", effects: {} },
  flat: { voice: "en_US-test-medium", flatten: true, effects: {} },
  paced: { voice: "en_US-test-medium", flatten: true, sentenceSilence: 0.4, effects: {} },
  slow: { voice: "en_US-test-medium", speaker: 3, lengthScale: 1.6, effects: {} },
  ghost: { sameAs: "nobody" },
  "bad name!": { voice: "x" },
  sneaky: { voice: "../../etc/passwd" },
}));
Object.assign(process.env, {
  NODE_ENV: "test", FAKE_LOG: LOG, FLATLINE_VOICE_QUEUE: "3",
  PIPER_BIN: join(HERE, "fixtures/fake-piper.mjs"), FFMPEG_BIN: join(HERE, "fixtures/fake-ffmpeg.mjs"),
  FLATLINE_VOICES_DIR: work, FLATLINE_VOICE_PRESETS: join(work, "presets.json"), FLATLINE_VOICE_MAX_CHARS: "200", FLATLINE_VOICE_MAX_PIPERS: "2",
});
const { buildFilter, mergeEffects, FORMATS, PADDING } = await import("../server/voice/chain.mjs");
const { flatten, segments, MAX_SEGMENTS } = await import("../server/voice/flatten.mjs");
const { createVoiceServer, loadPresets, cleanText, stopPipers, defaultPreset, piperKey, pausesOf, paceOf, withRequest, runningPipers } = await import("../server/voice/server.mjs");
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
  assert.deepEqual(Object.keys(loadPresets()).sort(), ["dixie", "flat", "flatline", "paced", "plain", "slow"]);
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
  // One piece at a time, each with the speaker; Piper adds no pause of its own.
  const lines = log.filter((c) => c.line).map((c) => c.line);
  assert.deepEqual(lines.slice(0, 2).map((l) => [l.text, l.speaker_id]), [["Listen up.", 7], ["Now.", 7]]);
  assert.equal(piper[piper.indexOf("--sentence_silence") + 1], "0");
  // ffmpeg joins them, with the pause after the first, then gives the sound and the edges.
  const ff = log.findLast((c) => c.ffmpeg).ffmpeg;
  const graph = ff[ff.indexOf("-filter_complex") + 1];
  assert.match(graph, /^\[0:a\]apad=pad_dur=0\.250\[p0\];\[1:a\]anull\[p1\];\[p0\]\[p1\]concat=n=2:v=0:a=1,asetrate=.*loudnorm=.*adelay=250:all=1,apad=pad_dur=0\.15\[out\]$/);
  assert.deepEqual(ff.slice(ff.indexOf("-map"), ff.indexOf("-map") + 2), ["-map", "[out]"]);
  assert.equal(ff.filter((a) => a === "-i").length, 2);
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
  assert.match(f, /adelay=250:all=1/, "a tune leaves the edges at their defaults");
});

test("the edges: lead-in, fade and tail by default; a preset or a tune that sets one sets them all", async () => {
  const ffOf = async (body) => {
    await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Edges.", format: "wav", ...body }) });
    const ff = (await calls()).findLast((c) => c.ffmpeg).ffmpeg;
    return ff[ff.indexOf("-af") + 1];
  };
  const dflt = await ffOf({});
  assert.match(dflt, /loudnorm=I=-16:TP=-1\.5:LRA=7,aresample=44100,areverse,afade=t=in:d=0\.04,areverse,adelay=250:all=1,apad=pad_dur=0\.15$/);
  const off = await ffOf({ tune: { leadIn: 0, fade: 0, tail: 0 } });
  assert.doesNotMatch(off, /adelay|areverse|apad|aresample=44100/);
  const some = await ffOf({ tune: { leadIn: 500 } });
  assert.match(some, /adelay=500:all=1/);
  assert.doesNotMatch(some, /apad|areverse/);
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
  assert.deepEqual([b.ok, b.presets.sort(), b.formats], [true, ["dixie", "flat", "flatline", "paced", "plain", "slow"], ["m4a", "mp3", "ogg", "wav"]]);
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
  assert.deepEqual((await s.presets()).sort(), ["dixie", "flat", "flatline", "paced", "plain", "slow"]);
  assert.equal(await s.health(), true);
});

test("createSpeaker: m4a by default, and the default preset (flatline)", async () => {
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

// --- flatten: a flat, final delivery (punctuation drives Piper's intonation) ------------------

for (const [said, shaped, why] of [
  ["Listen up, you have three things", "Listen up. You have three things.", "a clause comma becomes a full stop"],
  ["Good, that's one done, now get some sleep.", "Good. That's one done. Now get some sleep.", "several clauses"],
  ["First the dishes, then you rest.", "First the dishes. Then you rest.", "then"],
  ["Great! Do it now!", "Great. Do it now.", "\"!\" becomes \".\""],
  ["I said it once; I will not say it again", "I said it once. I will not say it again.", "a semicolon ends a clause"],
  ["Pick up milk, eggs and bread.", "Pick up milk, eggs and bread.", "a list keeps its commas"],
  ["Take your meds, drink some water, and check in before noon.", "Take your meds, drink some water, and check in before noon.", "a list of things to do"],
  ["That will be 1,200 points.", "That will be 1,200 points.", "a number"],
  ["Leave at nine, thirty.", "Leave at nine, thirty.", "a time in words"],
  ["Leave by 3.30.", "Leave by 3.30.", "a decimal point isn't a sentence end"],
  ["Are you done, or not?", "Are you done, or not?", "a question is left alone"],
  ["Done?! Then go.", "Done? Then go.", "\"?!\" stays a question"],
  ["Rest, and then you can go.", "Rest, and then you can go.", "never after \"and\""],
  ["ok, i will", "Ok. I will.", "capitalised, and \"i\" becomes \"I\""],
  ["   ", "", "nothing stays nothing"],
]) {
  test(`flatten: ${why}`, () => assert.equal(flatten(said), shaped));
}

test("a preset with flatten shapes the text before Piper; a request can turn it on or off", async () => {
  // The pieces Piper was given for the last request: the lines after the one before's ffmpeg.
  const lastLine = async () => {
    const all = await calls();
    const end = all.findLastIndex((c) => c.ffmpeg);
    const start = all.slice(0, end).findLastIndex((c) => c.ffmpeg);
    return all.slice(start + 1, end).filter((c) => c.line).map((c) => c.line.text).join(" ");
  };
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up, you have work!", preset: "flat", format: "wav" }) });
  assert.equal(await lastLine(), "Listen up. You have work.");
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up, you have work!", preset: "flat", format: "wav", flatten: false }) });
  assert.equal(await lastLine(), "Listen up, you have work!");
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up, you have work!", preset: "plain", format: "wav", flatten: true }) });
  assert.equal(await lastLine(), "Listen up. You have work.");
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up, you have work!", preset: "plain", format: "wav", flatten: "yes" }) });
  assert.equal(await lastLine(), "Listen up, you have work!");   // only true/false count
});

// --- the cast's presets: other names, the default, and sharing Pipers ------------------------------

test("an other name (sameAs) is the same preset; one that points nowhere is dropped", () => {
  const p = loadPresets();
  assert.equal(p.dixie, p.flatline);
  assert.equal("ghost" in p, false);
});

test("the default preset is flatline, else dixie, else the first", () => {
  assert.equal(defaultPreset({ plain: {}, dixie: {}, flatline: {} }), "flatline");
  assert.equal(defaultPreset({ plain: {}, dixie: {} }), "dixie");
  assert.equal(defaultPreset({ plain: {} }), "plain");
  return fetch(`${url}/`).then((r) => r.json()).then((b) => assert.equal(b.default, "flatline"));
});

test("dixie still speaks, as flatline, through flatline's own Piper", async () => {
  const before = (await calls()).filter((c) => c.piper).length;
  const r = await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Old name.", preset: "dixie", format: "wav" }) });
  assert.equal(r.status, 200);
  assert.equal((await calls()).findLast((c) => c.line).line.speaker_id, 7);
  assert.equal((await calls()).filter((c) => c.piper).length, before, "no new Piper for an other name");
});

test("presets with the same voice and pace share a Piper; the speaker is per line", () => {
  assert.equal(piperKey({ voice: "v", speaker: 1, lengthScale: 1.1 }), piperKey({ voice: "v", speaker: 9, lengthScale: 1.1 }));
  assert.notEqual(piperKey({ voice: "v", lengthScale: 1.1 }), piperKey({ voice: "v", lengthScale: 1.2 }));
  assert.notEqual(piperKey({ voice: "v" }), piperKey({ voice: "w" }));
});

test("at most FLATLINE_VOICE_MAX_PIPERS run: the least recently used one stops first", async () => {
  const say = (preset) => fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Count.", preset, format: "wav" }) });
  await say("flatline"); await say("plain"); await say("slow");
  assert.equal(runningPipers(), 2);
  const starts = () => calls().then((l) => l.filter((c) => c.piper).length);
  const n = await starts();
  await say("slow"); await say("plain");     // both running: no new Piper
  assert.equal(await starts(), n);
  await say("flatline");                      // stopped earlier: starts again
  assert.equal(await starts(), n + 1);
  assert.equal(runningPipers(), 2);
});

// --- the edges and the pauses -----------------------------------------------------------------

test("the chain: lead-in, fade and tail come after the level, and only as asked", () => {
  assert.equal(buildFilter({ leadIn: 250 }), "loudnorm=I=-16:TP=-1.5:LRA=7,aresample=44100,adelay=250:all=1");
  assert.equal(buildFilter({ fade: 40 }), "loudnorm=I=-16:TP=-1.5:LRA=7,aresample=44100,areverse,afade=t=in:d=0.04,areverse");
  assert.equal(buildFilter({ tail: 100 }), "loudnorm=I=-16:TP=-1.5:LRA=7,aresample=44100,apad=pad_dur=0.1");
  assert.equal(buildFilter({ ...PADDING }).split(",").slice(-5).join(","), "areverse,afade=t=in:d=0.04,areverse,adelay=250:all=1,apad=pad_dur=0.15");
  assert.match(buildFilter({ leadIn: 99999, tail: 99999, fade: 99999 }), /adelay=1000:all=1,apad=pad_dur=1$/);
  assert.match(buildFilter({ leadIn: 99999, fade: 99999 }), /afade=t=in:d=0\.2,/);
  assert.doesNotMatch(buildFilter({ leadIn: "250;rm", fade: "x", tail: null }), /adelay|afade|apad|aresample/);
  assert.deepEqual(mergeEffects({}, { leadIn: 100, tail: 50, fade: 10 }), { leadIn: 100, tail: 50, fade: 10 });
});

for (const [said, flat, expected, why] of [
  ["Listen up. You have three things. Call the dentist.", false, [["Listen up.", "stop"], ["You have three things.", "stop"], ["Call the dentist.", "stop"]], "sentences, a statement pause after each"],
  ["Is it done? Then go.", false, [["Is it done?", "question"], ["Then go.", "stop"]], "a question pause after a question"],
  ["Listen up, you have three things.", true, [["Listen up.", "clause"], ["You have three things.", "stop"]], "a comma flatten turned into a stop is a clause, a shorter pause"],
  ["Good, that's one done, now get some sleep.", true, [["Good.", "clause"], ["That's one done.", "clause"], ["Now get some sleep.", "stop"]], "several clauses"],
  ["Great! Do it now! Is that clear?", true, [["Great.", "stop"], ["Do it now.", "stop"], ["Is that clear?", "question"]], "\"!\" ends a sentence, a real stop"],
  ["Listen up, you have three things.", false, [["Listen up, you have three things.", "stop"]], "without flatten the comma stays inside the piece"],
  ["Ask Dr. Smith at 3.30 pm. Then call, e.g. Mr. Jones.", false, [["Ask Dr. Smith at 3.30 pm.", "stop"], ["Then call, e.g. Mr. Jones.", "stop"]], "abbreviations and decimals don't split"],
  ["Pick up milk, eggs and bread. Then rest.", true, [["Pick up milk, eggs and bread.", "stop"], ["Then rest.", "stop"]], "a list keeps its commas"],
  ["No full stop at the end", false, [["No full stop at the end", "stop"]], "no ending mark"],
  ["   ", true, [], "nothing is nothing"],
]) {
  test(`segments: ${why}`, () => assert.deepEqual(segments(said, flat).map((s) => [s.text, s.pause]), expected));
}

test("segments: flatten() and the joined segments say the same words", () => {
  const t = "Listen up, you have three things! Good, that's one done. Is it? Then go, now.";
  assert.equal(segments(t, true).map((s) => s.text).join(" "), flatten(t));
});

test("segments: no more than MAX_SEGMENTS, the rest kept in the last", () => {
  const t = Array.from({ length: 40 }, (_, i) => `Sentence ${i}.`).join(" ");
  const s = segments(t);
  assert.equal(s.length, MAX_SEGMENTS);
  assert.match(s.at(-1).text, /Sentence 23\. Sentence 24\..*Sentence 39\.$/);
});

test("pausesOf: from sentenceSilence, or set by the preset; clause is shorter than a statement", () => {
  assert.deepEqual(pausesOf({ sentenceSilence: 0.4 }), { stop: 0.4, clause: 0.2, question: 0.46 });
  assert.deepEqual(pausesOf({}), { stop: 0.25, clause: 0.125, question: 0.288 });
  assert.deepEqual(pausesOf({ sentenceSilence: 0.5, pauses: { clause: 0.1, question: 0.9 } }), { stop: 0.5, clause: 0.1, question: 0.9 });
  assert.deepEqual(pausesOf({ pauses: { stop: 99, clause: "x" } }), { stop: 3, clause: 1.5, question: 3 }, "at most 3 s (slow guidance can want long pauses)");
});

test("the pauses reach ffmpeg: a clause is shorter than a statement, a question longer", async () => {
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Listen up, you have work. Is it clear? Go.", preset: "paced", format: "wav" }) });
  const ff = (await calls()).findLast((c) => c.ffmpeg).ffmpeg;
  const graph = ff[ff.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[0:a\]apad=pad_dur=0\.200\[p0\];\[1:a\]apad=pad_dur=0\.400\[p1\];\[2:a\]apad=pad_dur=0\.460\[p2\];\[3:a\]anull\[p3\]/);
  const said = (await calls()).filter((c) => c.line).map((c) => c.line.text).slice(-4);
  assert.deepEqual(said, ["Listen up.", "You have work.", "Is it clear?", "Go."]);
});


// --- pace and pauses per request ---------------------------------------------------------

test("paceOf: 0.6..1.4 in steps of 0.05; anything that isn't a number is 1", () => {
  assert.equal(paceOf(0.75), 0.75);
  assert.equal(paceOf(0.77), 0.75);
  assert.equal(paceOf(0.2), 0.6);
  assert.equal(paceOf(9), 1.4);
  for (const v of [undefined, null, "0.5", NaN, Infinity, {}]) assert.equal(paceOf(v), 1, String(v));
});

test("withRequest: pace divides the preset's speed; pauses merge over its own; nothing asked is the preset", () => {
  const p = { voice: "v", lengthScale: 1.2, sentenceSilence: 0.4, effects: { pitch: 0.9 } };
  assert.equal(withRequest(p), p);
  assert.equal(withRequest(p, { pace: 1 }), p);
  const slow = withRequest(p, { pace: 0.75 });
  assert.equal(slow.lengthScale, 1.6);
  assert.deepEqual(slow.effects, p.effects);
  assert.equal(p.lengthScale, 1.2, "the preset itself is never changed");
  assert.equal(withRequest({ voice: "v" }, { pace: 0.6 }).lengthScale, 1.667, "a preset without a speed is 1");
  assert.equal(withRequest({ voice: "v", lengthScale: 1.8 }, { pace: 0.6 }).lengthScale, 2, "Piper's limit");
  const roomy = withRequest(p, { pauses: { stop: 1.2, question: 9 } });
  assert.deepEqual(pausesOf(roomy), { stop: 1.2, clause: 0.2, question: 3 });
  assert.deepEqual(pausesOf(withRequest(p, { pauses: { stop: "long" } })), pausesOf(p), "only numbers get in");
  assert.equal(withRequest(p, { pauses: [1, 2] }), p);
});

test("a request's pace starts a Piper at that speed; the same pace reuses it", async () => {
  const before = (await calls()).filter((c) => c.piper).length;
  for (const pace of [0.75, 0.76]) await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Slowly.", preset: "slow", format: "wav", pace }) });
  const starts = (await calls()).filter((c) => c.piper).slice(before);
  assert.equal(starts.length, 1, "0.76 rounds to 0.75: one Piper for both");
  const piper = starts[0].piper;
  assert.equal(piper[piper.indexOf("--length_scale") + 1], "2", "1.6 / 0.75, kept to Piper's 2");
});

test("a request's pauses go between the pieces", async () => {
  await fetch(`${url}/speak`, { method: "POST", body: JSON.stringify({ text: "Breathe in. Breathe out.", preset: "plain", format: "wav", pauses: { stop: 1.5 } }) });
  const ff = (await calls()).findLast((c) => c.ffmpeg).ffmpeg;
  assert.match(ff[ff.indexOf("-filter_complex") + 1], /^\[0:a\]apad=pad_dur=1\.500\[p0\]/);
});

test("createSpeaker: pace and pauses reach the service", async () => {
  const sent = [];
  const fake = async (u, init) => { sent.push(JSON.parse(init.body)); return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }); };
  const s = createSpeaker({ url: "http://voice.test", fetch: fake });
  await s.speak("Slowly.", { preset: "hoshi", pace: 0.75, pauses: { stop: 1.2 } });
  await s.speak("As it is.", { preset: "hoshi" });
  assert.deepEqual([sent[0].pace, sent[0].pauses], [0.75, { stop: 1.2 }]);
  assert.ok(!("pace" in sent[1]) && !("pauses" in sent[1]), "nothing asked: nothing sent");
});
