// flatline/server against a stand-in whisper server on a local port: the real fetch, the real
// multipart body, real timeouts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTranscriber, cleanTranscript, fileNameFor } from "../dist/server/index.js";

let server, url;
/** What the stand-in does next: "ok", "slow", "500", "notjson". */
let mode = "ok";
let lastBody = "";

before(async () => {
  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") { res.end("<html>whisper</html>"); return; }
    let body = "";
    for await (const c of req) body += c.toString("latin1");
    lastBody = body;
    if (mode === "slow") { await new Promise((r) => setTimeout(r, 400)); }
    if (mode === "500") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "model failed" })); return; }
    if (mode === "notjson") { res.end("<html>oops</html>"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: " [BLANK_AUDIO] Took my  vitamin D (cough) this morning. " }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

const audio = new Uint8Array([1, 2, 3, 4]);

test("transcribes, and drops whisper's sound tags", async () => {
  mode = "ok";
  const r = await createTranscriber({ url }).transcribe(audio, "audio/mp4");
  assert.equal(r.ok, true);
  assert.equal(r.text, "Took my vitamin D this morning.");
  assert.ok(r.ms >= 0);
});

test("sends a multipart file with a sensible name, and asks for JSON", async () => {
  mode = "ok";
  await createTranscriber({ url, language: "en" }).transcribe(audio, "audio/webm;codecs=opus");
  assert.match(lastBody, /filename="audio\.webm"/);
  assert.match(lastBody, /name="response_format"\r\n\r\njson/);
  assert.match(lastBody, /name="language"\r\n\r\nen/);
});

test("no URL: unavailable, and nothing is sent", async () => {
  const t = createTranscriber({ url: "" });
  assert.equal(t.configured, false);
  const r = await t.transcribe(audio);
  assert.deepEqual([r.ok, r.code], [false, "unavailable"]);
  assert.equal(await t.health(), false);
});

test("empty and oversized audio are refused before sending", async () => {
  const t = createTranscriber({ url, maxBytes: 3 });
  assert.equal((await t.transcribe(new Uint8Array())).code, "empty");
  assert.equal((await t.transcribe(audio)).code, "too_large");
});

test("a slow server times out", async () => {
  mode = "slow";
  const r = await createTranscriber({ url, timeoutMs: 100 }).transcribe(audio);
  assert.deepEqual([r.ok, r.code], [false, "timeout"]);
});

test("an error from the server is reported with its reason", async () => {
  mode = "500";
  const r = await createTranscriber({ url }).transcribe(audio);
  assert.equal(r.code, "bad_response");
  assert.match(r.error, /500: model failed/);
  mode = "notjson";
  assert.equal((await createTranscriber({ url }).transcribe(audio)).code, "bad_response");
});

test("a server that isn't there is unavailable, and unhealthy", async () => {
  const t = createTranscriber({ url: "http://127.0.0.1:9" });
  assert.equal((await t.transcribe(audio)).code, "unavailable");
  assert.equal(await t.health(), false);
});

test("health is true when the server answers", async () => {
  assert.equal(await createTranscriber({ url }).health(), true);
});

test("cleanTranscript and fileNameFor", () => {
  assert.equal(cleanTranscript("[Music] hello (laughs) *sigh* there  "), "hello there");
  assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
  assert.equal(fileNameFor("audio/mp4"), "audio.m4a");
  assert.equal(fileNameFor("audio/ogg; codecs=opus"), "audio.ogg");
  assert.equal(fileNameFor(undefined), "audio.audio");
  // What phones actually record: Safari (MP4/AAC) and Chrome or Firefox (WebM or Ogg Opus).
  assert.equal(fileNameFor("audio/mp4;codecs=mp4a.40.2"), "audio.m4a");
  assert.equal(fileNameFor("audio/x-m4a"), "audio.m4a");
  assert.equal(fileNameFor("audio/aac"), "audio.aac");
  assert.equal(fileNameFor("audio/webm;codecs=opus"), "audio.webm");
  assert.equal(fileNameFor("audio/ogg;codecs=opus"), "audio.ogg");
});
