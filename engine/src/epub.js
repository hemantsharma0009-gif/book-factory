/**
 * EPUB 3 assembler.
 *
 * Hand-rolled rather than pulled from a library so the output stays auditable:
 * KDP rejects malformed packages, and when it does, you need to be able to read
 * the OPF yourself. The one non-obvious rule is that `mimetype` must be the
 * first entry in the zip and STORED (uncompressed) - readers check bytes 30-60
 * of the archive for it.
 */
import JSZip from "jszip";
import { randomUUID } from "node:crypto";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Minimal, dependency-free Markdown -> XHTML for the subset agents emit. */
export function markdownToXhtml(markdown) {
  const blocks = String(markdown).replace(/\r\n/g, "\n").split(/\n{2,}/);

  return blocks
    .map((raw) => {
      const block = raw.trim();
      if (!block) return "";

      if (block.startsWith("### ")) return `<h3>${inline(block.slice(4))}</h3>`;
      if (block.startsWith("## ")) return `<h2>${inline(block.slice(3))}</h2>`;
      if (block.startsWith("# ")) return `<h2>${inline(block.slice(2))}</h2>`;

      if (/^\s*[-*]\s+/.test(block)) {
        const items = block
          .split("\n")
          .filter((l) => /^\s*[-*]\s+/.test(l))
          .map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      if (/^\s*\d+\.\s+/.test(block)) {
        const items = block
          .split("\n")
          .filter((l) => /^\s*\d+\.\s+/.test(l))
          .map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`)
          .join("");
        return `<ol>${items}</ol>`;
      }

      if (block.startsWith("> ")) {
        return `<blockquote><p>${inline(block.replace(/^>\s?/gm, ""))}</p></blockquote>`;
      }

      return `<p>${inline(block)}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

function inline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br/>");
}

const STYLESHEET = `@namespace epub "http://www.idpf.org/2007/ops";
body { font-family: Georgia, "Times New Roman", serif; line-height: 1.55; margin: 0 5%; text-align: justify; }
h1, h2, h3 { font-family: Georgia, serif; line-height: 1.25; text-align: left; }
h1 { font-size: 1.7em; margin: 2em 0 0.2em; }
h2 { font-size: 1.2em; margin: 1.6em 0 0.4em; }
p { margin: 0 0 0.9em; text-indent: 0; }
p + p { text-indent: 1.2em; margin-top: -0.6em; }
blockquote { margin: 1em 2em; font-style: italic; }
.chapter-number { font-size: 0.8em; letter-spacing: 0.18em; text-transform: uppercase; color: #666; margin-bottom: 0.2em; }
figure { margin: 1.6em 0; text-align: center; page-break-inside: avoid; }
figure img, figure svg { max-width: 100%; height: auto; }
figcaption { font-size: 0.85em; color: #555; margin-top: 0.4em; text-align: center; }
table.figure-data { width: 100%; border-collapse: collapse; font-size: 0.82em; margin: 0.8em 0 0; }
table.figure-data th, table.figure-data td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: right; }
table.figure-data th[scope="row"] { text-align: left; }
.title-page { text-align: center; margin-top: 25%; }
.title-page h1 { font-size: 2.2em; text-align: center; }
.title-page .subtitle { font-size: 1.1em; font-style: italic; color: #444; }
.title-page .author { margin-top: 3em; font-size: 1em; letter-spacing: 0.1em; }
.front-note { font-size: 0.85em; color: #555; margin-top: 4em; }`;

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * @param {object} book  { title, subtitle, author, language, description, chapters, figures, coverSvg, aiDisclosure }
 * @returns {Promise<Buffer>}
 */
export async function buildEpub(book) {
  const zip = new JSZip();
  const uuid = book.uuid || randomUUID();
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // 1. mimetype - first entry, stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  const oebps = zip.folder("OEBPS");
  oebps.file("style.css", STYLESHEET);

  const manifest = [];
  const spine = [];

  if (book.coverSvg) {
    oebps.file("cover.svg", book.coverSvg);
    manifest.push('<item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>');
    oebps.file(
      "cover.xhtml",
      xhtml(
        "Cover",
        `<div style="text-align:center;margin:0;padding:0"><img src="cover.svg" alt="${esc(book.title)}"/></div>`,
      ),
    );
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="yes"/>');
  }

  oebps.file(
    "title.xhtml",
    xhtml(
      book.title,
      `<div class="title-page">
<h1>${esc(book.title)}</h1>
${book.subtitle ? `<p class="subtitle">${esc(book.subtitle)}</p>` : ""}
<p class="author">${esc(book.author)}</p>
${book.aiDisclosure ? `<p class="front-note">${esc(book.aiDisclosure)}</p>` : ""}
</div>`,
    ),
  );
  manifest.push('<item id="titlepage" href="title.xhtml" media-type="application/xhtml+xml"/>');
  spine.push('<itemref idref="titlepage"/>');

  // Chapters, with any figure placed after the first section break.
  book.chapters.forEach((chapter, index) => {
    const id = `chap${String(index + 1).padStart(3, "0")}`;
    const figure = book.figures?.get?.(chapter.number);
    let bodyHtml = markdownToXhtml(chapter.body);

    if (figure) {
      oebps.file(figure.filename, figure.data);
      manifest.push(
        `<item id="${figure.id}" href="${figure.filename}" media-type="${figure.mediaType}"/>`,
      );
      const figureHtml = `<figure>
<img src="${figure.filename}" alt="${esc(figure.alt)}"/>
<figcaption>${esc(figure.alt)}</figcaption>
${figure.table || ""}
</figure>`;
      // Insert before the second <h2> if there is one, else append.
      const marker = bodyHtml.indexOf("<h2>", bodyHtml.indexOf("<h2>") + 1);
      bodyHtml = marker > -1
        ? bodyHtml.slice(0, marker) + figureHtml + bodyHtml.slice(marker)
        : bodyHtml + figureHtml;
    }

    oebps.file(
      `${id}.xhtml`,
      xhtml(
        chapter.title,
        `<section epub:type="chapter">
<p class="chapter-number">Chapter ${chapter.number}</p>
<h1>${esc(chapter.title.replace(/^Chapter\s+\d+:\s*/i, ""))}</h1>
${bodyHtml}
</section>`,
      ),
    );
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
  });

  // Navigation document (EPUB3 requirement).
  const navItems = book.chapters
    .map(
      (chapter, index) =>
        `<li><a href="chap${String(index + 1).padStart(3, "0")}.xhtml">${esc(chapter.title)}</a></li>`,
    )
    .join("\n");

  oebps.file(
    "nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>Contents</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
<li><a href="title.xhtml">Title page</a></li>
${navItems}
</ol></nav>
<nav epub:type="landmarks" hidden="hidden"><ol>
<li><a epub:type="bodymatter" href="chap001.xhtml">Begin reading</a></li>
</ol></nav>
</body>
</html>`,
  );
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');

  oebps.file(
    "content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:${uuid}</dc:identifier>
<dc:title>${esc(book.title)}</dc:title>
${book.subtitle ? `<dc:title id="subtitle">${esc(book.subtitle)}</dc:title>` : ""}
<dc:creator>${esc(book.author)}</dc:creator>
<dc:language>${esc(book.language || "en")}</dc:language>
<dc:date>${modified.slice(0, 10)}</dc:date>
${book.description ? `<dc:description>${esc(book.description)}</dc:description>` : ""}
<dc:publisher>${esc(book.publisher || book.author)}</dc:publisher>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
${manifest.join("\n")}
</manifest>
<spine>
${spine.join("\n")}
</spine>
</package>`,
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/epub+zip" });
}
