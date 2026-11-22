import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { readProductPage, wishlistImportUrl } from "../chrome-extension/product.mjs";

function capture(url, fixtures = {}, scripts = [], lang = "en-US") {
  const document = {
    title: "Example retailer",
    documentElement: { lang },
    querySelector: (selector) => Object.entries(fixtures).find(([key]) => selector.includes(key))?.[1] ?? null,
    querySelectorAll: (selector) => selector.startsWith("script")
      ? scripts.map((script) => ({ textContent: JSON.stringify(script) }))
      : [fixtures[selector]].flat().filter(Boolean),
  };
  return JSON.parse(JSON.stringify(runInNewContext("(" + readProductPage.toString() + ")()", {
    document, location: new URL(url), URL, Intl,
  })));
}

function priceNode(offscreen, options = {}) {
  const parts = {
    ".a-offscreen": offscreen == null ? null : { textContent: offscreen },
    ".a-price-whole": options.whole ? {
      textContent: options.whole,
      compareDocumentPosition: () => options.trailingCurrency ? 4 : 2,
    } : null,
    ".a-price-fraction": options.fraction ? { textContent: options.fraction } : null,
    ".a-price-symbol": options.symbol ? { textContent: options.symbol } : null,
    ".a-price-decimal": options.decimal ? { textContent: options.decimal } : null,
  };
  return {
    querySelector: (selector) => parts[selector] ?? null,
    closest: () => options.excluded ? {} : null,
    checkVisibility: () => !options.hidden,
  };
}

function section({ current = [], generic = [] }) {
  return { querySelectorAll: (selector) => selector === ".a-price" ? generic : current };
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
    "#corePriceDisplay_desktop_feature_div": section({ current: [priceNode("$15.37")] }),
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
  const prefixed = new URL(wishlistImportUrl("https://host.example/wishlist", product));
  assert.equal(prefixed.origin + prefixed.pathname, "https://host.example/wishlist/");
});

test("Amazon capture prefers a current price and skips hidden, list, unit, and subscription prices", () => {
  const product = capture("https://www.amazon.com/dp/B09V12JBQN", {
    "#corePriceDisplay_desktop_feature_div": [
      section({ current: [priceNode("$80.00", { hidden: true })] }),
      section({ generic: [priceNode("$100.00", { excluded: true }), priceNode("$0.98", { excluded: true })] }),
    ],
    "#apex_desktop": section({ current: [
      priceNode("$12.03", { excluded: true }),
      priceNode(null, { whole: "15.", fraction: "37", symbol: "$" }),
    ] }),
  });
  assert.equal(product.price, "$15.37");
});

test("Amazon capture recovers a missing decimal from the split localized price", () => {
  const product = capture("https://www.amazon.de/dp/B09V12JBQN", {
    "#corePriceDisplay_mobile_feature_div": section({ current: [
      priceNode("1537 €", { whole: "15", fraction: "37", symbol: "€", trailingCurrency: true }),
    ] }),
  }, [], "de-DE");
  assert.equal(product.price, "15,37 €");
});

test("Amazon capture reads an unmarked buy-box price without treating other page prices as the product", () => {
  const url = "https://www.amazon.com/dp/B09V12JBQN";
  const available = capture(url, {
    "#corePrice_feature_div": section({
      generic: [priceNode("$52.00", { excluded: true }), priceNode("$28.49")],
    }),
  });
  const unavailable = capture(url, {
    "#corePrice_feature_div": section({ generic: [priceNode("$52.00", { excluded: true })] }),
    "#relatedItems": section({ generic: [priceNode("$15.99")] }),
  });
  assert.equal(available.price, "$28.49");
  assert.equal(unavailable.price, "");
});
