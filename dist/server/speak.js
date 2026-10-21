// Text to speech on your own server: the flatline-voice service on loopback (see
// server/install-voice.sh). Text goes to that one address; the audio comes back to you.
/** The content type for each format, as the service answers it. */
export const SPEAK_TYPES = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };
export function createSpeaker(opts) {
    const base = (opts.url ?? "").trim().replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxChars = opts.maxChars ?? 1500;
    const doFetch = opts.fetch ?? fetch;
    async function info() {
        if (!base)
            return null;
        try {
            const res = await doFetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
            const body = await res.json().catch(() => null);
            return res.ok && body && Array.isArray(body.presets) ? { presets: body.presets.filter((p) => typeof p === "string") } : null;
        }
        catch {
            return null;
        }
    }
    return {
        configured: !!base,
        async speak(text, o = {}) {
            if (!base)
                return { ok: false, code: "unavailable", error: "No voice service is configured." };
            const words = String(text ?? "").replace(/\s+/g, " ").trim();
            if (!words)
                return { ok: false, code: "empty", error: "There's nothing to say." };
            if (words.length > maxChars)
                return { ok: false, code: "too_long", error: `Keep it under ${maxChars} characters.` };
            const started = Date.now();
            try {
                const res = await doFetch(`${base}/speak`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: words, ...(o.preset ? { preset: o.preset } : {}), format: o.format ?? "m4a", ...(o.tune ? { tune: o.tune } : {}) }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
                const type = res.headers.get("content-type") ?? "";
                if (res.ok && type.startsWith("audio/")) {
                    const audio = new Uint8Array(await res.arrayBuffer());
                    if (!audio.byteLength)
                        return { ok: false, code: "bad_response", error: "The voice service sent no audio." };
                    return { ok: true, audio, contentType: type, ms: Date.now() - started };
                }
                const body = await res.json().catch(() => null);
                const code = body?.code;
                const known = ["empty", "too_long", "unknown_preset", "busy", "timeout"];
                const error = typeof body?.error === "string" ? body.error : `The voice service answered ${res.status}.`;
                return { ok: false, code: known.includes(code) ? code : "bad_response", error };
            }
            catch (e) {
                const name = e?.name;
                if (name === "TimeoutError" || name === "AbortError")
                    return { ok: false, code: "timeout", error: `No speech after ${Math.round(timeoutMs / 1000)} s.` };
                return { ok: false, code: "unavailable", error: `Can't reach the voice service (${String(e?.message ?? e)}).` };
            }
        },
        async presets() { return (await info())?.presets ?? null; },
        async health() { return (await info()) !== null; },
    };
}
//# sourceMappingURL=speak.js.map