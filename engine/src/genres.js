/**
 * Genre rotation. The requirement is that consecutive books never repeat a
 * genre, and that the catalogue keeps moving through the space rather than
 * settling on whatever was picked first.
 *
 * Selection is least-recently-used among genres outside the cooldown window,
 * so the rotation is deterministic and auditable rather than random.
 */
import { GENRE_COOLDOWN } from "./config.js";

export const GENRES = [
  {
    id: "adventure",
    name: "Adventure",
    kind: "fiction",
    angles: ["expedition survival", "lost city", "high-seas pursuit", "mountain rescue"],
  },
  {
    id: "mystery",
    name: "Mystery",
    kind: "fiction",
    angles: ["locked room", "cold case", "small-town disappearance", "art forgery"],
  },
  {
    id: "literary",
    name: "Literary fiction",
    kind: "fiction",
    angles: ["family inheritance", "immigrant homecoming", "a year in one house"],
  },
  {
    id: "scifi",
    name: "Science fiction",
    kind: "fiction",
    angles: ["generation ship", "first contact", "near-future labour", "terraforming"],
  },
  {
    id: "history",
    name: "Narrative history",
    kind: "nonfiction",
    angles: ["a single decisive year", "an overlooked inventor", "a city's rise"],
  },
  {
    id: "selfhelp",
    name: "Practical self-help",
    kind: "nonfiction",
    angles: ["habit design", "focus and attention", "money habits", "sleep"],
  },
  {
    id: "business",
    name: "Business and finance",
    kind: "nonfiction",
    angles: ["small-business pricing", "freelance operations", "personal investing"],
  },
  {
    id: "art",
    name: "Art and craft",
    kind: "nonfiction",
    angles: ["drawing fundamentals", "colour theory", "hand lettering", "ceramics"],
  },
  {
    id: "cooking",
    name: "Cooking",
    kind: "nonfiction",
    angles: ["one-pan meals", "regional baking", "fermentation", "batch cooking"],
  },
  {
    id: "science",
    name: "Popular science",
    kind: "nonfiction",
    angles: ["the deep ocean", "sleep and the brain", "materials", "weather"],
  },
  {
    id: "wellness",
    name: "Health and wellness",
    kind: "nonfiction",
    angles: ["strength after 40", "walking", "stress physiology", "gut health"],
  },
  {
    id: "technology",
    name: "Technology",
    kind: "nonfiction",
    angles: ["practical AI workflows", "home automation", "privacy", "data literacy"],
  },
];

export function genreById(id) {
  return GENRES.find((g) => g.id === id) || null;
}

/**
 * Pick the next genre. `history` is a list of genre ids, most recent first.
 * Genres used within the cooldown window are excluded outright; among the
 * rest we take the one used longest ago (never-used genres sort first).
 */
export function nextGenre(history = [], { cooldown = GENRE_COOLDOWN } = {}) {
  const recent = history.slice(0, cooldown);
  let eligible = GENRES.filter((g) => !recent.includes(g.id));

  // With a small catalogue and a long history every genre can fall inside the
  // window; relax to "anything but the immediately previous one".
  if (eligible.length === 0) {
    eligible = GENRES.filter((g) => g.id !== history[0]);
  }
  if (eligible.length === 0) eligible = GENRES.slice();

  const lastUsedIndex = (id) => {
    const i = history.indexOf(id);
    return i === -1 ? Infinity : -i; // never-used first, then longest-ago
  };

  return eligible.slice().sort((a, b) => lastUsedIndex(b.id) - lastUsedIndex(a.id))[0];
}

/** Rotate the angle too, so two Adventure books aren't both "lost city". */
export function nextAngle(genre, history = []) {
  const used = history
    .filter((h) => h.genre === genre.id)
    .map((h) => h.angle);
  const unused = genre.angles.filter((a) => !used.includes(a));
  return (unused.length ? unused : genre.angles)[0];
}
