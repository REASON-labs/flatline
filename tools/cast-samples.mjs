#!/usr/bin/env node
// Samples of the cast, to compare by ear: for each character, the same few lines
// (COMPARE_LINES) and then one line in character, through a real voice service.
//
//   FLATLINE_VOICE_URL=http://127.0.0.1:8087 node tools/cast-samples.mjs out/
//
// Writes out/<n>-<id>.mp3 (the compare lines, then the character's sample) and
// out/<n>-<id>-in-character.mp3 (the sample alone).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CAST, COMPARE_LINES } from "../dist/cast/index.js";
import { createSpeaker } from "../dist/server/index.js";

const OUT = process.argv[2] ?? "cast-samples";
const speaker = createSpeaker({ url: process.env.FLATLINE_VOICE_URL ?? "http://127.0.0.1:8087", timeoutMs: 120_000 });
mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const [i, c] of CAST.entries()) {
  for (const [file, text] of [[`${i + 1}-${c.id}.mp3`, `${COMPARE_LINES.join(" ")} ${c.sample}`], [`${i + 1}-${c.id}-in-character.mp3`, c.sample]]) {
    const r = await speaker.speak(text, { preset: c.preset, format: "mp3" });
    if (!r.ok) { failed++; console.error(`${c.id}: ${r.code} ${r.error}`); continue; }
    writeFileSync(join(OUT, file), r.audio);
    console.log(`${file}  ${c.name}  ${r.audio.byteLength} bytes in ${r.ms} ms`);
  }
}
process.exit(failed ? 1 : 0);
