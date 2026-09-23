/* =========================================================
   Book Factory — publishing operations console
   Plain ES2020, no build step. State lives in localStorage.
   ========================================================= */
(function () {
"use strict";

/* ---------------------------------------------------------
   Constants
   --------------------------------------------------------- */

var APP_VERSION = "2.0";
var SCHEMA_VERSION = 4;

/**
 * Bumped whenever the real catalogue changes. A stored library carrying an
 * older value has the catalogue merged in rather than being left alone - the
 * strict "untouched demo" test used before was too conservative, and stranded
 * libraries showing published books as work in progress.
 */
var CATALOGUE_VERSION = "ledger-2026-09-pricing";
var STORE_KEY = "bookFactory.state.v2";
var LEGACY_KEY = "bookFactoryBooks";
var THEME_KEY = "bookFactory.theme";

var STAGES = [
  "Brief", "Blueprint", "Research", "Outline", "Chapters",
  "Editing", "Fact Check", "QA", "Packaging", "Publishing"
];

var CATEGORIES = [
  "Astrology", "Mythology", "Mystery", "Education",
  "AI / Tech", "Finance", "Health", "General"
];

var FORMATS = ["EPUB / PDF", "EPUB only", "PDF only", "Workbook", "Audio script"];

var ZONES = [
  { id: "IST", label: "India Standard Time (UTC+05:30)", offset: 330 },
  { id: "UTC", label: "Coordinated Universal Time (UTC)", offset: 0 },
  { id: "LON", label: "London (UTC+00:00)", offset: 0 },
  { id: "CET", label: "Central Europe (UTC+01:00)", offset: 60 },
  { id: "EST", label: "US Eastern (UTC−05:00)", offset: -300 },
  { id: "PST", label: "US Pacific (UTC−08:00)", offset: -480 },
  { id: "SGT", label: "Singapore (UTC+08:00)", offset: 480 },
  { id: "AET", label: "Sydney (UTC+10:00)", offset: 600 }
];

/**
 * Blueprints, one per genre the engine can produce.
 *
 * This list mirrors engine/src/genres.js deliberately: the dashboard offering
 * four options while the engine rotated through twelve meant most of the
 * catalogue was unreachable from the UI.
 */
var BLUEPRINTS = [
  { id: "adventure",  name: "Adventure",          kind: "fiction",    category: "Mythology", chapters: 24, words: 78000, format: "EPUB / PDF",
    blurb: "Expedition stakes · pursuit beats · survival tension · QA" },
  { id: "mystery",    name: "Mystery",            kind: "fiction",    category: "Mystery",   chapters: 26, words: 82000, format: "EPUB / PDF",
    blurb: "Clue planting · red herrings · reveal timing · continuity" },
  { id: "literary",   name: "Literary fiction",   kind: "fiction",    category: "Mythology", chapters: 20, words: 74000, format: "EPUB / PDF",
    blurb: "Character interiority · restraint · motif · line editing" },
  { id: "scifi",      name: "Science fiction",    kind: "fiction",    category: "Mystery",   chapters: 22, words: 80000, format: "EPUB / PDF",
    blurb: "World rules · consequence · first contact · consistency" },
  { id: "history",    name: "Narrative history",  kind: "nonfiction", category: "Education", chapters: 16, words: 62000, format: "EPUB / PDF",
    blurb: "Primary sources · chronology · figures · fact check" },
  { id: "selfhelp",   name: "Practical self-help", kind: "nonfiction", category: "Health",   chapters: 12, words: 42000, format: "EPUB / PDF",
    blurb: "One idea per chapter · drills · evidence · no filler" },
  { id: "business",   name: "Business and finance", kind: "nonfiction", category: "Finance", chapters: 14, words: 52000, format: "EPUB / PDF",
    blurb: "Worked numbers · pricing · case studies · charts" },
  { id: "art",        name: "Art and craft",      kind: "nonfiction", category: "Education", chapters: 18, words: 38000, format: "Workbook",
    blurb: "Exercises · progression · reference plates · answer keys" },
  { id: "cooking",    name: "Cooking",            kind: "nonfiction", category: "Health",    chapters: 20, words: 45000, format: "EPUB / PDF",
    blurb: "Tested method · ratios · substitutions · timings" },
  { id: "science",    name: "Popular science",    kind: "nonfiction", category: "Education", chapters: 14, words: 55000, format: "EPUB / PDF",
    blurb: "Mechanism first · analogy · diagrams · sourcing" },
  { id: "wellness",   name: "Health and wellness", kind: "nonfiction", category: "Health",   chapters: 12, words: 40000, format: "EPUB / PDF",
    blurb: "Protocols · evidence grading · caveats · progression" },
  { id: "technology", name: "Technology",         kind: "nonfiction", category: "AI / Tech", chapters: 16, words: 48000, format: "EPUB / PDF",
    blurb: "Tutorials · worked examples · workflows · update cadence" },
  { id: "workbook",   name: "Workbook",           kind: "nonfiction", category: "Education", chapters: 20, words: 32000, format: "Workbook",
    blurb: "Exercises · answer keys · difficulty ramp · QA" }
];

/**
 * Cadences match engine/src/scheduler.js exactly. They used to differ - the
 * dashboard offered "weekdays", which the engine cannot express, and omitted
 * fortnightly and monthly - so a schedule designed here could not be applied.
 */
var CADENCES = {
  daily: { label: "Daily", days: 1 },
  weekly: { label: "Weekly", days: 7 },
  fortnightly: { label: "Fortnightly", days: 14 },
  monthly: { label: "Monthly", days: 30 }
};

var DEFAULT_SCHEDULE = {
  enabled: false,
  cadence: "weekly",
  time: "09:00",
  zone: "IST",
  batch: 1,
  // The engine's spend guards, mirrored so the dashboard cannot describe a
  // schedule the engine would refuse to run.
  maxPending: 3,
  budgetUsd: 20,
  autoQA: true,
  autoPackage: true,
  handoff: true
};

var DEFAULT_SETTINGS = {
  theme: "dark",
};

/* ---------------------------------------------------------
   Seed library
   --------------------------------------------------------- */

/**
 * The real catalogue, as recorded in the Publisher's Ledger (Drive, Sept 2026):
 * title, category, per-platform sale status and list price.
 *
 * Sale status here is what the ledger asserts, not something this app observed
 * - Amazon and Google publish no API to check against, so it is only as current
 *   as the last time the ledger was updated. Correct it in the editor when it
 *   drifts.
 */
function seedBooks() {
  var raw = [
    // title, series, category, chapters, words, price, liveOn[], stage-if-not-live
    ["Ratna Vigyan", "Gemstone Sciences", "Astrology", 18, 62000, 9.99, [], "Packaging"],
    ["The Living Vedic Astrology", "Gemstone Sciences", "Astrology", 22, 80000, 8.99, ["gumroad"], null],
    ["Tarapatti", "Gemstone Sciences", "Astrology", 16, 58000, 7.99, ["amazon"], null],
    ["The Vikramaditya Code", "Vikramaditya", "Astrology", 20, 72000, 8.99, ["amazon"], null],
    ["The Untold Ravana (Sita Secret Edition)", "Lanka Chronicles", "Mythology", 24, 76000, 6.99, ["amazon"], null],
    ["Stone Sky Gods", "Lanka Chronicles", "Mystery", 26, 90000, 7.99, ["amazon"], null],
    ["Common Core Math Series (Grades 3–9)", "Classroom Core", "Education", 20, 32000, 9.99, ["amazon"], null],
    ["Claude Mastery", "Model Mastery", "AI / Tech", 16, 48000, 12.99, ["gumroad"], null],
    ["ChatGPT Mastery", "Model Mastery", "AI / Tech", 16, 48000, 12.99, ["gumroad"], null],
    ["One Dashboard to Rule Them All", "Operator Series", "Finance", 14, 40000, 9.99, ["gumroad"], null],
    ["Claude Mastery Bundle (2026 Edition)", "Model Mastery", "AI / Tech", 32, 96000, 16.99, ["gumroad"], null]
  ];

  var now = Date.now();

  return raw.map(function (r, i) {
    var liveOn = r[6];
    var live = liveOn.length > 0;
    var chapters = r[3];
    var words = r[4];

    return {
      id: "bk_seed_" + (i + 1),
      title: r[0],
      series: r[1],
      category: r[2],
      author: "Hemant Sharma",
      format: r[2] === "Education" ? "Workbook" : "EPUB / PDF",
      description: r[0] + " — published by Hemant Sharma.",
      // A title on sale is finished; anything else keeps its production stage.
      stage: live ? "Publishing" : r[7] || "Blueprint",
      chapters: { total: chapters, done: live ? chapters : Math.round(chapters * 0.4) },
      words: { done: live ? words : Math.round(words * 0.4), target: words },
      priority: "normal",
      revenue: 0,
      queued: false,
      released: false,
      storefronts: { amazon: "", gumroad: "", play: "", other: "" },
      liveOn: liveOn,
      publishedAt: live ? now - (11 - i) * 86400000 : null,
      issues: [],
      createdAt: now - (11 - i) * 86400000,
      updatedAt: now - (11 - i) * 3600000,
      listPriceUsd: r[5],
      // Amazon is capped at the top of its 70% royalty band. Above $9.99 the
      // rate halves, so a higher Amazon price earns less per sale until it is
      // roughly doubled - see priceAdvice(). Other stores keep the list price.
      prices: { amazon: Math.min(r[5], ROYALTY.amazon.bandHigh) }
    };
  });
}

/**
 * Continuity facts derived from the catalogue rather than invented.
 *
 * Only series with more than one title get a bible entry, because continuity
 * is a property of a series - a standalone book has nothing to stay consistent
 * WITH. The page used to show two hand-written facts about books that were
 * demo data, which told you nothing about your own catalogue.
 */
function seedFacts() {
  var books = seedBooks();
  var bySeries = Object.create(null);

  books.forEach(function (book) {
    if (!bySeries[book.series]) bySeries[book.series] = [];
    bySeries[book.series].push(book);
  });

  var facts = [];
  var now = Date.now();

  Object.keys(bySeries).forEach(function (series) {
    var titles = bySeries[series];
    if (titles.length < 2) return;

    facts.push({
      id: uid("ft"),
      text:
        series + " spans " + titles.length + " titles (" +
        titles.map(function (b) { return b.title; }).join(", ") +
        ") — terminology and any recurring names must match across all of them.",
      bookId: titles[0].id,
      series: series,
      createdAt: now - facts.length * 3600000,
    });
  });

  return facts;
}

function seedState() {
  return {
    schema: SCHEMA_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    books: seedBooks(),
    facts: seedFacts(),
    activity: [],
    schedule: clone(DEFAULT_SCHEDULE),
    settings: clone(DEFAULT_SETTINGS),
    lastReport: null,
    lastValidation: null
  };
}

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function $(id) { return document.getElementById(id); }

function escapeHTML(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function toInt(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function toNum(value, fallback) {
  var n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

function formatNumber(n) { return Math.round(n).toLocaleString("en-US"); }

function formatMoney(n) {
  var value = Number(n) || 0;
  var sign = value < 0 ? "−" : "";
  var abs = Math.abs(value);

  // Round totals, but never a price: $7.99 shown as "$8" is simply wrong.
  var digits = Number.isInteger(abs) ? 0 : 2;

  return sign + "$" + abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });
}

function relativeTime(ts) {
  var diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.round(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + "h ago";
  return Math.round(diff / 86400000) + "d ago";
}

function stageIndex(stage) {
  var i = STAGES.indexOf(stage);
  return i < 0 ? 0 : i;
}

/* ---------------------------------------------------------
   Storage
   --------------------------------------------------------- */

var storageWorks = true;

function readStore() {
  var raw = null;

  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch (err) {
    storageWorks = false;
    return null;
  }

  if (!raw) return migrateLegacy();

  try {
    var parsed = JSON.parse(raw);
    return normaliseState(parsed);
  } catch (err) {
    console.warn("Book Factory: stored state was unreadable, falling back to seed data.", err);
    return null;
  }
}

function migrateLegacy() {
  var raw;

  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch (err) {
    return null;
  }

  if (!raw) return null;

  try {
    var legacy = JSON.parse(raw);
    if (!Array.isArray(legacy) || !legacy.length) return null;

    var state = seedState();
    var now = Date.now();

    state.books = legacy.map(function (b, i) {
      var total = 16;
      var target = 50000;
      var stage = STAGES.indexOf(b.stage) >= 0 ? b.stage : "Blueprint";
      var pct = clamp(toInt(b.progress, 0), 0, 100) / 100;

      return {
        id: "bk_" + (b.id != null ? b.id : i),
        title: String(b.title || "Untitled"),
        series: "Imported",
        category: String(b.category || "General"),
        author: String(b.publisher || "Book Factory Studio"),
        format: String(b.format || "EPUB / PDF"),
        description: "Imported from an earlier Book Factory library.",
        stage: stage,
        chapters: { total: total, done: Math.round(total * pct) },
        words: { done: Math.round(target * pct), target: target },
        priority: pct > 0.7 ? "high" : "normal",
        revenue: 0,
        queued: b.status === "RUNNING",
        released: false,
        issues: [],
        createdAt: now,
        updatedAt: now
      };
    });

    state.activity = [{
      id: uid("ac"),
      at: now,
      kind: "system",
      message: "Migrated " + state.books.length + " books from the previous library format."
    }];

    return state;
  } catch (err) {
    console.warn("Book Factory: legacy migration failed.", err);
    return null;
  }
}

function normaliseBook(raw, index) {
  var book = raw && typeof raw === "object" ? raw : {};
  var chapters = book.chapters && typeof book.chapters === "object" ? book.chapters : {};
  var words = book.words && typeof book.words === "object" ? book.words : {};
  var total = clamp(toInt(chapters.total, 12), 1, 400);
  var target = clamp(toInt(words.target, 40000), 0, 5000000);

  return {
    id: String(book.id || uid("bk")),
    title: String(book.title || "Untitled book " + (index + 1)),
    series: String(book.series || "Standalone"),
    category: String(book.category || "General"),
    author: String(book.author || "Book Factory Studio"),
    format: String(book.format || "EPUB / PDF"),
    description: String(book.description || ""),
    stage: STAGES.indexOf(book.stage) >= 0 ? book.stage : "Brief",
    chapters: { total: total, done: clamp(toInt(chapters.done, 0), 0, total) },
    words: { done: clamp(toInt(words.done, 0), 0, 5000000), target: target },
    priority: book.priority === "high" ? "high" : "normal",
    revenue: Math.max(0, toNum(book.revenue, 0)),
    queued: book.queued === true,
    released: book.released === true,
    // Where the book is actually on sale. A title with any of these is LIVE,
    // whatever the pipeline thinks - a published book is not "in production".
    storefronts: normaliseStorefronts(book.storefronts),
    // Stores where the title is on sale but no link has been recorded.
    liveOn: Array.isArray(book.liveOn)
      ? book.liveOn.filter(function (id) {
          return STORES.some(function (store) { return store.id === id; });
        })
      : [],
    publishedAt: toInt(book.publishedAt, 0) || null,
    // Carried explicitly: this function rebuilds a book from a fixed field
    // list, so anything omitted here is silently dropped on every load.
    listPriceUsd: Math.max(0, toNum(book.listPriceUsd, 0)) || null,
    prices: normalisePrices(book.prices),
    productionCostUsd: Math.max(0, toNum(book.productionCostUsd, 0)) || null,
    // Imported storefront rows. Carried explicitly for the same reason as the
    // fields above: this function rebuilds a book from a fixed list, so an
    // omission here would silently discard every import on the next reload.
    sales: normaliseSales(book.sales),
    generated: book.generated === true,
    issues: Array.isArray(book.issues) ? book.issues.filter(Boolean).map(function (issue) {
      return {
        id: String(issue.id || uid("is")),
        text: String(issue.text || "Unspecified blocker"),
        severity: issue.severity === "warn" ? "warn" : "bad"
      };
    }) : [],
    createdAt: toInt(book.createdAt, Date.now()),
    updatedAt: toInt(book.updatedAt, Date.now())
  };
}

/**
 * Royalty a seller actually pays out, and the price band that governs it.
 *
 * Rates are the author's own figures from the Publisher's Ledger. The KDP band
 * is the consequential one: a title priced outside $2.99-$9.99 drops from 70%
 * to 35%, so a $16.99 ebook on Amazon nets LESS per sale than a $9.99 one.
 * These are planning numbers, not accounting - delivery fees and VAT vary.
 */
var ROYALTY = {
  amazon: { rate: 0.70, lowRate: 0.35, bandLow: 2.99, bandHigh: 9.99, label: "Amazon / KDP" },
  gumroad: { rate: 0.85, lowRate: 0.85, bandLow: 0, bandHigh: Infinity, label: "Gumroad" },
  play: { rate: 0.70, lowRate: 0.70, bandLow: 0, bandHigh: Infinity, label: "Google Play Books" },
  other: { rate: 0.80, lowRate: 0.80, bandLow: 0, bandHigh: Infinity, label: "Other store" }
};

/**
 * The price a title is listed at on one storefront.
 *
 * A single price per book cannot express the thing that matters here: $12.99
 * is right on Gumroad, which takes a flat cut, and wrong on Amazon, where it
 * falls outside the 70% band. Per-store prices fall back to the book's list
 * price when nothing store-specific is set.
 */
function priceFor(book, storeId) {
  var prices = book.prices || {};
  var specific = Number(prices[storeId]) || 0;
  return specific || Number(book.listPriceUsd) || 0;
}

/** What one sale nets at `price` on `storeId`, and whether the band bites. */
function netPerSale(storeId, price) {
  var r = ROYALTY[storeId] || ROYALTY.other;
  var inBand = price >= r.bandLow && price <= r.bandHigh;
  var rate = inBand ? r.rate : r.lowRate;
  return { net: price * rate, rate: rate, inBand: inBand, penalised: !inBand && r.lowRate < r.rate };
}

/**
 * The best price to list at on a store, and what it costs to get it wrong.
 *
 * On a banded store the answer is rarely "charge more": above the band the
 * royalty halves, so the top of the band can out-earn a higher price until the
 * price is roughly double. This returns the band-top comparison so the UI can
 * show the crossover rather than assert a rule.
 */
function priceAdvice(storeId, price) {
  var r = ROYALTY[storeId] || ROYALTY.other;
  var current = netPerSale(storeId, price);
  if (r.bandHigh === Infinity) return { current: current, better: null };

  var bandTop = netPerSale(storeId, r.bandHigh);
  if (current.net >= bandTop.net) return { current: current, better: null };

  return {
    current: current,
    better: { price: r.bandHigh, net: bandTop.net, gain: bandTop.net - current.net }
  };
}

var STORES = [
  { id: "amazon", label: "Amazon / KDP" },
  { id: "gumroad", label: "Gumroad" },
  { id: "play", label: "Google Play Books" },
  { id: "other", label: "Other store" },
];

function normalisePrices(raw) {
  var source = raw && typeof raw === "object" ? raw : {};
  var out = {};
  STORES.forEach(function (store) {
    var value = Math.max(0, toNum(source[store.id], 0));
    if (value) out[store.id] = value;
  });
  return out;
}

function normaliseStorefronts(raw) {
  var source = raw && typeof raw === "object" ? raw : {};
  var out = {};
  STORES.forEach(function (store) {
    var value = String(source[store.id] || "").trim();
    // Only keep something that looks like a link, so a stray word cannot
    // silently mark a book as published.
    out[store.id] = /^https?:\/\//i.test(value) ? value : "";
  });
  return out;
}

function liveStores(book) {
  if (!book) return [];
  var stores = book.storefronts || {};
  var flagged = book.liveOn || [];
  return STORES.filter(function (store) {
    return stores[store.id] || flagged.indexOf(store.id) >= 0;
  });
}

function isLive(book) {
  return liveStores(book).length > 0;
}


function normaliseSchedule(raw) {
  var schedule = Object.assign(clone(DEFAULT_SCHEDULE), raw || {});

  // "weekdays" existed only in the old dashboard; map it to the nearest thing
  // the engine can actually run rather than silently keeping a dead value.
  if (!CADENCES[schedule.cadence]) schedule.cadence = "weekly";

  schedule.batch = clamp(toInt(schedule.batch, 1), 1, 20);
  schedule.maxPending = clamp(toInt(schedule.maxPending, 3), 1, 20);
  schedule.budgetUsd = Math.max(0, toNum(schedule.budgetUsd, 20));
  if (!/^\d{2}:\d{2}$/.test(String(schedule.time))) schedule.time = "09:00";
  return schedule;
}

/**
 * Fold the real catalogue into a stored library.
 *
 * Titles match loosely on name. For a match, anything the user recorded -
 * revenue, storefront links, live flags - is kept, and only facts they have
 * not set are taken from the catalogue. Books the user added are left alone,
 * and catalogue titles they lack are added.
 *
 * This replaces an all-or-nothing migration: merging means a library with a
 * single edit in it is no longer stranded on stale data.
 */
function mergeCatalogue(books) {
  var canonical = seedBooks();
  var out = books.slice();
  var key = function (title) {
    return String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  };

  var index = Object.create(null);
  out.forEach(function (book, i) { index[key(book.title)] = i; });

  canonical.forEach(function (fresh) {
    var freshKey = key(fresh.title);
    var found = index[freshKey];

    // Tolerate a stored title that is a prefix of the catalogue's fuller one,
    // e.g. "The Untold Ravana" vs "The Untold Ravana (Sita Secret Edition)".
    if (found === undefined) {
      Object.keys(index).forEach(function (storedKey) {
        if (found !== undefined || storedKey.length < 6) return;
        if (freshKey.indexOf(storedKey) === 0 || storedKey.indexOf(freshKey) === 0) found = index[storedKey];
      });
    }

    if (found === undefined) {
      out.push(fresh);
      return;
    }

    var existing = out[found];
    var userSetLive = (existing.liveOn && existing.liveOn.length) ||
      Object.keys(existing.storefronts || {}).some(function (k) { return existing.storefronts[k]; });

    out[found] = Object.assign({}, existing, {
      title: fresh.title,
      series: existing.series || fresh.series,
      category: existing.category || fresh.category,
      listPriceUsd: existing.listPriceUsd || fresh.listPriceUsd,
      // Per-store prices the user set win; otherwise take the catalogue's,
      // which caps Amazon at the top of its 70% band.
      prices: Object.assign({}, fresh.prices, existing.prices || {}),
      // The catalogue is the authority on where a book is on sale, unless the
      // user has said otherwise themselves.
      liveOn: userSetLive ? existing.liveOn : fresh.liveOn,
      stage: userSetLive ? existing.stage : fresh.stage,
      chapters: existing.chapters && existing.chapters.total ? existing.chapters : fresh.chapters,
      words: existing.words && existing.words.target ? existing.words : fresh.words,
      revenue: Number(existing.revenue) || 0,
      updatedAt: Date.now(),
    });
  });

  return out;
}

function normaliseState(raw) {
  if (!raw || typeof raw !== "object") return null;

  var base = seedState();

  var books = Array.isArray(raw.books) ? raw.books.map(normaliseBook) : base.books;
  var merged = false;

  // Fold in the catalogue once per version, keeping everything the user set.
  if (raw.catalogueVersion !== CATALOGUE_VERSION && books.length) {
    books = mergeCatalogue(books).map(normaliseBook);
    merged = true;
  }

  var ids = Object.create(null);
  books.forEach(function (book) {
    while (ids[book.id]) book.id = uid("bk");
    ids[book.id] = true;
  });

  var bookIds = Object.create(null);
  books.forEach(function (b) { bookIds[b.id] = true; });

  return {
    schema: SCHEMA_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    catalogueMerged: merged,
    books: books,
    facts: (Array.isArray(raw.facts) ? raw.facts : base.facts)
      .filter(function (f) { return f && f.text; })
      .map(function (f) {
        return {
          id: String(f.id || uid("ft")),
          text: String(f.text),
          bookId: bookIds[f.bookId] ? f.bookId : null,
          createdAt: toInt(f.createdAt, Date.now())
        };
      }),
    activity: (Array.isArray(raw.activity) ? raw.activity : []).slice(0, 200).map(function (a) {
      return {
        id: String(a.id || uid("ac")),
        at: toInt(a.at, Date.now()),
        kind: String(a.kind || "system"),
        message: String(a.message || "")
      };
    }),
    schedule: normaliseSchedule(raw.schedule),
    settings: Object.assign(clone(DEFAULT_SETTINGS), raw.settings || {}),
    lastReport: raw.lastReport || null,
    lastValidation: raw.lastValidation || null
  };
}

var saveTimer = null;

function save() {
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(function () {
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      storageWorks = true;
    } catch (err) {
      storageWorks = false;
      console.warn("Book Factory: could not persist state.", err);
    }
    renderStorageState();
  }, 120);
}

/* ---------------------------------------------------------
   State
   --------------------------------------------------------- */

var state = readStore() || seedState();

var ui = {
  page: "dashboard",
  search: "",
  category: "",
  status: "",
  sort: "updated",
  onlyActive: false,
  running: false,
  lastFocus: null
};

var runTimer = null;

function log(kind, message) {
  state.activity.unshift({ id: uid("ac"), at: Date.now(), kind: kind, message: message });
  if (state.activity.length > 200) state.activity.length = 200;
}

function touch(book) { book.updatedAt = Date.now(); }

/* ---------------------------------------------------------
   Derived values
   --------------------------------------------------------- */

function progressOf(book) {
  if (isLive(book) || book.released) return 100;

  var i = stageIndex(book.stage);
  var step = 100 / (STAGES.length - 1);
  var pct = i * step;

  if (book.stage === "Chapters" && book.chapters.total > 0) {
    pct += step * (book.chapters.done / book.chapters.total);
  }

  return Math.round(clamp(pct, 0, 100));
}

function statusOf(book) {
  // A book on sale is finished, whatever stage the pipeline last recorded.
  if (isLive(book)) return "LIVE";
  if (book.issues.length) return "BLOCKED";
  if (book.released) return "RELEASED";
  if (book.stage === "Publishing") return "READY";
  if (book.queued) return "RUNNING";
  return "PIPELINE";
}

function statusClass(status) {
  if (status === "LIVE") return "ok";
  if (status === "READY" || status === "RELEASED") return "ok";
  if (status === "RUNNING") return "blue";
  if (status === "BLOCKED") return "bad";
  return "warn";
}

function metadataComplete(book) {
  return Boolean(
    book.title.trim() &&
    book.author.trim() &&
    book.category.trim() &&
    book.series.trim() &&
    book.description.trim().length >= 10 &&
    book.words.target > 0
  );
}

function packageState(book) {
  if (isLive(book)) {
    return {
      epub: "LIVE", pdf: "LIVE", metadata: "LIVE", zip: "LIVE",
      validator: "PASS", blockers: [],
    };
  }

  var i = stageIndex(book.stage);
  var packIndex = STAGES.indexOf("Packaging");
  var editIndex = STAGES.indexOf("Editing");
  var artifact = i >= packIndex ? "READY" : (i >= editIndex ? "PIPELINE" : "PENDING");
  var meta = metadataComplete(book) ? "READY" : "MISSING";
  var blockers = [];

  if (artifact !== "READY") blockers.push("Awaiting packaging stage");
  if (meta !== "READY") blockers.push("Metadata incomplete");

  book.issues.forEach(function (issue) { blockers.push(issue.text); });

  var zip = artifact === "READY" && meta === "READY" && !book.issues.length ? "READY" : "PENDING";
  var validator = zip === "READY" ? "PASS" : (book.issues.length || meta === "MISSING" ? "REVIEW" : "PENDING");

  return {
    epub: artifact,
    pdf: book.format === "EPUB only" ? "N/A" : artifact,
    metadata: meta,
    zip: zip,
    validator: validator,
    blockers: blockers
  };
}

function artifactClass(value) {
  if (value === "LIVE") return "ok";
  if (value === "READY" || value === "PASS") return "ok";
  if (value === "PIPELINE") return "blue";
  if (value === "MISSING" || value === "FAIL") return "bad";
  if (value === "REVIEW") return "warn";
  return "";
}

function summary() {
  var books = state.books;
  var counts = { LIVE: 0, READY: 0, RUNNING: 0, PIPELINE: 0, BLOCKED: 0, RELEASED: 0 };

  books.forEach(function (b) { counts[statusOf(b)] += 1; });

  var words = books.reduce(function (sum, b) { return sum + b.words.done; }, 0);
  var target = books.reduce(function (sum, b) { return sum + b.words.target; }, 0);
  var chapters = books.reduce(function (sum, b) { return sum + b.chapters.done; }, 0);
  var revenue = books.reduce(function (sum, b) { return sum + b.revenue; }, 0);
  var passing = books.filter(function (b) { return packageState(b).validator === "PASS"; }).length;

  return {
    total: books.length,
    counts: counts,
    queued: books.filter(function (b) { return b.queued; }).length,
    words: words,
    target: target,
    chapters: chapters,
    revenue: revenue,
    passing: passing,
    avgProgress: books.length
      ? Math.round(books.reduce(function (s, b) { return s + progressOf(b); }, 0) / books.length)
      : 0
  };
}

/* ---------------------------------------------------------
   Scheduler maths
   --------------------------------------------------------- */

function zoneOffset(id) {
  var zone = ZONES.filter(function (z) { return z.id === id; })[0];
  return zone ? zone.offset : 0;
}

function zoneLabel(id) {
  var zone = ZONES.filter(function (z) { return z.id === id; })[0];
  return zone ? zone.label : id;
}

function nextRunAt(schedule, from) {
  if (!schedule || !schedule.enabled) return null;

  var now = from || Date.now();
  var offset = zoneOffset(schedule.zone) * 60000;
  var parts = String(schedule.time || "09:00").split(":");
  var hour = clamp(toInt(parts[0], 9), 0, 23);
  var minute = clamp(toInt(parts[1], 0), 0, 59);
  var cadence = CADENCES[schedule.cadence] || CADENCES.weekly;
  var local = new Date(now + offset);

  // Walk forward a day at a time until the first slot that is both in the
  // future and lands on a day this cadence runs.
  for (var day = 0; day <= 62; day++) {
    var candidate = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + day,
      hour,
      minute
    );

    var instant = candidate - offset;
    if (instant <= now) continue;

    var at = new Date(candidate);

    if (schedule.cadence === "weekly" && at.getUTCDay() !== 1) continue;
    if (schedule.cadence === "fortnightly") {
      if (at.getUTCDay() !== 1) continue;
      // Every other Monday, anchored to ISO week parity so it is stable.
      var week = Math.floor(candidate / (7 * 86400000));
      if (week % 2 !== 0) continue;
    }
    if (schedule.cadence === "monthly" && at.getUTCDate() !== 1) continue;

    return instant;
  }

  return null;
}

function countdown(ts) {
  if (!ts) return "—";

  var diff = ts - Date.now();
  if (diff <= 0) return "due now";

  var hours = Math.floor(diff / 3600000);
  var minutes = Math.floor((diff % 3600000) / 60000);

  if (hours >= 24) {
    var days = Math.floor(hours / 24);
    return days + "d " + (hours % 24) + "h";
  }

  return hours + "h " + minutes + "m";
}

function nextCyclePlan() {
  var eligible = state.books.filter(function (b) {
    return !isLive(b) && !b.released && b.stage !== "Publishing" && !b.issues.length;
  });

  eligible.sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    if (a.queued !== b.queued) return a.queued ? -1 : 1;
    return progressOf(b) - progressOf(a);
  });

  return eligible.slice(0, clamp(toInt(state.schedule.batch, 3), 1, 20));
}

