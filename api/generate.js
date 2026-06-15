import {
  buildPrompt,
  callPolza,
  chooseAspectRatio,
  chooseModel,
  chooseResolution,
  cleanPrompt,
  getApiKey,
  methodNotAllowed,
  normalizeImageList,
  readJson,
  sendJson,
  toIntInRange
} from "./_polza.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return methodNotAllowed(res, "POST");
  }

  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return sendJson(res, 500, {
        error: "POLZA_API_KEY is not configured on the server"
      });
    }

    const body = await readJson(req);
    const prompt = cleanPrompt(body.prompt);

    if (!prompt) {
      return sendJson(res, 400, { error: "Prompt is required" });
    }

    const references = normalizeImageList(body.references, "reference");
    const characters = normalizeImageList(body.characters, "character");
    const imageItems = [...references, ...characters];
    const model = chooseModel(body.model);

    const input = {
      prompt: buildPrompt({
        prompt,
        referenceCount: references.length,
        characterCount: characters.length,
        preserveCharacters: body.preserveCharacters !== false,
        useReferenceStyle: body.useReferenceStyle !== false
      }),
      aspect_ratio: chooseAspectRatio(body.aspectRatio),
      image_resolution: chooseResolution(body.imageResolution),
      n: toIntInRange(body.count, 1, 1, 4)
    };

    if (imageItems.length > 0) {
      input.images = imageItems;
    }

    const { response, data } = await callPolza("/media", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input,
        async: true,
        user: "image_gen"
      })
    });

    if (!response.ok) {
      return sendJson(res, response.status, {
        error: "Polza API request failed",
        details: data
      });
    }

    return sendJson(res, 200, data);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.message || "Unexpected server error"
    });
  }
}
