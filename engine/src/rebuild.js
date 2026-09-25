/**
 * Rebuilding a book from its edited manuscript.
 *
 * Reading a draft and wanting to change something is the normal case, not the
 * exception - it is the whole reason the pipeline stops for approval. But
 * until now an edit went nowhere: manuscript.md was an output, and the EPUB
 * had already been assembled from the text as the model first wrote it. You
 * could fix a chapter and still publish the unfixed book, with nothing
 * anywhere to tell you.
 *
 * So: edit manuscript.md in any editor, run `rebuild`, and the EPUB is
 * reassembled from what you actually wrote. No model call, no cost.
 *
 * Figures are re-attached from the files already in the book's directory
 * rather than regenerated, so a rebuild cannot quietly change the pictures.
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as store from "./store.js";
import { buildEpub } from "./epub.js";
import { renderCover, renderPhotoCover } from "./cover.js";
import { languageById } from "./config.js";
import { AI_DISCLOSURE, alsoByFor } from "./pipeline.js";

/**
 * Splits the manuscript back into chapters.
 *
 * The format is the one pipeline.js writes: "# Title", a blank line, the body,
 * separated by a horizontal rule. Parsing it back rather than storing chapters
 * separately means the file you edited IS the source - there is no second copy
 * to drift out of step with it.
 */
