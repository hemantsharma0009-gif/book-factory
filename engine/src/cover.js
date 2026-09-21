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
