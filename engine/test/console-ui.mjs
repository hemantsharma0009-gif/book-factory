/**
 * The progress panel, end to end, in a real browser.
 *
 * Boots its own review console against a throwaway library, on a port the OS
 * picks, with the stub model - so it needs no key, spends nothing, and can run
 * beside anything else. Everything it checks is a promise the panel makes to
 * the person watching a book being written: the bar moves, the download works
 * mid-run, pause stops at a chapter boundary, an edit survives the editorial
 * pass, and the whole thing fits a phone.
 *
 *   node test/console-ui.mjs
 */
import { chromium, devices } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-console-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [path.join(here, "..", "src", "server.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    BOOK_FACTORY_DATA: dataDir,
    BOOK_FACTORY_DRY_RUN: "1",
    // Slow the stub down enough that a human-speed interaction - watching the
    // bar, clicking pause - is actually possible to test.
    BOOK_FACTORY_STUB_DELAY_MS: "12",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("review console")) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
});

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});

const check = async (label, fn) => {
  try {
    const detail = await fn();
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    problems.push(`${label}: ${err.message}`);
  }
};

try {
  await page.goto(`${base}/`);
  await page.waitForTimeout(600);

  await check("artwork is offered, and says what it needs when there is no key", async () => {
    const options = await page.locator("#genImages option").allTextContents();
    const artwork = page.locator("#genImages option", { hasText: "photographic artwork" });
    if (!(await artwork.count())) throw new Error(`no artwork option: ${options.join("|")}`);
    if (!(await artwork.isDisabled())) throw new Error("artwork offered with no image key configured");
    return options.length + " options";
  });

  // Dismissing the confirm means "dry run", which is free.
  page.on("dialog", (dialog) => dialog.dismiss());
  await page.selectOption("#genImages", "placeholder");
  await page.selectOption("#genMode", "live");
  await page.click("#generate");
  await page.waitForSelector("#runCard:not([hidden])", { timeout: 20000 });

  await check("the bar moves while the book is being written", async () => {
    const widths = new Set();
    for (let i = 0; i < 40; i += 1) {
      widths.add(await page.locator("#runBar").evaluate((el) => el.style.width));
      if (widths.size > 2) break;
      await page.waitForTimeout(400);
    }
    if (widths.size < 2) throw new Error(`never moved: ${[...widths].join(",")}`);
    return [...widths].slice(0, 4).join(" → ");
  });

  await check("the download control is in the same row as the bar", async () => {
    // Not a cosmetic point: the promise is that the book is yours at any
    // moment, so the way to take it must not be somewhere else on the page.
    const bar = await page.locator("#runBarWrap").boundingBox();
    const download = await page.locator("#dlEpub").boundingBox();
    const offset = Math.abs(bar.y + bar.height / 2 - (download.y + download.height / 2));
    if (offset > 20) throw new Error(`${Math.round(offset)}px apart vertically`);
    return `bar ${Math.round(bar.width)}px, button beside it`;
  });

  await check("chapters report their own state", async () => {
    await page.waitForFunction(() => document.querySelectorAll("#runChapters .chapter-chip").length > 0, null, { timeout: 20000 });
    const states = await page.locator(".chapter-chip").evaluateAll((els) => els.map((el) => el.dataset.state));
    if (!states.includes("waiting")) throw new Error(`no waiting chapters: ${states.join(" ")}`);
    return states.slice(0, 6).join(" ");
  });

  await check("pause says it will finish the current chapter first", async () => {
    await page.click("#runPause");
    await page.waitForTimeout(500);
    const hint = await page.locator("#runHint").innerText();
    if (!/finishes this one first|paid for/i.test(hint)) throw new Error(`hint was: ${hint}`);
    return hint.slice(0, 50);
  });

  await check("the run actually reaches paused", async () => {
    await page.waitForFunction(
      () => /^Paused after/.test(document.getElementById("runSummary").textContent),
      null,
      { timeout: 60000 },
    );
    if (await page.locator("#runResume").isHidden()) throw new Error("no resume button");
    if (!(await page.locator("#runPause").isHidden())) throw new Error("pause still offered");
    return await page.locator("#runSummary").innerText();
  });

  await check("the draft download is a real EPUB, mid-run", async () => {
    const href = await page.locator("#dlEpub").getAttribute("href");
    const response = await page.request.get(base + href);
    if (response.status() !== 200) throw new Error(`status ${response.status()}`);
    const body = await response.body();
    // Bytes 30-58 are where a reader looks for the stored mimetype entry.
    const marker = body.subarray(30, 58).toString();
    if (marker !== "mimetypeapplication/epub+zip") throw new Error(`not an EPUB: ${marker}`);
    return `${body.length} bytes`;
  });

  await check("a chapter opens for editing, and saving marks it yours", async () => {
    await page.locator(".chapter-chip:not([disabled])").first().click();
    await page.waitForSelector("#chapterBody", { timeout: 10000 });
    if ((await page.locator("#chapterBody").inputValue()).length < 100) throw new Error("editor loaded empty");

    await page.locator("#chapterBody").fill("These are my own words, and the editor must not touch them.");
    await page.click('[data-editor="save"]');
    await page.waitForTimeout(900);

    const state = await page.locator(".chapter-chip").first().getAttribute("data-state");
    if (state !== "edited-by-you") throw new Error(`chip state is ${state}`);
    return "chip reads edited-by-you";
  });

  await check("resuming finishes the book and leaves the edit alone", async () => {
    await page.click("#runResume");
    await page.waitForFunction(
      () => /^Finished/.test(document.getElementById("runSummary").textContent),
      null,
      { timeout: 180000 },
    );

    const state = await (await page.request.get(`${base}/api/state`)).json();
    const book = state.books[0];
    const chapter = await (await page.request.get(`${base}/api/runs/${book.id}/chapters/1`)).json();
    if (!chapter.body.startsWith("These are my own words")) {
      throw new Error(`the editorial pass overwrote it: ${chapter.body.slice(0, 60)}`);
    }
    return `${book.title} — ${book.chapterCount} chapters, ${book.figureCount} figures`;
  });

  await check("a live refresh does not blank the book you are reading", async () => {
    // The panel polls every 1.2s while a run is live. Re-rendering the detail
    // pane each time would wipe the reader, re-fetch the manuscript and throw
    // away your scroll position mid-paragraph.
    await page.locator(".queue-item").first().click();
    await page.waitForSelector("#reader", { timeout: 10000 });
    await page.waitForFunction(() => !/Loading/.test(document.getElementById("reader").textContent), null, { timeout: 15000 });

    await page.evaluate(() => { document.getElementById("reader").dataset.survived = "yes"; });
    await page.evaluate(async () => { await refresh(); await refresh(); });

    const survived = await page.locator("#reader").getAttribute("data-survived");
    if (survived !== "yes") throw new Error("the reader was re-rendered with nothing changed");
    return "reader untouched across two refreshes";
  });

  const phone = await browser.newPage({ ...devices["iPhone 13"] });
  await phone.goto(`${base}/`);
  await phone.waitForTimeout(800);

  await check("the panel fits a phone", async () => {
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 2) throw new Error(`${overflow}px of horizontal overflow`);
    const download = await phone.locator("#dlEpub").boundingBox();
    if (!download) throw new Error("download button not reachable");
    return `no overflow, download ${Math.round(download.width)}×${Math.round(download.height)}`;
  });
} finally {
  await browser.close();
  server.kill();
  await fs.rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${problems.length ? `${problems.length} PROBLEM(S)` : "console panel behaves"}`);
problems.forEach((p) => console.log(`  ${p}`));
process.exit(problems.length ? 1 : 0);
