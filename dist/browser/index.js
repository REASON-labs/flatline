// flatline/browser: record an answer that stops on silence, send it for a transcript, and
// Dixie, who reads text aloud.
export { record, canRecord, pickMimeType, ANSWER_DEFAULTS } from "./recorder.js";
export { SilenceDetector, rms } from "./silence.js";
export { dixie, speak, hush, speaking, primeVoices, canSpeak, loadVoices, chooseVoice } from "./dixie.js";
export { transcribeOnServer } from "./upload.js";
//# sourceMappingURL=index.js.map