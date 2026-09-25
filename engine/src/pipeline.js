/**
 * The production pipeline for one book.
 *
 * plan -> art direction -> draft -> edit -> illustrate -> listing -> cover -> EPUB -> await approval
 *
 * Nothing here publishes. The pipeline always stops at `awaiting_approval`;
 * publishing is a separate, explicitly invoked step (see publish/).
 *
 * TWO MODES, AND THE REASON THERE ARE TWO
 *
 *   batch  every chapter submitted at once through the Batch API at half
 *          price. Nothing is readable until the whole batch ends and there is
 *          no moment at which it can be interrupted. Right for a scheduled run
 *          nobody is watching.
 *
 *   live   one streamed request per chapter, in order, at full rate. Each
 *          chapter is written to disk the instant it lands, so it can be read,
 *          edited and downloaded while the rest is still being written, and
 *          the run can be paused between chapters.
 *
 * Live costs about twice what batch costs for the same book. That is the whole
 * trade, stated plainly wherever the choice is offered.
 *
 * EVERY STEP IS RESUMABLE. The plan, the art direction, each chapter and each
 * generated image are written to `library/books/<id>/` as they are produced,
 * and a resume picks up whatever is missing. Losing power at chapter eleven
 * costs you nothing but the chapter that was in flight.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { planBook } from "./agents/planner.js";
import { draftChapters, draftChaptersLive } from "./agents/writer.js";
import { editChapters, editChaptersLive } from "./agents/editor.js";
import { writeListing } from "./agents/marketer.js";
import { directArt } from "./agents/art-director.js";
import { scoreManuscript, overallScore } from "./agents/critic.js";
import { illustrate, illustrateCover, getProvider, assertUsable, DEFAULT_IMAGE_COST_USD } from "./illustrate/index.js";
import { renderCover, renderPhotoCover } from "./cover.js";
import { buildEpub } from "./epub.js";
import { nextGenre, nextAngle, genreById } from "./genres.js";
import { spendReport } from "./model.js";
import { DEFAULTS, MODEL, languageById } from "./config.js";
import * as store from "./store.js";
import * as chapters from "./chapters.js";
import * as runState from "./run-state.js";

/**
 * KDP asks separately whether the TEXT and the IMAGES are AI-generated, and a
 * declaration that covers only the text is an incomplete answer to a question
 * you are legally obliged to answer. So the sentence changes with what was
 * actually used.
 */
export const AI_DISCLOSURE =
  "This book was produced with AI assistance (text generation and editing) under human review.";

export const AI_DISCLOSURE_WITH_IMAGES =
  "This book was produced with AI assistance (text generation and editing, and AI-generated images) under human review.";

export function disclosureFor({ imagesGenerated }) {
  return imagesGenerated ? AI_DISCLOSURE_WITH_IMAGES : AI_DISCLOSURE;
}

const countWords = chapters.countWords;

/**
 * How often the chapter being written is flushed to disk for previewing.
 *
 * Fragments arrive many times a second; a person reading along cannot tell
 * 400ms from instant, and writing every fragment would turn a preview into a
 * disk-bound bottleneck on the run itself.
 */
const PARTIAL_WRITE_MS = 400;
let lastPartialWrite = 0;

/** Phases that will actually run, so the progress bar reaches 100%. */
function phasesFor({ images, editorial, scorecard = true }) {
  const active = ["planning"];
  if (getProvider(images).needsDirection) active.push("briefing");
  active.push("drafting");
  if (editorial) active.push("editing");
  if (scorecard) active.push("reviewing");
  if (images !== "none") active.push("illustrating");
  active.push("packaging");
  return active;
}

/**
 * The other books, for the back matter.
 *
 * A reader who finished this one is the likeliest buyer of the next, and this
 * page is the only thing in the pipeline that can cause a sale rather than
 * report one. It costs nothing to include.
 *
 * Only http(s) links survive: this value is written into an href inside a file
 * that gets published, and a "javascript:" URL smuggled in through an imported
 * catalogue would ship inside the book.
 */
const ALSO_BY_LIMIT = 12;

