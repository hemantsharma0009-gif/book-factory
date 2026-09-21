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
var SCHEMA_VERSION = 2;
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

var BLUEPRINTS = [
  {
    id: "fiction",
    name: "Fiction",
    blurb: "Characters · plot beats · chapters · dialogue passes · QA",
    category: "Mythology",
    chapters: 24,
    words: 78000,
    format: "EPUB / PDF"
  },
  {
    id: "nonfiction",
    name: "Non-fiction",
    blurb: "Research · structured chapters · references · line editing",
    category: "Education",
    chapters: 14,
    words: 55000,
    format: "EPUB / PDF"
  },
  {
    id: "workbook",
    name: "Workbook",
    blurb: "Exercises · answer keys · difficulty progression · QA",
    category: "Education",
    chapters: 20,
    words: 32000,
    format: "Workbook"
  },
  {
    id: "aitech",
    name: "AI / technology",
    blurb: "Tutorials · worked examples · workflows · update cadence",
    category: "AI / Tech",
    chapters: 16,
    words: 48000,
    format: "EPUB / PDF"
  }
];

var DEFAULT_SCHEDULE = {
  enabled: true,
  cadence: "daily",
  time: "22:00",
  zone: "IST",
  batch: 3,
  autoQA: true,
  autoPackage: true,
  handoff: true
};

var DEFAULT_SETTINGS = {
  theme: "dark",
  costPerK: 3.5,
  fixedCost: 120
};

/* ---------------------------------------------------------
   Seed library
   --------------------------------------------------------- */

function seedBooks() {
  var raw = [
    ["Ratna Vigyan", "Gemstone Sciences", "Astrology", "Packaging", 18, 18, 62000, 62000, "high", 0],
    ["The Living Vedic Astrology", "Gemstone Sciences", "Astrology", "QA", 22, 22, 81000, 80000, "normal", 0],
    ["Tarapatti", "Gemstone Sciences", "Astrology", "Editing", 16, 16, 54000, 58000, "normal", 0],
    ["The Vikramaditya Code", "Vikramaditya", "Astrology", "Research", 20, 4, 9000, 72000, "normal", 0],
    ["The Untold Ravana", "Lanka Chronicles", "Mythology", "Chapters", 24, 15, 44000, 76000, "high", 0],
    ["Stone Sky Gods", "Lanka Chronicles", "Mystery", "QA", 26, 26, 92000, 90000, "high", 0],
    ["Common Core Math Series", "Classroom Core", "Education", "Blueprint", 20, 0, 0, 32000, "normal", 0],
    ["Claude Mastery", "Model Mastery", "AI / Tech", "Outline", 16, 0, 2000, 48000, "normal", 0],
    ["ChatGPT Mastery", "Model Mastery", "AI / Tech", "Chapters", 16, 7, 21000, 48000, "normal", 0],
    ["One Dashboard to Rule Them All", "Operator Series", "Finance", "Blueprint", 12, 0, 0, 40000, "normal", 0]
  ];

  var now = Date.now();

  return raw.map(function (r, i) {
    return {
      id: "bk_seed_" + (i + 1),
      title: r[0],
      series: r[1],
      category: r[2],
      author: "Book Factory Studio",
      format: r[2] === "Education" ? "Workbook" : "EPUB / PDF",
      description: r[0] + " — produced by the Book Factory autonomous pipeline.",
      stage: r[3],
      chapters: { total: r[4], done: r[5] },
      words: { done: r[6], target: r[7] },
      priority: r[8],
      revenue: r[9],
      queued: r[3] === "Chapters",
      released: false,
      issues: [],
      createdAt: now - (10 - i) * 86400000,
      updatedAt: now - (10 - i) * 3600000
    };
  });
}

