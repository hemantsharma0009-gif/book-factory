/**
 * Real image generation.
 *
 * FIRST, THE THING TO KNOW: the Claude API does not generate images. There is
 * no setting that makes it. Artwork needs a second vendor, a second key and a
 * second bill, and there is no way around that - so this module keeps the
 * engine's dependence on any one of them as thin as possible.
 *
 * Drivers all reduce to one function:
 *
 *     generate({ prompt, aspect, size }) -> { mediaType, data: Buffer }
 *
 *   google       Gemini image generation. The request and response shapes here
 *                were read from Google's live API discovery document, not
 *                recalled - generationConfig.responseModalities, imageConfig
 *                .aspectRatio/.imageSize, and inlineData on the response part.
 *   openai       /v1/images/generations, b64_json. Written from the documented
 *                shape; NOT verified against the live API from here, because
 *                this sandbox cannot reach api.openai.com.
 *   custom       any HTTP image API, described by a small JSON file. This is
 *                the escape hatch: it means a provider I have never heard of
 *                does not require a code change.
 *   placeholder  offline, free, no key. Produces a real PNG so you can see
 *                where pictures land in the book before paying for any.
 *
 * Bytes are validated as PNG or JPEG before they are put in a book. A provider
 * that returns an HTML error page with a 200 is not a hypothetical.
 */
import { encodePng, isPng, isJpeg } from "./png.js";

const TIMEOUT_MS = Number(process.env.BOOK_FACTORY_IMAGE_TIMEOUT_MS || 120_000);

/** Aspect presets. Figures sit in running text; covers are tall. */
export const ASPECTS = {
  figure: "3:2",
  cover: "2:3",
  square: "1:1",
};

/**
 * How large to ask for.
 *
 * This is a money decision, not a quality one. Amazon deducts a delivery fee
 * per megabyte from the 70% royalty, so every megabyte of artwork is taken out
 * of every single sale, forever. A 1K interior figure is already more than an
 * e-ink page can show; a 2K one doubles the file for pixels nobody sees.
 *
 * The cover is the exception - it is the one image Amazon displays at full
 * size in a store listing, and KDP wants 1600x2560.
 */
export const SIZES = {
  figure: process.env.BOOK_FACTORY_IMAGE_SIZE || "1K",
  cover: process.env.BOOK_FACTORY_COVER_SIZE || "2K",
};

class ImageError extends Error {
  constructor(message, { driver, status } = {}) {
    super(message);
    this.name = "ImageError";
    this.driver = driver;
    this.status = status;
  }
}

async function postJson(url, { headers, body, driver }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // Providers put the useful part of a failure in the body, not the status.
    throw new ImageError(`${driver}: HTTP ${response.status} — ${text.slice(0, 400)}`, {
      driver,
      status: response.status,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ImageError(`${driver}: response was not JSON — ${text.slice(0, 200)}`, { driver });
  }
}

function decodeImage(base64, mediaType, driver) {
  const data = Buffer.from(String(base64 || ""), "base64");
  if (!isPng(data) && !isJpeg(data)) {
    throw new ImageError(
      `${driver} returned ${data.length} bytes that are neither PNG nor JPEG. ` +
        `Nothing was added to the book.`,
      { driver },
    );
  }
  return { mediaType: isPng(data) ? "image/png" : "image/jpeg", data, declared: mediaType };
}

/* ------------------------------------------------------------------ google */

const googleModel = () => process.env.BOOK_FACTORY_IMAGE_MODEL || "gemini-2.5-flash-image";

/**
 * Overridable so the driver can be pointed at a regional endpoint, a proxy, or
 * a local server in a test. Without this the only way to check the request
 * shape is to spend money on the real API.
 */
const googleBase = () => process.env.GOOGLE_API_BASE_URL || "https://generativelanguage.googleapis.com";
const openaiBase = () => process.env.OPENAI_BASE_URL || "https://api.openai.com";

const google = {
  id: "google",
  label: "Google Gemini image generation",
  env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  keyFor: () => process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null,

  async generate({ prompt, aspect = ASPECTS.figure, size = SIZES.figure }) {
    const key = google.keyFor();
    if (!key) throw new ImageError("google: no GOOGLE_API_KEY (or GEMINI_API_KEY) set.", { driver: "google" });

    const payload = await postJson(
      `${googleBase()}/v1beta/models/${encodeURIComponent(googleModel())}:generateContent`,
      {
        driver: "google",
        headers: { "x-goog-api-key": key },
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: aspect, imageSize: size },
          },
        },
      },
    );

    const candidate = payload.candidates?.[0];
    const part = candidate?.content?.parts?.find((p) => p.inlineData?.data);

    if (!part) {
      const reason = candidate?.finishReason || payload.promptFeedback?.blockReason || "no image in response";
      throw new ImageError(
        `google: ${reason}. ${candidate?.finishMessage || "The prompt may have been refused."}`,
        { driver: "google" },
      );
    }
    return { ...decodeImage(part.inlineData.data, part.inlineData.mimeType, "google"), model: googleModel() };
  },
};