export function alsoByFor(state, currentId) {
  return (state.books || [])
    .filter((other) => other.id !== currentId && other.title)
    .filter((other) => other.status !== "rejected")
    .slice(0, ALSO_BY_LIMIT)
    .map((other) => {
      const url = String(other.published?.gumroad?.url || other.storeUrl || "").trim();
      return {
        title: other.title,
        subtitle: other.subtitle || "",
        url: /^https?:\/\//i.test(url) ? url : "",
      };
    });
}

/* ------------------------------------------------------------- run helpers */

async function setPhase(bookId, phase, fraction = 0) {
  await runState.patchRun(bookId, (run) => {
    run.phase = phase;
    run.phaseFraction = fraction;
  });
}

async function note(bookId, log, line) {
  log(line);
  await runState.patchRun(bookId, (run) => runState.appendLog(run, line));
}

/**
 * Pause and stop are messages from another process - the console, or a second
 * terminal - so the inbox is the run file on disk rather than a variable.
 */
async function checkStop(bookId) {
  const run = await runState.readRun(bookId);
  if (!run) return null;
  if (run.cancelRequested) return "cancel";
  if (run.pauseRequested) return "pause";
  return null;
}

/* -------------------------------------------------------------- public API */

export async function produceBook(options = {}) {
  const {
    genreId = null,
    chapters: chapterCount = DEFAULTS.chapters,
    wordsPerChapter = DEFAULTS.wordsPerChapter,
    images = "charts",
    imageDriver = null,
    imageEvery = 1,
    author = "Book Factory Studio",
    language: languageId = DEFAULTS.language,
    sample = 0,
    mode = "batch",
    editorial = true,
    scorecard = true,
    /** Called with the book id the moment the run record exists, before the
     *  first API call. The console needs the id to start polling, and it
     *  should not have to guess it from the newest directory on disk. */
    onStart = () => {},
    log = () => {},
  } = options;

  const state = await store.load();
  const genre = genreId ? genreById(genreId) : nextGenre(state.genreHistory.map((h) => h.genre));
  if (!genre) throw new Error(`Unknown genre "${genreId}".`);

  const language = languageById(languageId);
  if (!language) throw new Error(`Unknown language "${languageId}".`);
  const angle = nextAngle(genre, state.genreHistory);

  // Fail before spending anything if the pictures cannot be made. Discovering
  // a missing key after twelve chapters have been written and paid for is the
  // expensive version of this error.
  assertUsable(images, imageDriver);

  const id = `bk_${Date.now().toString(36)}`;

  // writeRun creates the book directory itself, so nothing needs to exist first.
  await runState.writeRun(
    runState.emptyRun({
      bookId: id,
      totalChapters: sample || chapterCount,
      wordsTarget: (sample || chapterCount) * wordsPerChapter,
      activePhases: phasesFor({ images, editorial, scorecard }),
      meta: {
        mode,
        images,
        imageDriver,
        imageEvery,
        author,
        sample,
        editorial,
        scorecard,
        wordsPerChapter,
        chapterCount,
        genre: genre.id,
        genreName: genre.name,
        angle,
        language: language.code,
        languageName: language.name,
        costCarried: 0,
        imageCount: 0,
      },
    }),
  );

  onStart(id);
  return runPipeline({ bookId: id, log });
}

/**
 * Continue a paused, failed or interrupted run.
 *
 * Everything already on disk is kept: the plan, the art direction, every
 * finished chapter, every generated image. Nothing is regenerated and nothing
 * is paid for twice.
 */
export async function resumeBook({ bookId, log = () => {} }) {
  const run = await runState.readRun(bookId);
  if (!run) throw new Error(`No run found for ${bookId}. Nothing to resume.`);
  if (run.status === "done") throw new Error(`${bookId} is already finished.`);

  await runState.patchRun(bookId, (r) => {
    r.status = "running";
    r.pauseRequested = false;
    r.cancelRequested = false;
    r.error = null;
    runState.appendLog(r, "Resumed.");
  });

  return runPipeline({ bookId, log });
}

/* ----------------------------------------------------------------- the run */

