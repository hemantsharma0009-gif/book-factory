/**
 * The bridge from the engine to the dashboard.
 *
 * The two halves of this project never spoke: the engine wrote books into its
 * own library, and the dashboard showed a catalogue typed into a browser. A
 * book the factory produced did not appear on the page that tracks books.
 *
 * This writes one JSON file the dashboard can import. A file rather than an
 * API because the dashboard is a static page with no backend - and because the
 * engine runs on your machine while the dashboard runs in your browser, which
 * may not even be the same computer.
 *
 * The export carries only what the dashboard shows. No keys, no tokens, no
 * manuscript - this file is meant to be safe to drop in a Drive folder.
 */
import * as store from "./store.js";
import { languageById } from "./config.js";

export const EXPORT_KIND = "book-factory-export";

/** Dashboard stage names. The engine's statuses map onto these. */
function stageFor(book) {
  if (book.published?.gumroad || book.published?.kdp) return "Publishing";
  if (book.status === "approved") return "Packaging";
  if (book.status === "rejected") return "Editing";
  return "QA";
}

export function toDashboardBook(book) {
  const live = [];
  const storefronts = { amazon: "", gumroad: "", play: "", other: "" };

  if (book.published?.gumroad?.url) {
    storefronts.gumroad = book.published.gumroad.url;
    live.push("gumroad");
  }
  if (book.published?.kdp?.url) {
    storefronts.amazon = book.published.kdp.url;
    live.push("amazon");
  }

  const language = languageById(book.language);
  const chapters = Number(book.chapterCount) || 0;
  const words = Number(book.wordCount) || 0;

  return {
    id: book.id,
    title: book.title,
    series: book.genreName || "Standalone",
    category: book.genreName || "General",
    author: book.author || "Book Factory Studio",
    description: book.listing?.description || "",
    stage: stageFor(book),
    chapters: { total: chapters || 1, done: chapters },
    words: { done: words, target: words || 1 },
    // The engine only ever hands over finished books, so progress is complete.
    // The dashboard's own pipeline stages carry on from here.
    storefronts,
    liveOn: live,
    publishedAt: book.published?.gumroad?.at || null,
    listPriceUsd: book.listing?.priceUsd || null,
    prices: { amazon: Math.min(book.listing?.priceUsd || 0, 9.99) || null },
    // What it cost to make. The dashboard's break-even column is measured
    // against this, and it is the one number only the engine knows.
    productionCostUsd: book.cost?.usd || null,
    generated: true,
    language: language ? language.code : "en",
    createdAt: book.createdAt || Date.now(),
    updatedAt: book.updatedAt || Date.now(),
  };
}

export async function buildDashboardExport() {
  const state = await store.load();
  const books = state.books.filter((b) => b.status !== "rejected" && !b.sample);

  return {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    books: books.map(toDashboardBook),
  };
}
