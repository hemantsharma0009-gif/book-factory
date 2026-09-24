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
import { produceBook } from "./pipeline.js";
import { buildKdpPack, writeKdpPack } from "./publish/kdp.js";
import { publishToGumroad } from "./publish/gumroad.js";
import { CADENCES, nextRunAt } from "./scheduler.js";
import { GENRES } from "./genres.js";
import { DEFAULTS, LANGUAGES } from "./config.js";
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

/** Tracks an in-flight generation so the UI can show progress. */
let activeRun = null;

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
      activeRun,
    });
  },

  "POST /api/generate": async (req, res) => {
    if (activeRun) return json(res, 409, { error: "A generation is already running." });
    const body = await readBody(req);
    if (body.dryRun) process.env.BOOK_FACTORY_DRY_RUN = "1";

    activeRun = { startedAt: Date.now(), lines: [], done: false };
    json(res, 202, { started: true });

    produceBook({
      genreId: body.genre || null,
      chapters: Number(body.chapters) || 12,
      wordsPerChapter: Number(body.words) || 2200,
      images: body.images || "charts",
      author: body.author || "Book Factory Studio",
      language: body.language || DEFAULTS.language,
      log: (line) => activeRun.lines.push({ at: Date.now(), line }),
    })
      .then(async (book) => {
        // Same promise as the CLI: a book made here also lands in your Drive,
        // and the upload sheet is written first so it travels with it.
        await writeKdpPack(book.id);
        await deliverBook({
          id: book.id,
          log: (line) => activeRun.lines.push({ at: Date.now(), line }),
        });
        activeRun = { ...activeRun, done: true, bookId: book.id, finishedAt: Date.now() };
      })
      .catch((err) => {
        activeRun = { ...activeRun, done: true, error: err.message, finishedAt: Date.now() };
      })
      .finally(() => {
        // Keep the last run visible for a minute, then clear it.
        setTimeout(() => { activeRun = null; }, 60_000).unref?.();
      });
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

  // Route table with a single :id parameter.
  for (const [pattern, handler] of Object.entries(routes)) {
    const [method, template] = pattern.split(" ");
    if (req.method !== method) continue;

    const regex = new RegExp(`^${template.replace(/:id/, "([^/]+)")}$`);
    const match = pathname.match(regex);
    if (!match) continue;

    try {
      return await handler(req, res, { id: match[1] });
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
