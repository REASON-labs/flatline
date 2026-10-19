// Speech to text on your own server: a whisper.cpp server on loopback (see server/install.sh).
// The audio goes to that one address and nowhere else, and nothing here keeps it: once it is
// text, the bytes are the caller's to drop.
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX = 25 * 1024 * 1024;
/**
 * Whisper writes sounds that aren't speech in brackets ("[BLANK_AUDIO]", "(wind blowing)",
 * "[Music]"). They are not words someone said: drop them, and tidy the spacing.
 */
export function cleanTranscript(raw) {
    return raw.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
}
/** A file name with an extension whisper's ffmpeg step recognises, from a content type. */
export function fileNameFor(contentType) {
    const t = (contentType ?? "").toLowerCase();
    const ext = t.includes("webm") ? "webm" :
        t.includes("ogg") || t.includes("opus") ? "ogg" :
            t.includes("mp4") || t.includes("m4a") ? "m4a" :
                t.includes("aac") ? "aac" :
                    t.includes("mpeg") || t.includes("mp3") ? "mp3" :
                        t.includes("wav") ? "wav" :
                            t.includes("flac") ? "flac" : "audio";
    return `audio.${ext}`;
}
export function createTranscriber(opts) {
    const base = (opts.url ?? "").trim().replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
    const doFetch = opts.fetch ?? fetch;
    return {
        configured: !!base,
        async transcribe(audio, contentType) {
            if (!base)
                return { ok: false, code: "unavailable", error: "No speech-to-text server is configured." };
            if (!audio || audio.byteLength === 0)
                return { ok: false, code: "empty", error: "There was no audio." };
            if (audio.byteLength > maxBytes)
                return { ok: false, code: "too_large", error: `The audio is over ${Math.round(maxBytes / 1024 / 1024)} MB.` };
            const form = new FormData();
            form.append("file", new Blob([audio], { type: contentType || "application/octet-stream" }), fileNameFor(contentType));
            form.append("response_format", "json");
            form.append("temperature", "0");
            if (opts.language)
                form.append("language", opts.language);
            const started = Date.now();
            try {
                const res = await doFetch(`${base}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
                const body = await res.json().catch(() => null);
                if (!res.ok || !body || typeof body.text !== "string") {
                    const why = body && typeof body.error === "string" ? `: ${body.error}` : "";
                    return { ok: false, code: "bad_response", error: `The speech-to-text server answered ${res.status}${why}.` };
                }
                return { ok: true, text: cleanTranscript(body.text), ms: Date.now() - started };
            }
            catch (e) {
                const name = e?.name;
                if (name === "TimeoutError" || name === "AbortError")
                    return { ok: false, code: "timeout", error: `No transcript after ${Math.round(timeoutMs / 1000)} s.` };
                return { ok: false, code: "unavailable", error: `Can't reach the speech-to-text server (${String(e?.message ?? e)}).` };
            }
        },
        async health() {
            if (!base)
                return false;
            try {
                // whisper.cpp's server answers GET / with its demo page: up means it answers at all.
                const res = await doFetch(`${base}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
                return res.status < 500;
            }
            catch {
                return false;
            }
        },
    };
}
//# sourceMappingURL=transcribe.js.map