import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "../application.mjs";
import { openDatabase } from "../database.mjs";
import { extractProduct, lookupProduct } from "../products.mjs";

const origin = "http://localhost:3000";
const familyCode = "private-family-test-code";
const password = "x";

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
  async function signup(username, profile = { firstName: username, lastName: "Test" }) {
    const response = await send("/api/auth/signup", { username, password, familyCode, ...profile }, undefined, 201);
    return response.headers.getSetCookie()[0].split(";")[0];
  }
  return { send, signup, db };
}

test("password accounts, optional recipient email, and one personal wishlist", async (t) => {
  const { send, signup, db } = fixture(t);
  await send("/api/wishlists", undefined, undefined, 401);
  await send("/api/auth/signup", { username: "alex", password, familyCode: "wrong" }, undefined, 403);
  await send("/api/auth/signup", { username: "alex", password: "", familyCode }, undefined, 400);
  await send("/api/auth/signup", { username: "alex", password, familyCode, firstName: "Alex" }, undefined, 400);
  const shippingAddress = "123 Test Street\nExample City, CA 94000";
  const alex = await signup("alex", { firstName: "Alex", lastName: "Rivera", shippingAddress });
  const profile = db.prepare("SELECT first_name, last_name, shipping_address FROM accounts WHERE username = ?").get("alex");
  assert.deepEqual({ ...profile }, { first_name: "Alex", last_name: "Rivera", shipping_address: shippingAddress });
  const first = await send("/api/wishlists", { for: "self" }, alex, 201);
  const { id } = await first.json();
  await send("/api/wishlists", { for: "self" }, alex, 409);
  await send("/api/wishlists", { for: "other" }, alex, 400);
  const { id: other } = await (await send("/api/wishlists", { for: "other", name: "Taylor" }, alex, 201)).json();
  const { mine, lists } = await (await send("/api/wishlists", undefined, alex)).json();
  assert.equal(mine, id);
  assert.deepEqual(lists, [
    { id, name: "Alex Rivera", itemCount: 0, hasOwner: true },
    { id: other, name: "Taylor", itemCount: 0, hasOwner: false },
  ]);
  await send("/api/auth/logout", {}, alex);
  await send("/api/wishlists", undefined, alex, 401);
  await send("/api/auth/login", { username: "alex", password: "wrong" }, undefined, 401);
  await send("/api/auth/login", { username: "ALEX", password });
});

test("linking an unowned wishlist keeps its gifts and respects existing ownership", async (t) => {
  const { send, signup } = fixture(t);
  const creator = await signup("creator");
  const recipient = await signup("recipient");
  const { id } = await (await send("/api/wishlists", { for: "other", name: "Recipient" }, creator, 201)).json();
  const { id: other } = await (await send("/api/wishlists", { for: "other", name: "Another recipient" }, creator, 201)).json();
  const { id: reserved } = await (await send("/api/wishlists", {
    for: "other", name: "Reserved", email: "reserved@example.com",
  }, creator, 201)).json();
  const path = "/api/wishlists/" + id;
  const link = { action: "link-wishlist" };
  assert.equal((await (await send(path, undefined, recipient)).json()).hasOwner, false);
  await send("/api/wishlists/" + reserved, link, recipient, 403);
  await send(path, link, undefined, 401);
  await send(path, { action: "add", name: "Puzzle" }, creator, 201);
  await send(path, { action: "purchase", name: "Surprise" }, creator, 201);
  await send(path, link, recipient);
  await send(path, link, recipient);
  await send(path, link, creator, 409);
  await send("/api/wishlists/" + other, link, recipient, 409);
  await send(path, { action: "add", name: "Another gift" }, creator, 403);
  const personal = await (await send(path, undefined, recipient)).json();
  assert.equal(personal.isOwner, true);
  assert.equal(personal.hasOwner, true);
  assert.deepEqual(personal.items.map((item) => item.name), ["Puzzle"]);
  const home = await (await send("/api/wishlists", undefined, recipient)).json();
  assert.equal(home.mine, id);
  assert.deepEqual(home.lists.find((list) => list.id === id), { id, name: "Recipient", itemCount: 1, hasOwner: true });
});

