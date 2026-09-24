/**
 * Editorial pass. Runs as a second batch over the drafted chapters.
 *
 * This is where the difference between "AI output" and "a book" is made, so it
 * is not optional - a single pass costs roughly what drafting does at batch
 * rates and removes the repetition and throat-clearing that drafting leaves.
 *
 * Two design decisions worth understanding:
 *
 * 1. THE EDITOR SEES THE WHOLE MANUSCRIPT, not summaries of earlier chapters.
 *    Summaries cannot reveal that chapter 3 and chapter 9 make the same point
 *    in the same words - only the text can. The manuscript goes in the CACHED
 *    system prefix, byte-identical across every request in the batch, so it is
 *    billed as one cache write plus cheap reads rather than resent per chapter.
 *
 * 2. PARALLEL EDITS NEED A DETERMINISTIC TIE-BREAK. Every chapter is edited
 *    simultaneously and no editor can see another's decisions. Without a rule,
 *    both the chapter-3 and chapter-9 editors would independently cut the
 *    material they share and it would vanish from the book entirely. The rule
 *    below - the later chapter always defers to the earlier one - resolves
 *    every such case identically from either side, with no coordination.
 */
import { batchProse, streamProse } from "../model.js";
import { buildBible } from "./planner.js";

/**
 * Above this, the full manuscript is replaced by a window around the target
 * chapter. Sonnet 5 holds 1M tokens, so this is a guard against pathological
 * books rather than a limit anyone should meet in practice.
 */
const MAX_MANUSCRIPT_CHARS = 600_000;
const WINDOW = 3;

const EDIT_INSTRUCTION = `You are a line editor working on ONE chapter of a finished manuscript.

The complete manuscript is above, each chapter delimited by markers. It is there
so you can see what the rest of the book already does. You are editing only the
chapter you are asked for. Never output any other chapter.

Fix, in priority order:
1. Openings that announce themselves ("In this chapter", "Let's explore") - cut them.
2. Material that repeats another chapter. You can now see the other chapters, so
   check properly: the same example, the same claim, the same turn of phrase.
3. Padding: sentences that restate the previous one in different words.
4. Vague claims that need a concrete example, number or name.
5. Style-rule violations from the bible.

THE DEDUPLICATION RULE - follow it exactly:

Every chapter is being edited at the same moment by an editor who cannot see
your decisions. So when material appears in more than one chapter, the chapter
with the LOWER number keeps it and the HIGHER-numbered chapter gives way.

- If the duplicate sits in an EARLIER chapter than yours: cut or compress it in
  yours, and where the argument still needs it, refer back instead of restating.
- If the duplicate sits in a LATER chapter than yours: leave yours exactly as
  it is. The later chapter will yield. Do not cut it "to be safe" - if you both
  cut, the book loses the material altogether.

Preserve the chapter's structure, argument and approximate length. Do not add
meta-commentary. Output the edited chapter body only, in Markdown.`;

const marker = (n, edge) => `<<<CHAPTER ${n} ${edge}>>>`;

/** Full manuscript with unambiguous per-chapter delimiters. */
function buildManuscript(chapters) {
  return chapters
    .map(
      (c) =>
        `${marker(c.number, "START")}\n# ${c.title}\n\n${c.body}\n${marker(c.number, "END")}`,
    )
    .join("\n\n");
}

/** Chapters near `target`, used when the whole manuscript is too large. */
function buildWindow(chapters, target) {
  return chapters
    .filter((c) => Math.abs(c.number - target) <= WINDOW)
    .map(
      (c) =>
        `${marker(c.number, "START")}\n# ${c.title}\n\n${c.body}\n${marker(c.number, "END")}`,
    )
    .join("\n\n");
}

