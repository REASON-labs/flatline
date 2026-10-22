// "flatten": shape text for a flat, final, commanding delivery, before Piper sees it. Piper
// takes its intonation from punctuation: a comma or "!" makes the pitch rise or lift, a full
// stop makes it fall. So "!" becomes ".", and a comma that ends a clause becomes a full stop.
//
// It changes a comma only when the next word clearly starts a new clause ("you", "that's",
// "then"...). Anything else (lists like "milk, eggs and bread", numbers like "1,200" or
// "nine, thirty", a comma before "and") is left alone: better a little lilt than choppy speech.
// Questions keep their commas and their "?". Pure, so it is tested on its own.

/** Words that start a new clause after a comma ("Listen up, you have..."). */
const CLAUSE_STARTERS = new Set([
  "i", "you", "we", "they", "he", "she", "it",
  "i'm", "you're", "we're", "they're", "he's", "she's", "it's", "i've", "you've", "we've", "they've",
  "i'll", "you'll", "we'll", "they'll", "i'd", "you'd", "we'd", "they'd",
  "that's", "there's", "here's", "what's", "that", "this", "there", "these", "those",
  "then", "now", "so", "but", "because", "otherwise", "still", "also", "next", "first", "after", "later",
  "don't", "do", "let's", "get", "go",
]);

/** Number words: a comma between two of them is part of a number or a time ("nine, thirty"). */
const NUMBER_WORDS = /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|oh|o'clock|\d+)$/i;

const firstWord = (s) => (s.trim().match(/^[A-Za-z0-9']+/)?.[0] ?? "").toLowerCase();
const lastWord = (s) => (s.trim().match(/[A-Za-z0-9']+$/)?.[0] ?? "").toLowerCase();
const capitalise = (s) => s.replace(/^(\s*)([a-z])/, (_, sp, c) => sp + c.toUpperCase());

/** Marks a full stop that was a clause comma (a shorter pause), until segments() splits on it. */
const SOFT = "\uE000";

/** One sentence (without its end mark), with clause commas made into full stops. */
function flattenSentence(body) {
  const parts = body.split(/,\s+/);
  if (parts.length === 1) return body;
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i];
    const w = firstWord(next);
    const isNumber = NUMBER_WORDS.test(lastWord(out)) && NUMBER_WORDS.test(w);
    // Only a clear new clause (never after "and"/"or", never inside a number): a list item
    // doesn't start with a clause word, so lists are left as they are.
    if (!isNumber && CLAUSE_STARTERS.has(w) && lastWord(out) !== "and" && lastWord(out) !== "or") {
      out = `${out}.${SOFT} ${capitalise(next.replace(/^i\b/, "I"))}`;
    } else {
      out = `${out}, ${next}`;
    }
  }
  return out;
}

/** Text in, flatter text out. */
export function flatten(text) {
  return flattenMarked(text).replaceAll(SOFT, "");
}

function flattenMarked(text) {
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return t;
  // "!" (and "!!", "?!" keeps the question) becomes a full stop; a semicolon ends a clause too.
  t = t.replace(/\?!+/g, "?").replace(/!+/g, ".").replace(/;\s+/g, ". ");
  // Sentence by sentence (a "." or "?" ends one only before a space or the end, so "3.30" and
  // "e.g." stay whole): questions are left exactly as they are.
  const sentences = t.match(/.+?(?:[.?]+(?=\s|$)|$)/g) ?? [t];
  const shaped = sentences.map((s) => {
    const end = s.match(/[.?]+$/)?.[0] ?? "";
    const body = end ? s.slice(0, -end.length) : s;
    if (end.includes("?")) return s.trim();
    return capitalise(flattenSentence(body).trim()) + (end || ".");
  });
  return shaped.join(" ").replace(/\s+([.?,])/g, "$1").replace(/\.{2,}/g, ".").trim();
}

// --- segments: where the pauses go --------------------------------------------------------
// Piper puts the same pause after every sentence. A clause that flatten() turned into its own
// sentence then sounds as if it were a new thought: choppy. So the service speaks one piece at
// a time and sets the pause after each by what ended it.

/** Pause kinds: after a clause that was a comma, a statement, a question. */
export const PAUSES = ["clause", "stop", "question"];

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "no", "approx", "prof"]);
/** The most pieces one request is split into (the rest stays in the last). */
export const MAX_SEGMENTS = 24;

/**
 * Text in, pieces out: [{ text, pause }], where `pause` is the kind of pause after the piece
 * ("clause", "stop" or "question"; the last piece's is never used). `flat` applies flatten().
 * A full stop after an abbreviation ("Dr.", "e.g.") or a number, or a stop with no capital after
 * it, doesn't split.
 */
export function segments(text, flat = false) {
  const t = flat ? flattenMarked(text) : String(text ?? "").replace(/\s+/g, " ").trim();
  const out = [];
  const pieces = t.split(SOFT);
  pieces.forEach((piece, pi) => {
    const sentences = [];
    let start = 0;
    const re = /[.?!]+(?=\s+["'(]?[A-Z0-9])/g;
    for (let m; (m = re.exec(piece));) {
      const before = piece.slice(start, m.index).match(/[A-Za-z.]+$/)?.[0]?.toLowerCase().replace(/^\./, "") ?? "";
      if (m[0] === "." && ABBREVIATIONS.has(before)) continue;
      sentences.push(piece.slice(start, m.index + m[0].length).trim());
      start = m.index + m[0].length;
    }
    const rest = piece.slice(start).trim();
    if (rest) sentences.push(rest);
    sentences.forEach((s, i) => {
      const last = i === sentences.length - 1;
      const pause = last && pi < pieces.length - 1 ? "clause" : /\?[^A-Za-z0-9]*$/.test(s) ? "question" : "stop";
      if (s) out.push({ text: s, pause });
    });
  });
  if (out.length > MAX_SEGMENTS) {
    const head = out.slice(0, MAX_SEGMENTS - 1), tail = out.slice(MAX_SEGMENTS - 1);
    head.push({ text: tail.map((x) => x.text).join(" "), pause: tail.at(-1).pause });
    return head;
  }
  return out;
}
