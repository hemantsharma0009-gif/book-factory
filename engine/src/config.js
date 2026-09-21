/**
 * Central configuration. Every tunable the pipeline reads lives here so a
 * change of model, price or path is a one-line edit rather than a grep.
 */
import path from "node:path";
import os from "node:os";

/** The user chose Sonnet 5 throughout for cost; see docs/PIPELINE.md. */
export const MODEL = process.env.BOOK_FACTORY_MODEL || "claude-sonnet-5";

/**
 * USD per million tokens, used only to estimate and report spend.
 * Batch requests bill at 50% of these rates.
 */
export const PRICING = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

export const BATCH_DISCOUNT = 0.5;

/** Where generated books, manifests and packs are written. */
export const DATA_DIR = process.env.BOOK_FACTORY_DATA
  ? path.resolve(process.env.BOOK_FACTORY_DATA)
  : path.resolve(process.cwd(), "library");

export const paths = {
  data: DATA_DIR,
  manifest: path.join(DATA_DIR, "library.json"),
  books: path.join(DATA_DIR, "books"),
  tmp: path.join(os.tmpdir(), "book-factory"),
};

/** Book shape defaults. Overridable per blueprint. */
export const DEFAULTS = {
  chapters: 12,
  wordsPerChapter: 2200,
  frontMatter: true,
  charts: true,
  priceUsd: 9.99,
};

/**
 * How many recent genres to exclude when picking the next one. The user's
 * requirement: consecutive books must not repeat a genre.
 */
export const GENRE_COOLDOWN = 5;

/** Batch polling. Most batches finish well inside an hour. */
export const BATCH_POLL_MS = Number(process.env.BOOK_FACTORY_POLL_MS || 20_000);
export const BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Set by --dry-run: use the deterministic stub model instead of the API. */
export const isDryRun = () => process.env.BOOK_FACTORY_DRY_RUN === "1";
