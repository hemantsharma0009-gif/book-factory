/**
 * Listing agent: produces everything the storefronts ask for.
 *
 * KDP's form is the strictest consumer (7 keyword slots, a 4000-character
 * description, 3 categories), so the schema is shaped to fill it exactly.
 */
import { z } from "zod";
import { structured } from "../model.js";
import { DEFAULTS, LANGUAGES } from "../config.js";

export const ListingSchema = z.object({
  description: z.string(),
  shortPitch: z.string(),
  keywords: z.array(z.string()).length(7),
  categories: z.array(z.string()).min(2).max(3),
  priceUsd: z.number().positive(),
  priceRationale: z.string(),
  coverBrief: z.object({
    concept: z.string(),
    palette: z.array(z.string()),
    mood: z.string(),
  }),
});

const SYSTEM = `You write storefront listings for ebooks on Amazon KDP and Gumroad.

You know the rules: KDP allows 7 keyword slots (phrases readers actually type,
not single generic words, and never words already in the title or subtitle), a description
up to 4000 characters, and up to 3 browse categories. You do not stuff keywords,
invent endorsements, fabricate reviews, or claim bestseller status.`;

export async function writeListing({ plan, genre, wordCount, angle = "", language = LANGUAGES.en }) {
  // A Hindi book sold to Hindi readers needs a Hindi description and Hindi
  // keywords - those are the words a buyer actually types into the search box.
  const inLanguage = language.code === "en"
    ? ""
    : `
Write the description, the short pitch and the keywords in ${language.name}
(${language.endonym}), in the ${language.script} script - these are read and
typed by ${language.name} readers. Keep the browse categories in English,
because that is the language of the store's own category tree.
`;

  const prompt = `Write the storefront listing for this book.${inLanguage}

TITLE: ${plan.title}
SUBTITLE: ${plan.subtitle}
GENRE: ${genre.name} (${genre.kind})
PREMISE: ${plan.premise}
AUDIENCE: ${plan.audience}
LENGTH: ${wordCount.toLocaleString()} words, ${plan.chapters.length} chapters

CHAPTERS:
${plan.chapters.map((c) => `${c.number}. ${c.title}`).join("\n")}

Produce:
- description: 150-300 words of sales copy. Open with the reader's problem or a hook, not the title. Plain text with line breaks; no HTML.
- shortPitch: one sentence under 140 characters.
- keywords: exactly 7 search phrases a real buyer would type. Multi-word.
  None may repeat any word from the title OR the subtitle - KDP indexes both
  already, so a repeat wastes one of only seven slots.
- categories: 2-3 realistic browse categories in "Parent > Child" form.
- priceUsd: a defensible price for a ${wordCount.toLocaleString()}-word ${genre.kind} ebook. Typical range is 2.99-14.99; 9.99 is the top of the 70% royalty band on KDP.
- priceRationale: one sentence on why that price.
- coverBrief: concept, 3-4 hex colours, and a mood, for a cover that reads at thumbnail size.`;

  return structured({
    schema: ListingSchema,
    prompt,
    system: SYSTEM,
    stub: () => ({
      description: genre.kind === "fiction"
        ? `${plan.premise}\n\nA novel in ${plan.chapters.length} chapters for ${plan.audience.toLowerCase()}`
        : `${plan.premise}\n\nThis book covers ${plan.chapters.length} chapters of practical material for ${plan.audience.toLowerCase()} Written to be read once and used many times.`,
      shortPitch: `${plan.title}: ${plan.subtitle}`.slice(0, 139),
      keywords: stubKeywords(plan, genre),
      categories: genre.kind === "fiction"
        ? [`Fiction > ${genre.name}`, `Fiction > ${genre.name} > General`]
        : [`Nonfiction > ${genre.name}`, `Reference > ${genre.name}`],
      priceUsd: DEFAULTS.priceUsd,
      priceRationale: "Priced at the top of the 70% royalty band for a full-length title.",
      coverBrief: {
        concept: `A bold typographic cover for ${plan.title}`,
        palette: ["#12203f", "#f4b942", "#f6f4ef"],
        mood: "confident, uncluttered, readable at thumbnail size",
      },
    }),
  });
}

/**
 * Dry-run keywords. Real keyword quality comes from the model; this exists so a
 * dry run produces a listing that passes the same KDP validation a real one
 * must - which means never colliding with the title or subtitle.
 */
function stubKeywords(plan, genre) {
  const pool = genre.kind === "fiction"
    ? [
        "page turner novel", "book club pick", "gripping read",
        "character driven story", "one sitting read", "modern fiction",
        "award winning author", "atmospheric storytelling", "debut novel",
      ]
    : [
        "self study workbook", "illustrated reference", "learn at home",
        "no prior experience", "worked examples", "weekend project",
        "field tested methods", "quick reference", "evening course",
      ];

  const taken = new Set(
    `${plan.title} ${plan.subtitle}`.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
  );
  const safe = pool.filter((phrase) =>
    !phrase.split(/\W+/).some((w) => w.length > 3 && taken.has(w)),
  );

  return safe.slice(0, 7);
}
