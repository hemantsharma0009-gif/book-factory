/**
 * SVG figures for book pages.
 *
 * Constraints that drove the design, which differ from a web dashboard:
 *   - Most Kindles are greyscale e-ink, so series are separated by a
 *     SEQUENTIAL LIGHTNESS RAMP (monotonic, min 14 points of luminance apart),
 *     not by hue. A categorical hue palette would collapse into mush.
 *   - The page is static: there is no hover layer to fall back on, so every
 *     mark carries a direct value label and every figure is followed by a data
 *     table in the EPUB (which is also the relief for low-contrast light steps).
 *   - Light steps get a darker stroke so they stay visible on white paper.
 */

/** Monotonic light->dark ramp; verified distinct after greyscale conversion. */
export const RAMP = ["#1d3557", "#457b9d", "#89b0c4", "#c9dde5"];
const INK = "#1b1b1b";
const MUTED = "#6b6b6b";
const AXIS = "#c8c8c8";
const SURFACE = "#ffffff";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function seriesFill(index, total) {
  if (total <= 1) return RAMP[0];
  // Walk the ramp darkest-first so a two-series chart uses the extremes.
  return RAMP[Math.min(index, RAMP.length - 1)];
}

function needsStroke(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (1.05) / (L + 0.05) < 3; // below 3:1 on white
}

/**
 * Grouped/simple bar chart.
 * data: { categories: string[], series: [{ name, values: number[] }] }
 */
export function barChart({ title, caption, data, width = 640, height = 400 }) {
  // top padding clears the title+caption band; axis labels start below it
  const pad = { top: 64, right: 16, bottom: 56, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const series = data.series;
  const max = Math.max(...series.flatMap((s) => s.values), 0) || 1;
  const groupW = plotW / data.categories.length;
  const gap = 2; // 2px surface gap between adjacent fills
  const barW = Math.max(6, (groupW - 16 - gap * (series.length - 1)) / series.length);

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = pad.top + plotH - t * plotH;
      return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${AXIS}" stroke-width="1"/>
<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${Math.round(t * max)}</text>`;
    })
    .join("\n");

  const bars = data.categories
    .map((cat, ci) => {
      const groupX = pad.left + ci * groupW + 8;
      return series
        .map((s, si) => {
          const value = s.values[ci] ?? 0;
          const h = Math.max(1, (value / max) * plotH);
          const x = groupX + si * (barW + gap);
          const y = pad.top + plotH - h;
          const fill = seriesFill(si, series.length);
          const stroke = needsStroke(fill) ? ` stroke="${RAMP[1]}" stroke-width="1"` : "";
          // 4px rounded data-end, anchored to the baseline.
          return `<path d="M${x} ${pad.top + plotH} L${x} ${y + 4} Q${x} ${y} ${x + 4} ${y} L${x + barW - 4} ${y} Q${x + barW} ${y} ${x + barW} ${y + 4} L${x + barW} ${pad.top + plotH} Z" fill="${fill}"${stroke}/>
<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="${INK}">${value}</text>`;
        })
        .join("\n");
    })
    .join("\n");

  const catLabels = data.categories
    .map((cat, ci) => {
      const x = pad.left + ci * groupW + groupW / 2;
      return `<text x="${x}" y="${height - pad.bottom + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(cat)}</text>`;
    })
    .join("\n");

  // A legend is required for two or more series; a single series is named by
  // the title, so it gets none.
  const legend =
    series.length > 1
      ? series
          .map((s, si) => {
            const x = pad.left + si * 128;
            const fill = seriesFill(si, series.length);
            return `<rect x="${x}" y="${height - 16}" width="10" height="10" rx="2" fill="${fill}" stroke="${RAMP[1]}" stroke-width="1"/>
<text x="${x + 15}" y="${height - 7}" font-size="10" fill="${MUTED}">${esc(s.name)}</text>`;
          })
          .join("\n")
      : "";

  return wrap({ title, caption, width, height, body: `${gridlines}\n${bars}\n${catLabels}\n${legend}` });
}

/** Single-measure line chart over an ordered axis. */
export function lineChart({ title, caption, data, width = 640, height = 380 }) {
  const pad = { top: 64, right: 20, bottom: 50, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = data.series[0].values;
  const max = Math.max(...values, 0) || 1;
  const step = values.length > 1 ? plotW / (values.length - 1) : 0;

  const points = values.map((v, i) => [pad.left + i * step, pad.top + plotH - (v / max) * plotH]);
  const path = points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");

  const gridlines = [0, 0.5, 1]
    .map((t) => {
      const y = pad.top + plotH - t * plotH;
      return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${AXIS}" stroke-width="1"/>
<text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${Math.round(t * max)}</text>`;
    })
    .join("\n");

  // Label only the endpoints and the peak - never a number on every point.
  const peak = values.indexOf(Math.max(...values));
  const labelled = [...new Set([0, peak, values.length - 1])];
  const markers = labelled
    .map((i) => {
      const [x, y] = points[i];
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${RAMP[0]}" stroke="${SURFACE}" stroke-width="2"/>
<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="${INK}">${values[i]}</text>`;
    })
    .join("\n");

  const catLabels = data.categories
    .map((cat, i) => {
      if (values.length > 8 && i % 2) return "";
      return `<text x="${(pad.left + i * step).toFixed(1)}" y="${height - pad.bottom + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(cat)}</text>`;
    })
    .join("\n");

  return wrap({
    title,
    caption,
    width,
    height,
    body: `${gridlines}\n<path d="${path}" fill="none" stroke="${RAMP[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>\n${markers}\n${catLabels}`,
  });
}

function wrap({ title, caption, width, height, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}">
<rect width="${width}" height="${height}" fill="${SURFACE}"/>
<text x="16" y="24" font-family="Georgia, serif" font-size="14" font-weight="bold" fill="${INK}">${esc(title)}</text>
${caption ? `<text x="16" y="40" font-family="Georgia, serif" font-size="11" fill="${MUTED}">${esc(caption)}</text>` : ""}
${body}
</svg>`;
}

/** The table that accompanies every figure - accessibility and print relief. */
export function dataTable(data) {
  const head = `<tr><th scope="col">&#160;</th>${data.categories.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
  const rows = data.series
    .map((s) => `<tr><th scope="row">${esc(s.name)}</th>${s.values.map((v) => `<td>${v}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="figure-data">\n<thead>${head}</thead>\n<tbody>${rows}</tbody>\n</table>`;
}

export function renderFigure({ kind = "bar", title, caption, data }) {
  const svg = kind === "line" ? lineChart({ title, caption, data }) : barChart({ title, caption, data });
  return { svg, table: dataTable(data) };
}
