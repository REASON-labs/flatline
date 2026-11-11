// Speech to text: a whisper.cpp server on loopback (see server/install.sh) by default, where the
// audio goes to that one address and nowhere else. An app may instead list backends, tried in
// order, and one of them may be an OpenAI-style service (its own, or a cloud one): the audio
// then goes where the app said, and only there. Nothing here keeps it: once it is text, the
// bytes are the caller's to drop.
import { baseOf, bearer, isTimeout, openaiUp, reasonIn, refusal, safeText, shouldMoveOn } from "./backend.js";
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
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
    const doFetch = opts.fetch ?? fetch;
    const listed = Array.isArray(opts.backends) && opts.backends.length ? opts.backends : [{ kind: "whispercpp", url: opts.url ?? "" }];
    // A backend without an address is left out; `index` stays its place in the list as given.
    const ready = listed
        .map((backend, index) => ({ backend, base: baseOf(backend?.url), via: { index, kind: backend?.kind } }))
        .filter((b) => b.base && (b.backend.kind === "whispercpp" || b.backend.kind === "openai"));
    async function attempt({ backend, base, via }, audio, contentType) {
        const openai = backend.kind === "openai";
        const key = openai ? backend.apiKey : undefined;
        const wait = (openai ? backend.timeoutMs : undefined) ?? timeoutMs;
        const form = new FormData();
        form.append("file", new Blob([audio], { type: contentType || "application/octet-stream" }), fileNameFor(contentType));
        if (openai)
            form.append("model", backend.model);
        form.append("response_format", "json");
        form.append("temperature", "0");
        // OpenAI-style services detect the language when none is given; "auto" is whisper.cpp's word.
        if (opts.language && !(openai && opts.language === "auto"))
            form.append("language", opts.language);
        const started = Date.now();
        try {
            const signal = AbortSignal.timeout(wait);
            const res = await doFetch(openai ? `${base}/audio/transcriptions` : `${base}/inference`, {
                method: "POST", body: form, ...(openai ? { headers: bearer(key) } : {}), signal,
            });
            const body = await res.json().catch(() => null);
            // The wait can run out after the answer has started: that is a timeout, not a bad answer.
            if (!body && signal.aborted)
                throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
            if (res.ok && body && typeof body.text === "string") {
                return { result: { ok: true, text: cleanTranscript(body.text), ms: Date.now() - started, via }, moveOn: false };
            }
            const moveOn = shouldMoveOn(res.status);
            if (openai) {
                const error = res.ok ? "The speech-to-text service answered without a transcript." : refusal("speech-to-text service", res.status, body, key);
                return { result: { ok: false, code: res.status === 429 ? "busy" : "bad_response", error, via }, moveOn };
            }
            const why = safeText(reasonIn(body), undefined);
            return { result: { ok: false, code: "bad_response", error: `The speech-to-text server answered ${res.status}${why ? `: ${why}` : ""}.`, via }, moveOn };
        }
        catch (e) {
            if (isTimeout(e))
                return { result: { ok: false, code: "timeout", error: `No transcript after ${Math.round(wait / 1000)} s.`, via }, moveOn: true };
            return { result: { ok: false, code: "unavailable", error: `Can't reach the speech-to-text server (${safeText(e?.message ?? e, key)}).`, via }, moveOn: true };
        }
    }
    return {
        configured: ready.length > 0,
        async transcribe(audio, contentType) {
            if (!ready.length)
                return { ok: false, code: "unavailable", error: "No speech-to-text server is configured." };
            if (!audio || audio.byteLength === 0)
                return { ok: false, code: "empty", error: "There was no audio." };
            if (audio.byteLength > maxBytes)
                return { ok: false, code: "too_large", error: `The audio is over ${Math.round(maxBytes / 1024 / 1024)} MB.` };
            let last;
            for (const b of ready) {
                last = await attempt(b, audio, contentType);
                if (last.result.ok || !last.moveOn)
                    break;
            }
            return last.result;
        },
        async health() {
            const up = await Promise.all(ready.map(async ({ backend, base }) => {
                if (backend.kind === "openai")
                    return openaiUp(doFetch, base, backend.apiKey);
                try {
                    // whisper.cpp's server answers GET / with its demo page: up means it answers at all.
                    const res = await doFetch(`${base}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
                    return res.status < 500;
                }
                catch {
                    return false;
                }
            }));
            return up.some(Boolean);
        },
    };
}
//# sourceMappingURL=transcribe.js.map