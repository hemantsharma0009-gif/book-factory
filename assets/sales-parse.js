/**
 * Reading a sales report from a storefront.
 *
 * Amazon publishes no API for KDP, and Google Play Books offers downloadable
 * reports rather than a per-title feed, so the only honest way to get real
 * numbers off those two is the file you export from their console. This turns
 * one of those files into rows the dashboard can believe.
 *
 * It is deliberately separate from app.js and depends on nothing, so the fiddly
 * parts - quoted CSV fields, column guessing, money in six currencies - can be
 * tested directly rather than through a browser.
 *
 * Exported as a global rather than a module because the dashboard has no build
 * step; the tests load this same file and read the same global.
 */
(function (root) {
  "use strict";

  /**
   * A CSV parser that handles the things a storefront export actually contains:
   * a BOM from Excel, CRLF line endings, quoted fields with commas and quotes
   * inside them, and newlines inside a quoted title.
   *
   * Tab-separated files are common too (Play Books), so the delimiter is
   * sniffed from the header rather than assumed.
   */
  function parseDelimited(text) {
    var input = String(text || "").replace(/^﻿/, "");
    if (!input.trim()) return [];

    var firstLine = input.slice(0, input.indexOf("\n") === -1 ? input.length : input.indexOf("\n"));
    var delimiter = countOutsideQuotes(firstLine, "\t") > countOutsideQuotes(firstLine, ",") ? "\t" : ",";

    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;

    for (var i = 0; i < input.length; i++) {
      var ch = input[i];

      if (inQuotes) {
        if (ch === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          if (input[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') { inQuotes = true; continue; }
      if (ch === delimiter) { row.push(field); field = ""; continue; }

      if (ch === "\r") continue;
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }

      field += ch;
    }

    row.push(field);
    rows.push(row);

    return rows.filter(function (r) {
      return r.some(function (cell) { return String(cell).trim() !== ""; });
    });
  }

  function countOutsideQuotes(line, char) {
    var count = 0;
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuotes = !inQuotes;
      else if (line[i] === char && !inQuotes) count++;
    }
    return count;
  }

  /**
   * Money as a storefront writes it: "$1,234.56", "1.234,56", "(4.20)" for a
   * refund, "USD 12.99", or an empty cell.
   *
   * The separator heuristic: whichever of . and , appears LAST is the decimal
   * point. "1.234,56" is 1234.56 and "1,234.56" is also 1234.56 - getting this
   * backwards would inflate a European report by a thousandfold.
   */
  function parseMoney(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return 0;

    var negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
    var digits = raw.replace(/[^0-9.,]/g, "");
    if (!digits) return 0;

    var lastDot = digits.lastIndexOf(".");
    var lastComma = digits.lastIndexOf(",");

    if (lastDot > -1 && lastComma > -1) {
      var decimalAt = Math.max(lastDot, lastComma);
      digits = digits.slice(0, decimalAt).replace(/[.,]/g, "") + "." + digits.slice(decimalAt + 1);
    } else if (lastComma > -1) {
      // A lone comma is a decimal point only when it looks like one: "12,99".
      digits = /,\d{1,2}$/.test(digits) ? digits.replace(",", ".") : digits.replace(/,/g, "");
    } else {
      // A lone dot used as a thousands separator: "1.234" with no decimals.
      if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, "");
    }

    var number = Number(digits);
    if (!isFinite(number)) return 0;
    return negative ? -Math.abs(number) : number;
  }

  /** The currency the report is denominated in, from a code or a symbol. */
  var SYMBOLS = { "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR", "₩": "KRW", "R$": "BRL" };

  function parseCurrency(value, fallback) {
    var raw = String(value == null ? "" : value).trim();
    var code = raw.match(/\b([A-Z]{3})\b/);
    if (code) return code[1];
    for (var symbol in SYMBOLS) {
      if (raw.indexOf(symbol) >= 0) return SYMBOLS[symbol];
    }
    return fallback || "";
  }

  /**
   * Which column is which.
   *
   * Every storefront names these differently and renames them between years,
   * so each field is a list of patterns in order of confidence rather than one
   * exact header. The order matters: a KDP report has both "Units Sold" and
   * "Net Units Sold", and the net one is the number you were actually paid for.
   */
  var COLUMNS = {
    title: [/^(book\s*)?title$/i, /\btitle\b/i, /^item\s*name$/i, /^product(\s*name)?$/i, /\bbook\b/i],
    units: [/^net\s*units\s*sold$/i, /^units\s*sold$/i, /^quantity$/i, /^qty$/i, /\bunits\b/i, /\bcopies\b/i],
    amount: [
      /^royalty$/i, /^publisher\s*revenue$/i, /^earnings$/i, /^net\s*(amount|earnings|revenue)$/i,
      /\broyalt(y|ies)\b/i, /\bearnings\b/i, /\brevenue\b/i, /\bpayout\b/i, /\bamount\b/i,
    ],
    currency: [/^currency$/i, /\bcurrency\b/i],
    period: [/^royalty\s*date$/i, /^transaction\s*date$/i, /\bdate\b/i, /\bmonth\b/i, /\bperiod\b/i],
    store: [/^marketplace$/i, /\bmarketplace\b/i, /\bstore\b/i, /\bchannel\b/i, /\bplatform\b/i],
  };

  // Headers that look right but mean something else. "Royalty Rate" is 0.7,
  // not money; "Units Refunded" is already netted out of "Net Units Sold".
  var TRAPS = {
    units: [/refund/i, /returned/i],
    amount: [/rate/i, /\btype\b/i, /per\s*unit/i, /\bprice\b/i, /\btax\b/i],
    title: [/author/i, /publisher/i],
  };

  function detectColumns(header) {
    var cells = header.map(function (h) { return String(h || "").trim(); });
    var found = {};

    Object.keys(COLUMNS).forEach(function (field) {
      var traps = TRAPS[field] || [];

      for (var p = 0; p < COLUMNS[field].length; p++) {
        for (var c = 0; c < cells.length; c++) {
          if (found[field] !== undefined) continue;
          if (!cells[c]) continue;
          if (traps.some(function (trap) { return trap.test(cells[c]); })) continue;
          if (COLUMNS[field][p].test(cells[c])) found[field] = c;
        }
        if (found[field] !== undefined) break;
      }
    });

    return found;
  }

  /** Which storefront a report came from, guessed from its column names. */
  function detectSource(header) {
    var joined = header.join(" ").toLowerCase();
    if (/asin|kenp|kindle|royalty type/.test(joined)) return "amazon";
    if (/publisher revenue|book id|play/.test(joined)) return "play";
    if (/gumroad|item name/.test(joined)) return "gumroad";
    return "other";
  }

  /**
   * Turns a report into totals per title.
   *
   * Returns { rows, columns, source, currencies, skipped, error } where each
   * row is { title, units, amount, currency, period }. Rows for the same title
   * are summed, so a monthly report with one line per marketplace collapses to
   * one line per book - and a refund line, which carries negative money and
   * negative units, subtracts as it should.
   *
   * Amounts are NEVER summed across currencies. A report paying 1,240 INR and
   * 18 GBP has two totals, not one meaningless number.
   */
  function parseReport(text) {
    var table = parseDelimited(text);
    if (table.length < 2) return { error: "That file has no data rows.", rows: [] };

    // Some exports put a title or a blank line above the real header. Find the
    // first row that looks like headers rather than assuming row zero.
    var headerIndex = -1;
    var columns = null;
    for (var i = 0; i < Math.min(table.length, 12); i++) {
      var candidate = detectColumns(table[i]);
      if (candidate.title !== undefined && (candidate.units !== undefined || candidate.amount !== undefined)) {
        headerIndex = i;
        columns = candidate;
        break;
      }
    }

    if (headerIndex === -1) {
      return {
        error: "No column looked like a book title with units or royalties beside it.",
        rows: [],
        header: table[0] || [],
      };
    }

    var header = table[headerIndex];
    var source = detectSource(header);
    var byTitle = Object.create(null);
    var skipped = 0;
    var currencies = Object.create(null);

    for (var r = headerIndex + 1; r < table.length; r++) {
      var cells = table[r];
      var title = String(cells[columns.title] || "").trim();
      if (!title) { skipped++; continue; }

      // A totals row at the foot of the report is not a book.
      if (/^(total|grand total|sum)\b/i.test(title)) { skipped++; continue; }

      var units = columns.units === undefined ? 0 : Math.round(parseMoney(cells[columns.units]));
      var amount = columns.amount === undefined ? 0 : parseMoney(cells[columns.amount]);
      var currency = parseCurrency(
        columns.currency === undefined ? "" : cells[columns.currency],
        columns.amount === undefined ? "" : parseCurrency(cells[columns.amount], ""),
      ) || "USD";
      var period = columns.period === undefined ? "" : String(cells[columns.period] || "").trim();

      var key = title.toLowerCase() + "|" + currency;
      if (!byTitle[key]) {
        byTitle[key] = { title: title, units: 0, amount: 0, currency: currency, period: period };
      }
      byTitle[key].units += units;
      byTitle[key].amount += amount;
      if (period && !byTitle[key].period) byTitle[key].period = period;

      currencies[currency] = (currencies[currency] || 0) + amount;
    }

    var rows = Object.keys(byTitle).map(function (k) { return byTitle[k]; })
      .sort(function (a, b) { return b.amount - a.amount; });

    return { rows: rows, columns: columns, header: header, source: source, currencies: currencies, skipped: skipped };
  }

  /**
   * Matching a report row to a book in the catalogue.
   *
   * Storefronts decorate titles - a subtitle after a colon, an edition in
   * brackets, a series name appended - so an exact match is the exception.
   * Same loose key the catalogue merge uses, then a prefix match either way.
   */
  function titleKey(title) {
    return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function matchTitle(reportTitle, books) {
    var wanted = titleKey(reportTitle);
    if (!wanted) return null;

    var exact = null;
    var prefix = null;

    books.forEach(function (book) {
      var key = titleKey(book.title);
      if (!key) return;
      if (key === wanted) { exact = exact || book; return; }
      if (key.length < 6 || wanted.length < 6) return;
      if (wanted.indexOf(key) === 0 || key.indexOf(wanted) === 0) prefix = prefix || book;
    });

    return exact || prefix;
  }

  root.BookFactorySales = {
    parseDelimited: parseDelimited,
    parseMoney: parseMoney,
    parseCurrency: parseCurrency,
    detectColumns: detectColumns,
    detectSource: detectSource,
    parseReport: parseReport,
    titleKey: titleKey,
    matchTitle: matchTitle,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
