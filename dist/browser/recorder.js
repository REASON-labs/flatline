// Record one spoken answer on the phone: ask for the mic, record, and stop by itself when the
// person stops talking (or when the app says so). Nothing is uploaded here: the app gets the
// audio back and decides where it goes (normally its own server, which hands it to whisper).
import { SilenceDetector, rms } from "./silence.js";
import { hush } from "./dixie.js";
/** Tuned for a spoken answer: up to a minute, ended by 1.5 s of quiet, given up after 8 s of nothing. */
export const ANSWER_DEFAULTS = { maxMs: 60_000, silenceMs: 1500, noSpeechMs: 8000 };
/** Formats in order of preference: Chrome and Firefox record webm/ogg Opus, Safari mp4 (AAC). */
const PREFERRED = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/aac"];
/** The best format this browser can record, or "" to let it choose. Pure, for tests. */
export function pickMimeType(isSupported) {
    return PREFERRED.find((t) => { try {
        return isSupported(t);
    }
    catch {
        return false;
    } }) ?? "";
}
/** Can this page record at all? (Needs a secure page: https or localhost.) */
export function canRecord() {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}
function failure(code, error) { return { ok: false, code, error }; }
/**
 * Start recording. Call it from a tap: browsers only allow the mic (and audio) after the person
 * does something.
 */
export function record(opts = {}) {
    if (opts.hushDixie !== false)
        hush();
    let finish = () => { };
    const done = new Promise((resolve) => { finish = resolve; });
    let stopReason = null;
    let recorder = null;
    let cleanup = () => { };
    const end = (why) => {
        if (stopReason)
            return;
        stopReason = why;
        if (recorder && recorder.state !== "inactive")
            recorder.stop();
        else
            cleanup();
    };
    void (async () => {
        if (!canRecord()) {
            finish(failure("unsupported", "This browser can't record here (it needs a secure page and a microphone)."));
            return;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        }
        catch (e) {
            const name = e?.name;
            if (name === "NotAllowedError" || name === "SecurityError")
                finish(failure("denied", "Microphone access wasn't allowed."));
            else if (name === "NotFoundError" || name === "OverconstrainedError")
                finish(failure("no_mic", "No microphone was found."));
            else
                finish(failure("failed", `The microphone didn't start (${String(e?.message ?? e)}).`));
            return;
        }
        if (stopReason === "cancelled") {
            stream.getTracks().forEach((t) => t.stop());
            finish(failure("cancelled", "Cancelled."));
            return;
        }
        const type = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
        const chunks = [];
        const started = performance.now();
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const frame = new Float32Array(analyser.fftSize);
        const detector = new SilenceDetector({ ...ANSWER_DEFAULTS, ...opts });
        let lastState = detector.state;
        const timer = setInterval(() => {
            analyser.getFloatTimeDomainData(frame);
            const level = rms(frame);
            opts.onLevel?.(level);
            const why = detector.feed(level, performance.now());
            if (detector.state !== lastState) {
                lastState = detector.state;
                opts.onState?.(lastState);
            }
            if (why)
                end(why);
        }, 50);
        cleanup = () => {
            clearInterval(timer);
            stream.getTracks().forEach((t) => t.stop());
            void ctx.close().catch(() => { });
        };
        try {
            recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
        }
        catch (e) {
            cleanup();
            finish(failure("failed", `Recording didn't start (${String(e?.message ?? e)}).`));
            return;
        }
        recorder.ondataavailable = (e) => { if (e.data.size)
            chunks.push(e.data); };
        recorder.onerror = () => { cleanup(); finish(failure("failed", "Recording stopped with an error.")); };
        recorder.onstop = () => {
            cleanup();
            const ms = Math.round(performance.now() - started);
            const why = stopReason ?? "stopped";
            if (why === "cancelled") {
                finish(failure("cancelled", "Cancelled."));
                return;
            }
            if (why === "no_speech") {
                finish(failure("no_speech", "Nothing was heard."));
                return;
            }
            const audioType = recorder?.mimeType || type || "audio/webm";
            finish({ ok: true, audio: new Blob(chunks, { type: audioType }), type: audioType, ms, reason: why });
        };
        recorder.start(250);
        if (stopReason)
            recorder.stop(); // stop() arrived while the mic was starting
    })();
    return {
        stop: () => end("stopped"),
        cancel: () => end("cancelled"),
        done,
    };
}
//# sourceMappingURL=recorder.js.map