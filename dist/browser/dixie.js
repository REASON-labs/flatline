// Dixie: the voice that reads text aloud. Given an endpoint (your app's, in front of the
// flatline-voice service), she speaks with the server's voice, her own; otherwise, or when the
// server can't, with the phone's speech (speechSynthesis), on the device.
//
// Browser quirks it handles: the list of phone voices arrives late (empty at first on many
// phones), and sound must start from a tap: on iPhone the audio player is unlocked inside the
// tap, before the server's audio arrives.
let config = {};
export function configure(c) { config = { ...config, ...c }; }
/** Names that mark the better-sounding voices on Apple, Google and Microsoft systems. */
const QUALITY = /enhanced|premium|natural|neural|siri|google/i;
/** Novelty voices that come with some systems. */
const NOVELTY = /bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy/i;
/**
 * The best voice for a language: the exact language before others, better-sounding before
 * plain, on-device before network voices, never a novelty voice. Pure, for tests.
 */
export function chooseVoice(voices, lang = "en", name) {
    if (name) {
        const named = voices.find((v) => v.name === name);
        if (named)
            return named;
    }
    const want = lang.toLowerCase();
    const base = want.split("-")[0];
    const score = (v) => {
        const l = v.lang.toLowerCase().replace("_", "-");
        if (NOVELTY.test(v.name))
            return -1;
        let s = 0;
        if (l === want)
            s += 8;
        else if (l.split("-")[0] === base)
            s += 4;
        else
            return -1;
        if (QUALITY.test(v.name))
            s += 2;
        if (v.localService)
            s += 1;
        if (v.default)
            s += 0.5;
        return s;
    };
    let best = null, bestScore = -1;
    for (const v of voices) {
        const s = score(v);
        if (s > bestScore) {
            best = v;
            bestScore = s;
        }
    }
    return best;
}
export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
/** The phone's voices, waiting (briefly) for them to arrive. */
export function loadVoices(timeoutMs = 1500) {
    if (!canSpeak())
        return Promise.resolve([]);
    const now = speechSynthesis.getVoices();
    if (now.length)
        return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = () => { speechSynthesis.removeEventListener("voiceschanged", done); clearTimeout(t); resolve(speechSynthesis.getVoices()); };
        const t = setTimeout(done, timeoutMs);
        speechSynthesis.addEventListener("voiceschanged", done);
    });
}
/** What is being said now, so hush() (or the next speak) can settle it as "cancelled". */
let current = null;
/**
 * Load the phone's voices ahead of time (call once, early): speak() never waits for them,
 * because on iPhone any wait between the tap and speaking can lose the tap's permission.
 */
export function primeVoices() { void loadVoices(); }
// --- the server's voice, through one shared audio player -------------------------------------
let player = null;
/** A 20 ms silent WAV: played inside the tap, it unlocks the player for what comes later. */
function silentWav() {
    const n = 160, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++)
        b[o + i] = s.charCodeAt(i); };
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    let bin = "";
    for (const x of b)
        bin += String.fromCharCode(x);
    return `data:audio/wav;base64,${btoa(bin)}`;
}
function unlockedPlayer() {
    if (typeof Audio === "undefined")
        return null;
    if (!player) {
        player = new Audio();
        player.preload = "auto";
    }
    try {
        player.src = silentWav();
        void player.play().catch(() => { });
    }
    catch { /* the real play() will say */ }
    return player;
}
/**
 * Say something. Resolves when it has been said ("done"), or when it was stopped by hush(), a
 * newer speak() or record() ("cancelled"). One at a time. With an endpoint, the server's voice;
 * if the server can't speak (down, too slow, an error), the phone's voice instead. Call it from
 * a tap the first time: it starts the sound at once.
 */
