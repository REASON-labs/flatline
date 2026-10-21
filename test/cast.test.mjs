// The cast (flatline/cast): every character is complete, follows the rules, and has a real
// preset; and the installer's preset merge keeps what's there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAST, DEFAULT_CHARACTER, character, toneGuide, fill, linesFor, plainLines, changesVars, COMPARE_LINES, RULES } from "../dist/cast/index.js";
import { mergePresets } from "../server/voice/merge-presets.mjs";

const PRESETS = JSON.parse(readFileSync(new URL("../server/voice/presets.json", import.meta.url), "utf8"));
const INSTALLER = readFileSync(new URL("../server/install-voice.sh", import.meta.url), "utf8");
const DOCS = readFileSync(new URL("../docs/VOICE.md", import.meta.url), "utf8");
const PLACEHOLDERS = new Set(["name", "n", "time", "title", "who", "changes", "them", "error", "memo"]);
/** Lines a lock screen may show: never {title}. */
const TEXT_KEYS = new Set(["briefing.text", "briefing.textEmpty", "event.text", "tomorrow.text", "tomorrow.textClear", "wake.text", "wake.textLate"]);
const isText = (k) => TEXT_KEYS.has(k) || k.startsWith("inbox.") || k === "wake.partner";
/** Catchphrases and names that would make a character an imitation. */
const BANNED = [/make it so/i, /\bengage\b/i, /captain's log/i, /\bdave\b/i, /i'm afraid/i, /pod bay/i, /satisfied with your care/i,
  /healthcare companion/i, /scale of one to ten/i, /at your service/i, /\bsir\b/i, /\bmadam\b/i, /jarvis/i, /baymax/i, /\bhal\b/i,
  /picard/i, /\bmajor\b/i, /motoko/i, /\bdixie\b/i, /\bdaisy\b/i];
/** Shaming, guilt and counting misses. */
const UNKIND = [/streak/i, /lazy/i, /disappoint/i, /shame/i, /guilt/i, /\bfail/i, /\bmissed\b/i, /\bbehind\b/i, /\bagain\?/i, /should have/i, /pathetic/i, /useless/i];

const entries = (lines) => Object.entries(lines).flatMap(([group, v]) => Object.entries(v).flatMap(([k, t]) => Array.isArray(t) ? t.map((x, i) => [`${group}.${k}.${i}`, x]) : [[`${group}.${k}`, t]]));
const KEYS = entries(plainLines).map(([k]) => k);
const all = [...CAST.map((c) => [c.id, c.lines]), ["plain", plainLines]];

test("six characters, Flatline first and the default, ids unique and lowercase", () => {
  assert.deepEqual(CAST.map((c) => c.id), ["flatline", "kestrel", "iris", "ashford", "hoshi", "calder"]);
  assert.equal(DEFAULT_CHARACTER, "flatline");
  assert.equal(CAST[0].id, DEFAULT_CHARACTER);
  for (const c of CAST) assert.match(c.id, /^[a-z][a-z0-9-]*$/);
});

test("dixie is Flatline's old name; anything else unknown", () => {
  assert.equal(character("dixie"), character("flatline"));
  assert.equal(character("nobody"), undefined);
  assert.equal(character(null), undefined);
});

for (const [id, lines] of all) {
  test(`${id}: every line is there, eight wake-up steps`, () => {
    assert.deepEqual(entries(lines).map(([k]) => k), KEYS);
    assert.equal(lines.wake.steps.length, 8);
  });
  test(`${id}: short sentences ending in full stops; no commas, "!", "?" or emoji`, () => {
    for (const [k, t] of entries(lines)) {
      assert.ok(t.trim() === t && t.length > 0, `${k} is empty or padded`);
      assert.match(t, /\.$/, `${k} doesn't end in a full stop: ${t}`);
      assert.doesNotMatch(t, /[,!?;]/, `${k}: ${t}`);
      assert.doesNotMatch(t, /\p{Extended_Pictographic}/u, `${k} has an emoji`);
      for (const s of fill(t, { name: "App", n: 3, time: "7:00", title: "Dentist", who: "Sam", changes: "2 changes", them: "them", error: "It broke.", memo: "message" }).split(/(?<=\.)\s+/)) {
        assert.ok(s.split(/\s+/).length <= 16, `${k}: a long sentence: ${s}`);
      }
    }
  });
  test(`${id}: only known placeholders; lock-screen lines never name anything ({title})`, () => {
    for (const [k, t] of entries(lines)) {
      for (const [, p] of t.matchAll(/\{(\w+)\}/g)) assert.ok(PLACEHOLDERS.has(p), `${k}: {${p}}`);
      if (isText(k)) assert.doesNotMatch(t, /\{title\}/, `${k} could put a title on a lock screen`);
    }
    assert.match(lines.event.soon, /\{title\}/); assert.match(lines.event.soon, /\{n\}/);
    assert.match(lines.wake.call, /one/i, "the call says to press one");
    assert.match(lines.wake.partner, /\{who\}/); assert.match(lines.wake.partner, /\{time\}/);
  });
  test(`${id}: nothing unkind, no catchphrases, YES / NO / STOP as the app listens for them`, () => {
    for (const [k, t] of entries(lines)) {
      for (const re of UNKIND) assert.doesNotMatch(t, re, `${k}: ${t}`);
      for (const re of BANNED) assert.doesNotMatch(t, re, `${k}: ${t}`);
    }
    assert.match(lines.inbox.help, /\bYES\b/); assert.match(lines.inbox.help, /\bNO\b/); assert.match(lines.inbox.help, /\bSTOP\b/);
    assert.match(lines.inbox.ready, /\bYES\b/); assert.match(lines.inbox.ready, /\bNO\b/);
    assert.match(lines.inbox.ready, /\{changes\}/);
    assert.match(lines.inbox.failed, /^\{error\} /);
    // "1 change" and "3 changes" both read right: no verb that agrees with only one of them.
    for (const n of [1, 3]) for (const k of ["ready", "applied"]) {
      assert.doesNotMatch(fill(lines.inbox[k], { ...changesVars(n), name: "App" }), /\b1 change (go|deploy|take|are)\b|\b3 changes (goes|deploys|takes|is)\b/, `${k} with ${n}`);
    }
  });
}

