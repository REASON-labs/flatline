// The sound of a preset: settings in, an ffmpeg audio filter out. Pure, so it is tested on its
// own. Every number is checked and clamped here, so neither a preset file nor a "tune" in a
// request can put anything but numbers into the ffmpeg command.

/** A number within [min, max], or the fallback when it isn't a finite number. */
function num(v, min, max, fallback) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}
const r = (n, d = 3) => Number(n.toFixed(d));

/**
 * The effects a preset can use, and their ranges. 0 (or off) switches an effect off.
 *   pitch     0.7..1.3   lower is deeper (1 = unchanged); the pace is kept
 *   highpass  0..400 Hz  cut the rumble below (a phone speaker can't play it anyway)
 *   lowpass   0..12000 Hz cut the air above: lower sounds more like a line or a radio
 *   presence  { freq 300..6000, gain -12..12 dB }  a bump where words are clearest
 *   compress  { threshold -60..0 dB, ratio 1..20 } even it out, so quiet words carry
 *   drive     0..24 dB   push into a soft clipper: grit
 *   echo      { delay 0..200 ms, decay 0..0.9 }    a short slap: "in the machine"
 *   loudness  -30..-8 LUFS  the final level (phones: about -16)
 */
export const EFFECT_KEYS = ["pitch", "highpass", "lowpass", "presence", "compress", "drive", "echo", "loudness"];

/** Merge a "tune" (from a request) over a preset's effects: only known keys, only numbers. */
export function mergeEffects(base = {}, tune = {}) {
  const out = { ...base };
  for (const k of EFFECT_KEYS) {
    if (!(k in tune)) continue;
    const v = tune[k];
    if (v && typeof v === "object") out[k] = { ...(typeof base[k] === "object" ? base[k] : {}), ...v };
    else out[k] = v;
  }
  return out;
}

/** The ffmpeg -af value for these effects, for audio at `rate` Hz. */
export function buildFilter(effects = {}, rate = 22050) {
  const sr = Math.round(num(rate, 8000, 96000, 22050));
  const f = [];

  const pitch = num(effects.pitch, 0.7, 1.3, 1);
  if (Math.abs(pitch - 1) > 0.001) {
    // Play it slower (deeper), then speed it back up without changing the pitch.
    f.push(`asetrate=${Math.round(sr * pitch)}`, `aresample=${sr}`, `atempo=${r(1 / pitch, 4)}`);
  }
  const hp = num(effects.highpass, 0, 400, 0);
  if (hp > 0) f.push(`highpass=f=${Math.round(hp)}`);
  const lp = num(effects.lowpass, 0, 12000, 0);
  if (lp > 0) f.push(`lowpass=f=${Math.round(lp)}`);

  const pr = effects.presence;
  if (pr && typeof pr === "object") {
    const g = num(pr.gain, -12, 12, 0);
    if (g !== 0) f.push(`equalizer=f=${Math.round(num(pr.freq, 300, 6000, 1800))}:t=q:w=1:g=${r(g, 1)}`);
  }
  const c = effects.compress;
  if (c && typeof c === "object") {
    const ratio = num(c.ratio, 1, 20, 1);
    if (ratio > 1) f.push(`acompressor=threshold=${r(num(c.threshold, -60, 0, -20), 1)}dB:ratio=${r(ratio, 1)}:attack=5:release=80:makeup=2`);
  }
  const drive = num(effects.drive, 0, 24, 0);
  if (drive > 0) f.push(`volume=${r(drive, 1)}dB`, "asoftclip=type=tanh");

  const e = effects.echo;
  if (e && typeof e === "object") {
    const delay = num(e.delay, 0, 200, 0), decay = num(e.decay, 0, 0.9, 0);
    if (delay > 0 && decay > 0) f.push(`aecho=0.9:0.9:${Math.round(delay)}:${r(decay, 2)}`);
  }
  // Always last: a steady level, whatever came before (and headroom so nothing clips).
  f.push(`loudnorm=I=${r(num(effects.loudness, -30, -8, -16), 1)}:TP=-1.5:LRA=7`);
  return f.join(",");
}

/** What each output format needs from ffmpeg, and the content type to answer with. */
export const FORMATS = {
  m4a: { type: "audio/mp4", ext: "m4a", args: ["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "ipod"] },
  mp3: { type: "audio/mpeg", ext: "mp3", args: ["-c:a", "libmp3lame", "-q:a", "5", "-f", "mp3"] },
  ogg: { type: "audio/ogg", ext: "ogg", args: ["-c:a", "libopus", "-b:a", "32k", "-f", "ogg"] },
  wav: { type: "audio/wav", ext: "wav", args: ["-c:a", "pcm_s16le", "-f", "wav"] },
};
