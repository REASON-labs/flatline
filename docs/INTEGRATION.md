# Adding Flatline to an app with sign-ins

The shape that works: the phone records, sends the audio to **your** endpoint, your endpoint
checks who is asking and hands it to whisper, and the text comes back. Whisper itself is never
reachable from outside the server.

## Install

```jsonc
// package.json: once the repository is public, or wherever your server can read it
"dependencies": { "flatline": "github:REASON-labs/flatline#v0.8.0" }
```

The built code is committed, so installing needs no build step and no dev tools. Pin a tag.

While the repository is private, a server without GitHub access can't fetch it. Use the
release's tarball instead (it's attached to each GitHub release, or made with `npm pack`), kept
in your repository:

```jsonc
"dependencies": { "flatline": "file:vendor/flatline-0.8.0.tgz" }
```

and make sure your deploy copies `vendor/` to the server before `npm ci`.

## The server endpoint

```
POST /api/voice/transcribe
  headers: your session (cookie or header), content-type: the recording's type
  body:    the audio, as is (not form data)
→ 200 { "text": "…" }
→ 4xx/5xx { "error": "a sentence to show" }
```

```js
import { createTranscriber } from "flatline/server";

const stt = createTranscriber({
  url: process.env.FLATLINE_URL,   // http://127.0.0.1:8086; unset = voice is off
  maxBytes: 5 * 1024 * 1024,       // a minute of speech is well under 1 MB
  timeoutMs: 60_000,
});

app.post("/api/voice/transcribe", async (c) => {
  const who = c.get("actor");                       // 1. signed in, in their own space
  if (!who) return c.json({ error: "Not signed in." }, 401);
  if (!stt.configured) return c.json({ error: "Voice isn't set up on this server." }, 503);
  if (rateLimited(`voice:${who.id}`, 20, 10 * 60_000))   // 2. a CPU-heavy request: limit it
    return c.json({ error: "That's a lot of recordings. Give it a few minutes." }, 429);
  const type = c.req.header("content-type") ?? "";
  if (!type.startsWith("audio/")) return c.json({ error: "That isn't a recording." }, 415);
  const audio = new Uint8Array(await c.req.arrayBuffer());   // 3. cap the body in your server too
  const r = await stt.transcribe(audio, type);
  if (r.ok) return c.json({ text: r.text });        // 4. don't keep the audio
  return c.json({ error: MESSAGES[r.code] }, STATUS[r.code]);
});
```

Also tell the page whether voice is available (for example a `voice: stt.configured` field in
whatever status call the app already makes), so it can hide the mic instead of failing later.

### Limits

