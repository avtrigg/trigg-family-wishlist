import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "../application.mjs";
import { openDatabase } from "../database.mjs";
import { extractProduct, lookupProduct } from "../products.mjs";

const origin = "http://localhost:3000";
const familyCode = "private-family-test-code";
const password = "long-test-password";

function fixture(t, overrides = {}) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const app = createApplication({ db, origin, familyCode, ...overrides });
  async function send(path, body, cookie, expected = 200) {
    const headers = new Headers(cookie ? { Cookie: cookie } : {});
    if (body !== undefined) {
      headers.set("Origin", origin);
      headers.set("Content-Type", "application/json");
    }
    const result = await app(new Request(origin + path, {
      method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
    }));
    assert.equal(result.status, expected, await result.clone().text());
    return result;
  }
  async function signup(username) {
    const response = await send("/api/auth/signup", { username, password, familyCode }, undefined, 201);
    return response.headers.getSetCookie()[0].split(";")[0];
  }
  return { send, signup, db };
}

test("password accounts, optional recipient email, and one personal wishlist", async (t) => {
  const { send, signup } = fixture(t);
  await send("/api/wishlists", undefined, undefined, 401);
  await send("/api/auth/signup", { username: "alex", password, familyCode: "wrong" }, undefined, 403);
  const alex = await signup("alex");
  const first = await send("/api/wishlists", { for: "self" }, alex, 201);
  const { id } = await first.json();
  await send("/api/wishlists", { for: "self" }, alex, 409);
  await send("/api/wishlists", { for: "other" }, alex, 400);
  const { id: other } = await (await send("/api/wishlists", { for: "other", name: "Taylor" }, alex, 201)).json();
  const { mine, lists } = await (await send("/api/wishlists", undefined, alex)).json();
  assert.equal(mine, id);
  assert.deepEqual(lists, [{ id, name: "alex" }, { id: other, name: "Taylor" }]);
  await send("/api/auth/logout", {}, alex);
  await send("/api/wishlists", undefined, alex, 401);
  await send("/api/auth/login", { username: "alex", password: "wrong" }, undefined, 401);
  await send("/api/auth/login", { username: "ALEX", password });
});

test("gift editing works and recipient responses exclude purchases and claim state", async (t) => {
  const { send, signup, db } = fixture(t);
  const [owner, buyer, observer] = await Promise.all(["Alex", "Jordan", "Sam"].map(signup));
  db.prepare("UPDATE accounts SET name = ? WHERE username = ?").run("Jordan Kim", "Jordan");
  const { id } = await (await send("/api/wishlists", { for: "self" }, owner, 201)).json();
  const path = "/api/wishlists/" + id;
  const details = { name: "", notes: "", url: "https://example.com/gift", image: "https://example.com/img.png", price: "USD 13" };
  const { id: itemId } = await (await send(path, { action: "add", ...details }, owner, 201)).json();
  await send(path, { action: "edit", itemId, name: "Puzzle" }, buyer, 403);
  const edited = { ...details, name: "Puzzle", notes: "500 pieces", price: "USD 15" };
  await send(path, { action: "edit", itemId, ...edited }, owner);
  await send(path, { action: "claim", itemId }, owner, 403);
  await send(path, { action: "claim", itemId }, buyer);
  await send(path, { action: "claim", itemId }, observer, 409);
  const { id: purchase } = await (await send(path, { action: "purchase", name: "Book" }, buyer, 201)).json();
  await send(path, { action: "remove", itemId: purchase }, owner, 404);
  const personal = await send(path, undefined, owner);
  assert.equal(personal.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual((await personal.json()).items, [{ id: itemId, ...edited }]);
  const gifts = (await (await send(path, undefined, observer)).json()).items;
  assert.equal(gifts.find((item) => item.id === itemId).claimed, 1);
  assert.equal(gifts.find((item) => item.id === itemId).claimedBy, "Jordan");
  assert.equal(gifts.find((item) => item.id === purchase).claimed, 1);
  assert.equal(gifts.find((item) => item.id === purchase).claimedBy, "Jordan");
  assert.equal(gifts.find((item) => item.id === purchase).addedBy, "Jordan Kim");
  await send(path, { action: "remove", itemId }, owner);
  assert.deepEqual((await (await send(path, undefined, owner)).json()).items, []);
});

test("Google OAuth binds state, sends the PKCE verifier, and associates a verified recipient", async (t) => {
  const calls = [];
  const { send, signup } = fixture(t, { googleId: "test-client", googleSecret: "test-secret", requestGoogle: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/token") ? { access_token: "access" } : {
      sub: "google-account", name: "Taylor", email: "taylor@gmail.com", email_verified: true,
    });
  } });
  const creator = await signup("creator");
  const { id } = await (await send("/api/wishlists", { for: "other", name: "Taylor", email: "taylor@gmail.com" }, creator, 201)).json();
  const flow = await send("/api/auth/google", { mode: "signup", familyCode });
  const next = new URL((await flow.clone().json()).url);
  const state = next.searchParams.get("state");
  assert.equal(next.searchParams.get("code_challenge_method"), "S256");
  const callback = "/auth/google/callback?code=test&state=" + state;
  await send(callback, undefined, undefined, 303);
  assert.equal(calls.length, 0);
  const oauthCookie = flow.headers.getSetCookie()[0].split(";")[0];
  const login = await send(callback, undefined, oauthCookie, 303);
  const session = login.headers.getSetCookie()[0].split(";")[0];
  assert.ok(calls[0].options.body.get("code_verifier"));
  assert.equal((await (await send("/api/wishlists", undefined, session)).json()).mine, id);
  await send(callback, undefined, oauthCookie, 303);
  assert.equal(calls.length, 2);
});

