/**
 * What each storefront pays.
 *
 * These numbers also live in the dashboard, in assets/app.js - it is a static
 * page with no build step, so it cannot import this file. The duplication is
 * deliberate but dangerous: two copies of a pricing rule that disagree would
 * have the engine quoting one royalty and the dashboard another for the same
 * book. A unit test reads the dashboard's copy and fails if they drift.
 *
 * Amazon is the only one with a band: 70% between $2.99 and $9.99, 35% outside
 * it, so a $12.99 book earns less per sale than a $9.99 one.
 */
export const ROYALTY = {
  // `deliveryFee` marks the one store that charges for the file itself: KDP
  // deducts a per-megabyte delivery cost from the 70% option (and only that
  // option). It is the reason an illustrated book is not simply a better book.
  amazon: { rate: 0.70, lowRate: 0.35, bandLow: 2.99, bandHigh: 9.99, deliveryFee: true, label: "Amazon / KDP" },
  gumroad: { rate: 0.85, lowRate: 0.85, bandLow: 0, bandHigh: Infinity, label: "Gumroad" },
  play: { rate: 0.70, lowRate: 0.70, bandLow: 0, bandHigh: Infinity, label: "Google Play Books" },
  other: { rate: 0.80, lowRate: 0.80, bandLow: 0, bandHigh: Infinity, label: "Other store" },
};
