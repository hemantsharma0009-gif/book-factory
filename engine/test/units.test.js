import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { nextGenre, nextAngle, GENRES } from "../src/genres.js";
import { markdownToXhtml, buildEpub } from "../src/epub.js";
import { buildKdpPack } from "../src/publish/kdp.js";
import { nextRunAt, isDue, shouldRun } from "../src/scheduler.js";
import { renderFigure } from "../src/illustrate/charts.js";
import { genericTitleReason } from "../src/agents/title-check.js";
import { stubPlan } from "../src/agents/planner.js";
import { __test as __editor } from "../src/agents/editor.js";
import { mintLink, revokeLink, createShareServer, makeCertificate, __test as __share } from "../src/share.js";
import { deliverBook, safeName, folderNameFor } from "../src/deliver.js";
import { parseManuscript, rebuildBook, manuscriptIsNewer } from "../src/rebuild.js";
import * as __model from "../src/model.js";
import { ROYALTY } from "../src/royalty.js";
import { breakEven, netPerSale, betterAtLowRate, spentRecently, estimateRun, economicsFor } from "../src/economics.js";
import * as __runState from "../src/run-state.js";
import * as __chapters from "../src/chapters.js";
import * as __png from "../src/illustrate/png.js";
import * as __aigen from "../src/illustrate/aigen.js";
import * as __art from "../src/illustrate/art.js";
import * as __illustrate from "../src/illustrate/index.js";
import { assertUsable } from "../src/illustrate/index.js";
import { renderPhotoCover } from "../src/cover.js";
import { disclosureFor, alsoByFor, __test as __pipeline } from "../src/pipeline.js";

test("genre rotation never repeats within the cooldown window", () => {
  const history = [];
  const picks = [];

  for (let i = 0; i < 20; i++) {
    const genre = nextGenre(history);
    picks.push(genre.id);
    history.unshift(genre.id);
  }

  // No genre appears twice in any window of 6 consecutive picks.
  for (let i = 0; i + 6 <= picks.length; i++) {
    const window = picks.slice(i, i + 6);
    assert.equal(new Set(window).size, window.length, `repeat within window at ${i}: ${window}`);
  }
});

test("genre rotation never repeats consecutively even past the catalogue size", () => {
  const history = [];
  for (let i = 0; i < GENRES.length * 3; i++) {
    const genre = nextGenre(history);
    assert.notEqual(genre.id, history[0], "picked the same genre twice in a row");
    history.unshift(genre.id);
  }
});

test("angle rotates within a genre", () => {
  const genre = GENRES.find((g) => g.id === "adventure");
  const first = nextAngle(genre, []);
  const second = nextAngle(genre, [{ genre: "adventure", angle: first }]);
  assert.notEqual(first, second);
});

