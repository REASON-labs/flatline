// Phones record AAC in two shapes: inside an MP4 file (.m4a), or as a bare stream of frames
// (ADTS, ".aac"), which some messengers send as voice notes. whisper.cpp's server reads both
// (ffmpeg); an OpenAI-style service goes by what the file is and what it is called, and takes
// only the first. So: tell what a recording really is from its first bytes, and put a bare AAC
// stream into an MP4 file, as it is, without decoding anything.
/** What the bytes are, as a file extension an OpenAI-style service knows; "aac" for a bare (ADTS) stream; null when unknown. */
export function sniffAudio(b) {
    if (!b || b.byteLength < 12)
        return null;
    const at = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
    if (at(4, "ftyp"))
        return "m4a";
    if (at(0, "OggS"))
        return "ogg";
    if (at(0, "RIFF") && at(8, "WAVE"))
        return "wav";
    if (at(0, "fLaC"))
        return "flac";
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
        return "webm";
    if (at(0, "ID3"))
        return "mp3";
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0)
        return "aac"; // ADTS: 12 sync bits, layer 0
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)
        return "mp3"; // an MPEG audio frame
    return null;
}
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const chars = (s) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n) => new Array(n).fill(0);
function box(type, ...parts) {
    const size = 8 + parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(size);
    out.set(u32(size), 0);
    out.set(chars(type), 4);
    let at = 8;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
const MATRIX = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];
/**
 * A bare AAC stream (ADTS) as an MP4 file (.m4a): the same frames, in a container. Null when
 * the bytes aren't a clean ADTS stream (then send them as they are).
 */
export function adtsToM4a(b) {
    const frames = [];
    let profile = -1, rateIndex = -1, channels = -1;
    let at = 0;
    // A tag some encoders put first.
    if (b.byteLength > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)
        at = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
    while (at + 7 <= b.byteLength) {
        if (b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0)
            return null;
        const header = b[at + 1] & 1 ? 7 : 9;
        const p = b[at + 2] >> 6, r = (b[at + 2] >> 2) & 15, c = ((b[at + 2] & 1) << 2) | (b[at + 3] >> 6);
        const length = ((b[at + 3] & 3) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
        const blocks = b[at + 6] & 3;
        if (length <= header || blocks !== 0 || r >= RATES.length || c === 0)
            return null;
        if (frames.length === 0) {
            profile = p;
            rateIndex = r;
            channels = c;
        }
        else if (p !== profile || r !== rateIndex || c !== channels)
            return null;
        if (at + length > b.byteLength)
            break; // a cut-off last frame: leave it out
        frames.push(b.subarray(at + header, at + length));
        at += length;
    }
    if (!frames.length)
        return null;
    const rate = RATES[rateIndex];
    const duration = frames.length * 1024;
    const dataSize = frames.reduce((a, f) => a + f.byteLength, 0);
    // AudioSpecificConfig: the object type (profile + 1), the rate, the channels.
    const asc = [((profile + 1) << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3)];
    const esds = box("esds", u32(0), [0x03, 25, 0, 0, 0], // ES descriptor
    [0x04, 17, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0)], // decoder config: AAC, audio
    [0x05, 2, ...asc], // the AudioSpecificConfig
    [0x06, 1, 0x02]);
    const mp4a = box("mp4a", zeros(6), u16(1), zeros(8), u16(channels), u16(16), zeros(4), u16(rate), u16(0), esds);
    const stbl = (dataAt) => box("stbl", box("stsd", u32(0), u32(1), mp4a), box("stts", u32(0), u32(1), u32(frames.length), u32(1024)), box("stsc", u32(0), u32(1), u32(1), u32(frames.length), u32(1)), box("stsz", u32(0), u32(0), u32(frames.length), frames.flatMap((f) => u32(f.byteLength))), box("stco", u32(0), u32(1), u32(dataAt)));
    const moov = (dataAt) => box("moov", box("mvhd", u32(0), u32(0), u32(0), u32(rate), u32(duration), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)), box("trak", box("tkhd", u32(7), u32(0), u32(0), u32(1), u32(0), u32(duration), zeros(8), u16(0), u16(0), u16(0x100), u16(0), MATRIX, u32(0), u32(0)), box("mdia", box("mdhd", u32(0), u32(0), u32(0), u32(rate), u32(duration), u16(0x55c4), u16(0)), box("hdlr", u32(0), u32(0), chars("soun"), zeros(12), chars("SoundHandler\0")), box("minf", box("smhd", u32(0), u16(0), u16(0)), box("dinf", box("dref", u32(0), u32(1), box("url ", u32(1)))), stbl(dataAt)))));
    const ftyp = box("ftyp", chars("M4A "), u32(0), chars("M4A "), chars("mp42"), chars("isom"));
    const head = ftyp.byteLength + moov(0).byteLength;
    const top = moov(head + 8);
    const out = new Uint8Array(head + 8 + dataSize);
    out.set(ftyp, 0);
    out.set(top, ftyp.byteLength);
    out.set(u32(8 + dataSize), head);
    out.set(chars("mdat"), head + 4);
    let w = head + 8;
    for (const f of frames) {
        out.set(f, w);
        w += f.byteLength;
    }
    return out;
}
//# sourceMappingURL=aac.js.map