for (const c of CAST) {
  test(`${c.id}: a real preset, its voice pinned in the installer, its licence in the docs`, () => {
    const p = PRESETS[c.preset];
    assert.ok(p && p.voice, `no preset ${c.preset}`);
    assert.equal(p.voice, c.voice.model);
    assert.equal(p.speaker, c.voice.speaker);
    assert.equal(p.flatten === true, c.flatten, "flatten matches the preset");
    assert.ok(INSTALLER.includes(`[${c.voice.model}.onnx]=`) && INSTALLER.includes(`[${c.voice.model}.onnx.json]=`), `${c.voice.model} isn't pinned`);
    assert.ok(DOCS.includes(c.voice.model), `${c.voice.model} isn't in docs/VOICE.md`);
    assert.doesNotMatch(c.voice.licence, /NC|non-commercial/i);
    if (/CC BY/.test(c.voice.licence)) assert.ok(c.voice.credit, "a CC BY voice has a credit line");
  });
  test(`${c.id}: a tone guide with the rules, and a sample in character`, () => {
    const g = toneGuide(c);
    assert.ok(g.includes(c.tone) && g.includes(RULES));
    assert.match(g, /never shame/i); assert.match(g, /rest/i);
    assert.match(c.tone, new RegExp(`You are ${c.name}`));
    assert.match(c.sample, /\.$/); assert.doesNotMatch(c.sample, /[,!?]/);
    for (const re of [...BANNED, ...UNKIND]) assert.doesNotMatch(`${c.sample} ${c.tone.replace(/honorifics like sir or madam/, "")}`, re);
  });
}

test("Flatline keeps her tuned sound: the values tuned by ear on 2026-10-20", () => {
  const f = PRESETS.flatline;
  assert.deepEqual([f.voice, f.speaker, f.lengthScale, f.noiseScale, f.noiseW, f.sentenceSilence, f.flatten], ["en_US-libritts_r-medium", 137, 1.3, 0.35, 0.5, 0.55, true]);
  assert.deepEqual(f.effects, { pitch: 0.9, highpass: 110, lowpass: 5200, presence: { freq: 1900, gain: 3 }, compress: { threshold: -22, ratio: 4 }, drive: 6, echo: { delay: 16, decay: 0.15 }, loudness: -16 });
  assert.deepEqual(PRESETS.dixie, { about: PRESETS.dixie.about, sameAs: "flatline" });
});

test("no character: plain wording and a plain tone guide that still has the rules", () => {
  assert.equal(linesFor(undefined), plainLines);
  assert.ok(toneGuide(undefined).includes(RULES));
});

test("fill and changesVars", () => {
  assert.equal(fill("{changes} ready. Reply YES to run {them}.", changesVars(1)), "1 change ready. Reply YES to run it.");
  assert.equal(fill("{changes} ready. Reply YES to run {them}.", changesVars(3)), "3 changes ready. Reply YES to run them.");
  assert.equal(fill("Hi {who}. It's {time}.", { time: "7:00" }), "Hi . It's 7:00.");
  assert.equal(COMPARE_LINES.length, 3);
});

// --- the installer's merge -------------------------------------------------------------------

const SHIPPED = { flatline: { about: "new", voice: "a", lengthScale: 1.3 }, dixie: { sameAs: "flatline" }, kestrel: { voice: "k" }, plain: { voice: "a" } };

test("merge: an old file with a tuned dixie gets flatline as a copy of THEIR dixie, and the new characters", () => {
  const theirs = { dixie: { voice: "a", lengthScale: 1.45, effects: { pitch: 0.8 } }, plain: { voice: "a", noiseScale: 0.5 } };
  const { merged, added } = mergePresets(theirs, SHIPPED);
  assert.deepEqual(added, ["flatline", "kestrel"]);
  assert.deepEqual(merged.flatline, { voice: "a", lengthScale: 1.45, effects: { pitch: 0.8 }, about: "new" });
  assert.equal(merged.dixie, theirs.dixie, "their dixie is untouched");
  assert.equal(merged.plain, theirs.plain, "their plain is untouched");
});

test("merge: nothing they have changes; nothing new, nothing added", () => {
  const theirs = { ...SHIPPED, kestrel: { voice: "mine" }, mine: { voice: "x" } };
  const { merged, added } = mergePresets(theirs, SHIPPED);
  assert.deepEqual(added, []);
  assert.deepEqual(merged, theirs);
});

test("LATER: every voice says when the reminder comes back, and has a line for nothing to push", () => {
  for (const L of [...CAST.map((c) => linesFor(c)), plainLines]) {
    assert.match(L.inbox.later, /\{time\}/);
    assert.ok(L.inbox.nothingToPush.length > 0);
  }
});
