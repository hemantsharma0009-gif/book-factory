import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGenre, nextAngle, GENRES } from "../src/genres.js";
import { markdownToXhtml, buildEpub } from "../src/epub.js";
import { buildKdpPack } from "../src/publish/kdp.js";
import { nextRunAt, isDue } from "../src/scheduler.js";
import { renderFigure } from "../src/illustrate/charts.js";
import { genericTitleReason } from "../src/agents/title-check.js";
import { stubPlan } from "../src/agents/planner.js";

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
  assert.match(pack.markdown, /35% royalty/);
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
    title: "A Title",
    subtitle: "A Subtitle",
    author: "Author",
    figureCount: 0,
    listing: {
      description: overrides.description || "A description.",
      keywords: overrides.keywords || ["one two", "three four", "five six", "seven eight", "nine ten", "eleven twelve", "thirteen"],
      categories: ["A > B"],
      priceUsd: overrides.priceUsd || 9.99,
      priceRationale: "because",
    },
  };
}

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
