// Send a recording to the app's own server for a transcript. The app's server checks who is
// asking and hands the audio to whisper (flatline/server); the browser never talks to whisper.

export type UploadResult = { ok: true; text: string } | { ok: false; status: number; error: string };

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
export async function transcribeOnServer(endpoint: string, audio: Blob, opts: UploadOptions = {}): Promise<UploadResult> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      body: audio,
      credentials: "same-origin",
      headers: { "content-type": audio.type || "application/octet-stream", ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 130_000),
    });
    const body = await res.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
    if (res.ok && body && typeof body.text === "string") return { ok: true, text: body.text };
    return { ok: false, status: res.status, error: body && typeof body.error === "string" ? body.error : `The server answered ${res.status}.` };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, status: 0, error: name === "TimeoutError" ? "That took too long." : "Can't reach the server right now." };
  }
}
