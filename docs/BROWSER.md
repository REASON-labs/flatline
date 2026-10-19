# In the browser

`flatline/browser` has three parts: **record** an answer, **send** it to your server, and
**Dixie**, who reads text aloud. All of it needs a secure page (https, or localhost) and starts
from a tap: browsers allow the microphone and speech only after the person does something.

## Recording

```js
import { record, canRecord } from "flatline/browser";

if (!canRecord()) showTypingInstead();
const rec = record({
  silenceMs: 1500,   // quiet this long after speaking ends it
  noSpeechMs: 8000,  // nothing said this long from the start: give up
  maxMs: 60000,      // hard limit
  onLevel: (l) => {},  // 0..1, ~20 times a second, for a meter
  onState: (s) => {},  // "waiting" -> "speaking" <-> "trailing"
  hushDixie: true,     // stop Dixie first (default), so a tap on the mic interrupts her
});
```

The defaults (`ANSWER_DEFAULTS`) suit a spoken answer: 60 s at most, 1.5 s of quiet ends it,
8 s of nothing gives up. Every option is optional:

```js
const r = await record().done;   // or rec.done, from above
```

`r` is either `{ ok: true, audio, type, ms, reason }`, where `reason` is `"silence"`, `"max"` or
`"stopped"` (you called `rec.stop()`), or `{ ok: false, code, error }`:

| `code` | Meaning | Suggested response |
|---|---|---|
| `unsupported` | no mic API (old browser, or not https) | offer typing |
| `denied` | mic permission refused | say how to allow it; offer typing |
| `no_mic` | no microphone | offer typing |
| `no_speech` | nothing heard before `noSpeechMs` | "I didn't catch that", try again |
| `cancelled` | you called `rec.cancel()` | nothing |
| `failed` | anything else | offer typing |

### How it decides you've stopped

It measures loudness about 20 times a second and learns the room's background level from the
quietest moments, so a fan or traffic isn't mistaken for talking. Speech is anything three times
the background (and above a small floor) for at least 200 ms in a row; a cough or a bump is
shorter. After speech, 1.5 s of quiet ends it. All of these are options (`ratio`, `floor`,
`minSpeechMs`, `silenceMs`). The logic is `SilenceDetector`, usable on its own.

### Formats

Chrome, Edge and Firefox record WebM or Ogg (Opus); Safari records MP4 (AAC). The service's
`--convert` reads them all, so send the blob as it is, with its type.

## Sending it

```js
import { transcribeOnServer } from "flatline/browser";
const t = await transcribeOnServer("/api/transcribe", r.audio, { headers: { "x-session": token } });
// { ok: true, text } or { ok: false, status, error }
```

It POSTs the audio as the raw body with its content type, and expects `{ text }` back (or
`{ error }` with an error status), which is what `examples/node-server.mjs` answers.

## Dixie

```js
import { dixie } from "flatline/browser";
dixie.primeVoices();                                      // once, early (see iPhone notes)
await dixie.speak("When does your day usually start?");   // resolves when it's been said
dixie.hush();                                             // stop now: speak resolves "cancelled"
dixie.speaking();                                         // is she talking?
```

A new `speak()` cuts off the one before (which resolves `"cancelled"`), and `record()` hushes her
unless told not to. Browsers disagree on how a cancel is reported; Dixie always says
`"cancelled"`. If a browser never reports the end of a sentence (Safari, now and then), `speak()`
resolves `"done"` after about twice the time it should have taken.

Options: `lang` (default: the page's language), `voice` (a name the phone lists), `rate` (0.5 to
2), `pitch`. Dixie picks the best voice for the language: the exact language first, then the
better-sounding ones (Apple's "Enhanced"/"Premium", Google's and Microsoft's "Natural"/"Neural"),
on-device before network voices, and never the novelty voices some systems ship.

`speak` resolves to `"done"`, `"cancelled"` (something else was said, or `hush()`),
`"unavailable"` (no speech in this browser) or `"failed"`.

## iPhone notes

- The first `speak()` must come from a tap, with nothing awaited in between. `speak()` therefore
  starts at once with the voices already loaded: call `primeVoices()` early (on page load) so the
  better voice is there by the first question. Without it, the phone's default voice for the
  language is used.
- Better voices can be downloaded in Settings → Accessibility → Spoken Content → Voices; Dixie
  picks them up automatically.
- Speaking and recording at once doesn't work well; `record()` stops Dixie first for that reason.
