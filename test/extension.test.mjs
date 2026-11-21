import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readProductPage, wishlistImportUrl } from "../chrome-extension/product.mjs";

function capture(url, fixtures = {}, scripts = []) {
  const document = {
    title: "Example retailer",
    documentElement: { lang: "en-US" },
    querySelector: (selector) => Object.entries(fixtures).find(([key]) => selector.includes(key))?.[1] ?? null,
    querySelectorAll: () => scripts.map((script) => ({ textContent: JSON.stringify(script) })),
  };
  return JSON.parse(JSON.stringify(runInNewContext("(" + readProductPage.toString() + ")()", {
    document, location: new URL(url), URL, Intl,
  })));
}

test("the serialized Chrome extractor reads the selected Amazon product from the visible page", () => {
  const attrs = {
    "data-a-dynamic-image": JSON.stringify({
      "https://images.example/small.jpg": [120, 120],
      "https://images.example/large.jpg": [1500, 1400],
    }),
  };
  const product = capture("https://www.amazon.com/example/dp/B09V12JBQN?th=1#details", {
    "#productTitle": { textContent: "  Stainless   steel wire  " },
    ".priceToPay .a-offscreen": { textContent: "$15.37" },
    "#landingImage": { getAttribute: (name) => attrs[name] ?? null },
  });
  assert.deepEqual(product, {
    name: "Stainless steel wire", price: "$15.37", image: "https://images.example/large.jpg",
    url: "https://www.amazon.com/example/dp/B09V12JBQN?th=1",
  });
});

test("generic product extraction uses linked structured metadata and leaves absent prices blank", () => {
  const product = capture("https://shop.example/products/item", {}, [{
    "@graph": [
      { "@type": "Product", name: "Gift", image: { "@id": "#photo" }, offers: { "@id": "#offer" } },
      { "@type": "Offer", "@id": "#offer", price: 21, priceCurrency: "USD" },
      { "@type": "ImageObject", "@id": "#photo", contentUrl: "/gift.jpg" },
    ],
  }]);
  assert.equal(product.name, "Gift");
  assert.equal(product.price, "$21.00");
  assert.equal(product.image, "https://shop.example/gift.jpg");
  assert.equal(capture("https://shop.example/products/item").price, "");
});

test("extension adds only temporary page access and passes an encoded draft to the selected wishlist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../chrome-extension/manifest.json", import.meta.url)));
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  const product = { name: "Tea & mugs", price: "$17.50", url: "https://shop.example/a?color=blue&size=s", image: "" };
  const target = new URL(wishlistImportUrl("http://localhost:3000", product));
  assert.equal(target.origin, "http://localhost:3000");
  assert.equal(target.search, "");
  assert.deepEqual(JSON.parse(new URLSearchParams(target.hash.slice(1)).get("import")), product);
  assert.throws(() => wishlistImportUrl("http://remote.example", product));
  assert.throws(() => wishlistImportUrl("https://host.example/another-page", product));
});
