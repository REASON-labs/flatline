#!/usr/bin/env node
// Flatline's text-to-speech service: Piper speaks, ffmpeg gives the voice its character and
// encodes it. Loopback only, no dependencies beyond Node 20+, Piper and ffmpeg.
//
//   GET  /         { ok, presets, formats }
//   POST /speak    { text, preset?, format?, tune?, flatten? }  ->  audio (or { error, code })
//
// One Piper process per preset stays running (the model loads once), and one sentence is made
// at a time (it is CPU-bound), with a short queue. Settings come from the environment (see
// server/install-voice.sh); presets from FLATLINE_VOICE_PRESETS, re-read on restart.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { buildFilter, mergeEffects, FORMATS } from "./chain.mjs";
import { flatten } from "./flatten.mjs";

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

const log = (...a) => { if (env.NODE_ENV !== "test") console.log(...a); };

export function loadPresets(file = PRESETS_FILE) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const out = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]{1,40}$/.test(name) || !p || typeof p !== "object") continue;
    if (typeof p.voice !== "string" || !/^[A-Za-z0-9_.-]+$/.test(p.voice)) continue;
    out[name] = p;
  }
  return out;
}

/** Text Piper can take: no control characters, one line, trimmed. */
export function cleanText(t) {
  return String(t ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

// --- Piper: one long-running process per preset ------------------------------------------

const pipers = new Map();

function piperFor(name, p) {
  const have = pipers.get(name);
  if (have && !have.dead) return have;
  const model = join(VOICES, `${p.voice}.onnx`);
  const args = ["--model", model, "--json-input", "--quiet",
    "--length_scale", String(clamp(p.lengthScale, 0.5, 2, 1)),
    "--noise_scale", String(clamp(p.noiseScale, 0, 1.5, 0.667)),
    "--noise_w", String(clamp(p.noiseW, 0, 1.5, 0.8)),
    "--sentence_silence", String(clamp(p.sentenceSilence, 0, 2, 0.2))];
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
  pipers.set(name, proc);
  log(`piper started for ${name} (${p.voice})`);
  return proc;
}

/** Stop every Piper (on SIGTERM, and in tests). */
export function stopPipers() {
  for (const p of pipers.values()) { p.dead = true; p.child.kill(); }
  pipers.clear();
}

function clamp(v, min, max, fallback) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

function synthesize(name, p, text, wavPath) {
  const proc = piperFor(name, p);
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
export async function render(presets, { text, preset = "dixie", format = "m4a", tune, flatten: flat }) {
  const p = presets[preset];
  if (!p) throw Object.assign(new Error(`No preset "${preset}".`), { code: "unknown_preset", status: 404 });
  // A preset's "flatten" (or a request's, true or false, to compare) shapes the text first.
  if (typeof flat === "boolean" ? flat : p.flatten === true) text = flatten(text);
  const fmt = FORMATS[format];
  if (!fmt) throw Object.assign(new Error(`No format "${format}".`), { code: "bad_format", status: 400 });
  const dir = await mkdtemp(join(env.FLATLINE_VOICE_TMP ?? tmpdir(), "voice-"));
  try {
    const wav = join(dir, "raw.wav");
    const out = join(dir, `out.${fmt.ext}`);
    await synthesize(preset, p, text, wav);
    const filter = buildFilter(mergeEffects(p.effects ?? {}, tune ?? {}), sampleRate(p.voice));
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", filter, "-ac", "1", ...fmt.args, out]);
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
      if (req.method === "GET" && req.url === "/") return send(res, 200, { ok: true, presets: Object.keys(presets), formats: Object.keys(FORMATS) });
      if (req.method !== "POST" || req.url !== "/speak") return send(res, 404, { error: "Not found.", code: "not_found" });
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > MAX_CHARS * 4 + 4096) return send(res, 413, { error: "Too long.", code: "too_long" }); }
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "Send JSON: { text, preset, format }.", code: "bad_request" }); }
      const text = cleanText(body.text);
      if (!text) return send(res, 400, { error: "There's nothing to say.", code: "empty" });
      if (text.length > MAX_CHARS) return send(res, 413, { error: `Keep it under ${MAX_CHARS} characters.`, code: "too_long" });
      const started = Date.now();
      const out = await enqueue(() => render(presets, { text, preset: body.preset ?? "dixie", format: body.format ?? "m4a", tune: body.tune, flatten: typeof body.flatten === "boolean" ? body.flatten : undefined }));
      log(`spoke ${text.length} chars as ${body.preset ?? "dixie"}/${body.format ?? "m4a"} in ${Date.now() - started} ms`);
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
