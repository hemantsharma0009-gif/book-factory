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

/**
 * What Amazon deducts per megabyte of file, from the 70% royalty only.
 *
 * This is the single most surprising number in ebook economics, and it only
 * started mattering to this engine when books gained artwork. Text is tiny;
 * twelve generated photographs are not. The fee is charged on every sale for
 * as long as the book is listed, so a heavy book is not a one-off cost - it is
 * a permanent tax on the royalty.
 *
 * The rate differs by marketplace and Amazon changes it, so it is a default
 * rather than a fact: set BOOK_FACTORY_DELIVERY_FEE to the rate on your own
 * KDP dashboard.
 */
export const DELIVERY_FEE_PER_MB = Number(process.env.BOOK_FACTORY_DELIVERY_FEE || 0.15);

/**
 * Net per sale on one store at one price.
 *
 * `fileMb` only changes the answer where a store charges for delivery, which
 * today is Amazon's 70% option alone. The 35% option carries no delivery fee,
 * which is why a very large book can genuinely earn more at 35%.
 */
export function netPerSale(storeId, price, { fileMb = 0 } = {}) {
  const rule = ROYALTY[storeId];
  if (!rule || !price) return { rate: 0, net: 0, delivery: 0, gross: 0 };

  const inBand = price >= rule.bandLow && price <= rule.bandHigh;
  const rate = inBand ? rule.rate : rule.lowRate;
  const gross = price * rate;
  const delivery = rule.deliveryFee && inBand ? fileMb * DELIVERY_FEE_PER_MB : 0;

  // Amazon will not pay a negative royalty; it pays nothing. Reporting a
  // negative number would be arithmetic rather than truth.
  return { rate, gross, delivery, net: Math.max(0, gross - delivery) };
}

/**
 * Where a file is heavy enough that the 35% option pays better than 70%.
 *
 * 35% carries no delivery fee. Past roughly 23 MB at $9.99 the fee eats the
 * difference, and the option everyone is told to avoid becomes the right one.
 */
export function betterAtLowRate({ storeId = "amazon", price, fileMb }) {
  const rule = ROYALTY[storeId];
  if (!rule?.deliveryFee || !price) return false;
  const high = netPerSale(storeId, price, { fileMb });
  return price * rule.lowRate > high.net;
}

/**
 * Copies needed to recover a cost, per store.
 *
 * Amazon is quoted at the top of its 70% band when the list price is above it,
 * because that is the price the handoff sheet tells you to use - quoting a
 * royalty you have been advised not to take would make the figure fiction.
 */
export function breakEven({ costUsd, listPriceUsd, fileMb = 0 }) {
  if (!listPriceUsd) return [];

  return Object.keys(ROYALTY).map((storeId) => {
    const rule = ROYALTY[storeId];
    const price = Math.min(listPriceUsd, rule.bandHigh);
    const { rate, net, delivery } = netPerSale(storeId, price, { fileMb });

    return {
      store: storeId,
      label: rule.label,
      price,
      rate,
      net,
      delivery,
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
  // Delivery is charged on the delivered file, which is the EPUB.
  const fileMb = (book.epubBytes || 0) / (1024 * 1024);

  const stores = cost
    ? breakEven({ costUsd: cost, listPriceUsd: book.listing?.priceUsd, fileMb }).filter((row) => row.net > 0)
    : [];

  return {
    cost,
    stores,
    fileMb,
    delivery: {
      usd: stores.find((row) => row.store === "amazon")?.delivery || 0,
      perMb: DELIVERY_FEE_PER_MB,
      // Worth saying out loud, because the obvious reaction to a big file is
      // to shrug rather than to reprice.
      cheaperAtLowRate: betterAtLowRate({ price: book.listing?.priceUsd, fileMb }),
    },
    month: spentRecently(runs, 30),
  };
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

export function estimateRun({
  chapters,
  wordsPerChapter,
  price,
  batch = true,
  editorial = true,
  /** Pictures are billed per image by a different vendor, so they are a
   *  separate line rather than folded into the token maths. */
  images = 0,
  imageCostUsd = 0,
}) {
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

  // Image cost is not a band: it is a fixed price per picture, known up front.
  const imagesUsd = images * imageCostUsd;

  // A band rather than a point, because the model decides how long to write.
  return {
    low: usd * 0.75 + imagesUsd,
    high: usd * 1.4 + imagesUsd,
    mid: usd + imagesUsd,
    words: usd,
    images: imagesUsd,
    imageCount: images,
  };
}
