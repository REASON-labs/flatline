// Dixie: the voice that reads text aloud, using the phone's own speech (speechSynthesis). It
// runs on the device, so the words aren't sent anywhere, and works on iPhone and Android.
//
// Two browser quirks it handles: the list of voices arrives late (it is empty at first on many
// phones), and speech must start from a tap the first time.
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
/** The sentence being said now, so hush() (or the next speak) can settle it as "cancelled". */
let current = null;
/**
 * Load the voices ahead of time (call once, early): speak() never waits for them, because on
 * iPhone any wait between the tap and speaking can lose the tap's permission to make sound.
 */
export function primeVoices() { void loadVoices(); }
/**
 * Say something. Resolves when it has been said ("done"), or when it was stopped by hush() or
 * a newer speak() ("cancelled"). One at a time. It starts speaking at once, with the best voice
 * already loaded (see primeVoices).
 */
export function speak(text, opts = {}) {
    const words = text.trim();
    if (!words)
        return Promise.resolve("done");
    if (!canSpeak())
        return Promise.resolve("unavailable");
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
    hush(); // whatever she was saying is cut off, and reported as cancelled
    return new Promise((resolve) => {
        let settled = false;
        // Safari sometimes never fires "end" for a long sentence: give up waiting after about
        // twice the time it should take, and call it done.
        const guard = setTimeout(() => settle("done"), 3000 + (words.length * 140) / rate);
        const me = { settle };
        function settle(r) {
            if (settled)
                return;
            settled = true;
            clearTimeout(guard);
            if (current === me)
                current = null;
            resolve(r);
        }
        current = me;
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
    });
}
/** Stop talking now. A speak() in progress resolves "cancelled". Safe to call any time. */
export function hush() {
    if (current)
        current.settle("cancelled");
    if (canSpeak())
        speechSynthesis.cancel();
}
/** Is she talking right now? */
export const speaking = () => current !== null;
/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export const dixie = { speak, hush, speaking, primeVoices, canSpeak, loadVoices, chooseVoice };
//# sourceMappingURL=dixie.js.map