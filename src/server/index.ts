// flatline/server: speech to text, and text to speech: on your own server by default, or
// through the backends the app lists.
export { createTranscriber, cleanTranscript, fileNameFor } from "./transcribe.js";
export type { Transcriber, TranscriberOptions, TranscribeResult, TranscribeErrorCode, SttBackend, SttVia } from "./transcribe.js";
export { createSpeaker, SPEAK_TYPES, splitText, joinWavs } from "./speak.js";
export type { Speaker, SpeakerOptions, SpeakOptions, SpeakResult, SpeakErrorCode, SpeakFormat, Tune, Pauses, VoiceBackend, VoiceVia } from "./speak.js";
export type { Via } from "./backend.js";
