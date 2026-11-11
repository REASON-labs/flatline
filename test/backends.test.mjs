// Backends in order (0.8): stand-in services on local ports, the real fetch. Which failures move
// on to the next backend, what each kind of request looks like, and that a key never shows up
// in an error.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTranscriber, createSpeaker, splitText, joinWavs } from "../dist/server/index.js";

const KEY = "test-key-0123456789-not-real";
const DEAD = "http://127.0.0.1:9";
const servers = [];
after(() => servers.forEach((s) => s.close()));

/** A stand-in service: `answer(req, body)` returns [status, body, contentType?]; every request is kept in `seen`. */
async function standIn(answer) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = { method: req.method, path: req.url, headers: req.headers, body, text: body.toString("latin1") };
    seen.push(r);
    const [status, out, type = "application/json"] = await answer(r);
    res.writeHead(status, { "content-type": type });
    res.end(Buffer.isBuffer(out) ? out : typeof out === "string" ? out : JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A mono 16-bit WAV of `n` samples, each of value `v`. */
function wav(n, v = 1000, rate = 24000) {
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(v, 44 + i * 2);
  return b;
}

const audio = new Uint8Array([1, 2, 3, 4]);
const says = (text) => () => [200, { text }];
const whisper = (url) => ({ kind: "whispercpp", url });
const cloud = (url, more = {}) => ({ kind: "openai", url: `${url}/v1`, model: "big-model", ...more });

// --- speech to text ------------------------------------------------------------------------------

test("stt: the first backend that works answers, and the result says which", async () => {
  const a = await standIn(says("from the first"));
  const b = await standIn(says("from the second"));
  const r = await createTranscriber({ backends: [whisper(a.url), cloud(b.url)] }).transcribe(audio, "audio/mp4");
  assert.equal(r.text, "from the first");
  assert.deepEqual(r.via, { index: 0, kind: "whispercpp" });
  assert.equal(b.seen.length, 0);
  const swapped = await createTranscriber({ backends: [cloud(b.url), whisper(a.url)] }).transcribe(audio, "audio/mp4");
  assert.equal(swapped.text, "from the second");
  assert.deepEqual(swapped.via, { index: 0, kind: "openai" });
});

test("stt: moves on for 429, 503, a timeout and a backend that isn't there", async () => {
  const second = await standIn(says("made it"));
  const busy = await standIn(() => [429, { error: { message: "Rate limit reached." } }]);
  const broken = await standIn(() => [503, { error: "overloaded" }]);
  const slow = await standIn(async () => { await new Promise((r) => setTimeout(r, 400)); return [200, { text: "too late" }]; });
  for (const first of [cloud(busy.url), whisper(busy.url), cloud(broken.url), whisper(broken.url), cloud(slow.url, { timeoutMs: 80 }), cloud(DEAD), whisper(DEAD)]) {
    const r = await createTranscriber({ backends: [first, cloud(second.url)] }).transcribe(audio, "audio/webm");
    assert.equal(r.ok, true, JSON.stringify(first));
    assert.equal(r.text, "made it");
    assert.deepEqual(r.via, { index: 1, kind: "openai" });
  }
  assert.equal(second.seen.length, 7);
});

test("stt: a wait that runs out halfway through the answer is a timeout too", async () => {
  const second = await standIn(says("made it"));
  const stalls = createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.write('{"text":"half'); });
  await new Promise((r) => stalls.listen(0, "127.0.0.1", r));
  servers.push(stalls);
  const url = `http://127.0.0.1:${stalls.address().port}`;
  const alone = await createTranscriber({ url, timeoutMs: 80 }).transcribe(audio);
  assert.equal(alone.code, "timeout");
  const r = await createTranscriber({ backends: [whisper(url), cloud(second.url)], timeoutMs: 80 }).transcribe(audio);
  assert.deepEqual([r.ok, r.via.index], [true, 1]);
  stalls.closeAllConnections();
});

