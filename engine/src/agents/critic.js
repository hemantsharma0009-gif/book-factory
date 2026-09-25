/**
 * The editorial scorecard.
 *
 * THE PROBLEM IT EXISTS FOR. The pipeline can produce a book in twenty
 * minutes. Reading one carefully takes about two hours. A factory whose
 * output needs two hours of human attention per unit is not a factory; it is
 * a slow way to write books. Approval was the bottleneck, and nothing in the
 * engine ever asked whether what it had written was any good.
 *
 * So after the editorial pass, one call reads the finished manuscript and
 * answers the question a publisher would: is this worth putting your name on,
 * and if not, exactly where does it fail?
 *
 * WHAT MAKES IT USEFUL RATHER THAN DECORATIVE:
 *
 *   It quotes. "Chapter 7 is weak" sends you to re-read a chapter. A verbatim
 *   sentence sends you to the paragraph. Every finding must carry real text.
 *
 *   The quotes are VERIFIED against the manuscript. A model asked for quotes
 *   will sometimes produce a plausible sentence that is not in the book, and a
 *   confident citation of text that does not exist is worse than no citation -
 *   you would go looking for it. Anything that does not match is marked as
 *   unverified rather than quietly dropped, because the fact that it was
 *   invented is itself worth knowing.
 *
 *   It can say no. A scorecard that always concludes "looks good" is worth
 *   nothing, so the prompt makes rejection a real verdict with a real
 *   threshold, and names the failure modes this kind of book actually has.
 *
 * IT IS ADVISORY AND NEVER A GATE. It cannot reject a book, block publishing
 * or change a word. A human reads and approves; this only says where to look.
 */
import { z } from "zod";
import { structured } from "../model.js";

export const VERDICTS = ["publish", "fix-first", "do-not-publish"];

const CRITERIA = [
  ["opening", "Does the first page earn the reader's attention?"],
  ["promise", "Does the book deliver what its title, subtitle and description promise?"],
  ["specificity", "Concrete examples, numbers, names and scenes - or vague assertion?"],
  ["repetition", "Do chapters make the same points in the same words?"],
  ["voice", "A distinctive, consistent voice - or the flat, hedging register of generated text?"],
  ["ending", "Does the last chapter land the book, or trail off?"],
];

const FindingSchema = z.object({
  chapter: z.number().int().positive(),
  quote: z.string(),
  problem: z.string(),
  fix: z.string(),
});

export const ScorecardSchema = z.object({
  verdict: z.enum(["publish", "fix-first", "do-not-publish"]),
  oneLine: z.string(),
  scores: z.array(z.object({
    criterion: z.string(),
    score: z.number().int().min(1).max(5),
    note: z.string(),
  })),
  weakest: z.array(FindingSchema),
  strongest: z.object({ chapter: z.number().int().positive(), quote: z.string(), why: z.string() }),
});

const SYSTEM = `You are a commissioning editor deciding whether a finished manuscript
is worth publishing under your imprint. You have read thousands of submissions and
rejected most of them.

You are not the author's friend and you are not here to encourage. Your reputation
rides on what you let through. A book you wave past that readers abandon in chapter
two costs you more than a rejection ever will.

THE FAILURE MODES YOU ARE LOOKING FOR, in the order they kill a book:

1. NOTHING AT STAKE. The prose is competent and the reader has no reason to turn
   the page. This is the most common way a generated manuscript fails and the
   easiest to miss, because nothing in it is actually wrong.
2. ASSERTION WITHOUT EVIDENCE. Claims that sound authoritative and rest on
   nothing - no number, no name, no scene, no source. Count how often a paragraph
   would survive its own "for example".
3. THE SAME POINT, TWICE. Chapters that restate each other in different words.
4. THE HEDGING REGISTER. "It is worth noting", "in many ways", "a nuanced
   interplay", sentences that qualify themselves into saying nothing. This is
   what generated text sounds like when nobody edits it, and readers recognise
   it now.
5. A PROMISE NOT KEPT. The description sells one book and the manuscript is
   another.
6. AN ENDING THAT STOPS RATHER THAN LANDS.

SCORING. 1-5 per criterion, and use the whole range. A 4 means genuinely good.
A 3 is ordinary - most manuscripts are a 3. If you find yourself giving 4s to
everything, you are not reading hard enough.

VERDICT:
  publish         you would put your name on this as it stands
  fix-first       publishable once the listed passages are fixed
  do-not-publish  the problems are structural; editing passages will not save it

Be willing to say do-not-publish. An editor who never rejects is not an editor.

EVIDENCE. Every finding quotes the manuscript VERBATIM - copy the sentence
exactly as it appears, 10 to 40 words, no ellipsis, no paraphrase, no correction
of the author's punctuation. The quote is checked against the text automatically,
and an invented quote is worse than no finding at all: it sends somebody hunting
through a book for a sentence that was never in it. If you cannot find a real
sentence that demonstrates the problem, leave the finding out.

Find the five weakest passages, worst first, spread across the book rather than
all from one chapter. Also name the single best passage - an editor who can only
find fault is no more useful than one who can only praise.`;

/** Whitespace-insensitive containment: models re-wrap lines, they do not re-word them. */
function normalise(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
}

