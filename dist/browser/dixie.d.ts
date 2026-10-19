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
 * Load the voices ahead of time (call once, early): speak() never waits for them, because on
 * iPhone any wait between the tap and speaking can lose the tap's permission to make sound.
 */
export declare function primeVoices(): void;
/**
 * Say something. Resolves when it has been said ("done"), or when it was stopped by hush() or
 * a newer speak() ("cancelled"). One at a time. It starts speaking at once, with the best voice
 * already loaded (see primeVoices).
 */
export declare function speak(text: string, opts?: SpeakOptions): Promise<SpeakResult>;
/** Stop talking now. A speak() in progress resolves "cancelled". Safe to call any time. */
export declare function hush(): void;
/** Is she talking right now? */
export declare const speaking: () => boolean;
/** Dixie, as one object: `dixie.speak("Hi")`, `dixie.hush()`. */
export declare const dixie: {
    speak: typeof speak;
    hush: typeof hush;
    speaking: typeof speaking;
    primeVoices: typeof primeVoices;
    canSpeak: typeof canSpeak;
    loadVoices: typeof loadVoices;
    chooseVoice: typeof chooseVoice;
};