function seedState() {
  return {
    schema: SCHEMA_VERSION,
    books: seedBooks(),
    facts: [
      { id: "ft_1", text: "Ravana's court is seated on the Pushpak throne in Lanka.", bookId: "bk_seed_5", createdAt: Date.now() - 172800000 },
      { id: "ft_2", text: "Gemstone potency tables are shared across the Gemstone Sciences series.", bookId: "bk_seed_1", createdAt: Date.now() - 86400000 }
    ],
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
  var sign = n < 0 ? "−" : "";
  return sign + "$" + formatNumber(Math.abs(n));
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

function normaliseState(raw) {
  if (!raw || typeof raw !== "object") return null;

  var base = seedState();
  var books = Array.isArray(raw.books) ? raw.books.map(normaliseBook) : base.books;

  var ids = Object.create(null);
  books.forEach(function (book) {
    while (ids[book.id]) book.id = uid("bk");
    ids[book.id] = true;
  });

  var bookIds = Object.create(null);
  books.forEach(function (b) { bookIds[b.id] = true; });

  return {
    schema: SCHEMA_VERSION,
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
    schedule: Object.assign(clone(DEFAULT_SCHEDULE), raw.schedule || {}),
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
  if (book.released) return 100;

  var i = stageIndex(book.stage);
  var step = 100 / (STAGES.length - 1);
  var pct = i * step;

  if (book.stage === "Chapters" && book.chapters.total > 0) {
    pct += step * (book.chapters.done / book.chapters.total);
  }

  return Math.round(clamp(pct, 0, 100));
}

function statusOf(book) {
  if (book.issues.length) return "BLOCKED";
  if (book.released) return "RELEASED";
  if (book.stage === "Publishing") return "READY";
  if (book.queued) return "RUNNING";
  return "PIPELINE";
}

function statusClass(status) {
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
  if (value === "READY" || value === "PASS") return "ok";
  if (value === "PIPELINE") return "blue";
  if (value === "MISSING" || value === "FAIL") return "bad";
  if (value === "REVIEW") return "warn";
  return "";
}

function estimatedCost(book) {
  return (book.words.done / 1000) * toNum(state.settings.costPerK, 0) + toNum(state.settings.fixedCost, 0);
}

function summary() {
  var books = state.books;
  var counts = { READY: 0, RUNNING: 0, PIPELINE: 0, BLOCKED: 0, RELEASED: 0 };

  books.forEach(function (b) { counts[statusOf(b)] += 1; });

  var words = books.reduce(function (sum, b) { return sum + b.words.done; }, 0);
  var target = books.reduce(function (sum, b) { return sum + b.words.target; }, 0);
  var chapters = books.reduce(function (sum, b) { return sum + b.chapters.done; }, 0);
  var revenue = books.reduce(function (sum, b) { return sum + b.revenue; }, 0);
  var cost = books.reduce(function (sum, b) { return sum + estimatedCost(b); }, 0);
  var passing = books.filter(function (b) { return packageState(b).validator === "PASS"; }).length;

  return {
    total: books.length,
    counts: counts,
    queued: books.filter(function (b) { return b.queued; }).length,
    words: words,
    target: target,
    chapters: chapters,
    revenue: revenue,
    cost: cost,
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
  var now = from || Date.now();
  var offset = zoneOffset(schedule.zone) * 60000;
  var parts = String(schedule.time || "22:00").split(":");
  var hour = clamp(toInt(parts[0], 22), 0, 23);
  var minute = clamp(toInt(parts[1], 0), 0, 59);
  var local = new Date(now + offset);

  for (var day = 0; day < 14; day++) {
    var candidateLocal = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + day,
      hour,
      minute
    );

    var instant = candidateLocal - offset;
    if (instant <= now) continue;

    var weekday = new Date(candidateLocal).getUTCDay();

    if (schedule.cadence === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (schedule.cadence === "weekly" && weekday !== 1) continue;

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
    return !b.released && b.stage !== "Publishing" && !b.issues.length;
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
    .filter(function (b) { return b.queued && !b.released && b.stage !== "Publishing" && !b.issues.length; })
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
  if (book.issues.length || book.released || book.stage === "Publishing") return null;

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

function renderChrome() {
  var s = summary();

  $("navCountLibrary").textContent = s.total;
  $("navCountProduction").textContent = s.queued;
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
    metricCard("Active books", String(s.total),
      s.counts.PIPELINE + " in pipeline · " + s.counts.READY + " ready · " + s.counts.RELEASED + " released"),
    metricCard("Queued jobs", String(s.queued), ui.running ? "Run in progress" : "Queue idle"),
    metricCard("Next cycle", state.schedule.enabled && next ? countdown(next) : "OFF",
      state.schedule.enabled && next ? state.schedule.time + " " + state.schedule.zone : "Scheduler disabled"),
    metricCard("QA blockers", String(s.counts.BLOCKED), s.counts.BLOCKED ? "Needs review" : "All clear")
  ].join("");

  var focus = eligibleJobs()[0] || state.books.filter(function (b) { return !b.released; })[0];

  $("dashboardPipeline").innerHTML = focus
    ? pipelineHTML(focus.stage, focus.released)
    : pipelineHTML("Brief", false);

  $("pipelineSummary").textContent = focus
    ? "Tracking " + focus.title + " — stage " + focus.stage + " (" + progressOf(focus) + "%)"
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
    statRow("Released titles", "<strong>" + s.counts.RELEASED + "</strong>")
  ].join("");

  var jobs = state.books.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 6);

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
    : emptyRow(5, "No books yet — add one to get started.");

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
          '<div class="book-foot"><span class="small muted">' + pct + "% · " + escapeHTML(book.stage) + "</span>" +
            '<span class="small muted">' + relativeTime(book.updatedAt) + "</span></div>" +
          '<div class="actions">' +
            '<button type="button" class="btn tiny" data-action="view-book" data-id="' + escapeHTML(book.id) + '">View</button>' +
            '<button type="button" class="btn tiny" data-action="edit-book" data-id="' + escapeHTML(book.id) + '">Edit</button>' +
            '<button type="button" class="btn tiny ' + (book.queued ? "" : "primary") + '" data-action="toggle-queue" data-id="' +
              escapeHTML(book.id) + '">' + (book.queued ? "Dequeue" : "Queue") + "</button>" +
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

function renderProduction() {
  var s = summary();
  var jobs = eligibleJobs();

  $("productionMetrics").innerHTML = [
    metricCard("Queued", String(s.queued), jobs.length + " eligible now"),
    metricCard("Running", ui.running ? "YES" : "NO", ui.running ? "Ticking every 1.1s" : "Queue idle"),
    metricCard("Blocked", String(s.counts.BLOCKED), "Resolve blockers to resume"),
    metricCard("Chapters drafted", formatNumber(s.chapters), "Across the portfolio")
  ].join("");

  $("stageLegend").textContent = STAGES.join(" → ");

  var rows = state.books.slice().sort(function (a, b) {
    if (a.queued !== b.queued) return a.queued ? -1 : 1;
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return progressOf(b) - progressOf(a);
  });

  if (ui.onlyActive) rows = rows.filter(function (b) { return b.queued; });

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
    : emptyRow(7, ui.onlyActive ? "No active jobs in the queue." : "The library is empty.");
}

function renderScheduler() {
  var next = nextRunAt(state.schedule);
  var plan = nextCyclePlan();

  $("schedulerMetrics").innerHTML = [
    metricCard("Autonomous cron", state.schedule.enabled ? "ON" : "OFF", state.schedule.cadence),
    metricCard("Next run", state.schedule.enabled && next ? countdown(next) : "—",
      next ? new Date(next).toLocaleString() : "Scheduler disabled"),
    metricCard("Batch size", String(state.schedule.batch), "books per cycle"),
    metricCard("Timezone", state.schedule.zone, zoneLabel(state.schedule.zone))
  ].join("");

  $("schedCadence").value = state.schedule.cadence;
  $("schedTime").value = state.schedule.time;
  $("schedBatch").value = state.schedule.batch;
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

  $("memoryMetrics").innerHTML = [
    metricCard("Continuity facts", String(state.facts.length), "tracked across the library"),
    metricCard("Series bibles", String(seriesNames.length), "active series"),
    metricCard("Linked books", String(state.facts.filter(function (f) { return f.bookId; }).length), "facts bound to a title"),
    metricCard("Auto extraction", state.schedule.autoQA ? "ON" : "OFF", "runs with QA")
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
    ? seriesNames.sort().map(function (name) {
        var entry = seriesMap[name];
        return statRow(name, "<strong>" + entry.books + " books · " + entry.facts + " facts</strong>");
      }).join("")
    : '<p class="muted small">No series yet.</p>';
}

function renderPublishing() {
  var s = summary();

  $("publishingSummary").textContent =
    s.passing + " of " + s.total + " packages pass validation · " + s.counts.RELEASED + " released";

  $("publishingTable").innerHTML = state.books.length
    ? state.books.map(function (book) {
        var p = packageState(book);

        return "<tr>" +
          "<td>" + escapeHTML(book.title) + '<div class="small muted">' + escapeHTML(book.format) + "</div></td>" +
          "<td>" + pill(p.epub, artifactClass(p.epub)) + "</td>" +
          "<td>" + pill(p.pdf, artifactClass(p.pdf)) + "</td>" +
          "<td>" + pill(p.metadata, artifactClass(p.metadata)) + "</td>" +
          "<td>" + pill(p.zip, artifactClass(p.zip)) + "</td>" +
          "<td>" + pill(book.released ? "RELEASED" : p.validator, book.released ? "ok" : artifactClass(p.validator)) + "</td>" +
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

function renderAnalytics() {
  var s = summary();
  var margin = s.revenue - s.cost;

  $("analyticsMetrics").innerHTML = [
    metricCard("Revenue recorded", formatMoney(s.revenue), "from the book editor"),
    metricCard("Modelled cost", formatMoney(s.cost), "words × rate + fixed"),
    metricCard("Margin", formatMoney(margin), margin >= 0 ? "in the black" : "in the red"),
    metricCard("Portfolio", String(s.total), s.counts.RELEASED + " released · " + s.counts.BLOCKED + " blocked")
  ].join("");

  var days = [];

  for (var i = 6; i >= 0; i--) {
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);

    var end = new Date(start);
    end.setDate(end.getDate() + 1);

    var count = state.activity.filter(function (entry) {
      return entry.at >= start.getTime() && entry.at < end.getTime();
    }).length;

    days.push({ label: start.toLocaleDateString([], { weekday: "short" }), count: count });
  }

  var max = Math.max.apply(null, days.map(function (d) { return d.count; }).concat([1]));

  $("activityChart").innerHTML = days.map(function (d) {
    /* Cap at 88% so the value label above the bar always has room. */
    var height = d.count ? Math.max(4, Math.round((d.count / max) * 88)) : 1;

    return '<div class="col">' +
      '<div class="bar-wrap"><span class="bar-value">' + d.count + "</span>" +
      '<div class="bar" style="height:' + height + '%"></div></div>' +
      '<span class="bar-label">' + escapeHTML(d.label) + "</span>" +
      "</div>";
  }).join("");

  var byCategory = Object.create(null);
  state.books.forEach(function (book) {
    byCategory[book.category] = (byCategory[book.category] || 0) + 1;
  });

  var categories = Object.keys(byCategory).sort(function (a, b) { return byCategory[b] - byCategory[a]; });
  var catMax = Math.max.apply(null, categories.map(function (c) { return byCategory[c]; }).concat([1]));

  $("categoryBars").innerHTML = categories.length
    ? categories.map(function (name) {
        return '<div class="bars-row"><span>' + escapeHTML(name) + "</span>" +
          '<span class="bars-track"><span class="bars-fill" style="width:' +
            Math.round((byCategory[name] / catMax) * 100) + '%"></span></span>' +
          '<span class="num">' + byCategory[name] + "</span></div>";
      }).join("")
    : '<p class="muted small">No categories yet.</p>';

  $("costPerK").value = state.settings.costPerK;
  $("fixedCost").value = state.settings.fixedCost;

  $("economicsTable").innerHTML = state.books.length
    ? state.books.slice().sort(function (a, b) { return b.words.done - a.words.done; }).map(function (book) {
        var cost = estimatedCost(book);
        var m = book.revenue - cost;

        return "<tr>" +
          "<td>" + escapeHTML(book.title) + "</td>" +
          '<td class="nowrap">' + formatNumber(book.words.done) + "</td>" +
          '<td class="nowrap">' + formatMoney(cost) + "</td>" +
          '<td class="nowrap">' + formatMoney(book.revenue) + "</td>" +
          '<td class="nowrap">' + pill(formatMoney(m), m >= 0 ? "ok" : "bad") + "</td>" +
          "</tr>";
      }).join("")
    : emptyRow(5, "No titles to cost.");
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
      statRow("Estimated cost", "<strong>" + formatMoney(estimatedCost(book)) + "</strong>") +
      statRow("Revenue", "<strong>" + formatMoney(book.revenue) + "</strong>") +
      statRow("Last updated", "<strong>" + relativeTime(book.updatedAt) + "</strong>") +
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
      '<button type="button" class="btn primary" data-action="advance-book" data-id="' + escapeHTML(book.id) + '">Advance production</button>' +
      '<button type="button" class="btn" data-action="edit-book" data-id="' + escapeHTML(book.id) + '">Edit</button>' +
      '<button type="button" class="btn" data-action="toggle-queue" data-id="' + escapeHTML(book.id) + '">' +
        (book.queued ? "Remove from queue" : "Add to queue") + "</button>" +
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
    revenue: 0
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
        '<label class="field"><span>Recorded revenue ($)</span><input class="input" name="revenue" type="number" min="0" step="1" value="' + draft.revenue + '"></label>' +
      "</div>" +

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
    if (book.issues.length || book.released) return;
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
    if (book.released) return;
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

function importData(file) {
  var reader = new FileReader();

  reader.onload = function () {
    try {
      var parsed = JSON.parse(String(reader.result));
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
  "reset": resetData,
  "close-modal": closeModal,
  "clear-activity": function () {
    state.activity = [];
    save();
    render();
    toast("Activity log cleared.");
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

  state.schedule = {
    enabled: $("schedEnabled").checked,
    cadence: $("schedCadence").value,
    time: time,
    zone: $("schedZone").value,
    batch: batch,
    autoQA: $("schedAutoQA").checked,
    autoPackage: $("schedAutoPackage").checked,
    handoff: $("schedHandoff").checked
  };

  log("scheduler", "Schedule saved: " + state.schedule.cadence + " at " + time + " " + state.schedule.zone + ".");
  save();
  render();
  toast("Schedule saved.", "ok");
});

$("economicsForm").addEventListener("submit", function (event) {
  event.preventDefault();

  state.settings.costPerK = Math.max(0, toNum($("costPerK").value, DEFAULT_SETTINGS.costPerK));
  state.settings.fixedCost = Math.max(0, toNum($("fixedCost").value, DEFAULT_SETTINGS.fixedCost));

  save();
  render();
  toast("Cost assumptions saved.", "ok");
});

$("importFile").addEventListener("change", function () {
  if (this.files && this.files[0]) importData(this.files[0]);
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
