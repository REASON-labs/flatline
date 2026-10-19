// Send a recording to the app's own server for a transcript. The app's server checks who is
// asking and hands the audio to whisper (flatline/server); the browser never talks to whisper.
/**
 * POST the audio as the raw request body, with its type. Expects `{ text }` back, or
 * `{ error }` with a non-2xx status (the shape `examples/node-server.mjs` answers with).
 */
export async function transcribeOnServer(endpoint, audio, opts = {}) {
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            body: audio,
            credentials: "same-origin",
            headers: { "content-type": audio.type || "application/octet-stream", ...opts.headers },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 130_000),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body && typeof body.text === "string")
            return { ok: true, text: body.text };
        return { ok: false, status: res.status, error: body && typeof body.error === "string" ? body.error : `The server answered ${res.status}.` };
    }
    catch (e) {
        const name = e?.name;
        return { ok: false, status: 0, error: name === "TimeoutError" ? "That took too long." : "Can't reach the server right now." };
    }
}
//# sourceMappingURL=upload.js.map