test("markdown converts to well-formed xhtml fragments", () => {
  const html = markdownToXhtml("## Heading\n\nA **bold** and *italic* line.\n\n- one\n- two");
  assert.match(html, /<h2>Heading<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("markdown escapes html so book text cannot inject markup", () => {
  const html = markdownToXhtml("A <script>alert(1)</script> & an ampersand");
  assert.ok(!html.includes("<script>"), "raw script tag survived escaping");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("epub has mimetype stored first", async () => {
  const buffer = await buildEpub({
    title: "Test", subtitle: "S", author: "A", description: "d",
    chapters: [{ number: 1, title: "One", body: "Hello." }],
    figures: new Map(),
  });
  // The EPUB spec requires the literal string at this offset.
  assert.equal(buffer.subarray(30, 38).toString(), "mimetype");
  assert.equal(buffer.subarray(38, 58).toString(), "application/epub+zip");
});

test("kdp pack flags a price outside the 70% royalty band", () => {
  const book = baseBook({ priceUsd: 14.99 });
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.equal(pack.royalty, "35%");
  // The sheet must state the cost of the band, not merely the rate.
  assert.match(pack.markdown, /outside Amazon's \$2\.99–\$9\.99 band/);
  assert.match(pack.markdown, /\$5\.25 per sale/);   // 14.99 x 0.35
  assert.match(pack.markdown, /\$6\.99 at \$9\.99/); //  9.99 x 0.70
});

test("kdp pack quotes the Amazon price, not a generic list price", () => {
  // A title can be $12.99 on Gumroad and $9.99 on Amazon; the sheet is for
  // Amazon, so it must use the Amazon figure and the royalty that follows.
  const book = baseBook({ priceUsd: 12.99 });
  book.prices = { amazon: 9.99 };
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.equal(pack.royalty, "70%");
  assert.match(pack.markdown, /\| \*\*\$9\.99\*\* \|/);
  assert.match(pack.markdown, /70% — \$6\.99 per sale/);
  assert.doesNotMatch(pack.markdown, /outside Amazon's/);
});

test("kdp pack flags keywords that repeat title words, naming the field", () => {
  const book = baseBook({ keywords: ["cooking guide", "a", "b", "c", "d", "e", "f"] });
  book.title = "The Cooking Handbook";
  book.subtitle = "Recipes";
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.ok(pack.warnings.some((w) => /repeats "cooking" from the title/.test(w)));
});

test("kdp pack attributes a subtitle collision to the subtitle, not the title", () => {
  // Naming the wrong field sends you hunting in the wrong place.
  const book = baseBook({ keywords: ["practical techniques", "a", "b", "c", "d", "e", "f"] });
  book.title = "Nine Days Above the Treeline";
  book.subtitle = "A practical guide to expedition survival";
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  const warning = pack.warnings.find((w) => w.includes("practical techniques"));
  assert.ok(warning, "expected a warning for the colliding keyword");
  assert.match(warning, /from the subtitle/);
});

test("kdp pack does not warn on genuinely distinct keywords", () => {
  const book = baseBook({ keywords: ["self study workbook", "learn at home", "worked examples",
    "quick reference", "weekend project", "field tested methods", "no prior experience"] });
  book.title = "Nine Days Above the Treeline";
  book.subtitle = "Crossing the Sierra on foot";
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.deepEqual(pack.warnings, [], `unexpected warnings: ${pack.warnings.join("; ")}`);
});

test("kdp pack always carries the AI disclosure", () => {
  const pack = buildKdpPack({ book: baseBook({}), epubName: "x.epub" });
  assert.match(pack.markdown, /\*\*AI-Generated Content:\*\* ☑ \*\*Yes\*\*/);
});

test("kdp pack flags an over-long description", () => {
  const book = baseBook({ description: "x".repeat(4100) });
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.ok(pack.warnings.some((w) => w.includes("KDP allows 4000")));
});

test("scheduler computes a future run and reports due correctly", () => {
  const schedule = { enabled: true, cadence: "daily", time: "09:00" };
  const next = nextRunAt(schedule, null);
  assert.ok(next > Date.now(), "next run should be in the future");

  const longAgo = Date.now() - 5 * 86400000;
  assert.equal(isDue(schedule, longAgo), true, "a daily run 5 days overdue should be due");
  assert.equal(isDue({ ...schedule, enabled: false }, longAgo), false, "disabled schedule is never due");
});

test("charts carry direct labels and a data table", () => {
  const { svg, table } = renderFigure({
    kind: "bar",
    title: "T",
    caption: "Figure 1",
    data: { categories: ["a", "b"], series: [{ name: "s", values: [3, 7] }] },
  });
  // Every mark is labelled, because a printed page has no hover layer.
  assert.match(svg, />3</);
  assert.match(svg, />7</);
  assert.match(table, /<th scope="row">s<\/th>/);
});

function baseBook(overrides) {
  return {
    id: "bk_test",
    genre: overrides.genre,
    genreName: overrides.genreName,
    title: "A Title",
    subtitle: "A Subtitle",
    author: "Author",
    figureCount: 0,
    listing: {
      description: overrides.description || "A description.",
      keywords: overrides.keywords || ["one two", "three four", "five six", "seven eight", "nine ten", "eleven twelve", "thirteen"],
      categories: overrides.categories || ["A > B"],
      priceUsd: overrides.priceUsd || 9.99,
      priceRationale: "because",
    },
  };
}

test("kdp pack flags a novel filed on the nonfiction shelf", () => {
  // Amazon does not make a category easy to change once a title is live, and a
  // novel shelved under Reference is shown to the wrong readers from day one.
  const book = baseBook({
    genre: "adventure",
    genreName: "Adventure",
    categories: ["Nonfiction > Adventure", "Reference > Adventure"],
  });
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.ok(
    pack.warnings.some((w) => /Adventure is fiction/.test(w)),
    `expected a shelf warning, got: ${pack.warnings.join(" | ")}`,
  );
});

test("kdp pack accepts categories that match the genre", () => {
  for (const [genre, categories] of [
    ["adventure", ["Fiction > Adventure"]],
    ["cooking", ["Nonfiction > Cooking", "Reference > Cooking"]],
  ]) {
    const pack = buildKdpPack({ book: baseBook({ genre, categories }), epubName: "x.epub" });
    assert.equal(
      pack.warnings.filter((w) => /wrong readers/.test(w)).length,
      0,
      `${genre} should not warn on ${categories.join(", ")}`,
    );
  }
});

test("kdp pack does not warn when only one category crosses the shelf", () => {
  // A single crossover category is a deliberate reach for a second audience,
  // not a mis-file; warning on it would train you to ignore the warnings.
  const book = baseBook({
    genre: "adventure",
    categories: ["Fiction > Adventure", "Nonfiction > Adventure"],
  });
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.equal(pack.warnings.filter((w) => /wrong readers/.test(w)).length, 0);
});

test("a stub plan for a fiction genre does not read like a how-to", () => {
  const fiction = stubPlan({ genre: { id: "adventure", name: "Adventure", kind: "fiction" }, angle: "a lost city", chapters: 3 });
  assert.doesNotMatch(fiction.subtitle, /practical guide/i);

  const nonfiction = stubPlan({ genre: { id: "cooking", name: "Cooking", kind: "nonfiction" }, angle: "one-pan dinners", chapters: 3 });
  assert.match(nonfiction.subtitle, /practical guide/i);
});

test("generic-title guard rejects titles that name their own genre", () => {
  const genre = { name: "Mystery", id: "mystery", kind: "fiction" };
  assert.match(genericTitleReason("The Mystery Handbook", genre), /genre name/);
  assert.match(genericTitleReason("A Mystery Guide", genre), /genre name/);
  assert.match(genericTitleReason("Narrative History For Beginners", { name: "Narrative history" }), /genre name/);
});

test("generic-title guard rejects stock formulas", () => {
  const genre = { name: "Cooking", id: "cooking", kind: "nonfiction" };
  assert.ok(genericTitleReason("The Complete Guide to Bread", genre));
  assert.ok(genericTitleReason("Mastering Sourdough", genre));
  assert.ok(genericTitleReason("Sourdough 101", genre));
  assert.ok(genericTitleReason("The Fermentation Bible", genre));
  assert.ok(genericTitleReason("Everything You Need To Know About Yeast", genre));
});

test("generic-title guard accepts real, specific titles", () => {
  // These are the shapes we want; none may be flagged.
  const cases = [
    ["Salt Fat Acid Heat", { name: "Cooking" }],
    ["The Devil in the White City", { name: "Narrative history" }],
    ["Bowling Alone", { name: "Popular science" }],
    ["Nine Days Above the Treeline", { name: "Adventure" }],
    ["The Room That Locked Itself", { name: "Mystery" }],
    ["Six Weeks in October", { name: "Narrative history" }],
    ["One Pan, One Fire", { name: "Cooking" }],
  ];
  for (const [title, genre] of cases) {
    assert.equal(genericTitleReason(title, genre), null, `false positive on "${title}"`);
  }
});

test("generic-title guard rejects empty and filler-only titles", () => {
  const genre = { name: "Business" };
  assert.ok(genericTitleReason("", genre));
  assert.ok(genericTitleReason("   ", genre));
  assert.ok(genericTitleReason("The Complete Book", genre));
});

test("stub plans produce distinctive titles for every genre", () => {
  // A dry run must exercise the same paths as a real one, so its titles must
  // pass the same guard.
  for (const genre of GENRES) {
    const plan = stubPlan({ genre, angle: "a test angle", chapters: 3 });
    assert.equal(
      genericTitleReason(plan.title, genre),
      null,
      `stub title "${plan.title}" for ${genre.id} would be rejected`,
    );
  }
});

test("stub keywords never repeat title words", () => {
  for (const genre of GENRES.slice(0, 4)) {
    const plan = stubPlan({ genre, angle: "one pan meals", chapters: 3 });
    const listing = stubListingFor(plan, genre);
    const titleWords = plan.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    for (const keyword of listing.keywords) {
      for (const word of keyword.toLowerCase().split(/\W+/)) {
        assert.ok(
          !(word.length > 3 && titleWords.includes(word)),
          `keyword "${keyword}" repeats title word "${word}" from "${plan.title}"`,
        );
      }
    }
  }
});

/** Mirrors the marketer stub's keyword derivation for the test above. */
function stubListingFor(plan, genre) {
  const angleWords = "one pan meals".toLowerCase().split(/\s+/).slice(0, 3).join(" ");
  return {
    keywords: [
      `${angleWords} for beginners`,
      `how to start ${angleWords}`,
      `${angleWords} step by step`,
      `${genre.kind === "fiction" ? "novel" : "workbook"} for self study`,
      "illustrated reference",
      "practical techniques",
      "learn at home",
    ],
  };
}

test("editor prefix carries every chapter's full text, not summaries", () => {
  const chapters = [
    { number: 1, title: "One", summary: "s1", body: "UNIQUE_BODY_ONE and more words." },
    { number: 2, title: "Two", summary: "s2", body: "UNIQUE_BODY_TWO and more words." },
    { number: 3, title: "Three", summary: "s3", body: "UNIQUE_BODY_THREE and more words." },
  ];
  const manuscript = __editor.buildManuscript(chapters);

  for (const c of chapters) {
    assert.ok(manuscript.includes(c.body), `chapter ${c.number} body missing`);
    assert.ok(manuscript.includes(`<<<CHAPTER ${c.number} START>>>`), "missing start marker");
    assert.ok(manuscript.includes(`<<<CHAPTER ${c.number} END>>>`), "missing end marker");
  }
  // Summaries were the old approach; they must not be what the editor reads.
  assert.ok(!manuscript.includes("s1"), "summary leaked into the manuscript");
});

test("editor sees chapters in BOTH directions, not only earlier ones", () => {
  const chapters = [
    { number: 1, title: "One", summary: "", body: "EARLY_TEXT" },
    { number: 2, title: "Two", summary: "", body: "MIDDLE_TEXT" },
    { number: 3, title: "Three", summary: "", body: "LATE_TEXT" },
  ];
  const manuscript = __editor.buildManuscript(chapters);
  // Editing chapter 2 must expose chapter 3, which the old summary-only
  // version could never do.
  assert.ok(manuscript.includes("LATE_TEXT"), "later chapter not visible to the editor");
});

test("deduplication rule is deterministic and stated from both sides", () => {
  const rule = __editor.EDIT_INSTRUCTION;
  // Both branches must be spelled out, or two parallel editors can both cut
  // the same material and it disappears from the book.
  assert.match(rule, /LOWER number keeps it/);
  assert.match(rule, /HIGHER-numbered chapter gives way/);
  assert.match(rule, /leave yours exactly as\s+it is/);
  assert.match(rule, /if you both\s+cut, the book loses the material altogether/);
});

test("window fallback keeps neighbours and drops distant chapters", () => {
  const chapters = Array.from({ length: 20 }, (_, i) => ({
    number: i + 1, title: `C${i + 1}`, summary: "", body: `BODY_${i + 1}`,
  }));
  const window = __editor.buildWindow(chapters, 10);

  assert.ok(window.includes("BODY_10"), "target chapter missing");
  assert.ok(window.includes("BODY_7") && window.includes("BODY_13"), "±3 neighbours missing");
  assert.ok(!window.includes("BODY_6"), "chapter outside the window leaked in");
  assert.ok(!window.includes("BODY_20"), "distant chapter leaked in");
});

test("a normal-length book is never windowed", () => {
  // 12 chapters of 2200 words is the default shape; it must fit comfortably.
  const chapters = Array.from({ length: 12 }, (_, i) => ({
    number: i + 1, title: `C${i + 1}`, summary: "", body: "word ".repeat(2200),
  }));
  const manuscript = __editor.buildManuscript(chapters);
  assert.ok(
    manuscript.length < __editor.MAX_MANUSCRIPT_CHARS,
    `default book would be windowed (${manuscript.length} chars)`,
  );
});

test("scheduler honours midnight instead of silently moving it to 9am", () => {
  // `hour || 9` is falsy-zero bait; 00:xx must stay 00:xx.
  for (const [time, expectedHour, expectedMinute] of [
    ["00:00", 0, 0], ["00:01", 0, 1], ["09:00", 9, 0], ["23:59", 23, 59],
  ]) {
    const at = new Date(nextRunAt({ enabled: true, cadence: "daily", time }, null));
    assert.equal(at.getHours(), expectedHour, `${time} produced hour ${at.getHours()}`);
    assert.equal(at.getMinutes(), expectedMinute, `${time} produced minute ${at.getMinutes()}`);
  }
  // Garbage falls back rather than producing an invalid date.
  assert.equal(new Date(nextRunAt({ enabled: true, cadence: "daily", time: "nonsense" }, null)).getHours(), 9);
});

test("cron guard blocks when the approval backlog is full", () => {
  const state = dueState({ pending: 3, schedule: { maxPending: 3 } });
  const verdict = shouldRun(state);
  assert.equal(verdict.run, false);
  assert.match(verdict.reason, /awaiting approval/);
});

test("cron guard releases once a book is approved", () => {
  const state = dueState({ pending: 2, schedule: { maxPending: 3 } });
  assert.equal(shouldRun(state).run, true, shouldRun(state).reason);
});

test("cron guard blocks when the 30-day budget is spent", () => {
  const state = dueState({ pending: 0, schedule: { monthlyBudgetUsd: 5 } });
  state.runs = [
    { at: Date.now() - 86400000, cost: { usd: 3 } },
    { at: Date.now() - 2 * 86400000, cost: { usd: 2.5 } },
  ];
  const verdict = shouldRun(state);
  assert.equal(verdict.run, false);
  assert.match(verdict.reason, /budget/);
});

test("cron guard ignores spend older than 30 days", () => {
  const state = dueState({ pending: 0, schedule: { monthlyBudgetUsd: 5 } });
  state.runs = [{ at: Date.now() - 40 * 86400000, cost: { usd: 99 } }];
  assert.equal(shouldRun(state).run, true, "stale spend should not block a run");
});

test("cron guard blocks when the schedule is disabled", () => {
  const state = dueState({ pending: 0, schedule: { enabled: false } });
  assert.equal(shouldRun(state).run, false);
  assert.match(shouldRun(state).reason, /disabled/);
});

/** A state whose schedule is due right now, with `pending` unapproved books. */
function dueState({ pending, schedule }) {
  return {
    schedule: {
      enabled: true,
      cadence: "daily",
      time: "00:00",
      maxPending: 3,
      monthlyBudgetUsd: 20,
      ...schedule,
    },
    // No prior run means "due as soon as the time passes"; a run two days ago
    // makes a daily cadence overdue.
    runs: [{ at: Date.now() - 2 * 86400000, cost: { usd: 0 } }],
    books: Array.from({ length: pending }, (_, i) => ({
      id: `b${i}`, status: "awaiting_approval",
    })),
  };
}
test("sample mode writes fewer chapters but plans the whole book", async () => {
  process.env.BOOK_FACTORY_DRY_RUN = "1";
  process.env.BOOK_FACTORY_DATA = await fs.mkdtemp(path.join(os.tmpdir(), "bf-sample-"));

  const { produceBook } = await import(`../src/pipeline.js?sample=${Date.now()}`);
  const book = await produceBook({ genreId: "cooking", chapters: 10, sample: 2 });

  assert.equal(book.chapterCount, 2, "sample wrote the wrong number of chapters");
  assert.deepEqual(book.sample, { chapters: 2, of: 10 }, "sample metadata is wrong");

  // The plan on disk must still describe the whole book, so the full run later
  // writes the same book rather than a different one.
  const plan = JSON.parse(
    await fs.readFile(path.join(process.env.BOOK_FACTORY_DATA, "books", book.id, "plan.json"), "utf8"),
  );
  assert.equal(plan.chapters.length, 10, "sample truncated the stored plan");

  delete process.env.BOOK_FACTORY_DRY_RUN;
  delete process.env.BOOK_FACTORY_DATA;
});

test("a stub fiction listing reads as English, not as a template", () => {
  // "a adventure story" and "A novel of lost city" both shipped into a KDP
  // sheet before these were fixed, and a listing is the first thing a buyer
  // reads.
  const plan = stubPlan({
    genre: { id: "adventure", name: "Adventure", kind: "fiction" },
    angle: "lost city",
    chapters: 3,
  });
  assert.doesNotMatch(plan.audience, /\ba adventure\b/);
  assert.match(plan.audience, /\ban adventure\b/);
  assert.doesNotMatch(plan.subtitle, /novel of lost city/);
});

test("a non-English book is tagged in every place a reader looks", async () => {
  // dc:language alone is not enough: a reading system takes hyphenation, font
  // fallback and the speech voice from the xml:lang on each document.
  const buffer = await buildEpub({
    title: "शीर्षक", subtitle: "उपशीर्षक", author: "लेखक", description: "विवरण",
    language: "hi",
    chapters: [{ number: 1, title: "पहला अध्याय", body: "नमस्ते।" }],
    figures: new Map(),
  });

  const zip = await JSZip.loadAsync(buffer);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /<dc:language>hi<\/dc:language>/);
  assert.match(opf, /xml:lang="hi"/);

  for (const name of ["OEBPS/title.xhtml", "OEBPS/chap001.xhtml", "OEBPS/nav.xhtml"]) {
    const doc = await zip.file(name).async("string");
    assert.match(doc, /lang="hi"/, `${name} is not tagged as Hindi`);
    assert.doesNotMatch(doc, /lang="en"/, `${name} is still tagged as English`);
  }
});

test("the book's own furniture is translated, not left in English", async () => {
  const buffer = await buildEpub({
    title: "शीर्षक", author: "लेखक", language: "hi",
    chapters: [{ number: 3, title: "तीसरा", body: "पाठ।" }],
    figures: new Map(),
  });
  const zip = await JSZip.loadAsync(buffer);

  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /विषय-सूची/);
  assert.doesNotMatch(nav, />Contents</);

  const chapter = await zip.file("OEBPS/chap001.xhtml").async("string");
  assert.match(chapter, /अध्याय 3/);
  assert.doesNotMatch(chapter, /Chapter 3/);
});

test("an unlabelled language falls back to English rather than guessing", async () => {
  // Better a Swedish book that says "Chapter" than one that says a word no
  // one checked.
  const buffer = await buildEpub({
    title: "T", author: "A", language: "sv",
    chapters: [{ number: 1, title: "Ett", body: "Hej." }],
    figures: new Map(),
  });
  const zip = await JSZip.loadAsync(buffer);
  const chapter = await zip.file("OEBPS/chap001.xhtml").async("string");
  assert.match(chapter, /Chapter 1/);
  assert.match(chapter, /lang="sv"/);   // still tagged correctly
});

test("a right-to-left language sets the text direction", async () => {
  const buffer = await buildEpub({
    title: "ع", author: "ع", language: "ar", rtl: true,
    chapters: [{ number: 1, title: "الفصل", body: "نص." }],
    figures: new Map(),
  });
  const zip = await JSZip.loadAsync(buffer);
  assert.match(await zip.file("OEBPS/chap001.xhtml").async("string"), /dir="rtl"/);
});

test("the kdp sheet names the book's language and asks you to confirm it", () => {
  const book = baseBook({ genre: "cooking" });
  book.language = "hi";
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.match(pack.markdown, /\| Language \| Hindi \(हिन्दी\) \|/);
  assert.match(pack.markdown, /Confirm \*\*Hindi\*\* appears in KDP's Language dropdown/);
});

test("the kdp sheet stays English-clean for an English book", () => {
  const pack = buildKdpPack({ book: baseBook({ genre: "cooking" }), epubName: "x.epub" });
  assert.match(pack.markdown, /\| Language \| English \|/);
  assert.doesNotMatch(pack.markdown, /Language dropdown/);
});

test("an unknown language is a warning, not a silent English book", () => {
  const book = baseBook({ genre: "cooking" });
  book.language = "klingon";
  const pack = buildKdpPack({ book, epubName: "x.epub" });
  assert.ok(pack.warnings.some((w) => /Unknown language "klingon"/.test(w)));
});

test("a share link resolves only for its own token", () => {
  const { token: a } = mintLink("bk_a");
  const { token: b } = mintLink("bk_b");
  assert.equal(__share.resolve(a).bookId, "bk_a");
  assert.equal(__share.resolve(b).bookId, "bk_b");
  assert.equal(__share.resolve("0".repeat(32)), null);
  // Shapes that are not a token at all never reach the map.
  for (const junk of ["", "abc", "../../etc/passwd", "ZZ".repeat(16), null, 42]) {
    assert.equal(__share.resolve(junk), null, `resolved junk: ${junk}`);
  }
});

test("a share link stops working when it expires", () => {
  const { token } = mintLink("bk_x", -1);   // already expired
  assert.equal(__share.resolve(token), null);
});

test("a revoked share link stops working immediately", () => {
  const { token } = mintLink("bk_y");
  assert.ok(__share.resolve(token));
  assert.equal(revokeLink(token), true);
  assert.equal(__share.resolve(token), null);
});

test("the share server refuses every write, whatever the path", async () => {
  // Not "the write routes are guarded" - there are none. This probes the
  // property that makes it safe to put on a LAN at all, by asking the running
  // server rather than by grepping its source.
  const server = createShareServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = mintLink("bk_probe");

  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [`/s/${token}`, "/api/state", "/api/books/bk_probe/approve",
                          "/api/books/bk_probe/publish", "/api/generate"]) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 405, `${method} ${path} returned ${res.status}, not 405`);
      }
      // The single exception is submitting a passcode, and only by POST.
      if (method !== "POST") {
        const res = await fetch(`${base}/s/${token}/unlock`, { method });
        assert.equal(res.status, 405, `${method} on unlock returned ${res.status}`);
      }
    }

    // And a GET outside the three read routes is simply not there.
    for (const path of ["/api/state", "/library/bk_probe/x.epub", "/", "/review.html"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `GET ${path} returned ${res.status}`);
    }
  } finally {
    server.close();
  }
});

test("the share certificate covers every address a phone might use", () => {
  const { key, cert, fingerprint } = makeCertificate(["192.168.1.14", "10.0.0.5"]);
  const x = new X509Certificate(cert);

  for (const address of ["127.0.0.1", "192.168.1.14", "10.0.0.5"]) {
    assert.match(x.subjectAltName, new RegExp(address.replace(/\./g, "\\.")),
      `${address} is missing from the certificate, so a phone there would refuse outright`);
  }

  // The fingerprint the command prints has to be the one the phone will show.
  assert.equal(fingerprint, x.fingerprint256);
  assert.match(key, /-----BEGIN PRIVATE KEY-----/);

  // Short-lived by construction: it is thrown away with the session.
  assert.ok(new Date(x.validTo) - new Date(x.validFrom) <= 2 * 86400000);
});

test("the share private key is not left on disk", () => {
  const before = fsSync.readdirSync(os.tmpdir()).filter((f) => f.startsWith("book-factory-share-"));
  makeCertificate(["192.168.1.14"]);
  const after = fsSync.readdirSync(os.tmpdir()).filter((f) => f.startsWith("book-factory-share-"));
  assert.deepEqual(after, before, "a temp directory holding the key survived");
});

test("every share response carries the headers that keep the link private", async () => {
  const { key, cert } = makeCertificate([]);
  const server = createShareServer({ key, cert });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { token } = mintLink("bk_headers");

  // A throwaway certificate is untrusted by definition, so this goes through
  // node:https rather than fetch: the point is the headers, not the chain.
  const head = (path) =>
    new Promise((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.headers);
        })
        .on("error", reject);
    });

  try {
    for (const path of [`/s/${token}`, `/s/${token}/epub`, "/nope"]) {
      const headers = await head(path);
      assert.match(headers["cache-control"] || "", /no-store/, `${path} is cacheable`);
      assert.equal(headers["referrer-policy"], "no-referrer", `${path} could leak the token`);
      assert.equal(headers["x-content-type-options"], "nosniff", `${path} allows sniffing`);
    }
  } finally {
    server.close();
  }
});