export function speak(text, opts = {}) {
    const words = text.trim();
    if (!words)
        return Promise.resolve("done");
    const endpoint = opts.endpoint === null ? null : (opts.endpoint ?? config.endpoint ?? null);
    const useServer = !!endpoint && typeof Audio !== "undefined" && typeof fetch !== "undefined";
    if (!useServer && !canSpeak())
        return Promise.resolve("unavailable");
    hush(); // whatever she was saying is cut off, and reported as cancelled
    const el = useServer ? unlockedPlayer() : null; // inside the tap
    return new Promise((resolve) => {
        let settled = false;
        const cleanups = [];
        const me = { settle };
        function settle(r) {
            if (settled)
                return;
            settled = true;
            for (const c of cleanups.splice(0)) {
                try {
                    c();
                }
                catch { /* best effort */ }
            }
            if (current === me)
                current = null;
            resolve(r);
        }
        current = me;
        const phone = () => {
            if (settled)
                return;
            for (const c of cleanups.splice(0)) {
                try {
                    c();
                }
                catch { /* best effort */ }
            }
            if (!canSpeak()) {
                settle("unavailable");
                return;
            }
            sayOnPhone(words, opts, settle, cleanups);
        };
        if (!useServer || !el || !endpoint) {
            phone();
            return;
        }
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? config.timeoutMs ?? 15_000);
        cleanups.push(() => { clearTimeout(timer); ac.abort(); });
        fetch(endpoint, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", ...config.headers, ...opts.headers },
            body: JSON.stringify({ text: words, ...((opts.preset ?? config.preset) ? { preset: opts.preset ?? config.preset } : {}), format: config.format ?? "mp3" }),
            signal: ac.signal,
        }).then(async (res) => {
            if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/"))
                throw new Error(`status ${res.status}`);
            const blob = await res.blob();
            if (settled)
                return;
            clearTimeout(timer);
            const url = URL.createObjectURL(blob);
            cleanups.push(() => {
                el.onended = el.onerror = el.onloadedmetadata = null;
                el.pause();
                el.removeAttribute("src");
                el.load();
                URL.revokeObjectURL(url);
            });
            el.onended = () => settle("done");
            el.onerror = () => phone();
            // If the player never says it ended, stop waiting after twice its length.
            el.onloadedmetadata = () => {
                if (!Number.isFinite(el.duration))
                    return;
                const g = setTimeout(() => settle("done"), el.duration * 2000 + 3000);
                cleanups.push(() => clearTimeout(g));
            };
            el.src = url;
            await el.play();
        }).catch(() => { phone(); });
    });
}
/** The phone's own speech, settling through `settle`. */
function sayOnPhone(words, opts, settle, cleanups) {
    const lang = opts.lang ?? ((typeof document !== "undefined" && document.documentElement.lang) || "en");
    const u = new SpeechSynthesisUtterance(words);
    const v = chooseVoice(speechSynthesis.getVoices(), lang, opts.voice);
    u.lang = v?.lang ?? lang;
    // A voice the browser won't take (it changed under us) still leaves the language set.
    if (v) {
        try {
            u.voice = v;
        }
        catch { /* the language picks one */ }
    }
    const rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
    u.rate = rate;
    u.pitch = Math.min(2, Math.max(0, opts.pitch ?? 1));
    // Safari sometimes never fires "end" for a long sentence: give up waiting after about
    // twice the time it should take, and call it done.
    const guard = setTimeout(() => settle("done"), 3000 + (words.length * 140) / rate);
    cleanups.push(() => clearTimeout(guard));
    // Browsers disagree on what a cancel looks like (an "end", or an "interrupted" error);
    // hush() settles first, so either way the answer is "cancelled".
    u.onend = () => settle("done");
    u.onerror = (e) => settle(e.error === "canceled" || e.error === "interrupted" ? "cancelled" : "failed");
    try {
        speechSynthesis.speak(u);
    }
    catch {
        settle("failed");
    }
}
/** Stop talking now. A speak() in progress resolves "cancelled". Safe to call any time. */
export function hush() {
    const c = current;
    current = null;
    c?.settle("cancelled");
    if (canSpeak())
        speechSynthesis.cancel();
}
/** Is she talking (or about to, the server's audio on its way)? */
export const speaking = () => current !== null;
/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export const dixie = { speak, hush, speaking, configure, primeVoices, canSpeak, loadVoices, chooseVoice };
//# sourceMappingURL=dixie.js.map