async function runPipeline({ bookId, log }) {
  const startSpend = spendReport().usd;
  let run = await runState.readRun(bookId);
  const genre = genreById(run.genre);
  const language = languageById(run.language);
  const provider = getProvider(run.images);

  /** Keeps the live cost on the progress panel honest as the run proceeds. */
  const syncCost = async () => {
    await runState.patchRun(bookId, (r) => {
      const modelSpend = spendReport().usd - startSpend;
      r.costUsd = (r.costCarried || 0) + modelSpend + (r.imageCount || 0) * imageUnitCost(r);
    });
  };

  try {
    /* ---------------------------------------------------------- 1. plan */
    await setPhase(bookId, "planning");
    let plan = await readJson(bookId, "plan.json");

    if (!plan) {
      await note(bookId, log, `Genre: ${genre.name} — ${run.angle}`);
      if (language.code !== "en") {
        await note(bookId, log, `Language: ${language.name} (${language.endonym})`);
      }
      await note(bookId, log, "Planning…");
      plan = await planBook({
        genre,
        angle: run.angle,
        chapters: run.chapterCount,
        wordsPerChapter: run.wordsPerChapter,
        language,
      });
      await store.writeArtifact(bookId, "plan.json", JSON.stringify(plan, null, 2));
      await note(bookId, log, `Planned "${plan.title}" (${plan.chapters.length} chapters)`);
    }

    // Sample mode plans the whole book but writes only the first few chapters,
    // so the chapters it does write have the same context the full run gives.
    const fullPlan = plan;
    if (run.sample) plan = { ...fullPlan, chapters: fullPlan.chapters.slice(0, run.sample) };

    await runState.patchRun(bookId, (r) => {
      r.title = plan.title;
      r.subtitle = plan.subtitle;
      r.totalChapters = plan.chapters.length;
      if (!r.chapters.length) {
        r.chapters = plan.chapters.map((c) => ({ number: c.number, title: c.title, words: 0 }));
      }
    });
    await syncCost();

    /* -------------------------------------------------- 2. art direction */
    let direction = await readJson(bookId, "art.json");
    if (provider.needsDirection && !direction) {
      await setPhase(bookId, "briefing");
      await note(bookId, log, "Art direction…");
      direction = await directArt({ plan, genre, language, every: run.imageEvery || 1 });
      await store.writeArtifact(bookId, "art.json", JSON.stringify(direction, null, 2));
      await note(bookId, log, `  palette: ${direction.palette} · ${direction.figures.length} picture(s) briefed`);
      await syncCost();
    }

    /* --------------------------------------------------------- 3. draft */
    await setPhase(bookId, "drafting");
    const onDisk = await chapters.readAllChapters(bookId, plan.chapters.length);
    await markHumanEdits(bookId, onDisk);

    let written;
    let stopped = null;

    if (run.mode === "live") {
      const result = await draftChaptersLive({
        plan,
        genre,
        wordsPerChapter: run.wordsPerChapter,
        language,
        existing: onDisk,
        shouldStop: () => checkStop(bookId),
        onChapterStart: async (chapter) => {
          // Any partial left by a crashed earlier attempt is not a preview of
          // this chapter - it is text that is about to be replaced.
          await chapters.clearPartial(bookId, chapter.number);
          // So the first fragment of every chapter is flushed immediately and
          // the preview appears as soon as the words do.
          lastPartialWrite = 0;
          await runState.patchRun(bookId, (r) => {
            r.currentChapter = chapter.number;
            const entry = r.chapters.find((c) => c.number === chapter.number);
            if (entry) entry.streaming = true;
            runState.appendLog(r, `Chapter ${chapter.number}: ${chapter.title}`);
          });
          log(`Chapter ${chapter.number}: ${chapter.title}`);
        },
        onDelta: ({ chapter, words, text }) => {
          // Cheap and frequent: the bar has to move while a chapter is being
          // written, not only when one finishes.
          runState.patchRun(bookId, (r) => {
            const entry = r.chapters.find((c) => c.number === chapter.number);
            if (entry) entry.words = words;
            r.wordsWritten = r.chapters.reduce((sum, c) => sum + (c.words || 0), 0);
            const finished = r.chapters.filter((c) => c.done).length;
            r.phaseFraction = (finished + Math.min(0.95, words / (r.wordsPerChapter || 2200))) / r.totalChapters;
          });

          // The prose itself, so it can be read while it is being written.
          // Throttled: fragments arrive many times a second and the file is
          // only ever read by a person, who cannot tell the difference.
          const now = Date.now();
          if (now - lastPartialWrite < PARTIAL_WRITE_MS) return;
          lastPartialWrite = now;
          chapters.writePartial(bookId, chapter.number, text).catch(() => {
            // A preview is a convenience. Failing to write one must never
            // interrupt a chapter that is being paid for.
          });
        },
        onChapter: async (chapter) => {
          // Disk first, then the run record. If the process dies between the
          // two, a resume finds the chapter and re-derives the record.
          await chapters.writeChapter(bookId, chapter);
          await chapters.clearPartial(bookId, chapter.number);
          const words = countWords(chapter.body);
          await runState.patchRun(bookId, (r) => {
            const entry = r.chapters.find((c) => c.number === chapter.number);
            if (entry) {
              entry.words = words;
              entry.done = true;
              entry.streaming = false;
              entry.bodyHash = chapters.hashBody(chapter.body);
            }
            r.wordsWritten = r.chapters.reduce((sum, c) => sum + (c.words || 0), 0);
            r.phaseFraction = r.chapters.filter((c) => c.done).length / r.totalChapters;
          });
          await syncCost();
          await note(bookId, log, `  chapter ${chapter.number} done — ${words.toLocaleString()} words`);
        },
      });
      written = result.chapters;
      stopped = result.stopped;
    } else {
      const missing = plan.chapters.filter((c) => !onDisk.some((d) => d.number === c.number));
      if (missing.length) {
        await note(bookId, log, "Drafting chapters (batch)…");
        const drafted = await draftChapters({
          plan: { ...plan, chapters: missing },
          genre,
          wordsPerChapter: run.wordsPerChapter,
          language,
          onProgress: (p) => {
            runState.patchRun(bookId, (r) => {
              r.phaseFraction = p.total ? (p.succeeded || 0) / p.total : 0;
            });
            log(`  draft: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`);
          },
        });
        for (const chapter of drafted) await chapters.writeChapter(bookId, chapter);
      }
      written = await chapters.readAllChapters(bookId, plan.chapters.length);
      await runState.patchRun(bookId, (r) => {
        for (const chapter of written) {
          const entry = r.chapters.find((c) => c.number === chapter.number);
          if (entry) {
            entry.words = chapter.words;
            entry.done = true;
            entry.bodyHash = chapters.hashBody(chapter.body);
          }
        }
        r.wordsWritten = r.chapters.reduce((sum, c) => sum + (c.words || 0), 0);
      });
      await syncCost();
    }

    if (stopped) return finishStopped({ bookId, stopped, log });

    /* ---------------------------------------------------------- 4. edit */
    run = await runState.readRun(bookId);
    if (run.editorial) {
      await setPhase(bookId, "editing");
      const skip = new Set(run.chapters.filter((c) => c.humanEdited).map((c) => c.number));
      const already = new Set(run.chapters.filter((c) => c.edited).map((c) => c.number));

      if (skip.size) {
        await note(
          bookId,
          log,
          `Editorial pass — keeping ${skip.size} chapter(s) exactly as you edited them.`,
        );
      } else {
        await note(bookId, log, `Editorial pass (${run.mode})…`);
      }

      if (run.mode === "live") {
        const result = await editChaptersLive({
          plan,
          genre,
          chapters: written,
          language,
          skip: new Set([...skip, ...already]),
          log: (line) => log(line),
          shouldStop: () => checkStop(bookId),
          onChapterStart: (chapter) => {
            runState.patchRun(bookId, (r) => {
              r.currentChapter = chapter.number;
            });
          },
          onChapter: async (chapter) => {
            await chapters.writeChapter(bookId, chapter);
            await runState.patchRun(bookId, (r) => {
              const entry = r.chapters.find((c) => c.number === chapter.number);
              if (entry) {
                entry.edited = true;
                entry.words = countWords(chapter.body);
                entry.bodyHash = chapters.hashBody(chapter.body);
              }
              r.wordsWritten = r.chapters.reduce((sum, c) => sum + (c.words || 0), 0);
              r.phaseFraction = r.chapters.filter((c) => c.edited || c.humanEdited).length / r.totalChapters;
            });
            await syncCost();
            await note(bookId, log, `  chapter ${chapter.number} edited`);
          },
        });
        written = result.chapters;
        stopped = result.stopped;
      } else {
        const editable = written.filter((c) => !skip.has(c.number));
        const edited = await editChapters({
          plan,
          genre,
          chapters: editable,
          language,
          log,
          onProgress: (p) => {
            runState.patchRun(bookId, (r) => {
              r.phaseFraction = p.total ? (p.succeeded || 0) / p.total : 0;
            });
            log(`  edit: ${p.phase}${p.succeeded != null ? ` ${p.succeeded}/${p.total}` : ""}`);
          },
        });
        const byNumber = new Map(edited.map((c) => [c.number, c]));
        written = written.map((c) => byNumber.get(c.number) || c);
        for (const chapter of written) await chapters.writeChapter(bookId, chapter);
        await runState.patchRun(bookId, (r) => {
          for (const chapter of written) {
            const entry = r.chapters.find((c) => c.number === chapter.number);
            if (entry && !skip.has(chapter.number)) {
              entry.edited = true;
              entry.bodyHash = chapters.hashBody(chapter.body);
            }
          }
        });
        await syncCost();
      }

      if (stopped) return finishStopped({ bookId, stopped, log });
    }

    const wordCount = written.reduce((sum, c) => sum + countWords(c.body), 0);
    await note(bookId, log, `Manuscript: ${wordCount.toLocaleString()} words`);

    /* -------------------------------------------------- 4b. read it back */
    // The listing is written after this, so the critic is told what the book
    // promises using the plan rather than copy that does not exist yet.
    let scorecard = await readJson(bookId, "scorecard.json");

    if (run.scorecard !== false && !scorecard) {
      await setPhase(bookId, "reviewing");
      await note(bookId, log, "Reading it back…");
      try {
        scorecard = await scoreManuscript({
          plan,
          genre,
          listing: { description: plan.premise },
          chapters: written,
          language,
        });
        await store.writeArtifact(bookId, "scorecard.json", JSON.stringify(scorecard, null, 2));
        await syncCost();

        const invented = scorecard.weakest.filter((f) => !f.verified).length;
        await note(
          bookId,
          log,
          `  ${scorecard.verdict} — ${scorecard.oneLine}` +
            (invented ? ` (${invented} finding(s) quoted text not in the manuscript)` : ""),
        );
      } catch (err) {
        // An opinion is not worth losing a book over.
        await note(bookId, log, `  ! could not score the manuscript (${err.message})`);
      }
    }

    /* ---------------------------------------------------- 5. illustrate */
    let figures = new Map();
    let coverImage = null;

    if (run.images !== "none") {
      await setPhase(bookId, "illustrating");
      await note(bookId, log, `Illustrating (${provider.label})…`);

      const cached = await loadCachedFigures(bookId, direction);
      const remaining = direction
        ? { ...direction, figures: direction.figures.filter((f) => !cached.has(f.number)) }
        : null;

      const result = await illustrate({
        chapters: written,
        providerId: run.images,
        direction: remaining,
        genre,
        driverId: run.imageDriver,
        shouldStop: () => checkStop(bookId),
        onProgress: async (p) => {
          await runState.patchRun(bookId, (r) => {
            r.phaseFraction = p.total ? p.done / p.total : 0;
          });
        },
      });

      figures = new Map([...cached, ...result.figures]);

      for (const [number, figure] of result.figures) {
        if (figure.generated) {
          await store.writeArtifact(bookId, path.join("figures", figure.filename), figure.data);
        }
        void number;
      }

      if (result.generated) {
        await runState.patchRun(bookId, (r) => {
          r.imageCount = (r.imageCount || 0) + result.generated;
        });
        await syncCost();
      }

      for (const failure of result.failures) {
        await note(bookId, log, `  ! ${failure}`);
      }
      await note(
        bookId,
        log,
        `  ${figures.size} figure(s)${result.failures.length ? `, ${result.failures.length} failed` : ""}`,
      );

      // Cover artwork, if this provider makes pictures at all.
      if (provider.needsDirection && direction) {
        coverImage = await readCoverImage(bookId);
        if (!coverImage) {
          try {
            const made = await illustrateCover({
              direction,
              genre,
              providerId: run.images,
              driverId: run.imageDriver,
            });
            if (made) {
              const ext = made.mediaType === "image/jpeg" ? "jpg" : "png";
              await store.writeArtifact(bookId, `cover-art.${ext}`, made.data);
              coverImage = made;
              await runState.patchRun(bookId, (r) => {
                r.imageCount = (r.imageCount || 0) + 1;
              });
              await syncCost();
            }
          } catch (err) {
            // A book with a typographic cover still sells. A run that died at
            // the last step does not.
            await note(bookId, log, `  ! cover artwork failed (${err.message}); using the typographic cover`);
          }
        }
      }
    }

    /* ------------------------------------------------------- 6. package */
    await setPhase(bookId, "packaging");
    await note(bookId, log, "Writing listing…");
    const listing = await writeListing({ plan, genre, wordCount, angle: run.angle, language });

    const coverSvg = coverImage
      ? renderPhotoCover({
          title: plan.title,
          subtitle: plan.subtitle,
          author: run.author,
          image: coverImage.data,
          mediaType: coverImage.mediaType,
        })
      : renderCover({
          title: plan.title,
          subtitle: plan.subtitle,
          author: run.author,
          brief: listing.coverBrief,
        });
    await store.writeArtifact(bookId, "cover.svg", coverSvg);

    await note(bookId, log, "Assembling EPUB…");
    const imagesGenerated = [...figures.values()].some((f) => f.generated) || Boolean(coverImage);
    const aiDisclosure = disclosureFor({ imagesGenerated });
    const uuid = randomUUID();

    const catalogue = await store.load();

    const epub = await buildEpub({
      uuid,
      alsoBy: alsoByFor(catalogue, bookId),
      title: plan.title,
      subtitle: plan.subtitle,
      author: run.author,
      publisher: run.author,
      language: language.code,
      rtl: Boolean(language.rtl),
      description: listing.description,
      chapters: written,
      figures,
      coverSvg,
      aiDisclosure,
    });

    const epubPath = await store.writeArtifact(bookId, `${slug(plan.title)}.epub`, epub);
    await store.writeArtifact(bookId, "manuscript.md", chapters.assembleManuscript(written));

    await syncCost();
    run = await runState.readRun(bookId);
    const cost = { ...spendReport(), usd: Number((run.costUsd || 0).toFixed(4)) };

    const book = {
      id: bookId,
      uuid,
      sample: run.sample ? { chapters: plan.chapters.length, of: fullPlan.chapters.length } : null,
      title: plan.title,
      subtitle: plan.subtitle,
      author: run.author,
      genre: genre.id,
      genreName: genre.name,
      angle: run.angle,
      language: language.code,
      languageName: language.name,
      status: "awaiting_approval",
      createdAt: run.startedAt,
      updatedAt: Date.now(),
      wordCount,
      chapterCount: written.length,
      figureCount: figures.size,
      imagesGenerated,
      imageCount: run.imageCount || 0,
      imageProvider: run.images,
      mode: run.mode,
      epubFile: epubPath.split("/").pop(),
      epubBytes: epub.length,
      listing,
      scorecard: scorecard
        ? {
            verdict: scorecard.verdict,
            oneLine: scorecard.oneLine,
            score: overallScore(scorecard),
            scores: scorecard.scores,
            weakest: scorecard.weakest,
            strongest: scorecard.strongest,
          }
        : null,
      aiDisclosure,
      model: MODEL,
      cost,
      published: { gumroad: null, kdp: null },
    };

    await store.update(async (s) => {
      s.books = s.books.filter((b) => b.id !== bookId);
      s.books.unshift(book);
      if (!run.sample) {
        s.genreHistory.unshift({ genre: genre.id, angle: run.angle, at: Date.now(), bookId });
        s.genreHistory = s.genreHistory.slice(0, 50);
      }
      s.runs = s.runs.filter((r) => r.bookId !== bookId);
      s.runs.unshift({ at: Date.now(), bookId, cost, model: MODEL, sample: Boolean(run.sample) });
      s.runs = s.runs.slice(0, 100);
    });

    await runState.patchRun(bookId, (r) => {
      r.status = "done";
      r.phase = "packaging";
      r.phaseFraction = 1;
      r.currentChapter = null;
      runState.appendLog(r, `Done. ${book.title} — awaiting your approval.`);
    });
    await runState.settle(bookId);

    if (run.sample) {
      log(
        `Sample done. "${book.title}" — ${plan.chapters.length} chapters, ` +
          `$${cost.usd.toFixed(2)}. Read it, then run the full book if the prose holds up.`,
      );
    } else {
      log(`Done. ${book.title} — awaiting your approval. Cost $${cost.usd.toFixed(2)}`);
    }
    return book;
  } catch (err) {
    await runState.patchRun(bookId, (r) => {
      r.status = "failed";
      r.error = err.message;
      r.currentChapter = null;
      runState.appendLog(r, `Failed: ${err.message}`);
    });
    await runState.settle(bookId);
    throw err;
  }
}