test("gift editing works and recipient responses exclude purchases and claim state", async (t) => {
  const { send, signup, db } = fixture(t);
  const [owner, buyer, observer] = await Promise.all([
    signup("Alex"),
    signup("Jordan", { firstName: "Jordan", lastName: "Kim" }),
    signup("Sam"),
  ]);
  assert.equal(db.prepare("SELECT shipping_address FROM accounts WHERE username = ?").get("Jordan").shipping_address, null);
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
  const ownerHome = await (await send("/api/wishlists", undefined, owner)).json();
  const observerHome = await (await send("/api/wishlists", undefined, observer)).json();
  assert.equal(ownerHome.lists.find((list) => list.id === id).itemCount, 1);
  assert.equal(observerHome.lists.find((list) => list.id === id).itemCount, 2);
  await send(path, { action: "remove", itemId }, owner);
  assert.deepEqual((await (await send(path, undefined, owner)).json()).items, []);
});

test("Google OAuth binds state, sends the PKCE verifier, and associates a verified recipient", async (t) => {
  const calls = [];
  const { send, signup, db } = fixture(t, { googleId: "test-client", googleSecret: "test-secret", requestGoogle: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/token") ? { access_token: "access" } : {
      sub: "google-account", name: "Taylor", email: "taylor@gmail.com", email_verified: true,
    });
  } });
  const creator = await signup("creator");
  const { id } = await (await send("/api/wishlists", { for: "other", name: "Taylor", email: "taylor@gmail.com" }, creator, 201)).json();
  await send("/api/auth/google", { mode: "signup", familyCode, firstName: "Taylor" }, undefined, 400);
  const shippingAddress = "456 Test Avenue";
  const flow = await send("/api/auth/google", { mode: "signup", familyCode, firstName: "Taylor", lastName: "Reed", shippingAddress });
  const next = new URL((await flow.clone().json()).url);
  const state = next.searchParams.get("state");
  assert.equal(next.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!next.href.includes("Taylor") && !next.href.includes("456"));
  const callback = "/auth/google/callback?code=test&state=" + state;
  await send(callback, undefined, undefined, 303);
  assert.equal(calls.length, 0);
  const oauthCookie = flow.headers.getSetCookie()[0].split(";")[0];
  const login = await send(callback, undefined, oauthCookie, 303);
  const session = login.headers.getSetCookie()[0].split(";")[0];
  assert.ok(calls[0].options.body.get("code_verifier"));
  assert.deepEqual({ ...db.prepare("SELECT first_name, last_name, shipping_address FROM accounts WHERE google_sub = ?").get("google-account") }, {
    first_name: "Taylor", last_name: "Reed", shipping_address: shippingAddress,
  });
  assert.deepEqual((await (await send("/api/account", undefined, session)).json()).user.name, "Taylor Reed");
  assert.ok(!(await (await send("/api/account", undefined, session)).text()).includes(shippingAddress));
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

test("Amazon lookup recovers earlier results for the same account and product", async (t) => {
  const image = "https://example.com/amazon.jpg";
  let online = true;
  const { send, signup } = fixture(t, { preview: async () =>
    online ? { image, price: "$15" } : { image: "", price: "" },
  });
  const owner = await signup("cache-owner");
  const other = await signup("cache-other");
  const lookup = (url, cookie) => send("/api/product", { url }, cookie).then((response) => response.json());
  const link = (asin) => "https://www.amazon.com/dp/" + asin;
  const cachedAsin = "B000TEST01";
  const savedAsin = "B000TEST02";
  assert.deepEqual(await lookup(link(cachedAsin), owner), { image, price: "$15" });
  const { id } = await (await send("/api/wishlists", { for: "self" }, owner, 201)).json();
  await send("/api/wishlists/" + id, { action: "add", url: link(savedAsin), name: "Gift", image, price: "$20" }, owner, 201);

  online = false;
  for (const [asin, price] of [[cachedAsin, "$15"], [savedAsin, "$20"]]) {
    const alternate = "https://amazon.com/gp/product/" + asin + "?tag=example";
    const result = await lookup(alternate, owner);
    assert.equal(result.image, image);
    assert.equal(result.price, price);
    assert.match(result.message, /reused saved/i);
    assert.deepEqual(await lookup(alternate, other), { image: "", price: "" });
  }
});

