#!/usr/bin/env node
// Stands in for ffmpeg in tests: copies -i INPUT to the last argument and logs the arguments.
import { copyFileSync, appendFileSync } from "node:fs";
const a = process.argv.slice(2);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ ffmpeg: a }) + "\n");
if (process.env.FAKE_FFMPEG_FAIL) { console.error("boom"); process.exit(1); }
copyFileSync(a[a.indexOf("-i") + 1], a[a.length - 1]);
