/**
 * The durable record of one generation run.
 *
 * Everything the progress bar shows, and everything a resume needs, lives in
 * `library/books/<id>/run.json`. On disk rather than in the server's memory for
 * three reasons:
 *
 *   - a run started from the CLI has to be visible in the console, and vice versa;
 *   - pause is a message from one process to another, so it needs a shared inbox;
 *   - a crash or a restart mid-book must not lose eleven chapters you paid for.
 *
 * Writes are atomic (tmp + rename). A half-written run.json would make a
 * resumable run look corrupt, which is the one failure this file exists to
 * prevent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { bookDir } from "./store.js";

export const RUN_FILE = "run.json";

/**
 * Phase weights for the progress bar.
 *
 * These are wall-clock shares, not token shares: drafting dominates because it
 * is the part you wait for. A bar that jumps 0 -> 90% and then sits there for
 * four minutes is worse than no bar, so the weights are deliberately rough but
 * monotonic - the number never goes backwards.
 */
export const PHASES = [
  { id: "planning", label: "Planning the book", weight: 5 },
  { id: "briefing", label: "Art direction", weight: 2 },
  { id: "drafting", label: "Writing chapters", weight: 55 },
  { id: "editing", label: "Editorial pass", weight: 22 },
  { id: "illustrating", label: "Making the artwork", weight: 11 },
  { id: "packaging", label: "Assembling the book", weight: 5 },
];

export const TERMINAL = new Set(["done", "failed", "cancelled"]);

const phaseIndex = (id) => PHASES.findIndex((p) => p.id === id);

/**
 * Only the phases this run will actually execute count towards 100%. A run
 * with `--images none` would otherwise stall at 89% and finish, which reads as
 * a bug even though nothing is wrong.
 */
function activeWeights(run) {
  const active = new Set(run.activePhases?.length ? run.activePhases : PHASES.map((p) => p.id));
  return PHASES.filter((p) => active.has(p.id));
}

/** 0-100. Monotonic within a run as long as phases are entered in order. */
export function progressOf(run) {
  if (!run) return 0;
  if (run.status === "done") return 100;

  const phases = activeWeights(run);
  const total = phases.reduce((sum, p) => sum + p.weight, 0) || 1;
  const here = phases.findIndex((p) => p.id === run.phase);
  if (here < 0) return 0;

  const before = phases.slice(0, here).reduce((sum, p) => sum + p.weight, 0);
  const fraction = Math.max(0, Math.min(1, run.phaseFraction || 0));
  return Math.round(((before + phases[here].weight * fraction) / total) * 100);
}

/**
 * The one line under the bar. Written to be read at a glance from across a
 * room - what is happening, and how far in.
 */
export function summaryOf(run) {
  if (!run) return "";
  if (run.status === "failed") return run.error || "Failed.";
  if (run.status === "cancelled") return "Stopped. What was written is kept.";
  if (run.status === "done") return `Finished — ${run.wordsWritten.toLocaleString()} words.`;
  if (run.status === "paused") {
    const done = run.chapters.filter((c) => c.done).length;
    return `Paused after chapter ${done} of ${run.totalChapters}. Read it, edit it, then resume.`;
  }
  if (run.pauseRequested) {
    return `Finishing chapter ${run.currentChapter || "?"}, then pausing.`;
  }

  const phase = PHASES.find((p) => p.id === run.phase);
  if (run.phase === "drafting" || run.phase === "editing") {
    const done = run.chapters.filter((c) => (run.phase === "editing" ? c.edited || c.humanEdited : c.done)).length;
    return `${phase.label} — ${done} of ${run.totalChapters} done, ${run.wordsWritten.toLocaleString()} words so far.`;
  }
  return phase ? `${phase.label}…` : "Working…";
}

export function emptyRun({ bookId, totalChapters, wordsTarget, activePhases, meta = {} }) {
  return {
    bookId,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    phase: "planning",
    phaseFraction: 0,
    activePhases: activePhases || PHASES.map((p) => p.id),
    pauseRequested: false,
    cancelRequested: false,
    currentChapter: null,
    totalChapters,
    wordsTarget,
    wordsWritten: 0,
    costUsd: 0,
    chapters: [],
    log: [],
    error: null,
    ...meta,
  };
}

function runPath(bookId) {
  return path.join(bookDir(bookId), RUN_FILE);
}

export async function readRun(bookId) {
  try {
    return JSON.parse(await fs.readFile(runPath(bookId), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    // A truncated run.json is recoverable - the chapters on disk are the real
    // work - so it must not take down the caller.
    return null;
  }
}

export async function writeRun(run) {
  const file = runPath(run.bookId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...run, updatedAt: Date.now() }, null, 2));
  await fs.rename(tmp, file);
  return run;
}

/**
 * Serialised read-modify-write.
 *
 * The pipeline patches progress every few hundred milliseconds while the
 * server patches `pauseRequested` from a request handler. Without the queue the
 * two interleave and one of them loses - usually the pause, which is the one
 * that matters.
 */
const queues = new Map();

export function patchRun(bookId, mutate) {
  const previous = queues.get(bookId) || Promise.resolve();
  const next = previous.then(async () => {
    const run = await readRun(bookId);
    if (!run) return null;
    const result = mutate(run) || run;
    await writeRun(result);
    return result;
  }).catch((err) => {
    process.emitWarning(`run-state: ${err.message}`);
    return null;
  });
  queues.set(bookId, next);
  return next;
}

/** Drains pending writes. Tests and a clean shutdown need this; nothing else does. */
export function settle(bookId) {
  return queues.get(bookId) || Promise.resolve();
}

export const LOG_LIMIT = 400;

export function appendLog(run, line) {
  run.log.push({ at: Date.now(), line });
  if (run.log.length > LOG_LIMIT) run.log = run.log.slice(-LOG_LIMIT);
  return run;
}

/** What the console polls. Small enough to fetch twice a second. */
export function publicView(run) {
  if (!run) return null;
  return {
    bookId: run.bookId,
    status: run.status,
    phase: run.phase,
    percent: progressOf(run),
    summary: summaryOf(run),
    pauseRequested: Boolean(run.pauseRequested),
    // A run you stopped is still yours to continue; a run still going is not
    // "resumable", and a finished one has nothing left to do.
    resumable:
      run.status === "paused" ||
      run.status === "cancelled" ||
      (run.status === "failed" && run.chapters.some((c) => c.done)),
    title: run.title || null,
    subtitle: run.subtitle || null,
    totalChapters: run.totalChapters,
    wordsTarget: run.wordsTarget,
    wordsWritten: run.wordsWritten,
    costUsd: Number((run.costUsd || 0).toFixed(4)),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    currentChapter: run.currentChapter,
    error: run.error,
    images: run.images || null,
    chapters: run.chapters.map((c) => ({
      number: c.number,
      title: c.title,
      words: c.words || 0,
      state: chapterState(c),
      humanEdited: Boolean(c.humanEdited),
    })),
    // Anything to download yet?
    hasDraft: run.chapters.some((c) => c.done),
    log: run.log.slice(-60),
  };
}

export function chapterState(chapter) {
  if (chapter.humanEdited) return "edited-by-you";
  if (chapter.edited) return "edited";
  if (chapter.done) return "drafted";
  if (chapter.streaming) return "writing";
  return "waiting";
}
