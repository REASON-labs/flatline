// Text to speech on your own server: the flatline-voice service on loopback (see
// server/install-voice.sh). Text goes to that one address; the audio comes back to you.

export type SpeakFormat = "m4a" | "mp3" | "ogg" | "wav";

export type SpeakErrorCode =
  | "unavailable"     // no URL configured, or the service can't be reached
  | "empty"           // nothing to say
  | "too_long"        // over maxChars: never sent
  | "unknown_preset"  // the service has no such preset
  | "busy"            // the service's queue is full: try again shortly
  | "timeout"         // no audio after timeoutMs
  | "bad_response";   // the service answered, but not with audio

export type SpeakResult =
  | { ok: true; audio: Uint8Array; contentType: string; ms: number }
  | { ok: false; code: SpeakErrorCode; error: string };

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
  /** The voice service, e.g. "http://127.0.0.1:8087". Empty: every call is "unavailable". */
  url: string | undefined;
  /** Longest wait for one piece of speech. Default 60 s (the service queues one at a time). */
  timeoutMs?: number;
  /** Refuse longer text before sending. Default 1500 characters (about a minute and a half). */
  maxChars?: number;
  /** For tests: a stand-in for the global fetch. */
  fetch?: typeof fetch;
}

export interface Speaker {
  /** Text in, audio out. Preset: a character's (flatline/cast), unset for the service's default (flatline); format default "m4a" (AAC: Signal, iPhone). */
  speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
  /** The service's presets, or null when it can't be reached. */
  presets(): Promise<string[] | null>;
  /** Is the service up? */
  health(): Promise<boolean>;
  readonly configured: boolean;
}

/** The content type for each format, as the service answers it. */
export const SPEAK_TYPES: Record<SpeakFormat, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" };

export function createSpeaker(opts: SpeakerOptions): Speaker {
  const base = (opts.url ?? "").trim().replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxChars = opts.maxChars ?? 1500;
  const doFetch = opts.fetch ?? fetch;

  async function info(): Promise<{ presets: string[] } | null> {
    if (!base) return null;
    try {
      const res = await doFetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => null) as { presets?: unknown } | null;
      return res.ok && body && Array.isArray(body.presets) ? { presets: body.presets.filter((p): p is string => typeof p === "string") } : null;
    } catch { return null; }
  }

  return {
    configured: !!base,

    async speak(text, o = {}) {
      if (!base) return { ok: false, code: "unavailable", error: "No voice service is configured." };
      const words = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!words) return { ok: false, code: "empty", error: "There's nothing to say." };
      if (words.length > maxChars) return { ok: false, code: "too_long", error: `Keep it under ${maxChars} characters.` };
      const started = Date.now();
      try {
        const res = await doFetch(`${base}/speak`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: words, ...(o.preset ? { preset: o.preset } : {}), format: o.format ?? "m4a",
            ...(o.tune ? { tune: o.tune } : {}), ...(typeof o.pace === "number" ? { pace: o.pace } : {}), ...(o.pauses ? { pauses: o.pauses } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const type = res.headers.get("content-type") ?? "";
        if (res.ok && type.startsWith("audio/")) {
          const audio = new Uint8Array(await res.arrayBuffer());
          if (!audio.byteLength) return { ok: false, code: "bad_response", error: "The voice service sent no audio." };
          return { ok: true, audio, contentType: type, ms: Date.now() - started };
        }
        const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        const code = body?.code;
        const known: SpeakErrorCode[] = ["empty", "too_long", "unknown_preset", "busy", "timeout"];
        const error = typeof body?.error === "string" ? body.error : `The voice service answered ${res.status}.`;
        return { ok: false, code: known.includes(code as SpeakErrorCode) ? code as SpeakErrorCode : "bad_response", error };
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") return { ok: false, code: "timeout", error: `No speech after ${Math.round(timeoutMs / 1000)} s.` };
        return { ok: false, code: "unavailable", error: `Can't reach the voice service (${String((e as Error)?.message ?? e)}).` };
      }
    },

    async presets() { return (await info())?.presets ?? null; },
    async health() { return (await info()) !== null; },
  };
}
