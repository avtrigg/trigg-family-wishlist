// Chrome serializes this function when it runs it in the active tab.
export function readProductPage() {
  function clean(value, max = 240) {
    return (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "").slice(0, max);
  }

  function webUrl(value, httpsOnly = false) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) return "";
    try {
      const url = new URL(value, location.href);
      if (url.username || url.password) return "";
      if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) return "";
      return url.href;
    } catch { return ""; }
  }

  function meta(...keys) {
    for (const key of keys) {
      const node = document.querySelector('meta[property="' + key + '"], meta[name="' + key + '"], meta[itemprop="' + key + '"]');
      if (node?.content) return node.content;
    }
    return "";
  }

  const nodes = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > 1_000_000) continue;
    try {
      for (const entry of [JSON.parse(script.textContent)].flat()) {
        nodes.push(entry, ...[entry?.mainEntity].flat());
        if (Array.isArray(entry?.["@graph"])) nodes.push(...entry["@graph"]);
      }
    } catch { continue; }
  }
  const byId = new Map(nodes.filter((node) => node?.["@id"]).map((node) => [node["@id"], node]));
  const reference = (node) => byId.get(node?.["@id"]) ?? node;
  const product = nodes.map(reference).find((node) => [node?.["@type"]].flat().some((type) =>
    typeof type === "string" && /(?:^|[/#])Product$/.test(type)));

  const offer = [product?.offers].flat().map(reference).find((entry) =>
    entry?.price != null || entry?.lowPrice != null || entry?.priceSpecification?.price != null);

  let amazonName = "";
  let amazonPrice = "";
  const amazonImages = [];
  if (/(^|\.)amazon\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2})$/i.test(location.hostname)) {
    amazonName = document.querySelector("#productTitle")?.textContent;
    amazonPrice = document.querySelector(
      "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, " +
      "#corePrice_feature_div .priceToPay .a-offscreen, #corePrice_desktop .priceToPay .a-offscreen, " +
      "#corePrice_mobile_feature_div .apexPriceToPay .a-offscreen, " +
      "#priceblock_dealprice, #priceblock_ourprice, #priceblock_saleprice"
    )?.textContent;
    const mainImage = document.querySelector("#landingImage, #imgBlkFront, #ebooksImgBlkFront");
    if (mainImage) {
      amazonImages.push(mainImage.getAttribute("data-old-hires"));
      try {
        const variants = Object.entries(JSON.parse(mainImage.getAttribute("data-a-dynamic-image") || "{}"));
        variants.sort((a, b) => (Number(b[1]?.[0]) || 0) - (Number(a[1]?.[0]) || 0));
        for (const [src] of variants) amazonImages.push(src);
      } catch {}
      amazonImages.push(mainImage.currentSrc, mainImage.getAttribute("src"));
    }
  }

  const name = [amazonName, product?.name, meta("og:title", "twitter:title"),
    document.querySelector("h1")?.textContent, document.title].map((value) => clean(value)).find(Boolean) ?? "";
  const productImages = [product?.image].flat().map((entry) => {
    const photo = reference(entry);
    return typeof photo === "string" ? photo : photo?.contentUrl ?? photo?.url;
  });
  const image = [...amazonImages, ...productImages, meta("og:image:secure_url"), meta("og:image", "twitter:image", "image")]
    .map((value) => webUrl(value, true)).find(Boolean) ?? "";
  const rawAmount = offer?.price ?? offer?.lowPrice ?? offer?.priceSpecification?.price ??
    meta("product:price:amount", "og:price:amount", "price");
  const rawCurrency = offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency ??
    meta("product:price:currency", "og:price:currency", "priceCurrency");
  let price = clean(amazonPrice, 48);
  if (!/\d/.test(price)) {
    const amount = clean(typeof rawAmount === "number" ? String(rawAmount) : rawAmount, 40);
    const currency = clean(rawCurrency, 3).toUpperCase();
    price = /\d/.test(amount) ? amount : "";
    if (/^\d+(?:\.\d+)?$/.test(amount) && /^[A-Z]{3}$/.test(currency)) {
      try { price = Intl.NumberFormat(document.documentElement.lang || "en", { style: "currency", currency }).format(Number(amount)); }
      catch { price = currency + " " + amount; }
    }
  }

  const url = new URL(location.href);
  url.hash = "";
  return { name, price, image, url: webUrl(url.href) };
}

export function wishlistImportUrl(address, product) {
  const target = new URL(address.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !(local && target.protocol === "http:")) ||
      target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Enter the wishlist homepage address, such as http://localhost:3000.");
  }
  target.hash = new URLSearchParams({ import: JSON.stringify(product) }).toString();
  return target.href;
}
