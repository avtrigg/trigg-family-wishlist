import { Resolver } from "node:dns/promises";
import { get } from "node:https";
import { isIP } from "node:net";

export function webUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim(), base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function publicAddress(address) {
  const [first, second, third] = address.split(".").map(Number);
  return first > 0 && first < 224 && ![10, 127].includes(first) &&
    !(first === 100 && second >= 64 && second < 128) &&
    !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && (second === 168 || (second === 0 && [0, 2].includes(third)) || (second === 88 && third === 99))) &&
    !(first === 198 && ([18, 19].includes(second) || (second === 51 && third === 100))) &&
    !(first === 203 && second === 0 && third === 113);
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxPageBytes = 2_000_000;

function resolveHost(host, signal) {
  const resolver = new Resolver({ timeout: 1200, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  return resolver.resolve4(host).finally(() => signal.removeEventListener("abort", cancel));
}

function requestPage(url, address, signal) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        "User-Agent": "FamilyWishlist/1.0",
      },
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4),
    }, (response) => {
      if (redirectStatuses.has(response.statusCode)) {
        response.destroy();
        resolve({ location: response.headers.location });
        return;
      }
      if (response.statusCode !== 200 || !/html/i.test(response.headers["content-type"] ?? "")) {
        response.destroy();
        resolve({ status: response.statusCode });
        return;
      }
      const pieces = [];
      let size = 0;
      response.on("data", (piece) => {
        const remaining = maxPageBytes - size;
        pieces.push(piece.subarray(0, remaining));
        size += piece.length;
        if (size >= maxPageBytes) {
          response.destroy();
          resolve({ html: Buffer.concat(pieces).toString("utf8") });
        }
      });
      response.on("error", reject);
      response.on("end", () => resolve({ html: Buffer.concat(pieces).toString("utf8") }));
    });
    request.on("error", reject);
  });
}

const namedEntities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (!code.startsWith("#")) return namedEntities[code.toLowerCase()] ?? entity;
    const hex = code[1].toLowerCase() === "x";
    const number = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    return number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(([, key, double, single, bare]) => [key.toLowerCase(), decode(double ?? single ?? bare)]));
}

function tags(html, name) {
  return html.matchAll(new RegExp(String.raw`<(/?)${name}(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>`, "gi"));
}

function elementBody(html, name, matches) {
  let start;
  let depth = 0;
  for (const tag of tags(html, name)) {
    if (start === undefined) {
      if (!tag[1] && matches(attributes(tag[0]))) {
        start = tag.index + tag[0].length;
        depth = 1;
      }
    } else {
      depth += tag[1] ? -1 : 1;
      if (depth === 0) return html.slice(start, tag.index);
    }
  }
  return "";
}

function imageUrl(value, base) {
  const link = webUrl(value, base);
  return link.startsWith("https:") ? link : "";
}

function amazonImage(html, base) {
  for (const [tag, closing] of tags(html, "img")) {
    if (closing) continue;
    const attrs = attributes(tag);
    if (!["landingImage", "imgBlkFront"].includes(attrs.id)) continue;
    const primary = imageUrl(attrs["data-old-hires"], base);
    if (primary) return primary;
    if (attrs["data-a-dynamic-image"]) {
      try {
        const candidates = Object.keys(JSON.parse(attrs["data-a-dynamic-image"]));
        const image = candidates.map((value) => imageUrl(value, base)).find(Boolean);
        if (image) return image;
      } catch { /* Fall back to the image source. */ }
    }
    return imageUrl(attrs.src, base);
  }
  return "";
}

function hasClass(attrs, name) {
  return attrs.class?.split(/\s+/).includes(name);
}

function amazonPrice(html) {
  const scopes = ["corePriceDisplay_desktop_feature_div", "corePrice_feature_div", "corePrice_desktop", "corePrice_mobile_feature_div"];
  for (const id of scopes) {
    const scope = elementBody(html, "div", (attrs) => attrs.id === id);
    if (!scope) continue;
    const currentPrice = elementBody(scope, "span", (attrs) => hasClass(attrs, "priceToPay") || hasClass(attrs, "apexPriceToPay")) ||
      elementBody(scope, "span", (attrs) => hasClass(attrs, "a-price") &&
        !hasClass(attrs, "a-text-price") && attrs["data-a-strike"] !== "true");
    const text = elementBody(currentPrice, "span", (attrs) => hasClass(attrs, "a-offscreen"));
    const price = decode(text.replace(/<[^>]*>/g, "")).trim();
    if (price.length <= 40 && /\d/.test(price)) return price;
  }
  for (const id of ["priceblock_dealprice", "priceblock_ourprice", "priceblock_saleprice"]) {
    const price = decode(elementBody(html, "span", (attrs) => attrs.id === id).replace(/<[^>]*>/g, "")).trim();
    if (price.length <= 40 && /\d/.test(price)) return price;
  }
  return "";
}

