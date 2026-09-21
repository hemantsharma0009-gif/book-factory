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
 * Traffic is encrypted. The server generates a throwaway certificate at
 * startup and serves HTTPS, so an unpublished manuscript is not readable by
 * anyone else on the network. See makeCertificate() for why the certificate is
 * self-signed and what that costs you.
 */
import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, timingSafeEqual, X509Certificate } from "node:crypto";
import * as store from "./store.js";
import { markdownToXhtml } from "./epub.js";

// Short by default. A link you meant to use for ten minutes should not still
// work tomorrow; --hours raises it deliberately.
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * A throwaway TLS certificate for this one sharing session.
 *
 * It has to be self-signed: a real certificate authority will not issue for
 * 192.168.x.x, because that address means a different machine on every
 * network. So the phone shows a warning the first time, and the command prints
 * the certificate's fingerprint for you to check against the one the phone
 * shows. Checking it once is what makes the warning meaningful rather than
 * something to tap through.
 *
 * The key exists in a 0600 temp file for as long as openssl needs to write it,
 * is read into memory, and the file is deleted before the server starts. It is
 * never written into the repository or the library.
 */
export function makeCertificate(addresses = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-factory-share-"), { mode: 0o700 });
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");

  // Every address a phone might use to reach us has to be in the certificate,
  // or the phone rejects it outright instead of merely warning.
  const san = ["IP:127.0.0.1", "DNS:localhost", ...addresses.map((a) => `IP:${a}`)].join(",");

  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath,
        "-days", "1",
        "-subj", "/CN=book-factory share",
        "-addext", `subjectAltName=${san}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    const key = fs.readFileSync(keyPath, "utf8");
    const cert = fs.readFileSync(certPath, "utf8");
    return { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * token -> { bookId, expiresAt, passcode, attemptsLeft, sessions:Set<string> }
 *
 * The token in the URL says WHICH book; the passcode says you are meant to see
 * it. Splitting them is the point: a forwarded link, a screenshot, a browser
 * history entry or a line in a router log is no longer enough on its own.
 */
const links = new Map();

/** How many wrong passcodes before a link is destroyed rather than merely locked. */
const MAX_ATTEMPTS = 5;

/**
 * Headers every response carries.
 *
 * no-store: the manuscript is unpublished; it should not sit in a cache.
 * no-referrer: the share token is in the URL, and a Referer header would carry
 *   it to anything the page ever linked out to.
 * nosniff: this server returns exactly two content types; never let a browser
 *   guess a third.
 */
function secure(headers = {}) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  };
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mintLink(bookId, ttlMs = DEFAULT_TTL_MS) {
  const token = randomBytes(16).toString("hex");

  // Six digits, read aloud or typed on a phone keypad without fuss. Short is
  // only safe because MAX_ATTEMPTS destroys the link long before a guesser
  // gets anywhere near a million tries.
  const passcode = String(randomInt(0, 1_000_000)).padStart(6, "0");

  links.set(token, {
    bookId,
    expiresAt: Date.now() + ttlMs,
    passcode,
    attemptsLeft: MAX_ATTEMPTS,
    sessions: new Set(),
  });
  return { token, passcode };
}

/** Constant-time string compare that does not leak length through timing. */
function sameSecret(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still do the work, so a wrong length is not measurably faster.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Checks a passcode and, on success, issues a session id for the cookie.
 *
 * On failure it burns an attempt. When the last one goes the link is deleted
 * outright rather than locked: a locked link is a thing an attacker can keep
 * poking at, and you can always mint a new one.
 *
 * @returns {{ok:true, session:string}|{ok:false, attemptsLeft:number, dead:boolean}}
 */
export function unlock(token, passcode, onDestroyed = () => {}) {
  const entry = resolve(token);
  if (!entry) return { ok: false, attemptsLeft: 0, dead: true };

  if (sameSecret(entry.passcode, passcode)) {
    const session = randomBytes(16).toString("hex");
    entry.sessions.add(session);
    return { ok: true, session };
  }

  entry.attemptsLeft -= 1;
  if (entry.attemptsLeft <= 0) {
    for (const [known, value] of links) if (value === entry) links.delete(known);
    onDestroyed();
    return { ok: false, attemptsLeft: 0, dead: true };
  }
  return { ok: false, attemptsLeft: entry.attemptsLeft, dead: false };
}

/** Is this request carrying a session cookie this link issued? */
function unlocked(entry, req) {
  const header = req.headers.cookie;
  if (!header) return false;

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== "bf_share") continue;
    const value = rest.join("=");
    for (const session of entry.sessions) {
      if (sameSecret(session, value)) return true;
    }
  }
  return false;
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
  form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 4px 0 18px; }
  .code {
    font: 600 26px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .3em; width: 6.5em; padding: 12px 14px; min-height: 48px;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--paper); color: var(--ink);
  }
  button.btn {
    padding: 12px 18px; border-radius: 10px; border: 1px solid #2f6fed;
    background: #2f6fed; color: #fff; font: 15px system-ui, sans-serif; min-height: 48px;
  }
  .warn { color: #b3261e; font-family: system-ui, sans-serif; font-size: .9em; }
  @media (prefers-color-scheme: dark) { .warn { color: #f2b8b5; } }
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
    res.writeHead(200, secure({ "Content-Type": "text/html; charset=utf-8" }));
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

    res.writeHead(200, secure({ "Content-Type": "text/html; charset=utf-8" }));
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
      res.writeHead(200, secure({
        "Content-Type": "application/epub+zip",
        // Without this a phone browser tries to render the zip rather than save it.
        "Content-Disposition": `attachment; filename="${book.epubFile.replace(/[^\w.-]/g, "_")}"`,
        "Content-Length": data.length,
      }));
      res.end(data);
    } catch {
      notFound(res);
    }
  }],
];

/**
 * The gate. Deliberately says nothing about the book - not its title, not its
 * genre - because whoever is looking at this has not proved they may see it.
 */
function askForPasscode(res, token, { wrong = false, attemptsLeft = 0 } = {}) {
  res.writeHead(wrong ? 401 : 200, secure({ "Content-Type": "text/html; charset=utf-8" }));
  res.end(page("Passcode", `
<h1>Enter the passcode</h1>
<p class="sub">
  The six digits shown in the terminal where you started sharing.
</p>
<form method="POST" action="/s/${token}/unlock">
  <input class="code" name="passcode" inputmode="numeric" pattern="[0-9]*" maxlength="6"
         autocomplete="off" autofocus aria-label="Six digit passcode">
  <button class="btn primary" type="submit">Open</button>
</form>
${wrong ? `<p class="warn">Wrong passcode. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left before this link is destroyed.</p>` : ""}
<p class="note">
  The link alone is not enough on purpose, so forwarding it by accident does
  not hand over the book.
</p>`));
}

function notFound(res) {
  res.writeHead(404, secure({ "Content-Type": "text/html; charset=utf-8" }));
  res.end(page("Not found", `<h1>Not found</h1><p class="sub">This link has expired, been revoked, or never existed.</p>`));
}

/**
 * @param {object} [tls]  { key, cert } to serve HTTPS. Omit only for a
 *                        deliberate plaintext fallback - see the CLI.
 */
const UNLOCK = /^\/s\/([0-9a-f]{32})\/unlock\/?$/;

export function createShareServer(tls = null, { onDestroyed = () => {} } = {}) {
  const handler = async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const unlockMatch = pathname.match(UNLOCK);

    // POST exists for exactly one path: submitting the passcode. It writes
    // nothing to the library - only to the in-memory session set for this
    // link - so the "no write surface" property is unchanged.
    if (req.method === "POST" && unlockMatch) {
      const token = unlockMatch[1];
      const submitted = await readPasscode(req);
      const result = unlock(token, submitted, onDestroyed);

      if (!result.ok) {
        if (result.dead) return notFound(res);
        // A wrong guess should not be cheap to make a thousand times.
        await new Promise((r) => setTimeout(r, 400));
        return askForPasscode(res, token, { wrong: true, attemptsLeft: result.attemptsLeft });
      }

      res.writeHead(303, secure({
        Location: `/s/${token}`,
        // Secure only under TLS: a Secure cookie is silently dropped over
        // plain HTTP, which would lock out anyone on the --insecure path.
        "Set-Cookie": `bf_share=${result.session}; Path=/s/${token}; HttpOnly; SameSite=Strict; Max-Age=86400${tls ? "; Secure" : ""}`,
      }));
      return res.end();
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      // Everything else is read-only; say so plainly.
      res.writeHead(405, secure({ Allow: "GET, HEAD", "Content-Type": "text/plain" }));
      return res.end("This server is read-only.\n");
    }

    // A GET of the unlock path is someone reloading the form.
    if (unlockMatch) {
      return resolve(unlockMatch[1])
        ? askForPasscode(res, unlockMatch[1])
        : notFound(res);
    }

    for (const [pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (!match) continue;

      const entry = resolve(match[1]);
      if (!entry) return notFound(res);

      // The gate. Nothing about the book - not even its title - is served
      // before the passcode, so the page cannot leak what it is protecting.
      if (!unlocked(entry, req)) return askForPasscode(res, match[1]);

      try {
        return await handler(res, match.slice(1), entry);
      } catch {
        res.writeHead(500, secure({ "Content-Type": "text/plain" }));
        return res.end("error\n");
      }
    }

    notFound(res);
  };

  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

/** Reads the passcode field, with a hard cap so a body cannot exhaust memory. */
function readPasscode(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024) { body = body.slice(0, 1024); req.destroy(); }
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      resolve((params.get("passcode") || "").trim());
    });
    req.on("error", () => resolve(""));
  });
}

export const __test = { links, resolve, unlocked, MAX_ATTEMPTS };
