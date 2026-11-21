import { readProductPage, wishlistImportUrl } from "./product.mjs";

const defaultAddress = "http://localhost:3000";
const address = document.querySelector("#address");
const button = document.querySelector("#open-wishlist");
const status = document.querySelector("#status");
let product;

async function initialize() {
  const { wishlistAddress } = await chrome.storage.local.get("wishlistAddress");
  address.value = wishlistAddress || defaultAddress;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url ?? "")) {
      status.textContent = "Open a product page in this tab first.";
      return;
    }
    const [capture] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readProductPage });
    product = capture?.result;
    if (!product?.url) throw new Error("No product URL found.");
    document.querySelector("#item-name").textContent = product.name || new URL(product.url).hostname;
    document.querySelector("#price").textContent = product.price;
    const image = document.querySelector("#image");
    if (product.image) {
      image.addEventListener("error", () => { image.hidden = true; }, { once: true });
      image.hidden = false;
      image.src = product.image;
    }
    document.querySelector("#product").hidden = false;
    status.textContent = product.price && product.image ? "Review the details in your wishlist before saving."
      : "Some details were unavailable. You can fill them in before saving.";
    button.disabled = false;
  } catch {
    status.textContent = "Chrome couldn’t read this page. Open a product page and try again.";
  }
}

document.querySelector("#share").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!product) return;
  button.disabled = true;
  try {
    const destination = wishlistImportUrl(address.value, product);
    await chrome.storage.local.set({ wishlistAddress: new URL(destination).origin });
    await chrome.tabs.create({ url: destination });
  } catch (error) {
    document.querySelector("#settings").open = true;
    status.textContent = error.message || "Couldn’t open the wishlist.";
    button.disabled = false;
  }
});

void initialize().catch(() => { status.textContent = "Couldn’t open the extension. Try again."; });