/**
 * Did the model actually quote the book?
 *
 * Marked rather than removed: a fabricated quote is a fact about how much to
 * trust the rest of the scorecard, and hiding it would throw that away.
 */
export function verifyQuotes(scorecard, manuscript) {
  const haystack = normalise(manuscript);
  const check = (quote) => {
    const needle = normalise(quote);
    return needle.length > 12 && haystack.includes(needle);
  };

  return {
    ...scorecard,
    weakest: scorecard.weakest.map((finding) => ({ ...finding, verified: check(finding.quote) })),
    strongest: { ...scorecard.strongest, verified: check(scorecard.strongest.quote) },
  };
}

/** 0-100, for the one number that goes on a card. Equal weights: no criterion here is optional. */
export function overallScore(scorecard) {
  const scores = scorecard.scores || [];
  if (!scores.length) return null;
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  return Math.round((total / (scores.length * 5)) * 100);
}

function stubFor(plan) {
  return {
    verdict: "fix-first",
    oneLine: "Competent and unremarkable; the argument thins after chapter three.",
    scores: CRITERIA.map(([criterion], i) => ({
      criterion,
      score: (i % 3) + 2,
      note: `Stub note for ${criterion}.`,
    })),
    weakest: plan.chapters.slice(0, 5).map((chapter) => ({
      chapter: chapter.number,
      quote: "It is worth pausing on the mechanism, because the mechanism is the argument.",
      problem: "Asserts importance without showing it.",
      fix: "Replace with the specific case this chapter is actually about.",
    })),
    strongest: {
      chapter: 1,
      quote: "The work begins where most accounts leave off, in the unglamorous middle of the thing.",
      why: "Concrete, and it sets the book's angle in one line.",
    },
  };
}

/**
 * @param {object[]} chapters  the EDITED manuscript, which is what a reader gets
 * @returns {Promise<object>}  scorecard with every quote verified
 */
export async function scoreManuscript({ plan, genre, listing, chapters, language }) {
  const manuscript = chapters
    .map((c) => `<<<CHAPTER ${c.number}>>>\n# ${c.title}\n\n${c.body}`)
    .join("\n\n");

  const scorecard = await structured({
    schema: ScorecardSchema,
    stub: () => stubFor(plan),
    system: SYSTEM,
    maxTokens: 8000,
    // One call, read once. Marking it cacheable would cost 1.25x the input
    // rate for a prefix that is never read a second time.
    prompt: `Title: ${plan.title}
Subtitle: ${plan.subtitle}
Genre: ${genre.name} (${genre.kind})
Intended reader: ${plan.audience}
${language && language.code !== "en" ? `Language: ${language.name}. Judge it as a ${language.name} book; write your notes in English.\n` : ""}
What the description promises the buyer:
${listing?.description || "(none written)"}

Score the manuscript below against these criteria, using the exact criterion
names given:

${CRITERIA.map(([name, question]) => `  ${name} — ${question}`).join("\n")}

--- MANUSCRIPT ---

${manuscript}

--- END MANUSCRIPT ---`,
  });

  return verifyQuotes(scorecard, manuscript);
}

export const __test = { SYSTEM, CRITERIA, normalise, stubFor };

/**
 * The scorecard as text, shared by the CLI and the note delivered to Drive so
 * the two cannot disagree about what the book was judged to be.
 */
export function formatScorecard(scorecard, { width = 78 } = {}) {
  if (!scorecard) return "";

  const banner = {
    publish: "PUBLISH — it would go out as it stands",
    "fix-first": "FIX FIRST — publishable once the passages below are fixed",
    "do-not-publish": "DO NOT PUBLISH — the problems are structural",
  }[scorecard.verdict] || scorecard.verdict;

  const lines = [];
  lines.push("");
  lines.push("".padEnd(width, "─"));
  lines.push(banner + (scorecard.score != null ? `   ${scorecard.score}/100` : ""));
  lines.push(scorecard.oneLine);
  lines.push("".padEnd(width, "─"));

  (scorecard.scores || []).forEach((row) => {
    const bar = "█".repeat(row.score) + "·".repeat(5 - row.score);
    lines.push(`  ${row.criterion.padEnd(13)} ${bar}  ${row.note}`);
  });

  const weakest = scorecard.weakest || [];
  if (weakest.length) {
    lines.push("");
    lines.push(`  The ${weakest.length} passages to look at, worst first:`);
    weakest.forEach((finding, i) => {
      lines.push("");
      lines.push(`  ${i + 1}. Chapter ${finding.chapter} — ${finding.problem}`);
      lines.push(`     "${finding.quote}"`);
      if (!finding.verified) {
        // Worth saying loudly: it means the model invented a citation, which
        // is a fact about how much to trust the rest of this page.
        lines.push(`     ! that sentence is not in the manuscript — the finding may be invented`);
      }
      lines.push(`     → ${finding.fix}`);
    });
  }

  if (scorecard.strongest?.quote) {
    lines.push("");
    lines.push(`  Best passage — chapter ${scorecard.strongest.chapter}: ${scorecard.strongest.why}`);
    lines.push(`     "${scorecard.strongest.quote}"`);
  }

  lines.push("");
  lines.push("  This is an opinion, not a gate. Nothing publishes until you approve it.");
  return lines.join("\n");
}
