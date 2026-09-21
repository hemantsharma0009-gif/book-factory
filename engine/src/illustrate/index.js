/**
 * Illustration providers.
 *
 * v1 ships the `charts` provider, which costs nothing and needs no API key.
 * `stock` and `aigen` are declared with the same interface so they can be
 * implemented without touching the pipeline: each provider takes an image
 * brief and returns { mediaType, data, credit }.
 */
import { renderFigure } from "./charts.js";

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

export const providers = {
  charts: {
    id: "charts",
    label: "Generated charts and diagrams",
    costPerImage: 0,
    requiresKey: false,
    async generate({ chapter }) {
      if (!chapter.chartIdea) return null;
      const { svg, table } = renderFigure({
        kind: chapter.number % 2 ? "bar" : "line",
        title: chapter.chartIdea,
        caption: `Figure ${chapter.number}`,
        data: figureDataFor(chapter),
      });
      return {
        id: `fig-${String(chapter.number).padStart(3, "0")}`,
        mediaType: "image/svg+xml",
        filename: `fig-${String(chapter.number).padStart(3, "0")}.svg`,
        data: Buffer.from(svg, "utf8"),
        table,
        alt: chapter.chartIdea,
        credit: null,
      };
    },
  },

  stock: {
    id: "stock",
    label: "Public-domain and CC0 stock",
    costPerImage: 0,
    requiresKey: false,
    async generate() {
      throw new Error(
        "The stock provider is not implemented yet. It needs an Openverse/Wikimedia " +
          "search plus per-image licence capture so attribution can be written into " +
          "the back matter. Use --images charts until then.",
      );
    },
  },

  aigen: {
    id: "aigen",
    label: "AI-generated illustrations",
    costPerImage: 0.04,
    requiresKey: true,
    async generate() {
      throw new Error(
        "The AI image provider is not implemented yet. Wire an image API here and " +
          "set its key in the environment; remember KDP requires AI images to be " +
          "disclosed. Use --images charts until then.",
      );
    },
  },
};

export function getProvider(id) {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown image provider "${id}". Available: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}

export async function illustrate({ chapters, providerId = "charts" }) {
  if (providerId === "none") return new Map();
  const provider = getProvider(providerId);
  const figures = new Map();

  for (const chapter of chapters) {
    const figure = await provider.generate({ chapter });
    if (figure) figures.set(chapter.number, figure);
  }
  return figures;
}
