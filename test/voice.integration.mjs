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

test("every character in the cast speaks, with its own preset", { skip, timeout: 300_000 }, async () => {
  const { CAST } = await import("../dist/cast/index.js");
  const p = await speaker.presets();
  for (const c of CAST) {
    assert.ok(p.includes(c.preset), `no preset ${c.preset}`);
    const r = await speaker.speak(c.sample, { preset: c.preset, format: "mp3" });
    assert.equal(r.ok, true, `${c.id}: ${JSON.stringify(r)}`);
  }
});

for (const format of ["m4a", "mp3", "ogg", "wav"]) {
  test(`speaks ${format}`, { skip, timeout: 120_000 }, async () => {
    const r = await speaker.speak("Check in before noon.", { format });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(MAGIC[format](Buffer.from(r.audio)), `not a ${format}: ${Buffer.from(r.audio).subarray(0, 12).toString("hex")}`);
    assert.ok(r.audio.byteLength > 2000);
  });
}

// Whisper's small models, with no context, will mishear the odd short word ("meds" as "math")
// that a person would get; one sentence is too brittle a measure. Across several, at least 80%
// of the words that carry the meaning must come through.
const LINES = [
  ["Take your meds and drink some water. Then check in before noon.", ["meds", "water", "check", "noon"]],
  ["Listen up. You have three things to do today, and the first one is already late.", ["listen", "three", "today", "first", "late"]],
  ["Good. That's one done. Now get some sleep, and we'll talk in the morning.", ["good", "done", "sleep", "talk", "morning"]],
  ["Your appointment is at four o'clock. Leave by three thirty.", ["appointment", "four|4", "leave", "three|3", "thirty|30"]],
];
test("Dixie is understood: at least 80% of the key words survive the sound (through whisper)", { skip: skip || (!sttUrl && "set FLATLINE_URL"), timeout: 300_000 }, async () => {
  let got = 0, total = 0;
  const misses = [];
  for (const [line, keys] of LINES) {
    const r = await speaker.speak(line, { format: "m4a" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const t = await createTranscriber({ url: sttUrl }).transcribe(r.audio, r.contentType);
    assert.equal(t.ok, true, JSON.stringify(t));
    const said = t.text.toLowerCase();
    // A key may list spellings ("four|4"): whisper writes numbers as digits.
    for (const k of keys) { total++; if (k.split("|").some((w) => said.includes(w))) got++; else misses.push(`"${k}" (heard: ${t.text})`); }
  }
  console.log(`# key words heard: ${got}/${total}${misses.length ? `; missed ${misses.join("; ")}` : ""}`);
  assert.ok(got / total >= 0.8, `only ${got}/${total}: ${misses.join("; ")}`);
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
