export type ListenState = "waiting" | "speaking" | "trailing";
/** Why listening ended. */
export type StopReason = "silence" | "no_speech" | "max";
export interface SilenceOptions {
    /** Quiet this long after speech ends the recording. Default 1500 ms. */
    silenceMs?: number;
    /** Nothing heard for this long from the start: give up. Default 8000 ms. */
    noSpeechMs?: number;
    /** A hard limit on one recording. Default 120000 ms. */
    maxMs?: number;
    /** Loud this long in a row counts as speech (a click or a bump doesn't). Default 200 ms. */
    minSpeechMs?: number;
    /** Speech is this many times the background level... Default 3. */
    ratio?: number;
    /** ...and at least this loud (RMS, 0 to 1). Default 0.015. */
    floor?: number;
}
export declare class SilenceDetector {
    private readonly o;
    private start;
    private loudSince;
    private quietSince;
    private background;
    state: ListenState;
    /** Set once listening should end. */
    stopped: StopReason | null;
    constructor(opts?: SilenceOptions);
    /** The level that counts as speech right now. */
    get threshold(): number;
    /**
     * One reading: the RMS loudness (0 to 1) at time `now` (ms, any clock that only goes forward).
     * Returns the reason to stop, once there is one; null while it should keep listening.
     */
    feed(level: number, now: number): StopReason | null;
}
/** RMS loudness (0 to 1) of one frame of samples from an AnalyserNode (getFloatTimeDomainData). */
export declare function rms(samples: ArrayLike<number>): number;
