// Dixie: the voice that reads text aloud, using the phone's own speech (speechSynthesis). It
// runs on the device, so the words aren't sent anywhere, and works on iPhone and Android.
//
// Two browser quirks it handles: the list of voices arrives late (it is empty at first on many
// phones), and speech must start from a tap the first time.

export type SpeakResult = "done" | "cancelled" | "unavailable" | "failed";

export interface SpeakOptions {
  /** A language tag; picks the best voice for it. Default: the page's language, else "en". */
  lang?: string;
  /** A voice by name (as the phone lists it); falls back to the best for the language. */
  voice?: string;
  /** 0.5 (slow) to 2 (fast). Default 1. */
  rate?: number;
  /** 0 to 2. Default 1. */
  pitch?: number;
}

/** The parts of a voice that matter for choosing one (SpeechSynthesisVoice, or a test double). */
export interface VoiceInfo { name: string; lang: string; localService: boolean; default?: boolean }

/** Names that mark the better-sounding voices on Apple, Google and Microsoft systems. */
const QUALITY = /enhanced|premium|natural|neural|siri|google/i;
/** Novelty voices that come with some systems. */
const NOVELTY = /bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy/i;

/**
 * The best voice for a language: the exact language before others, better-sounding before
 * plain, on-device before network voices, never a novelty voice. Pure, for tests.
 */
export function chooseVoice<V extends VoiceInfo>(voices: readonly V[], lang = "en", name?: string): V | null {
  if (name) { const named = voices.find((v) => v.name === name); if (named) return named; }
  const want = lang.toLowerCase();
  const base = want.split("-")[0];
  const score = (v: V) => {
    const l = v.lang.toLowerCase().replace("_", "-");
    if (NOVELTY.test(v.name)) return -1;
    let s = 0;
    if (l === want) s += 8; else if (l.split("-")[0] === base) s += 4; else return -1;
    if (QUALITY.test(v.name)) s += 2;
    if (v.localService) s += 1;
    if (v.default) s += 0.5;
    return s;
  };
  let best: V | null = null, bestScore = -1;
  for (const v of voices) { const s = score(v); if (s > bestScore) { best = v; bestScore = s; } }
  return best;
}

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

/** The phone's voices, waiting (briefly) for them to arrive. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (!canSpeak()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { speechSynthesis.removeEventListener("voiceschanged", done); clearTimeout(t); resolve(speechSynthesis.getVoices()); };
    const t = setTimeout(done, timeoutMs);
    speechSynthesis.addEventListener("voiceschanged", done);
  });
}

/** Say something. Resolves when it has been said (or stopped). One at a time: a new one cuts off the last. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const words = text.trim();
  if (!words) return "done";
  if (!canSpeak()) return "unavailable";
  const voices = await loadVoices();
  const lang = opts.lang ?? ((typeof document !== "undefined" && document.documentElement.lang) || "en");
  const u = new SpeechSynthesisUtterance(words);
  const v = chooseVoice(voices, lang, opts.voice);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
  u.rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
  u.pitch = Math.min(2, Math.max(0, opts.pitch ?? 1));

  speechSynthesis.cancel();
  return new Promise((resolve) => {
    u.onend = () => resolve("done");
    u.onerror = (e) => resolve(e.error === "canceled" || e.error === "interrupted" ? "cancelled" : "failed");
    speechSynthesis.speak(u);
  });
}

/** Stop talking now. */
export function hush(): void {
  if (canSpeak()) speechSynthesis.cancel();
}

/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export const dixie = { speak, hush, canSpeak, loadVoices, chooseVoice };
