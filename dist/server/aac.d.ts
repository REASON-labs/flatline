/** What the bytes are, as a file extension an OpenAI-style service knows; "aac" for a bare (ADTS) stream; null when unknown. */
export declare function sniffAudio(b: Uint8Array): "m4a" | "ogg" | "wav" | "flac" | "webm" | "mp3" | "aac" | null;
/**
 * A bare AAC stream (ADTS) as an MP4 file (.m4a): the same frames, in a container. Null when
 * the bytes aren't a clean ADTS stream (then send them as they are).
 */
export declare function adtsToM4a(b: Uint8Array): Uint8Array | null;
