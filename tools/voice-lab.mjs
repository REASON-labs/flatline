#!/usr/bin/env node
// The voice lab: find the deepest voices Piper has, give each the Dixie sound, and check
// through whisper that the words still come through. Writes a ranked report and samples to
// listen to. Runs in CI (needs Piper, ffmpeg, the voices and a whisper service):
//
//   PIPER_BIN=... FLATLINE_VOICES_DIR=... FLATLINE_URL=http://127.0.0.1:8086 node tools/voice-lab.mjs out/
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildFilter } from "../server/voice/chain.mjs";

const OUT = process.argv[2] ?? "voice-lab";
const PIPER = process.env.PIPER_BIN ?? "/opt/flatline/piper/piper";
const VOICES = process.env.FLATLINE_VOICES_DIR ?? "/var/lib/flatline/voices";
const WHISPER = process.env.FLATLINE_URL ?? "http://127.0.0.1:8086";
const PRESETS = JSON.parse(readFileSync(new URL("../server/voice/presets.json", import.meta.url), "utf8"));
const MULTI = "en_US-libritts_r-medium";
const SINGLES = (process.env.LAB_SINGLES ?? "en_US-bryce-medium en_US-john-medium en_US-norman-medium en_US-joe-medium en_US-mike-medium").split(/\s+/).filter(Boolean);
const SWEEP_TEXT = "Listen up. I'm not asking twice.";
const SCRIPT = [
  "Listen up. You've got three things to do today, and the first one is already late.",
  "Take your meds, drink some water, and check in before noon. I'm not asking twice.",
];
mkdirSync(join(OUT, "wav"), { recursive: true });
mkdirSync(join(OUT, "samples"), { recursive: true });

// --- Piper, one process per voice, JSON lines in, paths out ----------------------------------
function piper(voice, extra = []) {
  const child = spawn(PIPER, ["--model", join(VOICES, `${voice}.onnx`), "--json-input", "--quiet", ...extra], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  let dead = false;
  createInterface({ input: child.stdout }).on("line", (l) => waiting.shift()?.(l.trim()));
  // A voice this Piper can't load (some newer ones) makes it exit: every waiting line gets null.
  child.on("exit", () => { dead = true; for (const w of waiting.splice(0)) w(null); });
  child.stdin.on("error", () => {});
  return {
    say: (text, output_file, speaker_id) => new Promise((res) => {
      if (dead) return res(null);
      waiting.push(res);
      child.stdin.write(JSON.stringify({ text, output_file, ...(speaker_id === undefined ? {} : { speaker_id }) }) + "\n");
    }),
    close: () => child.stdin.end(),
  };
}
const run = (cmd, args) => new Promise((res, rej) => { const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] }); c.on("exit", (code) => (code ? rej(new Error(`${cmd} ${code}`)) : res())); });

// --- pitch: median F0 of the voiced frames, by autocorrelation --------------------------------
function readWav(file) {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24);
  let off = 12;
  while (off < b.length - 8 && b.toString("ascii", off, off + 4) !== "data") off += 8 + b.readUInt32LE(off + 4);
  const n = (b.length - off - 8) >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
  return { rate, x };
}
export function medianF0({ rate: inRate, x: inX }) {
  // Pitch lives well below 1 kHz: average down to about 7 kHz first (27x less work at 22 kHz).
  const k = Math.max(1, Math.round(inRate / 7350));
  const rate = inRate / k, x = new Float32Array(Math.floor(inX.length / k));
  for (let i = 0; i < x.length; i++) { let sum = 0; for (let j = 0; j < k; j++) sum += inX[i * k + j]; x[i] = sum / k; }
  const size = 512, hop = 256, minLag = Math.floor(rate / 400), maxLag = Math.floor(rate / 55);
  const frames = [];
  for (let s = 0; s + size + maxLag < x.length; s += hop) {
    let e = 0; for (let i = 0; i < size; i++) e += x[s + i] * x[s + i];
    frames.push({ s, rms: Math.sqrt(e / size) });
  }
  const loud = frames.map((f) => f.rms).sort((a, b) => a - b)[Math.floor(frames.length * 0.6)] ?? 0;
  const f0s = [];
  for (const { s, rms } of frames) {
    if (rms < loud * 0.5 || rms < 0.01) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, a = 0, b = 0;
      for (let i = 0; i < size; i++) { const p = x[s + i], q = x[s + i + lag]; c += p * q; a += p * p; b += q * q; }
      const r = c / Math.sqrt(a * b + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.7) f0s.push(rate / bestLag);
  }
  f0s.sort((a, b) => a - b);
  return { f0: f0s.length ? Math.round(f0s[f0s.length >> 1]) : null, voiced: f0s.length };
}

