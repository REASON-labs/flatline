# Adding Flatline to an app with sign-ins

The shape that works: the phone records, sends the audio to **your** endpoint, your endpoint
checks who is asking and hands it to whisper, and the text comes back. Whisper itself is never
reachable from outside the server.

## Install

```jsonc
// package.json: once the repository is public, or wherever your server can read it
"dependencies": { "flatline": "github:REASON-labs/flatline#v0.1.2" }
```

The built code is committed, so installing needs no build step and no dev tools. Pin a tag.

While the repository is private, a server without GitHub access can't fetch it. Use the
release's tarball instead (it's attached to each GitHub release, or made with `npm pack`), kept
in your repository:

```jsonc
"dependencies": { "flatline": "file:vendor/flatline-0.1.2.tgz" }
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
| Recording length | 60 s (the browser's default for answers) | a spoken answer, not a podcast |
| Body size | 5 MB | a minute is 0.2 to 1 MB depending on the phone |
| Rate | about 20 per person per 10 minutes | each one keeps a CPU busy for seconds |
| Timeout | 60 s | the default model takes a few seconds for a short answer |

### Errors to show

| `code` (server) | Status | Show |
|---|---|---|
| `unavailable` | 503 | "Voice isn't working right now. You can type instead." |
| `timeout` | 504 | "That took too long. Try a shorter answer, or type it." |
| `too_large` | 413 | "That recording is too long. Try a shorter answer." |
| `empty` | 400 | "I didn't get any audio. Try again." |
| `bad_response` | 502 | "Voice isn't working right now. You can type instead." |

An empty transcript (`{ text: "" }`) means nothing was understood: "I didn't catch that."

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

## Tests in your app

`createTranscriber({ url, fetch })` takes a stand-in `fetch`, or give your endpoint any object
with a `transcribe(audio, type)` method returning `{ ok: true, text }`. In the browser,
Chromium's fake microphone (`--use-fake-device-for-media-stream`, with the microphone permission
granted to the context) drives `record()`; see `test/helpers.mjs` here.
