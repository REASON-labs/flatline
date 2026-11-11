// What the speech-to-text and voice clients share when they have more than one backend: which
// failures mean "try the next one", and keeping a key out of anything a caller might log.
/** A backend that is down or overloaded: the next one may still answer. Any other 4xx is about the request itself. */
export function shouldMoveOn(status) {
    return status === 429 || status >= 500;
}
/** No trailing slash; "" when unset. */
export function baseOf(url) {
    return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}
export function bearer(apiKey) {
    const key = (apiKey ?? "").trim();
    return key ? { authorization: `Bearer ${key}` } : {};
}
/** One line, at most 200 characters, with the key (if it is somehow in there) taken out. */
export function safeText(text, apiKey) {
    let s = String(text ?? "").replace(/\s+/g, " ").trim();
    const key = (apiKey ?? "").trim();
    if (key)
        s = s.split(key).join("[key]");
    return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}
/** The reason in an error body: ours ({ error: "…" }) or the OpenAI shape ({ error: { message } }). */
export function reasonIn(body) {
    const e = body?.error;
    if (typeof e === "string")
        return e;
    const m = e?.message;
    return typeof m === "string" ? m : "";
}
/**
 * Why an OpenAI-style service said no, in words safe to log. A refused key (401, 403) never
 * quotes the service's answer: some services repeat part of the key in it.
 */
export function refusal(what, status, body, apiKey) {
    if (status === 401 || status === 403)
        return `The ${what} refused the key (${status}).`;
    if (status === 429)
        return `The ${what} is busy or over its limit (429).`;
    const why = safeText(reasonIn(body), apiKey);
    return `The ${what} answered ${status}${why ? `: ${why}` : ""}.`;
}
export function isTimeout(e) {
    const name = e?.name;
    return name === "TimeoutError" || name === "AbortError";
}
/** Is an OpenAI-style service up, and does it take the key? GET {url}/models. */
export async function openaiUp(doFetch, base, apiKey) {
    try {
        const res = await doFetch(`${base}/models`, { method: "GET", headers: bearer(apiKey), signal: AbortSignal.timeout(3000) });
        return res.ok;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=backend.js.map