test("stt: never moves on for empty or oversized audio, a 400 or a refused key", async () => {
  const second = await standIn(says("should not be asked"));
  const bad = await standIn(() => [400, { error: { message: "file must be one of: flac mp3 mp4 ogg wav webm" } }]);
  const refused = await standIn(() => [401, { error: { message: "Invalid API Key" } }]);
  const t = createTranscriber({ backends: [cloud(bad.url), whisper(second.url)], maxBytes: 3 });
  assert.equal((await t.transcribe(new Uint8Array())).code, "empty");
  assert.equal((await t.transcribe(audio)).code, "too_large");
  assert.equal(bad.seen.length, 0);

  const r = await createTranscriber({ backends: [cloud(bad.url), whisper(second.url)] }).transcribe(audio, "audio/mp4");
  assert.deepEqual([r.ok, r.code], [false, "bad_response"]);
  assert.match(r.error, /answered 400: file must be one of/);
  assert.deepEqual(r.via, { index: 0, kind: "openai" });

  const k = await createTranscriber({ backends: [cloud(refused.url, { apiKey: KEY }), whisper(second.url)] }).transcribe(audio, "audio/mp4");
  assert.equal(k.code, "bad_response");
  assert.match(k.error, /refused the key \(401\)/);

  const w = await createTranscriber({ backends: [whisper(bad.url), cloud(second.url)] }).transcribe(audio, "audio/mp4");
  assert.equal(w.code, "bad_response");
  assert.equal(second.seen.length, 0);
});

test("stt: when every backend fails, the last one's reason comes back", async () => {
  const busy = await standIn(() => [429, {}]);
  const r = await createTranscriber({ backends: [whisper(DEAD), cloud(busy.url)] }).transcribe(audio, "audio/mp4");
  assert.deepEqual([r.ok, r.code], [false, "busy"]);
  assert.deepEqual(r.via, { index: 1, kind: "openai" });
});

test("stt: the \"openai\" request: its address, the key as a Bearer token, the model and the fields", async () => {
  const s = await standIn(says(" [Music] Call the vet (cough) on Friday. "));
  const r = await createTranscriber({ backends: [{ ...cloud(s.url, { apiKey: KEY }), url: `${s.url}/v1/` }], language: "en" }).transcribe(audio, "audio/webm;codecs=opus");
  assert.equal(r.text, "Call the vet on Friday.");
  const q = s.seen[0];
  assert.equal(`${q.method} ${q.path}`, "POST /v1/audio/transcriptions");
  assert.equal(q.headers.authorization, `Bearer ${KEY}`);
  assert.match(q.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(q.text, /name="file"; filename="audio\.webm"\r\nContent-Type: audio\/webm;codecs=opus\r\n\r\n\x01\x02\x03\x04\r\n/);
  assert.match(q.text, /name="model"\r\n\r\nbig-model\r\n/);
  assert.match(q.text, /name="response_format"\r\n\r\njson\r\n/);
  assert.match(q.text, /name="temperature"\r\n\r\n0\r\n/);
  assert.match(q.text, /name="language"\r\n\r\nen\r\n/);
  assert.ok(!q.text.includes(KEY));
});

test("stt: no key, no Authorization header; \"auto\" is whisper.cpp's word and isn't sent to an \"openai\" backend", async () => {
  const s = await standIn(says("ok"));
  await createTranscriber({ backends: [cloud(s.url)], language: "auto" }).transcribe(audio, "audio/mp4");
  assert.equal(s.seen[0].headers.authorization, undefined);
  assert.ok(!s.seen[0].text.includes('name="language"'));
  await createTranscriber({ backends: [whisper(s.url)], language: "auto" }).transcribe(audio, "audio/mp4");
  assert.equal(s.seen[1].path, "/inference");
  assert.match(s.seen[1].text, /name="language"\r\n\r\nauto\r\n/);
  assert.ok(!s.seen[1].text.includes('name="model"'));
});

test("stt: a key is never in an error, whatever the service says back", async () => {
  const echo400 = await standIn((q) => [400, { error: { message: `Bad request from ${q.headers.authorization}` } }]);
  const echo401 = await standIn(() => [401, { error: { message: `Incorrect API key provided: ${KEY}` } }]);
  const echo500 = await standIn(() => [500, { error: `key ${KEY} failed` }]);
  const noJson = await standIn(() => [502, `<html>${KEY}</html>`, "text/html"]);
  for (const url of [echo400.url, echo401.url, echo500.url, noJson.url, DEAD]) {
    const r = await createTranscriber({ backends: [cloud(url, { apiKey: KEY })] }).transcribe(audio, "audio/mp4");
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(KEY), JSON.stringify(r));
  }
  const r = await createTranscriber({ backends: [cloud(echo400.url, { apiKey: KEY })] }).transcribe(audio, "audio/mp4");
  assert.match(r.error, /Bearer \[key\]/);
});

