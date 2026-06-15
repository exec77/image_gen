import { readFile } from "node:fs/promises";
import path from "node:path";
import generate from "./api/generate.js";
import status from "./api/status.js";

const publicDir = path.join(process.cwd(), "public");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

export default async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/generate") {
      return generate(req, res);
    }

    if (requestUrl.pathname === "/api/status") {
      return status(req, res);
    }

    const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const filePath = path.normalize(
      path.join(publicDir, decodeURIComponent(pathname).replace(/^\/+/, ""))
    );

    if (!filePath.startsWith(publicDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const body = await readFile(filePath);
    res.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) || "application/octet-stream"
    );
    res.setHeader("Cache-Control", cacheControlFor(filePath));
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    res.statusCode = 500;
    res.end("Server error");
  }
}

function cacheControlFor(filePath) {
  const filename = path.basename(filePath);

  if (filename === "index.html" || filename === "sw.js") {
    return "no-cache";
  }

  return "public, max-age=31536000, immutable";
}
