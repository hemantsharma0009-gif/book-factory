/**
 * Art director: decides what each picture in the book is OF.
 *
 * One structured call per book, before any image is generated. It sends the
 * plan - titles and summaries, not the prose - so it costs a fraction of a
 * chapter and produces briefs that are about this book rather than generic
 * illustrations of its subject.
 *
 * The split between English and the book's language is deliberate:
 *
 *   brief    goes to the IMAGE MODEL, so it is always in English. Image models
 *            are trained overwhelmingly on English prompts and a Hindi prompt
 *            produces a visibly worse picture.
 *   caption  and alt go into the BOOK, so they are in the book's language. A
 *            Hindi book with English captions is not a Hindi book.
 */
import { z } from "zod";
import { structured } from "../model.js";
import { LANGUAGES } from "../config.js";

const FigureSchema = z.object({
  number: z.number().int().positive(),
  brief: z.string(),
  caption: z.string(),
  alt: z.string(),
});

export const ArtDirectionSchema = z.object({
  palette: z.string(),
  coverBrief: z.string(),
  coverAlt: z.string(),
  figures: z.array(FigureSchema),
});

const SYSTEM = `You are an art director commissioning photography for a book.

You write briefs a photographer could shoot. A brief names a subject, a place,
a moment and a light. It is concrete.

  Good:  "A kitchen table at dawn, one chair pushed back, a cup still steaming,
          low side light through a net curtain."
  Bad:   "An image representing loss and the passage of time."

Rules you never break:

1. NO WRITING IN THE PICTURE. Never brief a sign, a book cover, a screen with
   text, a newspaper, a label, a whiteboard, handwriting or a clock face with
   numerals. Image models render lettering as convincing gibberish, and printed
   gibberish inside a book for sale is a defect.

2. NO REAL PEOPLE. No named person, living or dead, and nothing that would only
   work if the viewer recognised a particular face. Invented people are fine;
   so are hands, backs, crowds and silhouettes.

3. NO LOGOS OR BRANDS.

4. ONE BOOK, ONE LOOK. Every brief shares the palette you choose and the same
   world. A reader flicking through should see a series, not a stock library.

5. THE PICTURE IS NOT THE PARAGRAPH. Do not illustrate the chapter's argument
   literally. Brief the object, place or moment the chapter turns on - the
   thing a reader would remember.

For the cover: one dominant subject that still reads at thumbnail size, with
the upper third left comparatively plain so the title can sit over it.`;

function stubFor(plan, language) {
  return {
    palette: "cool slate blue with a single warm amber accent",
    coverBrief: `A single object from "${plan.title}" on a plain surface, low side light.`,
    coverAlt: `Cover artwork for ${plan.title}`,
    figures: plan.chapters.map((c) => ({
      number: c.number,
      brief: `A concrete scene from "${c.title}": an object on a worn surface, soft daylight.`,
      caption: `${c.title}`,
      alt: `Photograph illustrating ${c.title}`,
    })),
  };
}

export async function directArt({ plan, genre, language = LANGUAGES.en, every = 1 }) {
  // `every` thins the figures out: every=2 illustrates every second chapter.
  // Images are the most expensive thing per unit in the book, so this is the
  // knob that decides how much a book costs to illustrate.
  const wanted = plan.chapters.filter((c) => (c.number - 1) % every === 0);

  const inLanguage =
    language.code === "en"
      ? "Write captions and alt text in English."
      : `Write every caption and every alt text in ${language.name} (${language.endonym}), in the ${language.script} script, because they are printed in the book. Write the briefs themselves in English, because they are instructions to an image model.`;

  const result = await structured({
    schema: ArtDirectionSchema,
    stub: () => stubFor({ ...plan, chapters: wanted }, language),
    system: SYSTEM,
    maxTokens: 8000,
    prompt: `Book: "${plan.title}" - ${plan.subtitle}
Genre: ${genre.name} (${genre.kind})
Premise: ${plan.premise}
Audience: ${plan.audience}
Tone: ${plan.toneGuide}

${inLanguage}

First choose one palette for the whole book: a short phrase naming the colour
world every picture shares.

Then write a cover brief, and one brief for each of these chapters:

${wanted.map((c) => `${c.number}. ${c.title} — ${c.summary}`).join("\n")}

Return a figure for each chapter number listed above and no others.`,
  });

  // The model can return a chapter that was not asked for, or miss one. Trust
  // the plan, not the response: an extra figure would be attached to a chapter
  // that does not exist.
  const byNumber = new Map(result.figures.map((f) => [f.number, f]));
  return {
    ...result,
    figures: wanted.map((c) => byNumber.get(c.number)).filter(Boolean),
  };
}

export const __test = { stubFor, SYSTEM };
