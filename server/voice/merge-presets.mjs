#!/usr/bin/env node
// Bring new presets (a new character) into someone's edited presets file without touching what
// they have. Run by install-voice.sh; pure, so it is tested on its own.
//
//   node merge-presets.mjs /etc/flatline/voice-presets.json shipped-presets.json
//
// Rules: a preset already in the file is never changed. A shipped preset that isn't there is
// added. One exception, for the rename of dixie to flatline: if the file has its own "dixie" and
// no "flatline", "flatline" is added as a copy of THEIR dixie (their tuning), not the shipped one.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** { merged, added }: the file's presets with the missing shipped ones added. */
export function mergePresets(current, shipped) {
  const merged = { ...current };
  const added = [];
  for (const [name, p] of Object.entries(shipped)) {
    if (name in merged) continue;
    const theirs = current.dixie;
    if (name === "flatline" && theirs && typeof theirs === "object" && typeof theirs.voice === "string") {
      merged.flatline = { ...theirs, about: p.about ?? theirs.about };
    } else {
      merged[name] = p;
    }
    added.push(name);
  }
  return { merged, added };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, shippedFile] = process.argv.slice(2);
  const { merged, added } = mergePresets(JSON.parse(readFileSync(file, "utf8")), JSON.parse(readFileSync(shippedFile, "utf8")));
  if (added.length) writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  console.log(added.length ? `Presets added: ${added.join(", ")} (yours are unchanged).` : "Presets: nothing new to add.");
}
