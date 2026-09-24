/**
 * Art direction.
 *
 * You asked for realistic or hyperrealistic artwork and left the style to me,
 * so these are the decisions and the reasons for them.
 *
 * ONE LOOK PER BOOK. A house style is written once per book and prepended to
 * every image prompt. Without it you get twelve unrelated stock photographs;
 * with it you get a book that was illustrated. This is the single biggest
 * difference between the two, and it costs nothing.
 *
 * PHOTOGRAPHIC, NOT PAINTERLY. "Realistic" from an image model means naming the
 * optics: focal length, light, depth of field, grade. Asking for "a realistic
 * image" gets you an airbrushed illustration; asking for "85mm, window light,
 * shallow depth of field" gets you a photograph.
 *
 * NEVER TEXT IN THE IMAGE. Image models still garble lettering, and a garbled
 * word printed inside a book you are selling is a defect a reader will
 * photograph and put in a review. Captions are typeset by the EPUB, where they
 * are real text a screen reader can read.
 *
 * NEVER A REAL PERSON. Invented faces only, no public figures, living or dead,
 * and no logos or trademarks. The legal exposure is asymmetric: the upside of
 * a recognisable face is nil and the downside is a takedown.
 */

/**
 * The look, by what kind of book it is. `kind` comes from the genre table.
 */
export const HOUSE_STYLES = {
  fiction: [
    "cinematic photographic realism, as if a still from a feature film",
    "shot on a full-frame camera at 50mm, shallow depth of field, subject sharp against a softly defocused background",
    "available light - window light, practical lamps, overcast daylight - never a studio flash look",
    "restrained filmic colour grade, gentle contrast, true blacks, no oversaturation",
    "fine natural film grain; photographic, never illustrated, painted or rendered",
  ],
  nonfiction: [
    "editorial photorealism in the manner of a magazine feature",
    "shot at 35mm, everything in the frame legible, composed with generous negative space",
    "clean directional daylight with soft shadows, real materials and real surfaces",
    "muted, confident colour; documentary rather than advertising",
    "photographic, never a diagram, never an illustration, never a 3D render",
  ],
};

/**
 * Appended to every prompt. Phrased as what the picture IS rather than a list
 * of what to avoid, because most image models follow positive instructions far
 * more reliably than negative ones - then the hard prohibitions, which are
 * worth stating even at a lower hit rate.
 */
export const CONSTRAINTS = [
  "The image contains no writing of any kind: no words, letters, numbers, captions, signage, labels, watermarks or signatures.",
  "Any person shown is entirely fictional and not recognisable as a real individual. Do not depict any real, living or historical public figure.",
  "No brand names, logos, trademarks or recognisable product designs.",
  "Nothing graphic, sexual or gory.",
].join(" ");

export function houseStyleFor(genre) {
  const lines = HOUSE_STYLES[genre?.kind === "fiction" ? "fiction" : "nonfiction"];
  return lines.join("; ");
}

/**
 * The prompt actually sent to the image model.
 *
 * Order matters: subject first, because every model weights the opening of the
 * prompt most heavily, then the book's look, then the hard constraints.
 */
export function buildImagePrompt({ brief, houseStyle, palette }) {
  return [
    String(brief).trim(),
    palette ? `Colour: ${palette}.` : "",
    `Style: ${houseStyle}.`,
    CONSTRAINTS,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Cover art is a different job from an interior figure: it is seen at
 * thumbnail size in a list of a hundred other books, so it needs one readable
 * shape and a strong value contrast rather than detail.
 *
 * The title is NOT drawn by the image model - it is typeset over the image as
 * real vector text, which is the only way to get a cover whose title is
 * actually spelled correctly.
 */
export function buildCoverPrompt({ brief, houseStyle, palette }) {
  return [
    String(brief).trim(),
    "Composition: a single dominant subject or shape, readable as a silhouette at thumbnail size. Strong light-to-dark contrast. Leave the upper third comparatively simple and uncluttered - book title typography will be placed over it afterwards.",
    palette ? `Colour: ${palette}.` : "",
    `Style: ${houseStyle}.`,
    CONSTRAINTS,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Where the alt text comes from.
 *
 * Alt text is not decoration: a reader using a screen reader gets the alt text
 * instead of the picture, and KDP's accessibility metadata asks whether images
 * have it. The art director writes a real description rather than repeating
 * the caption.
 */
export function altFor(figure) {
  return String(figure.alt || figure.brief || "Illustration").trim().slice(0, 300);
}