/* ------------------------------------------------------------------ openai */

const openai = {
  id: "openai",
  label: "OpenAI image generation",
  env: ["OPENAI_API_KEY"],
  keyFor: () => process.env.OPENAI_API_KEY || null,

  async generate({ prompt, aspect = ASPECTS.figure }) {
    const key = openai.keyFor();
    if (!key) throw new ImageError("openai: no OPENAI_API_KEY set.", { driver: "openai" });

    // This API takes pixel dimensions rather than a ratio.
    const size = aspect === ASPECTS.cover ? "1024x1536" : aspect === ASPECTS.square ? "1024x1024" : "1536x1024";

    const payload = await postJson(`${openaiBase()}/v1/images/generations`, {
      driver: "openai",
      headers: { Authorization: `Bearer ${key}` },
      body: {
        model: process.env.BOOK_FACTORY_IMAGE_MODEL || "gpt-image-1",
        prompt,
        size,
        n: 1,
      },
    });

    const first = payload.data?.[0];
    if (!first?.b64_json) throw new ImageError("openai: no image data in response.", { driver: "openai" });
    return { ...decodeImage(first.b64_json, "image/png", "openai"), model: payload.model || "gpt-image-1" };
  },
};

/* ------------------------------------------------------------------ custom */

/**
 * Any HTTP image API, described by BOOK_FACTORY_IMAGE_CONFIG pointing at JSON:
 *
 *   {
 *     "url": "https://…",
 *     "headers": { "Authorization": "Bearer ${MY_KEY}" },
 *     "body": { "prompt": "${prompt}", "aspect_ratio": "${aspect}" },
 *     "imagePath": "images.0.b64",     // dotted path to base64 in the response
 *     "label": "Whatever you use"
 *   }
 *
 * `${prompt}` and `${aspect}` are substituted into the body; `${ANYTHING_ELSE}`
 * is read from the environment, so keys live in the environment and never in
 * the config file.
 */
const custom = {
  id: "custom",
  label: "Custom image API",
  env: ["BOOK_FACTORY_IMAGE_CONFIG"],
  keyFor: () => process.env.BOOK_FACTORY_IMAGE_CONFIG || null,

  async generate({ prompt, aspect = ASPECTS.figure }) {
    const file = custom.keyFor();
    if (!file) throw new ImageError("custom: BOOK_FACTORY_IMAGE_CONFIG is not set.", { driver: "custom" });

    const fs = await import("node:fs/promises");
    let config;
    try {
      config = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      throw new ImageError(`custom: cannot read ${file} — ${err.message}`, { driver: "custom" });
    }
    if (!config.url || !config.imagePath) {
      throw new ImageError(`custom: ${file} needs at least "url" and "imagePath".`, { driver: "custom" });
    }

    const fill = (value) => {
      if (typeof value === "string") {
        return value.replace(/\$\{(\w+)\}/g, (_, name) => {
          if (name === "prompt") return prompt;
          if (name === "aspect") return aspect;
          return process.env[name] ?? "";
        });
      }
      if (Array.isArray(value)) return value.map(fill);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
      }
      return value;
    };

    const payload = await postJson(fill(config.url), {
      driver: "custom",
      headers: fill(config.headers || {}),
      body: fill(config.body || { prompt }),
    });

    const found = config.imagePath.split(".").reduce((node, key) => node?.[key], payload);
    if (!found) {
      throw new ImageError(
        `custom: nothing at "${config.imagePath}" in the response. Got keys: ${Object.keys(payload).join(", ")}`,
        { driver: "custom" },
      );
    }
    return { ...decodeImage(found, "image/png", "custom"), model: config.label || "custom" };
  },
};