/* ------------------------------------------------------------------ helpers */

function imageUnitCost(run) {
  return run.images === "artwork" ? DEFAULT_IMAGE_COST_USD : 0;
}

async function finishStopped({ bookId, stopped, log }) {
  const paused = stopped === "pause";
  await runState.patchRun(bookId, (r) => {
    r.status = paused ? "paused" : "cancelled";
    r.pauseRequested = false;
    r.cancelRequested = false;
    r.currentChapter = null;
    runState.appendLog(
      r,
      paused
        ? "Paused. Everything written so far is on disk and downloadable."
        : "Stopped. Everything written so far is on disk and downloadable.",
    );
  });
  await runState.settle(bookId);
  const run = await runState.readRun(bookId);
  log(paused ? "Paused." : "Stopped.");
  return { paused, cancelled: !paused, bookId, run };
}

async function readJson(bookId, name) {
  try {
    return JSON.parse(await store.readArtifact(bookId, name));
  } catch {
    return null;
  }
}

/**
 * Chapters whose text on disk no longer matches what the engine wrote are
 * yours, and are never regenerated or re-edited.
 */
async function markHumanEdits(bookId, onDisk) {
  await runState.patchRun(bookId, (run) => {
    for (const chapter of onDisk) {
      const entry = run.chapters.find((c) => c.number === chapter.number);
      if (!entry?.bodyHash) continue;
      if (chapters.hashBody(chapter.body) !== entry.bodyHash) {
        entry.humanEdited = true;
        entry.words = chapter.words;
      }
    }
  });
}