export function parseManuscript(markdown) {
  const blocks = String(markdown).split(/\n+---\n+/);
  const chapters = [];

  blocks.forEach((block) => {
    const text = block.trim();
    if (!text) return;

    const match = text.match(/^#\s+(.+?)\s*\n([\s\S]*)$/);
    if (!match) {
      // A block with no heading is still someone's writing. Keep it, rather
      // than dropping a chapter because its title line was reformatted.
      chapters.push({ number: chapters.length + 1, title: `Chapter ${chapters.length + 1}`, body: text });
      return;
    }

    chapters.push({ number: chapters.length + 1, title: match[1].trim(), body: match[2].trim() });
  });

  return chapters;
}

const countWords = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** Figures already on disk, keyed by chapter, so a rebuild reuses them. */
/**
 * Pictures already on disk, re-attached rather than regenerated.
 *
 * Two places to look, because there are two kinds: chart SVGs sit in the book
 * directory, generated artwork sits in `figures/`. Missing the second folder
 * would silently rebuild an illustrated book with no illustrations - and since
 * a rebuild is what you run after editing, the pictures you paid for would
 * disappear at exactly the moment you were not looking for them.
 *
 * Alt text and captions come from art.json where it exists. Inventing
 * "Figure 3" for a screen reader is worse than useless when the art director
 * already wrote a real description.
 */
async function existingFigures(id, chapters) {
  const dir = store.bookDir(id);
  const figures = new Map();

  const briefs = new Map();
  try {
    const art = JSON.parse(await fs.readFile(path.join(dir, "art.json"), "utf8"));
    for (const brief of art.figures || []) briefs.set(brief.number, brief);
  } catch {
    /* no art direction for this book */
  }

  for (const folder of [dir, path.join(dir, "figures")]) {
    let names;
    try {
      names = await fs.readdir(folder);
    } catch {
      continue;
    }

    for (const name of names) {
      const match = name.match(/^fig-(\d+)\.(svg|png|jpg|jpeg)$/i);
      if (!match) continue;

      const chapterNumber = Number(match[1]);
      if (!chapters.some((c) => c.number === chapterNumber)) continue;
      if (figures.has(chapterNumber)) continue;

      const extension = match[2].toLowerCase();
      const brief = briefs.get(chapterNumber);

      figures.set(chapterNumber, {
        id: `fig-${match[1]}`,
        filename: name,
        mediaType: extension === "svg" ? "image/svg+xml" : `image/${extension === "jpg" ? "jpeg" : extension}`,
        data: await fs.readFile(path.join(folder, name)),
        table: "",
        alt: brief?.alt || `Figure ${chapterNumber}`,
        caption: brief?.caption || "",
        credit: null,
        generated: extension !== "svg",
      });
    }
  }

  return figures;
}

/** The generated cover artwork, if this book has any. */
async function existingCoverArt(id) {
  for (const extension of ["png", "jpg"]) {
    try {
      const data = await fs.readFile(path.join(store.bookDir(id), `cover-art.${extension}`));
      return { data, mediaType: extension === "png" ? "image/png" : "image/jpeg" };
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Has the manuscript been edited since the EPUB was built?
 *
 * This is what stops you publishing the version you meant to fix. Compares
 * modification times, so it catches an edit made in any editor - the engine
 * does not need to have been involved.
 */
export async function manuscriptIsNewer(id, epubFile) {
  const dir = store.bookDir(id);
  try {
    const [manuscript, epub] = await Promise.all([
      fs.stat(path.join(dir, "manuscript.md")),
      fs.stat(path.join(dir, epubFile)),
    ]);
    // A second of slack: some editors and filesystems round timestamps, and a
    // spurious warning on every publish would teach you to ignore the real one.
    return manuscript.mtimeMs > epub.mtimeMs + 1000;
  } catch {
    return false;
  }
}

/**
 * Reassembles the EPUB from the manuscript on disk.
 *
 * @returns {Promise<{chapters:number, words:number, epubBytes:number, epubFile:string}>}
 */
export async function rebuildBook({ id, log = () => {} }) {
  const state = await store.load();
  const book = store.findBook(state, id);
  if (!book) throw new Error(`No book ${id}`);

  const markdown = (await store.readArtifact(id, "manuscript.md")).toString("utf8");
  const chapters = parseManuscript(markdown);
  if (!chapters.length) throw new Error("manuscript.md has no chapters in it.");

  const words = chapters.reduce((sum, c) => sum + countWords(c.body), 0);
  const figures = await existingFigures(id, chapters);
  const language = languageById(book.language) || languageById("en");

  log(`Rebuilding from manuscript.md: ${chapters.length} chapters, ${words.toLocaleString()} words`);
  if (chapters.length !== book.chapterCount) {
    log(`  chapter count changed: ${book.chapterCount} → ${chapters.length}`);
  }
  if (figures.size) log(`  re-attaching ${figures.size} figure(s) already on disk`);

  // The cover carries the title and subtitle, so it is redrawn in case either
  // was edited; everything else about it is unchanged. In particular, a book
  // with generated cover artwork keeps that artwork - redrawing it as the
  // plain typographic cover would throw away a picture you paid for, on a
  // command whose whole promise is that it changes only what you edited.
  const coverArt = await existingCoverArt(id);
  const coverSvg = coverArt
    ? renderPhotoCover({
        title: book.title,
        subtitle: book.subtitle,
        author: book.author,
        image: coverArt.data,
        mediaType: coverArt.mediaType,
      })
    : renderCover({
        title: book.title,
        subtitle: book.subtitle,
        author: book.author,
        brief: book.listing?.coverBrief || {},
      });
  await store.writeArtifact(id, "cover.svg", coverSvg);

  const epub = await buildEpub({
    uuid: book.uuid,
    // Rebuilt from the current catalogue, so a book gains the titles written
    // since it was made rather than being frozen with the list it shipped with.
    alsoBy: alsoByFor(state, id),
    title: book.title,
    subtitle: book.subtitle,
    author: book.author,
    publisher: book.author,
    language: language.code,
    rtl: Boolean(language.rtl),
    description: book.listing?.description || "",
    chapters,
    figures,
    coverSvg,
    // Whatever this book declared when it was made. A book with AI-generated
    // images declares both, and a rebuild must not quietly narrow that to the
    // text-only sentence.
    aiDisclosure: book.aiDisclosure || AI_DISCLOSURE,
  });

  await store.writeArtifact(id, book.epubFile, epub);

  // The EPUB was built FROM this manuscript, so it must not look older than
  // it. Usually it does not - but a file synced from another machine can
  // carry a timestamp ahead of this clock, and then the "you have edits"
  // warning would survive every rebuild and teach you to ignore it. Make the
  // invariant true by construction rather than hoping the clocks agree.
  const dir = store.bookDir(id);
  const manuscriptStat = await fs.stat(path.join(dir, "manuscript.md"));
  const epubPath = path.join(dir, book.epubFile);
  const epubStat = await fs.stat(epubPath);

  if (manuscriptStat.mtimeMs >= epubStat.mtimeMs) {
    const stamp = new Date(manuscriptStat.mtimeMs + 2000);
    await fs.utimes(epubPath, stamp, stamp);
  }

  await store.update((s) => {
    const record = store.findBook(s, id);
    record.chapterCount = chapters.length;
    record.wordCount = words;
    record.figureCount = figures.size;
    record.epubBytes = epub.length;
    record.rebuiltAt = Date.now();
    record.updatedAt = Date.now();
  });

  return { chapters: chapters.length, words, epubBytes: epub.length, epubFile: book.epubFile };
}