| | Suggested | Why |
|---|---|---|
| Recording length | 60 s (the browser's default for answers); 180 s for a memo (`recordMemo()`) | a spoken answer, not a podcast; a memo says a few things |
| Body size | 5 MB for answers; 10 MB if you take memos | a minute is 0.2 to 1 MB depending on the phone |
| Rate | about 20 per person per 10 minutes | each one keeps a CPU busy for seconds |
| Timeout | 60 s for answers; 120 s for memos | the default model takes a few seconds for a short answer, and longer in proportion |

### Errors to show

| `code` (server) | Status | Show |
|---|---|---|
| `unavailable` | 503 | "Voice isn't working right now. You can type instead." |
| `timeout` | 504 | "That took too long. Try a shorter answer, or type it." |
| `too_large` | 413 | "That recording is too long. Try a shorter answer." |
| `empty` | 400 | "I didn't get any audio. Try again." |
| `bad_response` | 502 | "Voice isn't working right now. You can type instead." |
| `busy` | 503 | "Voice is busy right now. Try again in a minute, or type." (only from an `"openai"` backend: its rate limit) |

An empty transcript (`{ text: "" }`) means nothing was understood: "I didn't catch that."

## Backends

`createTranscriber` and `createSpeaker` take either one `url` (your own service, as above) or
`backends`: a list, tried in order. A backend is one of your own services, or anything that
speaks OpenAI's audio API, which several cloud services and self-hosted servers do. For example,
with Groq's address:

```js
import { createTranscriber, createSpeaker } from "flatline/server";

const stt = createTranscriber({
  backends: [
    { kind: "whispercpp", url: process.env.FLATLINE_URL },          // your own server first
    { kind: "openai", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3",
      apiKey: process.env.GROQ_API_KEY, timeoutMs: 30_000 },        // then the cloud one
  ],
  maxBytes: 10 * 1024 * 1024,
});

const voice = createSpeaker({
  backends: [
    { kind: "flatline", url: process.env.FLATLINE_VOICE_URL },      // the cast's voices
    { kind: "openai", url: "https://api.groq.com/openai/v1", model: "canopylabs/orpheus-v1-english",
      voice: "troy", apiKey: process.env.GROQ_API_KEY, maxChars: 200 },
  ],
});

const r = await stt.transcribe(audio, type);
if (r.ok) log(`transcribed by backend ${r.via.index} (${r.via.kind}) in ${r.ms} ms`);
```

- **Order.** The first backend is asked first. The next is tried only when one can't be
  reached, times out, or answers 429 or 5xx. Audio that is empty or too large, text that is
  empty or too long, and any other 4xx (a bad file, a refused key, an unknown preset) are
  answered at once: another backend wouldn't help. When all fail, you get the last one's reason.
- **`via`.** Every answer that came from a backend says which: `{ index, kind }`, `index` being
  its place in your list (0 first). Log it; it's how you know your own server is the one working.
- **A backend with no `url`** (an unset environment variable) is left out, so one list serves a
  box with and without its own services. `configured` is true if any is left; `health()` is
  true if any is up (for `"openai"`, `GET {url}/models` answers 200).
- **`"openai"` for speech to text** posts multipart to `{url}/audio/transcriptions`: `file`,
  `model`, `response_format=json`, `temperature=0`, and `language` when you set one.
- **`"openai"` for the voice** posts JSON to `{url}/audio/speech`: `model`, `input`, `voice`,
  `response_format: "wav"`. Text over the backend's `maxChars` (default 200) is split at
  sentence ends (then commas, then spaces) and the WAVs joined into one. **The audio is always
  WAV**: if you asked for `m4a`, `mp3` or `ogg`, the result says so (`format: "wav"`,
  `contentType: "audio/wav"`, and a `note`), and converting is your app's job. Presets, `tune`,
  `pace` and `pauses` belong to the `"flatline"` kind and aren't sent: the voice is the one
  named in the backend.
- **Keys.** Read the key from the environment, on the server. It is sent only to its backend,
  as a Bearer token, and is never part of an error. Don't send `r.error` from a cloud backend
  to the page as is if you'd rather not show a service's wording; the codes are enough.
- **Privacy.** With a cloud backend in the list, audio (or the text to speak) can leave your
  server. Say so in your app, and list only what you mean to use: Flatline adds nothing.

`{ url }` alone is one `"whispercpp"` (or `"flatline"`) backend, and behaves as it did in 0.7.

## The page

```js
import { record, canRecord, transcribeOnServer, dixie } from "flatline/browser";

dixie.primeVoices();                        // once, early: loads the voices

async function ask(question) {
  await dixie.speak(question);              // resolves when she's done, or "cancelled"
}

async function answer() {                   // on a tap on the mic (this also stops Dixie)
  const rec = record();                     // stops 1.5 s after they stop talking; 60 s at most
  const r = await rec.done;
  if (!r.ok) return showProblem(r.code);    // denied, no_mic, no_speech, unsupported, failed
  const t = await transcribeOnServer("/api/voice/transcribe", r.audio);
  if (t.ok) putInTheAnswerBox(t.text);      // let them check or edit it before sending
  else showProblem(t.error);
}
```

Show the mic only when `canRecord()` is true and the server says voice is available. Typing must
always work: voice is a way to fill the box, not the only way.

| `record()` code | Show |
|---|---|
| `denied` | "The microphone isn't allowed. You can allow it in the browser's settings, or type." |
| `no_mic` | "No microphone was found. You can type instead." |
| `no_speech` | "I didn't hear anything. Tap the mic and try again." |
| `unsupported` | hide the mic |
| `failed` | "The microphone didn't start. You can type instead." |
| `cancelled` | nothing |

Speech that reads questions aloud should be something the person turns on (a speaker button,
remembered on the device), not a surprise in a quiet room.

## The voice (text to speech)

The same shape the other way round: the page asks your endpoint to speak, your endpoint checks
the session and asks flatline-voice, and the audio comes back.

```
POST /api/voice/speak
  headers: your session, content-type: application/json
  body:    { "text": "…", "preset": "kestrel", "format": "mp3" }   // preset: optional
→ 200 audio (the content type of the format)
→ 4xx/5xx { "error": "…" }
```

```js
import { createSpeaker } from "flatline/server";
import { CAST } from "flatline/cast";
const voice = createSpeaker({ url: process.env.FLATLINE_VOICE_URL, maxChars: 600 }); // http://127.0.0.1:8087

app.post("/api/voice/speak", async (c) => {
  if (!c.get("actor")) return c.json({ error: "Not signed in." }, 401);
  if (rateLimited(`speak:${c.get("actor").id}`, 60, 10 * 60_000)) return c.json({ error: "Slow down." }, 429);
  const { text, preset, format } = await c.req.json();
  // Only presets you allow: the cast's, and plain (CAST from flatline/cast). None: the service's default.
  const allowed = [...CAST.map((ch) => ch.preset), "plain"];
  const r = await voice.speak(text, { preset: allowed.includes(preset) ? preset : undefined, format: format === "m4a" ? "m4a" : "mp3" });
  if (!r.ok) return c.json({ error: r.error }, r.code === "busy" ? 503 : r.code === "unavailable" ? 503 : 400);
  return c.body(r.audio, 200, { "content-type": r.contentType, "cache-control": "no-store" });
});
```

Slow guidance (meditation, wind-down) can pass `pace` and `pauses` through the same call:
`voice.speak(text, { preset, pace: 0.75, pauses: { stop: 1.2 } })` (docs/VOICE.md, "Pace and
pauses"). Keep the values your app uses to a fixed few: each pace is its own Piper process.

On the page, once: `dixie.configure({ endpoint: "/api/voice/speak" })`. Then `dixie.speak(q)`
uses her voice (MP3 plays everywhere, including iPhone Safari), resolves `"done"` or `"cancelled"`
as before, and falls back to the phone's voice if the endpoint fails or takes over 15 s. For a
voice memo (Signal), ask for `format: "m4a"` server-side and send the bytes as an attachment.

Only let the page choose among presets you allow, and cap the text: anyone signed in can make
the CPU talk. Some voices are CC BY 4.0: credit the one in use somewhere in your app (an "About" or "Credits"
line): each character's `voice.credit` has the words.

## Characters

Let each person pick a character (or none), store its id, and use it everywhere the app speaks or
writes: the assistant's tone (`toneGuide(c)`), the fixed messages (`linesFor(c)` and `fill()`) and
the preset for voice memos (`c.preset`). Offer a "hear a sample" button that speaks `c.sample` with
`c.preset`. With none, use `plainLines` and the `plain` preset. Details: [CAST.md](CAST.md).

## Tests in your app

`createTranscriber({ url, fetch })` takes a stand-in `fetch`, or give your endpoint any object
with a `transcribe(audio, type)` method returning `{ ok: true, text }`. In the browser,
Chromium's fake microphone (`--use-fake-device-for-media-stream`, with the microphone permission
granted to the context) drives `record()`; see `test/helpers.mjs` here.
