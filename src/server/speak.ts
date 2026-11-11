// Text to speech: the flatline-voice service on loopback (see server/install-voice.sh) by
// default, where text goes to that one address and the audio comes back. An app may instead
// list backends, tried in order, and one of them may be an OpenAI-style service (its own, or a
// cloud one): the text then goes where the app said, and only there.
import { baseOf, bearer, isTimeout, openaiUp, refusal, safeText, shouldMoveOn, type Via } from "./backend.js";

export type SpeakFormat = "m4a" | "mp3" | "ogg" | "wav";

export type SpeakErrorCode =
  | "unavailable"     // no URL configured, or the service can't be reached
  | "empty"           // nothing to say
  | "too_long"        // over maxChars: never sent
  | "unknown_preset"  // the service has no such preset
  | "busy"            // the service's queue is full: try again shortly
  | "timeout"         // no audio after timeoutMs
  | "bad_response";   // the service answered, but not with audio

/** Where the text can be sent. */
export type VoiceBackend =
  /** The flatline-voice service (server/install-voice.sh), e.g. "http://127.0.0.1:8087". */
  | { kind: "flatline"; url: string }
  /**
   * Anything with OpenAI's speech API: POST {url}/audio/speech, asked for WAV. The url ends
   * before "/audio". `maxChars` is the most text the service takes in one request (default
   * 200): longer text is split at sentence ends and the WAVs joined. The audio is always WAV,
   * and presets, tune, pace and pauses don't apply: the voice is the one named here.
   */
  | { kind: "openai"; url: string; model: string; voice: string; apiKey?: string; maxChars?: number; timeoutMs?: number };

export type VoiceVia = Via<VoiceBackend["kind"]>;

export type SpeakResult =
  /**
   * `via`: which backend answered (its place in the list, 0 first, and its kind). `format`:
   * what the audio is. `note`: set when that isn't the format asked for (an "openai" backend
   * answers WAV whatever was asked).
   */
  | { ok: true; audio: Uint8Array; contentType: string; ms: number; via: VoiceVia; format: SpeakFormat; note?: string }
  /** `via`: the backend that gave this answer; unset when nothing was sent. */
  | { ok: false; code: SpeakErrorCode; error: string; via?: VoiceVia };

/** Numbers that override a preset's effects for one request (for tuning by ear). */
export interface Tune {
  pitch?: number; highpass?: number; lowpass?: number; drive?: number; loudness?: number;
  presence?: { freq?: number; gain?: number };
  compress?: { threshold?: number; ratio?: number };
  echo?: { delay?: number; decay?: number };
}

/** Pauses (seconds) after a statement, a clause and a question, for one request (0..3). */
export interface Pauses { stop?: number; clause?: number; question?: number }

/** What one request can change: the preset, the format, the sound, the pace and the pauses. */
export interface SpeakOptions {
  preset?: string;
  format?: SpeakFormat;
  tune?: Tune;
  /** × the preset's speed: 0.6..1.4 in steps of 0.05; lower is slower (0.75 for slow guidance). */
  pace?: number;
  /** Merged over the preset's own pauses. */
  pauses?: Pauses;
}

export interface SpeakerOptions {
  /** The voice service, e.g. "http://127.0.0.1:8087": short for one "flatline" backend. */
  url?: string | undefined;
  /**
   * Backends, tried in order (when set, `url` is ignored). The next one is tried only when one
   * is unreachable, times out, or answers 429 or 5xx; never for text that is empty or too
   * long, or another 4xx. None (and no `url`): every call is "unavailable".
   */
  backends?: VoiceBackend[];
  /** Longest wait for one backend. Default 60 s (the service queues one at a time). */
  timeoutMs?: number;
  /** Refuse longer text before sending. Default 1500 characters (about a minute and a half). */
  maxChars?: number;
  /** For tests: a stand-in for the global fetch. */
  fetch?: typeof fetch;
}

