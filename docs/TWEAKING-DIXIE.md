# Tweaking Dixie

A five-minute guide to changing how Dixie sounds on your server. You'll need a shell on the server
(examples use `you@your-server`) and `sudo`.

## Where the settings are

```
/etc/flatline/voice-presets.json
```

Dixie is the `"dixie"` entry. After editing, apply it with:

```bash
sudo systemctl restart flatline-voice
```

Before your first edit, keep a copy:

```bash
sudo cp /etc/flatline/voice-presets.json /etc/flatline/voice-presets.json.bak
```

## The knobs

**How she speaks (Piper).** These need a restart to take effect.

| Knob | Range | What it does |
|---|---|---|
| `lengthScale` | 0.5–2 | **Pace.** Higher is slower. 1 is normal; 1.3 is slow and deliberate. |
| `noiseScale` | 0–1.5 | **Pitch wander.** Lower is flatter and steadier, with less rise at the end of sentences. Below about 0.25 she turns robotic. |
| `noiseW` | 0–1.5 | **Timing variation.** Lower gives more even, measured syllables. |
| `sentenceSilence` | 0–2 s | **Pause between sentences.** |
| `speaker` | a number | **Which voice**, for the multi-speaker voice (`en_US-libritts_r-medium` has 904). See "Other voices" below. |
| `voice` | a voice name | **A different voice model**, e.g. `en_US-joe-medium`. It must be installed (see "Other voices"). |
| `flatten` | true / false | **Flatter delivery from the text.** `!` becomes `.`, and a comma that ends a clause becomes a full stop, so her pitch falls instead of rising. Lists, numbers and questions are left alone. |

**How she's processed (effects, in `"effects"`).** These can also be tried per request, without a restart (see "Hear it first").

| Knob | Range | What it does |
|---|---|---|
| `pitch` | 0.7–1.3 | **Deeper or higher**, without changing the pace. 0.9 is a bit deeper; 0.8 is much deeper. |
| `highpass` | 0–400 Hz | **Cuts the boom.** Higher sounds thinner, like a phone line. |
| `lowpass` | 0–12000 Hz | **Cuts the air.** Lower sounds more muffled, like a radio. Keep it at 3500 or more, or words blur. |
| `presence` | `{ freq, gain }` | **A lift where words are clearest** (around 1500–2500 Hz, gain −12 to 12). More makes her more forward and cutting. |
| `compress` | `{ threshold, ratio }` | **Evens out loud and quiet.** A higher ratio (up to 20) is flatter and punchier; 1 turns it off. |
| `drive` | 0–24 dB | **Grit.** Pushes into soft distortion. 0 is clean, 6 is rough, 12 is harsh. Above 12, words start to suffer. |
| `echo` | `{ delay, decay }` | **A short slap**, "in the machine". A delay of 10–30 ms sounds metallic, longer sounds like a room. Decay 0 turns it off. |
| `loudness` | −30 to −8 | **Overall level** (LUFS). −16 suits phones; −14 is louder. |

## Hear it first

Run these on the server. They write an MP3 you can then copy to your own machine.

**Try effects without touching the file** (`tune` applies to this one request only):

```bash
curl -s -H 'content-type: application/json' \
  -d '{"text":"Listen up. You have three things to do today.","preset":"dixie","format":"mp3","tune":{"pitch":0.85,"drive":9}}' \
  -o /tmp/try.mp3 http://127.0.0.1:8087/speak
```

**Compare with and without `flatten`:** add `"flatten": false` (or `true`) to the same request.

**Try Piper settings** (pace, wander, speaker) with a scratch preset next to `dixie`, so the real
one stays untouched. In `/etc/flatline/voice-presets.json`, copy the whole `"dixie": { ... }` entry
as `"try": { ... }`, change what you like, restart, and ask for `"preset":"try"`:

```bash
sudo systemctl restart flatline-voice
curl -s -H 'content-type: application/json' \
  -d '{"text":"Listen up. You have three things to do today.","preset":"try","format":"mp3"}' \
  -o /tmp/try.mp3 http://127.0.0.1:8087/speak
```

**Listen on your own machine:**

```bash
scp you@your-server:/tmp/try.mp3 .
```

When you like it, copy those values into `"dixie"`, restart, and delete `"try"` if you want.

## Recipes

Start from the current values and change one thing at a time.

| You want | Change |
|---|---|
| **Deeper** | `pitch` down by 0.05 (to 0.85); or another, lower `speaker` |
| **Slower** | `lengthScale` up by 0.1; `sentenceSilence` up by 0.1 |
| **Flatter, less sing-song** | `flatten: true`; `noiseScale` down by 0.05 (not below 0.25); write statements with full stops |
| **Rougher** | `drive` up by 2–3; `lowpass` down to 4500; `presence.gain` up by 1 |
| **Cleaner** | `drive` 0–3; `echo.decay` 0; `lowpass` 7000 or more |
| **Louder** | `loudness` −14 (or −12 at the most) |
| **More "in the machine"** | `echo` `{ "delay": 20, "decay": 0.25 }`; `highpass` 200 |

A quick edit without opening an editor (here: slower, then restart):

```bash
sudo node -e '
const f = "/etc/flatline/voice-presets.json", fs = require("fs");
const p = JSON.parse(fs.readFileSync(f, "utf8"));
p.dixie.lengthScale = 1.4;
fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");' && sudo systemctl restart flatline-voice
```

## Other voices

To try another installed voice, set `"voice"` (and remove `"speaker"` for single-speaker voices).
To install more, re-run the installer with them listed; your presets are kept:

```bash
sudo FLATLINE_VOICE_EXTRA="en_US-joe-medium en_US-john-medium" bash install-voice.sh
```

The voice lab's samples (on each release) are the quickest way to choose a `speaker` by ear.

## Undo

- **Your last copy:** `sudo cp /etc/flatline/voice-presets.json.bak /etc/flatline/voice-presets.json && sudo systemctl restart flatline-voice`
- **The shipped defaults:** re-run the installer with `FLATLINE_VOICE_RESET_PRESETS=1`. It saves your current file as `voice-presets.json.<date>.bak` first.
- **The repository's defaults:** `server/voice/presets.json`, at the release you installed.

If the service doesn't come back after a restart, the file probably isn't valid JSON. Check with
`journalctl -u flatline-voice -n 20`, fix it or restore the `.bak`, and restart.
