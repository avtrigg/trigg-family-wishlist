import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const publicFiles = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

const assets = Object.fromEntries(Object.entries(publicFiles).map(([route, [file, type]]) => [
  route, { body: readFileSync("public/" + file, "utf8"), type },
]));
const worker = readFileSync("worker.mjs", "utf8").replace(
  'import { assets } from "./assets.mjs";',
  "const assets = " + JSON.stringify(assets) + ";",
);
mkdirSync("dist/server", { recursive: true });
writeFileSync("dist/server/index.js", worker);
