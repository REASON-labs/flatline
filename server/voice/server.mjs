#!/usr/bin/env node
// Flatline's text-to-speech service: Piper speaks, ffmpeg gives the voice its character and
// encodes it. Loopback only, no dependencies beyond Node 20+, Piper and ffmpeg.
//
//   GET  /         { ok, presets, default, formats }
//   POST /speak    { text, preset?, format?, tune?, flatten? }  ->  audio (or { error, code })
//
// A Piper process stays running for each voice in use (the model loads once): presets with the
// same voice and pace share one. At most FLATLINE_VOICE_MAX_PIPERS run at a time (the least
// recently used one stops first), and one that sits idle stops after FLATLINE_VOICE_IDLE_MS, so
// a cast of characters fits in the memory cap. One sentence is made at a time (it is CPU-bound),
// with a short queue. A request is spoken a sentence at a time, with the pause after each set
// by what ended it (a clause, a statement, a question: see pausesOf), then joined. Settings come from the environment (see server/install-voice.sh); presets
// from FLATLINE_VOICE_PRESETS, re-read on restart. A preset can be another's other name:
// { "sameAs": "flatline" }.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { buildFilter, mergeEffects, FORMATS, PADDING } from "./chain.mjs";
import { segments } from "./flatten.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.FLATLINE_VOICE_PORT ?? 8087);
const HOST = env.FLATLINE_VOICE_HOST ?? "127.0.0.1";
const PIPER = env.PIPER_BIN ?? "/opt/flatline/piper/piper";
const FFMPEG = env.FFMPEG_BIN ?? "ffmpeg";
const VOICES = env.FLATLINE_VOICES_DIR ?? "/var/lib/flatline/voices";
const PRESETS_FILE = env.FLATLINE_VOICE_PRESETS ?? join(HERE, "presets.json");
const MAX_CHARS = Number(env.FLATLINE_VOICE_MAX_CHARS ?? 2000);
const MAX_QUEUE = Number(env.FLATLINE_VOICE_QUEUE ?? 8);
const JOB_TIMEOUT = Number(env.FLATLINE_VOICE_TIMEOUT_MS ?? 60_000);
const MAX_PIPERS = Math.max(1, Number(env.FLATLINE_VOICE_MAX_PIPERS ?? 4));
const IDLE_MS = Number(env.FLATLINE_VOICE_IDLE_MS ?? 15 * 60_000);

const log = (...a) => { if (env.NODE_ENV !== "test") console.log(...a); };

const NAME = /^[a-z0-9_-]{1,40}$/;

export function loadPresets(file = PRESETS_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const out = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!NAME.test(name) || !p || typeof p !== "object" || "sameAs" in p) continue;
    if (typeof p.voice !== "string" || !/^[A-Za-z0-9_.-]+$/.test(p.voice)) continue;
    out[name] = p;
  }
  // Other names ({ "sameAs": "flatline" }): the same preset, by reference. Only to a real one.
  for (const [name, p] of Object.entries(raw)) {
    if (!NAME.test(name) || !p || typeof p !== "object" || typeof p.sameAs !== "string") continue;
    if (out[p.sameAs] && !(name in out)) out[name] = out[p.sameAs];
  }
  return out;
}

/** The preset a request without one gets: FLATLINE_VOICE_DEFAULT, else flatline, else dixie, else the first. */
export function defaultPreset(presets) {
  for (const n of [env.FLATLINE_VOICE_DEFAULT, "flatline", "dixie"]) if (n && presets[n]) return n;
  return Object.keys(presets)[0];
}