test("the share server still works without TLS, for a trusted network", async () => {
  // --insecure is a deliberate fallback for someone with no openssl; it must
  // keep every other guarantee.
  const server = createShareServer(null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/s/${"0".repeat(32)}`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const write = await fetch(`${base}/api/books/x/publish`, { method: "POST" });
    assert.equal(write.status, 405);
  } finally {
    server.close();
  }
});

test("a share link shows nothing about the book without the passcode", async () => {
  const server = createShareServer(null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = mintLink("bk_mubd0w9f");

  try {
    for (const path of ["", "/read", "/epub"]) {
      const res = await fetch(`${base}/s/${token}${path}`);
      const body = await res.text();
      assert.match(body, /Enter the passcode/, `${path || "/"} skipped the gate`);
      // Not even the title leaks: whoever is looking has not proved they may see it.
      assert.doesNotMatch(body, /One Pan/, `${path || "/"} leaked the book's title`);
    }
  } finally {
    server.close();
  }
});

test("the right passcode opens the book, and the cookie is scoped and locked down", async () => {
  const server = createShareServer(null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token, passcode } = mintLink("bk_mubd0w9f");

  try {
    const res = await fetch(`${base}/s/${token}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode }),
      redirect: "manual",
    });
    assert.equal(res.status, 303);

    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/, "the cookie is readable by script");
    assert.match(cookie, /SameSite=Strict/, "the cookie rides cross-site requests");
    assert.match(cookie, new RegExp(`Path=/s/${token}`), "the cookie is not scoped to this link");

    const value = cookie.match(/bf_share=([0-9a-f]+)/)[1];
    const book = await fetch(`${base}/s/${token}`, { headers: { cookie: `bf_share=${value}` } });
    assert.match(await book.text(), /One Pan/, "the passcode did not open the book");
  } finally {
    server.close();
  }
});

test("one link's session does not open another link", async () => {
  const server = createShareServer(null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mine = mintLink("bk_mubd0w9f");
  const theirs = mintLink("bk_mubd0w9f");

  try {
    const res = await fetch(`${base}/s/${mine.token}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: mine.passcode }),
      redirect: "manual",
    });
    const value = res.headers.get("set-cookie").match(/bf_share=([0-9a-f]+)/)[1];

    const other = await fetch(`${base}/s/${theirs.token}`, { headers: { cookie: `bf_share=${value}` } });
    assert.match(await other.text(), /Enter the passcode/, "a session opened someone else's link");
  } finally {
    server.close();
  }
});