test("stt: a 0.7-style caller is one whisper.cpp backend, and says so", async () => {
  const s = await standIn(says("as before"));
  const t = createTranscriber({ url: `${s.url}/` });
  const r = await t.transcribe(audio, "audio/mp4");
  assert.deepEqual([r.ok, r.text, r.via], [true, "as before", { index: 0, kind: "whispercpp" }]);
  assert.equal(s.seen[0].path, "/inference");
  assert.equal(s.seen[0].headers.authorization, undefined);
  const down = await createTranscriber({ url: DEAD }).transcribe(audio);
  assert.deepEqual([down.code, down.via], ["unavailable", { index: 0, kind: "whispercpp" }]);
  assert.equal((await createTranscriber({ url: undefined }).transcribe(audio)).via, undefined);
});

test("stt: configured and healthy if any backend is; one without an address is left out", async () => {
  const up = await standIn((q) => q.path === "/v1/models" ? [200, { data: [] }] : [404, {}]);
  const refused = await standIn(() => [401, {}]);
  assert.equal(createTranscriber({ backends: [] }).configured, false);
  assert.equal(createTranscriber({ backends: [whisper(""), { kind: "openai", url: " ", model: "m" }] }).configured, false);
  assert.equal(createTranscriber({ backends: [whisper(undefined), cloud(up.url)] }).configured, true);
  assert.equal(await createTranscriber({ backends: [whisper(DEAD), cloud(up.url, { apiKey: KEY })] }).health(), true);
  assert.equal(up.seen.at(-1).headers.authorization, `Bearer ${KEY}`);
  assert.equal(await createTranscriber({ backends: [whisper(DEAD), cloud(refused.url)] }).health(), false);
  assert.equal(await createTranscriber({ backends: [whisper(DEAD)] }).health(), false);
  // The index is the place in the list as the app wrote it.
  const s = await standIn(says("second"));
  const r = await createTranscriber({ backends: [whisper(""), whisper(s.url)] }).transcribe(audio);
  assert.deepEqual(r.via, { index: 1, kind: "whispercpp" });
  // `backends` wins over `url`.
  const both = await createTranscriber({ url: DEAD, backends: [whisper(s.url)] }).transcribe(audio);
  assert.equal(both.ok, true);
});

// --- text to speech ------------------------------------------------------------------------------

const speech = (n = 10) => () => [200, wav(n), "audio/wav"];
const local = (url) => ({ kind: "flatline", url });
const voice = (url, more = {}) => ({ kind: "openai", url: `${url}/v1`, model: "talker", voice: "sam", ...more });
const flatlineOk = (q) => q.method === "GET" ? [200, { presets: ["flatline", "plain"] }] : [200, Buffer.from("ID3 audio"), "audio/mpeg"];
const dataOf = (b) => Buffer.from(b).subarray(44);

