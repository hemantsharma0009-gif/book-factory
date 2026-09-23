import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dashboard has no build step, so the file is loaded the same way a browser
// loads it: evaluated for its side effect of defining a global.
const here = path.dirname(fileURLToPath(import.meta.url));
new Function(fs.readFileSync(path.join(here, "..", "assets", "sales-parse.js"), "utf8"))();
const S = globalThis.BookFactorySales;

test("csv parsing survives what a storefront export actually contains", () => {
  const text = '﻿"Title","Units Sold","Royalty"\r\n' +
    '"Tarapatti, Volume 1",3,"7.50"\r\n' +          // comma inside a quoted field
    '"He said ""hello""",1,2.00\r\n' +              // doubled quotes
    '"A title\nwith a newline",2,4.00\r\n';         // newline inside quotes

  const rows = S.parseDelimited(text);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], ["Title", "Units Sold", "Royalty"]);   // BOM stripped
  assert.equal(rows[1][0], "Tarapatti, Volume 1");
  assert.equal(rows[2][0], 'He said "hello"');
  assert.equal(rows[3][0], "A title\nwith a newline");
});

test("tab-separated reports are detected, not mangled", () => {
  const rows = S.parseDelimited("Title\tUnits\tRoyalty\nOne Book\t2\t5.00\n");
  assert.deepEqual(rows[1], ["One Book", "2", "5.00"]);
});

test("money parses in the formats storefronts pay in", () => {
  assert.equal(S.parseMoney("$1,234.56"), 1234.56);
  assert.equal(S.parseMoney("1.234,56"), 1234.56);      // European: dot thousands
  assert.equal(S.parseMoney("12,99"), 12.99);           // European decimal comma
  assert.equal(S.parseMoney("1.234"), 1234);            // dot as thousands, no decimals
  assert.equal(S.parseMoney("USD 12.99"), 12.99);
  assert.equal(S.parseMoney("₹1,240.00"), 1240);
  assert.equal(S.parseMoney(""), 0);
  assert.equal(S.parseMoney("n/a"), 0);
});

test("a refund is negative money, however the report writes it", () => {
  // Getting this wrong turns money you gave back into money you earned.
  assert.equal(S.parseMoney("(4.20)"), -4.2);
  assert.equal(S.parseMoney("-4.20"), -4.2);
  assert.equal(S.parseMoney("-$4.20"), -4.2);
});

test("currency is read from a code or a symbol", () => {
  assert.equal(S.parseCurrency("USD"), "USD");
  assert.equal(S.parseCurrency("£12.99"), "GBP");
  assert.equal(S.parseCurrency("₹1,240"), "INR");
  assert.equal(S.parseCurrency("", "USD"), "USD");
});

test("column detection prefers net units over gross, and skips the traps", () => {
  const header = ["Royalty Date", "Title", "Author Name", "ASIN/ISBN", "Marketplace",
                  "Royalty Type", "Units Sold", "Units Refunded", "Net Units Sold",
                  "Royalty Rate", "Currency", "Royalty"];
  const cols = S.detectColumns(header);

  assert.equal(header[cols.title], "Title");
  assert.equal(header[cols.units], "Net Units Sold", "took gross units, or the refund column");
  assert.equal(header[cols.amount], "Royalty", "took the rate instead of the money");
  assert.equal(header[cols.currency], "Currency");
  assert.equal(header[cols.store], "Marketplace");
});

test("an amazon report is recognised as one", () => {
  assert.equal(S.detectSource(["Title", "ASIN/ISBN", "Royalty Type"]), "amazon");
  assert.equal(S.detectSource(["Book Title", "Publisher Revenue", "Book ID"]), "play");
  assert.equal(S.detectSource(["Item Name", "Quantity", "Earnings"]), "gumroad");
  assert.equal(S.detectSource(["Widget", "Count"]), "other");
});

test("a KDP-shaped report totals per title across marketplaces", () => {
  const csv = [
    "Royalty Date,Title,Author Name,ASIN/ISBN,Marketplace,Royalty Type,Units Sold,Units Refunded,Net Units Sold,Royalty Rate,Currency,Royalty",
    "2026-08,Tarapatti,Hemant Sharma,B0TEST1,Amazon.com,70%,4,0,4,0.7,USD,22.37",
    "2026-08,Tarapatti,Hemant Sharma,B0TEST1,Amazon.co.uk,70%,1,0,1,0.7,USD,5.59",
    "2026-08,Stone Sky Gods,Hemant Sharma,B0TEST2,Amazon.com,70%,2,1,1,0.7,USD,5.59",
    "Total,,,,,,7,1,6,,,33.55",
  ].join("\n");

  const out = S.parseReport(csv);
  assert.equal(out.error, undefined);
  assert.equal(out.source, "amazon");

  const tara = out.rows.find((r) => r.title === "Tarapatti");
  assert.equal(tara.units, 5, "marketplaces did not add up");
  assert.equal(Number(tara.amount.toFixed(2)), 27.96);

  // The totals row at the foot is not a book.
  assert.ok(!out.rows.some((r) => /^total/i.test(r.title)), "the Total line was imported as a title");
  assert.equal(out.rows.length, 2);
});

test("a report with a preamble above the header still parses", () => {
  const csv = [
    "KDP Royalties Report",
    "Generated 2026-09-01",
    "",
    "Title,Net Units Sold,Royalty,Currency",
    "Tarapatti,3,16.78,USD",
  ].join("\n");

  const out = S.parseReport(csv);
  assert.equal(out.error, undefined);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].units, 3);
});

test("currencies are totalled separately, never added together", () => {
  // 1,240 INR plus 18 GBP is not 1,258 of anything.
  const csv = [
    "Title,Net Units Sold,Currency,Royalty",
    "Tarapatti,4,USD,22.37",
    "Tarapatti,2,INR,1240.00",
    "Tarapatti,1,GBP,4.50",
  ].join("\n");

  const out = S.parseReport(csv);
  assert.equal(out.rows.length, 3, "rows in different currencies were merged");
  assert.equal(Number(out.currencies.USD.toFixed(2)), 22.37);
  assert.equal(Number(out.currencies.INR.toFixed(2)), 1240);
  assert.equal(Number(out.currencies.GBP.toFixed(2)), 4.5);
});

test("a file that is not a sales report says so instead of importing nonsense", () => {
  const out = S.parseReport("Name,Email\nSomeone,someone@example.com\n");
  assert.match(out.error, /title/i);
  assert.deepEqual(out.rows, []);
});

test("report titles match catalogue titles through their decorations", () => {
  const books = [
    { title: "The Untold Ravana (Sita Secret Edition)" },
    { title: "Common Core Math Series (Grades 3–9)" },
    { title: "Tarapatti" },
  ];

  assert.equal(S.matchTitle("Tarapatti", books).title, "Tarapatti");
  assert.equal(S.matchTitle("TARAPATTI", books).title, "Tarapatti");
  assert.equal(S.matchTitle("The Untold Ravana", books).title, "The Untold Ravana (Sita Secret Edition)");
  assert.equal(
    S.matchTitle("Common Core Math Series (Grades 3-9): Workbook", books).title,
    "Common Core Math Series (Grades 3–9)",
    "an en dash and an appended subtitle broke the match",
  );
  assert.equal(S.matchTitle("Something Else Entirely", books), null);
});

test("a short title does not prefix-match half the catalogue", () => {
  // "One" must not swallow "One Dashboard to Rule Them All".
  const books = [{ title: "One Dashboard to Rule Them All" }];
  assert.equal(S.matchTitle("One", books), null);
});
