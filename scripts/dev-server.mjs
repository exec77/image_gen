import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import generate from "../api/generate.js";
import status from "../api/status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const HOST = process.env.HOST || "127.0.0.1";

loadLocalEnv();

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/api/generate") {
      return generate(req, res);
    }

    if (requestUrl.pathname === "/api/status") {
      return status(req, res);
    }

    const safePath =
      requestUrl.pathname === "/"
        ? "index.html"
        : decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
    const filePath = path.normalize(path.join(publicDir, safePath));

    if (!filePath.startsWith(publicDir)) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }

    const body = await readFile(filePath);
    res.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) || "application/octet-stream"
    );
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.statusCode = 404;
      return res.end("Not found");
    }

    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(error.message || "Server error");
  }
}).listen(PORT, HOST, () => {
  console.log(`image_gen is running on http://${HOST}:${PORT}`);
});

function loadLocalEnv() {
  const envPath = path.join(rootDir, ".env.local");

  if (!existsSync(envPath)) {
    return;
  }

  const text = readFileSync(envPath, "utf8");

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  }
}
