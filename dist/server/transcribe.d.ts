import { type Via } from "./backend.js";
/** Why a transcription didn't happen, for the app to word in its own way. */
export type TranscribeErrorCode = "unavailable" | "too_large" | "empty" | "timeout" | "busy" | "bad_response";
/** Where the audio can be sent. */
export type SttBackend = 
/** A whisper.cpp server (server/install.sh), e.g. "http://127.0.0.1:8086". */
{
    kind: "whispercpp";
    url: string;
}
/**
 * Anything with OpenAI's transcription API: POST {url}/audio/transcriptions. The url ends
 * before "/audio" (e.g. "https://api.example.com/v1"). The key, when set, is sent as a Bearer
 * token and appears nowhere else.
 */
 | {
    kind: "openai";
    url: string;
    model: string;
    apiKey?: string;
    timeoutMs?: number;
};
export type SttVia = Via<SttBackend["kind"]>;
export type TranscribeResult = 
/** `via`: which backend answered (its place in the list, 0 first, and its kind). */
{
    ok: true;
    text: string;
    ms: number;
    via: SttVia;
}
/** `via`: the backend that gave this answer; unset when nothing was sent. */
 | {
    ok: false;
    code: TranscribeErrorCode;
    error: string;
    via?: SttVia;
};
export interface TranscriberOptions {
    /** The whisper.cpp server, e.g. "http://127.0.0.1:8086": short for one "whispercpp" backend. */
    url?: string | undefined;
    /**
     * Backends, tried in order (when set, `url` is ignored). The next one is tried only when one
     * is unreachable, times out, or answers 429 or 5xx; never for audio that is empty or too
     * large, or another 4xx. None (and no `url`): every call is "unavailable".
     */
    backends?: SttBackend[];
    /** Longest wait for one backend. Default 120 s (a long memo on a small box). */
    timeoutMs?: number;
    /** Refuse anything bigger, before sending. Default 25 MB (about 25 minutes of a phone memo). */
    maxBytes?: number;
    /** A language code ("en"), or "auto". Default: whatever the server was started with. */
    language?: string;
    /** For tests: a stand-in for the global fetch. */
    fetch?: typeof fetch;
}
export interface Transcriber {
    /** Audio in (any format ffmpeg reads, when the server runs with --convert), text out. */
    transcribe(audio: Uint8Array, contentType?: string): Promise<TranscribeResult>;
    /** Is any backend up? A cheap request to each, safe to call on a timer. */
    health(): Promise<boolean>;
    /** Is any backend configured at all (it may still be down)? */
    readonly configured: boolean;
}
/**
 * Whisper writes sounds that aren't speech in brackets ("[BLANK_AUDIO]", "(wind blowing)",
 * "[Music]"). They are not words someone said: drop them, and tidy the spacing.
 */
export declare function cleanTranscript(raw: string): string;
/** A file name with an extension whisper's ffmpeg step recognises, from a content type. */
export declare function fileNameFor(contentType: string | undefined): string;
export declare function createTranscriber(opts: TranscriberOptions): Transcriber;
