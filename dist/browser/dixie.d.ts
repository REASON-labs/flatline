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
    /** Speak with the server's voice: POST { text, preset, format } here, audio back. null = the
     *  phone's voice even when configure() set an endpoint. */
    endpoint?: string | null;
    /** The server preset (a character, e.g. "kestrel"). Unset: the service's default (flatline). */
    preset?: string;
    /** Extra request headers (a session token, say). */
    headers?: Record<string, string>;
    /** Give up on the server and use the phone's voice after this long. Default 15 s. */
    timeoutMs?: number;
}
/** Defaults for every speak(): set the endpoint once, e.g. configure({ endpoint: "/api/voice/speak" }). */
export interface DixieConfig {
    endpoint?: string | null;
    preset?: string;
    headers?: Record<string, string>;
    format?: "mp3" | "m4a" | "ogg" | "wav";
    timeoutMs?: number;
}
export declare function configure(c: DixieConfig): void;
/** The parts of a voice that matter for choosing one (SpeechSynthesisVoice, or a test double). */
export interface VoiceInfo {
    name: string;
    lang: string;
    localService: boolean;
    default?: boolean;
}
/**
 * The best voice for a language: the exact language before others, better-sounding before
 * plain, on-device before network voices, never a novelty voice. Pure, for tests.
 */
export declare function chooseVoice<V extends VoiceInfo>(voices: readonly V[], lang?: string, name?: string): V | null;
export declare const canSpeak: () => boolean;
/** The phone's voices, waiting (briefly) for them to arrive. */
export declare function loadVoices(timeoutMs?: number): Promise<SpeechSynthesisVoice[]>;
/**
 * Load the phone's voices ahead of time (call once, early): speak() never waits for them,
 * because on iPhone any wait between the tap and speaking can lose the tap's permission.
 */
export declare function primeVoices(): void;
/**
 * Say something. Resolves when it has been said ("done"), or when it was stopped by hush(), a
 * newer speak() or record() ("cancelled"). One at a time. With an endpoint, the server's voice;
 * if the server can't speak (down, too slow, an error), the phone's voice instead. Call it from
 * a tap the first time: it starts the sound at once.
 */
export declare function speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
/** Stop talking now. A speak() in progress resolves "cancelled". Safe to call any time. */
export declare function hush(): void;
/** Is she talking (or about to, the server's audio on its way)? */
export declare const speaking: () => boolean;
/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export declare const dixie: {
    speak: typeof speak;
    hush: typeof hush;
    speaking: typeof speaking;
    configure: typeof configure;
    primeVoices: typeof primeVoices;
    canSpeak: typeof canSpeak;
    loadVoices: typeof loadVoices;
    chooseVoice: typeof chooseVoice;
};
