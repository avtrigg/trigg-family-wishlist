import { execFile } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { Agent, get } from "node:https";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

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
const execFileAsync = promisify(execFile);
const decoders = new Map([
  ["gzip", createGunzip],
  ["deflate", createInflate],
  ["br", createBrotliDecompress],
]);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const amazonProxyAgent = (nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 5)) &&
  (process.env.https_proxy || process.env.HTTPS_PROXY) ? new Agent({ proxyEnv: process.env }) : null;

function resolveHost(host, signal) {
  const resolver = new Resolver({ timeout: 1200, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  return resolver.resolve4(host).finally(() => signal.removeEventListener("abort", cancel));
}

function requestPage(url, address, signal, agent = false) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent, signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": "FamilyWishlist/1.0",
      },
      ...(address && { lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4) }),
    }, (response) => {
      const status = response.statusCode;
      const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase() || "identity";
      const responseInfo = {
        status,
        contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : "unknown",
        encoding: /^[a-z0-9-]{1,20}$/.test(encoding) ? encoding : "unknown",
      };
      if (redirectStatuses.has(status)) {
        response.destroy();
        resolve({ ...responseInfo, location: response.headers.location });
        return;
      }
      if (status !== 200 || !/html/i.test(mime)) {
        response.destroy();
        resolve(responseInfo);
        return;
      }
      const decodeBody = decoders.get(encoding);
      if (encoding !== "identity" && !decodeBody) {
        response.destroy();
        resolve({ ...responseInfo, unsupportedEncoding: true });
        return;
      }
      const decoder = decodeBody?.();
      const body = decoder ? response.pipe(decoder) : response;
      if (decoder) decoder.on("error", (error) => { response.destroy(); reject(error); });
      response.on("error", (error) => { decoder?.destroy(); reject(error); });
      const pieces = [];
      let size = 0;
      body.on("data", (piece) => {
        const remaining = maxPageBytes - size;
        pieces.push(piece.subarray(0, remaining));
        size += piece.length;
        if (size >= maxPageBytes) {
          response.destroy();
          decoder?.destroy();
          resolve({ ...responseInfo, html: Buffer.concat(pieces).toString("utf8"), bytes: maxPageBytes, truncated: true });
        }
      });
      body.on("end", () => resolve({ ...responseInfo, html: Buffer.concat(pieces).toString("utf8"), bytes: size }));
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

const amazonStore = /(^|\.)amazon\.(com(?:\.(?:au|be|br|mx|sg|tr))?|co\.(?:uk|jp|za)|ae|ca|de|eg|es|fr|ie|in|it|nl|pl|sa|se)$/i;

function isAmazonShortHost(host) {
  return host === "a.co" || host === "amzn.to";
}

function isAmazonProxyHost(host) {
  const marketplace = host.replace(/^(?:www|m|smile)\./, "");
  return isAmazonShortHost(host) || (marketplace.startsWith("amazon.") && amazonStore.test(marketplace));
}

export function amazonProductKey(value) {
  const link = webUrl(value);
  if (!link) return "";
  const url = new URL(link);
  const host = url.hostname.toLowerCase();
  if (isAmazonShortHost(host)) return host + url.pathname.replace(/\/$/, "");
  if (!amazonStore.test(host)) return "";
  const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/i)?.[1];
  return asin ? host.replace(/^(?:www|m|smile)\./, "") + "/" + asin.toUpperCase() : "";
}

export function extractProduct(html, base) {
  const standard = standardProduct(html, base);
  if (!amazonStore.test(new URL(base).hostname)) return standard;
  return { image: amazonImage(html, base) || standard.image, price: amazonPrice(html) || standard.price };
}

const blank = () => ({ image: "", price: "" });