/** Images already generated and paid for in an earlier attempt at this book. */
async function loadCachedFigures(bookId, direction) {
  const cached = new Map();
  if (!direction?.figures?.length) return cached;

  for (const brief of direction.figures) {
    for (const ext of ["png", "jpg"]) {
      const name = `fig-${String(brief.number).padStart(3, "0")}.${ext}`;
      try {
        const data = await store.readArtifact(bookId, path.join("figures", name));
        cached.set(brief.number, {
          id: `fig-${String(brief.number).padStart(3, "0")}`,
          mediaType: ext === "png" ? "image/png" : "image/jpeg",
          filename: name,
          data,
          alt: brief.alt || "",
          caption: brief.caption || "",
          generated: true,
        });
        break;
      } catch {
        /* not there; generate it */
      }
    }
  }
  return cached;
}

async function readCoverImage(bookId) {
  for (const ext of ["png", "jpg"]) {
    try {
      const data = await store.readArtifact(bookId, `cover-art.${ext}`);
      return { data, mediaType: ext === "png" ? "image/png" : "image/jpeg" };
    } catch {
      /* not there */
    }
  }
  return null;
}

/**
 * The book so far, assembled on demand.
 *
 * This is what the download button next to the progress bar serves. It is a
 * real EPUB - openable in any reader, on a phone - containing every chapter
 * finished up to this second, labelled inside the file as a draft so it cannot
 * be mistaken for the finished book once it has been forwarded to someone.
 */
