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
  amazon: { rate: 0.70, lowRate: 0.35, bandLow: 2.99, bandHigh: 9.99, label: "Amazon / KDP" },
  gumroad: { rate: 0.85, lowRate: 0.85, bandLow: 0, bandHigh: Infinity, label: "Gumroad" },
  play: { rate: 0.70, lowRate: 0.70, bandLow: 0, bandHigh: Infinity, label: "Google Play Books" },
  other: { rate: 0.80, lowRate: 0.80, bandLow: 0, bandHigh: Infinity, label: "Other store" },
};
