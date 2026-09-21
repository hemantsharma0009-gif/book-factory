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

/**
 * Where generated books, manifests and packs are written.
 *
 * Resolved on each call rather than frozen at import, so BOOK_FACTORY_DATA can
 * be set by a caller (or a test) after this module is loaded.
 */
export function dataDir() {
  return process.env.BOOK_FACTORY_DATA
    ? path.resolve(process.env.BOOK_FACTORY_DATA)
    : path.resolve(process.cwd(), "library");
}

export function paths() {
  const data = dataDir();
  return {
    data,
    manifest: path.join(data, "library.json"),
    books: path.join(data, "books"),
    tmp: path.join(os.tmpdir(), "book-factory"),
  };
}

/** Book shape defaults. Overridable per blueprint. */
export const DEFAULTS = {
  chapters: 12,
  wordsPerChapter: 2200,
  frontMatter: true,
  charts: true,
  priceUsd: 9.99,
  language: "en",
};

/**
 * Languages a book can be written in.
 *
 * `code` is the BCP-47 tag that goes into the EPUB (dc:language and every
 * xml:lang), because a reader that does not know the language hyphenates and
 * renders it wrongly. `endonym` is the name in the language itself, which is
 * what belongs on the title page. `rtl` drives the text direction.
 *
 * KDP publishes its own list of accepted languages and changes it, so the
 * handoff sheet tells you to confirm the language appears in the dropdown
 * rather than asserting that it does.
 */
export const LANGUAGES = {
  en: { code: "en", name: "English", endonym: "English", script: "Latin" },
  hi: { code: "hi", name: "Hindi", endonym: "हिन्दी", script: "Devanagari" },
  mr: { code: "mr", name: "Marathi", endonym: "मराठी", script: "Devanagari" },
  bn: { code: "bn", name: "Bengali", endonym: "বাংলা", script: "Bengali" },
  gu: { code: "gu", name: "Gujarati", endonym: "ગુજરાતી", script: "Gujarati" },
  ta: { code: "ta", name: "Tamil", endonym: "தமிழ்", script: "Tamil" },
  te: { code: "te", name: "Telugu", endonym: "తెలుగు", script: "Telugu" },
  ml: { code: "ml", name: "Malayalam", endonym: "മലയാളം", script: "Malayalam" },
  es: { code: "es", name: "Spanish", endonym: "Español", script: "Latin" },
  fr: { code: "fr", name: "French", endonym: "Français", script: "Latin" },
  de: { code: "de", name: "German", endonym: "Deutsch", script: "Latin" },
  pt: { code: "pt", name: "Portuguese", endonym: "Português", script: "Latin" },
  ar: { code: "ar", name: "Arabic", endonym: "العربية", script: "Arabic", rtl: true },
};

export function languageById(id) {
  return LANGUAGES[String(id || "").toLowerCase()] || null;
}

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
