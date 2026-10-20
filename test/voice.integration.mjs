// Against the REAL voice service (server/install-voice.sh): each format is real audio of its
// kind, and Dixie is understood: what she says goes back through whisper and the words come
// through. Runs only when FLATLINE_VOICE_URL is set (CI installs both services).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeaker, createTranscriber } from "../dist/server/index.js";

const voiceUrl = process.env.FLATLINE_VOICE_URL;
const sttUrl = process.env.FLATLINE_URL;
const skip = !voiceUrl ? "set FLATLINE_VOICE_URL to run" : false;
const speaker = createSpeaker({ url: voiceUrl });

// What each container starts with.
const MAGIC = {
  m4a: (b) => b.subarray(4, 8).toString() === "ftyp",
  mp3: (b) => b.subarray(0, 3).toString() === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ogg: (b) => b.subarray(0, 4).toString() === "OggS",
  wav: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WAVE",
};

test("the service is up, with its presets", { skip }, async () => {
  assert.equal(await speaker.health(), true);
  const p = await speaker.presets();
  assert.ok(p.includes("dixie") && p.includes("plain"), p.join());
});

for (const format of ["m4a", "mp3", "ogg", "wav"]) {
  test(`speaks ${format}`, { skip, timeout: 120_000 }, async () => {
    const r = await speaker.speak("Check in before noon.", { format });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(MAGIC[format](Buffer.from(r.audio)), `not a ${format}: ${Buffer.from(r.audio).subarray(0, 12).toString("hex")}`);
    assert.ok(r.audio.byteLength > 2000);
  });
}

test("Dixie is understood: her words survive the sound (through whisper)", { skip: skip || (!sttUrl && "set FLATLINE_URL"), timeout: 180_000 }, async () => {
  const line = "Take your meds and drink some water. Then check in before noon.";
  const r = await speaker.speak(line, { format: "m4a" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = await createTranscriber({ url: sttUrl }).transcribe(r.audio, r.contentType);
  assert.equal(t.ok, true, JSON.stringify(t));
  const said = t.text.toLowerCase();
  for (const w of ["meds", "water", "check", "noon"]) assert.match(said, new RegExp(w), `missing "${w}" in: ${t.text}`);
});

test("a tune works for real, and the plain preset too", { skip, timeout: 120_000 }, async () => {
  const a = await speaker.speak("Testing.", { format: "wav", tune: { pitch: 0.8, drive: 10 } });
  const b = await speaker.speak("Testing.", { format: "wav", preset: "plain" });
  assert.equal(a.ok && b.ok, true);
});

test("its refusals", { skip }, async () => {
  assert.equal((await speaker.speak("hi", { preset: "nope" })).code, "unknown_preset");
  assert.equal((await speaker.speak("   ")).code, "empty");
});
