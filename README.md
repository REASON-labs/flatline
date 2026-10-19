# Flatline

Self-hosted voice for web apps. Someone talks to your app on their phone; your own server turns
it into text; your app can answer out loud. **The audio never leaves your machine.**

Three small pieces, no runtime dependencies:

| Piece | Runs | Does |
|---|---|---|
| **Speech-to-text service** (`server/install.sh`) | your server | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) at a pinned release, as a hardened systemd service on loopback |
| **`flatline/server`** | your app's backend (Node 20+) | sends audio to that service and returns clean text, with time and size limits and plain error codes |
| **`flatline/browser`** | the phone's browser | records an answer and **stops by itself when the person stops talking**; sends it to your backend; and **Dixie**, a voice that reads text aloud using the phone's own speech |

Named for the Dixie Flatline in *Neuromancer*: a voice in the machine that talks back.

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
"dependencies": { "flatline": "github:REASON-labs/flatline#v0.1.1" }
```

The built code is committed, so installing needs no build and no dev tools; pin a tag. A server
that can't read the repository can use the tarball attached to each release instead
(`"flatline": "file:vendor/flatline-0.1.1.tgz"`). See [docs/INTEGRATION.md](docs/INTEGRATION.md).

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

**3. The page** (call it from a tap: browsers allow the mic and speech only after one):

```js
import { record, transcribeOnServer, dixie } from "flatline/browser";

dixie.primeVoices();                       // once, early
await dixie.speak("When does your day usually start?");   // "done", or "cancelled"
const rec = record({ onLevel: (l) => meter(l) });   // also stops Dixie; 60 s at most
// rec.stop() keeps what was said; rec.cancel() throws it away.
const r = await rec.done;
if (r.ok) {
  const t = await transcribeOnServer("/api/voice/transcribe", r.audio);
  if (t.ok) showAnswer(t.text);
}
```

More in [docs/BROWSER.md](docs/BROWSER.md): the stop rules, error codes, iPhone notes, and
choosing Dixie's voice. Adding it to an app with sign-ins (the endpoint, limits and the errors to
show): [docs/INTEGRATION.md](docs/INTEGRATION.md). Moving a box from an older hand-made
`whisper.service`: [docs/MIGRATING.md](docs/MIGRATING.md).

## Privacy

- Audio goes from the phone to **your** server and to whisper on loopback. No third party hears it.
- Nothing in Flatline stores audio. What your app keeps is up to your app.
- Dixie speaks with the phone's own voices (`speechSynthesis`), so the text it reads isn't sent
  anywhere by Flatline. (Some browsers offer network voices; Dixie prefers on-device ones.)

## Development

```bash
npm install
npm test               # build, then unit and local-network tests
npx playwright install chromium
npm run test:browser   # recorder and Dixie in a real Chromium with a fake microphone
npm run test:whisper   # against a real service: set FLATLINE_URL and FLATLINE_SAMPLES (CI does)
```

The code is TypeScript in `src/`, built to `dist/`, which is committed (apps install from git):
run `npm run build` and commit `dist/` with any change to `src/` (CI checks). Keep it
dependency-free at runtime. Releases: bump `version`, tag `vX.Y.Z`, attach `npm pack`'s tarball.

## Status

0.1: used in production by one app for voice memos (Signal) and soon a spoken setup interview.
The API may still change before 1.0.

## License

[MIT](LICENSE). whisper.cpp, which the service builds, is MIT too; the models it downloads are
OpenAI's Whisper models (MIT).