/* ------------------------------------------------------------- placeholder */

/**
 * A real PNG, made locally, free.
 *
 * Not artwork and never pretends to be: it is a flat field in the book's
 * palette with a soft vignette, so you can lay out a twelve-chapter
 * illustrated book, check that the figures sit where you want them and see
 * what it does to the file size, before spending anything on pictures.
 */
const placeholder = {
  id: "placeholder",
  label: "Offline placeholder (free, not artwork)",
  env: [],
  keyFor: () => "offline",

  async generate({ prompt, aspect = ASPECTS.figure }) {
    const [aw, ah] = aspect.split(":").map(Number);
    const width = 768;
    const height = Math.round((width * ah) / aw);

    // Deterministic from the prompt, so the same brief always yields the same
    // placeholder and a rebuild does not churn the file.
    let seed = 0;
    for (const ch of String(prompt)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const base = [(seed >> 16) & 127, (seed >> 8) & 127, seed & 127];

    const data = encodePng(width, height, (x, y) => {
      const dx = (x / width - 0.5) * 2;
      const dy = (y / height - 0.5) * 2;
      const vignette = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 0.55);
      const wash = (x / width) * 0.35 + (y / height) * 0.15;
      return base.map((c) => Math.round((c + 90 * wash) * (0.45 + 0.55 * vignette)));
    });

    return { mediaType: "image/png", data, model: "placeholder" };
  },
};

export const DRIVERS = { google, openai, custom, placeholder };

/** Drivers whose key or config is actually present right now. */
export function availableDrivers() {
  return Object.values(DRIVERS).filter((d) => d.id !== "placeholder" && d.keyFor());
}

/**
 * Pick a driver. An explicit id always wins; otherwise the first configured
 * one. Never silently falls back to the placeholder - a book that quietly
 * shipped with grey rectangles instead of the artwork you paid for would be a
 * far worse outcome than a run that stops and says no key is set.
 */
export function pickDriver(id) {
  if (id && id !== "auto") {
    const driver = DRIVERS[id];
    if (!driver) throw new ImageError(`Unknown image driver "${id}". Known: ${Object.keys(DRIVERS).join(", ")}`);
    return driver;
  }
  const [first] = availableDrivers();
  if (first) return first;

  throw new ImageError(
    "No image provider is configured.\n\n" +
      "  Claude cannot generate images, so artwork needs a second key:\n" +
      "    GOOGLE_API_KEY=…   (or GEMINI_API_KEY)\n" +
      "    OPENAI_API_KEY=…\n" +
      "    BOOK_FACTORY_IMAGE_CONFIG=/path/to/provider.json  for anything else\n\n" +
      "  Put it in engine/.env. To lay the book out first without paying for\n" +
      "  pictures, use --images placeholder.",
  );
}

/** One image, with a single retry on the failures that are worth retrying. */
export async function generateImage({ prompt, aspect = ASPECTS.figure, driver, size }) {
  const chosen = typeof driver === "string" || !driver ? pickDriver(driver) : driver;

  try {
    return await chosen.generate({ prompt, aspect, size });
  } catch (err) {
    const worthRetrying = err.status === 429 || (err.status >= 500 && err.status < 600) || err.name === "TimeoutError";
    if (!worthRetrying) throw err;
    await new Promise((r) => setTimeout(r, 4000));
    return chosen.generate({ prompt, aspect, size });
  }
}

export { ImageError };
