// Record one spoken answer on the phone: ask for the mic, record, and stop by itself when the
// person stops talking (or when the app says so). Nothing is uploaded here: the app gets the
// audio back and decides where it goes (normally its own server, which hands it to whisper).
import { SilenceDetector, rms, type SilenceOptions, type StopReason, type ListenState } from "./silence.js";
import { hush } from "./dixie.js";

/** Tuned for a spoken answer: up to a minute, ended by 1.5 s of quiet, given up after 8 s of nothing. */
export const ANSWER_DEFAULTS = { maxMs: 60_000, silenceMs: 1500, noSpeechMs: 8000 } as const;

export type RecordingResult =
  | { ok: true; audio: Blob; type: string; ms: number; reason: StopReason | "stopped" }
  | { ok: false; code: RecordErrorCode; error: string };

export type RecordErrorCode =
  | "unsupported"  // no microphone API in this browser (or not a secure page)
  | "denied"       // the person (or the site's permissions) said no
  | "no_mic"       // no microphone found
  | "no_speech"    // nothing was said before noSpeechMs
  | "cancelled"    // the app cancelled it
  | "failed";      // anything else

export interface RecordOptions extends SilenceOptions {
  /** Each loudness reading, 0 to 1, about 20 times a second: for a level meter. */
  onLevel?: (level: number) => void;
  /** When it starts hearing speech, and when it's waiting for more. */
  onState?: (state: ListenState) => void;
  /** Stop Dixie talking first (so a tap on the mic interrupts her). Default true. */
  hushDixie?: boolean;
}

export interface Recording {
  /** Stop now and keep what was said. */
  stop(): void;
  /** Stop now and throw it away. */
  cancel(): void;
  /** The audio, once it has stopped (by itself, or by stop/cancel). */
  readonly done: Promise<RecordingResult>;
}

/** Formats in order of preference: Chrome and Firefox record webm/ogg Opus, Safari mp4 (AAC). */
const PREFERRED = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/aac"];

/** The best format this browser can record, or "" to let it choose. Pure, for tests. */
export function pickMimeType(isSupported: (t: string) => boolean): string {
  return PREFERRED.find((t) => { try { return isSupported(t); } catch { return false; } }) ?? "";
}

/** Can this page record at all? (Needs a secure page: https or localhost.) */
export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

function failure(code: RecordErrorCode, error: string): RecordingResult { return { ok: false, code, error }; }

/** An AudioContext (older iPhones only have the webkit-prefixed one), or null. */
function newAudioContext(): AudioContext | null {
  const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try { return AC ? new AC() : null; } catch { return null; }
}

/**
 * Start recording. Call it from a tap: browsers only allow the mic (and audio) after the person
 * does something.
 */
export function record(opts: RecordOptions = {}): Recording {
  if (opts.hushDixie !== false) hush();
  let finish: (r: RecordingResult) => void = () => {};
  const done = new Promise<RecordingResult>((resolve) => { finish = resolve; });
  let stopReason: StopReason | "stopped" | "cancelled" | null = null;
  let recorder: MediaRecorder | null = null;
  let cleanup = () => {};

  const end = (why: StopReason | "stopped" | "cancelled") => {
    if (stopReason) return;
    stopReason = why;
    if (recorder && recorder.state !== "inactive") recorder.stop(); else cleanup();
  };

  // The loudness meter's audio context is made NOW, inside the tap: on iPhone, one made after
  // a wait (the mic prompt) starts suspended and hears nothing.
  const ctx = canRecord() ? newAudioContext() : null;
  void ctx?.resume().catch(() => {});
  const closeCtx = () => { void ctx?.close().catch(() => {}); };

  void (async () => {
    if (!canRecord()) { finish(failure("unsupported", "This browser can't record here (it needs a secure page and a microphone).")); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      closeCtx();
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") finish(failure("denied", "Microphone access wasn't allowed."));
      else if (name === "NotFoundError" || name === "OverconstrainedError") finish(failure("no_mic", "No microphone was found."));
      else finish(failure("failed", `The microphone didn't start (${String((e as Error)?.message ?? e)}).`));
      return;
    }
    if (stopReason === "cancelled") { stream.getTracks().forEach((t) => t.stop()); closeCtx(); finish(failure("cancelled", "Cancelled.")); return; }

    const type = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    const chunks: Blob[] = [];
    const started = performance.now();
    await ctx?.resume().catch(() => {});
    let analyser: AnalyserNode | null = null;
    try {
      if (ctx) { analyser = ctx.createAnalyser(); analyser.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(analyser); }
    } catch { analyser = null; }
    const frame = new Float32Array(analyser?.fftSize ?? 1024);
    const settings = { ...ANSWER_DEFAULTS, ...opts };
    const detector = new SilenceDetector(settings);
    let lastState: ListenState = detector.state;
    // If the meter hears pure silence for a while (no meter at all, or a context the browser
    // never let run), it can't tell when someone stops: keep recording until stop() or maxMs,
    // rather than giving up on a person who is talking.
    let heardSignal = false;
    let deaf = !analyser;

    const timer = setInterval(() => {
      const now = performance.now();
      if (!deaf && analyser) {
        analyser.getFloatTimeDomainData(frame);
        const level = rms(frame);
        if (level > 0) heardSignal = true;
        else if (!heardSignal && now - started > 1500) deaf = true;
        if (!deaf) {
          opts.onLevel?.(level);
          const why = detector.feed(level, now);
          if (detector.state !== lastState) { lastState = detector.state; opts.onState?.(lastState); }
          // "Nothing said" needs a meter that hears something: a real mic always picks up a
          // little background. Pure zeros mean the meter is deaf, not that the room is silent.
          if (why === "no_speech" && !heardSignal) deaf = true;
          else if (why) { end(why); return; }
          if (!deaf) return;
        }
      }
      if (now - started >= settings.maxMs) end("max");
    }, 50);

    cleanup = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      closeCtx();
    };

    try {
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch (e) {
      cleanup();
      finish(failure("failed", `Recording didn't start (${String((e as Error)?.message ?? e)}).`));
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => { cleanup(); finish(failure("failed", "Recording stopped with an error.")); };
    recorder.onstop = () => {
      cleanup();
      const ms = Math.round(performance.now() - started);
      const why = stopReason ?? "stopped";
      if (why === "cancelled") { finish(failure("cancelled", "Cancelled.")); return; }
      if (why === "no_speech") { finish(failure("no_speech", "Nothing was heard.")); return; }
      const audioType = recorder?.mimeType || type || "audio/webm";
      finish({ ok: true, audio: new Blob(chunks, { type: audioType }), type: audioType, ms, reason: why });
    };
    recorder.start(250);
    if (stopReason) recorder.stop();   // stop() arrived while the mic was starting
  })();

  return {
    stop: () => end("stopped"),
    cancel: () => end("cancelled"),
    done,
  };
}