test("product preview extracts public page metadata and skips loopback targets", async () => {
  const base = "https://example.com/gift";
  const source = '<script type="application/ld+json">{"@type":"Product","image":"/gift.png","offers":{"price":"14.99","priceCurrency":"USD"}}</script>';
  assert.deepEqual(extractProduct(source, base), { image: "https://example.com/gift.png", price: "USD 14.99" });
  assert.deepEqual(extractProduct('<meta content="https://example.com/a.png?x=y&amp;z=1" property="og:image">', base),
    { image: "https://example.com/a.png?x=y&z=1", price: "" });
  assert.deepEqual(await lookupProduct("https://127.0.0.1/"), { image: "", price: "" });
});

test("Amazon lookup uses the main image and current price, including after a short-link redirect", async (t) => {
  const redirected = "https://www.amazon.com/dp/B000TEST01";
  const image = "https://m.media-amazon.com/images/I/test.jpg";
  const page = `
    <meta property="og:image" content="https://example.com/other.jpg">
    <img id="landingImage" data-a-dynamic-image='{&quot;${image}&quot;:[640,640]}'>
    <div id="related"><span class="priceToPay"><span class="a-offscreen">$7.00</span></span></div>
    <div id="corePrice_feature_div">
      <span class="a-price a-text-price"><span class="a-offscreen">$69.00</span></span>
      <div><span class="a-price priceToPay"><span class="a-offscreen">$49.99</span></span></div>
      <span class="a-price"><span class="a-offscreen">$2.50</span></span>
    </div>
  `;
  const calls = [];
  const preview = (url) => lookupProduct(url, {
    resolve: async () => ["8.8.8.8"],
    request: async (target, address) => {
      calls.push([target.href, address]);
      return target.hostname === "a.co" ? { location: redirected } : { html: page };
    },
  });
  const { send, signup } = fixture(t, { preview });
  const cookie = await signup("retailer-test");
  const result = await send("/api/product", { url: "https://a.co/example" }, cookie);
  assert.deepEqual(await result.json(), { image, price: "$49.99" });
  assert.deepEqual(calls, [["https://a.co/example", "8.8.8.8"], [redirected, "8.8.8.8"]]);
});

test("retailer metadata supports referenced offers and images and preserves missing values", () => {
  const url = "https://shop.example.com/products/gift";
  const html = `
    <meta property=og:image content="/store-logo.png">
    <script type="application/ld+json">{
      "@graph":[
        {"@type":"https://schema.org/Product","image":{"@id":"#hero"},"offers":{"@id":"#offer"}},
        {"@type":"Offer","@id":"#offer","priceSpecification":{"price":8.5,"priceCurrency":"USD"}},
        {"@type":"ImageObject","@id":"#hero","contentUrl":"/gift.jpg"}
      ]
    }</script>
  `;
  assert.deepEqual(extractProduct(html, url), { image: "https://shop.example.com/gift.jpg", price: "USD 8.5" });
  assert.deepEqual(extractProduct('<meta property="og:image" content="/gift.jpg">', url),
    { image: "https://shop.example.com/gift.jpg", price: "" });
});

test("product lookup stops before contacting a private redirect target", async () => {
  const requested = [];
  const result = await lookupProduct("https://shop.example.com/gift", {
    resolve: async (host) => [host === "shop.example.com" ? "8.8.8.8" : "10.0.0.1"],
    request: async (url) => {
      requested.push(url.hostname);
      return { location: "https://intranet.example.com/private" };
    },
  });
  assert.deepEqual(requested, ["shop.example.com"]);
  assert.deepEqual(result, { image: "", price: "" });

  const blocked = await lookupProduct("https://www.amazon.com/dp/B000TEST01", {
    resolve: async () => ["8.8.8.8"],
    request: async () => ({ status: 503 }),
  });
  assert.equal(blocked.price, "");
  assert.equal(blocked.image, "");
  assert.match(blocked.message, /still save the link/);
});
