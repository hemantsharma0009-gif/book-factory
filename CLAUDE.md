# Working rules for this repository

## Branch, always. Never commit to `main`.

Every change — including a one-line fix, a typo, or repairing something broken
an hour ago — goes on a branch and through a pull request. `main` is only ever
advanced by merging one.

The temptation is a small fix while the working copy already sits on `main`.
That is exactly the case this rule exists for: the smaller the change feels,
the less it gets looked at, and the review step is the whole point.

Do not merge a pull request until the repository owner asks.

## Verify before you push

```bash
cd engine && npm test            # unit tests, no key needed
node test/console-ui.mjs         # the review console in a real browser
node test/validate-epub.mjs <file.epub>
node --test test/*.test.js       # from the repo root: the sales parser
```

The engine runs its whole pipeline against a stub model with
`BOOK_FACTORY_DRY_RUN=1`, so end-to-end checks cost nothing. Use it.

## Things that must not change

- **Amazon KDP must never be driven by a browser bot.** Amazon publishes no
  upload API; automating the form breaches their terms and risks termination of
  the KDP account *and* the linked Amazon account. The engine stops at a
  handoff sheet on purpose.
- **Secrets live in `engine/.env` and nowhere else.** `ANTHROPIC_API_KEY`, the
  Gumroad token and any image-provider key are read from the environment and
  are never written into the library, an artifact, a config file or a chat
  window.
- **The review console binds to `127.0.0.1`.** It can spend API money and
  publish to a live storefront. The `share` command is the separate read-only
  server for reading a draft on a phone.
- **Nothing publishes itself.** The pipeline always stops at
  `awaiting_approval`. An AI writing a book is reversible; an AI publishing
  under someone's name is not.

## Two copies of the royalty table

`engine/src/royalty.js` and `assets/app.js` both hold it, because the dashboard
is a static page with no build step and cannot import from the engine. A unit
test reads the dashboard's copy and fails on drift. If you change one, change
both.
