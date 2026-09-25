# Book Factory Engine

Autonomous book production: plan → draft → edit → illustrate → package → **your
approval** → publish.

Nothing reaches a storefront without you approving it first. That is enforced in
code, not by convention: `publish` refuses any book that is not in the `approved`
state.

## Quick start

```bash
cd engine
npm install

# Free: exercises the entire pipeline with a stub model. No API key needed.
node src/cli.js generate --dry-run

# Review and approve in the browser
npm start          # http://127.0.0.1:4321
```

For a real run, export a key first. **Start with a sample** — it writes the plan
and the first two chapters so you can judge the prose for about a tenth of the
cost of a full book:

```bash
export ANTHROPIC_API_KEY=sk-ant-...

node src/cli.js generate --sample        # ~$0.09, 2 chapters — read these first
node src/cli.js generate                 # ~$0.39, the full 12-chapter book
```

A sample plans the *whole* book and writes the opening chapters against that
full plan, so what you read is what the real run would produce. It does not
consume a genre slot, so you can write the same book properly afterwards.

## Watching a book being written

`--live` streams the book chapter by chapter instead of submitting one batch.
Each chapter is written to `library/books/<id>/chapters/ch-007.md` the moment it
finishes, which is what makes everything else possible:

```bash
node src/cli.js generate --live --images artwork
#   [██████████··············] 42%  Writing chapters — 5 of 12 done, 11,204 words  $0.31
```

From another terminal, or from the console:

```bash
node src/cli.js pause  bk_abc123     # stops after the chapter it is writing
node src/cli.js runs                 # what is unfinished, and how to resume it
node src/cli.js resume bk_abc123     # carries on; nothing is paid for twice
```

Pausing takes effect at a chapter boundary rather than mid-sentence, because
abandoning a half-written chapter means paying for the tokens and throwing the
words away.

**You can read a chapter while it is being written.** Clicking the chapter in
flight opens the prose so far, growing as it arrives; it becomes editable by
itself once the chapter finishes. The half-written text lives in
`chapters/ch-007.partial.md`, which nothing that assembles a manuscript or an
EPUB ever reads — a book must never ship half a sentence.

**While it is paused you can edit.** Open a chapter in the console, or edit
`chapters/ch-003.md` in any editor. A chapter whose text no longer matches what
the engine wrote is marked as yours, and the editorial pass **skips it** — an
editor handed your paragraph would rewrite it, and silently discarding an edit
someone made on purpose is not a trade this pipeline gets to make.

The console shows a progress bar with a **download button beside it**. It serves
a real EPUB of whatever exists at that second — openable on a phone, labelled
inside the file as a draft so it cannot be mistaken for the finished book once
it has been forwarded to somebody.

Every step is resumable: the plan, the art direction, each chapter and each
generated image are on disk as they are produced. Losing power at chapter eleven
costs you the chapter that was in flight and nothing else.

## What it costs

Chapters are drafted through the **Batch API at 50% off**, and shared context —
the series bible, and during editing the whole manuscript — is sent as a **cached
prefix**, so it is billed as one cache write plus cheap reads rather than resent
with every chapter. A 12-chapter, ~26,000-word book on `claude-sonnet-5` runs
about **$1**. Every book records its actual measured spend in
`library/library.json`.

The editorial pass reads the entire manuscript, not chapter summaries, because
only the text reveals that chapter 3 and chapter 9 make the same point in the
same words. Caching makes that affordable: ~$0.09 of input per book instead of
~$0.44 if the manuscript were resent for every chapter.

Change the model with `BOOK_FACTORY_MODEL=claude-opus-5` (better prose, ~3× the
cost).

**Live mode costs about twice batch mode**, and that is the whole trade:

| | Price | What you can do while it runs |
|---|---|---|
| batch (default in the CLI) | half | nothing — no partial result exists until the batch ends |
| `--live` (default in the console) | full | read each chapter as it lands, pause, edit, download, resume |

Before a real run the CLI prints an estimated range and, above $1, asks. It
never asks when nothing is attached to the terminal — a question in cron would
hang forever holding the run lock.

## The two storefronts work differently

| | How it publishes | Why |
|---|---|---|
| **Gumroad** | Fully automatic via the v2 API | A real publishing API exists |
| **Amazon KDP** | You upload; the engine fills every field for you | **Amazon has no publishing API.** Driving kdp.amazon.com with a bot breaches their terms and risks your account, so this engine does not do it. |

