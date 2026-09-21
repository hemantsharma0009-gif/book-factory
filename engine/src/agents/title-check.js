/**
 * Deterministic guard against generic titles.
 *
 * A model asked for "a distinctive title" will sometimes still return
 * "The <Genre> Handbook". That is the single most damaging failure mode on a
 * storefront: a title that names its own category tells a browsing reader
 * nothing, and wastes the keyword slots that would otherwise carry search
 * terms (KDP already indexes the title, so repeating genre words there is
 * paid for twice and works once).
 *
 * This catches the pattern in code so the planner can be asked again, rather
 * than relying on the prompt alone.
 */

/** Title shapes that carry no information about this particular book. */
const EMPTY_FORMULAS = [
  /^(the\s+)?complete\s+guide\b/i,
  /^(the\s+)?ultimate\s+guide\b/i,
  /^(the\s+)?essential\s+guide\b/i,
  /^(the\s+)?beginner'?s?\s+guide\b/i,
  /^mastering\b/i,
  /^understanding\b/i,
  /^introduction\s+to\b/i,
  /^everything\s+you\s+need\s+to\s+know\b/i,
  /\b101$/i,
  /^(the\s+)?\w+\s+(handbook|bible|playbook|blueprint|masterclass|companion)$/i,
];

/** Words too weak to make a title specific on their own. */
const FILLER = new Set([
  "the", "a", "an", "of", "to", "for", "and", "in", "on", "your", "guide",
  "book", "handbook", "complete", "ultimate", "essential", "practical",
  "introduction", "beginners", "beginner", "simple", "easy", "modern",
]);

/**
 * @returns {string|null} the reason it is generic, or null if the title passes.
 */
export function genericTitleReason(title, genre) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return "the title is empty";

  const lower = trimmed.toLowerCase();

  // The worst case: the book is named after its own shelf.
  const genreWords = genre.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const namesItsGenre = genreWords.some((w) => lower.includes(w));
  if (namesItsGenre) {
    return `it contains the genre name ("${genre.name}"), which tells a browsing reader nothing`;
  }

  for (const formula of EMPTY_FORMULAS) {
    if (formula.test(trimmed)) return `it uses the stock formula "${trimmed}"`;
  }

  // A title made only of filler has no hook to remember it by.
  const substantive = lower.split(/\W+/).filter((w) => w && !FILLER.has(w));
  if (substantive.length === 0) return "it is made entirely of filler words";

  return null;
}

export const isGenericTitle = (title, genre) => genericTitleReason(title, genre) !== null;