/* ---------------------------------------------------------
   Production engine
   --------------------------------------------------------- */

function eligibleJobs() {
  return state.books
    .filter(function (b) { return b.queued && !isLive(b) && !b.released && b.stage !== "Publishing" && !b.issues.length; })
    .sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
      return a.updatedAt - b.updatedAt;
    });
}

function addIssue(book, text, severity) {
  var exists = book.issues.some(function (i) { return i.text === text; });
  if (exists) return;
  book.issues.push({ id: uid("is"), text: text, severity: severity || "bad" });
}

function runQA(book) {
  var ratio = book.words.target ? book.words.done / book.words.target : 1;

  if (book.chapters.done < book.chapters.total) {
    addIssue(book, "QA: " + (book.chapters.total - book.chapters.done) + " chapter(s) still undrafted", "bad");
  }

  if (ratio < 0.75) {
    addIssue(book, "QA: word count " + Math.round(ratio * 100) + "% of target", "warn");
  }

  if (!metadataComplete(book)) {
    addIssue(book, "QA: metadata incomplete (needs series, author and a description)", "warn");
  }
}

/** Advance a single book by one unit of work. Returns a log line, or null. */
function stepBook(book) {
  if (isLive(book) || book.issues.length || book.released || book.stage === "Publishing") return null;

  if (book.stage === "Chapters" && book.chapters.done < book.chapters.total) {
    book.chapters.done += 1;

    var perChapter = book.chapters.total
      ? Math.round(book.words.target / book.chapters.total)
      : 0;

    book.words.done = clamp(book.words.done + perChapter, 0, book.words.target || Infinity);
    touch(book);

    return book.title + ": drafted chapter " + book.chapters.done + " of " + book.chapters.total;
  }

  var next = STAGES[stageIndex(book.stage) + 1];
  if (!next) return null;

  book.stage = next;
  touch(book);

  if (next === "QA" && state.schedule.autoQA) {
    runQA(book);

    if (book.issues.length) {
      return book.title + ": QA raised " + book.issues.length + " blocker(s)";
    }
  }

  if (next === "Packaging" && !state.schedule.autoPackage) {
    book.queued = false;
    return book.title + ": reached Packaging, auto-packaging is off";
  }

  if (next === "Publishing") {
    book.queued = false;
    return book.title + ": reached Publishing and is ready for release";
  }

  return book.title + ": advanced to " + next;
}

