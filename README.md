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

## Reading a book on your phone before you approve it

The review console binds to `127.0.0.1` because it can spend API money and
publish to a live storefront. That keeps it off your network - and also out of
reach of the phone you would rather read the book on.

`share` solves that with a second, deliberately separate server:

```bash
node src/cli.js share <bookId> --hours 4
```

It prints a link for every address your machine has on the LAN. Open one on a
phone on the same wifi: you can read the manuscript and save the EPUB, and
that is all. There is no approve, reject, publish or generate route in that
server - not disabled, absent.

Two things are needed to read the book: the link, and a six-digit passcode the
command prints next to it. Until the passcode is entered the page shows nothing
about the book - not even its title - so a link that gets forwarded,
screenshotted or written to a log is not on its own enough. Five wrong attempts
destroy the link rather than locking it; mint a new one with `share` again.

Each link carries a 128-bit token scoped to one book, expires (2 hours by
default, `--hours` to change it), and dies when you stop the command.

Traffic is encrypted. The command generates a throwaway certificate covering
every address your machine answers on, and prints its SHA-256 fingerprint. Your
phone will warn that the certificate is untrusted - no certificate authority
will vouch for a private address like `192.168.1.14`, because that address
means a different machine on every network. Check the fingerprint the phone
shows against the one the command printed before you tap through; if it differs,
something else is answering on that address.

`--insecure` falls back to plain HTTP for a machine with no `openssl`. On that
path the book and the link are readable by anyone who can watch traffic on the
network, so it is for a network you trust and never for a forwarded port.

## Every new book landing in your Drive

Set one line in `engine/.env`:

```bash
BOOK_FACTORY_DELIVER_TO=/Users/you/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Book Factory
```

Every book generated after that - by you, by the review console, or by the
scheduler at 3am - copies itself there when it is finished. Each one gets its
own dated folder holding the EPUB, the KDP upload sheet, the cover, the
manuscript, the plan, and a plain-language note saying what the book is and
what to do with it.

Not sure of the path? `node src/cli.js deliver` prints the sync folders it can
find on your machine.

This deliberately uses your existing sync client rather than the Google Drive
API. A direct integration would mean this engine holding a refresh token with
write access to your whole Drive, on top of the API key and the Gumroad token
it already needs. Letting Drive for Desktop do the uploading gives the same
result and asks you for nothing.

