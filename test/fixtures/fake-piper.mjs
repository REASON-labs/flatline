#!/usr/bin/env node
// Stands in for Piper in tests: for each JSON line, writes a short WAV to output_file and
// prints its path. A line whose text is "CRASH" makes it exit, like a broken model.
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify({ piper: process.argv.slice(2) }) + "\n");
const wav = () => { const n = 800, b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; };
createInterface({ input: process.stdin }).on("line", (line) => {
  const j = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify({ line: j }) + "\n");
  if (j.text === "CRASH") process.exit(3);
  const delay = j.text.startsWith("SLOW") ? 300 : 0;
  setTimeout(() => { writeFileSync(j.output_file, wav()); console.log(j.output_file); }, delay);
});
