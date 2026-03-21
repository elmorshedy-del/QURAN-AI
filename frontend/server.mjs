import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const DIST_DIR = join(process.cwd(), "dist");
const INDEX_PATH = join(DIST_DIR, "index.html");
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function setHeaders(response, filePath) {
  const extension = extname(filePath).toLowerCase();
  response.setHeader("Content-Type", MIME_TYPES[extension] || "application/octet-stream");

  if (filePath === INDEX_PATH) {
    response.setHeader("Cache-Control", "no-cache");
  } else {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

function sendFile(response, filePath, method) {
  setHeaders(response, filePath);
  response.statusCode = 200;

  if (method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

const server = createServer((request, response) => {
  const method = request.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method Not Allowed");
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const cleanPath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  const requestPath = cleanPath === "/" ? "/index.html" : cleanPath;
  const filePath = join(DIST_DIR, requestPath);

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    sendFile(response, filePath, method);
    return;
  }

  if (!extname(requestPath) && existsSync(INDEX_PATH)) {
    sendFile(response, INDEX_PATH, method);
    return;
  }

  response.statusCode = 404;
  response.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Static frontend server listening on ${PORT}`);
});