For KDP the engine writes `KDP-UPLOAD-SHEET.md` next to the EPUB: every field in
the order KDP's form asks for it, with the description, 7 keywords, categories,
price, royalty band and the AI-content disclosure pre-filled. Uploading is
copy-paste, about two minutes.

Two KDP rules the sheet enforces for you:
- **AI content must be disclosed.** The disclosure is pre-ticked and worded.
- **3 new titles per day per account.** The sheet reminds you; exceeding it is a
  policy violation aimed at content farms.

## Commands

```
generate [--genre id] [--chapters n] [--words n] [--dry-run]
         [--images none|charts|placeholder|artwork] [--image-every n]
         [--image-driver google|openai|custom|placeholder]
         [--live] [--no-edit] [--sample n]
runs                             unfinished books, and how to resume each
resume <id>                      carry on; nothing already written is repaid for
pause <id> | stop <id>           from another terminal, while it runs
images                           which image providers are configured
status | show <id> | genres
approve <id> | reject <id> [reason]
pack <id>                        write the KDP upload sheet
publish <id> --gumroad [--dry-run]
schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
         [--max-pending n] [--budget usd]
should-run                       exit 0 when cron should generate (due + guards)
next-due                         exit 0 when a run is due, ignoring guards
```

### Scheduling

The engine does not daemonise. Set the cadence, then install the cron entry:

```bash
node src/cli.js schedule --cadence daily --time 09:00 --max-pending 3 --budget 20
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env && chmod 600 .env
./scripts/install-cron.sh
```

That installs one hourly entry. It exits quietly unless a run is genuinely due,
so the cadence lives in the engine's own config rather than in crontab syntax —
change it with `schedule` and the cron entry stays as it is.

**An unattended job that spends money needs to be able to stop itself.** Two
guards do that, and `should-run` enforces both:

| Guard | Default | Why |
|---|---|---|
| `--max-pending` | 3 | Books awaiting approval are books you have paid for and not read. If generation outruns approval, the pipeline quietly wastes money — so it stops until you catch up. |
| `--budget` | $20 / 30 days | A hard ceiling on rolling spend, whatever else goes wrong. |

The wrapper also takes a **lock**, so a slow run can never overlap the next
hourly tick and pay twice, and loads the API key from `engine/.env` because cron
runs with almost no environment.

Check what cron will decide, without waiting for it:

```bash
node src/cli.js should-run   # prints the reason; exit 0 means it would run
node src/cli.js status       # includes the cron verdict
tail -f logs/scheduled.log   # what it actually did
```

Remove it with `./scripts/install-cron.sh --remove`.

**On a server rather than a laptop:** cron only fires while the machine is
awake, so a daily run on a closed laptop will simply not happen. The hourly
entry makes that self-correcting — the run fires at the next hour the machine is
on — but a machine that is off all day still produces nothing.

## Genre rotation

Genres never repeat within a 5-book window, and never twice in a row even once
the catalogue is exhausted — selection is least-recently-used, so it is
deterministic and auditable rather than random. The *angle* rotates within a
genre too, so two Adventure books aren't both "lost city". Both are covered by
tests.

## Images

Four choices, and the honest position first: **the Claude API does not generate
images.** Nothing in this engine can make that untrue. Real artwork needs a
second vendor, a second key and a second bill.

| `--images` | What you get | Cost |
|---|---|---|
| `none` | no pictures | — |
| `charts` | SVG charts and diagrams, generated in plain JS | free, no key |
| `placeholder` | real PNGs made offline | free, no key |
| `artwork` | generated photography, one per chapter, plus cover art | per image, billed by the image provider |

`charts` is built for the medium: most Kindles are greyscale e-ink, so series are
separated by a **lightness ramp** rather than hue, every mark carries a direct
label (a printed page has no hover), and every figure is followed by a data
table. It is right for a data-led non-fiction book and useless for a novel.

`placeholder` exists so you can lay an illustrated book out — see where pictures
fall, what they do to the file size, how the cover reads at thumbnail size —
**before paying for any of them**.

### Artwork

```bash
node src/cli.js images                 # which providers you have configured
node src/cli.js generate --images artwork --image-every 2
```

Set one key in `engine/.env`:

