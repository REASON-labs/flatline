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
      out = `${out}. ${capitalise(next.replace(/^i\b/, "I"))}`;
    } else {
      out = `${out}, ${next}`;
    }
  }
  return out;
}

/** Text in, flatter text out. */
export function flatten(text) {
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