test("splitText: at sentence ends, then commas, then spaces, then mid-word; never over the limit; nothing lost", () => {
  assert.deepEqual(splitText("Short one.", 200), ["Short one."]);
  assert.deepEqual(splitText("  ", 200), []);
  assert.deepEqual(splitText("One two three. Four five six. Seven.", 30), ["One two three. Four five six.", "Seven."]);
  assert.deepEqual(splitText("Is it time? Yes! It is... \"Go.\" Then rest.", 12), ["Is it time?", "Yes!", "It is...", "\"Go.\"", "Then rest."]);
  assert.deepEqual(splitText("first the kettle, then the cups, then the tea", 20), ["first the kettle,", "then the cups,", "then the tea"]);
  assert.deepEqual(splitText("no punctuation here at all just words", 12), ["no", "punctuation", "here at all", "just words"]);
  assert.deepEqual(splitText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(splitText("Version 2.5 is out. Get it.", 20), ["Version 2.5 is out.", "Get it."]);
  // Exactly at the limit is one piece; one over is two.
  assert.deepEqual(splitText("a".repeat(200)), ["a".repeat(200)]);
  assert.equal(splitText("a".repeat(201)).length, 2);
  // Not between the halves of an emoji.
  assert.deepEqual(splitText("ab\u{1F600}cd", 3), ["ab", "\u{1F600}c", "d"]);
  const long = "Good morning. Here is your day, one thing at a time; nothing is urgent. ".repeat(12).trim();
  for (const max of [1, 7, 50, 200]) {
    const parts = splitText(long, max);
    assert.ok(parts.every((p) => p.length > 0 && p.length <= max), `max ${max}`);
    assert.equal(parts.join(" ").replace(/\s/g, ""), long.replace(/\s/g, ""));
  }
  assert.ok(splitText(long, 200).every((p) => /[.;,]$/.test(p)));
});

test("joinWavs: the samples in order under one header; not WAV, or different kinds, is null", () => {
  const joined = joinWavs([wav(3, 1), wav(2, 2), wav(4, 3)]);
  const b = Buffer.from(joined);
  assert.equal(b.length, 44 + 18);
  assert.equal(b.toString("latin1", 0, 4) + b.toString("latin1", 8, 16), "RIFFWAVEfmt ");
  assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.readUInt32LE(24), 24000);
  assert.equal(b.readUInt32LE(40), 18);
  assert.deepEqual([...new Int16Array(new Uint8Array(dataOf(b)).buffer)], [1, 1, 1, 2, 2, 3, 3, 3, 3]);
  assert.equal(joinWavs([wav(3), Buffer.from("not a wav at all")]), null);
  assert.equal(joinWavs([wav(3, 1, 24000), wav(3, 1, 16000)]), null);
  assert.equal(joinWavs([]), null);
  // A streamed WAV that doesn't know its length, and one with another chunk before the samples.
  const streamed = wav(5, 7); streamed.writeUInt32LE(0xffffffff, 4); streamed.writeUInt32LE(0xffffffff, 40);
  const w = wav(2, 9);
  const listed = Buffer.concat([w.subarray(0, 36), Buffer.from("LIST\x03\x00\x00\x00abc\x00", "latin1"), w.subarray(36)]);
  const both = Buffer.from(joinWavs([streamed, listed]));
  assert.equal(both.readUInt32LE(40), 14);
  assert.deepEqual([...new Int16Array(new Uint8Array(dataOf(both)).buffer)], [7, 7, 7, 7, 7, 9, 9]);
});

