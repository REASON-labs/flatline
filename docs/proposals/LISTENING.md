# Proposal: listening tools in Flatline

Status: proposal (2026-10-24). Nothing here is built yet in Flatline.

An app that uses Flatline built a "listening lab" to tune its voices: it measures every clip
(loudness, peaks, silence, pace, pitch at line ends), runs each through whisper to check it's
understood, and renders blind A/B pairs for a person to judge. Most of that is about voices, not
about the app, so it belongs here where every app and every character benefits. This document
says what to move into Flatline, in what order, and what stays in apps.

## What the measurements found (five characters, 17 lines each)

| | Finding |
|---|---|
| Loudness | -16.0 to -17.7 LUFS across characters, ±1 LU within one: the presets' `loudness` works |
| Peaks | about -1.3 dBFS at worst: no clipping |
| Line endings | no line ended on a rise of more than 1.5 semitones: `flatten` and full stops work |
| Understood | whisper heard 99% of words right (word error rate 0 to 1.4% per character; one character word-perfect). The one repeated slip: "Feel *where* you are…" heard as "why" in two voices, a weak word worth rewording around rather than a voice problem |
| **Pace** | **171-235 words a minute.** Fine for reminders; too fast for slow, spoken guidance (meditation and wind-down scripts run at about 110-140). There's no way to slow a character for one app without changing its preset for every app. |

## 1. Pace and pauses per request (do first)

`POST /speak` accepts `tune`, but only for effects; how fast a character speaks (`lengthScale`)
and how long it pauses (`pauses`) are fixed per preset. Add two request fields:

```jsonc
{ "text": "...", "preset": "hoshi",
  "pace": 0.75,                                   // 0.6..1.4 × the preset's speed (lower = slower)
  "pauses": { "stop": 1.2, "clause": 0.5 } }      // seconds, merged over the preset's pauses
```

- `pace` divides the preset's `lengthScale` (clamped to Piper's 0.5..2). Piper processes are
  already keyed by voice and `lengthScale` (`piperKey`), so a new pace starts its own process:
  round `pace` to 0.05 steps and cap live processes (oldest idle one closes first) so a client
  can't start dozens.
- `pauses` reuses `pausesOf`; clamp each to 0..3 s.
- `createSpeaker().speak(text, { pace, pauses })` passes them through; `tools/cast-samples.mjs`
  gains `--pace`.
- Tests: clamping and rounding in `pausesOf`/a new `paceOf` (pure), the process cap, and a CI
  check that `pace: 0.75` makes the same line about a third longer.

## 2. `flatline/listen`: measuring audio (pure, no dependencies)

A module that runs in the browser and in Node on raw samples:

| Function | Answers |
|---|---|
| `loudness(channels, rate)` | ITU-R BS.1770-4 integrated loudness (LUFS), gated |
| `shortTerm(...)` | loudness over a 3 s window, for curves |
| `peak(...)` | highest sample, dBFS |
| `edges(...)` | silence before the first word and after the last (checks `leadIn`/`tail`) |
| `pace(text, channels, rate)` | words a minute while speaking |
| `pitchContour(...)` | the voice's pitch over a line, and whether it ends on a rise |
| `brightness(...)`, `spectrogram(...)` | where the energy sits; data for a picture |

The app's version is tested against signals with known answers (a full-scale 1 kHz tone reads
-3.01 LUFS, the BS.1770 reference; stereo is +3.01; gating ignores silence; a synthetic rising
line is caught) and can move over with its tests. It decodes nothing itself: callers pass
samples (Web Audio's `decodeAudioData` in a browser; WAV from the service in Node).

Uses: a CI check that no preset drifts (louder, faster, a new rising ending) when Piper or a
preset changes; the cast's "ends in a full stop" rule measured instead of assumed.

## 3. `tools/clip-check.mjs`: does every line come through?

For a list of lines × characters: speak each, measure it with `flatline/listen`, transcribe it
with whisper and score the word error rate against the line. One report (JSON plus a short table):
per character the mean loudness and spread, peaks, pace, rising endings, and every line whisper
misheard. It generalises `tools/voice-lab.mjs` (which already does the whisper round trip for
choosing voices) to whole line sets, and suits CI before a release.

## 4. Pre-rendered bundles for apps that stay on the device

Some apps never send text to a server at run time (everything stays on the phone). They can
still use the cast by recording their fixed lines ahead of time:

- `tools/bundle.mjs --lines lines.txt --characters hoshi,iris --out public/voices` writes one
  clip per line per character and a `manifest.json`.
- Clips are named by a **line key**: FNV-1a (32-bit, hex) of the line normalised (lower case,
  single spaces, list marks, wrapping quotes and end punctuation removed). Export `lineKey()`
  from `flatline/cast` so the app finds the clip for a line however it's spaced or capitalised.
- `dixie` (the browser speaker) gains a bundle source: play the clip when the line has one,
  fall back to the phone's voice when it doesn't.

## 5. Blind A/B pages (optional)

`tools/compare.mjs` renders takes (two paces, two presets, two effect settings) and writes one
static HTML page: takes labelled A/B in random order, a pick per pair, and the votes as JSON to
copy back. No server, so it fits the loopback rule. Useful when tuning a new character by ear.

## What stays in apps

The app's own sound: music and ambience, crossfades, how far music dips under the voice. One
guideline from those measurements is worth adding to docs/INTEGRATION.md: **the voice should sit
at least 10 dB above whatever plays under it** (12-15 dB measured comfortable), measured with
`shortTerm` over the spoken line.

## Order

1. Pace and pauses per request (small server change; unblocks slower characters everywhere).
2. `flatline/listen` with its tests.
3. `tools/clip-check.mjs` (uses 2).
4. Bundles and `lineKey()`.
5. Compare pages, if tuning by ear keeps coming up.
