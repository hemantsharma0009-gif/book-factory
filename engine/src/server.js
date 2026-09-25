#!/usr/bin/env node
/**
 * Review console.
 *
 * Serves the approval UI and a small JSON API over the library. Runs locally;
 * nothing here is exposed to the internet by default, and nothing publishes
 * without an explicit approve call.
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import {
  produceBook,
  resumeBook,
  buildDraftEpub,
  buildDraftMarkdown,
  saveChapterEdit,
} from "./pipeline.js";
import * as runState from "./run-state.js";
import { readChapter, readPartial } from "./chapters.js";
import { describeImageSetup, assertUsable, providers as imageProviders } from "./illustrate/index.js";
import { buildKdpPack, writeKdpPack } from "./publish/kdp.js";
import { publishToGumroad } from "./publish/gumroad.js";
import { CADENCES, nextRunAt } from "./scheduler.js";
import { GENRES } from "./genres.js";
import { DEFAULTS, LANGUAGES, paths } from "./config.js";
import { deliverBook } from "./deliver.js";
import { rebuildBook, manuscriptIsNewer } from "./rebuild.js";
import { economicsFor } from "./economics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".epub": "application/epub+zip",
  ".md": "text/markdown; charset=utf-8",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * The book this server is currently working on.
 *
 * Only the id is held here. Everything the progress panel shows is read from
 * `run.json` on each poll, so a run started from the CLI in another terminal
 * shows up in the console too, and a console restart mid-book loses nothing.
 */
let activeBookId = null;

/** Everything that happens after a book is finished, from either entry point. */
async function afterBook(book) {
  await writeKdpPack(book.id);
  await deliverBook({ id: book.id, log: () => {} });
}

/**
 * A run that has a book id but no live process here - started from the CLI,
 * or left behind by a restart - is still shown, so the progress bar and the
 * download button work wherever the run was started.
 */
async function currentRun() {
  if (activeBookId) {
    const run = await runState.readRun(activeBookId);
    if (run) return runState.publicView(run);
  }
  // Nothing in memory: look for an unfinished book on disk. You can pause a
  // run, close the laptop and come back tomorrow, and the console still has to
  // offer you the Resume button and the part-written book.
  const found = await findUnfinishedRun();
  if (found) {
    activeBookId = found.bookId;
    return runState.publicView(found);
  }
  return null;
}

async function findUnfinishedRun() {
  let names;
  try {
    names = await fs.readdir(paths().books);
  } catch {
    return null;
  }

  let newest = null;
  for (const name of names) {
    const run = await runState.readRun(name);
    if (!run || run.status === "done") continue;
    if (!newest || run.updatedAt > newest.updatedAt) newest = run;
  }
  return newest;
}