```
GOOGLE_API_KEY=…        # or GEMINI_API_KEY
OPENAI_API_KEY=…
BOOK_FACTORY_IMAGE_CONFIG=/path/to/provider.json   # anything else
```

A run with `--images artwork` and no key **fails before the first token is
spent**, not after twelve chapters have been written and paid for.

The art direction is deliberate and lives in `src/illustrate/art.js`:

- **One look per book.** A house style and a palette are chosen once and
  prepended to every prompt. Without that you get twelve unrelated stock
  photographs instead of an illustrated book.
- **Photographic, not painterly.** The prompts name optics — focal length,
  light, depth of field, grade — because "make it realistic" gets you an
  airbrushed illustration and "50mm, window light, shallow depth of field" gets
  you a photograph. Fiction is briefed as cinematic; non-fiction as editorial.
- **Never text inside a picture.** Image models still render lettering as
  convincing nonsense, and a garbled word printed in a book you are selling is a
  defect a reader will photograph. Captions are typeset by the EPUB, where they
  are real text a screen reader can read.
- **Never a real person, logo or brand.** The upside of a recognisable face is
  nil and the downside is a takedown.

The **cover** is generated artwork with the title typeset over it as vector
text — never lettering drawn by the image model, which is the only way to be
sure the title is spelled correctly. `cover.svg` is the one to upload;
`cover-art.png` is the same picture without the title.

Bytes coming back from a provider are checked to be a real PNG or JPEG before
they go anywhere near a book. One picture failing drops that picture and says
so; it never takes down a run whose prose you have already paid for.

**KDP asks about AI text and AI images separately.** A book built with
`--images artwork` records a disclosure covering both, and the upload sheet says
so where you will be answering the question.

### Cost, and the part that surprises people

`BOOK_FACTORY_IMAGE_COST` sets the per-image figure used in estimates (default
`0.04`). Set it to what your provider actually charges — the engine has no way
to know.

**The bigger cost is not making the pictures, it is delivering them.** Amazon
deducts a per-megabyte delivery fee from the 70% royalty option, on every sale,
for as long as the book is listed. Text is tiny; twelve photographs are not.

| File | Royalty at $9.99 | Delivery | Net per sale |
|---|---|---|---|
| 0.3 MB, text only | $6.99 | $0.05 | **$6.95** |
| 12 MB, illustrated | $6.99 | $1.80 | **$5.19** |
| 30 MB | $6.99 | $4.50 | **$2.49** — the 35% option, which has no delivery fee, pays more |

So interior figures are requested at 1K rather than 2K (`BOOK_FACTORY_IMAGE_SIZE`)
— already more than an e-ink page can show — while the cover, the one image
Amazon displays at full size, stays at 2K. `--image-every 2` halves the rest.

The fee differs by marketplace and Amazon changes it, so `$0.15/MB` is a default,
not a fact: set `BOOK_FACTORY_DELIVERY_FEE` to the rate on your own dashboard.
Break-even, the upload sheet and the note delivered to Drive all use the same
figure, so they cannot disagree.

## Layout

```
src/config.js          models, pricing, paths, defaults
src/genres.js          rotation (least-recently-used, with tests)
src/model.js           the only module that calls the API; batching, caching, streaming
src/run-state.js       the durable run record: progress, pause, resume
src/chapters.js        one file per chapter, written as each one lands
src/agents/            planner, writer, editor, marketer, art director
src/illustrate/        charts, art direction, image drivers, a PNG writer
src/epub.js            EPUB3 assembler
src/cover.js           SVG cover, typographic or over generated artwork
src/pipeline.js        orchestration — always stops at awaiting_approval
src/publish/gumroad.js live publishing
src/publish/kdp.js     upload sheet + KDP rule validation
src/server.js          review console (loopback only)
```

## Tests

```bash
npm test                                   # 131 unit tests
node test/console-ui.mjs                   # the progress panel, in a real browser
node test/validate-epub.mjs <file.epub>    # structural EPUB validation
```

## Safety notes

- The review console binds to **127.0.0.1** only. It can spend money and publish
  to a live store; do not expose it without thinking about auth first.
- `GUMROAD_ACCESS_TOKEN` and `ANTHROPIC_API_KEY` come from the environment and are
  never written to the library or any artifact.
- `publish` is irreversible — it creates a real, live product. Run it with
  `--dry-run` first to see the exact payload.
