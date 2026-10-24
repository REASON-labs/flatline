export type SpeakFormat = "m4a" | "mp3" | "ogg" | "wav";
export type SpeakErrorCode = "unavailable" | "empty" | "too_long" | "unknown_preset" | "busy" | "timeout" | "bad_response";
export type SpeakResult = {
    ok: true;
    audio: Uint8Array;
    contentType: string;
    ms: number;
} | {
    ok: false;
    code: SpeakErrorCode;
    error: string;
};
/** Numbers that override a preset's effects for one request (for tuning by ear). */
export interface Tune {
    pitch?: number;
    highpass?: number;
    lowpass?: number;
    drive?: number;
    loudness?: number;
    presence?: {
        freq?: number;
        gain?: number;
    };
    compress?: {
        threshold?: number;
        ratio?: number;
    };
    echo?: {
        delay?: number;
        decay?: number;
    };
}
/** Pauses (seconds) after a statement, a clause and a question, for one request (0..3). */
export interface Pauses {
    stop?: number;
    clause?: number;
    question?: number;
}
/** What one request can change: the preset, the format, the sound, the pace and the pauses. */
export interface SpeakOptions {
    preset?: string;
    format?: SpeakFormat;
    tune?: Tune;
    /** × the preset's speed: 0.6..1.4 in steps of 0.05; lower is slower (0.75 for slow guidance). */
    pace?: number;
    /** Merged over the preset's own pauses. */
    pauses?: Pauses;
}
export interface SpeakerOptions {
    /** The voice service, e.g. "http://127.0.0.1:8087". Empty: every call is "unavailable". */
    url: string | undefined;
    /** Longest wait for one piece of speech. Default 60 s (the service queues one at a time). */
    timeoutMs?: number;
    /** Refuse longer text before sending. Default 1500 characters (about a minute and a half). */
    maxChars?: number;
    /** For tests: a stand-in for the global fetch. */
    fetch?: typeof fetch;
}
export interface Speaker {
    /** Text in, audio out. Preset: a character's (flatline/cast), unset for the service's default (flatline); format default "m4a" (AAC: Signal, iPhone). */
    speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
    /** The service's presets, or null when it can't be reached. */
    presets(): Promise<string[] | null>;
    /** Is the service up? */
    health(): Promise<boolean>;
    readonly configured: boolean;
}
/** The content type for each format, as the service answers it. */
export declare const SPEAK_TYPES: Record<SpeakFormat, string>;
export declare function createSpeaker(opts: SpeakerOptions): Speaker;
