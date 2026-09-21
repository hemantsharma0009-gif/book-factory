/**
 * Read-only share server: the approval queue on your phone, without the
 * buttons that spend money.
 *
 * The review console binds to 127.0.0.1 because it can generate books (which
 * costs API money) and publish to a live storefront. That is the right default
 * and it is not changed here. But it also means you cannot read a finished
 * book on your phone before approving it, which is exactly when you most want
 * to - the whole point of the approval gate is that a human reads the thing.
 *
 * So this is a SECOND server, deliberately separate:
 *
 *   - it listens on the LAN, so a phone on the same wifi can reach it
 *   - it serves exactly three things per link: a landing page, the EPUB, and
 *     the manuscript as HTML
 *   - it has no approve, reject, publish or generate route at all. Not
 *     disabled - absent. There is no code path from here to your Gumroad
 *     account or to the Anthropic API.
 *
 * Each link carries a 128-bit random token scoped to ONE book and expires.
 * Links are held in memory, so restarting the server invalidates every one.
 *
 * This is plain HTTP on a local network: treat a link as readable by anyone on
 * that wifi, and do not put it on the public internet.
 */
import http from "node:http";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as store from "./store.js";
import { markdownToXhtml } from "./epub.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** token -> { bookId, expiresAt } */
const links = new Map();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mintLink(bookId, ttlMs = DEFAULT_TTL_MS) {
  const token = randomBytes(16).toString("hex");
  links.set(token, { bookId, expiresAt: Date.now() + ttlMs });
  return token;
}

export function revokeLink(token) {
  return links.delete(token);
}

/**
 * Looks a token up in constant time with respect to the token's VALUE.
 *
 * A plain Map.get would return in different times for a hit and a miss, and
 * comparing with === leaks a prefix match. Neither matters much against a
 * 128-bit token, but the defensive version costs nothing.
 */
function resolve(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;

  let found = null;
  const candidate = Buffer.from(token, "hex");
  for (const [known, entry] of links) {
    const knownBuf = Buffer.from(known, "hex");
    if (knownBuf.length === candidate.length && timingSafeEqual(knownBuf, candidate)) found = entry;
  }

  if (!found) return null;
  if (found.expiresAt < Date.now()) return null;
  return found;
}

/** Every address a phone on this network could use to reach us. */
export function lanAddresses(port) {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(`http://${entry.address}:${port}`);
    }
  }
  return out;
}

function page(title, body, lang = "en") {
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --ink: #16181d; --paper: #fdfcfa; --muted: #6b7280; --line: #e5e3df; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8e6e3; --paper: #16181d; --muted: #9aa0a6; --line: #2a2d34; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 16px 64px;
    background: var(--paper); color: var(--ink);
    font: 17px/1.65 Georgia, "Noto Serif", serif;
    max-width: 38em; margin-inline: auto;
    -webkit-text-size-adjust: 100%;
  }
  h1 { font-size: 1.5em; line-height: 1.25; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: .95em; margin: 0 0 20px; }
  .bar { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 24px;
         padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  a.btn {
    display: inline-block; padding: 11px 16px; border-radius: 10px;
    border: 1px solid var(--line); text-decoration: none; color: inherit;
    font-family: system-ui, sans-serif; font-size: 15px;
    /* 44px minimum: a thumb is not a mouse pointer. */
    min-height: 44px; line-height: 22px;
  }
  a.btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  .note { color: var(--muted); font-size: .85em; font-family: system-ui, sans-serif; }
  h2 { font-size: 1.15em; margin: 1.8em 0 .4em; }
  img, figure { max-width: 100%; height: auto; }
  figure { margin: 1.4em 0; }
  figcaption { color: var(--muted); font-size: .85em; font-family: system-ui, sans-serif; }
  table { border-collapse: collapse; font-size: .85em; width: 100%; }
  th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 2.5em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

const routes = [
  // The landing page: what this book is, and the two things you can do with it.
  [/^\/s\/([0-9a-f]{32})\/?$/, async (res, [token], entry) => {
    const state = await store.load();
    const book = store.findBook(state, entry.bookId);
    if (!book) return notFound(res);

    const hours = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 3600000));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(book.title, `
<h1>${esc(book.title)}</h1>
<p class="sub">${esc(book.subtitle || "")}</p>
<p class="sub">${esc(book.genreName)} · ${book.wordCount.toLocaleString()} words · ${book.chapterCount} chapters${
      book.languageName && book.language !== "en" ? ` · ${esc(book.languageName)}` : ""
    }</p>
<div class="bar">
  <a class="btn primary" href="/s/${token}/read">Read it here</a>
  <a class="btn" href="/s/${token}/epub" download="${esc(book.epubFile)}">Save the EPUB (${(book.epubBytes / 1024).toFixed(0)} KB)</a>
</div>
<p class="note">
  Read-only. Approving and publishing stay on the machine running the engine —
  this page cannot do either. The link stops working in about ${hours} hour${hours === 1 ? "" : "s"}.
</p>`, book.language));
  }],

  [/^\/s\/([0-9a-f]{32})\/read\/?$/, async (res, [token], entry) => {
    const state = await store.load();
    const book = store.findBook(state, entry.bookId);
    if (!book) return notFound(res);

    let md;
    try {
      md = (await store.readArtifact(entry.bookId, "manuscript.md")).toString("utf8");
    } catch {
      return notFound(res);
    }

    // The manuscript is the model's own output, so it goes through the same
    // escaping the EPUB uses rather than being dropped into the page raw.
    const body = md
      .split(/\n{2,}/)
      .map((block) => (block.startsWith("# ") ? `<h2>${esc(block.slice(2))}</h2>` : markdownToXhtml(block)))
      .join("\n");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(book.title, `
<h1>${esc(book.title)}</h1>
<p class="sub">${esc(book.subtitle || "")}</p>
<div class="bar"><a class="btn" href="/s/${token}">Back</a>
<a class="btn" href="/s/${token}/epub" download="${esc(book.epubFile)}">Save the EPUB</a></div>
${body}`, book.language));
  }],

  [/^\/s\/([0-9a-f]{32})\/epub\/?$/, async (res, [, ], entry) => {
    const state = await store.load();
    const book = store.findBook(state, entry.bookId);
    if (!book) return notFound(res);

    try {
      const data = await store.readArtifact(entry.bookId, book.epubFile);
      res.writeHead(200, {
        "Content-Type": "application/epub+zip",
        // Without this a phone browser tries to render the zip rather than save it.
        "Content-Disposition": `attachment; filename="${book.epubFile.replace(/[^\w.-]/g, "_")}"`,
        "Content-Length": data.length,
      });
      res.end(data);
    } catch {
      notFound(res);
    }
  }],
];

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page("Not found", `<h1>Not found</h1><p class="sub">This link has expired, been revoked, or never existed.</p>`));
}

export function createShareServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      // There is no write surface here at all; say so plainly.
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
      return res.end("This server is read-only.\n");
    }

    const pathname = new URL(req.url, "http://localhost").pathname;

    for (const [pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (!match) continue;

      const entry = resolve(match[1]);
      if (!entry) return notFound(res);

      try {
        return await handler(res, match.slice(1), entry);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("error\n");
      }
    }

    notFound(res);
  });
}

export const __test = { links, resolve };