function structuredProducts(html) {
  const nodes = [];
  for (const [, source] of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const data = JSON.parse(source);
      for (const node of [data].flat()) {
        if (node && typeof node === "object") {
          nodes.push(node);
          if (Array.isArray(node["@graph"])) nodes.push(...node["@graph"]);
        }
      }
    } catch { /* Ignore malformed retailer metadata. */ }
  }
  return nodes;
}

function standardProduct(html, base) {
  const metadata = new Map();
  for (const [tag] of tags(html, "meta")) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop)?.toLowerCase();
    if (key && attrs.content && !metadata.has(key)) metadata.set(key, attrs.content);
  }
  const nodes = structuredProducts(html);
  const byId = new Map(nodes.filter((node) => node?.["@id"]).map((node) => [node["@id"], node]));
  const dereference = (node) => byId.get(node?.["@id"]) ?? node;
  const product = nodes.find((node) => [node?.["@type"]].flat().some((type) =>
    typeof type === "string" && /(?:^|[/#])Product$/.test(type)));
  const photos = [product?.image].flat();
  const image = [...photos.map((photo) => {
    const data = dereference(photo);
    return typeof data === "string" ? data : data?.contentUrl ?? data?.url;
  }), metadata.get("og:image:secure_url"), metadata.get("og:image"), metadata.get("twitter:image"), metadata.get("image")]
    .map((value) => imageUrl(value, base)).find(Boolean) ?? "";

  const offer = [product?.offers].flat().map(dereference).find((entry) =>
    entry?.price != null || entry?.lowPrice != null || entry?.priceSpecification?.price != null);
  const amount = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price ??
    metadata.get("product:price:amount") ?? metadata.get("og:price:amount") ?? metadata.get("price");
  const currency = offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency ??
    metadata.get("product:price:currency") ?? metadata.get("og:price:currency") ?? metadata.get("pricecurrency");
  const price = (typeof amount === "number" || typeof amount === "string") && String(amount).length <= 40 ? String(amount).trim() : "";
  const prefix = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) && /^\d/.test(price) ? currency + " " : "";
  return { image, price: price ? prefix + price : "" };
}

export function extractProduct(html, base) {
  const standard = standardProduct(html, base);
  if (!/(^|\.)amazon\.(com(?:\.(?:au|be|br|mx|sg|tr))?|co\.(?:uk|jp|za)|ae|ca|de|eg|es|fr|ie|in|it|nl|pl|sa|se)$/i.test(new URL(base).hostname)) return standard;
  return { image: amazonImage(html, base) || standard.image, price: amazonPrice(html) || standard.price };
}

const blank = () => ({ image: "", price: "" });

export async function lookupProduct(value, { resolve = resolveHost, request = requestPage } = {}) {
  let link = webUrl(value);
  const signal = AbortSignal.timeout(7000);
  try {
    for (let hop = 0; link && hop <= 3; hop++) {
      signal.throwIfAborted();
      const url = new URL(link);
      const host = url.hostname;
      if (url.protocol !== "https:" || url.port || !host.includes(".") || isIP(host)) break;
      const addresses = await resolve(host, signal);
      if (!addresses.length || !addresses.every((address) => isIP(address) === 4 && publicAddress(address))) break;
      const page = await request(url, addresses[0], signal);
      if (page.html !== undefined) return extractProduct(page.html, link);
      if ([403, 429, 503].includes(page.status)) {
        return { ...blank(), message: "The retailer didn’t provide an accessible product page. You can still save the link and enter the details." };
      }
      link = webUrl(page.location, link);
    }
  } catch { /* A lookup failure should not prevent saving the URL. */ }
  return blank();
}
