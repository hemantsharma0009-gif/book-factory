/**
 * Deterministic stand-in for the model, used by --dry-run.
 *
 * It exists so the whole pipeline - planning, batching, EPUB assembly,
 * approval, publishing payloads - can be exercised and tested without an API
 * key and without spending anything. The prose is obviously synthetic; the
 * point is shape and volume, not quality.
 */

const LOREM = [
  "The work begins where most accounts leave off, in the unglamorous middle of the thing.",
  "What follows is less a theory than a record of what held up under pressure.",
  "Three details matter here, and the first is easy to miss.",
  "Consider the ordinary case before reaching for the exception.",
  "The evidence is thinner than the confidence usually attached to it.",
  "By the end of the season the pattern was impossible to ignore.",
  "It is worth pausing on the mechanism, because the mechanism is the argument.",
  "Practitioners learned this long before anyone wrote it down.",
];

/** Cheap deterministic hash so the same prompt always yields the same text. */
function seedOf(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

export function stubProse(prompt, { words = 900 } = {}) {
  const seed = seedOf(prompt);
  const paragraphs = [];
  let produced = 0;
  let n = 0;

  while (produced < words) {
    const sentences = [];
    for (let i = 0; i < 5; i++) {
      sentences.push(LOREM[(seed + n + i) % LOREM.length]);
      n++;
    }
    const para = sentences.join(" ");
    produced += para.split(/\s+/).length;
    paragraphs.push(para);
  }

  return paragraphs.join("\n\n");
}
