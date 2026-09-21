/**
 * Structural validation of a generated EPUB: every XML document must parse,
 * every manifest entry must resolve, and the required EPUB3 pieces exist.
 * Finally the first chapter is rendered in a real browser engine.
 */
import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const epubPath = process.argv[2];
const zip = await JSZip.loadAsync(await fs.readFile(epubPath));
const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

const problems = [];
const ok = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { console.log(`FAIL  ${m}`); problems.push(m); };

const mimetype = await zip.file("mimetype").async("string");
mimetype === "application/epub+zip" ? ok("mimetype content") : fail(`mimetype is "${mimetype}"`);

for (const req of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml"]) {
  names.includes(req) ? ok(`present: ${req}`) : fail(`missing: ${req}`);
}

// Every XML document must be well-formed - xmllint is the authority here.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "epubcheck-"));
const xmlFiles = names.filter((n) => /\.(xhtml|opf|xml|svg)$/.test(n));
let xmlErrors = 0;

for (const name of xmlFiles) {
  const file = path.join(tmp, name.replace(/\//g, "_"));
  await fs.writeFile(file, await zip.file(name).async("nodebuffer"));
  try {
    execFileSync("xmllint", ["--noout", file], { stdio: "pipe" });
  } catch (err) {
    fail(`XML not well-formed: ${name} — ${String(err.stderr).split("\n")[0]}`);
    xmlErrors++;
  }
}
if (!xmlErrors) ok(`all ${xmlFiles.length} XML documents are well-formed`);

const opf = await zip.file("OEBPS/content.opf").async("string");
const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const missing = hrefs.filter((h) => !names.includes(`OEBPS/${h}`));
missing.length ? fail(`manifest points at missing files: ${missing.join(", ")}`) : ok(`all ${hrefs.length} manifest hrefs resolve`);

const ids = [...opf.matchAll(/<item id="([^"]+)"/g)].map((m) => m[1]);
const idrefs = [...opf.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
const dangling = idrefs.filter((r) => !ids.includes(r));
dangling.length ? fail(`spine references unknown ids: ${dangling.join(", ")}`) : ok(`all ${idrefs.length} spine idrefs resolve`);

const nav = await zip.file("OEBPS/nav.xhtml").async("string");
nav.includes('epub:type="toc"') ? ok("nav has a toc") : fail("nav missing epub:type=toc");

const chapters = names.filter((n) => /chap\d+\.xhtml$/.test(n)).sort();
chapters.length ? ok(`${chapters.length} chapter documents`) : fail("no chapters");

const figures = names.filter((n) => /fig-\d+\.svg$/.test(n));
console.log(`INFO  ${figures.length} figure(s) embedded`);
if (figures.length) {
  const bodies = await Promise.all(chapters.map((c) => zip.file(c).async("string")));
  bodies.some((b) => b.includes("<img")) ? ok("figures referenced from chapters") : fail("figures embedded but unreferenced");
  bodies.some((b) => b.includes("figure-data")) ? ok("figures carry a data table") : fail("figure has no data table");
}

// Render in a real engine - catches encoding and markup breakage a parser misses.
const browser = await chromium.launch();
const page = await browser.newPage();
const html = (await zip.file(chapters[0]).async("string")).replace(/<\?xml[^>]*\?>/, "");
await page.setContent(html, { waitUntil: "domcontentloaded" });
const textLen = (await page.evaluate(() => document.body.innerText)).length;
textLen > 500 ? ok(`first chapter renders (${textLen} chars)`) : fail(`first chapter rendered only ${textLen} chars`);

if (figures.length) {
  const svg = await zip.file(figures[0]).async("string");
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  const box = await page.evaluate(() => {
    const el = document.querySelector("svg");
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), texts: el.querySelectorAll("text").length };
  });
  box.w > 100 && box.texts > 3
    ? ok(`figure renders ${box.w}×${box.h} with ${box.texts} labels`)
    : fail(`figure renders oddly: ${JSON.stringify(box)}`);
}

await browser.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${problems.length ? `${problems.length} PROBLEM(S)` : "EPUB structurally valid"}`);
process.exit(problems.length ? 1 : 0);
