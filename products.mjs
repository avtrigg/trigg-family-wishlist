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

async function download(url) {
  const host = url.hostname;
  if (!host.includes(".") || isIP(host) || url.port || url.protocol !== "https:") return "";
  const resolver = new Resolver({ timeout: 1200, tries: 2 });
  const addresses = await resolver.resolve4(host);
  if (!addresses.length || !addresses.every(publicAddress)) return "";
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false,
      signal: AbortSignal.timeout(4500),
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "FamilyWishlist/1.0" },
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address: addresses[0], family: 4 }])
        : callback(null, addresses[0], 4),
    }, (response) => {
      if (response.statusCode !== 200 || !/html/i.test(response.headers["content-type"] ?? "")) {
        response.destroy();
        resolve("");
        return;
      }
      const pieces = [];
      let size = 0;
      response.on("data", (piece) => {
        size += piece.length;
        if (size > 768_000) { response.destroy(); resolve(Buffer.concat(pieces).toString("utf8")); }
        else pieces.push(piece);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(pieces).toString("utf8")));
    });
    request.on("error", reject);
  });
}

function decode(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39);/g, (entity) => ({
    "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'",
  })[entity]);
}

export function extractProduct(html, base) {
  const metadata = new Map();
  for (const [tag] of html.matchAll(/<meta\s+(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const values = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(([, key, double, single, bare]) => [key.toLowerCase(), decode(double ?? single ?? bare)]));
    const key = values.property ?? values.name ?? values.itemprop;
    if (key && values.content && !metadata.has(key.toLowerCase())) metadata.set(key.toLowerCase(), values.content);
  }
  let image = metadata.get("og:image:secure_url") ?? metadata.get("og:image") ?? metadata.get("twitter:image");
  let amount = metadata.get("product:price:amount") ?? metadata.get("og:price:amount") ?? metadata.get("price");
  let currency = metadata.get("product:price:currency") ?? metadata.get("og:price:currency") ?? metadata.get("pricecurrency");
  for (const [, source] of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const document = JSON.parse(source);
      const nodes = Array.isArray(document) ? document : [document, ...(Array.isArray(document?.["@graph"]) ? document["@graph"] : [])];
      const product = nodes.find((node) => [node?.["@type"]].flat().includes("Product"));
      if (!product) continue;
      const photo = [product.image].flat()[0];
      const offer = [product.offers].flat()[0];
      image ||= typeof photo === "string" ? photo : photo?.url;
      amount ??= offer?.price ?? offer?.lowPrice;
      currency ??= offer?.priceCurrency;
      break;
    } catch { continue; }
  }
  const safeImage = webUrl(image, base);
  const price = (typeof amount === "number" || typeof amount === "string") && String(amount).length < 30 ? String(amount).trim() : "";
  const prefix = typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency + " " : "";
  return { image: safeImage.startsWith("https:") ? safeImage : "", price: price ? prefix + price : "" };
}

export async function lookupProduct(value) {
  const link = webUrl(value);
  if (!link) return { image: "", price: "" };
  try { return extractProduct(await download(new URL(link)), link); }
  catch { return { image: "", price: "" }; }
}
