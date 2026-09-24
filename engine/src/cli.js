#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   generate [--genre id] [--language hi] [--chapters n] [--words n]
           [--images charts|none] [--dry-run] [--yes]
           [--sample n]          write only the first n chapters (default 2) to
                                 judge the prose cheaply before a full run
 *   status
 *   show <bookId>
 *   approve <bookId>
 *   reject <bookId> [reason]
 *   publish <bookId> [--gumroad] [--dry-run]
 *   rebuild <bookId>              reassemble the EPUB from an edited
 *                                 manuscript.md - no model call, no cost
 *   pack <bookId>                 write the KDP upload sheet
 *   deliver [bookId]              copy a book to BOOK_FACTORY_DELIVER_TO (your
 *                                 Drive folder). New books deliver themselves.
 *   export-dashboard [--out f]    write the catalogue as JSON for the dashboard
 *   share <bookId> [--hours n] [--insecure]
 *                                 serve this one book read-only on your LAN over
 *                                 HTTPS, so you can read it on a phone before
 *                                 approving
 *   schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
 *   next-due                      exit 0 if a run is due (for cron)
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as store from "./store.js";
import { produceBook, slug } from "./pipeline.js";
import { buildKdpPack, writeKdpPack } from "./publish/kdp.js";
import { publishToGumroad, listGumroadProducts } from "./publish/gumroad.js";
import { CADENCES, nextRunAt, isDue, shouldRun } from "./scheduler.js";
import { GENRES } from "./genres.js";
import { DEFAULTS, LANGUAGES, paths, PRICING, MODEL, isDryRun } from "./config.js";
import { createShareServer, mintLink, lanAddresses, makeCertificate } from "./share.js";
import { deliverBook, deliverTarget, likelyDriveFolders } from "./deliver.js";
import { buildDashboardExport } from "./dashboard-export.js";
import { rebuildBook, manuscriptIsNewer } from "./rebuild.js";
import { economicsFor, estimateRun } from "./economics.js";
import readline from "node:readline/promises";

const args = process.argv.slice(2);
const command = args[0];

/**
 * Above this, a real run asks before spending. Override in .env.
 *
 * Declared here rather than beside confirmSpend: anything below main()'s call
 * at the foot of this file is still in its temporal dead zone when a command
 * runs, and reading it throws.
 */
const CONFIRM_ABOVE_USD = Number(process.env.BOOK_FACTORY_CONFIRM_ABOVE || 1);

function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

// Piping to `head`, `less` or `grep -q` closes stdout early; without this the
// CLI dies with an unhandled EPIPE and a stack trace instead of exiting quietly.
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const log = (line) => process.stdout.write(`${line}\n`);

