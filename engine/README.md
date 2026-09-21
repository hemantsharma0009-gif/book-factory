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

For a real run, export a key first:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli.js generate --chapters 12 --words 2200
```

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
generate [--genre id] [--chapters n] [--words n] [--images charts|none] [--dry-run]
status | show <id> | genres
approve <id> | reject <id> [reason]
pack <id>                        write the KDP upload sheet
publish <id> --gumroad [--dry-run]
schedule --cadence daily|weekly|fortnightly|monthly --time HH:MM [--off]
next-due                         exit 0 when a run is due (for cron)
```

### Scheduling

The engine does not daemonise. Drive it from cron:

```cron
0 * * * * cd /path/to/engine && node src/cli.js next-due && node src/cli.js generate
```

`next-due` exits 0 only when the configured cadence says a run is due, so the
hourly cron does nothing until then.

## Genre rotation

Genres never repeat within a 5-book window, and never twice in a row even once
the catalogue is exhausted — selection is least-recently-used, so it is
deterministic and auditable rather than random. The *angle* rotates within a
genre too, so two Adventure books aren't both "lost city". Both are covered by
tests.

## Images

`--images charts` (the default) generates SVG figures in plain JS: no API key, no
cost. They are built for the medium — most Kindles are greyscale e-ink, so series
are separated by a **lightness ramp** rather than hue, every mark carries a direct
label (a printed page has no hover), and every figure is followed by a data table.

`stock` (public-domain) and `aigen` (AI illustration) are declared with the same
interface and throw a clear "not implemented" error. Implement `generate()` in
`src/illustrate/index.js` to add them; nothing else changes. Note that AI images
must also be disclosed to KDP.

## Layout

```
src/config.js          models, pricing, paths, defaults
src/genres.js          rotation (least-recently-used, with tests)
src/model.js           the only module that calls the API; batching + caching
src/agents/            planner, writer, editor, marketer
src/illustrate/        chart generation; stock/aigen adapters
src/epub.js            EPUB3 assembler
src/cover.js           SVG cover
src/pipeline.js        orchestration — always stops at awaiting_approval
src/publish/gumroad.js live publishing
src/publish/kdp.js     upload sheet + KDP rule validation
src/server.js          review console (loopback only)
```

## Tests

```bash
npm test                                   # 12 unit tests
node test/validate-epub.mjs <file.epub>    # structural EPUB validation
```

## Safety notes

- The review console binds to **127.0.0.1** only. It can spend money and publish
  to a live store; do not expose it without thinking about auth first.
- `GUMROAD_ACCESS_TOKEN` and `ANTHROPIC_API_KEY` come from the environment and are
  never written to the library or any artifact.
- `publish` is irreversible — it creates a real, live product. Run it with
  `--dry-run` first to see the exact payload.
