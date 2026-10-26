# The cast

Flatline's voice is a cast of characters, not one voice. An app lets each person pick one (or
none). A character is three things, kept together as data in `flatline/cast`:

1. **A sound**: a preset on the voice service (`server/voice/presets.json`): a Piper voice, its
   pace, and effects through ffmpeg.
2. **A tone guide**: how they talk, for an assistant model to follow (`toneGuide(c)`).
3. **A line set**: the fixed messages an app sends: the morning briefing, event reminders,
   tomorrow's preview, calendar changes, the wake-up escalation (each step, the call, "you're up",
   the note to a partner) and the replies to a message in (help, ready, applied, dropped and the rest).

Every character is original. Each is only *inspired by* a character from a story: none imitates
a real actor's voice, and none uses a famous catchphrase or quote.

| id | Name | Like | Inspired by | Voice (licence) | Flatten |
|---|---|---|---|---|---|
| `flatline` | Flatline (the default) | gravelly, slow, blunt orders | the Dixie Flatline (*Neuromancer*) | `en_US-libritts_r-medium` speaker 137 (CC BY 4.0) | on |
| `kestrel` | Kestrel | calm, clipped, tactical: your day is an operation | the Major (*Ghost in the Shell*) | `en_US-kristin-medium` (public domain) | on |
| `iris` | Iris | serene, very polite, faintly unsettling | HAL 9000 (*2001: A Space Odyssey*) | `en_GB-cori-medium` (public domain) | on |
| `ashford` | Ashford | dry English butler, efficient, quietly witty | JARVIS (the *Iron Man* films) | `en_GB-vctk-medium` speaker 95 (CC BY 4.0) | on |
| `hoshi` | Hoshi | soft, warm caretaker: the gentlest | Baymax (*Big Hero 6*) | `en_US-sam-medium` (Apache-2.0) | off |
| `calder` | Captain Calder | calm command, measured and decisive | a starship captain of the Picard kind | `en_GB-vctk-medium` speaker 76 (CC BY 4.0) | on |
| `nettle` | Nettle | sarcastic, bored-cool, bossy: a best friend who rolls her eyes and is on your side | Shego (*Kim Possible*), with no names or references | `en_US-libritts_r-medium` speaker 480 (CC BY 4.0) | on |

`dixie` is Flatline's old name: `character("dixie")` is Flatline, and the `dixie` preset is
`{ "sameAs": "flatline" }`. With no character, an app uses `plainLines` and the `plain` preset.
Licences and credit lines: [VOICE.md](VOICE.md#licences).

## The rules every character follows

Not negotiable, whatever the tone:

- **Nothing shaming, no guilt.** Never mention what they didn't do; never count misses or streaks.
- **On a rough day the order is rest.** Worn down, sick, a rough stretch: rest comes first.
- **Nothing private on a lock screen.** Lines marked "text" in `LineSet` may be shown on a lock
  screen: counts only, never a title. Spoken lines (heard only when a memo is played) may say more.
- **Short sentences ending in full stops.** A comma or "!" makes Piper's pitch rise; a full stop
  makes it fall. No commas, no "!", no "?" in the lines.
- **No emoji.**
- **YES, NO and STOP** are the words the app listens for: the inbox lines use them exactly.

`RULES` holds them in words for a model; `toneGuide(c)` is the character's tone plus `RULES`.
`test/cast.test.mjs` checks every line of every character against them.

## Using it

```js
import { CAST, DEFAULT_CHARACTER, character, toneGuide, linesFor, fill, changesVars } from "flatline/cast";

const c = character(profile.voice ?? DEFAULT_CHARACTER);  // undefined: no character
const L = linesFor(c);                                    // plain lines when there's none

system += "\n\n" + toneGuide(c);                          // an assistant model talks like them
const spoken = fill(L.event.soon, { title: "Dentist", n: 10 });         // "Dentist. In 10 minutes. Get moving."
const text = fill(L.inbox.ready, { ...changesVars(2), name: "MyApp" }); // "2 changes ready. Reply YES to run them. ..."
await speaker.speak(spoken, { preset: c?.preset ?? "plain" });
```

Placeholders: `{name}` (the app), `{n}` (a number, as it should be said), `{time}`, `{title}`
(spoken lines only), `{who}` (the partner note), `{changes}` and `{them}` (`changesVars(n)`),
`{error}` and `{memo}` (the inbox's "failed"). `fill()` drops a placeholder with no value.
The wake-up has eight steps: at the time, then 5, 10, 20, 30, 40, 50 and 60 minutes past (`wake.steps`, for a morning marked important).
An ordinary morning is `wake.rise`: three nudges, at the time, 5 and 15 minutes past, then quiet; `wake.snoozed` answers "10 more minutes" (0.5.0).

**Pick up the pace (0.7.0).** `pace` is for someone getting ready for work who is running out of time, in the
character's own voice but firmer: `pace.steps` has four spoken nudges (at about three quarters of their target with
`{n}` minutes left and `{time}` out the door, at `{time}`, then 10 and 20 minutes past as `{n} minutes past {time}`),
`pace.text` and `pace.textLate` are the lock-screen versions, and `pace.notStarted` / `pace.textNotStarted` are for
when it's time to start getting ready and they haven't. Firm is still never cruel: no "late", no "slow", nothing
about other mornings. An app should send these only to someone who switched them on, and stop the moment they're
ready or out the door.

**An important to-do that's overdue (0.7.0).** `overdue.spoken` names it (`{title}`, spoken only) and says to do it
today; `overdue.text` is the count (`{n}`) for a lock screen. Neither counts days.

`c.sample` is one line in character, for a "hear a sample" button. `COMPARE_LINES` are the same
few lines for every character, for comparing them by ear: `tools/cast-samples.mjs` makes an MP3
of each through a voice service (`FLATLINE_VOICE_URL=http://127.0.0.1:8087 node tools/cast-samples.mjs out/`).

## Adding a character

1. **Pick a voice** from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) whose
   MODEL_CARD names a licence that allows commercial use (public domain, CC0, CC BY, Apache-2.0,
   MIT). Skip non-commercial (NC) licences and cards that only say "see URL". Check it loads in
   the pinned Piper (some newer voices don't): `tools/voice-lab.mjs` reports those.
2. **Pin it** in `server/install-voice.sh`: add it to `CAST_VOICES` and its two files' SHA-256 to
   `VOICE_SHA`. Add its licence (and credit line, for CC BY) to [VOICE.md](VOICE.md#licences).
3. **Tune a preset** in `server/voice/presets.json` under the character's id: voice, speaker, pace,
   `flatten`, effects ([Tweaking a voice](TWEAKING-VOICES.md)). Keep it clear on a phone speaker.
4. **Write the character** in `src/cast/characters.ts`: id, name, about, inspiredBy, tone, preset,
   flatten, voice, sample and every line in `LineSet`, and add it to `CAST` in `src/cast/index.ts`.
   Write it as an original: no actor's voice, no catchphrases.
5. **Test**: `npm test` checks the lines against the rules, the placeholders, that the preset
   exists and matches, the voice is pinned and its licence documented. Listen to a sample.
6. **Release**: re-running the installer on a server adds the new preset (and fetches its voice)
   without touching anyone's edited presets.