async function main() {
  switch (command) {
    case "generate": {
      if (flag("dry-run")) process.env.BOOK_FACTORY_DRY_RUN = "1";
      const sampleFlag = flag("sample", false);
      const sampleChapters = sampleFlag ? Number(sampleFlag === true ? 2 : sampleFlag) : 0;

      if (!(await confirmSpend({
        chapters: sampleChapters || Number(flag("chapters", 12)),
        wordsPerChapter: Number(flag("words", 2200)),
        assumeYes: Boolean(flag("yes")),
      }))) {
        log("Cancelled. Nothing was generated and nothing was spent.");
        break;
      }

      const book = await produceBook({
        genreId: flag("genre", null) || null,
        chapters: Number(flag("chapters", 12)),
        wordsPerChapter: Number(flag("words", 2200)),
        images: String(flag("images", "charts")),
        author: String(flag("author", "Book Factory Studio")),
        language: String(flag("language", DEFAULTS.language)),
        sample: sampleFlag ? Number(sampleFlag === true ? 2 : sampleFlag) : 0,
        log,
      });
      await writePack(book.id);

      // The upload sheet has to exist before the copy, or your Drive gets the
      // book without the instructions for publishing it.
      await deliverBook({ id: book.id, log });

      await reportEconomics(book.id, log);

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
          `  ${b.id}  ${b.status.padEnd(18)} ${b.title}${b.sample ? ` [SAMPLE ${b.sample.chapters}/${b.sample.of}]` : ""}\n` +
            `             ${b.genreName} · ${b.wordCount.toLocaleString()} words · $${b.cost.usd.toFixed(2)}` +
            `${b.published.gumroad ? ` · gumroad: ${b.published.gumroad.url}` : ""}`,
        );
      }
      const next = nextRunAt(state.schedule, state.runs[0]?.at);
      log(`\nSchedule: ${state.schedule?.enabled ? `${CADENCES[state.schedule.cadence].label} at ${state.schedule.time}` : "off"}`);
      if (next) log(`Next run: ${new Date(next).toLocaleString()}`);
      log(`Cron verdict: ${shouldRun(state).reason}`);
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

      if (await manuscriptIsNewer(id, book.epubFile)) {
        throw new Error(
          `manuscript.md was edited after ${book.epubFile} was built, so the EPUB does not ` +
            `contain your changes.\n\n` +
            `  node src/cli.js rebuild ${id}\n\n` +
            `Then publish. (This costs nothing - it only reassembles the file.)`,
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
          // Guards for unattended runs; see scheduler.shouldRun.
          maxPending: Number(flag("max-pending", s.schedule?.maxPending ?? 3)),
          monthlyBudgetUsd: Number(flag("budget", s.schedule?.monthlyBudgetUsd ?? 20)),
        };
      });
      const state = await store.load();
      log(`Schedule: ${state.schedule.enabled ? `${CADENCES[cadence].label} at ${state.schedule.time}` : "disabled"}`);
      log(`Guards: stop at ${state.schedule.maxPending} book(s) awaiting approval, $${state.schedule.monthlyBudgetUsd}/30 days`);
      break;
    }

    case "next-due": {
      const state = await store.load();
      const due = isDue(state.schedule, state.runs[0]?.at);
      log(due ? "due" : "not due");
      process.exit(due ? 0 : 1);
      break;
    }

    // What cron gates on: due AND within the backlog and budget guards.
    case "should-run": {
      const state = await store.load();
      const verdict = shouldRun(state);
      log(verdict.reason);
      process.exit(verdict.run ? 0 : 1);
      break;
    }

    // Reconcile a hand-published catalogue with the dashboard.
    case "share": {
      const id = args[1];
      const state = await store.load();
      const book = store.findBook(state, id);
      if (!book) throw new Error(`No book ${id}`);

      const port = Number(process.env.BOOK_FACTORY_SHARE_PORT || 4322);
      const hours = Number(flag("hours", 2));
      const addresses = lanAddresses(port);

      // HTTPS by default. The manuscript is unpublished work and the token
      // that unlocks it rides in the URL; neither belongs in cleartext on a
      // network you do not own.
      let tls = null;
      let fingerprint = null;
      if (!flag("insecure")) {
        try {
          const made = makeCertificate(addresses.map((a) => new URL(a).hostname));
          tls = { key: made.key, cert: made.cert };
          fingerprint = made.fingerprint;
        } catch (err) {
          throw new Error(
            `Could not generate a certificate (${err.message.trim().split("\n")[0]}).\n` +
              `openssl is needed for HTTPS. Install it, or run with --insecure to serve\n` +
              `plain HTTP - only do that on a network you trust.`,
          );
        }
      }

      const scheme = tls ? "https" : "http";
      const { token, passcode } = mintLink(book.id, hours * 3600_000);
      const server = createShareServer(tls, {
        onDestroyed: () => log(`\nLink destroyed after ${5} wrong passcodes. Run share again for a new one.`),
      });

      // 0.0.0.0 on purpose: the whole point is that a phone can reach it. The
      // review console, which can spend money and publish, stays on localhost.
      await new Promise((resolve) => server.listen(port, "0.0.0.0", resolve));

      log(`Sharing "${book.title}" read-only for ${hours} hour(s).\n`);
      if (addresses.length) {
        for (const base of addresses) log(`  ${base.replace(/^http:/, `${scheme}:`)}/s/${token}`);
      } else {
        log(`  ${scheme}://localhost:${port}/s/${token}   (no LAN address found)`);
      }

      log(`\n  Passcode: ${passcode.slice(0, 3)} ${passcode.slice(3)}\n`);
      log(`The page asks for those six digits before it shows anything about the
book - not even the title. So a link that gets forwarded, screenshotted or
logged somewhere is not on its own enough to read the book. Five wrong
attempts destroy the link.`);

      if (tls) {
        log(`
Open that on your phone, on the same wifi. It can read the book and save the
EPUB - nothing else. Approving and publishing stay on this machine.

Your phone will warn that the certificate is not trusted. That is expected: no
certificate authority will vouch for a private address like 192.168.x.x, so
this one is self-signed and thrown away when you stop. Before you tap through,
check the phone shows this fingerprint:

  ${fingerprint}

If it shows anything else, stop - something else is answering on that address.`);
      } else {
        log(`
WARNING: --insecure means plain HTTP. The book and the link are readable by
anyone who can watch traffic on this network. Only do this on a network you
trust, and never with the port forwarded to the internet.`);
      }

      log(`\nCtrl-C stops sharing and kills the link.`);

      // Hold the process open until interrupted.
      await new Promise(() => {});
      break;
    }

    case "deliver": {
      const target = deliverTarget();
      const id = args[1];

      if (!target) {
        log("Delivery is off: BOOK_FACTORY_DELIVER_TO is not set.\n");
        const found = await likelyDriveFolders();
        if (found.length) {
          log("Sync folders found on this machine:\n");
          for (const dir of found) log(`  ${dir}`);
          log(`\nPick one and add it to engine/.env, with a subfolder of your choosing:\n`);
          log(`  BOOK_FACTORY_DELIVER_TO=${found[0]}/Book Factory\n`);
        } else {
          log("No Google Drive, Dropbox or OneDrive folder found here.\n");
          log("Either install Google Drive for Desktop and re-run this, or use rclone:\n");
          log("  rclone config            # once, to authorise Google Drive");
          log("  BOOK_FACTORY_DELIVER_TO=rclone:gdrive:Book Factory\n");
        }
        log("Every book generated after that lands there by itself.");
        break;
      }

      if (!id) {
        log(`Delivering to: ${target}`);
        log(`New books land there automatically. To send an existing one:\n`);
        log(`  node src/cli.js deliver <bookId>`);
        break;
      }

      const result = await deliverBook({ id, log });
      if (!result.delivered) process.exitCode = 1;
      break;
    }

    case "rebuild": {
      const id = args[1];
      const result = await rebuildBook({ id, log });
      await writePack(id);
      await deliverBook({ id, log });
      log(`\nRebuilt ${result.epubFile} — ${(result.epubBytes / 1024).toFixed(0)} KB, ` +
        `${result.chapters} chapters, ${result.words.toLocaleString()} words.`);
      log(`The upload sheet has been refreshed to match.`);
      break;
    }

    case "export-dashboard": {
      const payload = await buildDashboardExport();
      const out = String(flag("out", path.join(paths().data, "dashboard.json")));
      await fs.writeFile(out, JSON.stringify(payload, null, 2));
      log(`Wrote ${payload.books.length} book(s) to ${out}`);
      log(`\nOpen the dashboard, go to Settings, and choose "Import library JSON".`);
      break;
    }

    case "languages": {
      for (const l of Object.values(LANGUAGES)) {
        log(`  ${l.code.padEnd(3)} ${l.name.padEnd(12)} ${l.endonym}`);
      }
      log(`\nUse: node src/cli.js generate --language hi`);
      break;
    }

    case "gumroad-list": {
      const products = await listGumroadProducts();
      if (!products.length) return log("No products found in that Gumroad account.");

      log(`${products.length} product(s) on Gumroad:\n`);
      for (const p of products) {
        log(`  ${p.published ? "LIVE " : "draft"}  ${p.title}`);
        log(`         ${p.url}`);
        if (p.sales != null) {
          log(`         ${p.sales} sale(s)${p.revenueUsd != null ? ` · $${p.revenueUsd.toFixed(2)}` : ""}`);
        }
      }

      // Paste-ready for the dashboard's bulk import.
      log(`\nPaste this into the dashboard (Library → Import live titles):\n`);
      for (const p of products.filter((x) => x.published)) {
        log(`${p.title} | ${p.url}`);
      }
      break;
    }

    case "genres": {
      for (const g of GENRES) log(`  ${g.id.padEnd(12)} ${g.name} (${g.kind})`);
      break;
    }

    default:
      log(`book-factory engine

  generate [--genre id] [--chapters n] [--words n] [--images charts|none] [--dry-run]
           [--sample n]          write only the first n chapters (default 2) to
                                 judge the prose cheaply before a full run
  status | show <id> | genres
  languages                       list the languages a book can be written in
  share <id> [--hours n]          read it on your phone before approving
  rebuild <id>                    rebuild the EPUB after editing manuscript.md
  deliver [id]                    copy a book to your Drive folder (no id: set-up help)
  export-dashboard [--out file]   write the catalogue for the dashboard to import
  approve <id> | reject <id> [reason]
  pack <id>                       write the KDP upload sheet
  publish <id> --gumroad [--dry-run]
  gumroad-list                    list what is already on sale in your Gumroad
  schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
           [--max-pending n] [--budget usd]
  should-run                      exit 0 when cron should generate (due + guards)
  next-due                        exit 0 when a run is due, ignoring guards`);
  }
}

