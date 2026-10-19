import { type SilenceOptions, type StopReason, type ListenState } from "./silence.js";
/** Tuned for a spoken answer: up to a minute, ended by 1.5 s of quiet, given up after 8 s of nothing. */
export declare const ANSWER_DEFAULTS: {
    readonly maxMs: 60000;
    readonly silenceMs: 1500;
    readonly noSpeechMs: 8000;
};
export type RecordingResult = {
    ok: true;
    audio: Blob;
    type: string;
    ms: number;
    reason: StopReason | "stopped";
} | {
    ok: false;
    code: RecordErrorCode;
    error: string;
};
export type RecordErrorCode = "unsupported" | "denied" | "no_mic" | "no_speech" | "cancelled" | "failed";
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
/** The best format this browser can record, or "" to let it choose. Pure, for tests. */
export declare function pickMimeType(isSupported: (t: string) => boolean): string;
/** Can this page record at all? (Needs a secure page: https or localhost.) */
export declare function canRecord(): boolean;
/**
 * Start recording. Call it from a tap: browsers only allow the mic (and audio) after the person
 * does something.
 */
export declare function record(opts?: RecordOptions): Recording;