test("five wrong passcodes destroy the link rather than locking it", async () => {
  // A locked link is something an attacker can keep poking at. Destroying it
  // costs you one command and costs them everything.
  const server = createShareServer(null);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token, passcode } = mintLink("bk_mubd0w9f");
  const wrong = passcode === "000000" ? "111111" : "000000";

  const guess = (code) =>
    fetch(`${base}/s/${token}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: code }),
      redirect: "manual",
    });

  try {
    for (let i = 1; i <= __share.MAX_ATTEMPTS - 1; i++) {
      const res = await guess(wrong);
      assert.equal(res.status, 401, `attempt ${i} should be refused`);
      assert.match(await res.text(), /attempt.? left/, "the page does not say how many tries remain");
    }

    const last = await guess(wrong);
    assert.equal(last.status, 404, "the final wrong guess should destroy the link");

    // Even the real passcode is no good now: the link is gone.
    assert.equal((await guess(passcode)).status, 404);
    assert.equal(__share.resolve(token), null);
  } finally {
    server.close();
  }
});

test("passcodes are six digits and not predictable", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const { passcode } = mintLink("bk_rand");
    assert.match(passcode, /^\d{6}$/, `bad passcode shape: ${passcode}`);
    seen.add(passcode);
  }
  // 200 draws from a million: a generator stuck in a rut shows up here.
  assert.ok(seen.size > 190, `only ${seen.size} distinct passcodes in 200 draws`);
});

test("delivered folder names survive both filesystems", () => {
  // Windows forbids these outright; a trailing dot or space is silently
  // dropped, which would make the next delivery create a second folder.
  assert.equal(safeName('A/B\\C:D*E?F"G<H>I|J'), "A-B-C-D-E-F-G-H-I-J");
  assert.equal(safeName("Trailing dot."), "Trailing dot");
  assert.equal(safeName("Trailing space   "), "Trailing space");
  assert.equal(safeName("  padded  out  "), "padded out");
  assert.equal(safeName(""), "untitled");
  assert.ok(safeName("x".repeat(200)).length <= 80);
});

test("a delivered folder is dated and titled, so Drive sorts it usefully", () => {
  const name = folderNameFor({ title: "Nine Days: Above the Treeline", createdAt: Date.parse("2026-09-22T10:00:00Z") });
  assert.equal(name, "2026-09-22 — Nine Days- Above the Treeline");
});

test("delivery copies every artifact and adds a plain-language note", async () => {
  const { dir, bookId, target } = await stubLibrary();
  try {
    const result = await deliverBook({ id: bookId, target, log: () => {} });
    assert.equal(result.delivered, true);

    const landed = await fs.readdir(result.where);
    for (const name of ["book.epub", "KDP-UPLOAD-SHEET.md", "cover.svg", "manuscript.md"]) {
      assert.ok(landed.includes(name), `${name} did not arrive`);
    }

    // The note has to answer "what is this and what do I do with it" for
    // someone opening the folder on a phone three weeks later.
    const note = await fs.readFile(path.join(result.where, "ABOUT-THIS-BOOK.txt"), "utf8");
    assert.match(note, /Stub Title/);
    assert.match(note, /NOTHING IS PUBLISHED YET/);
    assert.match(note, /approve bk_stub/);
    assert.match(note, /KDP-UPLOAD-SHEET/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("delivery warns about a price outside the royalty band", async () => {
  const { dir, bookId, target } = await stubLibrary({ priceUsd: 14.99 });
  try {
    const result = await deliverBook({ id: bookId, target, log: () => {} });
    const note = await fs.readFile(path.join(result.where, "ABOUT-THIS-BOOK.txt"), "utf8");
    assert.match(note, /35%/);
    assert.match(note, /outside the \$2\.99-\$9\.99 band/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("delivering twice updates in place rather than piling up folders", async () => {
  const { dir, bookId, target } = await stubLibrary();
  try {
    const first = await deliverBook({ id: bookId, target, log: () => {} });
    const second = await deliverBook({ id: bookId, target, log: () => {} });
    assert.equal(first.where, second.where);
    assert.equal((await fs.readdir(target)).length, 1, "a second folder appeared");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a missing Drive folder fails loudly instead of faking a local one", async () => {
  // If the sync client is off or the path has a typo, mkdir -p would happily
  // create an ordinary folder that never syncs - and you would believe your
  // books were in the cloud for as long as it took to notice.
  const { dir, bookId } = await stubLibrary();
  const ghost = path.join(dir, "no", "such", "place");
  const lines = [];
  try {
    const result = await deliverBook({ id: bookId, target: ghost, log: (l) => lines.push(l) });
    assert.equal(result.delivered, false);
    assert.match(result.reason, /is the sync client running\?/);
    assert.equal(fsSync.existsSync(ghost), false, "it created the folder anyway");

    // And it must say where the book actually is, and how to retry.
    assert.match(lines.join("\n"), /The book is safe in/);
    assert.match(lines.join("\n"), /deliver bk_stub/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("delivery is off, not broken, when no target is configured", async () => {
  const result = await deliverBook({ id: "bk_nope", target: null });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /BOOK_FACTORY_DELIVER_TO/);
});

/** A throwaway library with one book on disk, and somewhere to deliver it. */
async function stubLibrary({ priceUsd = 9.99 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-deliver-"));
  process.env.BOOK_FACTORY_DATA = dir;

  const bookId = "bk_stub";
  const book = {
    id: bookId, title: "Stub Title", subtitle: "A subtitle", status: "awaiting_approval",
    genreName: "Cooking", language: "en", wordCount: 1200, chapterCount: 2,
    createdAt: Date.parse("2026-09-22T10:00:00Z"), epubFile: "book.epub",
    listing: { priceUsd }, cost: { usd: 0.42 },
  };

  await fs.mkdir(path.join(dir, "books", bookId), { recursive: true });
  for (const [name, body] of [["book.epub", "x"], ["KDP-UPLOAD-SHEET.md", "# sheet"],
                              ["cover.svg", "<svg/>"], ["manuscript.md", "# ch"]]) {
    await fs.writeFile(path.join(dir, "books", bookId, name), body);
  }
  await fs.writeFile(path.join(dir, "library.json"),
    JSON.stringify({ version: 1, books: [book], genreHistory: [], schedule: null, runs: [] }));

  const target = path.join(dir, "Drive");
  await fs.mkdir(target, { recursive: true });
  return { dir, bookId, target };
}

test("a manuscript splits back into the chapters it was written from", () => {
  // The file you edit IS the source, so this has to survive a round trip.
  const md = ["# Chapter 1: The Opening", "", "First body.", "", "---", "",
              "# Chapter 2: The Middle", "", "Second body.\n\nWith two paragraphs."].join("\n");
  const chapters = parseManuscript(md);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "Chapter 1: The Opening");
  assert.equal(chapters[0].body, "First body.");
  assert.equal(chapters[1].number, 2);
  assert.match(chapters[1].body, /two paragraphs/);
});

test("an edited manuscript keeps writing whose heading was reformatted", () => {
  // Dropping a chapter because someone changed its title line would lose work
  // silently, which is the worst way to lose it.
  const chapters = parseManuscript("# Kept\n\nBody one.\n\n---\n\nNo heading here, just prose.");
  assert.equal(chapters.length, 2);
  assert.equal(chapters[1].body, "No heading here, just prose.");
  assert.equal(chapters[1].title, "Chapter 2");
});

test("adding or removing a chapter in the file changes the book", () => {
  const three = parseManuscript(["# A", "", "a", "", "---", "", "# B", "", "b", "", "---", "", "# C", "", "c"].join("\n"));
  assert.equal(three.length, 3);
  assert.deepEqual(three.map((c) => c.number), [1, 2, 3]);

  const one = parseManuscript("# Only\n\njust this");
  assert.equal(one.length, 1);
});

test("an empty manuscript yields nothing rather than a phantom chapter", () => {
  assert.deepEqual(parseManuscript(""), []);
  assert.deepEqual(parseManuscript("\n\n---\n\n"), []);
});

test("rebuilding an edited manuscript puts the new words in the EPUB", async () => {
  const { dir, bookId } = await rebuildFixture();
  try {
    await fs.writeFile(
      path.join(dir, "books", bookId, "manuscript.md"),
      "# Chapter 1: Fixed\n\nThe corrected sentence.\n\n---\n\n# Chapter 2: Also fixed\n\nMore corrected text.",
    );

    const result = await rebuildBook({ id: bookId });
    assert.equal(result.chapters, 2);

    const zip = await JSZip.loadAsync(await fs.readFile(path.join(dir, "books", bookId, "book.epub")));
    const first = await zip.file("OEBPS/chap001.xhtml").async("string");
    assert.match(first, /The corrected sentence/);
    assert.doesNotMatch(first, /original wording/, "the EPUB still carries the text you replaced");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a rebuild updates the counts the dashboard reports", async () => {
  const { dir, bookId } = await rebuildFixture();
  try {
    await fs.writeFile(path.join(dir, "books", bookId, "manuscript.md"), "# Only one now\n\nShort.");
    await rebuildBook({ id: bookId });

    const state = JSON.parse(await fs.readFile(path.join(dir, "library.json"), "utf8"));
    const book = state.books.find((b) => b.id === bookId);
    assert.equal(book.chapterCount, 1, "chapter count did not follow the edit");
    assert.equal(book.wordCount, 1);
    assert.ok(book.rebuiltAt > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a rebuild re-attaches figures already on disk rather than losing them", async () => {
  const { dir, bookId } = await rebuildFixture();
  try {
    await fs.writeFile(path.join(dir, "books", bookId, "fig-001.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await rebuildBook({ id: bookId });

    const zip = await JSZip.loadAsync(await fs.readFile(path.join(dir, "books", bookId, "book.epub")));
    assert.ok(zip.file("OEBPS/fig-001.svg"), "the figure was dropped by the rebuild");
    const opf = await zip.file("OEBPS/content.opf").async("string");
    assert.match(opf, /fig-001\.svg/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an edit after the build is detectable, and a rebuild clears it", async () => {
  // This is what stops you publishing the version you meant to fix.
  const { dir, bookId } = await rebuildFixture();
  try {
    assert.equal(await manuscriptIsNewer(bookId, "book.epub"), false, "flagged a book nobody had touched");

    const later = new Date(Date.now() + 10_000);
    await fs.writeFile(path.join(dir, "books", bookId, "manuscript.md"), "# Edited\n\nNew words.");
    await fs.utimes(path.join(dir, "books", bookId, "manuscript.md"), later, later);
    assert.equal(await manuscriptIsNewer(bookId, "book.epub"), true, "did not notice the edit");

    await rebuildBook({ id: bookId });
    assert.equal(await manuscriptIsNewer(bookId, "book.epub"), false, "still flagged after rebuilding");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A library holding one built book, ready to be edited. */
async function rebuildFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-rebuild-"));
  process.env.BOOK_FACTORY_DATA = dir;

  const bookId = "bk_rebuild";
  const chapters = [
    { number: 1, title: "Chapter 1: Start", body: "The original wording." },
    { number: 2, title: "Chapter 2: Next", body: "More original wording." },
  ];

  await fs.mkdir(path.join(dir, "books", bookId), { recursive: true });
  await fs.writeFile(
    path.join(dir, "books", bookId, "manuscript.md"),
    chapters.map((c) => `# ${c.title}\n\n${c.body}`).join("\n\n---\n\n"),
  );

  const epub = await buildEpub({
    title: "Rebuild Fixture", subtitle: "s", author: "A", language: "en",
    description: "d", chapters, figures: new Map(),
  });
  await fs.writeFile(path.join(dir, "books", bookId, "book.epub"), epub);

  const book = {
    id: bookId, uuid: "11111111-1111-1111-1111-111111111111",
    title: "Rebuild Fixture", subtitle: "s", author: "A", language: "en",
    status: "awaiting_approval", epubFile: "book.epub", epubBytes: epub.length,
    chapterCount: 2, wordCount: 6, figureCount: 0,
    listing: { description: "d", priceUsd: 9.99, coverBrief: {} },
    cost: { usd: 0 }, createdAt: Date.now(), updatedAt: Date.now(),
  };
  await fs.writeFile(path.join(dir, "library.json"),
    JSON.stringify({ version: 1, books: [book], genreHistory: [], schedule: null, runs: [] }));

  return { dir, bookId };
}

