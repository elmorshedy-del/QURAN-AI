import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const port = Number(process.env.PORT || "4173");
const host = "0.0.0.0";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function resolveResponsePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = cleanPath.replace(/^\/+/, "");
  const candidate = relativePath ? path.join(distDir, relativePath) : path.join(distDir, "index.html");

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isFile()) {
      return candidate;
    }
    if (candidateStat.isDirectory()) {
      const nestedIndex = path.join(candidate, "index.html");
      const nestedStat = await stat(nestedIndex);
      if (nestedStat.isFile()) {
        return nestedIndex;
      }
    }
  } catch {}

  return path.join(distDir, "index.html");
}

const server = createServer(async (req, res) => {
  try {
    const filePath = await resolveResponsePath(req.url || "/");
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown startup error";
    const missingDist =
      detail.includes("ENOENT") && detail.includes(path.join("frontend", "dist"));
    res.writeHead(missingDist ? 503 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(missingDist ? "Frontend build output not found." : detail);
  }
});

server.listen(port, host, () => {
  console.log(`Frontend listening on http://${host}:${port}`);
});