/** Text Piper can take: no control characters, one line, trimmed. */
export function cleanText(t) {
  return String(t ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

// --- Piper: one long-running process per preset ------------------------------------------

const pipers = new Map();

/** Presets with the same voice and the same pace share a Piper (the speaker is chosen per line). */
export function piperKey(p) {
  return [p.voice, clamp(p.lengthScale, 0.5, 2, 1), clamp(p.noiseScale, 0, 1.5, 0.667), clamp(p.noiseW, 0, 1.5, 0.8)].join("|");
}

/**
 * The pauses (seconds) after a clause, a statement and a question. A preset can set any of them
 * in "pauses"; what it leaves out comes from "sentenceSilence" (the pause after a statement):
 * a clause gets half of it, a question a little more.
 */
export function pausesOf(p) {
  const stop = clamp(p.pauses?.stop ?? p.sentenceSilence, 0, 2, 0.25);
  const ms = (n) => Math.round(n * 1000) / 1000;
  return {
    stop: ms(stop),
    clause: ms(clamp(p.pauses?.clause, 0, 2, stop * 0.5)),
    question: ms(clamp(p.pauses?.question, 0, 2, stop * 1.15)),
  };
}

/** How many Piper processes are running (for tests). */
export const runningPipers = () => [...pipers.values()].filter((p) => !p.dead).length;

function stopPiper(key) {
  const p = pipers.get(key);
  if (!p) return;
  p.dead = true; clearTimeout(p.idle); p.child.kill();
  pipers.delete(key);
  log(`piper stopped for ${key.split("|")[0]}`);
}

function piperFor(name, p) {
  const key = piperKey(p);
  const have = pipers.get(key);
  if (have && !have.dead) {
    pipers.delete(key); pipers.set(key, have);   // most recently used last
    return have;
  }
  if (have) pipers.delete(key);
  // Room for one more: stop the least recently used that isn't speaking.
  while (pipers.size >= MAX_PIPERS) {
    const idle = [...pipers.entries()].find(([, q]) => !q.waiting.length);
    if (!idle) break;
    stopPiper(idle[0]);
  }
  const model = join(VOICES, `${p.voice}.onnx`);
  const args = ["--model", model, "--json-input", "--quiet",
    "--length_scale", String(clamp(p.lengthScale, 0.5, 2, 1)),
    "--noise_scale", String(clamp(p.noiseScale, 0, 1.5, 0.667)),
    "--noise_w", String(clamp(p.noiseW, 0, 1.5, 0.8)),
    "--sentence_silence", "0"];   // the pauses are put in between the pieces, by pausesOf
  const child = spawn(PIPER, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...env, LD_LIBRARY_PATH: dirname(PIPER) } });
  const proc = { child, dead: false, waiting: [] };
  createInterface({ input: child.stdout }).on("line", (line) => {
    const w = proc.waiting.shift();
    if (w) w.resolve(line.trim());
  });
  let errTail = "";
  child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-500); });
  const fail = (why) => {
    proc.dead = true;
    for (const w of proc.waiting.splice(0)) w.reject(new Error(why));
  };
  child.on("exit", (code) => fail(`piper exited (${code}): ${errTail.trim()}`));
  child.on("error", (e) => fail(`piper didn't start: ${e.message}`));
  pipers.set(key, proc);
  log(`piper started for ${name} (${p.voice})`);
  return proc;
}

/** Stop every Piper (on SIGTERM, and in tests). */
export function stopPipers() {
  for (const p of pipers.values()) { p.dead = true; clearTimeout(p.idle); p.child.kill(); }
  pipers.clear();
}

