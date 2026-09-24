/**
 * Cover generation.
 *
 * Produces an SVG that reads at thumbnail size. EPUB3 accepts SVG directly;
 * KDP wants a raster JPEG at 1600x2560, so the handoff pack carries the SVG
 * plus a conversion note. `npm run cover:png` converts it if Playwright or
 * rsvg-convert is available locally.
 */
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split a title into balanced lines so it stays readable small. */
function layoutTitle(title, maxPerLine = 11) {
  const words = title.split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    if ((line + " " + word).trim().length > maxPerLine && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

export function renderCover({ title, subtitle, author, brief }) {
  const palette = (brief?.palette || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const bg = palette[0] || "#12203f";
  const accent = palette[1] || "#f4b942";
  const paper = palette[2] || "#f6f4ef";

  const lines = layoutTitle(title);
  const startY = 760 - (lines.length - 1) * 80;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 2560" width="1600" height="2560">
<rect width="1600" height="2560" fill="${bg}"/>
<rect x="0" y="0" width="1600" height="24" fill="${accent}"/>
<rect x="120" y="360" width="180" height="10" fill="${accent}"/>
${lines
  .map(
    (line, i) =>
      `<text x="120" y="${startY + i * 168}" font-family="Georgia, 'Times New Roman', serif" font-size="150" font-weight="bold" fill="${paper}">${esc(line)}</text>`,
  )
  .join("\n")}
<text x="120" y="${startY + lines.length * 168 + 30}" font-family="Georgia, serif" font-size="58" fill="${accent}">${esc(subtitle || "")}</text>
<rect x="120" y="2180" width="180" height="6" fill="${accent}"/>
<text x="120" y="2280" font-family="Georgia, serif" font-size="52" fill="${paper}">${esc(author)}</text>
</svg>`;
}

/**
 * A cover built on generated artwork.
 *
 * The image is embedded in the SVG as base64 rather than referenced, so the
 * cover stays one self-contained file that survives being copied around - into
 * the EPUB, into Drive, into the handoff pack - without a second asset going
 * missing.
 *
 * The title is typeset here as vector text, NOT drawn by the image model.
 * Image models still render lettering as convincing nonsense; a cover whose
 * title is misspelled is unsellable, and this is the only way to be sure it
 * is not.
 *
 * `slice` crops the artwork to fill: image models return a fixed ratio and KDP
 * wants 1600x2560, so something has to give, and a cropped photograph is
 * better than a stretched one or a letterboxed band of white.
 */
export function renderPhotoCover({ title, subtitle, author, image, mediaType = "image/png", tint = "#0b1220" }) {
  const lines = layoutTitle(title);
  const startY = 700 - (lines.length - 1) * 80;
  const base64 = Buffer.isBuffer(image) ? image.toString("base64") : String(image);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1600 2560" width="1600" height="2560">
<defs>
<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${tint}" stop-opacity="0.92"/>
<stop offset="0.42" stop-color="${tint}" stop-opacity="0.45"/>
<stop offset="0.72" stop-color="${tint}" stop-opacity="0.25"/>
<stop offset="1" stop-color="${tint}" stop-opacity="0.85"/>
</linearGradient>
</defs>
<rect width="1600" height="2560" fill="${tint}"/>
<image x="0" y="0" width="1600" height="2560" preserveAspectRatio="xMidYMid slice" xlink:href="data:${mediaType};base64,${base64}"/>
<rect width="1600" height="2560" fill="url(#scrim)"/>
<rect x="120" y="300" width="180" height="10" fill="#ffffff" opacity="0.9"/>
${lines
  .map(
    (line, i) =>
      `<text x="120" y="${startY + i * 168}" font-family="Georgia, 'Times New Roman', serif" font-size="150" font-weight="bold" fill="#ffffff">${esc(line)}</text>`,
  )
  .join("\n")}
<text x="120" y="${startY + lines.length * 168 + 30}" font-family="Georgia, serif" font-size="58" fill="#ffffff" opacity="0.88">${esc(subtitle || "")}</text>
<text x="120" y="2300" font-family="Georgia, serif" font-size="52" fill="#ffffff" letter-spacing="4">${esc(author)}</text>
</svg>`;
}
