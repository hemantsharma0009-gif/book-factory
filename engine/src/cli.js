#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   generate [--genre id] [--chapters n] [--words n] [--images charts|none] [--dry-run]
 *   status
 *   show <bookId>
 *   approve <bookId>
 *   reject <bookId> [reason]
 *   publish <bookId> [--gumroad] [--dry-run]
 *   pack <bookId>                 write the KDP upload sheet
 *   schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
 *   next-due                      exit 0 if a run is due (for cron)
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as store from "./store.js";
import { produceBook, slug } from "./pipeline.js";
import { buildKdpPack } from "./publish/kdp.js";
import { publishToGumroad } from "./publish/gumroad.js";
import { CADENCES, nextRunAt, isDue } from "./scheduler.js";
import { GENRES } from "./genres.js";

const args = process.argv.slice(2);
const command = args[0];

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const log = (line) => process.stdout.write(`${line}\n`);

async function main() {
  switch (command) {
    case "generate": {
      if (flag("dry-run")) process.env.BOOK_FACTORY_DRY_RUN = "1";
      const book = await produceBook({
        genreId: flag("genre", null) || null,
        chapters: Number(flag("chapters", 12)),
        wordsPerChapter: Number(flag("words", 2200)),
        images: String(flag("images", "charts")),
        author: String(flag("author", "Book Factory Studio")),
        log,
      });
      await writePack(book.id);
      log(`\nArtifacts: ${store.bookDir(book.id)}`);
      log(`Review it, then: node src/cli.js approve ${book.id}`);
      break;
    }

    case "status": {
      const state = await store.load();
      if (!state.books.length) return log("No books yet. Run: node src/cli.js generate --dry-run");
      log(`${state.books.length} book(s)\n`);
      for (const b of state.books) {
        log(
          `  ${b.id}  ${b.status.padEnd(18)} ${b.title}\n` +
            `             ${b.genreName} · ${b.wordCount.toLocaleString()} words · $${b.cost.usd.toFixed(2)}` +
            `${b.published.gumroad ? ` · gumroad: ${b.published.gumroad.url}` : ""}`,
        );
      }
      const next = nextRunAt(state.schedule, state.runs[0]?.at);
      log(`\nSchedule: ${state.schedule?.enabled ? `${CADENCES[state.schedule.cadence].label} at ${state.schedule.time}` : "off"}`);
      if (next) log(`Next run: ${new Date(next).toLocaleString()}`);
      break;
    }

    case "show": {
      const state = await store.load();
      const book = store.findBook(state, args[1]);
      if (!book) throw new Error(`No book ${args[1]}`);
      log(JSON.stringify(book, null, 2));
      break;
    }

    case "approve": {
      const id = args[1];
      await store.update((s) => {
        const book = store.findBook(s, id);
        if (!book) throw new Error(`No book ${id}`);
        if (book.status !== "awaiting_approval") throw new Error(`Book is ${book.status}, not awaiting approval.`);
        book.status = "approved";
        book.approvedAt = Date.now();
        book.updatedAt = Date.now();
      });
      log(`Approved ${id}. Publish with: node src/cli.js publish ${id} --gumroad`);
      break;
    }

    case "reject": {
      const id = args[1];
      const reason = args.slice(2).filter((a) => !a.startsWith("--")).join(" ") || "no reason given";
      await store.update((s) => {
        const book = store.findBook(s, id);
        if (!book) throw new Error(`No book ${id}`);
        book.status = "rejected";
        book.rejectedReason = reason;
        book.updatedAt = Date.now();
      });
      log(`Rejected ${id}: ${reason}`);
      break;
    }

    case "pack": {
      const file = await writePack(args[1]);
      log(`Wrote ${file}`);
      break;
    }

    case "publish": {
      const id = args[1];
      const dryRun = Boolean(flag("dry-run"));
      const state = await store.load();
      const book = store.findBook(state, id);
      if (!book) throw new Error(`No book ${id}`);
      if (book.status !== "approved") {
        throw new Error(
          `Book ${id} is "${book.status}". Publishing requires your explicit approval first: node src/cli.js approve ${id}`,
        );
      }

      if (flag("gumroad")) {
        const epubBuffer = await store.readArtifact(id, book.epubFile);
        const result = await publishToGumroad({ book, epubBuffer, epubName: book.epubFile, dryRun });
        if (dryRun) {
          log("Dry run — would create this Gumroad product:");
          log(JSON.stringify(result, null, 2));
        } else {
          await store.update((s) => {
            const b = store.findBook(s, id);
            b.published.gumroad = { ...result, at: Date.now() };
            b.status = "published";
            b.updatedAt = Date.now();
          });
          log(`Published to Gumroad: ${result.url}`);
        }
      }

      const packPath = await writePack(id);
      log(`KDP is manual by design — upload sheet: ${packPath}`);
      break;
    }

    case "schedule": {
      const cadence = String(flag("cadence", "weekly"));
      if (!CADENCES[cadence]) throw new Error(`Cadence must be one of: ${Object.keys(CADENCES).join(", ")}`);
      await store.update((s) => {
        s.schedule = {
          enabled: !flag("off"),
          cadence,
          time: String(flag("time", "09:00")),
          images: String(flag("images", "charts")),
        };
      });
      const state = await store.load();
      log(`Schedule: ${state.schedule.enabled ? `${CADENCES[cadence].label} at ${state.schedule.time}` : "disabled"}`);
      break;
    }

    case "next-due": {
      const state = await store.load();
      const due = isDue(state.schedule, state.runs[0]?.at);
      log(due ? "due" : "not due");
      process.exit(due ? 0 : 1);
      break;
    }

    case "genres": {
      for (const g of GENRES) log(`  ${g.id.padEnd(12)} ${g.name} (${g.kind})`);
      break;
    }

    default:
      log(`book-factory engine

  generate [--genre id] [--chapters n] [--words n] [--images charts|none] [--dry-run]
  status | show <id> | genres
  approve <id> | reject <id> [reason]
  pack <id>                       write the KDP upload sheet
  publish <id> --gumroad [--dry-run]
  schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
  next-due                        exit 0 when a run is due (for cron)`);
  }
}

async function writePack(id) {
  const state = await store.load();
  const book = store.findBook(state, id);
  if (!book) throw new Error(`No book ${id}`);
  const pack = buildKdpPack({ book, epubName: book.epubFile });
  const file = path.join(store.bookDir(id), "KDP-UPLOAD-SHEET.md");
  await fs.writeFile(file, pack.markdown);
  if (pack.warnings.length) {
    for (const w of pack.warnings) process.stderr.write(`  warning: ${w}\n`);
  }
  return file;
}

main().catch((err) => {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
});
