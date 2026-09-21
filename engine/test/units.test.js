import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
import { mintLink, revokeLink, createShareServer, __test as __share } from "../src/share.js";

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
  const a = mintLink("bk_a");
  const b = mintLink("bk_b");
  assert.equal(__share.resolve(a).bookId, "bk_a");
  assert.equal(__share.resolve(b).bookId, "bk_b");
  assert.equal(__share.resolve("0".repeat(32)), null);
  // Shapes that are not a token at all never reach the map.
  for (const junk of ["", "abc", "../../etc/passwd", "ZZ".repeat(16), null, 42]) {
    assert.equal(__share.resolve(junk), null, `resolved junk: ${junk}`);
  }
});

test("a share link stops working when it expires", () => {
  const token = mintLink("bk_x", -1);   // already expired
  assert.equal(__share.resolve(token), null);
});

test("a revoked share link stops working immediately", () => {
  const token = mintLink("bk_y");
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
  const token = mintLink("bk_probe");

  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [`/s/${token}`, "/api/state", "/api/books/bk_probe/approve",
                          "/api/books/bk_probe/publish", "/api/generate"]) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 405, `${method} ${path} returned ${res.status}, not 405`);
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
