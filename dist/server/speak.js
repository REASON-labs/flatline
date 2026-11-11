// Text to speech: the flatline-voice service on loopback (see server/install-voice.sh) by
// default, where text goes to that one address and the audio comes back. An app may instead
// list backends, tried in order, and one of them may be an OpenAI-style service (its own, or a
// cloud one): the text then goes where the app said, and only there.
import { baseOf, bearer, isTimeout, openaiUp, refusal, safeText, shouldMoveOn } from "./backend.js";
/** The content type for each format, as the service answers it. */
export const SPEAK_TYPES = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };
/**
 * Text in pieces of at most `max` characters, cut at the last sentence end that fits, else the
 * last comma (or semicolon or colon), else the last space, else mid-word. Nothing is lost:
 * joined with spaces, the pieces are the text.
 */
export function splitText(text, max = 200) {
    const limit = Math.max(1, Math.floor(max) || 1);
    const out = [];
    let rest = String(text ?? "").replace(/\s+/g, " ").trim();
    while (rest.length > limit) {
        const head = rest.slice(0, limit + 1);
        let cut = lastEnd(head, /[.!?…]+["'”’)\]]*(?=\s)/g) || lastEnd(head, /[,;:—](?=\s)/g) || Math.max(0, head.lastIndexOf(" "));
        if (!cut) {
            cut = limit;
            // Not between the two halves of one character (an emoji, say).
            const c = rest.charCodeAt(cut - 1);
            if (cut > 1 && c >= 0xd800 && c <= 0xdbff)
                cut -= 1;
        }
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest)
        out.push(rest);
    return out;
}
function lastEnd(s, re) {
    let end = 0;
    for (const m of s.matchAll(re))
        end = m.index + m[0].length;
    return end;
}
const tag = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
/** The format chunk and the samples of a WAV, or null when it isn't one. */
function readWav(b) {
    if (b.byteLength < 12 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE")
        return null;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let fmt = null;
    for (let at = 12; at + 8 <= b.byteLength;) {
        const id = tag(b, at);
        const left = b.byteLength - at - 8;
        let size = view.getUint32(at + 4, true);
        // A streamed WAV may not know its length (0 or 0xFFFFFFFF): the samples run to the end.
        if (id === "data" && (size === 0 || size > left))
            size = left;
        if (size > left)
            return null;
        if (id === "fmt ")
            fmt = b.subarray(at + 8, at + 8 + size);
        if (id === "data")
            return fmt && fmt.byteLength >= 16 ? { fmt, data: b.subarray(at + 8, at + 8 + size) } : null;
        at += 8 + size + (size % 2);
    }
    return null;
}
/**
 * Several WAVs of the same kind (rate, channels, sample size) as one, in order. One WAV comes
 * back tidied (a plain header, its real length). Null when one isn't a WAV, or they differ.
 */
export function joinWavs(wavs) {
    const parts = wavs.map(readWav);
    const first = parts[0];
    if (!first || parts.some((p) => !p))
        return null;
    const same = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
    if (!parts.every((p) => same(p.fmt, first.fmt)))
        return null;
    const block = Math.max(1, new DataView(first.fmt.buffer, first.fmt.byteOffset, first.fmt.byteLength).getUint16(12, true));
    // Whole sample frames only, so a ragged end never shifts what follows it.
    const datas = parts.map((p) => p.data.subarray(0, p.data.byteLength - (p.data.byteLength % block)));
    const n = datas.reduce((a, d) => a + d.byteLength, 0);
    const fmtPad = first.fmt.byteLength % 2;
    const out = new Uint8Array(12 + 8 + first.fmt.byteLength + fmtPad + 8 + n + (n % 2));
    const view = new DataView(out.buffer);
    const put = (at, s) => { for (let i = 0; i < 4; i++)
        out[at + i] = s.charCodeAt(i); };
    put(0, "RIFF");
    view.setUint32(4, out.byteLength - 8, true);
    put(8, "WAVE");
    put(12, "fmt ");
    view.setUint32(16, first.fmt.byteLength, true);
    out.set(first.fmt, 20);
    let at = 20 + first.fmt.byteLength + fmtPad;
    put(at, "data");
    view.setUint32(at + 4, n, true);
    at += 8;
    for (const d of datas) {
        out.set(d, at);
        at += d.byteLength;
    }
    return out;
}
export function createSpeaker(opts) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxChars = opts.maxChars ?? 1500;
    const doFetch = opts.fetch ?? fetch;
    const listed = Array.isArray(opts.backends) && opts.backends.length ? opts.backends : [{ kind: "flatline", url: opts.url ?? "" }];
    // A backend without an address is left out; `index` stays its place in the list as given.
    const ready = listed
        .map((backend, index) => ({ backend, base: baseOf(backend?.url), via: { index, kind: backend?.kind } }))
        .filter((b) => b.backend && b.base && (b.backend.kind === "flatline" || b.backend.kind === "openai"));
    async function info(base) {
        try {
            const res = await doFetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
            const body = await res.json().catch(() => null);
            return res.ok && body && Array.isArray(body.presets) ? { presets: body.presets.filter((p) => typeof p === "string") } : null;
        }
        catch {
            return null;
        }
    }
    const failed = (e, wait, via, key) => isTimeout(e)
        ? { result: { ok: false, code: "timeout", error: `No speech after ${Math.round(wait / 1000)} s.`, via }, moveOn: true }
        : { result: { ok: false, code: "unavailable", error: `Can't reach the voice service (${safeText(e?.message ?? e, key)}).`, via }, moveOn: true };
    async function viaFlatline(base, via, words, o) {
        const started = Date.now();
        const format = o.format ?? "m4a";
        try {
            const res = await doFetch(`${base}/speak`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    text: words, ...(o.preset ? { preset: o.preset } : {}), format,
                    ...(o.tune ? { tune: o.tune } : {}), ...(typeof o.pace === "number" ? { pace: o.pace } : {}), ...(o.pauses ? { pauses: o.pauses } : {}),
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const type = res.headers.get("content-type") ?? "";
            if (res.ok && type.startsWith("audio/")) {
                const audio = new Uint8Array(await res.arrayBuffer());
                if (!audio.byteLength)
                    return { result: { ok: false, code: "bad_response", error: "The voice service sent no audio.", via }, moveOn: false };
                return { result: { ok: true, audio, contentType: type, ms: Date.now() - started, via, format }, moveOn: false };
            }
            const body = await res.json().catch(() => null);
            const code = body?.code;
            const known = ["empty", "too_long", "unknown_preset", "busy", "timeout"];
            const error = typeof body?.error === "string" ? body.error : `The voice service answered ${res.status}.`;
            return { result: { ok: false, code: known.includes(code) ? code : "bad_response", error, via }, moveOn: shouldMoveOn(res.status) };
        }
        catch (e) {
            return failed(e, timeoutMs, via);
        }
    }
    async function viaOpenai(backend, base, via, words, o) {
        const started = Date.now();
        const key = backend.apiKey;
        const wait = backend.timeoutMs ?? timeoutMs;
        const wavs = [];
        try {
            // One piece at a time, in order, all within the one wait.
            for (const input of splitText(words, backend.maxChars ?? 200)) {
                const left = wait - (Date.now() - started);
                if (left <= 0)
                    return failed({ name: "TimeoutError" }, wait, via);
                const res = await doFetch(`${base}/audio/speech`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...bearer(key) },
                    body: JSON.stringify({ model: backend.model, input, voice: backend.voice, response_format: "wav" }),
                    signal: AbortSignal.timeout(left),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    return { result: { ok: false, code: res.status === 429 ? "busy" : "bad_response", error: refusal("voice service", res.status, body, key), via }, moveOn: shouldMoveOn(res.status) };
                }
                wavs.push(new Uint8Array(await res.arrayBuffer()));
            }
        }
        catch (e) {
            return failed(e, wait, via, key);
        }
        const audio = joinWavs(wavs);
        if (!audio || audio.byteLength <= 44)
            return { result: { ok: false, code: "bad_response", error: "The voice service didn't send WAV audio.", via }, moveOn: false };
        const asked = o.format ?? "m4a";
        return {
            result: {
                ok: true, audio, contentType: SPEAK_TYPES.wav, ms: Date.now() - started, via, format: "wav",
                ...(asked !== "wav" ? { note: `Asked for ${asked}; this backend answers WAV.` } : {}),
            },
            moveOn: false,
        };
    }
    return {
        configured: ready.length > 0,
        async speak(text, o = {}) {
            if (!ready.length)
                return { ok: false, code: "unavailable", error: "No voice service is configured." };
            const words = String(text ?? "").replace(/\s+/g, " ").trim();
            if (!words)
                return { ok: false, code: "empty", error: "There's nothing to say." };
            if (words.length > maxChars)
                return { ok: false, code: "too_long", error: `Keep it under ${maxChars} characters.` };
            let last;
            for (const { backend, base, via } of ready) {
                last = backend.kind === "openai" ? await viaOpenai(backend, base, via, words, o) : await viaFlatline(base, via, words, o);
                if (last.result.ok || !last.moveOn)
                    break;
            }
            return last.result;
        },
        async presets() {
            for (const { backend, base } of ready) {
                if (backend.kind !== "flatline")
                    continue;
                const found = await info(base);
                if (found)
                    return found.presets;
            }
            return null;
        },
        async health() {
            const up = await Promise.all(ready.map(({ backend, base }) => backend.kind === "openai" ? openaiUp(doFetch, base, backend.apiKey) : info(base).then((i) => i !== null)));
            return up.some(Boolean);
        },
    };
}
//# sourceMappingURL=speak.js.map