export interface Speaker {
  /** Text in, audio out. Preset: a character's (flatline/cast), unset for the service's default (flatline); format default "m4a" (AAC: Signal, iPhone). */
  speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
  /** The presets of the first "flatline" backend that answers, or null when none does. */
  presets(): Promise<string[] | null>;
  /** Is any backend up? */
  health(): Promise<boolean>;
  readonly configured: boolean;
}

/** The content type for each format, as the service answers it. */
export const SPEAK_TYPES: Record<SpeakFormat, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };

/**
 * Text in pieces of at most `max` characters, cut at the last sentence end that fits, else the
 * last comma (or semicolon or colon), else the last space, else mid-word. Nothing is lost:
 * joined with spaces, the pieces are the text.
 */
export function splitText(text: string, max = 200): string[] {
  const limit = Math.max(1, Math.floor(max) || 1);
  const out: string[] = [];
  let rest = String(text ?? "").replace(/\s+/g, " ").trim();
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1);
    let cut = lastEnd(head, /[.!?…]+["'”’)\]]*(?=\s)/g) || lastEnd(head, /[,;:—](?=\s)/g) || Math.max(0, head.lastIndexOf(" "));
    if (!cut) {
      cut = limit;
      // Not between the two halves of one character (an emoji, say).
      const c = rest.charCodeAt(cut - 1);
      if (cut > 1 && c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function lastEnd(s: string, re: RegExp): number {
  let end = 0;
  for (const m of s.matchAll(re)) end = m.index + m[0].length;
  return end;
}

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** The format chunk and the samples of a WAV, or null when it isn't one. */
function readWav(b: Uint8Array): { fmt: Uint8Array; data: Uint8Array } | null {
  if (b.byteLength < 12 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt: Uint8Array | null = null;
  for (let at = 12; at + 8 <= b.byteLength;) {
    const id = tag(b, at);
    const left = b.byteLength - at - 8;
    let size = view.getUint32(at + 4, true);
    // A streamed WAV may not know its length (0 or 0xFFFFFFFF): the samples run to the end.
    if (id === "data" && (size === 0 || size > left)) size = left;
    if (size > left) return null;
    if (id === "fmt ") fmt = b.subarray(at + 8, at + 8 + size);
    if (id === "data") return fmt && fmt.byteLength >= 16 ? { fmt, data: b.subarray(at + 8, at + 8 + size) } : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Several WAVs of the same kind (rate, channels, sample size) as one, in order. One WAV comes
 * back tidied (a plain header, its real length). Null when one isn't a WAV, or they differ.
 */
export function joinWavs(wavs: Uint8Array[]): Uint8Array | null {
  const parts = wavs.map(readWav);
  const first = parts[0];
  if (!first || parts.some((p) => !p)) return null;
  const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
  if (!parts.every((p) => same(p!.fmt, first.fmt))) return null;
  const block = Math.max(1, new DataView(first.fmt.buffer, first.fmt.byteOffset, first.fmt.byteLength).getUint16(12, true));
  // Whole sample frames only, so a ragged end never shifts what follows it.
  const datas = parts.map((p) => p!.data.subarray(0, p!.data.byteLength - (p!.data.byteLength % block)));
  const n = datas.reduce((a, d) => a + d.byteLength, 0);
  const fmtPad = first.fmt.byteLength % 2;
  const out = new Uint8Array(12 + 8 + first.fmt.byteLength + fmtPad + 8 + n + (n % 2));
  const view = new DataView(out.buffer);
  const put = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  put(0, "RIFF"); view.setUint32(4, out.byteLength - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, first.fmt.byteLength, true); out.set(first.fmt, 20);
  let at = 20 + first.fmt.byteLength + fmtPad;
  put(at, "data"); view.setUint32(at + 4, n, true); at += 8;
  for (const d of datas) { out.set(d, at); at += d.byteLength; }
  return out;
}

type Attempt = { result: SpeakResult; moveOn: boolean };
type Ready = { backend: VoiceBackend; base: string; via: VoiceVia };

export function createSpeaker(opts: SpeakerOptions): Speaker {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxChars = opts.maxChars ?? 1500;
  const doFetch = opts.fetch ?? fetch;
  const listed: VoiceBackend[] = Array.isArray(opts.backends) && opts.backends.length ? opts.backends : [{ kind: "flatline", url: opts.url ?? "" }];
  // A backend without an address is left out; `index` stays its place in the list as given.
  const ready: Ready[] = listed
    .map((backend, index) => ({ backend, base: baseOf(backend?.url), via: { index, kind: backend?.kind } }))
    .filter((b) => b.backend && b.base && (b.backend.kind === "flatline" || b.backend.kind === "openai"));

  async function info(base: string): Promise<{ presets: string[] } | null> {
    try {
      const res = await doFetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => null) as { presets?: unknown } | null;
      return res.ok && body && Array.isArray(body.presets) ? { presets: body.presets.filter((p): p is string => typeof p === "string") } : null;
    } catch { return null; }
  }

  const failed = (e: unknown, wait: number, via: VoiceVia, key?: string): Attempt => isTimeout(e)
    ? { result: { ok: false, code: "timeout", error: `No speech after ${Math.round(wait / 1000)} s.`, via }, moveOn: true }
    : { result: { ok: false, code: "unavailable", error: `Can't reach the voice service (${safeText((e as Error)?.message ?? e, key)}).`, via }, moveOn: true };

  async function viaFlatline(base: string, via: VoiceVia, words: string, o: SpeakOptions): Promise<Attempt> {
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
        if (!audio.byteLength) return { result: { ok: false, code: "bad_response", error: "The voice service sent no audio.", via }, moveOn: false };
        return { result: { ok: true, audio, contentType: type, ms: Date.now() - started, via, format }, moveOn: false };
      }
      const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
      const code = body?.code;
      const known: SpeakErrorCode[] = ["empty", "too_long", "unknown_preset", "busy", "timeout"];
      const error = typeof body?.error === "string" ? body.error : `The voice service answered ${res.status}.`;
      return { result: { ok: false, code: known.includes(code as SpeakErrorCode) ? code as SpeakErrorCode : "bad_response", error, via }, moveOn: shouldMoveOn(res.status) };
    } catch (e) {
      return failed(e, timeoutMs, via);
    }
  }

  async function viaOpenai(backend: Extract<VoiceBackend, { kind: "openai" }>, base: string, via: VoiceVia, words: string, o: SpeakOptions): Promise<Attempt> {
    const started = Date.now();
    const key = backend.apiKey;
    const wait = backend.timeoutMs ?? timeoutMs;
    const wavs: Uint8Array[] = [];
    try {
      // One piece at a time, in order, all within the one wait.
      for (const input of splitText(words, backend.maxChars ?? 200)) {
        const left = wait - (Date.now() - started);
        if (left <= 0) return failed({ name: "TimeoutError" }, wait, via);
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
    } catch (e) {
      return failed(e, wait, via, key);
    }
    const audio = joinWavs(wavs);
    if (!audio || audio.byteLength <= 44) return { result: { ok: false, code: "bad_response", error: "The voice service didn't send WAV audio.", via }, moveOn: false };
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
      if (!ready.length) return { ok: false, code: "unavailable", error: "No voice service is configured." };
      const words = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!words) return { ok: false, code: "empty", error: "There's nothing to say." };
      if (words.length > maxChars) return { ok: false, code: "too_long", error: `Keep it under ${maxChars} characters.` };
      let last: Attempt | undefined;
      for (const { backend, base, via } of ready) {
        last = backend.kind === "openai" ? await viaOpenai(backend, base, via, words, o) : await viaFlatline(base, via, words, o);
        if (last.result.ok || !last.moveOn) break;
      }
      return last!.result;
    },

    async presets() {
      for (const { backend, base } of ready) {
        if (backend.kind !== "flatline") continue;
        const found = await info(base);
        if (found) return found.presets;
      }
      return null;
    },

    async health() {
      const up = await Promise.all(ready.map(({ backend, base }) => backend.kind === "openai" ? openaiUp(doFetch, base, backend.apiKey) : info(base).then((i) => i !== null)));
      return up.some(Boolean);
    },
  };
}
