// Dixie: the voice that reads text aloud. Given an endpoint (your app's, in front of the
// flatline-voice service), she speaks with the server's voice, her own; otherwise, or when the
// server can't, with the phone's speech (speechSynthesis), on the device.
//
// Browser quirks it handles: the list of phone voices arrives late (empty at first on many
// phones), and sound must start from a tap: on iPhone the audio player is unlocked inside the
// tap, before the server's audio arrives.

/** "blocked": the browser refused to play the server's voice (no tap yet): call unlock() from a tap. */
export type SpeakResult = "done" | "cancelled" | "unavailable" | "failed" | "blocked";

export interface SpeakOptions {
  /** A language tag; picks the best voice for it. Default: the page's language, else "en". */
  lang?: string;
  /** A voice by name (as the phone lists it); falls back to the best for the language. */
  voice?: string;
  /** 0.5 (slow) to 2 (fast). Default 1. */
  rate?: number;
  /** 0 to 2. Default 1. */
  pitch?: number;
  /** Speak with the server's voice: POST { text, preset, format } here, audio back. null = the
   *  phone's voice even when configure() set an endpoint. */
  endpoint?: string | null;
  /** The server preset (a character, e.g. "kestrel"). Unset: the service's default (flatline). */
  preset?: string;
  /** Extra request headers (a session token, say). */
  headers?: Record<string, string>;
  /** Give up on the server and use the phone's voice after this long. Default 15 s. */
  timeoutMs?: number;
  /** When the server can't speak (down, too slow, an error), use the phone's voice. Default true;
   *  false resolves "failed" instead, for an app that would rather say nothing than switch voice. */
  fallback?: boolean;
}

/** Defaults for every speak(): set the endpoint once, e.g. configure({ endpoint: "/api/voice/speak" }). */
export interface DixieConfig { endpoint?: string | null; preset?: string; headers?: Record<string, string>; format?: "mp3" | "m4a" | "ogg" | "wav"; timeoutMs?: number; fallback?: boolean }
let config: DixieConfig = {};
export function configure(c: DixieConfig): void { config = { ...config, ...c }; }

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

/** What is being said now, so hush() (or the next speak) can settle it as "cancelled". */
let current: { settle: (r: SpeakResult) => void } | null = null;

/**
 * Load the phone's voices ahead of time (call once, early): speak() never waits for them,
 * because on iPhone any wait between the tap and speaking can lose the tap's permission.
 */
export function primeVoices(): void { void loadVoices(); }

// --- the server's voice, through one shared audio player -------------------------------------

let player: HTMLAudioElement | null = null;
/** A 20 ms silent WAV: played inside the tap, it unlocks the player for what comes later. */
function silentWav(): string {
  const n = 160, b = new Uint8Array(44 + n * 2), v = new DataView(b.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  let bin = ""; for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
}
function unlockedPlayer(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!player) { player = new Audio(); player.preload = "auto"; }
  try { player.src = silentWav(); void player.play().catch(() => {}); } catch { /* the real play() will say */ }
  return player;
}

/**
 * Let the server's voice play later. Browsers (iPhone above all) only start sound that a tap
 * began, so a voice that arrives after a wait, such as a question read aloud when the answer
 * to the last one comes back, is refused unless the player was unlocked by a tap before.
 * Call it from the tap that turns reading aloud on (or the first tap in the page). Safe to
 * repeat; false when this browser has no audio player.
 */
export function unlock(): boolean { return unlockedPlayer() !== null; }

/** Which voice said the last thing: the server's, or the phone's (null: nothing yet). */
let voiceUsed: "server" | "phone" | null = null;
export const lastVoice = (): "server" | "phone" | null => voiceUsed;

/**
 * Say something. Resolves when it has been said ("done"), or when it was stopped by hush(), a
 * newer speak() or record() ("cancelled"). One at a time. With an endpoint, the server's voice;
 * if the server can't speak (down, too slow, an error), the phone's voice instead. Call it from
 * a tap the first time: it starts the sound at once.
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<SpeakResult> {
  const words = text.trim();
  if (!words) return Promise.resolve("done");
  const endpoint = opts.endpoint === null ? null : (opts.endpoint ?? config.endpoint ?? null);
  const useServer = !!endpoint && typeof Audio !== "undefined" && typeof fetch !== "undefined";
  if (!useServer && !canSpeak()) return Promise.resolve("unavailable");

  hush();   // whatever she was saying is cut off, and reported as cancelled
  const el = useServer ? unlockedPlayer() : null;   // inside the tap
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const me = { settle };
    function settle(r: SpeakResult) {
      if (settled) return;
      settled = true;
      for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } }
      if (current === me) current = null;
      resolve(r);
    }
    current = me;

    const phone = () => {
      if (settled) return;
      for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } }
      if (useServer && (opts.fallback ?? config.fallback) === false) { settle("failed"); return; }
      if (!canSpeak()) { settle("unavailable"); return; }
      voiceUsed = "phone";
      sayOnPhone(words, opts, settle, cleanups);
    };
    if (!useServer || !el || !endpoint) { phone(); return; }

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
      if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("audio/")) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      if (settled) return;
      clearTimeout(timer);
      const url = URL.createObjectURL(blob);
      cleanups.push(() => {
        el.onended = el.onerror = el.onloadedmetadata = null;
        el.pause(); el.removeAttribute("src"); el.load();
        URL.revokeObjectURL(url);
      });
      el.onended = () => settle("done");
      el.onerror = () => phone();
      // If the player never says it ended, stop waiting after twice its length.
      el.onloadedmetadata = () => {
        if (!Number.isFinite(el.duration)) return;
        const g = setTimeout(() => settle("done"), el.duration * 2000 + 3000);
        cleanups.push(() => clearTimeout(g));
      };
      el.src = url;
      voiceUsed = "server";
      await el.play();
    }).catch((e) => {
      // The browser said no to sound nobody tapped for. The phone's own voice would be refused
      // too (or be the wrong voice), so say so rather than switching: the app can unlock() on
      // its next tap and ask again.
      if ((e as { name?: string })?.name === "NotAllowedError" && !settled) {
        for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } }
        voiceUsed = null;
        settle("blocked");
        return;
      }
      phone();
    });
  });
}

/** The phone's own speech, settling through `settle`. */
function sayOnPhone(words: string, opts: SpeakOptions, settle: (r: SpeakResult) => void, cleanups: Array<() => void>) {
  const lang = opts.lang ?? ((typeof document !== "undefined" && document.documentElement.lang) || "en");
  const u = new SpeechSynthesisUtterance(words);
  const v = chooseVoice(speechSynthesis.getVoices(), lang, opts.voice);
  u.lang = v?.lang ?? lang;
  // A voice the browser won't take (it changed under us) still leaves the language set.
  if (v) { try { u.voice = v; } catch { /* the language picks one */ } }
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
  try { speechSynthesis.speak(u); } catch { settle("failed"); }
}

/** Stop talking now. A speak() in progress resolves "cancelled". Safe to call any time. */
export function hush(): void {
  const c = current;
  current = null;
  c?.settle("cancelled");
  if (canSpeak()) speechSynthesis.cancel();
}

/** Is she talking (or about to, the server's audio on its way)? */
export const speaking = (): boolean => current !== null;

/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export const dixie = { speak, hush, speaking, configure, primeVoices, canSpeak, loadVoices, chooseVoice, unlock, lastVoice };