function clamp(v, min, max, fallback) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function synthesize(name, p, text, wavPath) {
  const proc = piperFor(name, p);
  // A Piper nobody has asked for in a while stops, and starts again when it's wanted.
  clearTimeout(proc.idle);
  if (IDLE_MS > 0) { proc.idle = setTimeout(() => { if (!proc.waiting.length && pipers.get(piperKey(p)) === proc) stopPiper(piperKey(p)); }, IDLE_MS); proc.idle.unref?.(); }
  return new Promise((resolve, reject) => {
    proc.waiting.push({ resolve, reject });
    const line = { text, output_file: wavPath };
    if (Number.isInteger(p.speaker)) line.speaker_id = p.speaker;
    proc.child.stdin.write(JSON.stringify(line) + "\n");
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err = (err + d).slice(-800); });
    c.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

function sampleRate(voice) {
  try { return JSON.parse(readFileSync(join(VOICES, `${voice}.onnx.json`), "utf8")).audio?.sample_rate ?? 22050; }
  catch { return 22050; }
}

/** Text in, encoded audio out. */
export async function render(presets, { text, preset = defaultPreset(presets), format = "m4a", tune, flatten: flat }) {
  const p = presets[preset];
  if (!p) throw Object.assign(new Error(`No preset "${preset}".`), { code: "unknown_preset", status: 404 });
  // A preset's "flatten" (or a request's, true or false, to compare) shapes the text first.
  const pieces = segments(text, typeof flat === "boolean" ? flat : p.flatten === true);
  if (!pieces.length) throw Object.assign(new Error("There's nothing to say."), { code: "empty", status: 400 });
  const fmt = FORMATS[format];
  if (!fmt) throw Object.assign(new Error(`No format "${format}".`), { code: "bad_format", status: 400 });
  const dir = await mkdtemp(join(env.FLATLINE_VOICE_TMP ?? tmpdir(), "voice-"));
  try {
    const out = join(dir, `out.${fmt.ext}`);
    const wavs = [];
    for (const [i, piece] of pieces.entries()) {
      const wav = join(dir, `raw${i}.wav`);
      await synthesize(preset, p, piece.text, wav);
      wavs.push(wav);
    }
    // Edges (lead-in, fade, tail) are the service's own unless the preset (or a tune) sets them.
    const effects = mergeEffects(p.effects ?? {}, tune ?? {});
    const edges = ["leadIn", "fade", "tail"].some((k) => k in effects) ? {} : PADDING;
    const filter = buildFilter({ ...edges, ...effects }, sampleRate(p.voice));
    const inputs = wavs.flatMap((w) => ["-i", w]);
    const encode = ["-ac", "1", ...fmt.args, out];
    if (wavs.length === 1) {
      await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-af", filter, ...encode]);
    } else {
      // Each piece gets the silence its ending calls for, then they are joined and given the sound.
      const pauses = pausesOf(p);
      const pad = pieces.map((piece, i) => i === pieces.length - 1 ? "anull" : `apad=pad_dur=${pauses[piece.pause].toFixed(3)}`);
      const graph = [
        ...pad.map((f, i) => `[${i}:a]${f}[p${i}]`),
        `${pad.map((_, i) => `[p${i}]`).join("")}concat=n=${pad.length}:v=0:a=1,${filter}[out]`,
      ].join(";");
      await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", ...encode]);
    }
    return { audio: await readFile(out), type: fmt.type };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- the queue: one at a time ---------------------------------------------------------------

let chain = Promise.resolve();
let queued = 0;

function enqueue(fn) {
  if (queued >= MAX_QUEUE) return Promise.reject(Object.assign(new Error("Busy: try again in a moment."), { code: "busy", status: 503 }));
  queued++;
  const job = chain.then(() => withTimeout(fn(), JOB_TIMEOUT));
  chain = job.catch(() => {}).finally(() => { queued--; });
  return job;
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Took too long."), { code: "timeout", status: 504 })), ms))]);
}

// --- HTTP ------------------------------------------------------------------------------------

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

export function createVoiceServer(presets = loadPresets()) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") return send(res, 200, { ok: true, presets: Object.keys(presets), default: defaultPreset(presets), formats: Object.keys(FORMATS) });
      if (req.method !== "POST" || req.url !== "/speak") return send(res, 404, { error: "Not found.", code: "not_found" });
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > MAX_CHARS * 4 + 4096) return send(res, 413, { error: "Too long.", code: "too_long" }); }
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "Send JSON: { text, preset, format }.", code: "bad_request" }); }
      const text = cleanText(body.text);
      if (!text) return send(res, 400, { error: "There's nothing to say.", code: "empty" });
      if (text.length > MAX_CHARS) return send(res, 413, { error: `Keep it under ${MAX_CHARS} characters.`, code: "too_long" });
      const started = Date.now();
      const preset = typeof body.preset === "string" && body.preset ? body.preset : defaultPreset(presets);
      const out = await enqueue(() => render(presets, { text, preset, format: body.format ?? "m4a", tune: body.tune, flatten: typeof body.flatten === "boolean" ? body.flatten : undefined }));
      log(`spoke ${text.length} chars as ${preset}/${body.format ?? "m4a"} in ${Date.now() - started} ms`);
      return send(res, 200, out.audio, out.type);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) log(`speak failed: ${e.message}`);
      return send(res, status, { error: status >= 500 && !e.code ? "Speaking failed." : e.message, code: e.code ?? "failed" });
    }
  });
}

// Run as a service (not when imported by the tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(PRESETS_FILE)) { console.error(`No presets at ${PRESETS_FILE}`); process.exit(1); }
  const presets = loadPresets();
  createVoiceServer(presets).listen(PORT, HOST, () => log(`Flatline voice on http://${HOST}:${PORT} (presets: ${Object.keys(presets).join(", ")})`));
  const stop = () => { stopPipers(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