test("voice: the \"openai\" request: its address, the key, the model, the voice, WAV asked for", async () => {
  const s = await standIn(speech(6));
  const r = await createSpeaker({ backends: [voice(s.url, { apiKey: KEY })] }).speak("  Good   morning. ", { preset: "kestrel", format: "wav", pace: 0.75, pauses: { stop: 1 }, tune: { pitch: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual([r.contentType, r.format, r.note, r.via], ["audio/wav", "wav", undefined, { index: 0, kind: "openai" }]);
  assert.equal(r.audio.byteLength, 44 + 12);
  const q = s.seen[0];
  assert.equal(`${q.method} ${q.path}`, "POST /v1/audio/speech");
  assert.equal(q.headers.authorization, `Bearer ${KEY}`);
  assert.equal(q.headers["content-type"], "application/json");
  // The preset, tune, pace and pauses are the flatline service's: none of them is sent.
  assert.deepEqual(JSON.parse(q.text), { model: "talker", input: "Good morning.", voice: "sam", response_format: "wav" });
});

test("voice: asked for m4a, mp3 or ogg, an \"openai\" backend answers WAV and says so", async () => {
  const s = await standIn(speech());
  const sp = createSpeaker({ backends: [voice(s.url)] });
  for (const format of [undefined, "m4a", "mp3", "ogg"]) {
    const r = await sp.speak("Hello.", format ? { format } : {});
    assert.deepEqual([r.ok, r.format, r.contentType], [true, "wav", "audio/wav"]);
    assert.equal(r.note, `Asked for ${format ?? "m4a"}; this backend answers WAV.`);
    assert.equal(JSON.parse(s.seen.at(-1).text).response_format, "wav");
  }
  assert.equal(s.seen[0].headers.authorization, undefined);
});

test("voice: long text goes in pieces of at most 200 characters, and comes back as one WAV", async () => {
  let n = 0;
  const s = await standIn(() => [200, wav(4, ++n), "audio/wav"]);
  const text = "Good morning. Here is your day, one thing at a time; nothing is urgent. ".repeat(9).trim();
  assert.ok(text.length > 600);
  const r = await createSpeaker({ backends: [voice(s.url)] }).speak(text, { format: "wav" });
  assert.equal(r.ok, true);
  const inputs = s.seen.map((q) => JSON.parse(q.text).input);
  assert.ok(inputs.length >= 4);
  assert.ok(inputs.every((i) => i.length <= 200 && /\.$/.test(i)));
  assert.equal(inputs.join(" "), text);
  const samples = [...new Int16Array(new Uint8Array(dataOf(r.audio)).buffer)];
  assert.deepEqual(samples, inputs.flatMap((_, i) => [i + 1, i + 1, i + 1, i + 1]));
  // A backend's own limit.
  const small = await standIn(speech(1));
  await createSpeaker({ backends: [voice(small.url, { maxChars: 40 })] }).speak("One short sentence here. And then another one after it.");
  assert.deepEqual(small.seen.map((q) => JSON.parse(q.text).input), ["One short sentence here.", "And then another one after it."]);
});

test("voice: the first backend that works answers; the flatline kind still gets presets, pace and the format", async () => {
  const a = await standIn(flatlineOk);
  const b = await standIn(speech());
  const sp = createSpeaker({ backends: [local(a.url), voice(b.url)] });
  const r = await sp.speak("Hello.", { preset: "kestrel", format: "mp3", pace: 0.8 });
  assert.deepEqual([r.ok, r.contentType, r.format, r.note, r.via], [true, "audio/mpeg", "mp3", undefined, { index: 0, kind: "flatline" }]);
  assert.deepEqual(JSON.parse(a.seen[0].text), { text: "Hello.", preset: "kestrel", format: "mp3", pace: 0.8 });
  assert.equal(b.seen.length, 0);
  assert.deepEqual(await sp.presets(), ["flatline", "plain"]);
  assert.deepEqual(await createSpeaker({ backends: [voice(b.url), local(a.url)] }).presets(), ["flatline", "plain"]);
  assert.equal(await createSpeaker({ backends: [voice(b.url)] }).presets(), null);
});

test("voice: moves on for a service that isn't there, busy (503), 429, a failure (500) and a timeout", async () => {
  const second = await standIn(speech());
  const busy = await standIn(() => [503, { error: "Busy: try again in a moment.", code: "busy" }]);
  const limited = await standIn(() => [429, { error: { message: "Rate limit reached." } }]);
  const failing = await standIn(() => [500, { error: "Speaking failed.", code: "failed" }]);
  const slow = await standIn(async () => { await new Promise((r) => setTimeout(r, 400)); return [200, wav(1), "audio/wav"]; });
  for (const first of [local(DEAD), voice(DEAD), local(busy.url), voice(limited.url), local(failing.url), voice(failing.url), voice(slow.url, { timeoutMs: 80 })]) {
    const r = await createSpeaker({ backends: [first, voice(second.url)] }).speak("Time to get up.");
    assert.equal(r.ok, true, JSON.stringify(first));
    assert.deepEqual(r.via, { index: 1, kind: "openai" });
  }
  assert.equal(second.seen.length, 7);
  const t = await createSpeaker({ backends: [local(slow.url)], timeoutMs: 80 }).speak("Slow.");
  assert.deepEqual([t.code, t.via], ["timeout", { index: 0, kind: "flatline" }]);
});

test("voice: never moves on for nothing to say, too much, an unknown preset, a 400 or a refused key", async () => {
  const second = await standIn(speech());
  const noPreset = await standIn(() => [404, { error: 'No preset "nope".', code: "unknown_preset" }]);
  const bad = await standIn(() => [400, { error: { message: "voice must be one of the listed voices" } }]);
  const refused = await standIn(() => [401, { error: { message: "Invalid API Key" } }]);
  const notWav = await standIn(() => [200, "<html>hello</html>", "text/html"]);
  const sp = createSpeaker({ backends: [local(noPreset.url), voice(second.url)], maxChars: 10 });
  assert.equal((await sp.speak("   ")).code, "empty");
  assert.equal((await sp.speak("more than ten characters")).code, "too_long");
  assert.equal(noPreset.seen.length, 0);
  assert.equal((await sp.speak("hi", { preset: "nope" })).code, "unknown_preset");
  const r = await createSpeaker({ backends: [voice(bad.url), voice(second.url)] }).speak("hi");
  assert.deepEqual([r.code, r.via], ["bad_response", { index: 0, kind: "openai" }]);
  assert.match(r.error, /answered 400: voice must be one of/);
  const k = await createSpeaker({ backends: [voice(refused.url, { apiKey: KEY }), voice(second.url)] }).speak("hi");
  assert.match(k.error, /refused the key \(401\)/);
  assert.equal((await createSpeaker({ backends: [voice(notWav.url), voice(second.url)] }).speak("hi")).code, "bad_response");
  assert.equal(second.seen.length, 0);
});

test("voice: a key is never in an error, whatever the service says back", async () => {
  const echo400 = await standIn((q) => [400, { error: { message: `Bad request from ${q.headers.authorization}` } }]);
  const echo401 = await standIn(() => [401, { error: { message: `Incorrect API key provided: ${KEY}` } }]);
  const echo500 = await standIn(() => [500, { error: { message: `key ${KEY} failed` } }]);
  for (const url of [echo400.url, echo401.url, echo500.url, DEAD]) {
    const r = await createSpeaker({ backends: [voice(url, { apiKey: KEY })] }).speak("hi");
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(KEY), JSON.stringify(r));
  }
});

test("voice: a 0.7-style caller is one flatline backend; configured and healthy if any backend is", async () => {
  const a = await standIn(flatlineOk);
  const models = await standIn((q) => q.path === "/v1/models" ? [200, { data: [] }] : [404, {}]);
  const old = createSpeaker({ url: `${a.url}/` });
  const r = await old.speak("As before.");
  assert.deepEqual([r.ok, r.contentType, r.format, r.via], [true, "audio/mpeg", "m4a", { index: 0, kind: "flatline" }]);
  assert.deepEqual(JSON.parse(a.seen[0].text), { text: "As before.", format: "m4a" });
  assert.equal(await old.health(), true);
  assert.equal(createSpeaker({ url: "" }).configured, false);
  assert.equal(createSpeaker({ backends: [local(""), { kind: "openai", url: " ", model: "m", voice: "v" }] }).configured, false);
  assert.equal(createSpeaker({ backends: [local(undefined), voice(models.url)] }).configured, true);
  assert.equal(await createSpeaker({ backends: [local(DEAD), voice(models.url)] }).health(), true);
  assert.equal(await createSpeaker({ backends: [local(DEAD), voice(DEAD)] }).health(), false);
  assert.equal((await createSpeaker({ backends: [] }).speak("hi")).code, "unavailable");
});
