/**
 * Planning agent: turns a genre + angle into a concrete book plan.
 *
 * Everything downstream keys off this object, so it is schema-validated
 * rather than parsed out of prose.
 */
import { z } from "zod";
import { structured } from "../model.js";
import { DEFAULTS, LANGUAGES } from "../config.js";
import { genericTitleReason } from "./title-check.js";

const ChapterSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  beats: z.array(z.string()),
  chartIdea: z.string().nullable(),
});

export const PlanSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  premise: z.string(),
  audience: z.string(),
  toneGuide: z.string(),
  styleRules: z.array(z.string()),
  recurringTerms: z.array(z.string()),
  chapters: z.array(ChapterSchema),
});

const SYSTEM = `You are a commissioning editor who plans books that real readers finish.

You produce plans that are specific, not generic: a concrete premise, a named
audience, and chapters that each do distinct work. You avoid the hallmarks of
low-effort output - filler chapters, chapters that restate each other, vague
promises like "unlock your potential", and titles that could belong to any book.

For non-fiction, every chapter earns its place with a distinct, useful idea.
For fiction, chapters advance plot or character; nothing is a placeholder.

TITLING IS THE PART YOU TAKE MOST SERIOUSLY.

A title is the only thing most browsers will ever read. It does one job: make a
stranger curious enough to read the subtitle. The subtitle explains; the title
hooks. Never make the title do the explaining.

A good title comes from INSIDE the material - a concrete image, a specific
number, a person or place, a phrase with tension in it, a claim that sounds
slightly wrong until explained. "Bowling Alone". "The Devil in the White City".
"Why Nations Fail". "Salt Fat Acid Heat". None of these name their genre; each
is unmistakably about one particular book.

Never produce:
- a title containing the genre name ("The Mystery Handbook", "Adventure Guide")
- stock formulas: "The Complete Guide to X", "Mastering X", "X 101",
  "Everything You Need to Know About X", "Unlocking X", "The Secrets of X"
- a title made of abstractions with no image in it
- a colon where the part after it just restates the part before it

Test: could this title sit on a hundred other books? If yes, write another one.`;

export async function planBook({ genre, angle, chapters = DEFAULTS.chapters, wordsPerChapter, language = LANGUAGES.en }) {
  // The whole plan - title, subtitle, chapter titles, style rules - has to be
  // in the book's language, or the drafting step spends every chapter
  // translating its own instructions.
  const inLanguage = language.code === "en"
    ? ""
    : `\nWrite EVERYTHING in ${language.name} (${language.endonym}), in the ${language.script} script:
the title, the subtitle, the premise, the audience, every chapter title and
summary, the style rules and the recurring terms. Do not write them in English
and do not transliterate ${language.name} into Latin letters. Write for a reader
who reads ${language.name} as a first language, not for a translation.\n`;

  const prompt = `Plan a ${genre.kind} book in the "${genre.name}" genre, approaching it through: ${angle}.
${inLanguage}
Requirements:
- ${chapters} chapters, roughly ${wordsPerChapter} words each.
- A title drawn from something concrete in this specific book - an image, a
  number, a name, a phrase with tension. It must NOT contain the word
  "${genre.name}" or any stock formula. The subtitle carries the explanation.
- A specific audience, not "anyone interested in ${genre.name}".
- styleRules: 4-6 concrete instructions a drafting writer must follow (voice, person, tense, formatting habits, what to avoid).
- recurringTerms: names, places or terms that must stay consistent across chapters.
- For each chapter: a summary, 3-5 beats, and chartIdea - a diagram or chart that
  would genuinely help the reader, or null if a chart would be decoration.
${genre.kind === "fiction" ? "- Charts are rare in fiction; use null for chartIdea unless it truly serves the story." : "- Prefer charts that carry real information."}`;

  const plan = await structured({
    schema: PlanSchema,
    prompt,
    system: SYSTEM,
    stub: () => stubPlan({ genre, angle, chapters }),
  });

  // The prompt asks for a distinctive title; this verifies it got one. A model
  // that slipped into "The <Genre> Handbook" is asked once more, with the
  // specific fault quoted back - which works far better than asking again in
  // the same words.
  const reason = genericTitleReason(plan.title, genre);
  if (!reason) return plan;

  const retry = await structured({
    schema: PlanSchema,
    system: SYSTEM,
    prompt: `${prompt}

Your previous attempt titled this book "${plan.title}". That title is unusable:
${reason}.

Write a different title. Take it from something concrete inside this book - an
image, a number, a name, a phrase with tension in it. Keep the rest of the plan
as good as it was. Do not reuse the rejected title or a variation of it.`,
    stub: () => stubPlan({ genre, angle, chapters, variant: 1 }),
  });

  const retryReason = genericTitleReason(retry.title, genre);
  if (retryReason) {
    // Two failures is a signal worth surfacing rather than hiding: the book is
    // still usable, but the title needs a human before it goes on a storefront.
    process.stderr.write(
      `  warning: title "${retry.title}" is still weak (${retryReason}). Rename it before publishing.\n`,
    );
  }
  return retry;
}

