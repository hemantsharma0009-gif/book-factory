/**
 * What a book cost, and what it has to sell to get that back.
 *
 * The cost of making a book is interesting at exactly one moment - before you
 * decide to make the next one. By the time you are looking at a finished
 * draft the money is spent, and whether to publish should turn on whether the
 * book is good, not on what it already cost. Letting a sunk cost drive that
 * decision is how a weak book gets published because "I already paid for it".
 *
 * So the number worth showing at the approval gate is not the cost on its own
 * but the break-even: how many copies get it back. In practice that is almost
 * always one, which is the reassuring thing to know.
 */
import { ROYALTY } from "./royalty.js";

/** Net per sale on one store at one price. */
export function netPerSale(storeId, price) {
  const rule = ROYALTY[storeId];
  if (!rule || !price) return { rate: 0, net: 0 };

  const rate = price >= rule.bandLow && price <= rule.bandHigh ? rule.rate : rule.lowRate;
  return { rate, net: price * rate };
}

/**
 * Copies needed to recover a cost, per store.
 *
 * Amazon is quoted at the top of its 70% band when the list price is above it,
 * because that is the price the handoff sheet tells you to use - quoting a
 * royalty you have been advised not to take would make the figure fiction.
 */
export function breakEven({ costUsd, listPriceUsd }) {
  if (!listPriceUsd) return [];

  return Object.keys(ROYALTY).map((storeId) => {
    const rule = ROYALTY[storeId];
    const price = Math.min(listPriceUsd, rule.bandHigh);
    const { rate, net } = netPerSale(storeId, price);

    return {
      store: storeId,
      label: rule.label,
      price,
      rate,
      net,
      // A book that cost nothing to make is already ahead; one with no net
      // per sale can never break even, and saying "0 copies" would be a lie.
      copies: !costUsd ? 0 : net > 0 ? Math.ceil(costUsd / net) : null,
    };
  });
}

/** What this engine has spent in the last `days` days, from the run log. */
export function spentRecently(runs, days = 30) {
  const since = Date.now() - days * 86400000;
  const recent = (runs || []).filter((run) => run.at >= since);

  return {
    usd: recent.reduce((sum, run) => sum + (run.cost?.usd || 0), 0),
    books: recent.length,
    days,
  };
}

/**
 * The lines to print under a finished book. Shared so the CLI, the review
 * console and the note delivered to Drive cannot disagree about the maths.
 */
export function economicsFor({ book, runs }) {
  const cost = book.cost?.usd || 0;

  // Break-even answers "how many sales get the money back". With no money
  // spent there is nothing to get back, and a row reading "0 copies" is noise
  // dressed up as information.
  const stores = cost
    ? breakEven({ costUsd: cost, listPriceUsd: book.listing?.priceUsd }).filter((row) => row.net > 0)
    : [];

  return { cost, stores, month: spentRecently(runs, 30) };
}

/**
 * What a run is likely to cost, before it starts.
 *
 * This is the only cost figure that can change a decision, because it is the
 * only one you see while the money is still yours. After the run it is spent
 * whatever the number says.
 *
 * The estimate is deliberately a range and deliberately rough: output length
 * is the model's to choose, and a book that runs long costs more. It is built
 * from what is actually known - the chapter count, the words asked for, and
 * the rates in config - rather than from a remembered figure.
 */
const TOKENS_PER_WORD = 1.4;     // English prose, Claude tokenizer, approximate
const BIBLE_TOKENS = 1200;       // the cached prefix shared by every chapter
const PROMPT_TOKENS = 400;       // per-chapter instructions on top of the bible

export function estimateRun({ chapters, wordsPerChapter, price, batch = true, editorial = true }) {
  const discount = batch ? 0.5 : 1;
  const outputPerChapter = wordsPerChapter * TOKENS_PER_WORD;

  // Drafting: one request per chapter, each reading the cached bible.
  const draftOutput = chapters * outputPerChapter;
  const draftInput = chapters * PROMPT_TOKENS;
  const draftCacheWrite = BIBLE_TOKENS;
  const draftCacheRead = chapters * BIBLE_TOKENS;

  // Editing: the whole manuscript is the cached prefix, so it is written once
  // and read back per chapter. This is the part that used to report as free.
  const manuscript = draftOutput;
  const editOutput = editorial ? chapters * outputPerChapter : 0;
  const editCacheWrite = editorial ? manuscript : 0;
  const editCacheRead = editorial ? chapters * manuscript : 0;

  const usd =
    ((draftInput / 1e6) * price.input +
      ((draftOutput + editOutput) / 1e6) * price.output +
      ((draftCacheWrite + editCacheWrite) / 1e6) * price.input * 1.25 +
      ((draftCacheRead + editCacheRead) / 1e6) * price.input * 0.1) *
    discount;

  // A band rather than a point, because the model decides how long to write.
  return { low: usd * 0.75, high: usd * 1.4, mid: usd };
}
