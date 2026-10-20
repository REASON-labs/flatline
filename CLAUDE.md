# Flatline — rules for working on this repo

Self-hosted voice for web apps: `server/install.sh` (whisper.cpp on loopback, :8086),
`server/install-voice.sh` (Piper + ffmpeg presets on loopback, :8087, `server/voice/`),
`flatline/server` (createTranscriber, createSpeaker), `flatline/browser` (record until silence,
upload, and Dixie, who speaks with the server's voice or the phone's).
The repository will be **public**: no personal hosts, names, addresses or app-specific wording.
Apps that use it (Mindtop and its forks) keep only a thin adapter; anything reusable lives here.

## Non-negotiables

1. **Audio never leaves the user's own server.** No third-party speech APIs, no telemetry. Dixie's
   voice is made on that server; her fallback (the phone's speech) prefers on-device voices.
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

## Commands

```bash
npm test               # build + unit and local-network tests
npm run test:browser   # recorder and Dixie in Chromium with a fake microphone
npm run test:whisper   # real whisper (CI); test:voice real Piper (CI); tools/voice-lab.mjs picks voices
```
