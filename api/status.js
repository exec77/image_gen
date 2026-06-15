import {
  callPolza,
  getApiKey,
  methodNotAllowed,
  sendJson
} from "./_polza.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return methodNotAllowed(res, "GET");
  }

  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      return sendJson(res, 500, {
        error: "POLZA_API_KEY is not configured on the server"
      });
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const id = url.searchParams.get("id");

    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return sendJson(res, 400, { error: "A valid generation id is required" });
    }

    const { response, data } = await callPolza(`/media/${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      return sendJson(res, response.status, {
        error: "Polza status request failed",
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
