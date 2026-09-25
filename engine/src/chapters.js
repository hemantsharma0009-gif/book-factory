/**
 * Chapters on disk, one file each.
 *
 * A chapter is written to `library/books/<id>/chapters/ch-007.md` the moment it
 * finishes, before anything else happens. That single decision is what makes
 * the rest of this feature possible: you can read chapter 7 while chapter 8 is
 * being written, edit it in place, download the book so far, or lose power and
 * resume without repaying for what was already generated.
 *
 * The file format is the same as manuscript.md's sections, so assembling the
 * manuscript is a join rather than a conversion.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { bookDir } from "./store.js";

export const CHAPTER_DIR = "chapters";

export const chapterFile = (number) => `ch-${String(number).padStart(3, "0")}.md`;

function dirFor(bookId) {
  return path.join(bookDir(bookId), CHAPTER_DIR);
}

export function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

export async function writeChapter(bookId, chapter) {
  const dir = dirFor(bookId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, chapterFile(chapter.number));
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `# ${chapter.title}\n\n${chapter.body.trim()}\n`);
  await fs.rename(tmp, file);
  return file;
}

export async function readChapter(bookId, number) {
  try {
    const raw = await fs.readFile(path.join(dirFor(bookId), chapterFile(number)), "utf8");
    return parseChapterFile(raw, number);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** A heading-less file is still a chapter - keep the prose, invent no title. */
export function parseChapterFile(raw, number) {
  const text = String(raw).replace(/\r\n/g, "\n").trim();
  const match = text.match(/^#\s+(.+?)\n+([\s\S]*)$/);
  if (!match) return { number, title: `Chapter ${number}`, body: text, words: countWords(text) };
  return { number, title: match[1].trim(), body: match[2].trim(), words: countWords(match[2]) };
}

/** Every chapter present, in order. Gaps are skipped, not faked. */
export async function readAllChapters(bookId, upTo = 200) {
  const out = [];
  for (let n = 1; n <= upTo; n += 1) {
    const chapter = await readChapter(bookId, n);
    if (chapter) out.push(chapter);
  }
  return out;
}

export function assembleManuscript(chapters) {
  return chapters.map((c) => `# ${c.title}\n\n${c.body}`).join("\n\n---\n\n");
}

/**
 * Has a human touched this file since the engine wrote it?
 *
 * Compares the text, not the timestamp: a resume rewrites run.json and a Drive
 * sync rewrites mtimes, and neither means the prose changed. Text comparison
 * cannot produce a false positive, which is the direction that matters - a
 * false positive would have the editorial pass skip a chapter nobody edited.
 */
export function wasEdited(onDisk, generated) {
  if (!onDisk || !generated) return false;
  return onDisk.body.trim() !== String(generated).trim();
}

/**
 * A fingerprint of the prose the engine last wrote.
 *
 * Stored in run.json so a resume can tell "you edited this chapter" from "the
 * engine wrote this chapter", without keeping a second copy of the whole book
 * in the run record. Comparing text, not timestamps: a Drive sync rewrites
 * mtimes and a resume rewrites run.json, and neither means a word changed.
 */
export function hashBody(text) {
  return createHash("sha1").update(String(text || "").trim()).digest("hex").slice(0, 16);
}

/**
 * The chapter being written, as far as it has got.
 *
 * A separate file from the finished chapter, and deliberately not the same
 * name: `readAllChapters` must never pick a half-written chapter up and put it
 * in a manuscript or an EPUB. This exists only to be read on screen while the
 * words are arriving.
 *
 * Written from a stream, so it is always a prefix of the finished chapter -
 * never a different version of it.
 */
const partialFile = (number) => `ch-${String(number).padStart(3, "0")}.partial.md`;

export async function writePartial(bookId, number, text) {
  const dir = dirFor(bookId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, partialFile(number));
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, String(text));
  await fs.rename(tmp, file);
}

export async function readPartial(bookId, number) {
  try {
    const raw = await fs.readFile(path.join(dirFor(bookId), partialFile(number)), "utf8");
    return { number, body: raw, words: countWords(raw), partial: true };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Cleared when the chapter lands, and again before it is rewritten.
 *
 * A stale partial left by a crash would otherwise be served as a preview of a
 * chapter that is about to be written from scratch - showing you text that is
 * not going to be in the book.
 */
export async function clearPartial(bookId, number) {
  await fs.rm(path.join(dirFor(bookId), partialFile(number)), { force: true });
}