async function writePack(id) {
  const { file, warnings } = await writeKdpPack(id);
  for (const w of warnings) process.stderr.write(`  warning: ${w}\n`);
  return file;
}

main().catch((err) => {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exit(1);
});

/**
 * What the book cost, and what gets it back.
 *
 * Printed after a run because that is when you decide whether to make another
 * one - not to weigh on whether to publish this one, which should turn on
 * whether it is any good.
 */
async function reportEconomics(id, log) {
  const state = await store.load();
  const book = store.findBook(state, id);
  if (!book) return;

  const { cost, stores, month } = economicsFor({ book, runs: state.runs });
  if (!cost && !month.usd) return;

  log("");
  log(`Cost to make: $${cost.toFixed(2)}`);

  for (const row of stores) {
    log(
      `  ${row.label.padEnd(18)} $${row.price.toFixed(2)} · ${Math.round(row.rate * 100)}% · ` +
        `$${row.net.toFixed(2)}/sale · breaks even on ` +
        (row.copies === 0 ? "nothing to recover" : `${row.copies} cop${row.copies === 1 ? "y" : "ies"}`),
    );
  }

  log(`\nSpent in the last ${month.days} days: $${month.usd.toFixed(2)} across ${month.books} run(s).`);
}

/**
 * Show what a run will cost, and get a yes when it is more than small change.
 *
 * The estimate is the only cost figure that can change a decision - after the
 * run the money is spent whatever it says. A dry run spends nothing, so it is
 * never gated.
 *
 * Never prompts when stdin is not a terminal. The scheduler runs this from
 * cron, where a question would hang forever holding the run lock, and a
 * factory that silently stops producing is worse than one that spends a
 * dollar unasked - the budget guard in the scheduler is what caps that.
 */
async function confirmSpend({ chapters, wordsPerChapter, assumeYes }) {
  const price = PRICING[MODEL] || PRICING["claude-sonnet-5"];
  const estimate = estimateRun({ chapters, wordsPerChapter, price });
  const dry = isDryRun();

  log(
    `About to write ${chapters} chapters of roughly ${wordsPerChapter.toLocaleString()} words ` +
      `with ${MODEL}, batched and cached.`,
  );
  // A dry run spends nothing, but the figure is the reason to do one - it is
  // what the real run would cost, seen before committing to it.
  log(
    dry
      ? `A real run would cost about $${estimate.low.toFixed(2)} – $${estimate.high.toFixed(2)}. This one is free.\n`
      : `Estimated cost: $${estimate.low.toFixed(2)} – $${estimate.high.toFixed(2)}\n`,
  );

  if (dry || assumeYes || estimate.mid <= CONFIRM_ABOVE_USD) return true;

  if (!process.stdin.isTTY) {
    log(`(over $${CONFIRM_ABOVE_USD.toFixed(2)}, but nothing is attached to ask - continuing)`);
    return true;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`That is over $${CONFIRM_ABOVE_USD.toFixed(2)}. Continue? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
