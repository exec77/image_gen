export const POLZA_API_BASE =
  process.env.POLZA_API_BASE || "https://polza.ai/api/v1";

export const MODEL_ID = "openai/gpt-5.4-image-2";

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES_AS_DATA_URI = 2.8 * 1024 * 1024;
const IMAGE_DATA_URI = /^data:image\/(png|jpe?g|webp);base64,/i;

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function methodNotAllowed(res, allowed = "GET, POST") {
  res.setHeader("Allow", allowed);
  sendJson(res, 405, { error: "Method not allowed" });
}

export function getApiKey() {
  return process.env.POLZA_API_KEY || process.env.POLZA_AI_API_KEY || "";
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body || "{}");
  }

  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function cleanPrompt(prompt) {
  if (typeof prompt !== "string") {
    return "";
  }

  return prompt.trim().slice(0, 5000);
}

export function normalizeImageList(items, kind) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .slice(0, 6)
    .map((item, index) => {
      const data = typeof item?.dataUrl === "string" ? item.dataUrl : "";
      if (!IMAGE_DATA_URI.test(data)) {
        const error = new Error(`Invalid ${kind} image at position ${index + 1}`);
        error.statusCode = 400;
        throw error;
      }

      if (Buffer.byteLength(data, "utf8") > MAX_IMAGE_BYTES_AS_DATA_URI) {
        const error = new Error(
          `${kind} image ${index + 1} is too large after compression`
        );
        error.statusCode = 413;
        throw error;
      }

      return {
        type: "base64",
        data
      };
    });
}

export function toIntInRange(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

export function chooseAspectRatio(value, provider) {
  const common = new Set(["auto", "1:1", "9:16", "16:9", "4:3", "3:4"]);
  const openaiOnly = new Set(["2:3", "3:2", "4:5", "5:4", "21:9"]);

  if (provider === "mie") {
    return common.has(value) ? value : "auto";
  }

  return common.has(value) || openaiOnly.has(value) ? value : "auto";
}

export function chooseResolution(value, provider) {
  if (provider === "mie") {
    return ["1K", "2K", "4K"].includes(value) ? value : "1K";
  }

  return ["1K", "2K"].includes(value) ? value : "1K";
}

export function chooseProvider(value) {
  return value === "mie" ? "mie" : "openai";
}

export function buildPrompt({
  prompt,
  referenceCount,
  characterCount,
  preserveCharacters,
  useReferenceStyle
}) {
  const additions = [];

  if (referenceCount > 0) {
    additions.push(
      `Uploaded image order: images 1-${referenceCount} are visual references/examples. Use them for composition, mood, palette, details and style${useReferenceStyle ? "" : " only when it helps the requested scene"}.`
    );
  }

  if (characterCount > 0) {
    const start = referenceCount + 1;
    const end = referenceCount + characterCount;
    additions.push(
      `Uploaded image order: images ${start}-${end} are character photos. Place these characters in the requested scene and keep them recognizable${preserveCharacters ? ": face shape, hairstyle, age cues, proportions, clothing identity and distinctive features should remain consistent." : "."}`
    );
  }

  if (additions.length === 0) {
    return prompt;
  }

  return `${prompt}\n\nReference handling:\n${additions.map((line) => `- ${line}`).join("\n")}`;
}

export async function callPolza(path, options) {
  const response = await fetch(`${POLZA_API_BASE}${path}`, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return { response, data };
}
