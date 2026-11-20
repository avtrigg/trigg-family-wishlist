import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../dist/server/index.js";

const accounts = {
  owner: { id: "user-1", email: "alex@example.test", name: "Alex" },
  buyer: { id: "user-2", email: "jordan@example.test", name: "Jordan" },
  observer: { id: "user-3", email: "sam@example.test", name: "Sam" },
};

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("drizzle/0000_family.sql", "utf8"));
  const environment = { DB: { prepare(sql) {
    const statement = db.prepare(sql);
    const bind = (...args) => ({
      first: async () => statement.get(...args) ?? null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => statement.run(...args),
    });
    return { ...bind(), bind };
  } } };

  async function send(account, query = "", body) {
    const headers = new Headers();
    if (account) {
      headers.set("oai-authenticated-user-id", account.id);
      headers.set("oai-authenticated-user-email", account.email);
      headers.set("oai-authenticated-user-full-name", account.name);
    }
    if (body) headers.set("Content-Type", "application/json");
    const request = new Request("https://wishlist.example.test/api/wishlist" + query,
      { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    const result = await worker.fetch(request, environment);
    return { status: result.status, data: await result.json(), cache: result.headers.get("Cache-Control") };
  }
  return { send, close: () => db.close() };
}

test("family can create lists, add wishes, and browse them", async (t) => {
  const { send, close } = setup();
  t.after(close);
  const { owner, buyer } = accounts;
  assert.equal((await send(null)).status, 401);
  const create = { action: "addPerson", name: "Alex", email: "ALEX@example.test" };
  const created = await send(buyer, "", create);
  assert.equal(created.status, 201);
  assert.equal((await send(owner, "", create)).status, 409);

  const personId = created.data.id;
  const family = await send(owner);
  assert.deepEqual(family.data.people, [{ id: personId, name: "Alex", isOwner: true }]);
  assert.equal((await send(buyer)).data.people[0].isOwner, false);
  const wish = { action: "addWish", personId, title: "Jigsaw puzzle", note: "500 pieces", url: "https://example.test/puzzle" };
  assert.equal((await send(buyer, "", wish)).status, 403);
  assert.equal((await send(owner, "", { ...wish, url: "javascript:alert(1)" })).status, 400);
  const saved = await send(owner, "", wish);
  assert.equal(saved.status, 201);
  assert.deepEqual((await send(buyer, "?person=" + personId)).data, {
    wishes: [{ id: saved.data.id, title: wish.title, note: wish.note, url: wish.url }],
  });
});

test("purchase data is restricted to other family members and duplicates are prevented", async (t) => {
  const { send, close } = setup();
  t.after(close);
  const { owner, buyer, observer } = accounts;
  const { data: { id: personId } } = await send(owner, "", { action: "addPerson", name: owner.name, email: owner.email });
  const { data: { id: wishId } } = await send(owner, "", { action: "addWish", personId, title: "Sketchbook" });
  const query = "?person=" + personId;
  const purchaseQuery = query + "&view=purchases";
  const buy = { action: "buyWish", personId, wishId };
  assert.equal((await send(owner, "", buy)).status, 403);
  assert.equal((await send(null, purchaseQuery)).status, 401);
  assert.equal((await send(buyer, "", buy)).status, 201);
  assert.equal((await send(observer, "", buy)).status, 409);
  assert.equal((await send(buyer, "", { action: "addPurchase", personId, title: "Surprise book" })).status, 201);
  const hidden = await send(owner, purchaseQuery);
  assert.equal(hidden.status, 403);
  assert.equal(hidden.cache, "private, no-store");
  assert.deepEqual((await send(owner, query)).data.wishes, [{ id: wishId, title: "Sketchbook", url: null, note: null }]);

  const purchases = (await send(observer, purchaseQuery)).data.purchases;
  assert.equal(purchases.length, 2);
  const sketchbook = purchases.find((gift) => gift.wishId === wishId);
  assert.equal(sketchbook.buyerName, buyer.name);
  assert.equal(sketchbook.isMine, 0);
  const undo = { action: "undoPurchase", personId, purchaseId: sketchbook.id };
  assert.equal((await send(owner, "", undo)).status, 403);
  assert.equal((await send(observer, "", undo)).status, 404);
  assert.equal((await send(buyer, "", undo)).status, 200);
  assert.equal((await send(observer, purchaseQuery)).data.purchases.length, 1);
});
