// When to stop listening: a small state machine fed one loudness reading at a time. Pure (no
// browser), so it is tested on its own. The recorder feeds it from a Web Audio analyser.
//
// It learns the room's background level from the quietest readings, so a fan or a car doesn't
// count as talking, and only calls it speech once it has heard enough of it in a row.
export class SilenceDetector {
    o;
    start = null;
    loudSince = null;
    quietSince = null;
    background = Infinity;
    state = "waiting";
    /** Set once listening should end. */
    stopped = null;
    constructor(opts = {}) {
        this.o = { silenceMs: 1500, noSpeechMs: 8000, maxMs: 120_000, minSpeechMs: 200, ratio: 3, floor: 0.015, ...opts };
    }
    /** The level that counts as speech right now. */
    get threshold() {
        return Math.max(this.o.floor, Number.isFinite(this.background) ? this.background * this.o.ratio : 0);
    }
    /**
     * One reading: the RMS loudness (0 to 1) at time `now` (ms, any clock that only goes forward).
     * Returns the reason to stop, once there is one; null while it should keep listening.
     */
    feed(level, now) {
        if (this.stopped)
            return this.stopped;
        if (this.start === null)
            this.start = now;
        const lvl = Number.isFinite(level) && level > 0 ? level : 0;
        // The background drifts down to the quietest reading fast, and up slowly (a room gets louder).
        this.background = lvl < this.background ? lvl : this.background + (lvl - this.background) * 0.01;
        const loud = lvl >= this.threshold;
        if (now - this.start >= this.o.maxMs)
            return (this.stopped = "max");
        if (this.state === "waiting") {
            if (loud) {
                this.loudSince ??= now;
                if (now - this.loudSince >= this.o.minSpeechMs)
                    this.state = "speaking";
            }
            else {
                this.loudSince = null;
                if (now - this.start >= this.o.noSpeechMs)
                    return (this.stopped = "no_speech");
            }
            return null;
        }
        if (loud) {
            this.state = "speaking";
            this.quietSince = null;
            return null;
        }
        this.state = "trailing";
        this.quietSince ??= now;
        if (now - this.quietSince >= this.o.silenceMs)
            return (this.stopped = "silence");
        return null;
    }
}
/** RMS loudness (0 to 1) of one frame of samples from an AnalyserNode (getFloatTimeDomainData). */
export function rms(samples) {
    if (!samples.length)
        return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++)
        sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}
//# sourceMappingURL=silence.js.map