/**
 * Editorial pass. Runs as a second batch over the drafted chapters.
 *
 * This is where the difference between "AI output" and "a book" is made, so it
 * is not optional - a single pass costs roughly what drafting does at batch
 * rates and removes the repetition and throat-clearing that drafting leaves.
 */
import { batchProse } from "../model.js";
import { buildBible } from "./planner.js";

const EDIT_INSTRUCTION = `You are a line editor. Return the chapter rewritten, in full, improved.

Fix, in priority order:
1. Openings that announce themselves ("In this chapter", "Let's explore") - cut them.
2. Repetition of phrasing, sentence rhythm or ideas already covered elsewhere.
3. Padding: sentences that restate the previous one with different words.
4. Vague claims that need a concrete example, number or name.
5. Style-rule violations from the bible.

Preserve the chapter's structure, argument and length. Do not add meta-commentary.
Output the edited chapter body only, in Markdown.`;

export async function editChapters({ plan, genre, chapters, onProgress }) {
  const bible = `${buildBible(plan, genre)}\n\n${EDIT_INSTRUCTION}`;

  const jobs = chapters.map((chapter) => ({
    id: `ed-${String(chapter.number).padStart(3, "0")}`,
    prompt: `Edit chapter ${chapter.number}, "${chapter.title}".

Chapters already written before this one (for repetition checking):
${chapters
  .filter((c) => c.number < chapter.number)
  .map((c) => `${c.number}. ${c.title}: ${c.summary}`)
  .join("\n") || "(this is the first chapter)"}

--- CHAPTER DRAFT ---
${chapter.body}`,
  }));

  const results = await batchProse({ jobs, system: bible, onProgress });

  return chapters.map((chapter) => ({
    ...chapter,
    body: results.get(`ed-${String(chapter.number).padStart(3, "0")}`) || chapter.body,
  }));
}