test("Amazon failures log the stage and safe response details", async () => {
  const lines = [];
  const options = { resolve: async () => ["8.8.8.8"], warn: (line) => lines.push(line) };
  const url = "https://www.amazon.com/dp/B000TEST01?tag=private-query";
  await lookupProduct(url, { ...options, resolve: async () => {
    throw Object.assign(new Error("private diagnostic payload"), { code: "ENOTFOUND" });
  } });
  await lookupProduct(url, { ...options, request: async () => ({ status: 503 }) });
  await lookupProduct("https://a.co/private-token", {
    ...options,
    request: async (target) => target.hostname === "a.co"
      ? { status: 302, location: url }
      : { status: 200, html: "<html></html>", bytes: 13, contentType: "text/html", encoding: "identity" },
  });
  assert.equal(lines.length, 3);
  const [dns, http, page] = lines.map((line) => {
    assert.match(line, /^\[amazon-lookup\] /);
    assert.doesNotMatch(line, /private-query|private-token|private diagnostic payload/);
    return JSON.parse(line.slice("[amazon-lookup] ".length));
  });
  assert.equal(dns.reason, "dns_error");
  assert.equal(dns.code, "ENOTFOUND");
  assert.equal(http.reason, "http_error");
  assert.equal(http.status, 503);
  assert.equal(page.reason, "missing_product_details");
  assert.equal(page.originHost, "a.co");
  assert.equal(page.host, "www.amazon.com");
  assert.equal(page.redirects, 1);
  assert.equal(page.bytes, 13);
  assert.deepEqual(page.missing, ["image", "price"]);
});

test("configured Amazon proxy handles the short link and marketplace but not unrelated redirect targets", async () => {
  const proxied = [];
  const resolved = [];
  const options = {
    proxyRequest: async (url) => {
      proxied.push(url.hostname);
      return url.hostname === "a.co"
        ? { status: 302, location: "https://www.amazon.com/dp/B000TEST01" }
        : { status: 302, location: "https://intranet.example.com/private" };
    },
    resolve: async (host) => { resolved.push(host); return ["10.0.0.1"]; },
    request: async () => assert.fail("Private redirect should not be requested"),
    warn: () => {},
  };
  assert.deepEqual(await lookupProduct("https://a.co/example", options), { image: "", price: "" });
  assert.deepEqual(proxied, ["a.co", "www.amazon.com"]);
  assert.deepEqual(resolved, ["intranet.example.com"]);
});

test("an Amazon verification page is reported instead of treated as a product page", async () => {
  const logs = [];
  const result = await lookupProduct("https://www.amazon.com/dp/B000TEST01", {
    proxyRequest: async () => ({ status: 200, html: '<form action="/errors/validateCaptcha"></form>' }),
    warn: (line) => logs.push(line),
  });
  assert.equal(result.image, "");
  assert.equal(result.price, "");
  assert.match(result.message, /verification page/);
  assert.match(logs[0], /amazon_verification_page/);
});

test("a path prefix scopes session cookies and Google redirects", async (t) => {
  const requestGoogle = async () => { throw new Error("not called"); };
  const { send } = fixture(t, { base: "/wishlist", googleId: "id", googleSecret: "secret", requestGoogle });
  const signup = await send("/api/auth/signup", { username: "pat", password, familyCode, firstName: "Pat", lastName: "Test" }, undefined, 201);
  assert.match(signup.headers.getSetCookie()[0], /; Path=\/wishlist;/);
  const google = await send("/api/auth/google", { familyCode });
  const redirect = new URL((await google.json()).url ?? google.headers.get("location"));
  assert.equal(redirect.searchParams.get("redirect_uri"), origin + "/wishlist/auth/google/callback");
  const failed = await send("/auth/google/callback?error=denied", undefined, undefined, 303);
  assert.match(failed.headers.get("location"), /^http:\/\/localhost:3000\/wishlist\/\?auth=/);
});
