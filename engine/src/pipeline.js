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
import { DEFAULTS, MODEL } from "./config.js";
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
  log = () => {},
} = {}) {
  const state = await store.load();

  const genre = genreId ? genreById(genreId) : nextGenre(state.genreHistory.map((h) => h.genre));
  if (!genre) throw new Error(`Unknown genre "${genreId}".`);
  const angle = nextAngle(genre, state.genreHistory);

  const id = `bk_${Date.now().toString(36)}`;
  log(`Genre: ${genre.name} — ${angle}`);

  log("Planning…");
  const plan = await planBook({ genre, angle, chapters, wordsPerChapter });
  log(`Planned "${plan.title}" (${plan.chapters.length} chapters)`);
  await store.writeArtifact(id, "plan.json", JSON.stringify(plan, null, 2));

  log("Drafting chapters (batch)…");
  let written = await draftChapters({
    plan,
    genre,
    wordsPerChapter,
    onProgress: (p) => log(`  draft: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`),
  });

  log("Editorial pass (batch)…");
  written = await editChapters({
    plan,
    genre,
    chapters: written,
    log,
    onProgress: (p) => log(`  edit: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`),
  });

  const wordCount = written.reduce((sum, c) => sum + countWords(c.body), 0);
  log(`Manuscript: ${wordCount.toLocaleString()} words`);

  log(`Illustrating (${images})…`);
  const figures = await illustrate({ chapters: written, providerId: images });
  log(`  ${figures.size} figure(s)`);

  log("Writing listing…");
  const listing = await writeListing({ plan, genre, wordCount, angle });

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
    language: "en",
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
    title: plan.title,
    subtitle: plan.subtitle,
    author,
    genre: genre.id,
    genreName: genre.name,
    angle,
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
    s.genreHistory.unshift({ genre: genre.id, angle, at: Date.now(), bookId: id });
    s.genreHistory = s.genreHistory.slice(0, 50);
    s.runs.unshift({ at: Date.now(), bookId: id, cost, model: MODEL });
    s.runs = s.runs.slice(0, 100);
  });

  log(`Done. ${book.title} — awaiting your approval. Estimated cost $${cost.usd.toFixed(2)}`);
  return book;
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
}
