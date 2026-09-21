# Book Factory

An autonomous publishing operations console for planning, producing, packaging and
releasing digital books. It is a dependency-free static app — three files, no build
step, no server — that keeps its entire state in the browser's local storage.

**Live deployment:** static build, Vercel-ready. Open `index.html` directly or serve
the folder with any static file server.

## What it does

| Section | What it gives you |
| --- | --- |
| **Command Center** | Live portfolio metrics, the pipeline position of the active title, a control panel and an activity log of everything the system has done. |
| **Master Library** | Every title with search, category/status filters and sorting; add, edit, queue and delete books. |
| **Production** | The job queue plus a production engine that drafts chapters and moves titles through the ten pipeline stages, one step at a time or on a timer. |
| **Scheduler** | A real cron configuration — cadence, run time, timezone, batch size and automation toggles — with a computed next-run countdown and the exact books the next cycle would pick up. |
| **Blueprints** | Four production blueprints that seed a new book with its chapter count, word target and format, then queue it. |
| **Continuity Memory** | Continuity facts bound to books and rolled up into series bibles, with auto-extraction. |
| **Publishing** | Per-title EPUB/PDF/metadata/ZIP readiness derived from the book's actual state, a validator that explains every blocker, and a release action. |
| **Analytics** | Seven-day production activity, portfolio mix by category, and unit economics modelled from word counts against recorded revenue. |
| **Settings** | Storage usage, theme, and JSON export/import/reset. |

## Pipeline model

Ten stages, in order:

```
Brief → Blueprint → Research → Outline → Chapters → Editing → Fact Check → QA → Packaging → Publishing
```

Nothing about a book's progress is stored twice. Progress is **derived** from the
stage index, blended with chapter completion while a book is in the `Chapters` stage,
so the number on a card can never drift from the stage it is in. Status is derived
too:

- `BLOCKED` — the book has open QA blockers
- `RELEASED` — published and released
- `READY` — reached `Publishing`, awaiting release
- `RUNNING` — sitting in the production queue
- `PIPELINE` — everything else

The production engine advances one unit of work per tick: it drafts the next chapter
if any remain, otherwise it moves the book to the next stage. Entering `QA` with
automatic QA enabled runs real checks (undrafted chapters, word count below 75% of
target, incomplete metadata) and raises blockers that stop the book until they are
resolved.

## Production engine

The dashboard is the operations console. The **engine** (`engine/`) is what
actually produces books: it plans, drafts, edits, illustrates, packages and — once
you approve — publishes them.

```bash
cd engine && npm install
node src/cli.js generate --dry-run   # free, no API key required
npm start                            # approval console at 127.0.0.1:4321
```

Books cost roughly **$1** each to produce on `claude-sonnet-5` (Batch API at 50%
off, plus prompt caching). Gumroad publishing is fully automatic; Amazon KDP is
not, because **Amazon publishes no upload API** — the engine instead fills in
every field of the KDP form for you in `KDP-UPLOAD-SHEET.md`, including the
required AI-content disclosure. See `engine/README.md`.

## Project layout

```
index.html         markup and page shells only
assets/styles.css  design tokens, layout, components, dark + light themes
assets/app.js      state, persistence, derived values, rendering and actions
```

## Data and persistence

State is a single versioned object in `localStorage` under `bookFactory.state.v2`:
books, continuity facts, activity log, schedule, settings and the last report. Every
read is validated and normalised, so a corrupted or hand-edited entry falls back to
seed data rather than breaking the app. Libraries saved by the previous version
(`bookFactoryBooks`) are migrated automatically on first load.

Export and import round-trip the whole state as JSON from **Settings**.

## Keyboard and accessibility

- `/` jumps to the library search
- `Esc` closes the book dialog, which traps focus while open
- Every page is deep-linkable (`#/library`, `#/analytics`, …) and reachable by keyboard
- Live regions announce toasts; the colour theme follows an explicit dark/light choice

## Local development

No toolchain required:

```bash
npx http-server -p 8099 .   # or: python3 -m http.server 8099
```

Then open <http://127.0.0.1:8099/>.