**On a headless machine** with no sync client, use
[rclone](https://rclone.org) instead:

```bash
rclone config                                    # once, to authorise Drive
BOOK_FACTORY_DELIVER_TO=rclone:gdrive:Book Factory
```

Two things worth knowing:

- **The target folder must already exist.** If it does not, delivery fails and
  says so. Creating it would be worse: with Drive not running, the engine would
  make an ordinary local folder that never syncs, and you would believe your
  books were in the cloud until you noticed they were not.
- **A failed delivery never costs you the book.** The copy is the last step,
  the failure is reported with the path the book is actually at, and
  `node src/cli.js deliver <bookId>` retries it.

## Watching the book being written, and stopping it when you want to

A batch of twelve chapters shows you nothing until it ends and cannot be
interrupted. So the console defaults to **live mode**: one chapter at a time,
streamed, each written to disk the moment it finishes.

The progress panel has a bar, and **a download button in the same row as the
bar** — because the whole point is that the book is yours at any moment, so the
way to take it should never be somewhere else on the page. It serves a real
EPUB of whatever exists at that second, openable on a phone, and labelled
*inside the file* as a draft so it cannot be mistaken for the finished book
once it has been forwarded to somebody.

| Button | What it does |
|---|---|
| **Pause** | stops after the chapter it is writing, never mid-sentence — a half-written chapter is a chapter you paid for |
| **Resume** | carries on; the plan, every finished chapter and every generated picture are reused, not repaid for |
| **Stop** | ends the run and keeps everything written so far |
| **Download the book so far** | EPUB, or plain text for editing |

While it is paused, click any chapter to read it and edit it in place. **A
chapter you edit becomes yours**: the editorial pass skips it when the run
resumes, so nothing rewrites your words. That holds whether you edit it in the
console or open `chapters/ch-003.md` in your own editor — the engine compares
the text, not the timestamp, so a Drive sync or a resume is never mistaken for
an edit.

The same run can be driven from a terminal, and the two see the same book:

```bash
node src/cli.js generate --live --images artwork
node src/cli.js pause  bk_abc123     # from a second terminal
node src/cli.js runs                 # what is unfinished
node src/cli.js resume bk_abc123
```

## Pictures in the book

**Claude does not generate images**, so artwork needs a second key — Google,
OpenAI, or any HTTP image API described by a small JSON file. `node src/cli.js
images` says what you have configured, and a run that asks for artwork without a
key stops before the first token is spent rather than after twelve chapters.

The style is decided per book and applied to every picture, so the book looks
illustrated rather than assembled from stock: fiction is briefed as cinematic
photography, non-fiction as editorial. No image ever contains lettering — image
models garble it, and garbled words printed in a book you are selling are a
defect. The cover is generated artwork with the title typeset over it as real
vector text, which is the only way to be certain the title is spelled correctly.

`--images placeholder` lays the whole book out with real PNGs, offline and free,
so you can see where the pictures fall before paying for any.

KDP asks about AI text and AI images separately; an illustrated book records a
disclosure covering both, and the upload sheet says so at the point you answer.

**Pictures cost more to deliver than to make.** Amazon deducts a per-megabyte
delivery fee from the 70% royalty on every sale, forever — a 12 MB illustrated
book nets $5.19 a sale instead of $6.95, and past about 30 MB the 35% option
(which has no delivery fee) genuinely pays more. Break-even, the upload sheet
and the Drive note all say so, using the same number.

## Reading a finished book, and changing it before you publish

The pipeline stops at `awaiting_approval` so a person reads the book. Reading
it and wanting to change something is the normal case, so the edit has
somewhere to go.

**Read it, and take the text away:**

```bash
node src/server.js                        # review console, reads in the browser
node src/cli.js share <bookId> --hours 2  # the same text on your phone
```

The console offers two downloads: the **EPUB**, which is what people would buy,
and **the text to edit** — `manuscript.md`, which opens in any editor. The
whole book folder also lands in your Drive if delivery is configured.

**Change what you like, then:**

```bash
node src/cli.js rebuild <bookId>
```

The EPUB is reassembled from your edited manuscript, the upload sheet is
refreshed to match, and the folder is re-delivered. **No model call, so it
costs nothing** — it only rebuilds the file. Figures already on disk are
re-attached rather than regenerated, so a rebuild cannot quietly change the
pictures. Add or remove a chapter in the file and the book follows.

**You cannot publish a book whose EPUB is behind its text.** `publish` compares
the two timestamps and refuses, naming the rebuild command, because the failure
it prevents is silent: shipping the version you meant to fix. The review
console shows the same warning with a **Rebuild the EPUB** button.

## Reading the books themselves

The dashboard holds no book text and never has — it tracks titles, not
manuscripts. A card's **Details** shows stage, chapters, price and store links;
none of that is the book.

Each book now carries a **manuscript link**: paste a Google Docs, Drive or
Dropbox URL and the card gets a **Read ↗** button that opens it. Books with no
link show **Add manuscript** instead, which asks for one in a single prompt.
Clearing the field removes the link.

Only `http://` and `https://` are accepted, and the same check runs again on
every load — the value ends up in an `href`, and a `javascript:` link smuggled
in through an imported library file would be script execution one click away.

Books the engine generated need no link: their text is in
`engine/library/books/<id>/`, readable in the review console
(`node src/server.js`) and on a phone via `node src/cli.js share <bookId>`.

## Distribution gaps as a checklist

The gaps table listed ten books missing from a store. It did not say which to
do first, what each was worth, or let you tick one off — so the same ten rows
sat there week after week looking identical whether you had done nine or none.

Analytics now shows one row per **job**: this title, on this store, ordered by
what the job pays. Each row carries the price to list at, the royalty rate that
price earns there, and the net per sale — and an Amazon row says that KDP
review takes up to 72 hours.

Ticking a job off asks for the listing URL and marks the book as on sale at
that store, so the job leaves the list because it is no longer a gap. Leave the
URL blank if the link is not to hand yet; the listing is still recorded. Paste
a link belonging to a different store and it is refused, because recording a
listing on a store the book is not on is worse than recording nothing.

"Start" marks a job in progress and survives a reload, so a KDP upload waiting
on review is visibly different from one you have not begun.

## Real sales numbers, from the storefronts

Until you import something, every figure on the Revenue table is one somebody
typed. The import turns that into something a storefront said.

**Analytics → Import sales from a storefront.** Choose a report you exported
from KDP, Play Books Partner Center, or Gumroad. Nothing is written until you
have seen a preview of exactly what would change:

- which column it read as the title, the units and the money
- which storefront it thinks the report came from — **correctable**, and it
  decides whether a re-import replaces a period or adds to it
- every title that matches nothing in your catalogue, listed rather than
  silently skipped
- how many previously imported rows would be replaced

Save the download as **CSV** first if it arrives as a spreadsheet.

Three things it is careful about, because a revenue figure that quietly
inflates is worse than no figure at all:

- **Refunds subtract.** A KDP report's `Net Units Sold` is preferred over
  `Units Sold`, and negative money parses as negative.
- **Currencies are never added together.** 1,240 INR plus 18 GBP is not 1,258
  of anything. Only USD rows count towards revenue; the rest are recorded and
  named under the table.
- **Re-importing a period replaces it.** Importing August twice leaves August's
  figures where they were rather than doubling them.

Why a file and not an API: Amazon publishes no API for KDP authors at all, and
Google Play Books offers report downloads rather than a per-title feed. Gumroad
does have a real API — `node src/cli.js gumroad-list`.

## Putting the factory's books on the dashboard

```bash
node src/cli.js export-dashboard
```

Writes `dashboard.json`. In the dashboard: **Settings → Import library JSON**.

It merges: books the catalogue has not seen are added, ones it already has are
updated with what only the engine knows — that the book was generated, and what
it cost to produce, which is what the break-even column is measured against.
Anything a person edited here wins, and importing the same export twice changes
nothing the second time. The file carries no keys, no tokens and no manuscript,
so it is safe to leave in a Drive folder.