export async function buildDraftEpub({ bookId }) {
  const run = await runState.readRun(bookId);
  if (!run) throw new Error(`No run for ${bookId}.`);

  const plan = await readJson(bookId, "plan.json");
  const written = await chapters.readAllChapters(bookId, run.totalChapters || 60);
  if (!written.length) throw new Error("Nothing has been written yet.");

  const language = languageById(run.language) || languageById("en");
  const direction = await readJson(bookId, "art.json");
  const figures = await loadCachedFigures(bookId, direction);
  const coverImage = await readCoverImage(bookId);

  const title = plan?.title || run.title || "Untitled";
  const subtitle = plan?.subtitle || run.subtitle || "";

  const coverSvg = coverImage
    ? renderPhotoCover({ title, subtitle, author: run.author, image: coverImage.data, mediaType: coverImage.mediaType })
    : renderCover({ title, subtitle, author: run.author, brief: null });

  const epub = await buildEpub({
    uuid: randomUUID(),
    title,
    subtitle,
    author: run.author,
    publisher: run.author,
    language: language.code,
    rtl: Boolean(language.rtl),
    description: "",
    chapters: written,
    figures,
    coverSvg,
    aiDisclosure: disclosureFor({ imagesGenerated: figures.size > 0 || Boolean(coverImage) }),
    draft: `Draft — ${written.length} of ${run.totalChapters} chapters. Not the finished book.`,
  });

  return {
    epub,
    filename: `${slug(title)}-draft-${written.length}of${run.totalChapters}.epub`,
    chapters: written.length,
    totalChapters: run.totalChapters,
    words: written.reduce((sum, c) => sum + c.words, 0),
  };
}

