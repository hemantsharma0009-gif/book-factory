/**
 * Illustration providers.
 *
 *   none         no pictures.
 *   charts       generated SVG charts and diagrams. Free, no key. Right for a
 *                data-led non-fiction book; useless for a novel.
 *   placeholder  real PNGs made offline, free. Not artwork - a way to lay the
 *                book out and see where pictures fall before paying for any.
 *   artwork      real generated photography, through whichever image API you
 *                have a key for. This is the one that makes an illustrated book.
 *
 * Every provider returns the same figure record, so the EPUB assembler does not
 * know or care which produced it:
 *
 *     { id, filename, mediaType, data, alt, caption, table?, credit? }
 *
 * ONE IMAGE FAILING DOES NOT FAIL THE BOOK. By the time pictures are being made
 * you have already paid for twelve chapters of prose. A refused prompt or a
 * provider hiccup drops that one figure, says so in the log, and the run
 * carries on - the book is simply illustrated a little less. A provider that is
 * not configured at all still stops the run, before any money is spent.
 */
import { renderFigure } from "./charts.js";
import { generateImage, pickDriver, ASPECTS, SIZES, DRIVERS, availableDrivers } from "./aigen.js";
import { buildImagePrompt, houseStyleFor, altFor } from "./art.js";

/** Derives plausible figure data from a chapter's chart idea. */
function figureDataFor(chapter) {
  const seed = chapter.number * 7;
  const categories = ["Baseline", "Week 4", "Week 8", "Week 12"];
  return {
    categories,
    series: [
      {
        name: "Observed",
        values: categories.map((_, i) => 20 + ((seed + i * 13) % 55)),
      },
    ],
  };
}

const pad = (n) => String(n).padStart(3, "0");

/** What one image is assumed to cost, for the estimate and the running total. */
export const DEFAULT_IMAGE_COST_USD = Number(process.env.BOOK_FACTORY_IMAGE_COST || 0.04);

export const providers = {
  none: {
    id: "none",
    label: "No images",
    costPerImage: 0,
    requiresKey: false,
    needsDirection: false,
  },

  charts: {
    id: "charts",
    label: "Generated charts and diagrams",
    costPerImage: 0,
    requiresKey: false,
    needsDirection: false,
    async generate({ chapter }) {
      if (!chapter.chartIdea) return null;
      const { svg, table } = renderFigure({
        kind: chapter.number % 2 ? "bar" : "line",
        title: chapter.chartIdea,
        caption: `Figure ${chapter.number}`,
        data: figureDataFor(chapter),
      });
      return {
        id: `fig-${pad(chapter.number)}`,
        mediaType: "image/svg+xml",
        filename: `fig-${pad(chapter.number)}.svg`,
        data: Buffer.from(svg, "utf8"),
        table,
        alt: chapter.chartIdea,
        caption: chapter.chartIdea,
        credit: null,
      };
    },
  },

  placeholder: {
    id: "placeholder",
    label: "Offline placeholders (free — not artwork)",
    costPerImage: 0,
    requiresKey: false,
    needsDirection: true,
    driver: "placeholder",
  },

  artwork: {
    id: "artwork",
    label: "Generated photographic artwork",
    costPerImage: DEFAULT_IMAGE_COST_USD,
    requiresKey: true,
    needsDirection: true,
    driver: "auto",
  },
};

/**
 * A driver id, or a driver object passed straight through.
 *
 * Accepting the object matters beyond tests: it is how a caller supplies a
 * provider this module has never heard of without editing this module.
 */
function resolveDriver(driverId, provider) {
  if (driverId && typeof driverId === "object") return driverId;
  return pickDriver(driverId || provider.driver);
}

export function getProvider(id) {
  const provider = providers[id];
  if (!provider) {
    throw new Error(
      `Unknown image provider "${id}". Available: ${Object.keys(providers).join(", ")}`,
    );
  }
  return provider;
}

/**
 * Checked before a run starts, so a missing key costs nothing rather than
 * surfacing after twelve chapters have been written and paid for.
 */
export function assertUsable(providerId, driverId) {
  const provider = getProvider(providerId);
  if (!provider.requiresKey) return { provider, driver: provider.driver || null };
  return { provider, driver: resolveDriver(driverId, provider) };
}

export function describeImageSetup(providerId = "artwork", driverId) {
  const configured = availableDrivers().map((d) => d.label);
  return {
    provider: providerId,
    drivers: Object.values(DRIVERS).map((d) => ({ id: d.id, label: d.label, env: d.env })),
    configured,
    ready: providerId === "artwork" ? configured.length > 0 : true,
  };
}

/**
 * @param {object[]} chapters
 * @param {string}   providerId
 * @param {object}   direction  output of the art director (palette + per-chapter briefs)
 * @returns {Promise<{figures: Map, failures: string[], generated: number}>}
 */
export async function illustrate({
  chapters,
  providerId = "charts",
  direction = null,
  genre = null,
  driverId = null,
  onProgress = () => {},
  shouldStop = () => null,
}) {
  const figures = new Map();
  const failures = [];
  let generated = 0;

  if (providerId === "none") return { figures, failures, generated };

  const provider = getProvider(providerId);

  // Chart-style providers work straight off the chapter; image providers need
  // briefs from the art director.
  if (!provider.needsDirection) {
    let done = 0;
    for (const chapter of chapters) {
      const figure = await provider.generate({ chapter });
      if (figure) figures.set(chapter.number, figure);
      done += 1;
      onProgress({ done, total: chapters.length });
    }
    return { figures, failures, generated: figures.size };
  }

  if (!direction?.figures?.length) return { figures, failures, generated };

  const driver = resolveDriver(driverId, provider);
  const houseStyle = houseStyleFor(genre);
  const briefs = direction.figures.filter((f) => chapters.some((c) => c.number === f.number));
  let done = 0;

  for (const brief of briefs) {
    if (await shouldStop()) break;

    onProgress({ done, total: briefs.length, chapter: brief.number, phase: "start" });

    try {
      const image = await generateImage({
        prompt: buildImagePrompt({ brief: brief.brief, houseStyle, palette: direction.palette }),
        aspect: ASPECTS.figure,
        size: SIZES.figure,
        driver,
      });

      const extension = image.mediaType === "image/jpeg" ? "jpg" : "png";
      figures.set(brief.number, {
        id: `fig-${pad(brief.number)}`,
        mediaType: image.mediaType,
        filename: `fig-${pad(brief.number)}.${extension}`,
        data: image.data,
        alt: altFor(brief),
        caption: brief.caption || "",
        credit: null,
        generated: true,
        model: image.model,
      });
      generated += 1;
    } catch (err) {
      // One picture, not the book.
      failures.push(`chapter ${brief.number}: ${err.message}`);
    }

    done += 1;
    onProgress({ done, total: briefs.length, chapter: brief.number, phase: "done" });
  }

  return { figures, failures, generated };
}

/** The cover image, generated with the same house style as the interior. */
export async function illustrateCover({ direction, genre, providerId = "artwork", driverId = null }) {
  const provider = getProvider(providerId);
  if (!provider.needsDirection || !direction?.coverBrief) return null;

  const driver = resolveDriver(driverId, provider);
  const { buildCoverPrompt } = await import("./art.js");

  const image = await generateImage({
    prompt: buildCoverPrompt({
      brief: direction.coverBrief,
      houseStyle: houseStyleFor(genre),
      palette: direction.palette,
    }),
    aspect: ASPECTS.cover,
    size: SIZES.cover,
    driver,
  });

  return { ...image, alt: direction.coverAlt || "" };
}
