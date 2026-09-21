/**
 * KDP handoff pack.
 *
 * Amazon publishes no upload API, and driving kdp.amazon.com with a browser
 * bot breaches their terms and risks the account, so this deliberately stops
 * at the form. It produces everything the form asks for, in field order, so
 * uploading is copy-paste rather than authoring.
 */
import { AI_DISCLOSURE } from "../pipeline.js";

/** KDP's own limits, enforced here so you find out now rather than at the form. */
const LIMITS = { title: 200, subtitle: 200, description: 4000, keywords: 7, keywordChars: 50 };

export function buildKdpPack({ book, epubName }) {
  const { listing } = book;
  const warnings = [];

  if (book.title.length > LIMITS.title) warnings.push(`Title exceeds ${LIMITS.title} characters.`);
  if ((book.subtitle || "").length > LIMITS.subtitle) warnings.push(`Subtitle exceeds ${LIMITS.subtitle} characters.`);
  if (listing.description.length > LIMITS.description) {
    warnings.push(`Description is ${listing.description.length} characters; KDP allows ${LIMITS.description}.`);
  }
  if (listing.keywords.length !== LIMITS.keywords) {
    warnings.push(`KDP has exactly ${LIMITS.keywords} keyword slots; listing has ${listing.keywords.length}.`);
  }
  listing.keywords.forEach((keyword) => {
    if (keyword.length > LIMITS.keywordChars) warnings.push(`Keyword too long: "${keyword}"`);
    const titleWords = `${book.title} ${book.subtitle}`.toLowerCase().split(/\W+/);
    if (keyword.toLowerCase().split(/\W+/).some((w) => w.length > 3 && titleWords.includes(w))) {
      warnings.push(`Keyword "${keyword}" repeats a word from the title — KDP indexes the title already.`);
    }
  });

  const royalty = listing.priceUsd >= 2.99 && listing.priceUsd <= 9.99 ? "70%" : "35%";

  const markdown = `# KDP upload sheet — ${book.title}

Generated ${new Date().toISOString().slice(0, 10)} · book id \`${book.id}\`

Open https://kdp.amazon.com → **Create** → **Kindle eBook**, then work down this
sheet. Fields are in the order KDP asks for them.

## 1. Kindle eBook Details

| Field | Value |
|---|---|
| Language | English |
| Book Title | \`${book.title}\` |
| Subtitle | \`${book.subtitle}\` |
| Series | — |
| Edition number | 1 |
| Author | ${book.author} |
| Publisher | ${book.author} |

**Description** — paste verbatim (${listing.description.length}/${LIMITS.description} characters):

\`\`\`
${listing.description}
\`\`\`

**Publishing rights:** I own the copyright and hold the necessary publishing rights.

**AI-Generated Content:** ☑ **Yes** — this title contains AI-generated content.
When KDP asks which parts: **text** (AI-generated, then edited)${book.figureCount ? " and **images** (generated charts)" : ""}.
> ${AI_DISCLOSURE}

**Keywords** — one per slot:

${listing.keywords.map((k, i) => `${i + 1}. \`${k}\``).join("\n")}

**Categories** (choose the closest match KDP offers):

${listing.categories.map((c) => `- ${c}`).join("\n")}

**Age range / reading age:** leave blank unless targeting children.
**Pre-order:** No — release for sale now.

## 2. Kindle eBook Content

- **Manuscript:** upload \`${epubName}\`
- **Cover:** upload the cover — see the note below
- **AI Preview:** check the first chapter and the table of contents render correctly
- **ISBN:** not required for Kindle; leave blank

## 3. Kindle eBook Pricing

| Field | Value |
|---|---|
| KDP Select enrolment | Your call — 90-day Amazon exclusivity in exchange for Kindle Unlimited page reads. **Do not enrol if you are also selling this on Gumroad.** |
| Primary marketplace | Amazon.com |
| List price (USD) | **$${listing.priceUsd.toFixed(2)}** |
| Royalty plan | ${royalty} |
| Book Lending | Enabled |

Pricing rationale: ${listing.priceRationale}

${royalty === "35%" ? "> ⚠ This price falls outside the $2.99–$9.99 band, so it earns the 35% royalty rather than 70%.\n" : ""}
## Cover note

The generated cover is \`cover.svg\`. KDP requires a raster image — JPEG or TIFF,
ideally 1600 × 2560 px. Convert before uploading:

\`\`\`bash
rsvg-convert -w 1600 -h 2560 cover.svg -o cover.jpg
# or open cover.svg in a browser and export at 1600×2560
\`\`\`

## Before you submit

- [ ] Read the first chapter end to end — you are the approval gate, not the pipeline
- [ ] Confirm the AI-content disclosure is ticked
- [ ] Confirm you are under KDP's limit of 3 new titles per day on this account
- [ ] Spot-check two keywords against Amazon search for real demand
${warnings.length ? `\n## ⚠ Warnings\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : "\nNo validation warnings.\n"}`;

  return { markdown, warnings, royalty };
}
