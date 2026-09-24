/**
 * Delivery: putting a finished book somewhere you will actually see it.
 *
 * The engine writes books into its own library directory, which is fine for a
 * machine and useless for a person. Delivery copies the finished artifacts
 * somewhere you already look - a Google Drive folder, Dropbox, a NAS share.
 *
 * Two backends, chosen by the shape of BOOK_FACTORY_DELIVER_TO:
 *
 *   /Users/you/My Drive/Book Factory   a plain directory. If that directory is
 *                                      inside Google Drive for Desktop (or
 *                                      Dropbox, or iCloud), their own sync
 *                                      client uploads it. No API, no OAuth
 *                                      token for this engine to hold, nothing
 *                                      to expire.
 *
 *   rclone:gdrive:Book Factory         shell out to rclone, for a headless box
 *                                      with no sync client. rclone holds the
 *                                      credentials; the engine never sees them.
 *
 * Deliberately NOT a direct Google Drive API integration. That would mean this
 * engine storing a refresh token with write access to your whole Drive, on top
 * of the API key and the Gumroad token it already needs. The sync-client route
 * gives the same result and asks you for nothing.
 *
 * Delivery never fails a run. A book that was written but not copied is a
 * nuisance; a book lost because the copy failed is a paid-for book thrown
 * away. Every failure here is reported and swallowed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as store from "./store.js";
import { breakEven } from "./economics.js";

const run = promisify(execFile);

export const RCLONE_PREFIX = "rclone:";

/** Where deliveries go, or null when the feature is switched off. */
export function deliverTarget() {
  const raw = (process.env.BOOK_FACTORY_DELIVER_TO || "").trim();
  return raw || null;
}

/**
 * A folder name that survives every filesystem and both sync clients.
 *
 * Windows forbids \ / : * ? " < > |, macOS treats : specially in the Finder,
 * and a trailing dot or space is silently dropped by Windows - which would
 * make the engine's idea of the folder name differ from the one on disk, and
 * the next delivery would create a second folder beside the first.
 */
export function safeName(text) {
  return String(text)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 80) || "untitled";
}

/** `2026-09-22 — Nine Days Above the Treeline` */
export function folderNameFor(book) {
  const date = new Date(book.createdAt || Date.now()).toISOString().slice(0, 10);
  return `${date} — ${safeName(book.title)}`;
}

/**
 * A plain-language note beside the files, because a folder of .epub and .md in
 * Drive three weeks from now tells you nothing about what to do with it.
 */
function summaryFor(book) {
  const price = book.prices?.amazon || book.listing?.priceUsd;
  const inBand = price >= 2.99 && price <= 9.99;

  return `${book.title}
${book.subtitle || ""}

Written ${new Date(book.createdAt || Date.now()).toISOString().slice(0, 10)} by the book factory.
Status: ${String(book.status || "unknown").replace(/_/g, " ")}

  Genre      ${book.genreName || book.genre || "—"}
  Language   ${book.languageName || book.language || "English"}
  Length     ${(book.wordCount || 0).toLocaleString()} words in ${book.chapterCount || 0} chapters
  Price      ${price ? `$${Number(price).toFixed(2)}` : "—"}${
    price ? `  (Amazon royalty ${inBand ? "70%" : "35%"}${inBand ? "" : " - outside the $2.99-$9.99 band"})` : ""
  }
  Cost       ${book.cost?.usd != null ? `$${book.cost.usd.toFixed(2)} to produce` : "—"}${
    book.cost?.usd
      ? `\n  Breaks even${breakEven({ costUsd: book.cost.usd, listPriceUsd: price })
          .filter((r) => r.net > 0)
          .map((r) => `\n    ${r.label.padEnd(20)} ${r.copies} cop${r.copies === 1 ? "y" : "ies"} at $${r.net.toFixed(2)}/sale`)
          .join("")}`
      : ""
  }

WHAT IS IN HERE

  *.epub                 the book. Upload this to KDP, and to Gumroad.
  KDP-UPLOAD-SHEET.md    every field the KDP form asks for, in its order.
  cover.svg              the cover. KDP needs a raster - convert to
                         1600x2560 JPEG before uploading.
  manuscript.md          the text on its own, for reading or editing.
  plan.json              the outline the book was written from.

NOTHING IS PUBLISHED YET

This book is waiting for you to read it. The engine never publishes on its
own. When you are happy with it:

  node src/cli.js approve ${book.id}
  node src/cli.js publish ${book.id} --gumroad

Amazon has no upload API, so KDP stays manual - work down the upload sheet.
`;
}