test("cached tokens are priced, not counted as free", () => {
  // The bug this covers: cache reads were tallied but never charged, and
  // cache writes were not read from the usage at all - so the editorial
  // pass, which caches the whole manuscript, reported $0.00.
  __model.spend.usd = 0;
  __model.spend.cacheReadTokens = 0;
  __model.spend.cacheWriteTokens = 0;

  __model.__test.recordUsage({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  });

  // Sonnet 5 input is $2/MTok: a megatoken written (1.25x) plus a megatoken
  // read (0.1x) is $2.50 + $0.20.
  assert.equal(Number(__model.spend.usd.toFixed(4)), 2.7);
  assert.equal(__model.spend.cacheWriteTokens, 1_000_000);
  assert.equal(__model.spend.cacheReadTokens, 1_000_000);
});

test("a one-hour cache entry costs more than a five-minute one", () => {
  __model.spend.usd = 0;
  __model.__test.recordUsage({
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 },
  });
  assert.equal(Number(__model.spend.usd.toFixed(4)), 4);   // 2x of $2
});

test("a write with no breakdown is priced at the cheaper rate, not the dearer", () => {
  // Guessing the one-hour rate would overstate every run this engine makes,
  // since it only ever asks for the default five-minute entry.
  __model.spend.usd = 0;
  __model.__test.recordUsage({
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000,
  });
  assert.equal(Number(__model.spend.usd.toFixed(4)), 2.5);  // 1.25x, not 2x
});

test("the batch discount applies to cached tokens too", () => {
  __model.spend.usd = 0;
  __model.__test.recordUsage(
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
    { batch: true },
  );
  assert.equal(Number(__model.spend.usd.toFixed(4)), 0.1);  // $0.20 halved
});

test("ordinary input and output are still priced as before", () => {
  // The fix must not have moved the numbers that were already right.
  __model.spend.usd = 0;
  __model.__test.recordUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(Number(__model.spend.usd.toFixed(4)), 12);   // $2 in + $10 out
});

test("a book that caches its manuscript no longer reports as free", () => {
  // The shape of a real editorial pass: one big cache write, then a read of
  // the same prefix per chapter. Before the fix this whole thing was $0.00.
  __model.spend.usd = 0;
  __model.__test.recordUsage(
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000 },
    { batch: true },
  );
  for (let chapter = 0; chapter < 12; chapter++) {
    __model.__test.recordUsage(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 },
      { batch: true },
    );
  }
  assert.ok(__model.spend.usd > 0.1, `reported ${__model.spend.usd}, which is still near zero`);
});

test("the engine's royalty table matches the dashboard's", async () => {
  // The dashboard is a static page with no build step, so it cannot import
  // src/royalty.js - the table is duplicated. Two copies that disagree would
  // have the engine quoting one royalty and the page another for the same
  // book, and nothing would notice. This is what notices.
  const appJs = await fs.readFile(new URL("../../assets/app.js", import.meta.url), "utf8");
  const block = appJs.slice(appJs.indexOf("var ROYALTY = {"), appJs.indexOf("};", appJs.indexOf("var ROYALTY = {")));

  for (const [storeId, rule] of Object.entries(ROYALTY)) {
    const line = block.split("\n").find((l) => l.trim().startsWith(`${storeId}:`));
    assert.ok(line, `the dashboard has no royalty rule for ${storeId}`);

    for (const field of ["rate", "lowRate", "bandLow"]) {
      const match = line.match(new RegExp(`${field}:\\s*([0-9.]+)`));
      assert.ok(match, `${storeId}.${field} missing from the dashboard`);
      assert.equal(Number(match[1]), rule[field], `${storeId}.${field} drifted apart`);
    }

    const high = line.match(/bandHigh:\s*([0-9.]+|Infinity)/);
    assert.equal(high[1] === "Infinity" ? Infinity : Number(high[1]), rule.bandHigh,
      `${storeId}.bandHigh drifted apart`);
  }
});

test("break-even is quoted at the price the handoff sheet tells you to use", () => {
  // A $16.99 book would earn 35% on Amazon. The sheet tells you to list it at
  // $9.99, so quoting the 35% figure would be advice against our own advice.
  const rows = breakEven({ costUsd: 5, listPriceUsd: 16.99 });
  const amazon = rows.find((r) => r.store === "amazon");
  assert.equal(amazon.price, 9.99);
  assert.equal(amazon.rate, 0.7);

  const gumroad = rows.find((r) => r.store === "gumroad");
  assert.equal(gumroad.price, 16.99, "Gumroad has no band and should keep the list price");
});

test("break-even rounds up, because half a sale is not a sale", () => {
  const rows = breakEven({ costUsd: 10, listPriceUsd: 9.99 });
  const amazon = rows.find((r) => r.store === "amazon");
  assert.equal(amazon.net, 9.99 * 0.7);
  assert.equal(amazon.copies, 2, "10 / 6.99 is 1.43, which is 2 copies");
});

test("a free book has nothing to recover, and an unsellable one says so", () => {
  const free = breakEven({ costUsd: 0, listPriceUsd: 9.99 });
  assert.ok(free.every((r) => r.copies === 0));

  // No price means no net per sale, and "0 copies" there would be a lie.
  assert.deepEqual(breakEven({ costUsd: 5, listPriceUsd: 0 }), []);
});

test("the monthly total counts only recent runs", () => {
  const now = Date.now();
  const runs = [
    { at: now - 1 * 86400000, cost: { usd: 0.5 } },
    { at: now - 29 * 86400000, cost: { usd: 0.25 } },
    { at: now - 40 * 86400000, cost: { usd: 99 } },   // outside the window
    { at: now - 2 * 86400000 },                        // a run with no cost recorded
  ];
  const month = spentRecently(runs, 30);
  assert.equal(Number(month.usd.toFixed(2)), 0.75);
  assert.equal(month.books, 3);
});

test("the estimate scales with the work asked for", () => {
  const price = { input: 2, output: 10 };
  const two = estimateRun({ chapters: 2, wordsPerChapter: 2200, price });
  const twelve = estimateRun({ chapters: 12, wordsPerChapter: 2200, price });

  assert.ok(twelve.mid > two.mid * 3, "a six-times-longer book should cost far more");
  assert.ok(two.low < two.mid && two.mid < two.high, "the estimate should be a range");
});

test("the estimate halves under the batch discount", () => {
  const price = { input: 2, output: 10 };
  const batched = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, batch: true });
  const realtime = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, batch: false });
  assert.equal(Number((realtime.mid / batched.mid).toFixed(2)), 2);
});

test("the estimate accounts for the cached manuscript the editor reads", () => {
  // Skipping the editorial pass removes both its output and the cache traffic
  // that made the old accounting wrong; the estimate should notice.
  const price = { input: 2, output: 10 };
  const withEdit = estimateRun({ chapters: 12, wordsPerChapter: 2200, price });
  const without = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, editorial: false });
  assert.ok(withEdit.mid > without.mid * 1.5, "the editorial pass is most of the bill");
});

test("a book that cost nothing gets no break-even row", () => {
  // "Breaks even at 0 copies" is noise dressed up as information.
  const free = economicsFor({ book: { cost: { usd: 0 }, listing: { priceUsd: 9.99 } }, runs: [] });
  assert.deepEqual(free.stores, []);

  const paid = economicsFor({ book: { cost: { usd: 0.62 }, listing: { priceUsd: 9.99 } }, runs: [] });
  assert.ok(paid.stores.length > 0);
  assert.equal(paid.stores.find((s) => s.store === "amazon").copies, 1);
});

/* ========================================================================
 * Live runs: progress, pause, resume, and the draft you can take at any point
 * ====================================================================== */

test("progress never exceeds 100 and reaches it exactly when the run is done", () => {
  const run = __runState.emptyRun({ bookId: "bk_x", totalChapters: 4, wordsTarget: 8000 });

  assert.equal(__runState.progressOf(run), 0);

  // Walk every phase at full fraction; the number must climb and stop at 100.
  let last = 0;
  for (const phase of __runState.PHASES) {
    run.phase = phase.id;
    run.phaseFraction = 1;
    const now = __runState.progressOf(run);
    assert.ok(now >= last, `${phase.id} went backwards: ${last} -> ${now}`);
    assert.ok(now <= 100, `${phase.id} exceeded 100: ${now}`);
    last = now;
  }
  assert.equal(last, 100);
});

test("a run with no illustration phase still reaches 100%", () => {
  // Otherwise a --images none run stalls at 89% and finishes, which reads as
  // a bug even though nothing is wrong.
  const run = __runState.emptyRun({
    bookId: "bk_x",
    totalChapters: 4,
    wordsTarget: 8000,
    activePhases: ["planning", "drafting", "editing", "packaging"],
  });
  run.phase = "packaging";
  run.phaseFraction = 1;
  assert.equal(__runState.progressOf(run), 100);
});

