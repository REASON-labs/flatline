// flatline/cast: the voices as characters. Each character is a sound (a preset on the voice
// service), a tone guide (how they talk, for an assistant model) and a line set (the fixed
// messages an app sends: briefings, reminders, the wake-up escalation, replies to messages).
// Plain data and two small functions, so an app's server and its pages can both read it.
// docs/CAST.md has the cast, the rules, and how to add a character.
import { flatline, kestrel, iris, ashford, hoshi, calder, nettle, plainLines } from "./characters.js";
import type { Character, LineSet } from "./types.js";

export type { Character, LineSet, VoiceSource } from "./types.js";
export { plainLines };

/** Every character, in the order a picker shows them. The first is the default. */
export const CAST: readonly Character[] = [flatline, kestrel, iris, ashford, hoshi, calder, nettle];

/** The default character. */
export const DEFAULT_CHARACTER = "flatline";

/** Old ids that still work: Flatline was called Dixie before 0.3.0. */
export const ALIASES: Readonly<Record<string, string>> = { dixie: "flatline" };

/** A character by id (or an old alias); undefined for anything else. */
export function character(id: string | null | undefined): Character | undefined {
  if (!id) return undefined;
  const want = ALIASES[id] ?? id;
  return CAST.find((c) => c.id === want);
}

/**
 * The rules every character follows, whatever their tone. Added to every tone guide, so an
 * assistant model is held to them too.
 */
export const RULES = `Rules that always hold, in character or not: write short sentences that end in full stops (a comma or an exclamation mark makes the spoken voice rise). No exclamation marks and no emoji. Never shame, never guilt, never mention what they didn't do, and never count misses or streaks. When they're worn down, sick or having a rough stretch, the order is rest.`;

/** What an assistant model is told about how to talk, as this character (or plainly, with none). */
export function toneGuide(c: Character | undefined): string {
  if (!c) return `How you talk: plainly and kindly, in short, clear sentences. ${RULES}`;
  return `How you talk: ${c.tone} ${RULES}`;
}

/** The line set for a character, or the plain one. */
export const linesFor = (c: Character | undefined): LineSet => c?.lines ?? plainLines;

/** Values for a line's placeholders. Numbers are fine; say them as they should be heard. */
export type LineVars = Partial<Record<"name" | "n" | "time" | "title" | "who" | "changes" | "them" | "error" | "memo", string | number>>;

/** A line with its placeholders filled. A placeholder with no value is dropped. */
export function fill(template: string, vars: LineVars = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = (vars as Record<string, string | number | undefined>)[k];
    return v === undefined ? "" : String(v);
  }).replace(/\s+/g, " ").trim();
}

/** "1 change" / "3 changes", and "it" / "them", for the inbox lines. */
export const changesVars = (n: number): LineVars => ({ changes: `${n} ${n === 1 ? "change" : "changes"}`, them: n === 1 ? "it" : "them", n });

/** The same few lines for every character, for comparing them by ear (the samples). */
export const COMPARE_LINES: readonly string[] = [
  "Good morning. You have three things on the list today.",
  "The dentist is at nine thirty. Leave by nine.",
  "You slept five hours. Take it easy today.",
];
