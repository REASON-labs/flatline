import { type Via } from "./backend.js";
export type SpeakFormat = "m4a" | "mp3" | "ogg" | "wav";
export type SpeakErrorCode = "unavailable" | "empty" | "too_long" | "unknown_preset" | "busy" | "timeout" | "bad_response";
/** Where the text can be sent. */
export type VoiceBackend = 
/** The flatline-voice service (server/install-voice.sh), e.g. "http://127.0.0.1:8087". */
{
    kind: "flatline";
    url: string;
}
/**
 * Anything with OpenAI's speech API: POST {url}/audio/speech, asked for WAV. The url ends
 * before "/audio". `maxChars` is the most text the service takes in one request (default
 * 200): longer text is split at sentence ends and the WAVs joined. The audio is always WAV,
 * and presets, tune, pace and pauses don't apply: the voice is the one named here.
 */
 | {
    kind: "openai";
    url: string;
    model: string;
    voice: string;
    apiKey?: string;
    maxChars?: number;
    timeoutMs?: number;
};
export type VoiceVia = Via<VoiceBackend["kind"]>;
export type SpeakResult = 
/**
 * `via`: which backend answered (its place in the list, 0 first, and its kind). `format`:
 * what the audio is. `note`: set when that isn't the format asked for (an "openai" backend
 * answers WAV whatever was asked).
 */
{
    ok: true;
    audio: Uint8Array;
    contentType: string;
    ms: number;
    via: VoiceVia;
    format: SpeakFormat;
    note?: string;
}
/** `via`: the backend that gave this answer; unset when nothing was sent. */
 | {
    ok: false;
    code: SpeakErrorCode;
    error: string;
    via?: VoiceVia;
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
    /** The voice service, e.g. "http://127.0.0.1:8087": short for one "flatline" backend. */
    url?: string | undefined;
    /**
     * Backends, tried in order (when set, `url` is ignored). The next one is tried only when one
     * is unreachable, times out, or answers 429 or 5xx; never for text that is empty or too
     * long, or another 4xx. None (and no `url`): every call is "unavailable".
     */
    backends?: VoiceBackend[];
    /** Longest wait for one backend. Default 60 s (the service queues one at a time). */
    timeoutMs?: number;
    /** Refuse longer text before sending. Default 1500 characters (about a minute and a half). */
    maxChars?: number;
    /** For tests: a stand-in for the global fetch. */
    fetch?: typeof fetch;
}
export interface Speaker {
    /** Text in, audio out. Preset: a character's (flatline/cast), unset for the service's default (flatline); format default "m4a" (AAC: Signal, iPhone). */
    speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
    /** The presets of the first "flatline" backend that answers, or null when none does. */
    presets(): Promise<string[] | null>;
    /** Is any backend up? */
    health(): Promise<boolean>;
    readonly configured: boolean;
}
/** The content type for each format, as the service answers it. */
export declare const SPEAK_TYPES: Record<SpeakFormat, string>;
/**
 * Text in pieces of at most `max` characters, cut at the last sentence end that fits, else the
 * last comma (or semicolon or colon), else the last space, else mid-word. Nothing is lost:
 * joined with spaces, the pieces are the text.
 */
export declare function splitText(text: string, max?: number): string[];
/**
 * Several WAVs of the same kind (rate, channels, sample size) as one, in order. One WAV comes
 * back tidied (a plain header, its real length). Null when one isn't a WAV, or they differ.
 */
export declare function joinWavs(wavs: Uint8Array[]): Uint8Array | null;
export declare function createSpeaker(opts: SpeakerOptions): Speaker;
