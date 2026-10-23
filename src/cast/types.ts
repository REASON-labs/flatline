// The shape of a character: a sound (a preset on the voice service), a tone guide (how they talk,
// for an assistant model to follow) and a line set (the fixed messages an app sends).

/**
 * Templates, filled with fill(). Placeholders an app supplies:
 *   {name}    the app's name                     {n}       a number, as it should be said
 *   {time}    a time ("7:00", "nine thirty")     {title}   an event's title (SPOKEN lines only)
 *   {who}     a person's name (the partner note) {changes} "1 change" / "3 changes"
 *   {them}    "it" / "them"                      {error}   a plain sentence about what failed
 *   {memo}    "voice memo" / "message"
 * Lines marked "text" may be shown on a lock screen: they never name anything private (counts
 * only), so they never use {title}. Spoken lines are heard only when a memo is played.
 */
export interface LineSet {
  /** The morning briefing. */
  briefing: {
    /** Spoken, first. */
    open: string;
    /** Spoken: a short night ({n} hours, under six). On a rough day the order is rest. */
    sleepShort: string;
    /** Spoken: a full night ({n} hours). */
    sleepGood: string;
    /** Spoken, when they haven't checked in yet. */
    checkIn: string;
    /** Spoken, last, when today's list is empty. */
    planEmpty: string;
    /** Spoken, last, when the list is empty but some things are overdue. */
    planOverdue: string;
    /** Spoken, last, when the list is long (more than five). */
    tooMuch: string;
    /** Spoken, last, on an ordinary day. */
    close: string;
    /** Text: after the counts ("2 to-dos today."). */
    text: string;
    /** Text: when there's nothing on the list. */
    textEmpty: string;
  };
  /** Event reminders. */
  event: {
    /** Spoken: {title} starts in {n} minutes. */
    soon: string;
    /** Spoken: {title} is starting. */
    now: string;
    /** Text: after "something starts in {n} minutes." */
    text: string;
  };
  /** Tomorrow, the night before. */
  tomorrow: {
    /** Spoken, first. */
    open: string;
    /** Spoken, last. */
    close: string;
    /** Spoken: be up by {time}. */
    upBy: string;
    /** Spoken, after upBy, when it's an important wake-up. */
    important: string;
    /** Text: after the counts. */
    text: string;
    /** Text: nothing tomorrow. */
    textClear: string;
  };
  /** "Your calendar changed." */
  changes: {
    /** Spoken, first. */
    open: string;
  };
  /** The wake-up escalation: it gets firmer as it goes, never cruel. */
  wake: {
    /** Spoken, one per step: at the time, then 5, 10, 20, 30, 40, 50 and 60 minutes past. {time}, {n}. */
    steps: readonly string[];
    /** Text, at the time. {time}. */
    text: string;
    /** Text, later steps. {n} minutes past {time}. */
    textLate: string;
    /** What a call says when they pick up; then it listens for 1. {n}, {time}. */
    call: string;
    /** After they press 1. */
    awake: string;
    /** Rise and shine, the ordinary morning (not marked important): spoken, one per nudge: at the time, 5 and 15 minutes past. {time}, {n}. */
    rise: readonly string[];
    /** Text, the ordinary morning, at the time. {time}. */
    riseText: string;
    /** Text, the ordinary morning, later nudges. {n} minutes past {time}. */
    riseTextLate: string;
    /** After "10 more minutes": {n} minutes, then it comes back. */
    snoozed: string;
    /** To their partner, after an hour, only if they allowed it. {who}, {time}. Plain, kind, and no more. */
    partner: string;
  };
  /** Replies to a message in (all text). YES, NO and STOP are the words an app listens for. */
  inbox: {
    help: string;
    /** {changes} ready; YES / NO; {them}. */
    ready: string;
    /** Put in front of ready when it was a voice memo. */
    heard: string;
    applied: string;
    nothingWaiting: string;
    dropped: string;
    nothingToDrop: string;
    /** After LATER: the last reminder comes again at {time}. */
    later: string;
    /** LATER, with no recent reminder to push back. */
    nothingToPush: string;
    nothingFound: string;
    switchedOff: string;
    tooMany: string;
    cantListen: string;
    memoMissing: string;
    memoTooLong: string;
    memoUnclear: string;
    memoEmpty: string;
    limit: string;
    /** {error} first, then: the {memo} isn't lost. */
    failed: string;
  };
}

/** Where a character's sound comes from, and what its licence asks. */
export interface VoiceSource {
  /** A Piper voice (rhasspy/piper-voices). */
  model: string;
  /** For multi-speaker models. */
  speaker?: number;
  /** The licence of the data the voice was trained on (the model files are MIT). */
  licence: string;
  /** A credit line to show somewhere in an app (an About or Credits line), when the licence asks for one. */
  credit?: string;
}

export interface Character {
  /** Stable id: what an app stores. Lowercase. */
  id: string;
  /** What a person sees in a picker. */
  name: string;
  /** One line for a picker: what they're like. */
  about: string;
  /** Who they're loosely inspired by. Original characters: no imitation of any actor, no catchphrases. */
  inspiredBy: string;
  /** How they talk, for an assistant model. The shared rules (RULES) are added by toneGuide(). */
  tone: string;
  /** The voice service preset that gives them their sound. */
  preset: string;
  /** Does the preset shape the text for a flat, falling delivery (see docs/VOICE.md, flatten)? */
  flatten: boolean;
  voice: VoiceSource;
  /** One line in character, for "hear a sample". */
  sample: string;
  lines: LineSet;
}
