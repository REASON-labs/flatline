# Dixie's voice: text to speech on your own server

`server/install-voice.sh` installs **flatline-voice**: [Piper](https://github.com/rhasspy/piper), a
fast speech engine that runs on the CPU, behind a small Node service that gives each **preset**
its sound with ffmpeg. It listens on **127.0.0.1:8087** only. Text goes to it and audio comes
back; nothing is sent anywhere else.

The **dixie** preset is the Dixie Flatline: a deep voice, slow and deliberate, pitched down,
compressed, with grit and a faint line or radio colour, still clear on a phone speaker. It
doesn't imitate any real person's voice: it is a stock voice with effects, tuned for character.

## Install

```bash
sudo bash server/install-voice.sh
```

It needs Node 20+ (already there if a Flatline app runs on the box) and installs ffmpeg. It
downloads Piper and the voice at pinned versions, checks their SHA-256, and starts the service.
It's safe to re-run, and it keeps your edited presets.

On a remote server, copy the `server/` folder over (the installer needs `server/voice/` next to it)
and run it there:

```bash
scp -r server you@your-server:/tmp/flatline-server
ssh -t you@your-server 'sudo bash /tmp/flatline-server/install-voice.sh'
```

| Variable | Default | |
|---|---|---|
| `FLATLINE_VOICE_PORT` | `8087` | loopback port |
| `FLATLINE_VOICE_EXTRA` | none | more Piper voices to fetch, e.g. `"en_US-joe-medium"`, to try in a preset |
| `FLATLINE_VOICE_RESET_PRESETS` | `0` | `1` replaces your presets with the shipped ones (a backup is kept) |
| `FLATLINE_VOICE_MEMORY_MAX` | `1G` | systemd memory cap |

On a 4-core server a sentence takes well under a second; one is made at a time, with a short
queue (a full queue answers "busy").

## Using it

From an app's backend:

```js
import { createSpeaker } from "flatline/server";
const voice = createSpeaker({ url: process.env.FLATLINE_VOICE_URL }); // http://127.0.0.1:8087

const r = await voice.speak("Check in before noon.", { preset: "dixie", format: "m4a" });
if (r.ok) sendVoiceMemo(r.audio, r.contentType);       // audio: Uint8Array, contentType: audio/mp4
else console.log(r.code, r.error);
```

| Format | Content type | Use |
|---|---|---|
| `m4a` (default) | `audio/mp4` | AAC: voice memos (Signal), iPhone |
| `mp3` | `audio/mpeg` | browsers (all of them, including iPhone Safari) |
| `ogg` | `audio/ogg` | Opus: small, for browsers that play it |
| `wav` | `audio/wav` | uncompressed |

Codes: `unavailable`, `empty`, `too_long` (over `maxChars`, default 1500), `unknown_preset`,
`busy`, `timeout`, `bad_response`. In the browser, `dixie.configure({ endpoint: "/api/voice/speak" })`
makes `dixie.speak()` use this voice through your app's endpoint (see
[INTEGRATION.md](INTEGRATION.md)), falling back to the phone's voice when the server can't speak.

The service's own API, for curl:

```bash
curl -s http://127.0.0.1:8087/                       # { ok, presets, formats }
curl -s -H 'content-type: application/json' \
  -d '{"text":"Listen up.","preset":"dixie","format":"mp3"}' \
  -o dixie.mp3 http://127.0.0.1:8087/speak
```

## Tuning the preset

Presets live in `/etc/flatline/voice-presets.json` (the shipped ones are in
`server/voice/presets.json`). Edit, then `sudo systemctl restart flatline-voice`.

