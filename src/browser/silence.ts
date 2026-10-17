// When to stop listening: a small state machine fed one loudness reading at a time. Pure (no
// browser), so it is tested on its own. The recorder feeds it from a Web Audio analyser.
//
// It learns the room's background level from the quietest readings, so a fan or a car doesn't
// count as talking, and only calls it speech once it has heard enough of it in a row.

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

export class SilenceDetector {
  private readonly o: Required<SilenceOptions>;
  private start: number | null = null;
  private loudSince: number | null = null;
  private quietSince: number | null = null;
  private background = Infinity;
  state: ListenState = "waiting";
  /** Set once listening should end. */
  stopped: StopReason | null = null;

  constructor(opts: SilenceOptions = {}) {
    this.o = { silenceMs: 1500, noSpeechMs: 8000, maxMs: 120_000, minSpeechMs: 200, ratio: 3, floor: 0.015, ...opts };
  }

  /** The level that counts as speech right now. */
  get threshold(): number {
    return Math.max(this.o.floor, Number.isFinite(this.background) ? this.background * this.o.ratio : 0);
  }

  /**
   * One reading: the RMS loudness (0 to 1) at time `now` (ms, any clock that only goes forward).
   * Returns the reason to stop, once there is one; null while it should keep listening.
   */
  feed(level: number, now: number): StopReason | null {
    if (this.stopped) return this.stopped;
    if (this.start === null) this.start = now;
    const lvl = Number.isFinite(level) && level > 0 ? level : 0;

    // The background drifts down to the quietest reading fast, and up slowly (a room gets louder).
    this.background = lvl < this.background ? lvl : this.background + (lvl - this.background) * 0.01;
    const loud = lvl >= this.threshold;

    if (now - this.start >= this.o.maxMs) return (this.stopped = "max");

    if (this.state === "waiting") {
      if (loud) {
        this.loudSince ??= now;
        if (now - this.loudSince >= this.o.minSpeechMs) this.state = "speaking";
      } else {
        this.loudSince = null;
        if (now - this.start >= this.o.noSpeechMs) return (this.stopped = "no_speech");
      }
      return null;
    }

    if (loud) { this.state = "speaking"; this.quietSince = null; return null; }
    this.state = "trailing";
    this.quietSince ??= now;
    if (now - this.quietSince >= this.o.silenceMs) return (this.stopped = "silence");
    return null;
  }
}

/** RMS loudness (0 to 1) of one frame of samples from an AnalyserNode (getFloatTimeDomainData). */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
