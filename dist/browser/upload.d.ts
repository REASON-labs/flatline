export type UploadResult = {
    ok: true;
    text: string;
} | {
    ok: false;
    status: number;
    error: string;
};
export interface UploadOptions {
    /** Extra headers (a session token, say). Cookies go along by default. */
    headers?: Record<string, string>;
    /** Give up after this long. Default 130 s (a little over the server's own limit). */
    timeoutMs?: number;
}
/**
 * POST the audio as the raw request body, with its type. Expects `{ text }` back, or
 * `{ error }` with a non-2xx status (the shape `examples/node-server.mjs` answers with).
 */
export declare function transcribeOnServer(endpoint: string, audio: Blob, opts?: UploadOptions): Promise<UploadResult>;
