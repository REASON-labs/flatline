/** Why a transcription didn't happen, for the app to word in its own way. */
export type TranscribeErrorCode = "unavailable" | "too_large" | "empty" | "timeout" | "bad_response";
export type TranscribeResult = {
    ok: true;
    text: string;
    ms: number;
} | {
    ok: false;
    code: TranscribeErrorCode;
    error: string;
};
export interface TranscriberOptions {
    /** The whisper.cpp server, e.g. "http://127.0.0.1:8086". Empty: every call is "unavailable". */
    url: string | undefined;
    /** Longest wait for one transcription. Default 120 s (a long memo on a small box). */
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
    /** Is the server up? A cheap request, safe to call on a timer. */
    health(): Promise<boolean>;
    /** Is a server configured at all (it may still be down)? */
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
