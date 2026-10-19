// Against a REAL whisper service (server/install.sh): the formats phones actually record,
// spoken words in, the words back out. Runs only when FLATLINE_URL and FLATLINE_SAMPLES are set
// (CI sets both: it installs the service with the tiny model and makes the samples with
// espeak-ng and ffmpeg). Each sample says "Hello world".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTranscriber } from "../dist/server/index.js";

const url = process.env.FLATLINE_URL;
const dir = process.env.FLATLINE_SAMPLES;
const skip = !url || !dir ? "set FLATLINE_URL and FLATLINE_SAMPLES to run" : false;

// [file, the content type the browser reports for it]
const SAMPLES = [
  ["hello.m4a", "audio/mp4"],                 // iPhone Safari: MediaRecorder MP4 (AAC)
  ["hello.webm", "audio/webm;codecs=opus"],   // Chrome, Edge, Android: WebM (Opus)
  ["hello.ogg", "audio/ogg;codecs=opus"],     // Firefox: Ogg (Opus)
  ["hello.wav", "audio/wav"],
];

test("the service is up", { skip }, async () => {
  assert.equal(await createTranscriber({ url }).health(), true);
});

// The samples are a synthetic voice and CI uses the tiny model, so the words come out roughly
// ("Hello world" can be heard as "the low world"); what matters is that every format is read,
// and read the same way.
const heard = {};
for (const [file, type] of SAMPLES) {
  test(`transcribes ${file} (${type})`, { skip, timeout: 120_000 }, async () => {
    const audio = new Uint8Array(await readFile(join(dir, file)));
    const r = await createTranscriber({ url }).transcribe(audio, type);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.text.toLowerCase(), /world/, r.text);
    heard[file] = r.text.toLowerCase();
  });
}

test("every format gives the same words", { skip }, () => {
  const texts = new Set(Object.values(heard));
  assert.equal(Object.keys(heard).length, SAMPLES.length);
  assert.equal(texts.size, 1, JSON.stringify(heard));
});