/** Copy one directory's files. No recursion: a book directory is flat. */
async function copyInto(sourceDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const copied = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await fs.copyFile(path.join(sourceDir, entry.name), path.join(destDir, entry.name));
    copied.push(entry.name);
  }
  return copied;
}

/**
 * Delivers one book. Returns { delivered, where, files } or { delivered:false,
 * reason } - it throws only if you pass it a book id that does not exist.
 */
export async function deliverBook({ id, book = null, target = deliverTarget(), log = () => {} }) {
  if (!target) return { delivered: false, reason: "BOOK_FACTORY_DELIVER_TO is not set" };

  const state = await store.load();
  const record = book || store.findBook(state, id);
  if (!record) throw new Error(`No book ${id}`);

  const sourceDir = store.bookDir(record.id);
  const folder = folderNameFor(record);

  // The summary is written into the book's own directory first, so the copy
  // stays a plain directory copy and the engine's library and your Drive hold
  // exactly the same files.
  await store.writeArtifact(record.id, "ABOUT-THIS-BOOK.txt", summaryFor(record));

  try {
    if (target.startsWith(RCLONE_PREFIX)) {
      const remote = target.slice(RCLONE_PREFIX.length).replace(/\/+$/, "");
      const dest = `${remote}/${folder}`;
      await run("rclone", ["copy", sourceDir, dest, "--create-empty-src-dirs=false"]);
      log(`Delivered to ${dest}`);
      return { delivered: true, where: dest, files: (await fs.readdir(sourceDir)).length };
    }

    const root = expandHome(target);

    // The root must already exist. Creating it would be worse than failing:
    // if Drive is not running, or the path has a typo, mkdir -p would happily
    // make an ordinary local folder that never syncs, and you would believe
    // your books were safe in the cloud for as long as it took to notice.
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw Object.assign(new Error(`${root} is not a directory`), { code: "ENOENT" });
    }

    const dest = path.join(root, folder);
    const files = await copyInto(sourceDir, dest);
    log(`Delivered ${files.length} file(s) to ${dest}`);
    return { delivered: true, where: dest, files: files.length };
  } catch (err) {
    // Never let a failed copy cost you the book.
    const reason = err.code === "ENOENT" && !target.startsWith(RCLONE_PREFIX)
      ? `${target} does not exist - is the sync client running?`
      : err.message.trim().split("\n")[0];
    log(`Delivery failed: ${reason}`);
    log(`The book is safe in ${sourceDir}. Retry with: node src/cli.js deliver ${record.id}`);
    return { delivered: false, reason };
  }
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Where a sync client is likely to have put your Drive on this machine.
 *
 * Guessing saves you hunting for a path that differs per OS and per account,
 * and each candidate is confirmed to exist before it is offered.
 */
export async function likelyDriveFolders() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library", "CloudStorage"), // macOS, one dir per account
    path.join(home, "Google Drive"),
    path.join(home, "My Drive"),
    "G:\\My Drive",
    path.join(home, "Dropbox"),
    path.join(home, "OneDrive"),
  ];

  const found = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isDirectory()) continue;

      // macOS nests the real Drive one level down, named for the account.
      if (candidate.endsWith("CloudStorage")) {
        for (const entry of await fs.readdir(candidate)) {
          if (/^GoogleDrive-/.test(entry)) found.push(path.join(candidate, entry, "My Drive"));
        }
        continue;
      }
      found.push(candidate);
    } catch {
      // Not on this machine; try the next.
    }
  }
  return found;
}
