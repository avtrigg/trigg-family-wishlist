import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAuth } from "./auth.mjs";
import { lookupProduct, webUrl } from "./products.mjs";

const assets = new Map(Object.entries({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
}).map(([route, [file, type]]) => [route, { type, content: readFileSync(new URL("./public/" + file, import.meta.url)) }]));

const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
const fail = (error, status) => json({ error }, status);
const text = (value) => typeof value === "string" ? value : "";

export function createApplication(options) {
  const { db, origin, familyCode, preview = lookupProduct } = options;
  const auth = createAuth({ ...options, json, fail });
  const limits = new Map();

  function limited(key, max) {
    const now = Date.now();
    const record = limits.get(key);
    if (record?.expires > now) return ++record.count > max;
    if (limits.size >= 1024) {
      for (const [id, entry] of limits) if (entry.expires <= now) limits.delete(id);
      if (limits.size >= 2048) return true;
    }
    limits.set(key, { count: 1, expires: now + 600_000 });
    return false;
  }

  function home(user) {
    const lists = db.prepare("SELECT id, name, owner_id FROM lists ORDER BY name COLLATE NOCASE, id").all();
    return json({
      user, mine: lists.find((list) => list.owner_id === user.id)?.id ?? null,
      lists: lists.map(({ id, name }) => ({ id, name })),
    });
  }

  function createList(user, input) {
    if (input.for === "self") {
      const result = db.prepare(`
        INSERT INTO lists (id, name, owner_id, creator_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO NOTHING RETURNING id
      `).get(randomUUID(), user.name, user.id, user.id);
      return result ? json(result, 201) : fail("You already have a wishlist.", 409);
    }
    if (input.for !== "other") return fail("Choose who the wishlist is for.", 400);
    const name = text(input.name).trim();
    const email = text(input.email).trim().toLowerCase();
    if (!name || name.length > 100) return fail("Enter the recipient’s name.", 400);
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return fail("Enter a valid email address or leave it blank.", 400);
    const account = email ? db.prepare("SELECT id FROM accounts WHERE verified_email = ?").get(email) : null;
    const result = db.prepare(`
      INSERT INTO lists (id, name, owner_id, contact_email, creator_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id
    `).get(randomUUID(), name, account?.id ?? null, email || null, user.id);
    return result ? json(result, 201) : fail(account?.id === user.id ? "You already have a wishlist." : "A wishlist already exists for this person’s account or email.", 409);
  }

  function readList(list, user) {
    const isOwner = list.owner_id === user.id;
    const canEdit = isOwner || (!list.owner_id && list.creator_id === user.id);
    const items = isOwner ? db.prepare(`
      SELECT id, name, url, notes, image, price FROM items WHERE list_id = ? AND added_by IS NULL ORDER BY rowid DESC
    `).all(list.id) : db.prepare(`
      SELECT i.id, i.name, i.url, i.notes, i.image, i.price, i.claimed_by IS NOT NULL AS claimed,
        i.claimed_by = ? AS claimedByMe, i.added_by = ? AS addedByMe, a.name AS addedBy
      FROM items i LEFT JOIN accounts a ON a.id = i.added_by WHERE i.list_id = ? ORDER BY i.rowid DESC
    `).all(user.id, user.id, list.id);
    return json({ id: list.id, name: list.name, isOwner, canEdit, items });
  }

  function itemFields(input) {
    const url = webUrl(input.url);
    const image = webUrl(input.image);
    if (text(input.url).trim() && !url) return;
    if (text(input.image).trim() && !image.startsWith("https:")) return;
    return [text(input.name), url, text(input.notes), image, text(input.price)];
  }

  function updateList(list, user, input) {
    const isOwner = list.owner_id === user.id;
    const editor = isOwner || (!list.owner_id && list.creator_id === user.id);
    const action = input.action;
    if (action === "add" || action === "purchase") {
      const purchase = action === "purchase";
      if (purchase ? isOwner : !editor) return fail("You can’t add this item.", 403);
      const fields = itemFields(input);
      if (!fields) return fail("Use a valid website link and an HTTPS image link.", 400);
      const id = randomUUID();
      const buyer = purchase ? user.id : null;
      db.prepare(`
        INSERT INTO items (id, list_id, name, url, notes, image, price, added_by, claimed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, list.id, ...fields, buyer, buyer);
      return json({ id }, 201);
    }
    if ((action === "claim" || action === "release") && isOwner) return fail("This action is for other family members.", 403);
    const item = db.prepare("SELECT id, added_by FROM items WHERE id = ? AND list_id = ?").get(text(input.itemId), list.id);
    if (!item || (isOwner && item.added_by)) return fail("Item not found.", 404);
    if (action === "claim" || action === "release") {
      if (item.added_by) return fail("This purchase is already recorded.", 409);
      const result = action === "claim"
        ? db.prepare("UPDATE items SET claimed_by = ? WHERE id = ? AND claimed_by IS NULL").run(user.id, item.id)
        : db.prepare("UPDATE items SET claimed_by = NULL WHERE id = ? AND claimed_by = ?").run(item.id, user.id);
      return result.changes ? json({}) : fail("The claim has already changed.", 409);
    }
    if (item.added_by ? item.added_by !== user.id : !editor) return fail("You can’t change this item.", 403);
    if (action === "remove") {
      db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      return json({});
    }
    if (action === "edit") {
      const fields = itemFields(input);
      if (!fields) return fail("Use a valid website link and an HTTPS image link.", 400);
      db.prepare("UPDATE items SET name = ?, url = ?, notes = ?, image = ?, price = ? WHERE id = ?").run(...fields, item.id);
      return json({});
    }
    return fail("Action not found.", 400);
  }

  async function handler(request, ip = "local") {
    const url = new URL(request.url);
    const route = url.pathname;
    if (request.method === "GET" && assets.has(route)) {
      const asset = assets.get(route);
      return new Response(asset.content, { headers: {
        "Content-Type": asset.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      } });
    }
    if (request.method === "GET" && route === "/auth/google/callback") {
      try { return await auth.finishGoogle(request, url); }
      catch { return auth.authError("google"); }
    }
    if (!route.startsWith("/api/")) return new Response("Page not found", { status: 404 });
    if (request.method === "POST" && (request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";")[0] !== "application/json")) return fail("Invalid request origin or content type.", 403);
    const user = auth.viewer(request);
    if (request.method === "GET" && route === "/api/account") return json({ user: user ?? null, google: auth.googleEnabled, requiresCode: Boolean(familyCode) });
    if (request.method === "POST" && route.startsWith("/api/auth/")) {
      if (route === "/api/auth/logout") return auth.logout(request);
      if (limited("auth:" + ip, 24)) return fail("Too many attempts. Try again in a few minutes.", 429);
      if (route === "/api/auth/login") return auth.credentials(request, "login");
      if (route === "/api/auth/signup") return auth.credentials(request, "signup");
      if (route === "/api/auth/google") return auth.beginGoogle(request);
      return fail("Page not found.", 404);
    }
    if (!user) return fail("Sign in to continue.", 401);
    if (request.method === "GET" && route === "/api/wishlists") return home(user);
    const listId = /^\/api\/wishlists\/([a-f0-9-]{36})$/.exec(route)?.[1];
    if (request.method === "GET" && listId) {
      const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(listId);
      return list ? readList(list, user) : fail("Wishlist not found.", 404);
    }
    if (request.method === "POST") {
      const input = await request.json().catch(() => null);
      if (!input || typeof input !== "object") return fail("Invalid request.", 400);
      if (route === "/api/wishlists") return createList(user, input);
      if (route === "/api/product") {
        if (limited("preview:" + user.id, 40)) return fail("Too many lookups. You can still fill in the details.", 429);
        return json(await preview(text(input.url)));
      }
      if (listId) {
        const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(listId);
        return list ? updateList(list, user, input) : fail("Wishlist not found.", 404);
      }
    }
    return fail("Page not found.", 404);
  }

  return async (request, ip) => {
    try { return await handler(request, ip); }
    catch (error) {
      console.error(error);
      return fail("Something went wrong. Please try again.", 500);
    }
  };
}