/**
 * Dry-run plans. These deliberately produce title shapes like the ones a good
 * model returns, so a dry run exercises the same downstream code paths (and
 * the keyword validator) as a real one.
 */
/** "a" or "an" - "a adventure story" in a listing reads as a typo, because it is. */
function article(word) {
  return /^[aeiou]/i.test(String(word)) ? "an" : "a";
}

export function stubPlan({ genre, angle, chapters, variant = 0 }) {
  const titles = {
    adventure: ["Nine Days Above the Treeline", "The Long Way Down"],
    mystery: ["The Room That Locked Itself", "Twelve Grams of Evidence"],
    literary: ["What the House Kept", "Every Second Tuesday"],
    scifi: ["Ship of Grandchildren", "The Quiet Signal"],
    history: ["The Year Everything Moved", "Six Weeks in October"],
    selfhelp: ["Small Hinges", "The Second Hour"],
    business: ["Charge More", "The Margin Nobody Counts"],
    art: ["Twenty Lines a Day", "The Honest Pencil"],
    cooking: ["One Pan, One Fire", "Salt at the End"],
    science: ["The Pressure Below", "Four Miles Down"],
    wellness: ["The Strength You Keep", "Ten Thousand Steps Later"],
    technology: ["The Machine That Reads Your Mail", "Ask Better Questions"],
  };
  const pick = titles[genre.id] || ["The Working Draft", "Second Pass"];
  const fiction = genre.kind === "fiction";

  return {
      title: pick[variant % pick.length],
      // A how-to subtitle on a novel would sail through every downstream check
      // and produce a KDP sheet that describes the wrong kind of book.
      // A colon, not "a novel of X" - the angles are bare noun phrases ("lost
      // city"), and the genitive form reads as a typo for half of them.
      subtitle: fiction ? `A novel: ${angle}` : `A practical guide to ${angle}`,
      premise: fiction
        ? `A story of ${angle}, told through the people it costs the most.`
        : `A working treatment of ${angle} for readers who want something they can apply.`,
      audience: fiction
        ? `Readers who want ${article(genre.name)} ${genre.name.toLowerCase()} story with real stakes.`
        : `Readers new to ${genre.name} who want a concrete starting point.`,
      toneGuide: "Direct, concrete, warm. Short sentences. No hype.",
      styleRules: [
        "Write in second person for instructions, third for examples.",
        "Open each chapter with a concrete scene or case, never a definition.",
        "No bulleted lists longer than five items.",
        "Never begin a paragraph with 'In today's world'.",
      ],
      recurringTerms: ["the practice", "the baseline", "the review loop"],
      chapters: Array.from({ length: chapters }, (_, i) => ({
        number: i + 1,
        title: `Chapter ${i + 1}: ${angle}, part ${i + 1}`,
        summary: `Develops the ${i + 1}th movement of the argument about ${angle}.`,
        beats: ["Open on a case", "Introduce the mechanism", "Show the failure mode", "Give the drill"],
        chartIdea: genre.kind === "fiction" ? null : i % 3 === 0 ? `Comparison of outcomes in chapter ${i + 1}` : null,
      })),
  };
}

/**
 * The series bible: the shared, cached prefix sent with every chapter request.
 * Must be byte-identical across a batch or the cache will not hit.
 */
export function buildBible(plan, genre, language = LANGUAGES.en) {
  return `You are drafting chapters of a single book. Hold to this bible exactly.

LANGUAGE: ${language.name} (${language.endonym}) - write every word of the
manuscript in ${language.name}, in the ${language.script} script. Chapter
headings, dialogue, examples and any list are all in ${language.name}. Never
switch to English, and never transliterate into Latin letters.

TITLE: ${plan.title}
SUBTITLE: ${plan.subtitle}
GENRE: ${genre.name} (${genre.kind})
PREMISE: ${plan.premise}
AUDIENCE: ${plan.audience}
TONE: ${plan.toneGuide}

STYLE RULES (non-negotiable):
${plan.styleRules.map((r) => `- ${r}`).join("\n")}

RECURRING TERMS (use these exact forms):
${plan.recurringTerms.map((t) => `- ${t}`).join("\n")}

FULL CHAPTER MAP (for continuity - do not write chapters other than the one asked for):
${plan.chapters.map((c) => `${c.number}. ${c.title} - ${c.summary}`).join("\n")}

OUTPUT RULES:
- Output the chapter body only. No chapter number, no title, no preamble, no meta-commentary.
- Use Markdown: paragraphs, "## " for section breaks within the chapter, and *emphasis*.
- Do not write "In this chapter we will" or summarise what you are about to do.
- Do not end with a summary of the chapter unless the chapter map calls for one.`;
}
