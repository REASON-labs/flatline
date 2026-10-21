# Flatline

Self-hosted voice for web apps. Someone talks to your app on their phone; your own server turns
it into text; your app can answer out loud. **The audio never leaves your machine.**

Small pieces, no runtime dependencies:

| Piece | Runs | Does |
|---|---|---|
| **Speech-to-text service** (`server/install.sh`) | your server | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) at a pinned release, as a hardened systemd service on loopback |
| **`flatline/server`** | your app's backend (Node 20+) | sends audio to that service and returns clean text, with time and size limits and plain error codes |
| **Text-to-speech service** (`server/install-voice.sh`) | your server | [Piper](https://github.com/rhasspy/piper) at a pinned release, with a preset per character that gives the voice its sound through ffmpeg |
| **`flatline/browser`** | the phone's browser | records an answer and **stops by itself when the person stops talking**; sends it to your backend; and `dixie`, the speaker, which reads text aloud with the server's voice, or the phone's own when that isn't available |
| **`flatline/cast`** | anywhere (data) | **the cast**: six voice characters, each a sound (a preset), a tone guide for an assistant model, and a line set (briefings, reminders, wake-up calls, replies). [docs/CAST.md](docs/CAST.md) |

Named for the Dixie Flatline in *Neuromancer*: a voice in the machine that talks back. Since 0.3
she is **Flatline**, the default character of a cast: Flatline, Kestrel, Iris, Ashford, Hoshi and
Captain Calder (original characters, each only inspired by one from a story).
`flatline/server` also has `createSpeaker()`, for the voice: text in, M4A/MP3/Ogg/WAV out.

## How it fits together

```
 phone (browser)                     your server
 ───────────────                     ────────────────────────────────────────────
 record()  ── audio ──▶  your app's endpoint ──▶ flatline/server ──▶ whisper (127.0.0.1)
           ◀── { text } ─┘   (checks who is asking)       ◀── text ──┘
 dixie.speak("…")   (on the phone; nothing is sent)
```

The browser never talks to whisper directly: your app's endpoint decides who may send audio.
Whisper listens on loopback only.

## Install

```jsonc
"dependencies": { "flatline": "github:REASON-labs/flatline#v0.3.0" }
```

The built code is committed, so installing needs no build and no dev tools; pin a tag. A server
that can't read the repository can use the tarball attached to each release instead
(`"flatline": "file:vendor/flatline-0.3.0.tgz"`). See [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Quick start

**1. The service** (Debian or Ubuntu with systemd; about 500 MB for the default English model):

```bash
sudo bash server/install.sh
```

It builds whisper.cpp, downloads the model, and starts `flatline-whisper` on
`http://127.0.0.1:8086`. Options (model, language, port, threads) are at the top of the script and
in [docs/SERVER.md](docs/SERVER.md).

**2. Your backend:**

```js
import { createTranscriber } from "flatline/server";

const stt = createTranscriber({ url: process.env.FLATLINE_URL }); // http://127.0.0.1:8086

// In your POST handler, after checking the session:
const r = await stt.transcribe(audioBytes, request.headers["content-type"]);
if (r.ok) reply({ text: r.text });
else reply({ error: r.error }, r.code === "unavailable" ? 503 : 400);
```

A complete minimal server is in [examples/node-server.mjs](examples/node-server.mjs).
For the voices, see [docs/VOICE.md](docs/VOICE.md): install them, tune the presets, and the licences.
The characters and how to add one: [docs/CAST.md](docs/CAST.md). To change how one sounds in five
minutes: [Tweaking a voice](docs/TWEAKING-VOICES.md).

**3. The page** (call it from a tap: browsers allow the mic and speech only after one):

```js
import { record, transcribeOnServer, dixie } from "flatline/browser";

dixie.primeVoices();                       // once, early
await dixie.speak("When does your day usually start?");   // "done", or "cancelled"
const rec = record({ onLevel: (l) => meter(l) });   // also stops the speaker; 60 s at most
// rec.stop() keeps what was said; rec.cancel() throws it away.
const r = await rec.done;
if (r.ok) {
  const t = await transcribeOnServer("/api/voice/transcribe", r.audio);
  if (t.ok) showAnswer(t.text);
}
```

More in [docs/BROWSER.md](docs/BROWSER.md): the stop rules, error codes, iPhone notes, and
choosing the phone's voice. Adding it to an app with sign-ins (the endpoint, limits and the errors to
show): [docs/INTEGRATION.md](docs/INTEGRATION.md). Moving a box from an older hand-made
`whisper.service`: [docs/MIGRATING.md](docs/MIGRATING.md).

## Privacy

- Audio goes from the phone to **your** server and to whisper on loopback. No third party hears it.
- Nothing in Flatline stores audio. What your app keeps is up to your app.
- Without a server voice, `dixie` speaks with the phone's own voices (`speechSynthesis`), so the
  text it reads isn't sent anywhere by Flatline. (Some browsers offer network voices; it prefers
  on-device ones.)

## Development

```bash
npm install
npm test               # build, then unit and local-network tests
npx playwright install chromium
npm run test:browser   # recorder and speaker in a real Chromium with a fake microphone
npm run test:whisper   # against a real service: set FLATLINE_URL and FLATLINE_SAMPLES (CI does)
```

The code is TypeScript in `src/`, built to `dist/`, which is committed (apps install from git):
run `npm run build` and commit `dist/` with any change to `src/` (CI checks). Keep it
dependency-free at runtime. Releases: bump `version`, tag `vX.Y.Z`, attach `npm pack`'s tarball.

## Status

0.3: used in production by one app for voice memos (Signal), wake-up calls and a spoken setup
interview, with the cast.
The API may still change before 1.0.

## License

[MIT](LICENSE). whisper.cpp, which the speech-to-text service builds, is MIT too; the models it
downloads are OpenAI's Whisper models (MIT). The voice service runs Piper (MIT, which bundles
espeak-ng, GPL-3.0, in its own process) and the cast's voices: LibriTTS-R and VCTK (CC BY 4.0:
credit them), two public-domain LibriVox voices, and one Apache-2.0 voice.
Details in [docs/VOICE.md](docs/VOICE.md#licences).