async function requestAmazonThroughProxy(url, signal) {
  // Redirects are handled by lookupProduct so that every target passes its own checks.
  let result;
  try {
    result = await execFileAsync("curl", [
      "--http2", "--compressed", "--globoff", "--silent", "--show-error",
      "--no-location", "--no-location-trusted", "--max-redirs", "0", "--no-insecure", "--no-proxy-insecure",
      "--proto", "=https", "--max-time", "6", "--max-filesize", String(maxPageBytes),
      "--user-agent", "FamilyWishlist/1.0", "--header", "Accept: text/html,application/xhtml+xml",
      "--write-out", "\n%{json}", "--url", url.href,
    ], { signal, maxBuffer: maxPageBytes + 65_536, encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === 2) return requestPage(url, null, signal, amazonProxyAgent);
    if (Number.isInteger(error.code)) throw Object.assign(new Error("curl request failed"), { code: "CURL_" + error.code });
    throw error;
  }
  const split = result.stdout.lastIndexOf("\n");
  const { http_code: status, redirect_url: location, content_type: mime } = JSON.parse(result.stdout.slice(split + 1));
  const mediaType = mime?.split(";")[0].trim().toLowerCase() ?? "";
  const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType) ? mediaType : "unknown";
  const response = { status, contentType };
  if (redirectStatuses.has(status)) return { ...response, location };
  if (status !== 200 || !/html/i.test(contentType)) return response;
  const html = result.stdout.slice(0, split);
  return { ...response, html, bytes: Buffer.byteLength(html) };
}

const defaultProxyRequest = amazonProxyAgent && requestAmazonThroughProxy;

export async function lookupProduct(value, {
  resolve = resolveHost, request = requestPage, warn = console.warn,
  proxyRequest = resolve === resolveHost && request === requestPage ? defaultProxyRequest : null,
} = {}) {
  let link = webUrl(value);
  if (!link) return blank();
  const originHost = new URL(link).hostname;
  let host = originHost;
  let isAmazon = isAmazonShortHost(host) || amazonStore.test(host);
  let redirects = 0;
  let stage = "url";
  let transport = "direct";
  const started = Date.now();
  const signal = AbortSignal.timeout(7000);

  function logFailure(reason, fields = {}) {
    if (isAmazon) {
      warn("[amazon-lookup] " + JSON.stringify({
        reason, stage, transport, originHost, host, redirects, elapsedMs: Date.now() - started, ...fields,
      }));
    }
    return blank();
  }

  try {
    while (redirects <= 3) {
      stage = "url";
      signal.throwIfAborted();
      const url = new URL(link);
      host = url.hostname;
      isAmazon ||= isAmazonShortHost(host) || amazonStore.test(host);
      if (url.protocol !== "https:" || url.port || !host.includes(".") || isIP(host)) {
        return logFailure("unsupported_target");
      }
      const useProxy = proxyRequest && isAmazonProxyHost(host);
      transport = useProxy ? "configured_proxy" : "direct";
      let address;
      if (!useProxy) {
        stage = "dns";
        const addresses = await resolve(host, signal);
        if (!addresses.length) return logFailure("no_ipv4_addresses");
        if (!addresses.every((address) => isIP(address) === 4 && publicAddress(address))) {
          return logFailure("non_public_dns_address");
        }
        address = addresses[0];
      }

      stage = "request";
      const page = useProxy ? await proxyRequest(url, signal) : await request(url, address, signal);
      const { html, location, status, contentType, encoding, bytes, truncated } = page;
      const response = { status, contentType, encoding, bytes, truncated };
      if (page.unsupportedEncoding) return logFailure("unsupported_content_encoding", response);
      if (html !== undefined) {
        stage = "parse";
        const product = extractProduct(html, link);
        const missing = ["image", "price"].filter((field) => !product[field]);
        if (isAmazon && missing.length === 2 &&
            /validateCaptcha|<title>\s*Robot Check\s*<\/title>|to discuss automated access/i.test(html)) {
          return { ...logFailure("amazon_verification_page", { ...response, missing }),
            message: "Amazon returned a verification page. You can import a saved product page or save the link by itself." };
        }
        if (missing.length) logFailure("missing_product_details", { ...response, missing });
        return product;
      }
      if ([403, 429, 503].includes(response.status)) {
        return { ...logFailure("http_error", response),
          message: "The retailer didn’t provide an accessible product page. You can still save the link and enter the details." };
      }
      if (!location && !redirectStatuses.has(response.status)) {
        return logFailure(response.status === 200 ? "unexpected_content_type" : "http_error", response);
      }

      stage = "redirect";
      link = webUrl(location, link);
      if (!link) return logFailure("invalid_redirect", response);
      redirects++;
    }
    return logFailure("redirect_limit");
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
    return logFailure(signal.aborted ? "timeout" : stage + "_error", { code });
  }
}