/** The same thing as editable text, for reading on a phone or fixing in an editor. */
export async function buildDraftMarkdown({ bookId }) {
  const run = await runState.readRun(bookId);
  if (!run) throw new Error(`No run for ${bookId}.`);
  const written = await chapters.readAllChapters(bookId, run.totalChapters || 60);
  if (!written.length) throw new Error("Nothing has been written yet.");

  const heading = `# ${run.title || "Untitled"}\n\n> Draft — ${written.length} of ${run.totalChapters} chapters, ${written
    .reduce((sum, c) => sum + c.words, 0)
    .toLocaleString()} words. Edit any chapter and the editorial pass will leave it alone.\n\n---\n\n`;

  return { markdown: heading + chapters.assembleManuscript(written), chapters: written.length };
}

/**
 * Save an edit made while the run is paused.
 *
 * Writes the chapter file and marks it yours, which is what keeps the
 * editorial pass off it when the run resumes.
 */
export async function saveChapterEdit({ bookId, number, body, title }) {
  const existing = await chapters.readChapter(bookId, number);
  if (!existing) throw new Error(`Chapter ${number} has not been written yet.`);

  const chapter = { number, title: title || existing.title, body: String(body) };
  await chapters.writeChapter(bookId, chapter);

  await runState.patchRun(bookId, (run) => {
    const entry = run.chapters.find((c) => c.number === number);
    if (entry) {
      entry.humanEdited = true;
      entry.words = countWords(chapter.body);
      entry.title = chapter.title;
      // Deliberately NOT updating bodyHash: the hash records what the engine
      // last wrote, and the gap between it and the file is the evidence that
      // you edited this.
    }
    run.wordsWritten = run.chapters.reduce((sum, c) => sum + (c.words || 0), 0);
    runState.appendLog(run, `You edited chapter ${number}. The editorial pass will leave it alone.`);
  });
  await runState.settle(bookId);

  return { ok: true, words: countWords(chapter.body) };
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
}

export const __test = { phasesFor, markHumanEdits, imageUnitCost };
