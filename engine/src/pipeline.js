/**
 * The production pipeline for one book.
 *
 * plan -> draft -> edit -> illustrate -> listing -> cover -> EPUB -> await approval
 *
 * Nothing here publishes. The pipeline always stops at `awaiting_approval`;
 * publishing is a separate, explicitly invoked step (see publish/).
 */
import { randomUUID } from "node:crypto";
import { planBook } from "./agents/planner.js";
import { draftChapters } from "./agents/writer.js";
import { editChapters } from "./agents/editor.js";
import { writeListing } from "./agents/marketer.js";
import { illustrate } from "./illustrate/index.js";
import { renderCover } from "./cover.js";
import { buildEpub } from "./epub.js";
import { nextGenre, nextAngle, genreById } from "./genres.js";
import { spendReport } from "./model.js";
import { DEFAULTS, MODEL, languageById } from "./config.js";
import * as store from "./store.js";

/**
 * KDP requires AI-assisted content to be declared at upload. The pipeline
 * records it on the book and prints it in the handoff pack so the declaration
 * is never forgotten at the form.
 */
export const AI_DISCLOSURE =
  "This book was produced with AI assistance (text generation and editing) under human review.";

const countWords = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

export async function produceBook({
  genreId = null,
  chapters = DEFAULTS.chapters,
  wordsPerChapter = DEFAULTS.wordsPerChapter,
  images = "charts",
  author = "Book Factory Studio",
  language: languageId = DEFAULTS.language,
  /**
   * Sample mode: plan the whole book but write only the first few chapters.
   * The point is to judge PROSE for about a tenth of the cost, before
   * committing to a full run - so the chapters it does write go through the
   * same drafting and editing the real thing would.
   */
  sample = 0,
  log = () => {},
} = {}) {
  const state = await store.load();

  const genre = genreId ? genreById(genreId) : nextGenre(state.genreHistory.map((h) => h.genre));
  if (!genre) throw new Error(`Unknown genre "${genreId}".`);

  const language = languageById(languageId);
  if (!language) throw new Error(`Unknown language "${languageId}".`);
  const angle = nextAngle(genre, state.genreHistory);

  const id = `bk_${Date.now().toString(36)}`;
  log(`Genre: ${genre.name} — ${angle}`);
  if (language.code !== "en") log(`Language: ${language.name} (${language.endonym})`);

  log("Planning…");
  const fullPlan = await planBook({ genre, angle, chapters, wordsPerChapter, language });
  log(`Planned "${fullPlan.title}" (${fullPlan.chapters.length} chapters)`);
  await store.writeArtifact(id, "plan.json", JSON.stringify(fullPlan, null, 2));

  // The bible still describes the whole book, so sampled chapters are written
  // with the same context the full run would give them.
  const plan = sample
    ? { ...fullPlan, chapters: fullPlan.chapters.slice(0, sample) }
    : fullPlan;

  if (sample) {
    log(`Sample: writing ${plan.chapters.length} of ${fullPlan.chapters.length} chapters`);
  }

  log("Drafting chapters (batch)…");
  let written = await draftChapters({
    plan,
    genre,
    wordsPerChapter,
    language,
    onProgress: (p) => log(`  draft: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`),
  });

  log("Editorial pass (batch)…");
  written = await editChapters({
    plan,
    genre,
    chapters: written,
    language,
    log,
    onProgress: (p) => log(`  edit: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`),
  });

  const wordCount = written.reduce((sum, c) => sum + countWords(c.body), 0);
  log(`Manuscript: ${wordCount.toLocaleString()} words`);

  log(`Illustrating (${images})…`);
  const figures = await illustrate({ chapters: written, providerId: images });
  log(`  ${figures.size} figure(s)`);

  log("Writing listing…");
  const listing = await writeListing({ plan, genre, wordCount, angle, language });

  const coverSvg = renderCover({
    title: plan.title,
    subtitle: plan.subtitle,
    author,
    brief: listing.coverBrief,
  });
  await store.writeArtifact(id, "cover.svg", coverSvg);

  log("Assembling EPUB…");
  const uuid = randomUUID();
  const epub = await buildEpub({
    uuid,
    title: plan.title,
    subtitle: plan.subtitle,
    author,
    publisher: author,
    language: language.code,
    rtl: Boolean(language.rtl),
    description: listing.description,
    chapters: written,
    figures,
    coverSvg,
    aiDisclosure: AI_DISCLOSURE,
  });

  const epubPath = await store.writeArtifact(id, `${slug(plan.title)}.epub`, epub);
  await store.writeArtifact(
    id,
    "manuscript.md",
    written.map((c) => `# ${c.title}\n\n${c.body}`).join("\n\n---\n\n"),
  );

  const cost = spendReport();

  const book = {
    id,
    uuid,
    sample: sample ? { chapters: plan.chapters.length, of: fullPlan.chapters.length } : null,
    title: plan.title,
    subtitle: plan.subtitle,
    author,
    genre: genre.id,
    genreName: genre.name,
    angle,
    language: language.code,
    languageName: language.name,
    status: "awaiting_approval",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    wordCount,
    chapterCount: written.length,
    figureCount: figures.size,
    epubFile: epubPath.split("/").pop(),
    epubBytes: epub.length,
    listing,
    aiDisclosure: AI_DISCLOSURE,
    model: MODEL,
    cost,
    published: { gumroad: null, kdp: null },
  };

  await store.update(async (s) => {
    s.books.unshift(book);
    // A sample does not consume a genre slot - you will want to write this
    // book properly afterwards, in this same genre.
    if (!sample) {
      s.genreHistory.unshift({ genre: genre.id, angle, at: Date.now(), bookId: id });
      s.genreHistory = s.genreHistory.slice(0, 50);
    }
    s.runs.unshift({ at: Date.now(), bookId: id, cost, model: MODEL, sample: Boolean(sample) });
    s.runs = s.runs.slice(0, 100);
  });

  if (sample) {
    log(
      `Sample done. "${book.title}" — ${plan.chapters.length} chapters, ` +
        `$${cost.usd.toFixed(2)}. Read it, then run the full book if the prose holds up.`,
    );
  } else {
    log(`Done. ${book.title} — awaiting your approval. Estimated cost $${cost.usd.toFixed(2)}`);
  }
  return book;
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
}
