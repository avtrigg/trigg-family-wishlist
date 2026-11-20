import { assets } from "./assets.mjs";

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fail(error, status) {
  return json({ error }, status);
}

function viewer(request) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!id || !email) return null;
  let name = request.headers.get("oai-authenticated-user-full-name");
  if (name && request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(name); } catch { name = null; }
  }
  return { id, email, name: name || "A family member" };
}

function field(input, key, limit, optional = false) {
  if (typeof input?.[key] !== "string") return optional ? "" : null;
  const value = input[key].trim();
  return value.length <= limit && (value || optional) ? value : null;
}

async function read(db, user, params) {
  const personId = params.get("person");
  if (!personId) {
    const { results } = await db.prepare("SELECT id, name, owner_email FROM people ORDER BY name COLLATE NOCASE, id").all();
    return json({ viewerEmail: user.email, people: results.map((person) => ({
      id: person.id, name: person.name, isOwner: person.owner_email === user.email,
    })) });
  }

  const person = await db.prepare("SELECT owner_email FROM people WHERE id = ?").bind(personId).first();
  if (!person) return fail("That wishlist could not be found.", 404);

  if (params.get("view") === "purchases") {
    if (person.owner_email === user.email) return fail("This view is for other family members.", 403);
    const { results } = await db.prepare(`
      SELECT id, wish_id AS wishId, title, buyer_name AS buyerName, buyer_id = ? AS isMine
      FROM purchases WHERE person_id = ? ORDER BY created_at DESC, id
    `).bind(user.id, personId).all();
    return json({ purchases: results });
  }

  const { results } = await db.prepare(
    "SELECT id, title, url, note FROM wishes WHERE person_id = ? ORDER BY created_at DESC, id",
  ).bind(personId).all();
  return json({ wishes: results });
}

async function write(db, user, request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("Send wishlist updates as JSON.", 415);
  }
  const input = await request.json().catch(() => null);
  const action = input?.action;
  const id = crypto.randomUUID();
  const date = new Date().toISOString();
  if (action === "addPerson") {
    const name = field(input, "name", 80);
    const email = field(input, "email", 254)?.toLowerCase();
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail("Enter a name and their ChatGPT sign-in email.", 400);
    }
    const result = await db.prepare(`
      INSERT INTO people (id, name, owner_email, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_email) DO NOTHING RETURNING id
    `).bind(id, name, email, date).first();
    return result ? json(result, 201) : fail("A wishlist already exists for that sign-in email.", 409);
  }

  const personId = field(input, "personId", 36);
  if (!personId) return fail("Choose a wishlist.", 400);
  const person = await db.prepare("SELECT owner_email FROM people WHERE id = ?").bind(personId).first();
  if (!person) return fail("That wishlist could not be found.", 404);

  const isOwner = person.owner_email === user.email;
  if (action === "addWish") {
    if (!isOwner) return fail("Only the recipient can add wishes to this list.", 403);
    const title = field(input, "title", 160);
    const url = field(input, "url", 2048, true);
    const note = field(input, "note", 500, true);
    if (!title || url === null || note === null) return fail("Check the gift name, link, and notes.", 400);
    if (url) {
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
      } catch {
        return fail("The product link must start with https:// or http://.", 400);
      }
    }
    await db.prepare(`
      INSERT INTO wishes (id, person_id, title, url, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, personId, title, url || null, note || null, date).run();
    return json({ id }, 201);
  }

  if (isOwner) return fail("This view is for other family members.", 403);

  if (action === "undoPurchase") {
    const purchaseId = field(input, "purchaseId", 36);
    if (!purchaseId) return fail("Choose a purchase.", 400);
    const removed = await db.prepare(
      "DELETE FROM purchases WHERE id = ? AND person_id = ? AND buyer_id = ? RETURNING id",
    ).bind(purchaseId, personId, user.id).first();
    return removed ? json(removed) : fail("That purchase could not be found.", 404);
  }

  if (action === "addPurchase") {
    const title = field(input, "title", 160);
    if (!title) return fail("Enter a gift name.", 400);
    await db.prepare(`
      INSERT INTO purchases (id, person_id, title, buyer_id, buyer_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, personId, title, user.id, user.name, date).run();
    return json({ id }, 201);
  }

  if (action === "buyWish") {
    const wishId = field(input, "wishId", 36);
    if (!wishId) return fail("Choose a gift idea.", 400);
    const wish = await db.prepare("SELECT title FROM wishes WHERE id = ? AND person_id = ?").bind(wishId, personId).first();
    if (!wish) return fail("That gift idea could not be found.", 404);
    const result = await db.prepare(`
      INSERT INTO purchases (id, person_id, wish_id, title, buyer_id, buyer_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wish_id) DO NOTHING RETURNING id
    `).bind(id, personId, wishId, wish.title, user.id, user.name, date).first();
    return result ? json(result, 201) : fail("Someone already bought this gift.", 409);
  }
  return fail("That action could not be recognized.", 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/wishlist") {
      const user = viewer(request);
      if (!user) return fail("Sign in to open the family wishlist.", 401);
      try {
        if (request.method === "GET") return await read(env.DB, user, url.searchParams);
        if (request.method === "POST") return await write(env.DB, user, request);
        return fail("That method is unavailable.", 405);
      } catch (error) {
        console.error(error);
        return fail("Couldn’t open or save the list. Please try again.", 500);
      }
    }
    const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : null;
    if (request.method !== "GET" || !asset) return new Response("Page not found", { status: 404 });
    return new Response(asset.body, { headers: {
      "Content-Type": asset.type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
    } });
  },
};
