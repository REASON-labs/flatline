# Flatline — rules for working on this repo

Self-hosted voice for web apps: `server/install.sh` (whisper.cpp on loopback, :8086),
`server/install-voice.sh` (Piper + ffmpeg presets on loopback, :8087, `server/voice/`),
`flatline/server` (createTranscriber, createSpeaker), `flatline/browser` (record until silence,
upload, and `dixie`, the speaker: the server's voice or the phone's), and `flatline/cast` (the
voice characters: Flatline, the default and once called Dixie, Kestrel, Iris, Ashford, Hoshi,
Captain Calder and Nettle; each a preset, a tone guide and a line set; docs/CAST.md).
The repository will be **public**: no personal hosts, names, addresses or app-specific wording.
Apps that use it (Mindtop and its forks) keep only a thin adapter; anything reusable lives here.

## Non-negotiables

1. **Audio never leaves the user's own server.** No third-party speech APIs, no telemetry. The
   voices are made on that server; the fallback (the phone's speech) prefers on-device voices.
2. **Both services listen on loopback only** (whisper :8086, voice :8087). The app's endpoint is
   the gate; never document exposing them.
3. **No runtime dependencies.** Dev tools only (TypeScript, Playwright).
4. **Errors are codes plus a plain sentence**, never thrown at the caller for expected failures
   (no server, timeout, mic denied, nothing said).
5. **Pinned upstream.** whisper.cpp is built at a tag in `server/install.sh`; bump it on purpose.
6. **Licences stay permissive and documented** (docs/VOICE.md#licences): never a voice with a
   non-commercial licence; credit CC BY voices. Don't imitate a real person's voice.
7. **Pure logic is separate and tested** (`SilenceDetector`, `chooseVoice`, `pickMimeType`,
   `cleanTranscript`); browser-only code is tested in a real Chromium (`npm run test:browser`).
8. **The cast's rules hold for every character** (docs/CAST.md, `test/cast.test.mjs`): nothing
   shaming, no counting misses, rest on a rough day, nothing private in a text line, short
   sentences ending in full stops, no emoji. Characters are originals: no catchphrases or quotes.

## Commands

```bash
npm test               # build + unit and local-network tests
npm run test:browser   # recorder and speaker in Chromium with a fake microphone
npm run test:whisper   # real whisper (CI); test:voice real Piper (CI); tools/voice-lab.mjs picks voices
FLATLINE_VOICE_URL=... node tools/cast-samples.mjs out/   # an MP3 of each character, to compare
```
