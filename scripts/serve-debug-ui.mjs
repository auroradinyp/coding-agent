#!/usr/bin/env node
/**
 * Zero-dependency static server for debug-ui/ — `pnpm viewer`.
 *
 * The viewer is a single self-contained HTML file, so this just exists to give
 * it a http:// origin (clipboard API, localStorage, etc. behave better than on
 * file://). Serves debug-ui/ as the web root.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..", "debug-ui");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});

let port = Number(process.env.PORT) || 5173;
const maxPort = port + 10;

server.on("error", (err) => {
  if (err.code !== "EADDRINUSE" || port >= maxPort) throw err;
  port += 1;
  server.listen(port);
});

server.listen(port, () => {
  console.log(`流式请求查看器 → http://localhost:${port}/`);
  console.log(`(ctrl+c 退出 · PORT=xxxx pnpm viewer 换端口)`);
});
