/**
 * The only module that talks to the Claude API.
 *
 * Two cost decisions are baked in here, both deliberate:
 *   - Chapters are drafted through the Batch API (50% off). Book generation is
 *     not latency-sensitive, so there is no reason to pay realtime rates.
 *   - The series bible is sent as a cached system prefix, so the shared context
 *     is billed once per batch rather than once per chapter.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  MODEL,
  PRICING,
  BATCH_DISCOUNT,
  BATCH_POLL_MS,
  BATCH_TIMEOUT_MS,
  isDryRun,
} from "./config.js";
import { stubProse } from "./stub.js";

let client = null;

function api() {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Cached tokens are not free, and are not priced like ordinary input.
 *
 *   write  1.25x the input rate for the default 5-minute entry, 2x for a
 *          one-hour one - you pay a premium to put the prefix in the cache
 *   read   0.1x the input rate - cheap, which is the point, but not zero
 *
 * Counting them at zero is what made the reported cost of a book wrong: the
 * editorial pass sends the whole manuscript as a cached prefix, so a
 * twelve-chapter book writes ~100k tokens to cache once and reads them back
 * on every chapter. At Sonnet rates that is real money reported as $0.00.
 */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

/** Running tally for the current process, reported at the end of a run. */
export const spend = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0,
};

function recordUsage(usage, { batch = false } = {}) {
  if (!usage) return;
  const price = PRICING[MODEL] || PRICING["claude-sonnet-5"];
  const multiplier = batch ? BATCH_DISCOUNT : 1;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;

  // When the API breaks writes down by lifetime, price each at its own rate.
  // Without the breakdown, assume the 5-minute entry this engine actually
  // asks for - guessing the dearer one would overstate every run.
  const byTtl = usage.cache_creation || null;
  const write1h = byTtl ? byTtl.ephemeral_1h_input_tokens || 0 : 0;
  const write5m = byTtl ? byTtl.ephemeral_5m_input_tokens || 0 : cacheWrite;

  spend.inputTokens += input;
  spend.outputTokens += output;
  spend.cacheReadTokens += cacheRead;
  spend.cacheWriteTokens += cacheWrite;

  spend.usd +=
    ((input / 1e6) * price.input +
      (output / 1e6) * price.output +
      (write5m / 1e6) * price.input * CACHE_WRITE_5M +
      (write1h / 1e6) * price.input * CACHE_WRITE_1H +
      (cacheRead / 1e6) * price.input * CACHE_READ) *
    multiplier;
}

/** Exposed for the unit tests; nothing else should reach for it. */
export const __test = { recordUsage, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ };

export function spendReport() {
  return {
    ...spend,
    usd: Number(spend.usd.toFixed(4)),
    model: MODEL,
  };
}

function textOf(message) {
  return (message.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * A structured call: returns an object validated against `schema`.
 * Used for planning and marketing copy, where downstream code needs fields.
 */
export async function structured({ schema, stub, system, prompt, maxTokens = 16000, effort = "high" }) {
  // In dry-run the caller supplies a sample matching `schema`, so the stub
  // never has to reverse-engineer Zod internals.
  if (isDryRun()) return schema.parse(typeof stub === "function" ? stub() : stub);

  const response = await api().messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort, format: zodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: prompt }],
  });

  recordUsage(response.usage);

  if (response.stop_reason === "refusal") {
    throw new Error(
      `The model declined this request (${response.stop_details?.category || "unspecified"}). ` +
        `Adjust the brief and retry.`,
    );
  }
  if (!response.parsed_output) {
    throw new Error("Model returned no parseable structured output.");
  }
  return response.parsed_output;
}

/**
 * A batch of prose generations. `jobs` is [{ id, prompt }]; `system` is the
 * shared, cached prefix. Returns a Map of id -> text.
 *
 * Progress is reported through `onProgress` so the CLI can show something
 * during what may be a multi-minute wait.
 */
export async function batchProse({
  jobs,
  system,
  maxTokens = 16000,
  effort = "medium",
  onProgress = () => {},
}) {
  if (isDryRun()) {
    const out = new Map();
    for (const job of jobs) out.set(job.id, stubProse(job.prompt));
    onProgress({ phase: "ended", succeeded: jobs.length, total: jobs.length });
    return out;
  }

  const batch = await api().messages.batches.create({
    requests: jobs.map((job) => ({
      custom_id: job.id,
      params: {
        model: MODEL,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort },
        // The cached prefix must be byte-identical across requests for the
        // cache to hit; it is built once by the caller and reused verbatim.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: job.prompt }],
      },
    })),
  });

  onProgress({ phase: "submitted", batchId: batch.id, total: jobs.length });

  const startedAt = Date.now();
  let current = batch;

  while (current.processing_status !== "ended") {
    if (Date.now() - startedAt > BATCH_TIMEOUT_MS) {
      throw new Error(`Batch ${batch.id} did not finish within 24h.`);
    }
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
    current = await api().messages.batches.retrieve(batch.id);
    onProgress({
      phase: "polling",
      batchId: batch.id,
      succeeded: current.request_counts?.succeeded || 0,
      processing: current.request_counts?.processing || 0,
      total: jobs.length,
    });
  }

  const results = new Map();
  const failures = [];

  // Results arrive in arbitrary order - always key by custom_id.
  for await (const item of await api().messages.batches.results(batch.id)) {
    if (item.result.type === "succeeded") {
      const message = item.result.message;
      if (message.stop_reason === "refusal") {
        failures.push(`${item.custom_id}: declined by safety classifier`);
        continue;
      }
      recordUsage(message.usage, { batch: true });
      results.set(item.custom_id, textOf(message));
    } else if (item.result.type === "errored") {
      failures.push(`${item.custom_id}: ${item.result.error?.type || "error"}`);
    } else {
      failures.push(`${item.custom_id}: ${item.result.type}`);
    }
  }

  onProgress({ phase: "ended", succeeded: results.size, total: jobs.length, failures });

  if (failures.length) {
    throw new Error(
      `${failures.length} of ${jobs.length} generations failed:\n  ${failures.join("\n  ")}`,
    );
  }
  return results;
}
