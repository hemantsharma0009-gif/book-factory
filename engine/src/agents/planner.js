/**
 * Planning agent: turns a genre + angle into a concrete book plan.
 *
 * Everything downstream keys off this object, so it is schema-validated
 * rather than parsed out of prose.
 */
import { z } from "zod";
import { structured } from "../model.js";
import { DEFAULTS } from "../config.js";

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
For fiction, chapters advance plot or character; nothing is a placeholder.`;

export async function planBook({ genre, angle, chapters = DEFAULTS.chapters, wordsPerChapter }) {
  const prompt = `Plan a ${genre.kind} book in the "${genre.name}" genre, approaching it through: ${angle}.

Requirements:
- ${chapters} chapters, roughly ${wordsPerChapter} words each.
- A distinctive title that is not a cliché of the genre.
- A specific audience, not "anyone interested in ${genre.name}".
- styleRules: 4-6 concrete instructions a drafting writer must follow (voice, person, tense, formatting habits, what to avoid).
- recurringTerms: names, places or terms that must stay consistent across chapters.
- For each chapter: a summary, 3-5 beats, and chartIdea - a diagram or chart that
  would genuinely help the reader, or null if a chart would be decoration.
${genre.kind === "fiction" ? "- Charts are rare in fiction; use null for chartIdea unless it truly serves the story." : "- Prefer charts that carry real information."}`;

  return structured({
    schema: PlanSchema,
    prompt,
    system: SYSTEM,
    stub: () => ({
      title: `The ${genre.name} Handbook`,
      subtitle: `A practical guide to ${angle}`,
      premise: `A working treatment of ${angle} for readers who want something they can apply.`,
      audience: `Readers new to ${genre.name} who want a concrete starting point.`,
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
    }),
  });
}

/**
 * The series bible: the shared, cached prefix sent with every chapter request.
 * Must be byte-identical across a batch or the cache will not hit.
 */
export function buildBible(plan, genre) {
  return `You are drafting chapters of a single book. Hold to this bible exactly.

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