test("the summary says what is happening, not just that something is", () => {
  const run = __runState.emptyRun({ bookId: "bk_x", totalChapters: 12, wordsTarget: 26400 });
  run.phase = "drafting";
  run.chapters = [{ number: 1, done: true, words: 2100 }, { number: 2 }];
  run.wordsWritten = 2100;
  assert.match(__runState.summaryOf(run), /Writing chapters — 1 of 12 done, 2,100 words so far/);

  run.pauseRequested = true;
  run.currentChapter = 2;
  assert.match(__runState.summaryOf(run), /Finishing chapter 2, then pausing/);

  run.pauseRequested = false;
  run.status = "paused";
  assert.match(__runState.summaryOf(run), /Paused after chapter 1 of 12/);

  run.status = "failed";
  run.error = "the roof fell in";
  assert.equal(__runState.summaryOf(run), "the roof fell in");
});

test("a run is only offered as resumable when there is something to resume", () => {
  const base = { bookId: "bk_x", totalChapters: 2, wordsTarget: 100, chapters: [], log: [], wordsWritten: 0 };

  assert.equal(__runState.publicView({ ...base, status: "running" }).resumable, false);
  assert.equal(__runState.publicView({ ...base, status: "done" }).resumable, false);
  assert.equal(__runState.publicView({ ...base, status: "paused" }).resumable, true);
  assert.equal(__runState.publicView({ ...base, status: "cancelled" }).resumable, true);

  // A run that failed before writing anything has nothing to pick up.
  assert.equal(__runState.publicView({ ...base, status: "failed" }).resumable, false);
  assert.equal(
    __runState.publicView({ ...base, status: "failed", chapters: [{ number: 1, done: true }] }).resumable,
    true,
  );
});

test("the download button is only live once a chapter exists", () => {
  const base = { bookId: "bk_x", status: "running", totalChapters: 3, wordsTarget: 0, chapters: [], log: [], wordsWritten: 0 };
  assert.equal(__runState.publicView(base).hasDraft, false);
  assert.equal(
    __runState.publicView({ ...base, chapters: [{ number: 1, done: true }] }).hasDraft,
    true,
  );
});

test("a chapter you edited is labelled yours, above every other state", () => {
  // The editorial pass keys off this, so "edited by you" has to win even when
  // the engine also edited the chapter earlier in the run.
  assert.equal(__runState.chapterState({ done: true, edited: true, humanEdited: true }), "edited-by-you");
  assert.equal(__runState.chapterState({ done: true, edited: true }), "edited");
  assert.equal(__runState.chapterState({ done: true }), "drafted");
  assert.equal(__runState.chapterState({ streaming: true }), "writing");
  assert.equal(__runState.chapterState({}), "waiting");
});

