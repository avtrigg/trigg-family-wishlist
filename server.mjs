import { createServer } from "node:http";
import { createApplication } from "./application.mjs";
import { openDatabase } from "./database.mjs";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const origin = new URL(process.env.APP_ORIGIN || "http://localhost:" + port).origin;
const familyCode = process.env.FAMILY_ACCESS_CODE;
const production = process.env.NODE_ENV === "production";
if (production && (!origin.startsWith("https:") || !familyCode || familyCode.length < 16)) {
  throw new Error("Production requires an HTTPS APP_ORIGIN and a FAMILY_ACCESS_CODE of at least 16 characters.");
}

const app = createApplication({
  db: openDatabase(process.env.DATABASE_PATH || "wishlist.sqlite"), origin, familyCode,
  googleId: process.env.GOOGLE_CLIENT_ID, googleSecret: process.env.GOOGLE_CLIENT_SECRET,
});
const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (incoming, outgoing) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 1_000_000) {
        outgoing.writeHead(413).end("Request too large");
        return;
      }
      chunks.push(chunk);
    }
    const target = new URL(incoming.url, origin);
    if (target.origin !== origin) { outgoing.writeHead(400).end(); return; }
    const request = new Request(target, {
      method: incoming.method, headers: incoming.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const result = await app(request, incoming.socket.remoteAddress);
    const headers = Object.fromEntries(result.headers);
    if (result.headers.has("set-cookie")) headers["set-cookie"] = result.headers.getSetCookie();
    outgoing.writeHead(result.status, headers).end(Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(400);
    outgoing.end();
  }
});
server.listen(port, host, () => console.log("Trigg Family Wishlist • " + origin));
