import { plainLines } from "./characters.js";
import type { Character, LineSet } from "./types.js";
export type { Character, LineSet, VoiceSource } from "./types.js";
export { plainLines };
/** Every character, in the order a picker shows them. The first is the default. */
export declare const CAST: readonly Character[];
/** The default character. */
export declare const DEFAULT_CHARACTER = "flatline";
/** Old ids that still work: Flatline was called Dixie before 0.3.0. */
export declare const ALIASES: Readonly<Record<string, string>>;
/** A character by id (or an old alias); undefined for anything else. */
export declare function character(id: string | null | undefined): Character | undefined;
/**
 * The rules every character follows, whatever their tone. Added to every tone guide, so an
 * assistant model is held to them too.
 */
export declare const RULES = "Rules that always hold, in character or not: write short sentences that end in full stops (a comma or an exclamation mark makes the spoken voice rise). No exclamation marks and no emoji. Never shame, never guilt, never mention what they didn't do, and never count misses or streaks. When they're worn down, sick or having a rough stretch, the order is rest.";
/** What an assistant model is told about how to talk, as this character (or plainly, with none). */
export declare function toneGuide(c: Character | undefined): string;
/** The line set for a character, or the plain one. */
export declare const linesFor: (c: Character | undefined) => LineSet;
/** Values for a line's placeholders. Numbers are fine; say them as they should be heard. */
export type LineVars = Partial<Record<"name" | "n" | "time" | "title" | "who" | "changes" | "them" | "error" | "memo", string | number>>;
/** A line with its placeholders filled. A placeholder with no value is dropped. */
export declare function fill(template: string, vars?: LineVars): string;
/** "1 change" / "3 changes", and "it" / "them", for the inbox lines. */
export declare const changesVars: (n: number) => LineVars;
/** The same few lines for every character, for comparing them by ear (the samples). */
export declare const COMPARE_LINES: readonly string[];
