/**
 * Listing agent: produces everything the storefronts ask for.
 *
 * KDP's form is the strictest consumer (7 keyword slots, a 4000-character
 * description, 3 categories), so the schema is shaped to fill it exactly.
 */
import { z } from "zod";
import { structured } from "../model.js";
import { DEFAULTS } from "../config.js";

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
not single generic words, and never words already in the title), a description
up to 4000 characters, and up to 3 browse categories. You do not stuff keywords,
invent endorsements, fabricate reviews, or claim bestseller status.`;

export async function writeListing({ plan, genre, wordCount }) {
  const prompt = `Write the storefront listing for this book.

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
- keywords: exactly 7 search phrases a real buyer would type. Multi-word. None may repeat words from the title.
- categories: 2-3 realistic browse categories in "Parent > Child" form.
- priceUsd: a defensible price for a ${wordCount.toLocaleString()}-word ${genre.kind} ebook. Typical range is 2.99-14.99; 9.99 is the top of the 70% royalty band on KDP.
- priceRationale: one sentence on why that price.
- coverBrief: concept, 3-4 hex colours, and a mood, for a cover that reads at thumbnail size.`;

  return structured({
    schema: ListingSchema,
    prompt,
    system: SYSTEM,
    stub: () => ({
      description: `${plan.premise}\n\nThis book covers ${plan.chapters.length} chapters of practical material for ${plan.audience.toLowerCase()} Written to be read once and used many times.`,
      shortPitch: `${plan.title}: ${plan.subtitle}`.slice(0, 139),
      keywords: [
        `${genre.name.toLowerCase()} guide`,
        `beginner ${genre.name.toLowerCase()}`,
        `practical ${genre.name.toLowerCase()} book`,
        "step by step handbook",
        "self study workbook",
        "illustrated reference",
        "skills for beginners",
      ],
      categories: [`Nonfiction > ${genre.name}`, `Reference > ${genre.name}`],
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