// --- words through whisper -----------------------------------------------------------------------
const words = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
async function transcribe(file, type) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type }), file.split("/").pop());
  form.append("response_format", "json");
  const res = await fetch(`${WHISPER}/inference`, { method: "POST", body: form });
  return ((await res.json()).text ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").trim();
}

// --- 1. the sweep: every speaker of the multi-speaker voice, and each single voice ------------------
const results = [];
const unusable = [];
const t0 = Date.now();
if (existsSync(join(VOICES, `${MULTI}.onnx`))) {
  const n = JSON.parse(readFileSync(join(VOICES, `${MULTI}.onnx.json`), "utf8")).num_speakers;
  const p = piper(MULTI);
  for (let id = 0; id < n; id++) {
    const f = join(OUT, "wav", `sweep-${id}.wav`);
    if (!(await p.say(SWEEP_TEXT, f, id))) { console.log(`${MULTI} stopped at speaker ${id}`); break; }
    results.push({ voice: MULTI, speaker: id, ...medianF0(readWav(f)) });
  }
  p.close();
}
for (const v of SINGLES) {
  if (!existsSync(join(VOICES, `${v}.onnx`))) { console.log(`(skipping ${v}: not installed)`); continue; }
  const p = piper(v);
  const f = join(OUT, "wav", `sweep-${v}.wav`);
  const ok = await p.say(SWEEP_TEXT, f);
  p.close();
  if (!ok) { unusable.push(v); console.log(`(${v} won't load in this Piper: skipped)`); continue; }
  results.push({ voice: v, speaker: null, ...medianF0(readWav(f)) });
}
console.log(`swept ${results.length} voices in ${Math.round((Date.now() - t0) / 1000)} s`);

// --- 2. the deepest male voices, with the Dixie sound, through whisper ----------------------------
const dixie = PRESETS.flatline;
const deep = results.filter((r) => r.f0 && r.f0 >= 65 && r.f0 <= 135 && r.voiced >= 8).sort((a, b) => a.f0 - b.f0);
const candidates = [...deep.filter((r) => r.speaker !== null).slice(0, 12), ...deep.filter((r) => r.speaker === null)];
const scored = [];
for (const c of candidates) {
  const id = c.speaker === null ? c.voice.replace(/^en_US-|-medium$/g, "") : `libritts_r-${c.speaker}`;
  const p = piper(c.voice, ["--length_scale", String(dixie.lengthScale), "--noise_scale", String(dixie.noiseScale), "--noise_w", String(dixie.noiseW), "--sentence_silence", String(dixie.sentenceSilence)]);
  const raw = join(OUT, "wav", `${id}.wav`);
  const ok = await p.say(SCRIPT.join(" "), raw, c.speaker ?? undefined);
  p.close();
  if (!ok) continue;
  const m4a = join(OUT, "wav", `${id}.m4a`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-af", buildFilter(dixie.effects, 22050), "-ac", "1", "-c:a", "aac", "-b:a", "64k", m4a]);
  const heard = await transcribe(m4a, "audio/mp4");
  const plainHeard = await transcribe(raw, "audio/wav");
  scored.push({ id, voice: c.voice, speaker: c.speaker, f0: c.f0, dixieWer: Number(wer(SCRIPT.join(" "), heard).toFixed(3)), plainWer: Number(wer(SCRIPT.join(" "), plainHeard).toFixed(3)), heard });
  // Samples to listen to: Dixie, and the same voice untouched.
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", m4a, "-c:a", "libmp3lame", "-q:a", "4", join(OUT, "samples", `dixie-${id}.mp3`)]);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=7", "-c:a", "libmp3lame", "-q:a", "4", join(OUT, "samples", `plain-${id}.mp3`)]);
}

// Clear first (whisper gets nearly every word), then deepest.
scored.sort((a, b) => (a.dixieWer > 0.15) - (b.dixieWer > 0.15) || a.f0 - b.f0 || a.dixieWer - b.dixieWer);
const report = { sweptVoices: results.length, unusable, script: SCRIPT, preset: dixie, ranked: scored, deepestTwenty: deep.slice(0, 20) };
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
const md = [
  "# Voice lab", "", `Swept ${results.length} voices. Script: "${SCRIPT.join(" ")}"`, "",
  ...(unusable.length ? [`Won't load in Piper 2023.11.14-2 (newer voices): ${unusable.join(", ")}`, ""] : []),
  "| rank | voice | F0 (Hz) | words missed, Dixie | words missed, plain | heard |", "|---|---|---|---|---|---|",
  ...scored.map((s, i) => `| ${i + 1} | ${s.id} | ${s.f0} | ${Math.round(s.dixieWer * 100)}% | ${Math.round(s.plainWer * 100)}% | ${s.heard.slice(0, 90)} |`),
];
writeFileSync(join(OUT, "report.md"), md.join("\n") + "\n");
console.log(md.join("\n"));