```jsonc
"dixie": {
  "voice": "en_US-libritts_r-medium",  // a Piper voice in /var/lib/flatline/voices
  "speaker": 137,                      // for multi-speaker voices: which speaker
  "lengthScale": 1.15,                 // > 1 is slower, more deliberate
  "noiseScale": 0.55, "noiseW": 0.7,   // lower is steadier, flatter delivery
  "sentenceSilence": 0.4,              // seconds of pause between sentences
  "effects": {
    "pitch": 0.9,                          // 0.7..1.3: lower is deeper (the pace is kept)
    "highpass": 110, "lowpass": 5200,      // Hz: a narrower band sounds more like a line or radio
    "presence": { "freq": 1900, "gain": 3 },  // a bump where words are clearest
    "compress": { "threshold": -22, "ratio": 4 },
    "drive": 6,                            // dB into a soft clipper: grit (0 = clean)
    "echo": { "delay": 16, "decay": 0.15 },   // a short slap: "in the machine" (0 = off)
    "loudness": -16                        // LUFS, the final level
  }
}
```

To try changes without restarting, add `"tune"` to a request; it overrides the preset's
effects for that request only:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"text":"Listen up.","format":"mp3","tune":{"pitch":0.85,"drive":9,"lowpass":4200}}' \
  -o try.mp3 http://127.0.0.1:8087/speak
```

Every number is checked and kept in range before it reaches ffmpeg. For a phone speaker, keep
`lowpass` at 3500 or higher and `drive` at 12 or lower, or words start to blur.

**Choosing the voice.** `tools/voice-lab.mjs`, run in CI, sweeps every speaker of the
multi-speaker voice and the single voices below, measures each one's pitch, gives the deepest
ones the Dixie sound, and checks through whisper that the words come through. Its report and
samples (`dixie-*.mp3`, `plain-*.mp3`) are attached to each release, so you can choose by ear.

The 0.2.0 lab swept 908 voices. The default, **libritts_r speaker 137**, was the deepest
(about 86 Hz before Dixie's pitch drop), and whisper caught every word of the test script both
with and without the effects. The next deepest (499, 687, 797, 479, 36, then `john` and `joe`)
were nearly as clear. To try one, set `"speaker"` (or `"voice"` for `john`/`joe`, fetched with
`FLATLINE_VOICE_EXTRA`).

## Licences

Flatline's own code is MIT. It doesn't include or link any of the following: the installer
downloads them from their publishers, and the service runs Piper as a separate program.

| Part | Licence | Notes |
|---|---|---|
| Piper 2023.11.14-2 (rhasspy/piper) | MIT | the last MIT release; development continues as piper1-gpl (GPL-3.0), not used here |
| espeak-ng (inside Piper's download) | GPL-3.0 | Piper uses it to turn text into phonemes; it runs inside Piper's own process |
| Piper voice models (rhasspy/piper-voices) | MIT (the models) | each voice is trained on a dataset with its own licence, below |
| `en_US-libritts_r-medium` (the default) | CC BY 4.0 (LibriTTS-R) | free to use, commercially too, **with credit**: "Voice: Piper en_US-libritts_r, trained on LibriTTS-R (CC BY 4.0)" |
| `en_US-bryce`, `en_US-john`, `en_US-norman` | public domain | |
| `en_US-joe` | CC0 | (`en_US-mike`, also CC0, is too new for this Piper and won't load) |
| ffmpeg (Ubuntu's package) | LGPL/GPL | a separate program the service runs |

Voices with non-commercial licences (`en_US-ryan`, `en_US-hfc_male`, `en_US-l2arctic` among them)
are deliberately not used.

## What's installed where

| Path | |
|---|---|
| `/opt/flatline/piper` | Piper, its libraries and espeak-ng data |
| `/opt/flatline/voice` | the service (`server.mjs`, `chain.mjs`) |
| `/var/lib/flatline/voices` | voice models |
| `/etc/flatline/voice-presets.json` | your presets |
| `/etc/systemd/system/flatline-voice.service` | the unit (same hardening as flatline-whisper) |

```bash
systemctl status flatline-voice
journalctl -u flatline-voice -n 50
```
