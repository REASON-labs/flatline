// Speech to text: a whisper.cpp server on loopback (see server/install.sh) by default, where the
// audio goes to that one address and nowhere else. An app may instead list backends, tried in
// order, and one of them may be an OpenAI-style service (its own, or a cloud one): the audio
// then goes where the app said, and only there. Nothing here keeps it: once it is text, the
// bytes are the caller's to drop.
import { adtsToM4a, sniffAudio } from "./aac.js";
import { baseOf, bearer, isTimeout, openaiUp, reasonIn, refusal, safeText, shouldMoveOn, type Via } from "./backend.js";

/** Why a transcription didn't happen, for the app to word in its own way. */
export type TranscribeErrorCode =
  | "unavailable"   // no URL configured, or the server can't be reached
  | "too_large"     // over maxBytes: never sent
  | "empty"         // no audio at all
  | "timeout"       // the server took longer than timeoutMs
  | "busy"          // an "openai" backend answered 429 (rate limit): try again shortly
  | "bad_response"; // the server answered, but not with a transcript

/** Where the audio can be sent. */
export type SttBackend =
  /** A whisper.cpp server (server/install.sh), e.g. "http://127.0.0.1:8086". */
  | { kind: "whispercpp"; url: string }
  /**
   * Anything with OpenAI's transcription API: POST {url}/audio/transcriptions. The url ends
   * before "/audio" (e.g. "https://api.example.com/v1"). The key, when set, is sent as a Bearer
   * token and appears nowhere else.
   */
  | { kind: "openai"; url: string; model: string; apiKey?: string; timeoutMs?: number };

export type SttVia = Via<SttBackend["kind"]>;

export type TranscribeResult =
  /** `via`: which backend answered (its place in the list, 0 first, and its kind). */
  | { ok: true; text: string; ms: number; via: SttVia }
  /** `via`: the backend that gave this answer; unset when nothing was sent. */
  | { ok: false; code: TranscribeErrorCode; error: string; via?: SttVia };

export interface TranscriberOptions {
  /** The whisper.cpp server, e.g. "http://127.0.0.1:8086": short for one "whispercpp" backend. */
  url?: string | undefined;
  /**
   * Backends, tried in order (when set, `url` is ignored). The next one is tried only when one
   * is unreachable, times out, or answers 429 or 5xx; never for audio that is empty or too
   * large, or another 4xx. None (and no `url`): every call is "unavailable".
   */
  backends?: SttBackend[];
  /** Longest wait for one backend. Default 120 s (a long memo on a small box). */
  timeoutMs?: number;
  /** Refuse anything bigger, before sending. Default 25 MB (about 25 minutes of a phone memo). */
  maxBytes?: number;
  /** A language code ("en"), or "auto". Default: whatever the server was started with. */
  language?: string;
  /** For tests: a stand-in for the global fetch. */
  fetch?: typeof fetch;
}