function stepProduction(silent) {
  var jobs = eligibleJobs();

  if (!jobs.length) {
    if (!silent) toast("No eligible jobs. Queue a book from the library first.", "warn");
    stopRun();
    return false;
  }

  var line = stepBook(jobs[0]);

  if (line) {
    log("production", line);
    if (!silent) toast(line);
  }

  save();
  render();
  return true;
}

function startRun() {
  if (ui.running) return;

  if (!eligibleJobs().length) {
    toast("Nothing is queued — add books to the queue to start a run.", "warn");
    return;
  }

  ui.running = true;
  log("system", "Production run started.");
  runTimer = setInterval(function () { stepProduction(true); }, 1100);
  save();
  render();
  toast("Production run started.", "ok");
}

function stopRun() {
  if (!ui.running) return;

  ui.running = false;
  if (runTimer) clearInterval(runTimer);
  runTimer = null;
  log("system", "Production run stopped.");
  save();
  render();
}

function toggleRun() {
  if (ui.running) {
    stopRun();
    toast("Production queue paused.");
  } else {
    startRun();
  }
}

/* ---------------------------------------------------------
   Toasts
   --------------------------------------------------------- */

function toast(message, kind) {
  var host = $("toasts");
  if (!host) return;

  var node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  host.appendChild(node);

  while (host.children.length > 4) host.removeChild(host.firstChild);

  setTimeout(function () {
    if (node.parentNode) node.parentNode.removeChild(node);
  }, 3600);
}

/* ---------------------------------------------------------
   Routing
   --------------------------------------------------------- */

var PAGES = {
  dashboard: ["Publisher Command Center", "Autonomous publishing operations"],
  library: ["Master Library", "Your complete publishing portfolio"],
  production: ["Production Queue", "Manage autonomous book production"],
  scheduler: ["Smart Scheduler", "Automated production scheduling"],
  blueprints: ["Blueprint Engine", "Reusable book production blueprints"],
  memory: ["Continuity Memory", "Cross-book facts and series consistency"],
  publishing: ["Publishing Center", "Packaging, validation and release"],
  analytics: ["Analytics", "Portfolio and production intelligence"],
  settings: ["System Settings", "Book Factory configuration"]
};