const routes = {
  "GET /api/state": async (req, res) => {
    const state = await store.load();
    const books = await Promise.all(state.books.map(async (book) => ({
      ...book,
      manuscriptEdited: book.epubFile ? await manuscriptIsNewer(book.id, book.epubFile) : false,
      economics: economicsFor({ book, runs: state.runs }),
    })));

    json(res, 200, {
      books,
      schedule: state.schedule,
      nextRunAt: nextRunAt(state.schedule, state.runs[0]?.at),
      cadences: CADENCES,
      genres: GENRES.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
      languages: Object.values(LANGUAGES),
      genreHistory: state.genreHistory.slice(0, 12),
      runs: state.runs.slice(0, 20),
      activeRun: await currentRun(),
      imageProviders: Object.values(imageProviders).map((p) => ({
        id: p.id,
        label: p.label,
        requiresKey: Boolean(p.requiresKey),
        costPerImage: p.costPerImage || 0,
      })),
      imageSetup: describeImageSetup(),
    });
  },

  "POST /api/generate": async (req, res) => {
    const running = await currentRun();
    if (running && !runState.TERMINAL.has(running.status)) {
      return json(res, 409, { error: "A generation is already running." });
    }

    const body = await readBody(req);
    if (body.dryRun) process.env.BOOK_FACTORY_DRY_RUN = "1";

    const options = {
      genreId: body.genre || null,
      chapters: Number(body.chapters) || 12,
      wordsPerChapter: Number(body.words) || 2200,
      images: body.images || "charts",
      imageDriver: body.imageDriver || null,
      imageEvery: Number(body.imageEvery) || 1,
      author: body.author || "Book Factory Studio",
      language: body.language || DEFAULTS.language,
      // Live is the default from the console, because the console is where
      // somebody is watching: a batch run shows nothing until it ends and
      // cannot be paused, which is the opposite of what this screen is for.
      mode: body.mode === "batch" ? "batch" : "live",
      editorial: body.editorial !== false,
    };

    // Anything that can fail before a token is spent - an unknown genre, an
    // image provider with no key - should fail HERE, in the response to the
    // click, not silently inside a background promise.
    try {
      assertUsable(options.images, options.imageDriver);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const ready = new Promise((resolve) => {
      produceBook({ ...options, onStart: resolve, log: () => {} })
        .then(async (book) => {
          if (book?.id) await afterBook(book);
        })
        .catch((err) => {
          // The run record already carries the failure. Swallowing it here
          // only stops an unhandled rejection taking the console down.
          process.emitWarning(`generate: ${err.message}`);
          resolve(null);
        });
    });

    activeBookId = await ready;
    json(res, 202, { started: true, bookId: activeBookId });
  },

  "GET /api/runs/:id": async (req, res, { id }) => {
    const run = await runState.readRun(id);
    if (!run) return json(res, 404, { error: "No such run" });
    json(res, 200, runState.publicView(run));
  },

  "POST /api/runs/:id/pause": async (req, res, { id }) => {
    const run = await runState.readRun(id);
    if (!run) return json(res, 404, { error: "No such run" });
    if (runState.TERMINAL.has(run.status) || run.status === "paused") {
      return json(res, 400, { error: `This run is ${run.status}.` });
    }
    await runState.patchRun(id, (r) => {
      r.pauseRequested = true;
      runState.appendLog(r, "Pause requested — finishing the current chapter first.");
    });
    await runState.settle(id);
    json(res, 200, runState.publicView(await runState.readRun(id)));
  },

  "POST /api/runs/:id/stop": async (req, res, { id }) => {
    const run = await runState.readRun(id);
    if (!run) return json(res, 404, { error: "No such run" });
    await runState.patchRun(id, (r) => {
      r.cancelRequested = true;
      runState.appendLog(r, "Stop requested. What is already written is kept.");
    });
    await runState.settle(id);
    json(res, 200, runState.publicView(await runState.readRun(id)));
  },

  "POST /api/runs/:id/resume": async (req, res, { id }) => {
    const run = await runState.readRun(id);
    if (!run) return json(res, 404, { error: "No such run" });
    if (run.status === "done") return json(res, 400, { error: "This book is finished." });

    const running = await currentRun();
    if (running && running.bookId !== id && !runState.TERMINAL.has(running.status)) {
      return json(res, 409, { error: "Another generation is running." });
    }

    activeBookId = id;
    resumeBook({ bookId: id, log: () => {} })
      .then(async (book) => {
        if (book?.id) await afterBook(book);
      })
      .catch((err) => process.emitWarning(`resume: ${err.message}`));

    json(res, 202, { resumed: true, bookId: id });
  },

  "GET /api/runs/:id/draft.epub": async (req, res, { id }) => {
    try {
      const draft = await buildDraftEpub({ bookId: id });
      res.writeHead(200, {
        "Content-Type": MIME[".epub"],
        "Content-Length": draft.epub.length,
        "Content-Disposition": `attachment; filename="${draft.filename}"`,
        // A draft changes every time a chapter lands, so it must never be
        // served from a cache.
        "Cache-Control": "no-store",
      });
      res.end(draft.epub);
    } catch (err) {
      json(res, 409, { error: err.message });
    }
  },

  "GET /api/runs/:id/draft.md": async (req, res, { id }) => {
    try {
      const draft = await buildDraftMarkdown({ bookId: id });
      res.writeHead(200, {
        "Content-Type": MIME[".md"],
        "Content-Disposition": `attachment; filename="draft-${id}.md"`,
        "Cache-Control": "no-store",
      });
      res.end(draft.markdown);
    } catch (err) {
      json(res, 409, { error: err.message });
    }
  },

  "GET /api/runs/:id/chapters/:n": async (req, res, { id, n }) => {
    const number = Number(n);
    const chapter = await readChapter(id, number);
    if (chapter) return json(res, 200, { ...chapter, partial: false });

    // Nothing finished, but this may be the chapter being written right now.
    // Serving the prose so far is the whole point of watching a book being
    // written; `partial` tells the console to show it read-only and keep
    // asking for more.
    const partial = await readPartial(id, number);
    if (partial) {
      const run = await runState.readRun(id);
      const entry = run?.chapters.find((c) => c.number === number);
      return json(res, 200, {
        ...partial,
        title: entry?.title || `Chapter ${number}`,
        // no-store: this changes every few hundred milliseconds.
        partial: true,
      });
    }

    json(res, 404, { error: "Not written yet" });
  },

  "POST /api/runs/:id/chapters/:n": async (req, res, { id, n }) => {
    const body = await readBody(req);
    if (typeof body.body !== "string" || !body.body.trim()) {
      return json(res, 400, { error: "Nothing to save." });
    }

    // A chapter still being written will be overwritten by the stream a few
    // seconds from now, so accepting an edit to it would quietly throw the
    // edit away. Saying so is better than losing it.
    const run = await runState.readRun(id);
    const entry = run?.chapters.find((c) => c.number === Number(n));
    if (entry?.streaming && !entry.done) {
      return json(res, 409, {
        error: "This chapter is still being written. Pause the run, then edit it.",
      });
    }
    try {
      const result = await saveChapterEdit({
        bookId: id,
        number: Number(n),
        body: body.body,
        title: body.title,
      });
      json(res, 200, result);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },

  "POST /api/books/:id/approve": async (req, res, { id }) => {
    try {
      await store.update((s) => {
        const book = store.findBook(s, id);
        if (!book) throw new Error("No such book");
        if (book.status !== "awaiting_approval") throw new Error(`Book is ${book.status}`);
        book.status = "approved";
        book.approvedAt = Date.now();
        book.updatedAt = Date.now();
      });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },

  "POST /api/books/:id/reject": async (req, res, { id }) => {
    const { reason } = await readBody(req);
    await store.update((s) => {
      const book = store.findBook(s, id);
      if (book) {
        book.status = "rejected";
        book.rejectedReason = reason || "no reason given";
        book.updatedAt = Date.now();
      }
    });
    json(res, 200, { ok: true });
  },

  "POST /api/books/:id/publish": async (req, res, { id }) => {
    const body = await readBody(req);
    const state = await store.load();
    const book = store.findBook(state, id);

    if (!book) return json(res, 404, { error: "No such book" });
    if (book.status !== "approved") {
      return json(res, 400, { error: `Book is "${book.status}". Approve it first.` });
    }

    try {
      const epubBuffer = await store.readArtifact(id, book.epubFile);
      const result = await publishToGumroad({
        book,
        epubBuffer,
        epubName: book.epubFile,
        dryRun: Boolean(body.dryRun),
      });

      if (!body.dryRun) {
        await store.update((s) => {
          const b = store.findBook(s, id);
          b.published.gumroad = { ...result, at: Date.now() };
          b.status = "published";
          b.updatedAt = Date.now();
        });
      }
      json(res, 200, { ok: true, result });
    } catch (err) {
      json(res, 502, { error: err.message });
    }
  },

  "GET /api/books/:id/manuscript": async (req, res, { id }) => {
    const download = new URL(req.url, "http://localhost").searchParams.has("download");
    try {
      const md = await store.readArtifact(id, "manuscript.md");
      res.writeHead(200, {
        "Content-Type": MIME[".md"],
        // With ?download the browser saves it instead of rendering it, which
        // is what you want when the next step is editing it.
        ...(download ? { "Content-Disposition": `attachment; filename="manuscript.md"` } : {}),
      });
      res.end(md);
    } catch {
      json(res, 404, { error: "No manuscript" });
    }
  },

  "GET /api/books/:id/kdp": async (req, res, { id }) => {
    const state = await store.load();
    const book = store.findBook(state, id);
    if (!book) return json(res, 404, { error: "No such book" });
    const pack = buildKdpPack({ book, epubName: book.epubFile });
    res.writeHead(200, { "Content-Type": MIME[".md"] });
    res.end(pack.markdown);
  },

  "POST /api/books/:id/rebuild": async (req, res, { id }) => {
    try {
      const result = await rebuildBook({ id });
      await writeKdpPack(id);
      await deliverBook({ id });
      json(res, 200, { ok: true, result });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },

  "POST /api/schedule": async (req, res) => {
    const body = await readBody(req);
    if (body.cadence && !CADENCES[body.cadence]) {
      return json(res, 400, { error: `Unknown cadence "${body.cadence}"` });
    }
    await store.update((s) => {
      s.schedule = {
        enabled: Boolean(body.enabled),
        cadence: body.cadence || "weekly",
        time: body.time || "09:00",
        images: body.images || "charts",
      };
    });
    const state = await store.load();
    json(res, 200, { schedule: state.schedule, nextRunAt: nextRunAt(state.schedule, state.runs[0]?.at) });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Route table. `:name` segments become named parameters, so a route can
  // address a chapter inside a book without a second lookup.
  for (const [pattern, handler] of Object.entries(routes)) {
    const [method, template] = pattern.split(" ");
    if (req.method !== method) continue;

    const names = [];
    const source = template.replace(/:([A-Za-z]+)/g, (_, name) => {
      names.push(name);
      return "([^/]+)";
    });
    const match = pathname.match(new RegExp(`^${source}$`));
    if (!match) continue;

    const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));

    try {
      return await handler(req, res, params);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // Book artifacts (cover, epub) - served read-only from the library.
  const artifact = pathname.match(/^\/library\/([^/]+)\/(.+)$/);
  if (artifact && req.method === "GET") {
    const [, id, name] = artifact;
    if (name.includes("..")) return json(res, 400, { error: "bad path" });
    try {
      const data = await store.readArtifact(id, name);
      res.writeHead(200, { "Content-Type": MIME[path.extname(name)] || "application/octet-stream" });
      return res.end(data);
    } catch {
      return json(res, 404, { error: "not found" });
    }
  }

  // Static assets are an explicit allowlist, not a directory mount: this server
  // can spend money and publish, so it must never hand out arbitrary repo files.
  const STATIC = {
    "/": path.join(here, "..", "public", "review.html"),
    "/review.html": path.join(here, "..", "public", "review.html"),
    "/assets/styles.css": path.join(here, "..", "..", "assets", "styles.css"),
  };

  const staticFile = STATIC[pathname];
  if (staticFile && req.method === "GET") {
    try {
      const data = await fs.readFile(staticFile);
      res.writeHead(200, { "Content-Type": MIME[path.extname(staticFile)] || "text/plain" });
      return res.end(data);
    } catch {
      return json(res, 404, { error: "asset missing" });
    }
  }

  json(res, 404, { error: `No route for ${req.method} ${pathname}` });
});

// Bound to loopback deliberately: this console approves spend and publishes to
// a live storefront, so it is not exposed on the network without a conscious
// decision (set BOOK_FACTORY_HOST to override).
const HOST = process.env.BOOK_FACTORY_HOST || "127.0.0.1";

server.listen(PORT, HOST, () => {
  process.stdout.write(`Book Factory review console: http://${HOST}:${PORT}\n`);
});