export interface Transcriber {
  /** Audio in (any format ffmpeg reads, when the server runs with --convert), text out. */
  transcribe(audio: Uint8Array, contentType?: string): Promise<TranscribeResult>;
  /** Is any backend up? A cheap request to each, safe to call on a timer. */
  health(): Promise<boolean>;
  /** Is any backend configured at all (it may still be down)? */
  readonly configured: boolean;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX = 25 * 1024 * 1024;

/**
 * Whisper writes sounds that aren't speech in brackets ("[BLANK_AUDIO]", "(wind blowing)",
 * "[Music]"). They are not words someone said: drop them, and tidy the spacing.
 */
export function cleanTranscript(raw: string): string {
  return raw.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
}

/** A file name with an extension whisper's ffmpeg step recognises, from a content type. */
export function fileNameFor(contentType: string | undefined): string {
  const t = (contentType ?? "").toLowerCase();
  const ext =
    t.includes("webm") ? "webm" :
    t.includes("ogg") || t.includes("opus") ? "ogg" :
    t.includes("mp4") || t.includes("m4a") ? "m4a" :
    t.includes("aac") ? "aac" :
    t.includes("mpeg") || t.includes("mp3") ? "mp3" :
    t.includes("wav") ? "wav" :
    t.includes("flac") ? "flac" : "audio";
  return `audio.${ext}`;
}

const SNIFFED_TYPES: Record<string, string> = { m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac", webm: "audio/webm", mp3: "audio/mpeg" };

/** The recording as an OpenAI-style service wants it: named (and typed) for what the bytes are. */
function forOpenai(audio: Uint8Array, contentType: string | undefined): { bytes: Uint8Array; type: string; name: string } {
  const is = sniffAudio(audio);
  if (is === "aac") {
    const m4a = adtsToM4a(audio);
    if (m4a) return { bytes: m4a, type: "audio/mp4", name: "audio.m4a" };
  } else if (is) {
    return { bytes: audio, type: SNIFFED_TYPES[is]!, name: `audio.${is}` };
  }
  return { bytes: audio, type: contentType || "application/octet-stream", name: fileNameFor(contentType) };
}

type Attempt = { result: TranscribeResult; moveOn: boolean };
type Ready = { backend: SttBackend; base: string; via: SttVia };

export function createTranscriber(opts: TranscriberOptions): Transcriber {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX;
  const doFetch = opts.fetch ?? fetch;
  const listed: SttBackend[] = Array.isArray(opts.backends) && opts.backends.length ? opts.backends : [{ kind: "whispercpp", url: opts.url ?? "" }];
  // A backend without an address is left out; `index` stays its place in the list as given.
  const ready: Ready[] = listed
    .map((backend, index) => ({ backend, base: baseOf(backend?.url), via: { index, kind: backend?.kind } }))
    .filter((b) => b.backend && b.base && (b.backend.kind === "whispercpp" || b.backend.kind === "openai"));

  async function attempt({ backend, base, via }: Ready, audio: Uint8Array, contentType: string | undefined): Promise<Attempt> {
    const openai = backend.kind === "openai";
    const key = openai ? backend.apiKey : undefined;
    const wait = (openai ? backend.timeoutMs : undefined) ?? timeoutMs;
    const form = new FormData();
    // whisper.cpp reads anything ffmpeg does. An OpenAI-style service goes by what the file is
    // and what it is called: name it for what it really is, and put a bare AAC stream (a voice
    // note from some messengers) into an MP4 file first.
    const file = openai ? forOpenai(audio, contentType) : { bytes: audio, type: contentType || "application/octet-stream", name: fileNameFor(contentType) };
    form.append("file", new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
    if (openai) form.append("model", backend.model);
    form.append("response_format", "json");
    form.append("temperature", "0");
    // OpenAI-style services detect the language when none is given; "auto" is whisper.cpp's word.
    if (opts.language && !(openai && opts.language === "auto")) form.append("language", opts.language);

    const started = Date.now();
    try {
      const signal = AbortSignal.timeout(wait);
      const res = await doFetch(openai ? `${base}/audio/transcriptions` : `${base}/inference`, {
        method: "POST", body: form, ...(openai ? { headers: bearer(key) } : {}), signal,
      });
      const body = await res.json().catch(() => null) as { text?: unknown; error?: unknown } | null;
      // The wait can run out after the answer has started: that is a timeout, not a bad answer.
      if (!body && signal.aborted) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
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
    } catch (e) {
      if (isTimeout(e)) return { result: { ok: false, code: "timeout", error: `No transcript after ${Math.round(wait / 1000)} s.`, via }, moveOn: true };
      return { result: { ok: false, code: "unavailable", error: `Can't reach the speech-to-text server (${safeText((e as Error)?.message ?? e, key)}).`, via }, moveOn: true };
    }
  }

  return {
    configured: ready.length > 0,

    async transcribe(audio, contentType) {
      if (!ready.length) return { ok: false, code: "unavailable", error: "No speech-to-text server is configured." };
      if (!audio || audio.byteLength === 0) return { ok: false, code: "empty", error: "There was no audio." };
      if (audio.byteLength > maxBytes) return { ok: false, code: "too_large", error: `The audio is over ${Math.round(maxBytes / 1024 / 1024)} MB.` };
      let last: Attempt | undefined;
      for (const b of ready) {
        last = await attempt(b, audio, contentType);
        if (last.result.ok || !last.moveOn) break;
      }
      return last!.result;
    },

    async health() {
      const up = await Promise.all(ready.map(async ({ backend, base }) => {
        if (backend.kind === "openai") return openaiUp(doFetch, base, backend.apiKey);
        try {
          // whisper.cpp's server answers GET / with its demo page: up means it answers at all.
          const res = await doFetch(`${base}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
          return res.status < 500;
        } catch {
          return false;
        }
      }));
      return up.some(Boolean);
    },
  };
}
