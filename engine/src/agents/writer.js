/**
 * Drafting agent. One batch, one request per chapter, shared cached bible.
 */
import { batchProse } from "../model.js";
import { buildBible } from "./planner.js";

export async function draftChapters({ plan, genre, wordsPerChapter, onProgress }) {
  const bible = buildBible(plan, genre);

  const jobs = plan.chapters.map((chapter) => ({
    id: `ch-${String(chapter.number).padStart(3, "0")}`,
    prompt: `Draft chapter ${chapter.number}, "${chapter.title}".

What this chapter must do:
${chapter.summary}

Beats to hit, in order:
${chapter.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}

Target length: ${wordsPerChapter} words (within 15%).
${chapter.number === 1 ? "This is the opening chapter: earn the reader's attention in the first paragraph." : ""}
${chapter.number === plan.chapters.length ? "This is the final chapter: land the book, do not trail off." : ""}`,
  }));

  const results = await batchProse({ jobs, system: bible, onProgress });

  return plan.chapters.map((chapter) => ({
    ...chapter,
    body: results.get(`ch-${String(chapter.number).padStart(3, "0")}`) || "",
  }));
}
