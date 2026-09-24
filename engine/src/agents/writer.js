/**
 * Drafting agent.
 *
 * Two ways to run the same prompts:
 *
 *   draftChapters      one batch, all chapters at once, 50% off. Nothing is
 *                      readable until the whole batch ends, and there is no
 *                      point at which it can be interrupted. Right for an
 *                      unattended or scheduled run.
 *
 *   draftChaptersLive  one streamed request per chapter, in order, at full
 *                      rate. Each chapter lands as it finishes, so it can be
 *                      read, edited and downloaded while the rest is still
 *                      being written, and the run can be paused between
 *                      chapters. Right when you are watching.
 *
 * The prompts are identical, so the prose does not depend on which you pick -
 * only the price and what you can see while it happens.
 */
import { batchProse, streamProse } from "../model.js";
import { buildBible } from "./planner.js";

const jobId = (number) => `ch-${String(number).padStart(3, "0")}`;

function chapterPrompt({ chapter, plan, wordsPerChapter }) {
  return `Draft chapter ${chapter.number}, "${chapter.title}".

What this chapter must do:
${chapter.summary}

Beats to hit, in order:
${chapter.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}

Target length: ${wordsPerChapter} words (within 15%).
${chapter.number === 1 ? "This is the opening chapter: earn the reader's attention in the first paragraph." : ""}
${chapter.number === plan.chapters.length ? "This is the final chapter: land the book, do not trail off." : ""}`;
}

export async function draftChapters({ plan, genre, wordsPerChapter, onProgress, language }) {
  const bible = buildBible(plan, genre, language);

  const jobs = plan.chapters.map((chapter) => ({
    id: jobId(chapter.number),
    prompt: chapterPrompt({ chapter, plan, wordsPerChapter }),
  }));

  const results = await batchProse({ jobs, system: bible, onProgress });

  return plan.chapters.map((chapter) => ({
    ...chapter,
    body: results.get(jobId(chapter.number)) || "",
  }));
}

/**
 * Live drafting.
 *
 * @param {object[]} existing   chapters already on disk; these are never rewritten
 * @param {function} shouldStop called before each chapter - return "pause",
 *                              "cancel" or nothing. Checked at the boundary and
 *                              not mid-chapter, because abandoning a chapter
 *                              halfway means paying for tokens and throwing the
 *                              words away.
 * @param {function} onChapter  awaited after each chapter, so the caller can
 *                              write it to disk before the next one starts.
 */
export async function draftChaptersLive({
  plan,
  genre,
  wordsPerChapter,
  language,
  existing = [],
  shouldStop = () => null,
  onChapterStart = () => {},
  onDelta = () => {},
  onChapter = async () => {},
  signal,
}) {
  const bible = buildBible(plan, genre, language);
  const done = new Map(existing.map((c) => [c.number, c]));
  const written = [];
  let stopped = null;

  for (const chapter of plan.chapters) {
    const already = done.get(chapter.number);
    if (already?.body) {
      written.push({ ...chapter, ...already });
      continue;
    }

    const stop = await shouldStop();
    if (stop) {
      stopped = stop;
      break;
    }

    onChapterStart(chapter);
    let words = 0;

    const body = await streamProse({
      system: bible,
      prompt: chapterPrompt({ chapter, plan, wordsPerChapter }),
      signal,
      onDelta: (fragment) => {
        // Counting whitespace runs is close enough for a progress bar and
        // costs nothing; a real word count happens once the chapter lands.
        words += (fragment.match(/\s+/g) || []).length;
        onDelta({ chapter, words });
      },
    });

    const record = { ...chapter, body: body.trim() };
    written.push(record);
    await onChapter(record);
  }

  return { chapters: written, stopped };
}

export const __test = { chapterPrompt, jobId };