function openPage(page, options) {
  if (!PAGES[page]) page = "dashboard";
  ui.page = page;

  Object.keys(PAGES).forEach(function (id) {
    var section = $(id);
    if (!section) return;
    var active = id === page;
    section.classList.toggle("active", active);
    section.hidden = !active;
  });

  Array.prototype.forEach.call(document.querySelectorAll("#nav button[data-page]"), function (button) {
    if (button.dataset.page === page) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  $("pageTitle").textContent = PAGES[page][0];
  $("pageSubtitle").textContent = PAGES[page][1];

  $("sidebar").classList.remove("open");
  $("menuToggle").setAttribute("aria-expanded", "false");

  if (location.hash !== "#/" + page) {
    if (options && options.replace) {
      location.replace("#/" + page);
    } else {
      location.hash = "#/" + page;
    }
  }

  render();

  if (!options || !options.keepScroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function pageFromHash() {
  var page = String(location.hash || "").replace(/^#\/?/, "");
  return PAGES[page] ? page : "dashboard";
}

/* ---------------------------------------------------------
   Rendering — shared fragments
   --------------------------------------------------------- */

function metricCard(label, value, note) {
  return '<div class="card">' +
    '<div class="label">' + escapeHTML(label) + "</div>" +
    '<div class="metric">' + escapeHTML(value) + "</div>" +
    '<div class="muted small">' + escapeHTML(note) + "</div>" +
    "</div>";
}

function statRow(label, valueHTML) {
  return '<div class="stat-row"><span>' + escapeHTML(label) + "</span>" + valueHTML + "</div>";
}

function pill(text, kind) {
  return '<span class="pill ' + (kind || "") + '">' + escapeHTML(text) + "</span>";
}

function progressBar(pct, ok) {
  return '<div class="progress' + (ok ? " ok" : "") + '" role="progressbar" aria-valuenow="' + pct +
    '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct + '%"></i></div>';
}

function pipelineHTML(currentStage, released) {
  var current = stageIndex(currentStage);

  return STAGES.map(function (stage, i) {
    var cls = "stage";
    if (released || i < current) cls += " done";
    else if (i === current) cls += " current";

    return '<div class="' + cls + '"><b>' + String(i + 1).padStart(2, "0") + "</b>" + escapeHTML(stage) + "</div>";
  }).join("");
}

function emptyRow(colspan, message) {
  return '<tr><td colspan="' + colspan + '" class="empty">' + escapeHTML(message) + "</td></tr>";
}

/* ---------------------------------------------------------
   Rendering — pages
   --------------------------------------------------------- */

function render() {
  renderChrome();

  switch (ui.page) {
    case "dashboard": renderDashboard(); break;
    case "library": renderLibrary(); break;
    case "production": renderProduction(); break;
    case "scheduler": renderScheduler(); break;
    case "blueprints": renderBlueprints(); break;
    case "memory": renderMemory(); break;
    case "publishing": renderPublishing(); break;
    case "analytics": renderAnalytics(); break;
    case "settings": renderSettings(); break;
  }
}

function renderCatalogueBanner() {
  var banner = $("catalogueBanner");
  if (!banner) return;

  var show = state.catalogueMerged && !ui.bannerDismissed;
  banner.hidden = !show;
  if (!show) return;

  var live = state.books.filter(isLive).length;
  $("catalogueBannerText").textContent =
    "Your stored library predated the catalogue update, so published titles were " +
    "showing as work in progress. It has been merged: " + live + " of " +
    state.books.length + " titles are now marked on sale, and anything you had " +
    "edited was kept.";
}

function renderChrome() {
  renderCatalogueBanner();
  var s = summary();

  $("navCountLibrary").textContent = s.total;
  $("navCountProduction").textContent = state.books.filter(function (b) { return !isLive(b); }).length;
  $("navCountPublishing").textContent = s.passing;

  $("runState").textContent = ui.running ? "RUNNING" : (s.counts.BLOCKED ? "ATTENTION" : "IDLE");

  var runToggle = $("runToggle");
  runToggle.textContent = ui.running ? "⏸ Pause production" : "▶ Run production";

  var queueToggle = $("queueToggle");
  if (queueToggle) queueToggle.textContent = ui.running ? "Pause queue" : "Start queue";

  $("appVersionTag").textContent = "v" + APP_VERSION;

  renderStorageState();
}

function renderStorageState() {
  var node = $("storageState");
  if (!node) return;
  node.textContent = storageWorks ? "Local persistence active" : "Local persistence unavailable";
}

function renderDashboard() {
  var s = summary();
  var next = nextRunAt(state.schedule);

  $("dashboardMetrics").innerHTML = [
    metricCard("Catalogue", String(s.total),
      s.counts.LIVE + " on sale · " + s.counts.PIPELINE + " in pipeline · " + s.counts.READY + " ready"),
    metricCard("Queued jobs", String(s.queued), ui.running ? "Run in progress" : "Queue idle"),
    metricCard("Next cycle", state.schedule.enabled && next ? countdown(next) : "OFF",
      state.schedule.enabled && next ? state.schedule.time + " " + state.schedule.zone : "Scheduler disabled"),
    metricCard("QA blockers", String(s.counts.BLOCKED), s.counts.BLOCKED ? "Needs review" : "All clear")
  ].join("");

  var focus =
    eligibleJobs()[0] ||
    state.books.filter(function (b) { return !isLive(b) && !b.released; })[0];

  $("dashboardPipeline").innerHTML = focus
    ? pipelineHTML(focus.stage, focus.released)
    : pipelineHTML("Brief", false);

  $("pipelineSummary").textContent = focus
    ? "Tracking " + focus.title + " — stage " + focus.stage + " (" + progressOf(focus) + "%)"
    : s.counts.LIVE === s.total && s.total > 0
      ? "Every title in the catalogue is on sale. Add a new book to start production."
      : "No active book. Add one from the library or a blueprint.";

  var blocked = s.counts.BLOCKED;

  $("healthRows").innerHTML = [
    statRow("Orchestrator", pill(ui.running ? "RUNNING" : "ONLINE", ui.running ? "blue" : "ok")),
    statRow("Blueprint engine", pill("ONLINE", "ok")),
    statRow("Memory engine", pill(state.facts.length + " FACTS", "ok")),
    statRow("QA engine", pill(blocked ? blocked + " REVIEW" : "CLEAR", blocked ? "warn" : "ok")),
    statRow("Average progress", "<strong>" + s.avgProgress + "%</strong>"),
    statRow("Words drafted", "<strong>" + formatNumber(s.words) + " / " + formatNumber(s.target) + "</strong>")
  ].join("");

  var artifacts = { epub: 0, pdf: 0, metadata: 0, zip: 0 };

  state.books.forEach(function (book) {
    var p = packageState(book);
    if (p.epub === "READY") artifacts.epub += 1;
    if (p.pdf === "READY") artifacts.pdf += 1;
    if (p.metadata === "READY") artifacts.metadata += 1;
    if (p.zip === "READY") artifacts.zip += 1;
  });

  $("readinessRows").innerHTML = [
    statRow("EPUB ready", "<strong>" + artifacts.epub + " / " + s.total + "</strong>"),
    statRow("PDF ready", "<strong>" + artifacts.pdf + " / " + s.total + "</strong>"),
    statRow("Metadata complete", "<strong>" + artifacts.metadata + " / " + s.total + "</strong>"),
    statRow("Packages validated", pill(s.passing + " PASS", s.passing ? "ok" : "warn")),
    statRow("Titles on sale", "<strong>" + s.counts.LIVE + "</strong>")
  ].join("");

  var jobs = state.books
    .filter(function (b) { return !isLive(b); })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
    .slice(0, 6);

  $("recentJobs").innerHTML = jobs.length
    ? jobs.map(function (book) {
        var status = statusOf(book);
        return "<tr>" +
          "<td>" + escapeHTML(book.title) + '<div class="small muted">' + escapeHTML(book.series) + "</div></td>" +
          "<td>" + escapeHTML(book.stage) + "</td>" +
          '<td style="min-width:130px">' + progressBar(progressOf(book), status === "READY" || status === "RELEASED") +
            '<div class="small muted">' + progressOf(book) + "%</div></td>" +
          "<td>" + pill(status, statusClass(status)) + "</td>" +
          '<td><button type="button" class="btn tiny" data-action="view-book" data-id="' + escapeHTML(book.id) + '">Open</button></td>' +
          "</tr>";
      }).join("")
    : emptyRow(
        5,
        state.books.length
          ? "Nothing in production — every title is on sale."
          : "No books yet — add one to get started.",
      );

  $("activityFeed").innerHTML = state.activity.length
    ? state.activity.slice(0, 12).map(function (entry) {
        return "<li><time datetime=\"" + new Date(entry.at).toISOString() + "\">" + formatTime(entry.at) + "</time>" +
          "<span><span class=\"kind\">" + escapeHTML(entry.kind) + "</span> — " + escapeHTML(entry.message) + "</span></li>";
      }).join("")
    : '<li class="muted small">Nothing logged yet.</li>';
}

function renderLibrary() {
  var grid = $("libraryGrid");
  if (!grid) return;

  var search = ui.search.trim().toLowerCase();

  var filtered = state.books.filter(function (book) {
    var haystack = (book.title + " " + book.series + " " + book.category + " " + book.author).toLowerCase();
    if (search && haystack.indexOf(search) < 0) return false;
    if (ui.category && book.category !== ui.category) return false;
    if (ui.status && statusOf(book) !== ui.status) return false;
    return true;
  });

  filtered.sort(function (a, b) {
    if (ui.sort === "title") return a.title.localeCompare(b.title);
    if (ui.sort === "progress") return progressOf(b) - progressOf(a);
    if (ui.sort === "category") return a.category.localeCompare(b.category) || a.title.localeCompare(b.title);
    return b.updatedAt - a.updatedAt;
  });

  $("librarySummary").textContent =
    filtered.length + " of " + state.books.length + " titles · " +
    formatNumber(state.books.reduce(function (s, b) { return s + b.words.done; }, 0)) + " words drafted";

  grid.innerHTML = filtered.length
    ? filtered.map(function (book) {
        var status = statusOf(book);
        var pct = progressOf(book);
        var live = isLive(book);

        return '<article class="book-card">' +
          '<div class="spine" style="background:' + spineColor(book.category) + '"></div>' +
          '<div class="book-head">' +
            '<div><div class="book-title">' + escapeHTML(book.title) + "</div>" +
            '<div class="book-meta">' + escapeHTML(book.series) + " · " + escapeHTML(book.category) + "</div></div>" +
            pill(status, statusClass(status)) +
          "</div>" +
          '<div class="book-meta">' + escapeHTML(book.format) + " · " + book.chapters.done + "/" + book.chapters.total +
            " chapters · " + formatNumber(book.words.done) + " words</div>" +
          progressBar(pct, status === "READY" || status === "RELEASED") +
          '<div class="book-foot"><span class="small muted">' +
            (live ? "On sale" : pct + "% · " + escapeHTML(book.stage)) + "</span>" +
            '<span class="small muted">' + relativeTime(book.updatedAt) + "</span></div>" +
          (live
            ? '<div class="chips">' + liveStores(book).map(function (store) {
                var url = book.storefronts[store.id];
                return url
                  ? '<a class="chip" href="' + escapeHTML(url) + '" target="_blank" rel="noopener">' +
                      escapeHTML(store.label) + " ↗</a>"
                  : '<span class="chip">' + escapeHTML(store.label) + "</span>";
              }).join("") + "</div>"
            : "") +
          '<div class="actions">' +
            '<button type="button" class="btn tiny" data-action="view-book" data-id="' + escapeHTML(book.id) + '">View</button>' +
            '<button type="button" class="btn tiny" data-action="edit-book" data-id="' + escapeHTML(book.id) + '">Edit</button>' +
            (live
              ? ""
              : '<button type="button" class="btn tiny ' + (book.queued ? "" : "primary") + '" data-action="toggle-queue" data-id="' +
                escapeHTML(book.id) + '">' + (book.queued ? "Dequeue" : "Queue") + "</button>" +
                '<button type="button" class="btn tiny" data-action="mark-live" data-id="' + escapeHTML(book.id) + '">Mark on sale</button>') +
          "</div>" +
          "</article>";
      }).join("")
    : '<div class="card"><h3>No books match</h3><p class="muted small">Try a different search or clear the filters.</p></div>';
}

function spineColor(category) {
  var palette = {
    "Astrology": "var(--violet)",
    "Mythology": "var(--yellow)",
    "Mystery": "var(--blue)",
    "Education": "var(--green)",
    "AI / Tech": "var(--blue)",
    "Finance": "var(--green)",
    "Health": "var(--red)"
  };
  return palette[category] || "var(--muted)";
}

/**
 * A compact ten-stage strip per book, so progress is visible as position in
 * the pipeline rather than only as a percentage.
 */
function stageStrip(book) {
  var current = stageIndex(book.stage);

  return STAGES.map(function (stage, i) {
    var cls = i < current ? "stage done" : i === current ? "stage current" : "stage";
    return '<div class="' + cls + '" title="' + escapeHTML(stage) + '"><b>' +
      String(i + 1).padStart(2, "0") + "</b>" + escapeHTML(stage) + "</div>";
  }).join("");
}

function renderStageProgress() {
  var host = $("stageProgress");
  if (!host) return;

  var inProduction = state.books.filter(function (b) { return !isLive(b); });

  host.innerHTML = inProduction.length
    ? inProduction
        .sort(function (a, b) { return progressOf(b) - progressOf(a); })
        .map(function (book) {
          var pct = progressOf(book);
          return '<div style="margin-bottom:18px">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px">' +
              "<strong>" + escapeHTML(book.title) + "</strong>" +
              '<span class="small muted">' + escapeHTML(book.stage) + " · " + pct + "% · " +
                book.chapters.done + "/" + book.chapters.total + " chapters</span>" +
            "</div>" +
            '<div class="pipeline">' + stageStrip(book) + "</div>" +
            "</div>";
        }).join("")
    : '<p class="muted small">Nothing in production. Generate a book from a blueprint and its stages will appear here.</p>';
}

/** Titles genuinely still being worked on - everything not yet on sale. */
function rowsInProduction() {
  return state.books.filter(function (b) { return !isLive(b); }).length;
}

function renderProduction() {
  var s = summary();
  var jobs = eligibleJobs();

  $("productionMetrics").innerHTML = [
    metricCard("Queued", String(s.queued), jobs.length + " eligible now"),
    metricCard("Running", ui.running ? "YES" : "NO", ui.running ? "Ticking every 1.1s" : "Queue idle"),
    metricCard("Blocked", String(s.counts.BLOCKED), "Resolve blockers to resume"),
    metricCard("In production", String(rowsInProduction()), "excludes titles on sale")
  ].join("");

  $("stageLegend").textContent = STAGES.join(" → ");

  var rows = state.books.filter(function (b) { return !isLive(b); }).sort(function (a, b) {
    if (a.queued !== b.queued) return a.queued ? -1 : 1;
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return progressOf(b) - progressOf(a);
  });

  if (ui.onlyActive) rows = rows.filter(function (b) { return b.queued && !isLive(b); });

  $("productionTable").innerHTML = rows.length
    ? rows.map(function (book) {
        var status = statusOf(book);
        var pct = progressOf(book);

        return "<tr>" +
          "<td>" + escapeHTML(book.title) + '<div class="small muted">' + escapeHTML(book.category) + "</div></td>" +
          "<td>" + pill(book.priority === "high" ? "HIGH" : "NORMAL", book.priority === "high" ? "warn" : "") + "</td>" +
          "<td>" + escapeHTML(book.stage) + "</td>" +
          '<td class="nowrap">' + book.chapters.done + " / " + book.chapters.total + "</td>" +
          '<td style="min-width:140px">' + progressBar(pct, status === "READY" || status === "RELEASED") +
            '<div class="small muted">' + pct + "%</div></td>" +
          "<td>" + pill(status, statusClass(status)) + "</td>" +
          '<td class="nowrap">' +
            '<button type="button" class="btn tiny" data-action="advance-book" data-id="' + escapeHTML(book.id) + '">Advance</button> ' +
            '<button type="button" class="btn tiny" data-action="toggle-queue" data-id="' + escapeHTML(book.id) + '">' +
              (book.queued ? "Dequeue" : "Queue") + "</button>" +
          "</td>" +
          "</tr>";
      }).join("")
    : emptyRow(
        7,
        ui.onlyActive
          ? "No active jobs in the queue."
          : summary().counts.LIVE === state.books.length && state.books.length
            ? "Every title in the catalogue is on sale. Nothing is in production."
            : "The library is empty.",
      );

  renderStageProgress();
}

function renderScheduler() {
  var next = nextRunAt(state.schedule);
  var plan = nextCyclePlan();

  $("schedulerMetrics").innerHTML = [
    metricCard("Autonomous cron", state.schedule.enabled ? "ON" : "OFF", state.schedule.cadence),
    metricCard("Next run", state.schedule.enabled && next ? countdown(next) : "—",
      next ? new Date(next).toLocaleString() : "Scheduler disabled"),
    metricCard("Batch size", String(state.schedule.batch), "books per cycle"),
    metricCard(
      "Spend guard",
      "$" + state.schedule.budgetUsd,
      "per 30 days · stops at " + state.schedule.maxPending + " awaiting approval",
    )
  ].join("");

  var cadenceSelect = $("schedCadence");
  if (cadenceSelect.options.length !== Object.keys(CADENCES).length) {
    cadenceSelect.innerHTML = Object.keys(CADENCES).map(function (id) {
      return '<option value="' + id + '">' + escapeHTML(CADENCES[id].label) + "</option>";
    }).join("");
  }
  cadenceSelect.value = state.schedule.cadence;
  $("schedTime").value = state.schedule.time;
  $("schedBatch").value = state.schedule.batch;
  $("schedMaxPending").value = state.schedule.maxPending;
  $("schedBudget").value = state.schedule.budgetUsd;
  $("schedEnabled").checked = state.schedule.enabled;
  $("schedAutoQA").checked = state.schedule.autoQA;
  $("schedAutoPackage").checked = state.schedule.autoPackage;
  $("schedHandoff").checked = state.schedule.handoff;

  var zoneSelect = $("schedZone");
  if (!zoneSelect.options.length) {
    zoneSelect.innerHTML = ZONES.map(function (z) {
      return '<option value="' + z.id + '">' + escapeHTML(z.label) + "</option>";
    }).join("");
  }
  zoneSelect.value = state.schedule.zone;

  $("scheduleCommand").textContent = scheduleCommand();

  $("schedulePlan").innerHTML = plan.length
    ? plan.map(function (book, i) {
        return statRow(
          (i + 1) + ". " + book.title + " (" + book.stage + ")",
          pill(book.priority === "high" ? "HIGH" : "NORMAL", book.priority === "high" ? "warn" : "") +
          ' <span class="small muted">' + progressOf(book) + "%</span>"
        );
      }).join("")
    : '<p class="muted small">Every title is either released or blocked — nothing to schedule.</p>';
}

/**
 * The exact commands that make these settings real.
 *
 * This page designs a schedule; the engine runs it. A browser cannot write to
 * your machine's crontab, so rather than pretend the toggle above starts
 * anything, it emits the two commands that do.
 */
function scheduleCommand() {
  var sched = state.schedule;

  var args = [
    "--cadence " + sched.cadence,
    "--time " + sched.time,
    "--max-pending " + sched.maxPending,
    "--budget " + sched.budgetUsd
  ];
  if (!sched.enabled) args.push("--off");

  return [
    "cd engine",
    "node src/cli.js schedule " + args.join(" "),
    "./scripts/install-cron.sh",
    "",
    "# check what cron will decide, without waiting for it:",
    "node src/cli.js should-run"
  ].join("\n");
}

function renderBlueprints() {
  $("blueprintGrid").innerHTML = BLUEPRINTS.map(function (bp) {
    return '<div class="card">' +
      "<h3>" + escapeHTML(bp.name) + "</h3>" +
      '<p class="muted small">' + escapeHTML(bp.blurb) + "</p>" +
      '<p class="small muted">' + bp.chapters + " chapters · " + formatNumber(bp.words) + " words · " + escapeHTML(bp.format) + "</p>" +
      '<button type="button" class="btn primary" data-action="use-blueprint" data-id="' + bp.id + '">Generate book</button>' +
      "</div>";
  }).join("");

  $("blueprintPipeline").innerHTML = pipelineHTML("Blueprint", false);
}

function renderMemory() {
  var seriesMap = Object.create(null);

  state.books.forEach(function (book) {
    if (!seriesMap[book.series]) seriesMap[book.series] = { books: 0, facts: 0 };
    seriesMap[book.series].books += 1;
  });

  state.facts.forEach(function (fact) {
    var book = state.books.filter(function (b) { return b.id === fact.bookId; })[0];
    if (book && seriesMap[book.series]) seriesMap[book.series].facts += 1;
  });

  var seriesNames = Object.keys(seriesMap);

  // Continuity only means something across a series, so count multi-title
  // series separately from standalones.
  var multi = seriesNames.filter(function (name) { return seriesMap[name].books > 1; });
  var standalone = seriesNames.length - multi.length;
  var linked = state.facts.filter(function (f) { return f.bookId; }).length;

  $("memoryMetrics").innerHTML = [
    metricCard("Continuity facts", String(state.facts.length), linked + " bound to a title"),
    metricCard("Series bibles", String(multi.length), standalone + " standalone title(s)"),
    metricCard(
      "Largest series",
      multi.length
        ? String(Math.max.apply(null, multi.map(function (n) { return seriesMap[n].books; })))
        : "—",
      multi.length ? "titles to keep consistent" : "no multi-book series yet",
    ),
    metricCard("Books covered", String(new Set(state.facts.map(function (f) { return f.bookId; }).filter(Boolean)).size) + " / " + state.books.length, "have at least one fact")
  ].join("");

  var select = $("factBook");
  var previous = select.value;

  select.innerHTML = '<option value="">Unassigned</option>' + state.books.map(function (book) {
    return '<option value="' + escapeHTML(book.id) + '">' + escapeHTML(book.title) + "</option>";
  }).join("");

  if (previous) select.value = previous;

  $("factsTable").innerHTML = state.facts.length
    ? state.facts.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).map(function (fact) {
        var book = state.books.filter(function (b) { return b.id === fact.bookId; })[0];

        return "<tr>" +
          "<td>" + escapeHTML(fact.text) + "</td>" +
          "<td>" + escapeHTML(book ? book.title : "—") + "</td>" +
          "<td>" + escapeHTML(book ? book.series : "—") + "</td>" +
          '<td class="nowrap small muted">' + formatDate(fact.createdAt) + "</td>" +
          '<td><button type="button" class="btn tiny danger" data-action="delete-fact" data-id="' + escapeHTML(fact.id) + '">Remove</button></td>' +
          "</tr>";
      }).join("")
    : emptyRow(5, "No continuity facts recorded yet.");

  $("seriesRows").innerHTML = seriesNames.length
    ? seriesNames
        .sort(function (a, b) { return seriesMap[b].books - seriesMap[a].books || a.localeCompare(b); })
        .map(function (name) {
          var entry = seriesMap[name];
          var needsWork = entry.books > 1 && entry.facts === 0;
          return statRow(
            name,
            "<strong>" + entry.books + " book" + (entry.books === 1 ? "" : "s") + "</strong> · " +
              entry.facts + " fact" + (entry.facts === 1 ? "" : "s") +
              (needsWork ? " " + pill("NO BIBLE", "warn") : entry.books === 1 ? ' <span class="small muted">standalone</span>' : ""),
          );
        }).join("")
    : '<p class="muted small">No series yet.</p>';
}

function renderPublishing() {
  var s = summary();

  $("publishingSummary").textContent =
    s.counts.LIVE + " of " + s.total + " titles are on sale · " +
    s.passing + " package(s) pass validation";

  $("publishingTable").innerHTML = state.books.length
    ? state.books.map(function (book) {
        var p = packageState(book);

        return "<tr>" +
          "<td>" + escapeHTML(book.title) + '<div class="small muted">' + escapeHTML(book.format) + "</div></td>" +
          "<td>" + pill(p.epub, artifactClass(p.epub)) + "</td>" +
          "<td>" + pill(p.pdf, artifactClass(p.pdf)) + "</td>" +
          "<td>" + pill(p.metadata, artifactClass(p.metadata)) + "</td>" +
          "<td>" + pill(p.zip, artifactClass(p.zip)) + "</td>" +
          "<td>" + pill(isLive(book) ? "ON SALE" : book.released ? "RELEASED" : p.validator,
            isLive(book) || book.released ? "ok" : artifactClass(p.validator)) + "</td>" +
          '<td class="small muted">' + (p.blockers.length ? escapeHTML(p.blockers.join("; ")) : "None") + "</td>" +
          "</tr>";
      }).join("")
    : emptyRow(7, "No packages to validate.");

  var report = state.lastValidation;

  $("validatorReport").innerHTML = report
    ? '<p class="small muted">Last run ' + escapeHTML(new Date(report.at).toLocaleString()) + "</p>" +
      statRow("Passing packages", pill(report.pass + " PASS", "ok")) +
      statRow("Needs review", pill(report.review + " REVIEW", report.review ? "warn" : "ok")) +
      statRow("Not ready", pill(report.pending + " PENDING", "")) +
      (report.notes.length
        ? '<ul class="feed">' + report.notes.map(function (n) { return "<li><span>" + escapeHTML(n) + "</span></li>"; }).join("") + "</ul>"
        : "")
    : '<p class="muted small">Run the validator to produce a report.</p>';
}

/**
 * Analytics for a catalogue that mostly already exists.
 *
 * The previous version measured the wrong things. It charted production events
 * per day, which is permanently zero for books that are written and on sale;
 * and it multiplied word counts by an API rate to produce a "cost" for books
 * the author wrote themselves, then subtracted that fiction from revenue to
 * get a fictional margin.
 *
 * What is actually true and actionable here is distribution: which titles are
 * on which storefronts, and - the cheapest revenue available - which finished
 * books are not yet listed somewhere they could be.
 */
function renderAnalytics() {
  var books = state.books;
  var live = books.filter(isLive);

  // Coverage per store. Single series, so no legend - the title names it.
  var coverage = STORES.map(function (store) {
    var titles = books.filter(function (b) {
      return (b.liveOn || []).indexOf(store.id) >= 0 || (b.storefronts || {})[store.id];
    });
    return { store: store, count: titles.length };
  });

  var listings = coverage.reduce(function (sum, c) { return sum + c.count; }, 0);
  var revenue = books.reduce(function (sum, b) { return sum + (Number(b.revenue) || 0); }, 0);

  // A gap is a finished book missing from a store. Only stores that carry at
  // least one of your titles count - suggesting a storefront you have never
  // used is noise, not a gap.
  var usedStores = coverage.filter(function (c) { return c.count > 0; }).map(function (c) { return c.store; });
  var gaps = booksWithGaps();

  var gapCount = gaps.reduce(function (sum, row) { return sum + row.missing.length; }, 0);

  var tiles = [
    { key: "onsale", label: "Titles on sale", value: String(live.length), note: books.length + " written in total" },
    { key: "listings", label: "Storefront listings", value: String(listings),
      note: "across " + usedStores.length + " store(s)" },
    // The gaps table below already answers this one in more detail than a
    // drill could, so the tile jumps to it rather than printing it twice.
    { key: "gaps", label: "Distribution gaps", value: String(gapCount), jump: "gapsCard",
      note: gapCount ? "finished books not yet listed" : "every title is everywhere" },
    { key: "revenue", label: "Revenue recorded", value: formatMoney(revenue),
      // Where the money came from matters as much as the figure: a total that
      // says "entered by hand" when it came off a KDP report is a small lie
      // that makes the whole page harder to trust.
      note: revenue ? revenueSourceNote(books) : "none yet — import a report below" }
  ];

  $("analyticsMetrics").innerHTML = tiles.map(function (tile) {
    var selected = ui.drill && ui.drill.type === "metric" && ui.drill.key === tile.key;
    var hook = tile.jump
      ? 'data-jump="' + escapeHTML(tile.jump) + '"'
      : 'data-drill="metric" data-key="' + escapeHTML(tile.key) +
        '" data-label="' + escapeHTML(tile.label) +
        '" aria-pressed="' + (selected ? "true" : "false") + '"';
    return '<button type="button" class="card clickable" ' + hook + ">" +
      '<div class="label">' + escapeHTML(tile.label) + "</div>" +
      '<div class="metric">' + escapeHTML(tile.value) + "</div>" +
      '<div class="muted small">' + escapeHTML(tile.note) + "</div>" +
      "</button>";
  }).join("");

  var coverageMax = Math.max.apply(null, coverage.map(function (c) { return c.count; }).concat([1]));

  $("coverageBars").innerHTML = coverage.map(function (c) {
    var selected = ui.drill && ui.drill.type === "store" && ui.drill.key === c.store.id;
    return '<button type="button" class="bars-row" data-drill="store" data-key="' +
      escapeHTML(c.store.id) + '" data-label="' + escapeHTML(c.store.label) +
      '" aria-pressed="' + (selected ? "true" : "false") + '">' +
      "<span>" + escapeHTML(c.store.label) + "</span>" +
      '<span class="bars-track"><span class="bars-fill" style="width:' +
        Math.round((c.count / coverageMax) * 100) + '%"></span></span>' +
      '<span class="num">' + c.count + "</span></button>";
  }).join("");

  var byCategory = Object.create(null);
  books.forEach(function (book) {
    byCategory[book.category] = (byCategory[book.category] || 0) + 1;
  });

  var categories = Object.keys(byCategory).sort(function (a, b) { return byCategory[b] - byCategory[a]; });
  var catMax = Math.max.apply(null, categories.map(function (c) { return byCategory[c]; }).concat([1]));

  $("categoryBars").innerHTML = categories.length
    ? categories.map(function (name) {
        var selected = ui.drill && ui.drill.type === "category" && ui.drill.key === name;
        return '<button type="button" class="bars-row" data-drill="category" data-key="' +
          escapeHTML(name) + '" data-label="' + escapeHTML(name) +
          '" aria-pressed="' + (selected ? "true" : "false") + '">' +
          "<span>" + escapeHTML(name) + "</span>" +
          '<span class="bars-track"><span class="bars-fill" style="width:' +
            Math.round((byCategory[name] / catMax) * 100) + '%"></span></span>' +
          '<span class="num">' + byCategory[name] + "</span></button>";
      }).join("")
    : '<p class="muted small">No categories yet.</p>';

  $("gapsTable").innerHTML = gaps.length
    ? gaps.map(function (row) {
        return "<tr>" +
          "<td>" + escapeHTML(row.book.title) + "</td>" +
          "<td>" + row.on.map(function (s) { return pill(s.label, "ok"); }).join(" ") + "</td>" +
          "<td>" + row.missing.map(function (s) { return pill(s.label, "warn"); }).join(" ") + "</td>" +
          '<td class="nowrap">' + (row.book.listPriceUsd ? formatMoney(row.book.listPriceUsd) : "—") +
            (row.book.prices && row.book.prices.amazon && row.book.prices.amazon !== row.book.listPriceUsd
              ? '<br><span class="small muted">' + formatMoney(row.book.prices.amazon) + " on Amazon</span>"
              : "") + "</td>" +
          "</tr>";
      }).join("")
    : emptyRow(
        4,
        live.length
          ? "No gaps — every title on sale is listed on every store you use."
          : "Nothing is marked on sale yet. Mark a title in the library and gaps will appear here.",
      );

  renderListingMatrix(books);
  renderPricing(books);
  renderDrill();

  var others = otherCurrencyTotals(books);
  var otherCodes = Object.keys(others);

  $("revenueNote").textContent = (revenue
    ? "Figures with a storefront beside them came from a report you imported; the rest were typed by hand. " +
      "Amazon and Google publish no sales API, so those two stay a file you export."
    : "No revenue yet. Amazon and Google publish no sales API, so import a report above; " +
      "Gumroad can be pulled with `node src/cli.js gumroad-list`, or enter figures by hand in the editor.") +
    (otherCodes.length
      ? " Not included, because the dashboard totals USD: " +
        otherCodes.map(function (code) { return others[code].toFixed(2) + " " + code; }).join(", ") + "."
      : "");

  var sellable = live.length ? live : books;

  $("revenueTable").innerHTML = sellable.length
    ? sellable
        .slice()
        .sort(function (a, b) { return (b.revenue || 0) - (a.revenue || 0) || a.title.localeCompare(b.title); })
        .map(function (book) {
          var stores = liveStores(book);
          return "<tr>" +
            "<td>" + escapeHTML(book.title) + "</td>" +
            '<td class="small muted">' + (stores.length ? escapeHTML(stores.map(function (s) { return s.label; }).join(", ")) : "not on sale") + "</td>" +
            '<td class="nowrap">' + (book.listPriceUsd ? formatMoney(book.listPriceUsd) : "—") + "</td>" +
            '<td class="nowrap">' + (unitsSold(book) || '<span class="muted">—</span>') + "</td>" +
            '<td class="nowrap">' + (book.revenue ? formatMoney(book.revenue) : '<span class="muted">—</span>') + "</td>" +
            '<td class="small muted">' + escapeHTML(revenueProvenance(book)) + "</td>" +
            "</tr>";
        }).join("")
    : emptyRow(6, "No titles yet.");
}

/** "from Amazon / KDP", "from 2 storefronts", or "entered by hand". */
function revenueSourceNote(books) {
  var sources = [];
  books.forEach(function (book) {
    (book.sales || []).forEach(function (row) {
      if (row.currency !== "USD" || !row.amount) return;
      var label = sourceLabel(row.source);
      if (sources.indexOf(label) === -1) sources.push(label);
    });
  });

  if (!sources.length) return "entered by hand";
  if (sources.length === 1) return "imported from " + sources[0];
  return "imported from " + sources.length + " storefronts";
}

function unitsSold(book) {
  return (book.sales || []).reduce(function (sum, row) { return sum + row.units; }, 0);
}

/**
 * Where a revenue figure came from.
 *
 * The difference between "Amazon said so" and "somebody typed it" is the whole
 * point of the import, and a number with no provenance is the reason the page
 * could not be trusted before.
 */
function revenueProvenance(book) {
  var sales = book.sales || [];
  if (!sales.length) return book.revenue ? "entered by hand" : "—";

  var sources = [];
  sales.forEach(function (row) {
    var label = sourceLabel(row.source);
    if (sources.indexOf(label) === -1) sources.push(label);
  });

  var periods = sales.map(function (row) { return row.period; }).filter(Boolean);
  return sources.join(", ") + (periods.length ? " · " + periods[0] : "");
}

/** Every title against every storefront, as a plain yes/no grid. */
function renderListingMatrix(books) {
  var host = $("listingMatrix");
  if (!host) return;

  var head = "<thead><tr><th>Title</th>" +
    STORES.map(function (store) { return "<th>" + escapeHTML(store.label) + "</th>"; }).join("") +
    "</tr></thead>";

  var rows = books
    .slice()
    .sort(function (a, b) { return liveStores(b).length - liveStores(a).length || a.title.localeCompare(b.title); })
    .map(function (book) {
      var on = liveStores(book).map(function (s) { return s.id; });
      return "<tr><td>" + escapeHTML(book.title) + "</td>" +
        STORES.map(function (store) {
          var url = (book.storefronts || {})[store.id];
          if (on.indexOf(store.id) >= 0) {
            return "<td>" + (url
              ? '<a href="' + escapeHTML(url) + '" target="_blank" rel="noopener">' + pill("LISTED", "ok") + "</a>"
              : pill("LISTED", "ok")) + "</td>";
          }
          return '<td><span class="small muted">—</span></td>';
        }).join("") +
        "</tr>";
    }).join("");

  host.innerHTML = head + "<tbody>" +
    (rows || emptyRow(STORES.length + 1, "No titles yet.")) + "</tbody>";
}

/**
 * Pricing and break-even, per title per store it is on.
 *
 * Break-even is measured against what a book costs to PRODUCE with this
 * engine - roughly a dollar of model time plus a cover. For books written by
 * hand the figure is not meaningful, so it is only shown where a production
 * cost is actually recorded, and the note says so.
 */
function renderPricing(books) {
  var host = $("pricingTable");
  if (!host) return;

  var ENGINE_COST = 1.5; // ~$1 of batched model time, plus a little slack.
  var rows = [];
  var penalised = 0;

  books.forEach(function (book) {
    var stores = liveStores(book);
    if (!stores.length) return;

    stores.forEach(function (store) {
      var price = priceFor(book, store.id);
      if (!price) return;

      var advice = priceAdvice(store.id, price);
      var cost = Number(book.productionCostUsd) || (book.generated ? ENGINE_COST : 0);
      var breakEven = advice.current.net > 0 && cost
        ? Math.ceil(cost / advice.current.net)
        : null;

      if (advice.current.penalised) penalised += 1;

      rows.push(
        "<tr>" +
          "<td>" + escapeHTML(book.title) + "</td>" +
          '<td class="small muted">' + escapeHTML(store.label) + "</td>" +
          '<td class="nowrap">' + formatMoney(price) + "</td>" +
          "<td>" + pill(
            Math.round(advice.current.rate * 100) + "%",
            advice.current.penalised ? "warn" : "ok",
          ) + "</td>" +
          '<td class="nowrap">' + formatMoney(advice.current.net) + "</td>" +
          '<td class="nowrap">' + (breakEven
            ? breakEven + " sale" + (breakEven === 1 ? "" : "s")
            : '<span class="muted small">cost not recorded</span>') + "</td>" +
          '<td class="small">' + (advice.better
            ? formatMoney(advice.better.price) + " would net " + formatMoney(advice.better.net) +
              ' <span class="muted">(+' + formatMoney(advice.better.gain) + "/sale)</span>"
            : '<span class="muted">already optimal</span>') + "</td>" +
        "</tr>",
      );
    });
  });

  host.innerHTML = rows.length ? rows.join("") : emptyRow(7, "No priced titles on sale yet.");

  $("pricingNote").textContent = penalised
    ? penalised + " listing(s) are priced outside Amazon's $2.99–$9.99 band, where the royalty " +
      "drops from 70% to 35% — so a higher price earns less per sale until it is roughly doubled. " +
      "Break-even counts sales needed to cover production; it only appears for books this engine made."
    : "Royalty rates are the planning figures from your ledger: Amazon 70% inside the $2.99–$9.99 " +
      "band and 35% outside it, Gumroad 85%, Google Play 70%. Break-even only appears for books " +
      "this engine produced, since it is measured against their production cost.";
}

/**
 * Drill-down.
 *
 * Bars and metric tiles are real buttons, so a reader reaches the breakdown by
 * keyboard as readily as by pointer, and the whole row is the hit target rather
 * than the painted pixels. Selecting the same row again closes it.
 *
 * Book titles are user-entered, so every one is written with textContent rather
 * than concatenated into markup.
 */
function toggleDrill(type, key, label) {
  var open = ui.drill && ui.drill.type === type && ui.drill.key === key;
  ui.drill = open ? null : { type: type, key: key, label: label };
  renderAnalytics();

  if (!open) {
    var host = $(type === "category" ? "categoryDrill" : type === "store" ? "coverageDrill" : "metricDrill");
    if (host) host.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** A table of books, built as DOM so titles never pass through innerHTML. */
function drillTable(books, columns) {
  var table = document.createElement("table");
  table.className = "table";

  var thead = document.createElement("thead");
  var headRow = document.createElement("tr");
  columns.forEach(function (col) {
    var th = document.createElement("th");
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  var tbody = document.createElement("tbody");

  if (!books.length) {
    var empty = document.createElement("tr");
    var td = document.createElement("td");
    td.colSpan = columns.length;
    td.className = "empty";
    td.textContent = "Nothing here yet.";
    empty.appendChild(td);
    tbody.appendChild(empty);
  }

  books.forEach(function (book) {
    var tr = document.createElement("tr");
    columns.forEach(function (col) {
      var td = document.createElement("td");
      var value = col.value(book);
      if (value instanceof Node) td.appendChild(value);
      else td.textContent = value == null ? "—" : String(value);
      if (col.nowrap) td.className = "nowrap";
      tr.appendChild(td);
    });

    // The whole row opens the book, so a drill-down ends somewhere useful.
    tr.style.cursor = "pointer";
    tr.title = "Open " + book.title;
    tr.addEventListener("click", function () { viewBook(book.id); });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  var wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.appendChild(table);
  return wrap;
}

function renderDrill() {
  ["coverageDrill", "categoryDrill", "metricDrill"].forEach(function (id) {
    var host = $(id);
    if (host) { host.hidden = true; host.innerHTML = ""; }
  });

  if (!ui.drill) return;

  var drill = ui.drill;
  var host = $(drill.type === "category" ? "categoryDrill" : drill.type === "store" ? "coverageDrill" : "metricDrill");
  if (!host) return;

  var books = drillBooks(drill);

  var head = document.createElement("div");
  head.className = "drill-head";

  var title = document.createElement("strong");
  title.textContent = drill.label + " — " + books.length + " title" + (books.length === 1 ? "" : "s");
  head.appendChild(title);

  var close = document.createElement("button");
  close.type = "button";
  close.className = "btn tiny ghost";
  close.textContent = "Close";
  close.addEventListener("click", function () { ui.drill = null; renderAnalytics(); });
  head.appendChild(close);

  host.appendChild(head);
  host.appendChild(drillTable(books, drillColumns(drill)));
  host.hidden = false;
}

function drillBooks(drill) {
  var books = state.books;

  if (drill.type === "store") {
    return books.filter(function (b) {
      return liveStores(b).some(function (s) { return s.id === drill.key; });
    });
  }

  if (drill.type === "category") {
    return books.filter(function (b) { return b.category === drill.key; });
  }

  if (drill.key === "onsale") return books.filter(isLive);
  // A listing belongs to a book, so the breakdown is per title, with the
  // widest-distributed first - that is the shape of the question "where am I
  // actually on sale?".
  if (drill.key === "listings") {
    return books.filter(isLive).sort(function (a, b) {
      return liveStores(b).length - liveStores(a).length;
    });
  }
  if (drill.key === "gaps") return booksWithGaps().map(function (row) { return row.book; });
  if (drill.key === "revenue") {
    return books.filter(function (b) { return Number(b.revenue) > 0; })
      .sort(function (a, b) { return b.revenue - a.revenue; });
  }
  return [];
}

function drillColumns(drill) {
  if (drill.type === "store") {
    var storeId = drill.key;
    return [
      { label: "Title", value: function (b) { return b.title; } },
      { label: "Price here", nowrap: true, value: function (b) { return formatMoney(priceFor(b, storeId)); } },
      { label: "Royalty", nowrap: true, value: function (b) {
          return Math.round(netPerSale(storeId, priceFor(b, storeId)).rate * 100) + "%";
        } },
      { label: "Net per sale", nowrap: true, value: function (b) {
          return formatMoney(netPerSale(storeId, priceFor(b, storeId)).net);
        } },
      { label: "Revenue", nowrap: true, value: function (b) { return b.revenue ? formatMoney(b.revenue) : "—"; } },
    ];
  }

  return [
    { label: "Title", value: function (b) { return b.title; } },
    { label: "Category", value: function (b) { return b.category; } },
    { label: "On sale at", value: function (b) {
        var stores = liveStores(b);
        return stores.length ? stores.map(function (s) { return s.label; }).join(", ") : "not on sale";
      } },
    { label: "List price", nowrap: true, value: function (b) {
        return b.listPriceUsd ? formatMoney(b.listPriceUsd) : "—";
      } },
  ];
}

/**
 * Imported sales.
 *
 * A row is one storefront's word on one title for one period. Keeping the rows
 * rather than only a total is what makes an import repeatable: re-importing
 * August replaces August instead of adding it twice, and you can see which
 * number came from where.
 */
function normaliseSales(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map(function (row) {
    return {
      source: String(row.source || "other"),
      period: String(row.period || ""),
      units: toInt(row.units, 0),
      amount: toNum(row.amount, 0),
      currency: String(row.currency || "USD").toUpperCase().slice(0, 3),
      at: toInt(row.at, Date.now())
    };
  });
}

/**
 * The dashboard reports in USD. Adding 1,240 INR to 18 GBP would produce a
 * number that is not money in any currency, so only USD rows count towards
 * revenue - and renderSalesSummary says plainly what was left out.
 */
function usdRevenue(book) {
  return (book.sales || []).reduce(function (sum, row) {
    return row.currency === "USD" ? sum + row.amount : sum;
  }, 0);
}

function otherCurrencyTotals(books) {
  var totals = Object.create(null);
  books.forEach(function (book) {
    (book.sales || []).forEach(function (row) {
      if (row.currency === "USD") return;
      totals[row.currency] = (totals[row.currency] || 0) + row.amount;
    });
  });
  return totals;
}

/**
 * Folds parsed report rows into the catalogue.
 *
 * Rows from the same storefront and period replace what was there before, so
 * importing the same file twice is a no-op rather than a doubling. Anything
 * that matches no book is returned rather than dropped - a title the dashboard
 * has never heard of is the most interesting thing in the file.
 */
function applySalesRows(rows, source) {
  var matched = [];
  var unmatched = [];
  var now = Date.now();

  rows.forEach(function (row) {
    var book = window.BookFactorySales.matchTitle(row.title, state.books);
    if (!book) { unmatched.push(row); return; }

    book.sales = (book.sales || []).filter(function (existing) {
      return !(existing.source === source && existing.period === row.period && existing.currency === row.currency);
    });
    book.sales.push({
      source: source,
      period: row.period,
      units: row.units,
      amount: row.amount,
      currency: row.currency,
      at: now
    });

    book.revenue = Math.max(0, usdRevenue(book));
    book.updatedAt = now;
    matched.push({ row: row, book: book });
  });

  return { matched: matched, unmatched: unmatched };
}

/**
 * The import preview.
 *
 * Nothing is written until you have seen what would change. A silent import is
 * how a dashboard starts lying: one mis-detected column and every figure on
 * the page is wrong, with no sign that anything happened.
 *
 * Titles come from an external file, so every one is written with textContent.
 */
var pendingImport = null;

function previewSalesFile(file) {
  var host = $("salesPreview");
  if (!host) return;

  var reader = new FileReader();
  reader.onerror = function () { showImportError("That file could not be read."); };
  reader.onload = function () {
    var parsed;
    try {
      parsed = window.BookFactorySales.parseReport(String(reader.result || ""));
    } catch (err) {
      showImportError("That file could not be parsed (" + err.message + ").");
      return;
    }

    if (parsed.error) {
      showImportError(parsed.error, parsed.header);
      return;
    }

    pendingImport = parsed;
    renderImportPreview(file.name, parsed);
  };
  reader.readAsText(file);
}

function showImportError(message, header) {
  var host = $("salesPreview");
  pendingImport = null;
  host.innerHTML = "";

  var box = document.createElement("div");
  box.className = "drill";

  var line = document.createElement("p");
  line.className = "small";
  line.textContent = message;
  box.appendChild(line);

  if (header && header.length) {
    var seen = document.createElement("p");
    seen.className = "small muted";
    seen.textContent = "Columns found: " + header.filter(Boolean).join(" · ");
    box.appendChild(seen);
  }

  var help = document.createElement("p");
  help.className = "small muted";
  help.textContent =
    "The file needs a column of book titles and a column of units or royalties. " +
    "If your download is a spreadsheet, open it and save as CSV first.";
  box.appendChild(help);

  host.appendChild(box);
  host.hidden = false;
}

function renderImportPreview(fileName, parsed) {
  var host = $("salesPreview");
  host.innerHTML = "";
  host.hidden = false;

  var matches = parsed.rows.map(function (row) {
    return { row: row, book: window.BookFactorySales.matchTitle(row.title, state.books) };
  });
  var unmatched = matches.filter(function (m) { return !m.book; });

  var box = document.createElement("div");
  box.className = "drill";

  var head = document.createElement("div");
  head.className = "drill-head";
  var strong = document.createElement("strong");
  strong.textContent = fileName + " — " + parsed.rows.length + " row" + (parsed.rows.length === 1 ? "" : "s") +
    " from " + sourceLabel(parsed.source);
  head.appendChild(strong);
  box.appendChild(head);

  // What the parser decided each column meant. If it guessed wrong, this is
  // where you see it - before anything is written.
  var storePick = document.createElement("label");
  storePick.className = "field";
  storePick.style.maxWidth = "320px";
  var storeLabel = document.createElement("span");
  storeLabel.textContent = "Storefront this report came from";
  storePick.appendChild(storeLabel);

  var select = document.createElement("select");
  select.className = "input";
  select.id = "salesSource";
  [["amazon", "Amazon / KDP"], ["play", "Google Play Books"], ["gumroad", "Gumroad"], ["other", "Other"]]
    .forEach(function (pair) {
      var option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      if (pair[0] === parsed.source) option.selected = true;
      select.appendChild(option);
    });
  storePick.appendChild(select);
  box.appendChild(storePick);

  // Re-importing a period replaces it. Say so, with the count, because the
  // alternative reading - that it adds - would mean doubled revenue.
  var replacing = countReplacedRows(parsed, parsed.source);
  var replaceNote = document.createElement("p");
  replaceNote.className = "small muted";
  replaceNote.id = "salesReplaceNote";
  replaceNote.textContent = describeReplacement(replacing);
  box.appendChild(replaceNote);

  select.addEventListener("change", function () {
    $("salesReplaceNote").textContent = describeReplacement(countReplacedRows(parsed, select.value));
  });

  var mapping = document.createElement("p");
  mapping.className = "small muted";
  mapping.textContent = "Reading: " + ["title", "units", "amount", "currency", "period"]
    .filter(function (field) { return parsed.columns[field] !== undefined; })
    .map(function (field) { return field + " = \u201c" + parsed.header[parsed.columns[field]] + "\u201d"; })
    .join(" · ");
  box.appendChild(mapping);

  var table = document.createElement("table");
  table.className = "table";
  table.appendChild(rowOf(["Title in the report", "Matches", "Units", "Amount"], "th"));

  var body = document.createElement("tbody");
  matches.forEach(function (m) {
    var tr = document.createElement("tr");
    tr.appendChild(cell(m.row.title));
    tr.appendChild(cell(m.book ? m.book.title : "no match — will be skipped"));
    tr.appendChild(cell(String(m.row.units)));
    tr.appendChild(cell(formatAmount(m.row.amount, m.row.currency)));
    if (!m.book) tr.className = "muted";
    body.appendChild(tr);
  });
  table.appendChild(body);

  var wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.appendChild(table);
  box.appendChild(wrap);

  var codes = Object.keys(parsed.currencies || {});
  if (codes.length > 1) {
    var note = document.createElement("p");
    note.className = "small";
    note.textContent = "This report pays in " + codes.join(", ") +
      ". Only the USD rows count towards revenue — the rest are recorded but not added, " +
      "because totalling different currencies would produce a number that is not money.";
    box.appendChild(note);
  }

  if (unmatched.length) {
    var miss = document.createElement("p");
    miss.className = "small";
    miss.textContent = unmatched.length + " title" + (unmatched.length === 1 ? "" : "s") +
      " in the report match nothing in your catalogue and will be skipped. " +
      "If they are yours, rename the book here to match the storefront.";
    box.appendChild(miss);
  }

  var actions = document.createElement("div");
  actions.className = "actions";

  var confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "btn primary";
  confirm.dataset.action = "apply-sales-import";
  confirm.textContent = "Import " + (parsed.rows.length - unmatched.length) + " title" +
    (parsed.rows.length - unmatched.length === 1 ? "" : "s");
  confirm.disabled = parsed.rows.length === unmatched.length;
  actions.appendChild(confirm);

  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn ghost";
  cancel.dataset.action = "cancel-sales-import";
  cancel.textContent = "Cancel";
  actions.appendChild(cancel);

  box.appendChild(actions);
  host.appendChild(box);
}

/**
 * How many already-imported rows this file would overwrite.
 *
 * Same storefront, same period, same currency means the same sales being
 * restated - so they are replaced. Anything else is new money and is added.
 */
function countReplacedRows(parsed, source) {
  var count = 0;
  parsed.rows.forEach(function (row) {
    var book = window.BookFactorySales.matchTitle(row.title, state.books);
    if (!book) return;
    (book.sales || []).forEach(function (existing) {
      if (existing.source === source && existing.period === row.period && existing.currency === row.currency) count++;
    });
  });
  return count;
}

function describeReplacement(count) {
  return count
    ? count + " row(s) already imported for this storefront and period will be replaced, not added."
    : "Nothing here has been imported before — these will be added.";
}

function rowOf(labels, tag) {
  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  labels.forEach(function (label) {
    var el = document.createElement(tag || "td");
    el.textContent = label;
    tr.appendChild(el);
  });
  thead.appendChild(tr);
  return thead;
}

function cell(text) {
  var td = document.createElement("td");
  td.textContent = text;
  return td;
}

function formatAmount(amount, currency) {
  var value = Math.round(amount * 100) / 100;
  return currency === "USD" ? formatMoney(value) : value.toFixed(2) + " " + currency;
}

function sourceLabel(source) {
  if (source === "amazon") return "Amazon / KDP";
  if (source === "play") return "Google Play Books";
  if (source === "gumroad") return "Gumroad";
  return "an unrecognised storefront";
}

function commitSalesImport() {
  if (!pendingImport) return;

  // The storefront the person confirmed, not the one the parser guessed.
  var picker = $("salesSource");
  var source = picker ? picker.value : pendingImport.source;
  var result = applySalesRows(pendingImport.rows, source);
  pendingImport = null;

  save();
  render();

  $("salesPreview").hidden = true;
  $("salesPreview").innerHTML = "";

  log(
    "import",
    "Imported " + result.matched.length + " title(s) from " + sourceLabel(source) +
      (result.unmatched.length ? ", skipped " + result.unmatched.length + " unmatched" : ""),
  );
  toast("Imported " + result.matched.length + " title(s).", "ok");
}

/** Shared by the gaps table and the gaps drill, so they cannot disagree. */
function booksWithGaps() {
  var used = STORES.filter(function (store) {
    return state.books.some(function (b) {
      return liveStores(b).some(function (s) { return s.id === store.id; });
    });
  });

  return state.books
    .filter(isLive)
    .map(function (book) {
      var on = liveStores(book);
      return {
        book: book,
        on: on,
        missing: used.filter(function (store) {
          return !on.some(function (s) { return s.id === store.id; });
        }),
      };
    })
    .filter(function (row) { return row.missing.length; })
    .sort(function (a, b) { return b.missing.length - a.missing.length; });
}

function renderSettings() {
  var s = summary();
  var bytes = 0;

  try {
    bytes = new Blob([JSON.stringify(state)]).size;
  } catch (err) {
    bytes = JSON.stringify(state).length;
  }

  $("settingsRows").innerHTML = [
    statRow("Application", "<strong>Book Factory " + APP_VERSION + "</strong>"),
    statRow("Repository", "<strong>hemantsharma0009-gif/book-factory</strong>"),
    statRow("Deployment", "<strong>Static build · Vercel</strong>"),
    statRow("Schema version", "<strong>" + state.schema + "</strong>"),
    statRow("Titles stored", "<strong>" + s.total + "</strong>"),
    statRow("Continuity facts", "<strong>" + state.facts.length + "</strong>"),
    statRow("Activity entries", "<strong>" + state.activity.length + "</strong>"),
    statRow("Local storage used", "<strong>" + (bytes / 1024).toFixed(1) + " KB</strong>"),
    statRow("Persistence", pill(storageWorks ? "ENABLED" : "UNAVAILABLE", storageWorks ? "ok" : "bad")),
    statRow("Last report", "<strong>" + (state.lastReport ? new Date(state.lastReport.at).toLocaleString() : "—") + "</strong>")
  ].join("");

  $("themeSelect").value = state.settings.theme;
}

/* ---------------------------------------------------------
   Modal
   --------------------------------------------------------- */

function openModal(title, html) {
  ui.lastFocus = document.activeElement;

  $("modalTitle").textContent = title;
  $("modalContent").innerHTML = html;

  var modal = $("modal");
  modal.hidden = false;
  modal.classList.add("show");

  var focusable = modal.querySelector("input, select, textarea, button:not(.close)");
  if (focusable) focusable.focus();
}

function closeModal() {
  var modal = $("modal");
  modal.classList.remove("show");
  modal.hidden = true;
  $("modalContent").innerHTML = "";

  if (ui.lastFocus && document.contains(ui.lastFocus)) ui.lastFocus.focus();
  ui.lastFocus = null;
}

function modalOpen() { return $("modal").classList.contains("show"); }

function trapFocus(event) {
  if (!modalOpen() || event.key !== "Tab") return;

  var nodes = Array.prototype.filter.call(
    $("modal").querySelectorAll("button, input, select, textarea, [href]"),
    function (node) { return !node.disabled && node.offsetParent !== null; }
  );

  if (!nodes.length) return;

  var first = nodes[0];
  var last = nodes[nodes.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function findBook(id) {
  return state.books.filter(function (b) { return b.id === id; })[0] || null;
}

function viewBook(id) {
  var book = findBook(id);
  if (!book) return;

  var status = statusOf(book);
  var p = packageState(book);
  var facts = state.facts.filter(function (f) { return f.bookId === book.id; });

  openModal(book.title,
    '<div class="grid">' +
      metricCard("Stage", book.stage, progressOf(book) + "% complete") +
      metricCard("Chapters", book.chapters.done + " / " + book.chapters.total, formatNumber(book.words.done) + " words") +
      metricCard("Status", status, book.priority === "high" ? "High priority" : "Normal priority") +
      metricCard("Validator", book.released ? "RELEASED" : p.validator, book.format) +
    "</div>" +

    '<div class="card section"><h3>Production pipeline</h3><div class="pipeline">' +
      pipelineHTML(book.stage, book.released) + "</div></div>" +

    '<div class="card section"><h3>Details</h3>' +
      statRow("Series", "<strong>" + escapeHTML(book.series) + "</strong>") +
      statRow("Category", "<strong>" + escapeHTML(book.category) + "</strong>") +
      statRow("Author", "<strong>" + escapeHTML(book.author) + "</strong>") +
      statRow("Word target", "<strong>" + formatNumber(book.words.target) + "</strong>") +
      statRow("Revenue", "<strong>" + formatMoney(book.revenue) + "</strong>") +
      statRow("Last updated", "<strong>" + relativeTime(book.updatedAt) + "</strong>") +
      (isLive(book)
        ? statRow(
            "On sale at",
            liveStores(book).map(function (store) {
              var url = book.storefronts[store.id];
              return url
                ? '<a href="' + escapeHTML(url) + '" target="_blank" rel="noopener">' +
                    escapeHTML(store.label) + " ↗</a>"
                : escapeHTML(store.label);
            }).join(" · "),
          )
        : "") +
      (book.description ? '<p class="small muted" style="margin-top:10px">' + escapeHTML(book.description) + "</p>" : "") +
    "</div>" +

    (book.issues.length
      ? '<div class="card section"><h3>Blockers</h3>' + book.issues.map(function (issue) {
          return statRow(issue.text,
            pill(issue.severity === "warn" ? "WARN" : "BLOCK", issue.severity === "warn" ? "warn" : "bad") +
            ' <button type="button" class="btn tiny" data-action="resolve-issue" data-id="' + escapeHTML(book.id) +
            '" data-issue="' + escapeHTML(issue.id) + '">Resolve</button>');
        }).join("") + "</div>"
      : "") +

    (facts.length
      ? '<div class="card section"><h3>Continuity facts</h3>' + facts.map(function (f) {
          return '<div class="stat-row"><span>' + escapeHTML(f.text) + "</span></div>";
        }).join("") + "</div>"
      : "") +

    '<div class="actions section">' +
      (isLive(book)
        ? ""
        : '<button type="button" class="btn primary" data-action="advance-book" data-id="' + escapeHTML(book.id) + '">Advance production</button>') +
      '<button type="button" class="btn" data-action="edit-book" data-id="' + escapeHTML(book.id) + '">Edit</button>' +
      (isLive(book)
        ? ""
        : '<button type="button" class="btn" data-action="toggle-queue" data-id="' + escapeHTML(book.id) + '">' +
          (book.queued ? "Remove from queue" : "Add to queue") + "</button>") +
      '<button type="button" class="btn danger" data-action="delete-book" data-id="' + escapeHTML(book.id) + '">Delete</button>' +
    "</div>"
  );
}

function editBook(id) {
  var book = id ? findBook(id) : null;
  var isNew = !book;

  var draft = book || {
    id: "",
    title: "",
    series: "Standalone",
    category: "General",
    author: "Book Factory Studio",
    format: "EPUB / PDF",
    description: "",
    stage: "Brief",
    chapters: { total: 14, done: 0 },
    words: { done: 0, target: 45000 },
    priority: "normal",
    revenue: 0,
    listPriceUsd: 9.99,
    storefronts: normaliseStorefronts({}),
    prices: {},
    liveOn: [],
  };

  function options(list, selected) {
    return list.map(function (value) {
      return '<option value="' + escapeHTML(value) + '"' + (value === selected ? " selected" : "") + ">" +
        escapeHTML(value) + "</option>";
    }).join("");
  }

  openModal(isNew ? "Add book" : "Edit book",
    '<form id="bookForm" novalidate>' +
      '<div class="field-row">' +
        '<label class="field"><span>Title</span><input class="input" name="title" required value="' + escapeHTML(draft.title) + '"></label>' +
        '<label class="field"><span>Series</span><input class="input" name="series" value="' + escapeHTML(draft.series) + '"></label>' +
      "</div>" +

      '<div class="field-row">' +
        '<label class="field"><span>Category</span><select class="input" name="category">' + options(CATEGORIES, draft.category) + "</select></label>" +
        '<label class="field"><span>Format</span><select class="input" name="format">' + options(FORMATS, draft.format) + "</select></label>" +
        '<label class="field"><span>Author</span><input class="input" name="author" value="' + escapeHTML(draft.author) + '"></label>' +
      "</div>" +

      '<div class="field-row">' +
        '<label class="field"><span>Stage</span><select class="input" name="stage">' + options(STAGES, draft.stage) + "</select></label>" +
        '<label class="field"><span>Priority</span><select class="input" name="priority">' +
          '<option value="normal"' + (draft.priority === "normal" ? " selected" : "") + ">Normal</option>" +
          '<option value="high"' + (draft.priority === "high" ? " selected" : "") + ">High</option>" +
        "</select></label>" +
      "</div>" +

      '<div class="field-row">' +
        '<label class="field"><span>Chapters planned</span><input class="input" name="chaptersTotal" type="number" min="1" max="400" value="' + draft.chapters.total + '"></label>' +
        '<label class="field"><span>Chapters drafted</span><input class="input" name="chaptersDone" type="number" min="0" max="400" value="' + draft.chapters.done + '"></label>' +
        '<label class="field"><span>Word target</span><input class="input" name="wordsTarget" type="number" min="0" step="500" value="' + draft.words.target + '"></label>' +
        '<label class="field"><span>Words drafted</span><input class="input" name="wordsDone" type="number" min="0" step="500" value="' + draft.words.done + '"></label>' +
      "</div>" +

      '<div class="field-row">' +
        '<label class="field"><span>List price ($)</span><input class="input" name="listPrice" type="number" min="0" step="0.01" value="' + (draft.listPriceUsd || "") + '"></label>' +
        '<label class="field"><span>Recorded revenue ($)</span><input class="input" name="revenue" type="number" min="0" step="1" value="' + draft.revenue + '"></label>' +
      "</div>" +

      '<fieldset style="border:1px solid var(--border);border-radius:10px;padding:12px;margin:0 0 12px">' +
        '<legend class="small muted" style="padding:0 6px">Already on sale? Paste the listing links</legend>' +
        '<p class="small muted" style="margin:0 0 10px">Tick a store to mark the title on sale there. The link is optional — a book can be live whether or not you have the URL handy. Anything marked on sale is kept out of the production queue.</p>' +
        STORES.map(function (store) {
          var onSale = (draft.liveOn || []).indexOf(store.id) >= 0 ||
            Boolean(draft.storefronts && draft.storefronts[store.id]);
          var storePrice = (draft.prices || {})[store.id] || "";
          var r = ROYALTY[store.id];
          var hint = r && r.bandHigh !== Infinity
            ? "70% up to " + formatMoney(r.bandHigh) + ", 35% above"
            : Math.round((r ? r.rate : 0.8) * 100) + "% royalty";

          return '<div style="margin-bottom:12px">' +
            '<label class="switch"><input type="checkbox" name="live_' + store.id + '"' +
              (onSale ? " checked" : "") + "> <span>On sale at " + escapeHTML(store.label) +
              ' <span class="small muted">— ' + escapeHTML(hint) + "</span></span></label>" +
            '<div style="display:flex;gap:8px">' +
              '<input class="input" name="price_' + store.id + '" type="number" min="0" step="0.01" ' +
                'style="width:120px" placeholder="price" value="' + storePrice + '">' +
              '<input class="input" name="store_' + store.id + '" type="url" style="flex:1" ' +
                'placeholder="Listing link (optional)" value="' +
                escapeHTML((draft.storefronts && draft.storefronts[store.id]) || "") + '">' +
            "</div></div>";
        }).join("") +
      "</fieldset>" +

      '<label class="field"><span>Description (used for metadata validation)</span>' +
        '<textarea class="input" name="description" rows="3">' + escapeHTML(draft.description) + "</textarea></label>" +

      '<p class="field-error" id="bookFormError" role="alert"></p>' +

      '<div class="actions">' +
        '<button type="submit" class="btn primary">' + (isNew ? "Create book" : "Save changes") + "</button>" +
        '<button type="button" class="btn" data-action="close-modal">Cancel</button>' +
      "</div>" +
    "</form>"
  );

  $("bookForm").addEventListener("submit", function (event) {
    event.preventDefault();
    submitBookForm(book, event.target);
  });
}

function submitBookForm(book, form) {
  var data = new FormData(form);
  var title = String(data.get("title") || "").trim();
  var error = $("bookFormError");

  if (!title) {
    error.textContent = "A title is required.";
    form.elements.title.focus();
    return;
  }

  var total = clamp(toInt(data.get("chaptersTotal"), 1), 1, 400);
  var done = clamp(toInt(data.get("chaptersDone"), 0), 0, total);
  var target = clamp(toInt(data.get("wordsTarget"), 0), 0, 5000000);
  var drafted = clamp(toInt(data.get("wordsDone"), 0), 0, 5000000);

  if (target && drafted > target * 1.5) {
    error.textContent = "Words drafted looks wrong — it exceeds 150% of the target.";
    return;
  }

  var isNew = !book;

  var target_book = book || {
    id: uid("bk"),
    queued: false,
    released: false,
    issues: [],
    storefronts: normaliseStorefronts({}),
    liveOn: [],
    publishedAt: null,
    createdAt: Date.now()
  };

  target_book.title = title;
  target_book.series = String(data.get("series") || "Standalone").trim() || "Standalone";
  target_book.category = String(data.get("category") || "General");
  target_book.format = String(data.get("format") || "EPUB / PDF");
  target_book.author = String(data.get("author") || "Book Factory Studio").trim();
  target_book.stage = STAGES.indexOf(String(data.get("stage"))) >= 0 ? String(data.get("stage")) : "Brief";
  target_book.priority = data.get("priority") === "high" ? "high" : "normal";
  target_book.chapters = { total: total, done: done };
  target_book.words = { done: drafted, target: target };
  target_book.revenue = Math.max(0, toNum(data.get("revenue"), 0));
  target_book.listPriceUsd = Math.max(0, toNum(data.get("listPrice"), 0)) || null;

  var storefronts = {};
  var liveOn = [];
  var prices = {};
  STORES.forEach(function (store) {
    storefronts[store.id] = String(data.get("store_" + store.id) || "").trim();
    if (data.get("live_" + store.id)) liveOn.push(store.id);
    var storePrice = Math.max(0, toNum(data.get("price_" + store.id), 0));
    if (storePrice) prices[store.id] = storePrice;
  });
  target_book.prices = normalisePrices(prices);
  var wasLive = isLive(target_book);
  target_book.storefronts = normaliseStorefronts(storefronts);
  target_book.liveOn = liveOn;
  if (isLive(target_book) && !wasLive) target_book.publishedAt = Date.now();
  if (!isLive(target_book)) target_book.publishedAt = null;
  target_book.description = String(data.get("description") || "").trim();
  target_book.updatedAt = Date.now();

  if (isNew) {
    state.books.unshift(target_book);
    log("library", "Added “" + title + "” to the master library.");
  } else {
    log("library", "Updated “" + title + "”.");
  }

  save();
  closeModal();
  render();
  toast(isNew ? "Book added to the library." : "Book updated.", "ok");
}

/* ---------------------------------------------------------
   Actions
   --------------------------------------------------------- */

function toggleQueue(id) {
  var book = findBook(id);
  if (!book) return;

  if (isLive(book)) {
    toast(book.title + " is already on sale — it does not belong in production.", "warn");
    return;
  }

  if (book.released || book.stage === "Publishing") {
    toast("That title has already finished production.", "warn");
    return;
  }

  book.queued = !book.queued;
  touch(book);
  log("queue", book.title + (book.queued ? " queued for production." : " removed from the queue."));
  save();
  render();
  toast(book.queued ? "Queued " + book.title + "." : "Dequeued " + book.title + ".");
}

/**
 * Record that a book is already on sale. Kept deliberately quick - most people
 * have a handful of published titles to correct in one sitting, and making
 * that a full form edit each time is why the dashboard stayed wrong.
 */
function markLive(id) {
  var book = findBook(id);
  if (!book) return;

  var url = prompt(
    "Paste the listing URL for “" + book.title + "”\n\n" +
      "Amazon/KDP, Gumroad or any other store. Leave blank to cancel.",
    "",
  );
  if (!url || !url.trim()) return;

  var trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    toast("That does not look like a link — it needs to start with http.", "warn");
    return;
  }

  var host = trimmed.toLowerCase();
  var store = /amazon\.|amzn\.|kdp\./.test(host)
    ? "amazon"
    : /gumroad\./.test(host)
      ? "gumroad"
      : "other";

  book.storefronts[store] = trimmed;
  if ((book.liveOn || []).indexOf(store) < 0) book.liveOn = (book.liveOn || []).concat(store);
  book.publishedAt = book.publishedAt || Date.now();
  book.queued = false;
  book.stage = "Publishing";
  touch(book);

  log("library", book.title + " marked as on sale.");
  save();
  render();
  toast(book.title + " is now marked LIVE on " + store + ".", "ok");
}

/**
 * Bulk-marks published titles from pasted "Title | URL" lines.
 *
 * Gumroad can produce that list from its API (`node src/cli.js gumroad-list`).
 * Amazon and KDP publish no such API, so those lines are pasted by hand - which
 * is still far quicker than editing each book in turn.
 */
function importLive() {
  var pasted = prompt(
    "Paste one line per published book:\n\n" +
      "    Title | https://link-to-the-listing\n\n" +
      "Titles are matched loosely against your library. " +
      "Run `node src/cli.js gumroad-list` in the engine to generate these for Gumroad.",
    "",
  );
  if (!pasted || !pasted.trim()) return;

  var matched = 0;
  var unmatched = [];

  pasted.split(/\n+/).forEach(function (line) {
    if (!line.trim()) return;

    var parts = line.split("|");
    var title = String(parts[0] || "").trim();
    var url = String(parts.slice(1).join("|") || "").trim();

    if (!title || !/^https?:\/\//i.test(url)) {
      unmatched.push(line.trim() + "  (needs: Title | https://…)");
      return;
    }

    var needle = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    var book = state.books.filter(function (b) {
      var hay = b.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return hay === needle || hay.indexOf(needle) === 0 || needle.indexOf(hay) === 0;
    })[0];

    if (!book) {
      unmatched.push(title + "  (no matching book in the library)");
      return;
    }

    var host = url.toLowerCase();
    var store = /amazon\.|amzn\.|kdp\./.test(host)
      ? "amazon"
      : /gumroad\./.test(host)
        ? "gumroad"
        : "other";

    book.storefronts[store] = url;
    book.publishedAt = book.publishedAt || Date.now();
    book.queued = false;
    book.stage = "Publishing";
    touch(book);
    matched += 1;
  });

  if (matched) {
    log("library", "Imported " + matched + " published title(s).");
    save();
    render();
  }

  toast(
    matched + " marked on sale" + (unmatched.length ? ", " + unmatched.length + " could not be matched" : "."),
    unmatched.length ? "warn" : "ok",
  );

  if (unmatched.length) {
    openModal(
      "Lines that did not match",
      '<p class="small muted">Everything else was imported. These need a closer look — check the title spelling against your library, or add the book first.</p>' +
        '<ul class="feed">' +
        unmatched.map(function (line) { return "<li><span>" + escapeHTML(line) + "</span></li>"; }).join("") +
        "</ul>" +
        '<div class="actions section"><button type="button" class="btn" data-action="close-modal">Close</button></div>',
    );
  }
}

function advanceBook(id) {
  var book = findBook(id);
  if (!book) return;

  if (book.issues.length) {
    toast("Resolve the blockers on " + book.title + " first.", "warn");
    return;
  }

  var line = stepBook(book);

  if (!line) {
    toast(book.title + " has finished the pipeline.", "ok");
    return;
  }

  log("production", line);
  save();

  if (modalOpen()) viewBook(book.id);
  render();
  toast(line);
}

function deleteBook(id) {
  var book = findBook(id);
  if (!book) return;
  if (!confirm("Delete “" + book.title + "” from the library? This cannot be undone.")) return;

  state.books = state.books.filter(function (b) { return b.id !== id; });
  state.facts = state.facts.map(function (f) {
    return f.bookId === id ? Object.assign({}, f, { bookId: null }) : f;
  });

  log("library", "Deleted “" + book.title + "”.");
  save();
  closeModal();
  render();
  toast("Book deleted.", "warn");
}

function resolveIssue(bookId, issueId) {
  var book = findBook(bookId);
  if (!book) return;

  book.issues = book.issues.filter(function (i) { return i.id !== issueId; });
  touch(book);
  log("qa", "Resolved a blocker on " + book.title + ".");
  save();

  if (modalOpen()) viewBook(bookId);
  render();
  toast("Blocker resolved.", "ok");
}

function useBlueprint(id) {
  var bp = BLUEPRINTS.filter(function (b) { return b.id === id; })[0];
  if (!bp) return;

  var count = state.books.filter(function (b) { return b.series === bp.name + " Blueprint"; }).length;

  var book = {
    id: uid("bk"),
    title: bp.name + " title " + (count + 1),
    series: bp.name + " Blueprint",
    category: bp.category,
    author: "Book Factory Studio",
    format: bp.format,
    description: "Generated from the " + bp.name + " blueprint: " + bp.blurb + ".",
    stage: "Blueprint",
    chapters: { total: bp.chapters, done: 0 },
    words: { done: 0, target: bp.words },
    priority: "normal",
    revenue: 0,
    queued: true,
    released: false,
    issues: [],
    // Marks this as engine-produced, so break-even can be computed against a
    // real cost rather than guessed for a book written by hand.
    generated: true,
    listPriceUsd: 9.99,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  state.books.unshift(book);
  log("blueprint", bp.name + " blueprint generated “" + book.title + "” and queued it.");
  save();
  render();
  toast(bp.name + " blueprint routed to the production queue.", "ok");
  editBook(book.id);
}

function addFact() {
  var input = $("factText");
  var text = input.value.trim();

  if (!text) {
    toast("Enter a fact first.", "warn");
    input.focus();
    return;
  }

  state.facts.unshift({
    id: uid("ft"),
    text: text,
    bookId: $("factBook").value || null,
    createdAt: Date.now()
  });

  input.value = "";
  log("memory", "Continuity fact recorded.");
  save();
  render();
  toast("Fact added to continuity memory.", "ok");
}

function extractFacts() {
  var added = 0;

  state.books.forEach(function (book) {
    var marker = "Auto: " + book.title;
    var exists = state.facts.some(function (f) { return f.text.indexOf(marker) === 0; });
    if (exists) return;

    state.facts.unshift({
      id: uid("ft"),
      text: marker + " — " + book.category + " title in the " + book.series + " series, " +
        book.chapters.total + " chapters, " + formatNumber(book.words.target) + " word target.",
      bookId: book.id,
      createdAt: Date.now()
    });

    added += 1;
  });

  log("memory", "Auto-extraction added " + added + " fact(s).");
  save();
  render();
  toast(added ? "Extracted " + added + " new fact(s)." : "No new facts to extract.", added ? "ok" : "warn");
}

function deleteFact(id) {
  state.facts = state.facts.filter(function (f) { return f.id !== id; });
  save();
  render();
  toast("Fact removed.");
}

function validatePackages() {
  var report = { at: Date.now(), pass: 0, review: 0, pending: 0, notes: [] };

  state.books.forEach(function (book) {
    var p = packageState(book);

    if (p.validator === "PASS") report.pass += 1;
    else if (p.validator === "REVIEW") report.review += 1;
    else report.pending += 1;

    if (p.blockers.length) {
      report.notes.push(book.title + ": " + p.blockers.join("; "));
    }
  });

  state.lastValidation = report;
  log("publishing", "Validator run: " + report.pass + " pass, " + report.review + " review, " + report.pending + " pending.");
  save();
  render();
  toast("Validation complete — " + report.pass + " package(s) passed.", report.review ? "warn" : "ok");
}

function packageBooks() {
  var packaged = 0;

  state.books.forEach(function (book) {
    if (isLive(book) || book.issues.length || book.released) return;
    if (stageIndex(book.stage) < STAGES.indexOf("QA")) return;
    if (book.stage === "Packaging" || book.stage === "Publishing") return;

    book.stage = "Packaging";
    touch(book);
    packaged += 1;
  });

  log("publishing", "Packaged " + packaged + " book(s).");
  save();
  render();
  toast(packaged ? "Packaged " + packaged + " book(s)." : "Nothing is eligible for packaging yet.", packaged ? "ok" : "warn");
}

function releasePackages() {
  var released = [];

  state.books.forEach(function (book) {
    if (isLive(book) || book.released) return;
    if (packageState(book).validator !== "PASS") return;
    if (book.stage !== "Publishing") {
      book.stage = "Publishing";
    }
    book.released = true;
    book.queued = false;
    touch(book);
    released.push(book.title);
  });

  if (!released.length) {
    toast("No package currently passes validation.", "warn");
    return;
  }

  log("publishing", "Released: " + released.join(", ") + ".");
  save();
  render();
  toast("Released " + released.length + " title(s).", "ok");
}

function generateReport() {
  var s = summary();

  state.lastReport = {
    at: Date.now(),
    total: s.total,
    ready: s.counts.READY,
    running: s.counts.RUNNING,
    pipeline: s.counts.PIPELINE,
    blocked: s.counts.BLOCKED,
    released: s.counts.RELEASED,
    words: s.words
  };

  log("report", "Daily report generated: " + s.total + " titles, " + s.counts.BLOCKED + " blocked.");
  save();
  render();
  toast("Daily production report generated.", "ok");
}

function clearCompleted() {
  var cleared = 0;

  state.books.forEach(function (book) {
    if (book.stage === "Publishing" && book.queued) {
      book.queued = false;
      cleared += 1;
    }
  });

  log("queue", "Cleared " + cleared + " completed job(s) from the queue.");
  save();
  render();
  toast(cleared ? "Cleared " + cleared + " completed job(s)." : "Queue is already clean.");
}

function exportData() {
  var payload = JSON.stringify({
    exportedAt: new Date().toISOString(),
    app: "book-factory",
    version: APP_VERSION,
    state: state
  }, null, 2);

  var blob = new Blob([payload], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");

  link.href = url;
  link.download = "book-factory-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  toast("Library exported.", "ok");
}

/**
 * Folding the engine's books into the catalogue.
 *
 * A factory export must MERGE, never replace. Importing it used to run through
 * the same path as a library restore, which would have thrown away the eleven
 * titles this catalogue exists to track in exchange for whatever the engine
 * happened to hold.
 *
 * The engine owns what only it knows - that a book was generated, and what it
 * cost to make. Everything a person could have edited here wins.
 */
function mergeFactoryBooks(incoming) {
  var added = 0;
  var updated = 0;

  incoming.forEach(function (raw) {
    var fresh = normaliseBook(raw, state.books.length);
    var existing = window.BookFactorySales.matchTitle(fresh.title, state.books);

    if (!existing) {
      state.books.unshift(fresh);
      added++;
      return;
    }

    existing.productionCostUsd = fresh.productionCostUsd || existing.productionCostUsd;
    existing.generated = true;
    existing.description = existing.description || fresh.description;
    existing.listPriceUsd = existing.listPriceUsd || fresh.listPriceUsd;

    // A store link the engine has and this catalogue does not is new news; one
    // the catalogue already has was put there by a person and stays.
    STORES.forEach(function (store) {
      if (!existing.storefronts[store.id] && fresh.storefronts[store.id]) {
        existing.storefronts[store.id] = fresh.storefronts[store.id];
      }
    });
    fresh.liveOn.forEach(function (id) {
      if (existing.liveOn.indexOf(id) === -1) existing.liveOn.push(id);
    });

    existing.updatedAt = Date.now();
    updated++;
  });

  return { added: added, updated: updated };
}

function importData(file) {
  var reader = new FileReader();

  reader.onload = function () {
    try {
      var parsed = JSON.parse(String(reader.result));

      // A factory export is a different thing from a library backup: it is a
      // slice of the catalogue, not the whole of it.
      if (parsed && parsed.kind === "book-factory-export") {
        if (!Array.isArray(parsed.books) || !parsed.books.length) {
          throw new Error("That export contains no books.");
        }
        var result = mergeFactoryBooks(parsed.books);
        log("system", "Factory import: " + result.added + " added, " + result.updated + " updated.");
        save();
        render();
        toast(result.added + " book(s) added, " + result.updated + " updated.", "ok");
        return;
      }

      var incoming = parsed && parsed.state ? parsed.state : parsed;
      var next = normaliseState(Array.isArray(incoming) ? { books: incoming } : incoming);

      if (!next || !next.books.length) throw new Error("No books found in that file.");

      state = next;
      log("system", "Imported " + state.books.length + " books.");
      save();
      render();
      toast("Imported " + state.books.length + " books.", "ok");
    } catch (err) {
      toast("Import failed: " + err.message, "bad");
    }
  };

  reader.onerror = function () { toast("Could not read that file.", "bad"); };
  reader.readAsText(file);
}

function resetData() {
  if (!confirm("Reset Book Factory to the seed library? Your current data will be replaced.")) return;

  state = seedState();
  log("system", "Reset to seed data.");
  save();
  render();
  toast("Seed data restored.", "ok");
}

function setTheme(theme) {
  var value = theme === "light" ? "light" : "dark";

  state.settings.theme = value;
  document.documentElement.dataset.theme = value;

  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", value === "light" ? "#f4f6fc" : "#080d19");

  try {
    localStorage.setItem(THEME_KEY, value);
  } catch (err) { /* storage unavailable */ }

  save();
  render();
}

/* ---------------------------------------------------------
   Event wiring
   --------------------------------------------------------- */

var ACTIONS = {
  "toggle-run": toggleRun,
  "step-production": function () { stepProduction(false); },
  "clear-completed": clearCompleted,
  "open-blueprints": function () { openPage("blueprints"); },
  "open-publishing": function () { openPage("publishing"); },
  "report": generateReport,
  "new-book": function () { editBook(null); },
  "view-book": function (el) { viewBook(el.dataset.id); },
  "edit-book": function (el) { editBook(el.dataset.id); },
  "delete-book": function (el) { deleteBook(el.dataset.id); },
  "toggle-queue": function (el) { toggleQueue(el.dataset.id); },
  "mark-live": function (el) { markLive(el.dataset.id); },
  "import-live": importLive,
  "advance-book": function (el) { advanceBook(el.dataset.id); },
  "resolve-issue": function (el) { resolveIssue(el.dataset.id, el.dataset.issue); },
  "use-blueprint": function (el) { useBlueprint(el.dataset.id); },
  "add-fact": addFact,
  "extract-facts": extractFacts,
  "delete-fact": function (el) { deleteFact(el.dataset.id); },
  "validate": validatePackages,
  "package": packageBooks,
  "release": releasePackages,
  "export": exportData,
  "import": function () { $("importFile").click(); },
  "pick-sales-file": function () { $("salesFile").click(); },
  "apply-sales-import": commitSalesImport,
  "cancel-sales-import": function () {
    pendingImport = null;
    $("salesPreview").hidden = true;
    $("salesPreview").innerHTML = "";
  },
  "reset": resetData,
  "close-modal": closeModal,
  "dismiss-catalogue-banner": function () {
    ui.bannerDismissed = true;
    state.catalogueMerged = false;
    save();
    renderCatalogueBanner();
  },
  "clear-activity": function () {
    state.activity = [];
    save();
    render();
    toast("Activity log cleared.");
  },
  "copy-schedule-command": function () {
    var text = scheduleCommand();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Commands copied.", "ok"); },
        function () { toast("Could not copy — select the text instead.", "warn"); },
      );
    } else {
      toast("Clipboard unavailable — select the text instead.", "warn");
    }
  },

  "reset-schedule": function () {
    state.schedule = clone(DEFAULT_SCHEDULE);
    save();
    render();
    toast("Schedule restored to defaults.");
  }
};

document.addEventListener("click", function (event) {
  var node = event.target;
  if (!node || typeof node.closest !== "function") return;

  var drill = node.closest("[data-drill]");
  if (drill) {
    event.preventDefault();
    toggleDrill(drill.dataset.drill, drill.dataset.key, drill.dataset.label);
    return;
  }

  var jump = node.closest("[data-jump]");
  if (jump) {
    event.preventDefault();
    var target = $(jump.dataset.jump);
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
      // A flash, because a page that silently scrolls leaves you wondering
      // which of the tables below you were just sent to.
      target.classList.add("flash");
      setTimeout(function () { target.classList.remove("flash"); }, 1200);
    }
    return;
  }

  var trigger = node.closest("[data-action]");
  if (!trigger) return;

  var handler = ACTIONS[trigger.dataset.action];
  if (!handler) return;

  event.preventDefault();
  handler(trigger);
});

document.querySelectorAll("#nav button[data-page]").forEach(function (button) {
  button.addEventListener("click", function () { openPage(button.dataset.page); });
});

$("menuToggle").addEventListener("click", function () {
  var open = $("sidebar").classList.toggle("open");
  this.setAttribute("aria-expanded", String(open));
});

$("themeToggle").addEventListener("click", function () {
  setTheme(state.settings.theme === "light" ? "dark" : "light");
});

$("themeSelect").addEventListener("change", function () { setTheme(this.value); });

$("bookSearch").addEventListener("input", function () {
  ui.search = this.value;
  renderLibrary();
});

$("categoryFilter").addEventListener("change", function () {
  ui.category = this.value;
  renderLibrary();
});

$("statusFilter").addEventListener("change", function () {
  ui.status = this.value;
  renderLibrary();
});

$("sortBy").addEventListener("change", function () {
  ui.sort = this.value;
  renderLibrary();
});

$("onlyActive").addEventListener("change", function () {
  ui.onlyActive = this.checked;
  renderProduction();
});

$("scheduleForm").addEventListener("submit", function (event) {
  event.preventDefault();

  var error = $("scheduleError");
  var time = $("schedTime").value;
  var batch = toInt($("schedBatch").value, 0);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    error.textContent = "Enter a run time as HH:MM.";
    return;
  }

  if (batch < 1 || batch > 20) {
    error.textContent = "Batch size must be between 1 and 20 books.";
    return;
  }

  error.textContent = "";

  state.schedule = normaliseSchedule({
    enabled: $("schedEnabled").checked,
    cadence: $("schedCadence").value,
    time: time,
    zone: $("schedZone").value,
    batch: batch,
    maxPending: toInt($("schedMaxPending").value, 3),
    budgetUsd: toNum($("schedBudget").value, 20),
    autoQA: $("schedAutoQA").checked,
    autoPackage: $("schedAutoPackage").checked,
    handoff: $("schedHandoff").checked
  });

  log("scheduler", "Schedule saved: " + state.schedule.cadence + " at " + time + " " + state.schedule.zone + ".");
  save();
  render();
  toast("Schedule saved.", "ok");
});

$("importFile").addEventListener("change", function () {
  if (this.files && this.files[0]) importData(this.files[0]);
  this.value = "";
});

$("salesFile").addEventListener("change", function () {
  if (this.files && this.files[0]) previewSalesFile(this.files[0]);
  // Cleared so choosing the same file twice still fires a change event.
  this.value = "";
});

$("modal").addEventListener("click", function (event) {
  if (event.target.id === "modal") closeModal();
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && modalOpen()) {
    closeModal();
    return;
  }

  trapFocus(event);

  var active = document.activeElement;
  var typing = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);

  if (event.key === "/" && !typing && !modalOpen()) {
    event.preventDefault();
    openPage("library", { keepScroll: true });
    $("bookSearch").focus();
  }
});

window.addEventListener("hashchange", function () {
  var page = pageFromHash();
  if (page !== ui.page) openPage(page);
});

window.addEventListener("beforeunload", function () {
  if (saveTimer) {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) { /* ignore */ }
  }
});

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

$("categoryFilter").innerHTML = '<option value="">All categories</option>' +
  CATEGORIES.map(function (c) { return '<option value="' + escapeHTML(c) + '">' + escapeHTML(c) + "</option>"; }).join("");

setTheme(state.settings.theme);
openPage(pageFromHash(), { replace: true, keepScroll: true });

/* Keep the countdown and relative timestamps honest. */
setInterval(function () {
  if (ui.page === "dashboard" || ui.page === "scheduler") render();
}, 30000);


})();