test("a pause written while progress is being written is not lost", async () => {
  // The pipeline patches progress every few hundred milliseconds while the
  // console patches pauseRequested from a request handler. Without the write
  // queue the two interleave and the pause is the one that disappears.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-run-"));
  process.env.BOOK_FACTORY_DATA = dir;

  try {
    await __runState.writeRun(__runState.emptyRun({ bookId: "bk_race", totalChapters: 3, wordsTarget: 100 }));

    const writes = [];
    for (let i = 0; i < 25; i += 1) {
      writes.push(__runState.patchRun("bk_race", (r) => { r.wordsWritten = i; }));
      if (i === 12) writes.push(__runState.patchRun("bk_race", (r) => { r.pauseRequested = true; }));
    }
    await Promise.all(writes);
    await __runState.settle("bk_race");

    const run = await __runState.readRun("bk_race");
    assert.equal(run.pauseRequested, true, "the pause was overwritten by a progress update");
  } finally {
    delete process.env.BOOK_FACTORY_DATA;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a chapter file round-trips, heading and all", () => {
  const parsed = __chapters.parseChapterFile("# The Salt Line\n\nIt began at the water.\n", 3);
  assert.equal(parsed.title, "The Salt Line");
  assert.equal(parsed.body, "It began at the water.");
  assert.equal(parsed.number, 3);
  assert.equal(parsed.words, 5);
});

test("a chapter file with no heading keeps its prose instead of losing it", () => {
  // Somebody editing the file by hand may well delete the heading line. The
  // prose is the part that cost money; a title can be invented, text cannot.
  const parsed = __chapters.parseChapterFile("Just the words, no heading.", 2);
  assert.equal(parsed.body, "Just the words, no heading.");
  assert.equal(parsed.title, "Chapter 2");
});

test("an edit is detected by what the text says, not when the file was touched", () => {
  // Timestamps move for reasons that are not edits - a Drive sync, a resume,
  // a copy between machines. Comparing the text cannot produce a false
  // positive, which is the direction that matters.
  const original = "the engine wrote this";
  const hash = __chapters.hashBody(original);

  assert.equal(__chapters.hashBody("the engine wrote this"), hash, "same text, same hash");
  assert.equal(__chapters.hashBody("  the engine wrote this \n"), hash, "whitespace is not an edit");
  assert.notEqual(__chapters.hashBody("I wrote this"), hash);
});

test("the manuscript assembled from chapters parses back into the same chapters", async () => {
  // rebuild reads manuscript.md; the live pipeline writes chapter files. If
  // the two formats drifted, editing a downloaded manuscript would silently
  // produce a different book.
  const chapters = [
    { number: 1, title: "One", body: "First body.\n\n## A break\n\nMore." },
    { number: 2, title: "Two", body: "Second body." },
  ];
  const manuscript = __chapters.assembleManuscript(chapters);
  const back = parseManuscript(manuscript);

  assert.equal(back.length, 2);
  assert.equal(back[0].title, "One");
  assert.equal(back[1].body, "Second body.");
  assert.match(back[0].body, /## A break/);
});

/* ========================================================================
 * Pictures
 * ====================================================================== */

test("the placeholder provider makes a real PNG, not a promise of one", async () => {
  const image = await __aigen.generateImage({ prompt: "a table by a window", driver: "placeholder" });
  assert.equal(image.mediaType, "image/png");
  assert.ok(__png.isPng(image.data), "not a PNG");

  const size = __png.pngSize(image.data);
  assert.equal(size.width, 768);
  assert.equal(size.height, 512, "figures are 3:2");
});

test("a cover placeholder is portrait, because a landscape cover is not a cover", async () => {
  const image = await __aigen.generateImage({
    prompt: "a door",
    aspect: __aigen.ASPECTS.cover,
    driver: "placeholder",
  });
  const size = __png.pngSize(image.data);
  assert.ok(size.height > size.width, `${size.width}x${size.height}`);
});

test("the same brief makes the same placeholder twice", async () => {
  // Otherwise every rebuild churns the file and the book's bytes change for
  // no reason anyone can see.
  const a = await __aigen.generateImage({ prompt: "identical", driver: "placeholder" });
  const b = await __aigen.generateImage({ prompt: "identical", driver: "placeholder" });
  assert.ok(a.data.equals(b.data));
});

test("with no image key the failure names the keys and costs nothing", () => {
  const saved = { ...process.env };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.BOOK_FACTORY_IMAGE_CONFIG;

  try {
    assert.throws(() => __aigen.pickDriver(), (err) => {
      assert.match(err.message, /Claude cannot generate images/);
      assert.match(err.message, /GOOGLE_API_KEY/);
      assert.match(err.message, /--images placeholder/);
      return true;
    });

    // And the pipeline must refuse before the first token, not after twelve
    // chapters have been written and paid for.
    assert.throws(() => assertUsable("artwork", null), /No image provider is configured/);
    assert.doesNotThrow(() => assertUsable("charts", null));
    assert.doesNotThrow(() => assertUsable("placeholder", null));
  } finally {
    Object.assign(process.env, saved);
  }
});

test("bytes that are not an image never reach a book", async () => {
  // A provider returning an HTML error page with a 200 status is not
  // hypothetical, and an unreadable file inside a published EPUB is a defect
  // a reader photographs for a review.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-img-"));
  const config = path.join(dir, "provider.json");
  await fs.writeFile(config, JSON.stringify({
    url: "http://127.0.0.1:1/never",
    imagePath: "image",
    body: { prompt: "${prompt}" },
  }));

  const saved = process.env.BOOK_FACTORY_IMAGE_CONFIG;
  process.env.BOOK_FACTORY_IMAGE_CONFIG = config;

  try {
    const driver = __aigen.DRIVERS.custom;
    assert.equal(driver.keyFor(), config);
    await assert.rejects(driver.generate({ prompt: "x" }));
  } finally {
    if (saved === undefined) delete process.env.BOOK_FACTORY_IMAGE_CONFIG;
    else process.env.BOOK_FACTORY_IMAGE_CONFIG = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("one picture failing costs you one picture, not the book", async () => {
  // By this point in a run the prose is written and paid for. A refused
  // prompt must not take it down with it.
  const exploding = {
    id: "boom",
    generate: async ({ prompt }) => {
      if (prompt.includes("second")) throw new Error("refused");
      const { encodePng } = __png;
      return { mediaType: "image/png", data: encodePng(8, 8, () => [1, 2, 3]) };
    },
  };

  const result = await __illustrate.illustrate({
    chapters: [{ number: 1 }, { number: 2 }],
    providerId: "placeholder",
    driverId: exploding,
    genre: { kind: "fiction" },
    direction: {
      palette: "grey",
      figures: [
        { number: 1, brief: "the first thing", caption: "One", alt: "A first thing" },
        { number: 2, brief: "the second thing", caption: "Two", alt: "A second thing" },
      ],
    },
  });

  assert.equal(result.figures.size, 1, "the good picture survived");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /chapter 2/);
});

test("an image prompt leads with the subject and always forbids lettering", () => {
  const prompt = __art.buildImagePrompt({
    brief: "A kitchen table at dawn",
    houseStyle: __art.houseStyleFor({ kind: "fiction" }),
    palette: "cold blues",
  });

  // Every image model weights the opening of a prompt most heavily, so the
  // subject goes first and the boilerplate after it.
  assert.ok(prompt.startsWith("A kitchen table at dawn"), prompt.slice(0, 60));
  assert.match(prompt, /no writing of any kind/i);
  assert.match(prompt, /not recognisable as a real individual/i);
  assert.match(prompt, /cold blues/);
});

test("fiction and non-fiction do not get the same look", () => {
  const fiction = __art.houseStyleFor({ kind: "fiction" });
  const nonfiction = __art.houseStyleFor({ kind: "nonfiction" });
  assert.notEqual(fiction, nonfiction);
  assert.match(fiction, /cinematic/i);
  assert.match(nonfiction, /editorial/i);
  // Both must ask for a photograph rather than an illustration, which is what
  // "realistic" actually means to an image model.
  assert.match(fiction, /photograph/i);
  assert.match(nonfiction, /photograph/i);
});

test("the cover brief leaves room for the title", () => {
  const prompt = __art.buildCoverPrompt({ brief: "A lighthouse", houseStyle: "x", palette: "y" });
  assert.match(prompt, /upper third/i);
  assert.match(prompt, /thumbnail/i);
  assert.match(prompt, /no writing of any kind/i);
});

test("the cover typesets the title itself rather than trusting the image model", async () => {
  // Image models still render lettering as convincing nonsense. A cover whose
  // title is misspelled is unsellable, and this is the only way to be sure.
  const art = __png.encodePng(40, 60, () => [10, 20, 30]);
  const svg = renderPhotoCover({ title: "The Salt Line", subtitle: "A novel", author: "A N Other", image: art });

  assert.match(svg, /<image /, "the artwork is embedded");
  assert.match(svg, /data:image\/png;base64,/, "and embedded inline, not referenced");
  assert.match(svg, /<text[^>]*>The Salt<\/text>/, "the title is real vector text");
  assert.match(svg, /preserveAspectRatio="xMidYMid slice"/, "artwork fills rather than stretches");
});

/* ========================================================================
 * What the book declares, and what it costs
 * ====================================================================== */

test("a book with generated pictures declares them, and one without does not", () => {
  assert.match(disclosureFor({ imagesGenerated: true }), /AI-generated images/);
  assert.doesNotMatch(disclosureFor({ imagesGenerated: false }), /images/);
});

test("the KDP sheet answers the images question separately from the text one", () => {
  // KDP asks about text and images separately. A declaration covering only
  // the text is an incomplete answer to a question you must answer.
  const book = {
    id: "bk_1",
    title: "T",
    subtitle: "S",
    author: "A",
    language: "en",
    wordCount: 1000,
    chapterCount: 2,
    figureCount: 2,
    imagesGenerated: true,
    aiDisclosure: disclosureFor({ imagesGenerated: true }),
    listing: { description: "d", keywords: ["a"], categories: ["x"], priceUsd: 9.99, blurb: "b" },
  };

  const withArt = buildKdpPack({ book, epubName: "b.epub" }).markdown;
  assert.match(withArt, /\*\*and images\*\*/);
  assert.match(withArt, /AI-generated artwork, including the cover/);
  assert.match(withArt, /cover-art\.png` is the raw artwork \*\*without\*\* the title/);

  const charts = buildKdpPack({
    book: { ...book, imagesGenerated: false, aiDisclosure: disclosureFor({ imagesGenerated: false }) },
    epubName: "b.epub",
  }).markdown;
  assert.match(charts, /generated charts, not AI-generated art/);
  assert.doesNotMatch(charts, /cover-art\.png/);
});

test("live mode is priced as the full-rate run it is", () => {
  const price = { input: 2, output: 10 };
  const batch = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, batch: true });
  const live = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, batch: false });

  // The batch discount is exactly half, so quoting live at batch rates would
  // understate what you are about to spend by a factor of two.
  assert.ok(Math.abs(live.mid - batch.mid * 2) < 1e-9, `${live.mid} vs ${batch.mid}`);
});

test("pictures are a separate line on the estimate, not folded into the tokens", () => {
  const price = { input: 2, output: 10 };
  const bare = estimateRun({ chapters: 12, wordsPerChapter: 2200, price });
  const illustrated = estimateRun({ chapters: 12, wordsPerChapter: 2200, price, images: 13, imageCostUsd: 0.04 });

  assert.equal(illustrated.imageCount, 13);
  assert.ok(Math.abs(illustrated.images - 0.52) < 1e-9);
  // A fixed per-image price is known exactly, so it must not be widened by the
  // band that exists only because output length is the model's choice.
  assert.ok(Math.abs((illustrated.high - bare.high) - 0.52) < 1e-9);
  assert.ok(Math.abs((illustrated.low - bare.low) - 0.52) < 1e-9);
});

test("phases match the run that will actually happen", () => {
  assert.deepEqual(
    __pipeline.phasesFor({ images: "none", editorial: true }),
    ["planning", "drafting", "editing", "packaging"],
  );
  // Charts need no art direction; artwork does.
  assert.ok(!__pipeline.phasesFor({ images: "charts", editorial: true }).includes("briefing"));
  assert.ok(__pipeline.phasesFor({ images: "artwork", editorial: true }).includes("briefing"));
  assert.ok(!__pipeline.phasesFor({ images: "charts", editorial: false }).includes("editing"));
});

test("a draft download says inside the file that it is a draft", async () => {
  // Filenames are lost the moment a file is forwarded or synced. Someone
  // opening this on a phone has to be able to tell it is unfinished.
  const epub = await buildEpub({
    title: "Half a Book",
    author: "A",
    language: "en",
    chapters: [{ number: 1, title: "One", body: "Words." }],
    figures: new Map(),
    draft: "Draft — 1 of 12 chapters. Not the finished book.",
  });

  const zip = await JSZip.loadAsync(epub);
  const title = await zip.file("OEBPS/title.xhtml").async("string");
  assert.match(title, /draft-banner/);
  assert.match(title, /1 of 12 chapters/);
});

test("alt text and the caption are allowed to say different things", async () => {
  // A caption repeated as alt text tells a reader using a screen reader
  // nothing they did not already have.
  const epub = await buildEpub({
    title: "T",
    author: "A",
    language: "en",
    chapters: [{ number: 1, title: "One", body: "Words.\n\n## Break\n\nMore." }],
    figures: new Map([
      [1, {
        id: "fig-001",
        filename: "fig-001.png",
        mediaType: "image/png",
        data: __png.encodePng(4, 4, () => [0, 0, 0]),
        alt: "A wooden table under a window, early light",
        caption: "The table",
      }],
    ]),
  });

  const zip = await JSZip.loadAsync(epub);
  const chapter = await zip.file("OEBPS/chap001.xhtml").async("string");
  assert.match(chapter, /alt="A wooden table under a window, early light"/);
  assert.match(chapter, /<figcaption>The table<\/figcaption>/);
});

test("a rebuild keeps the artwork and the cover it was made with", async () => {
  // rebuild runs after an edit, which is exactly when nobody is looking for
  // the pictures to vanish.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-rebuild-"));
  process.env.BOOK_FACTORY_DATA = dir;

  try {
    const bookDir = path.join(dir, "books", "bk_art");
    await fs.mkdir(path.join(bookDir, "figures"), { recursive: true });
    await fs.writeFile(path.join(bookDir, "manuscript.md"), "# One\n\nFirst.\n\n---\n\n# Two\n\nSecond.");
    await fs.writeFile(path.join(bookDir, "figures", "fig-001.png"), __png.encodePng(6, 6, () => [9, 9, 9]));
    await fs.writeFile(path.join(bookDir, "cover-art.png"), __png.encodePng(6, 9, () => [4, 4, 4]));
    await fs.writeFile(path.join(bookDir, "art.json"), JSON.stringify({
      palette: "grey",
      coverBrief: "a door",
      coverAlt: "A door",
      figures: [{ number: 1, brief: "a table", caption: "The table", alt: "A wooden table" }],
    }));

    await fs.writeFile(path.join(dir, "library.json"), JSON.stringify({
      version: 1,
      books: [{
        id: "bk_art",
        uuid: "u",
        title: "T",
        subtitle: "S",
        author: "A",
        language: "en",
        chapterCount: 2,
        wordCount: 2,
        figureCount: 1,
        imagesGenerated: true,
        aiDisclosure: disclosureFor({ imagesGenerated: true }),
        epubFile: "t.epub",
        listing: { description: "d" },
      }],
      genreHistory: [],
      schedule: null,
      runs: [],
    }));

    await rebuildBook({ id: "bk_art" });

    const zip = await JSZip.loadAsync(await fs.readFile(path.join(bookDir, "t.epub")));
    const names = Object.keys(zip.files);
    assert.ok(names.includes("OEBPS/fig-001.png"), `artwork dropped: ${names.join(", ")}`);

    const chapter = await zip.file("OEBPS/chap001.xhtml").async("string");
    assert.match(chapter, /alt="A wooden table"/, "alt text came from art.json, not invented");
    assert.match(chapter, /<figcaption>The table<\/figcaption>/);

    const cover = await zip.file("OEBPS/cover.svg").async("string");
    assert.match(cover, /<image /, "the photographic cover was replaced by the plain one");

    const title = await zip.file("OEBPS/title.xhtml").async("string");
    assert.match(title, /AI-generated images/, "the rebuild narrowed the disclosure");
  } finally {
    delete process.env.BOOK_FACTORY_DATA;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the Google driver sends the request shape Google's own schema describes", async () => {
  // Request and response shapes here were read from Google's live API
  // discovery document, not recalled. This test pins them, so a guess can
  // never quietly replace the verified thing.
  let seen = null;
  const png = __png.encodePng(8, 12, () => [7, 7, 7]);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = {
      url: req.url,
      key: req.headers["x-goog-api-key"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }],
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = { ...process.env };
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_API_KEY = "test-key";

  try {
    const image = await __aigen.DRIVERS.google.generate({ prompt: "a lighthouse", aspect: "2:3", size: "2K" });

    assert.match(seen.url, /\/v1beta\/models\/gemini-2\.5-flash-image:generateContent$/);
    assert.equal(seen.key, "test-key", "the key goes in the header, never the query string");
    assert.deepEqual(seen.body.contents, [{ role: "user", parts: [{ text: "a lighthouse" }] }]);
    assert.deepEqual(seen.body.generationConfig.responseModalities, ["IMAGE"]);
    assert.deepEqual(seen.body.generationConfig.imageConfig, { aspectRatio: "2:3", imageSize: "2K" });

    assert.equal(image.mediaType, "image/png");
    assert.deepEqual(__png.pngSize(image.data), { width: 8, height: 12 });
  } finally {
    Object.assign(process.env, saved);
    delete process.env.GOOGLE_API_BASE_URL;
    server.close();
  }
});

test("a refusal from the image API is reported, not silently swallowed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ finishReason: "SAFETY", finishMessage: "blocked" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const saved = { ...process.env };
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_API_KEY = "test-key";

  try {
    await assert.rejects(
      () => __aigen.DRIVERS.google.generate({ prompt: "x" }),
      /SAFETY/,
    );
  } finally {
    Object.assign(process.env, saved);
    delete process.env.GOOGLE_API_BASE_URL;
    server.close();
  }
});

test("an error page returned with a 200 never becomes a picture in a book", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Base64 of "<html>not an image</html>" - a 200, valid JSON, and junk.
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("<html>not an image</html>").toString("base64") } }] } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const saved = { ...process.env };
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GOOGLE_API_KEY = "test-key";

  try {
    await assert.rejects(
      () => __aigen.DRIVERS.google.generate({ prompt: "x" }),
      /neither PNG nor JPEG/,
    );
  } finally {
    Object.assign(process.env, saved);
    delete process.env.GOOGLE_API_BASE_URL;
    server.close();
  }
});

test("a custom provider is described by a file, and its key stays in the environment", async () => {
  let seen = null;
  const png = __png.encodePng(5, 5, () => [3, 3, 3]);

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen = { auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ images: [{ b64: png.toString("base64") }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-custom-"));
  const config = path.join(dir, "provider.json");
  await fs.writeFile(config, JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}/generate`,
    headers: { Authorization: "Bearer ${MY_IMAGE_KEY}" },
    body: { prompt: "${prompt}", aspect_ratio: "${aspect}" },
    imagePath: "images.0.b64",
  }));

  const saved = { ...process.env };
  process.env.BOOK_FACTORY_IMAGE_CONFIG = config;
  process.env.MY_IMAGE_KEY = "secret-value";

  try {
    const image = await __aigen.DRIVERS.custom.generate({ prompt: "a pier at night", aspect: "3:2" });

    assert.equal(seen.auth, "Bearer secret-value", "the key is read from the environment, not the file");
    assert.equal(seen.body.prompt, "a pier at night");
    assert.equal(seen.body.aspect_ratio, "3:2");
    assert.ok(__png.isPng(image.data));

    // The config file itself must be safe to keep in a repo.
    assert.doesNotMatch(await fs.readFile(config, "utf8"), /secret-value/);
  } finally {
    Object.assign(process.env, saved);
    delete process.env.BOOK_FACTORY_IMAGE_CONFIG;
    delete process.env.MY_IMAGE_KEY;
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ========================================================================
 * The megabyte tax: what an illustrated book actually earns on Amazon
 * ====================================================================== */

test("Amazon's delivery fee is charged per megabyte, on the 70% option only", () => {
  // Twelve photographs turn a 300 KB book into a 20 MB one, and the fee is
  // taken from every sale for as long as the book is listed.
  const light = netPerSale("amazon", 9.99, { fileMb: 0.3 });
  const heavy = netPerSale("amazon", 9.99, { fileMb: 20 });

  assert.ok(Math.abs(light.delivery - 0.045) < 1e-9);
  assert.ok(Math.abs(heavy.delivery - 3.0) < 1e-9);
  assert.ok(Math.abs(heavy.net - (9.99 * 0.7 - 3)) < 1e-9);
  assert.equal(heavy.gross, 9.99 * 0.7, "gross is before delivery, net is after");

  // Outside the band the royalty is 35% and there is no delivery fee at all.
  const outside = netPerSale("amazon", 12.99, { fileMb: 20 });
  assert.equal(outside.rate, 0.35);
  assert.equal(outside.delivery, 0);
});

test("no other storefront charges for the file", () => {
  for (const store of ["gumroad", "play", "other"]) {
    const row = netPerSale(store, 9.99, { fileMb: 40 });
    assert.equal(row.delivery, 0, `${store} invented a delivery fee`);
    assert.equal(row.net, row.gross);
  }
});

test("past a certain size the 35% option genuinely pays more than 70%", () => {
  // The advice everyone gives - always take 70% - stops being true for a
  // heavy file, because 35% carries no delivery fee.
  assert.equal(betterAtLowRate({ price: 9.99, fileMb: 1 }), false);
  assert.equal(betterAtLowRate({ price: 9.99, fileMb: 20 }), false);
  assert.equal(betterAtLowRate({ price: 9.99, fileMb: 30 }), true);

  // And it is never true for a store with no delivery fee to avoid.
  assert.equal(betterAtLowRate({ storeId: "gumroad", price: 9.99, fileMb: 100 }), false);
});

test("a book's own size drives its break-even, not an assumed size", () => {
  const book = {
    cost: { usd: 1.2 },
    listing: { priceUsd: 9.99 },
    epubBytes: 20 * 1024 * 1024,
  };
  const out = economicsFor({ book, runs: [] });

  assert.ok(Math.abs(out.fileMb - 20) < 1e-9);
  assert.ok(Math.abs(out.delivery.usd - 3) < 1e-9);

  const amazon = out.stores.find((row) => row.store === "amazon");
  // $1.20 to make, $3.99 a sale after delivery - still one copy, but the
  // number it is derived from has to be the real one.
  assert.ok(Math.abs(amazon.net - 3.99) < 0.005, `net was ${amazon.net}`);
  assert.equal(amazon.copies, 1);

  // A text-only book pays almost nothing and should not be nagged about it.
  const light = economicsFor({ book: { ...book, epubBytes: 300 * 1024 }, runs: [] });
  assert.ok(light.delivery.usd < 0.05);
  assert.equal(light.delivery.cheaperAtLowRate, false);
});

test("the upload sheet warns about file size before you list, not after", () => {
  const book = {
    id: "b",
    title: "T",
    subtitle: "S",
    author: "A",
    language: "en",
    wordCount: 1000,
    chapterCount: 2,
    figureCount: 12,
    imagesGenerated: true,
    epubBytes: 28 * 1024 * 1024,
    listing: { description: "d", keywords: ["a", "b", "c", "d", "e", "f", "g"], categories: ["x"], priceUsd: 9.99, blurb: "b" },
  };

  const heavy = buildKdpPack({ book, epubName: "b.epub" }).warnings.join("\n");
  assert.match(heavy, /28\.0 MB/);
  assert.match(heavy, /EVERY sale/);
  assert.match(heavy, /35% royalty option pays MORE/);

  const light = buildKdpPack({
    book: { ...book, epubBytes: 300 * 1024, figureCount: 0, imagesGenerated: false },
    epubName: "b.epub",
  }).warnings;
  assert.deepEqual(light, [], `a small book should not be warned: ${light.join("; ")}`);
});

test("a half-written chapter is readable on screen but never reaches the book", async () => {
  // The whole risk of previewing a chapter mid-stream is that the partial
  // leaks into a manuscript or an EPUB and ships half a sentence.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-partial-"));
  process.env.BOOK_FACTORY_DATA = dir;

  try {
    await __chapters.writeChapter("bk_p", { number: 1, title: "One", body: "A finished chapter." });
    await __chapters.writePartial("bk_p", 2, "A chapter that stops mid-");

    const preview = await __chapters.readPartial("bk_p", 2);
    assert.equal(preview.body, "A chapter that stops mid-");
    assert.equal(preview.partial, true);

    // The only two ways text gets into a book:
    const all = await __chapters.readAllChapters("bk_p", 5);
    assert.deepEqual(all.map((c) => c.number), [1], "a partial was picked up as a chapter");
    assert.doesNotMatch(__chapters.assembleManuscript(all), /stops mid-/);

    // And it is cleared once the real chapter lands.
    await __chapters.writeChapter("bk_p", { number: 2, title: "Two", body: "A chapter that stops mid-sentence no longer." });
    await __chapters.clearPartial("bk_p", 2);
    assert.equal(await __chapters.readPartial("bk_p", 2), null);
    assert.equal((await __chapters.readAllChapters("bk_p", 5)).length, 2);
  } finally {
    delete process.env.BOOK_FACTORY_DATA;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("clearing a partial that was never there is not an error", async () => {
  // It runs before every chapter, including the first.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-partial2-"));
  process.env.BOOK_FACTORY_DATA = dir;
  try {
    await assert.doesNotReject(() => __chapters.clearPartial("bk_missing", 7));
  } finally {
    delete process.env.BOOK_FACTORY_DATA;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ========================================================================
 * Cross-promotion: the one page that can cause a sale rather than report one
 * ====================================================================== */

test("every book advertises the others, and a hostile link never ships", () => {
  const state = {
    books: [
      { id: "bk_self", title: "This One" },
      { id: "bk_a", title: "Book A", subtitle: "A sequel", published: { gumroad: { url: "https://gum.co/a" } } },
      { id: "bk_b", title: "Book B" },
      { id: "bk_evil", title: "Book Evil", published: { gumroad: { url: "javascript:alert(1)" } } },
      { id: "bk_gone", title: "Rejected One", status: "rejected" },
    ],
  };

  const list = alsoByFor(state, "bk_self");

  assert.deepEqual(list.map((b) => b.title), ["Book A", "Book B", "Book Evil"], "self or rejected leaked in");
  assert.equal(list[0].url, "https://gum.co/a");
  assert.equal(list[1].url, "", "a book with no storefront is still named");

  // This value is written into an href inside a file you publish and sell.
  assert.equal(list[2].url, "", "a javascript: URL survived into a book");
});

test("the back matter is a real page, in the contents, in the book's language", async () => {
  const epub = await buildEpub({
    title: "पहली किताब",
    author: "A",
    language: "hi",
    chapters: [{ number: 1, title: "एक", body: "शब्द।" }],
    figures: new Map(),
    alsoBy: [
      { title: "Book Two", subtitle: "A sequel", url: "https://example.com/two" },
      { title: "Book Three", subtitle: "", url: "" },
    ],
  });

  const zip = await JSZip.loadAsync(epub);
  const page = await zip.file("OEBPS/alsoby.xhtml").async("string");

  assert.match(page, /इसी लेखक की अन्य पुस्तकें/, "heading was not translated");
  assert.match(page, /<a href="https:\/\/example\.com\/two">Book Two<\/a>/);
  assert.match(page, /<strong>Book Three<\/strong>/, "a book with no link must still be named");

  const nav = await zip.file("OEBPS/nav.xhtml").async("string");
  assert.match(nav, /alsoby\.xhtml/, "not reachable from the table of contents");

  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.match(opf, /idref="alsoby"/, "not in the reading order");
});

test("a book with nothing to advertise gets no empty page", async () => {
  // A back-matter page reading "Also by this author" with nothing under it is
  // worse than no page at all.
  const epub = await buildEpub({
    title: "Only Book",
    author: "A",
    language: "en",
    chapters: [{ number: 1, title: "One", body: "Words." }],
    figures: new Map(),
    alsoBy: [],
  });

  const zip = await JSZip.loadAsync(epub);
  assert.equal(zip.file("OEBPS/alsoby.xhtml"), null);
  assert.doesNotMatch(await zip.file("OEBPS/nav.xhtml").async("string"), /alsoby/);
});