export async function editChapters({ plan, genre, chapters, onProgress, log = () => {}, language }) {
  const bible = buildBible(plan, genre, language);
  const manuscript = buildManuscript(chapters);
  const windowed = manuscript.length > MAX_MANUSCRIPT_CHARS;

  if (windowed) {
    log(
      `  manuscript is ${Math.round(manuscript.length / 1000)}k characters; ` +
        `editing against a ±${WINDOW}-chapter window instead of the whole book`,
    );
  }

  // Everything stable goes in the cached prefix, in a fixed order. When the
  // manuscript is windowed it differs per chapter, so it moves into the
  // per-request prompt and only the bible stays cacheable.
  const sharedPrefix = windowed
    ? `${bible}\n\n${EDIT_INSTRUCTION}`
    : `${bible}\n\n--- FULL MANUSCRIPT ---\n\n${manuscript}\n\n--- END MANUSCRIPT ---\n\n${EDIT_INSTRUCTION}`;

  const jobs = chapters.map((chapter) => {
    const pointer = `Edit chapter ${chapter.number}, "${chapter.title}".

It is delimited by ${marker(chapter.number, "START")} and ${marker(chapter.number, "END")}.

Remember the deduplication rule: chapters numbered below ${chapter.number} keep
any shared material; this chapter gives way to them. Chapters numbered above
${chapter.number} will give way to this one, so do not pre-emptively cut for them.`;

    return {
      id: `ed-${String(chapter.number).padStart(3, "0")}`,
      prompt: windowed
        ? `--- SURROUNDING CHAPTERS ---\n\n${buildWindow(chapters, chapter.number)}\n\n--- END ---\n\n${pointer}`
        : pointer,
    };
  });

  const results = await batchProse({ jobs, system: sharedPrefix, onProgress });

  return chapters.map((chapter) => ({
    ...chapter,
    body: results.get(`ed-${String(chapter.number).padStart(3, "0")}`) || chapter.body,
  }));
}


/**
 * Editorial pass, streamed one chapter at a time.
 *
 * Same prompts and the same deduplication rule as the batch path. The cached
 * prefix stays pinned to the DRAFTED manuscript and is never rebuilt between
 * chapters: rebuilding it after each edit would change the prefix byte for
 * byte, miss the cache on every request, and quietly multiply the cost of the
 * pass - and it would also break the dedup rule, which is only coherent if
 * every editor sees the same text.
 *
 * `skip` holds chapters you edited by hand. They are not sent at all. An
 * editor handed your paragraph would rewrite it, and silently discarding an
 * edit someone made on purpose is not a trade this pass gets to make.
 */
export async function editChaptersLive({
  plan,
  genre,
  chapters,
  language,
  skip = new Set(),
  log = () => {},
  shouldStop = () => null,
  onChapterStart = () => {},
  onDelta = () => {},
  onChapter = async () => {},
  signal,
}) {
  const bible = buildBible(plan, genre, language);
  const manuscript = buildManuscript(chapters);
  const windowed = manuscript.length > MAX_MANUSCRIPT_CHARS;

  if (windowed) {
    log(
      `  manuscript is ${Math.round(manuscript.length / 1000)}k characters; ` +
        `editing against a ±${WINDOW}-chapter window instead of the whole book`,
    );
  }

  const sharedPrefix = windowed
    ? `${bible}\n\n${EDIT_INSTRUCTION}`
    : `${bible}\n\n--- FULL MANUSCRIPT ---\n\n${manuscript}\n\n--- END MANUSCRIPT ---\n\n${EDIT_INSTRUCTION}`;

  const out = [];
  let stopped = null;

  for (const chapter of chapters) {
    if (skip.has(chapter.number)) {
      log(`  chapter ${chapter.number}: kept as you edited it, not sent to the editor`);
      out.push(chapter);
      continue;
    }

    const stop = await shouldStop();
    if (stop) {
      stopped = stop;
      // Everything not yet edited stays as drafted. A half-edited book is
      // still a readable book; a book missing chapters is not.
      out.push(...chapters.slice(out.length));
      break;
    }

    onChapterStart(chapter);

    const edited = await streamProse({
      system: sharedPrefix,
      prompt: windowed
        ? `--- SURROUNDING CHAPTERS ---\n\n${buildWindow(chapters, chapter.number)}\n\n--- END ---\n\n${editPointer(chapter)}`
        : editPointer(chapter),
      signal,
      onDelta: (fragment) => onDelta({ chapter, fragment }),
    });

    const record = { ...chapter, body: edited.trim() || chapter.body, edited: true };
    out.push(record);
    await onChapter(record);
  }

  return { chapters: out, stopped };
}

function editPointer(chapter) {
  return `Edit chapter ${chapter.number}, "${chapter.title}".

It is delimited by ${marker(chapter.number, "START")} and ${marker(chapter.number, "END")}.

Remember the deduplication rule: chapters numbered below ${chapter.number} keep
any shared material; this chapter gives way to them. Chapters numbered above
${chapter.number} will give way to this one, so do not pre-emptively cut for them.`;
}

export const __test = { buildManuscript, buildWindow, EDIT_INSTRUCTION, MAX_MANUSCRIPT_CHARS, editPointer };
