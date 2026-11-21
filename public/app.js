const app = document.querySelector("#app");
const editor = document.querySelector("#editor");
const signOut = document.querySelector("#sign-out");
let account;
let authMode = "login";
let wishlist;
let navigation;
let saving = false;
let lookupTimer;
let productLookup;
let extensionDraft;
const extensionDraftKey = "wishlist-extension-draft";

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

const giftArt = '<div class="hero-art" aria-hidden="true"><div class="halo"></div><span class="spark spark-one">✦</span>' +
  '<span class="spark spark-two">✧</span><span class="spark spark-three">✦</span><div class="parcel parcel-back"><i></i><b></b></div>' +
  '<div class="parcel parcel-front"><i></i><b></b></div></div>';

function hero(title, description) {
  return '<section class="hero"><div class="hero-text"><h1>' + title + '</h1><p>' + description + '</p></div>' + giftArt + '</section>';
}

async function api(route, data, signal) {
  const response = await fetch("/api/" + route, {
    cache: "no-store", signal,
    ...(data && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error || "Couldn’t connect. Please try again.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function notice(target, message) {
  const alert = target?.querySelector("[data-error]");
  if (alert) { alert.textContent = message; alert.hidden = !message; }
}

const alertRegion = '<p class="inline-error" data-error role="alert" hidden></p>';

function authPage(message = "") {
  const signup = authMode === "signup";
  const label = signup ? "Create account" : "Sign in";
  const code = signup && account.requiresCode
    ? '<label>Family access code<input name="familyCode" type="password" required></label>' : "";
  const profile = signup
    ? '<div class="name-fields"><label>First name<input name="firstName" autocomplete="given-name" required maxlength="80"></label>' +
      '<label>Last name<input name="lastName" autocomplete="family-name" required maxlength="80"></label></div>' +
      '<label>Shipping address <span class="field-help">(optional)</span>' +
      '<textarea name="shippingAddress" autocomplete="street-address" rows="3" maxlength="1000"></textarea></label>'
    : "";
  const google = '<button class="small-button google-button" type="button" data-action="google"' +
    (account.google ? "" : " disabled") + '><span aria-hidden="true" class="google-symbol">G</span>' +
    (signup ? "Create account with Google" : "Sign in with Google") + '</button>' +
    (account.google ? "" : '<p class="field-help google-help">Google sign-in is awaiting setup.</p>');
  app.innerHTML = hero("Family wishlists", "Find gift ideas for the people you love.") +
    '<section class="panel auth-panel"><div class="auth-tabs" aria-label="Account options">' +
    '<button type="button" data-action="login" aria-pressed="' + !signup + '">Sign in</button>' +
    '<button type="button" data-action="signup" aria-pressed="' + signup + '">Create account</button></div>' +
    '<form id="auth-form"><h2>' + (signup ? "Create your account" : "Welcome back") + '</h2>' +
    profile + '<label>Username<input name="username" autocomplete="username" required maxlength="32"></label>' +
    '<label>Password<input name="password" type="password" autocomplete="' + (signup ? "new-password" : "current-password") +
    '" required maxlength="256"></label>' + code + alertRegion +
    '<button class="button auth-submit">' + label + '</button><div class="or"><span>or</span></div>' + google + '</form></section>';
  notice(app, message);
}

function familyPage(home, draft = null) {
  const personal = home.mine ? '<a class="my-list" href="#' + home.mine + '">' : '<button class="my-list" data-action="my-list">';
  const familyLists = home.lists.filter((list) => list.id !== home.mine);
  const family = familyLists.length ? familyLists.map((list) => {
    const initials = list.name.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]?.toLocaleUpperCase()).join("");
    return '<li><a class="family-card" href="#' + list.id + '"><span class="avatar" aria-hidden="true">' + html(initials) +
      '</span><strong>' + html(list.name) + '</strong><span class="family-chevron" aria-hidden="true">›</span></a></li>';
  }).join("") : '<li class="section-empty">No other wishlists yet.</li>';
  const importPanel = draft ? '<section class="panel list-heading"><div><h2>Add your browser item</h2>' +
    '<p>Create your wishlist to add ' + html(draft.name || "this item") + '.</p>' + alertRegion + '</div>' +
    '<div class="list-controls"><button class="small-button" data-action="discard-import">Discard</button>' +
    '<button class="button" data-action="create-import-list">Create my wishlist</button></div></section>' : "";
  app.innerHTML = hero("Family wishlists", "Find gift ideas for the people you love.") +
    importPanel + personal + '<span class="personal-icon" aria-hidden="true">♡</span><span><strong>My wishlist</strong><small>' +
    (home.mine ? "View and edit your gift ideas" : "Create your personal list") + '</small></span><span aria-hidden="true">›</span>' +
    (home.mine ? "</a>" : "</button>") +
    '<section class="family-section"><h2>Family wishlists</h2><ul class="family-grid">' + family +
    '</ul><button class="add-person" data-action="add-list">＋ Add another wishlist</button></section>';
}

function itemCard(item) {
  const picture = item.image ? '<img class="item-image" src="' + html(item.image) + '" alt="" referrerpolicy="no-referrer" loading="lazy">' :
    '<span class="item-image fallback" aria-hidden="true"><img src="/favicon.svg" alt=""></span>';
  const badge = item.claimedBy ? '<span class="claimed">Claimed by ' + html(item.claimedBy) + '</span>' : "";
  const controls = [];
  if ((wishlist.canEdit && !item.addedBy) || item.addedByMe) {
    controls.push('<button class="small-button" data-action="edit" data-id="' + item.id + '">Edit</button>',
      '<button class="text-button" data-action="remove" data-id="' + item.id + '">Remove</button>');
  }
  if (!wishlist.isOwner && !item.addedBy && (!item.claimed || item.claimedByMe)) {
    controls.push('<button class="small-button" data-action="' + (item.claimedByMe ? "release" : "claim") +
      '" data-id="' + item.id + '">' + (item.claimedByMe ? "Unclaim" : "Mark as claimed") + '</button>');
  }
  return '<li class="gift-card">' + picture + '<div class="gift-body"><div class="gift-title"><h3>' +
    html(item.name || "Untitled item") + '</h3>' + badge + '</div>' +
    (item.price ? '<p class="price">' + html(item.price) + '</p>' : "") +
    (item.addedBy ? '<p class="byline">Added by ' + html(item.addedBy) + '</p>' : "") +
    (item.notes ? '<p class="gift-notes">' + html(item.notes) + '</p>' : "") +
    (item.url ? '<a class="product-link" href="' + html(item.url) + '" target="_blank" rel="noopener noreferrer">Visit product website</a>' : "") +
    (controls.length ? '<div class="gift-actions">' + controls.join("") + '</div>' : "") + '</div></li>';
}

function listPage() {
  const title = wishlist.isOwner ? "My wishlist" : html(wishlist.name) + "’s wishlist";
  const controls = (wishlist.canEdit ? '<button class="button" data-action="add-item">＋ Add item</button>' : "") +
    (!wishlist.isOwner ? '<button class="' + (wishlist.canEdit ? "small-button" : "button") +
      '" data-action="purchase">＋ Add a purchased gift</button>' : "");
  app.innerHTML = '<a class="back-link" href="#home">All wishlists</a><section class="panel wishlist-panel"><div class="list-heading">' +
    '<div><h1>' + title + '</h1><p>' + (wishlist.isOwner ? "Your gift ideas for the family." : "Claim a gift to help the family avoid duplicates.") +
    '</p></div><div class="list-controls">' + controls + '</div></div>' + alertRegion +
    (wishlist.items.length ? '<ul class="gift-list">' + wishlist.items.map(itemCard).join("") + '</ul>' :
      '<div class="empty"><img class="empty-icon" src="/favicon.svg" alt=""><h2>No items yet</h2><p>' +
      (wishlist.canEdit ? "Add your first gift idea." : "Gift ideas will appear here when they’re added.") + '</p></div>') + '</section>';
}

function setExtensionDraft(draft) {
  extensionDraft = draft;
  try {
    if (draft) sessionStorage.setItem(extensionDraftKey, JSON.stringify(draft));
    else sessionStorage.removeItem(extensionDraftKey);
  } catch { /* The draft remains available in memory. */ }
}

function parseExtensionDraft(raw) {
  if (!raw || raw.length > 12_000) return null;
  try {
    const draft = JSON.parse(raw);
    const field = (name, max) => typeof draft?.[name] === "string" ? draft[name].trim().slice(0, max) : "";
    const url = normalizeWebsite(field("url", 4096));
    if (!url) return null;
    const image = normalizeWebsite(field("image", 4096));
    return { name: field("name", 240), url, image: image?.startsWith("https:") ? image : "", price: field("price", 48) };
  } catch { return null; }
}

function getExtensionDraft() {
  if (location.hash.startsWith("#import=")) {
    const raw = new URLSearchParams(location.hash.slice(1)).get("import");
    history.replaceState(null, "", "#home");
    setExtensionDraft(parseExtensionDraft(raw));
  } else if (extensionDraft === undefined) {
    try { extensionDraft = parseExtensionDraft(sessionStorage.getItem(extensionDraftKey)); }
    catch { extensionDraft = null; }
  }
  return extensionDraft;
}

async function render() {
  navigation?.abort();
  navigation = new AbortController();
  const { signal } = navigation;
  const draft = getExtensionDraft();
  signOut.hidden = !account?.user;
  if (!account?.user) {
    authPage(draft ? "Sign in or create an account to finish adding your browser item." : "");
    return;
  }
  const id = location.hash.slice(1);
  try {
    if (draft) {
      const home = await api("wishlists", undefined, signal);
      if (signal.aborted) return;
      if (!home.mine) {
        wishlist = null;
        familyPage(home, draft);
        return;
      }
      const result = await api("wishlists/" + home.mine, undefined, signal);
      if (signal.aborted) return;
      wishlist = result;
      if (!result.isOwner) {
        familyPage(home, draft);
        return;
      }
      history.replaceState(null, "", "#" + result.id);
      setExtensionDraft(null);
      listPage();
      itemForm("add", draft);
      return;
    }
    if (/^[a-f0-9-]{36}$/.test(id)) {
      const result = await api("wishlists/" + id, undefined, signal);
      if (!signal.aborted) { wishlist = result; listPage(); }
    } else {
      const home = await api("wishlists", undefined, signal);
      if (!signal.aborted) { wishlist = null; familyPage(home); }
    }
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401) { await start(); return; }
    app.innerHTML = '<section class="panel empty"><h2>Couldn’t open this page</h2><p role="alert">' + html(error.message) +
      '</p><a href="#home" class="small-button">All wishlists</a></section>';
  }
}

function modal(title, fields, submit, type) {
  if (editor.open) editor.close();
  editor.dataset.type = type;
  editor.innerHTML = '<form><div class="dialog-heading"><h2 id="editor-title">' + title + '</h2>' +
    '<button type="button" data-action="close" class="icon-button" aria-label="Close">×</button></div>' +
    fields + alertRegion + '<div class="dialog-actions"><button type="button" class="small-button" data-action="close">Cancel</button>' +
    '<button class="button">' + submit + '</button></div></form>';
  editor.showModal();
}

function createListForm(personal = false) {
  modal("Add another wishlist",
    '<fieldset class="for-options"><legend>Who is this wishlist for?</legend>' +
    '<label><input type="radio" name="for" value="self" checked> Myself</label>' +
    '<label><input type="radio" name="for" value="other"> Someone else</label></fieldset>' +
    '<div id="recipient-fields" hidden><label>Recipient name<input name="name" maxlength="100"></label>' +
    '<label>Recipient email <span>Optional</span><input type="email" name="email" maxlength="254"></label>' +
    '<p class="field-help">A matching verified Google account can take ownership of this list.</p></div>', "Create wishlist", "list");
  if (personal) editor.querySelector('input[value="self"]').focus();
}

function itemForm(action, item = {}) {
  resetProductLookup();
  const input = (name, label, type = "text") => '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + html(item[name]) + '"></label>';
  modal(action === "edit" ? "Edit item" : action === "purchase" ? "Add a purchased gift" : "Add item",
    input("name", "Item name") + '<label>Website link<input name="url" type="text" inputmode="url" value="' + html(item.url) + '"></label>'  +
    '<p class="field-help" id="product-info" role="status">Paste a product link to look up its image and price.</p>' +
    '<details class="product-import" data-product-import' + (item.url && (!item.image || !item.price) ? "" : " hidden") + '>' +
    '<summary>Import from a page you can open</summary>' +
    '<p class="field-help">Open the product in your browser and save it as HTML. Choose that file here to read the image and price on this device.</p>' +
    '<label>Saved product page<input name="productPage" type="file" accept=".html,.htm,text/html"></label></details>' +
    '<div class="item-fields">' + input("price", "Price") + input("image", "Image link", "url") + '</div>' +
    '<label>Notes<textarea name="notes" rows="4">' + html(item.notes) + '</textarea></label>',
    action === "edit" ? "Save changes" : "Add item", action);
  editor.dataset.item = item.id ?? "";
  editor.dataset.originalUrl = item.url ?? "";
  for (const name of ["image", "price"]) {
    const field = editor.querySelector('[name="' + name + '"]');
    field.dataset.auto = field.value;
  }
  editor.querySelector('[name="name"]').focus();
}

function normalizeWebsite(value) {
  const input = value.trim();
  if (!input) return "";
  const candidate = /^[^/\s:]+\.[^/\s:]+(?:[/?#]|$)/.test(input) ? "https://" + input : input;
  try {
    const url = new URL(candidate);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

function resetProductLookup() {
  clearTimeout(lookupTimer);
  productLookup?.controller.abort();
  productLookup = undefined;
}

function fillProductFields(form, metadata) {
  for (const name of ["image", "price"]) {
    const field = form.elements.namedItem(name);
    if (field.dataset.auto === field.value && metadata[name]) {
      field.value = metadata[name];
      field.dataset.auto = field.value;
    }
  }
  form.querySelector("[data-product-import]").hidden = Boolean(
    form.elements.namedItem("image").value && form.elements.namedItem("price").value);
}

function detailsFromSavedPage(source, url) {
  const template = document.createElement("template");
  template.innerHTML = source;
  const page = template.content;
  const meta = (...keys) => keys.map((key) =>
    page.querySelector('meta[property="' + key + '"], meta[itemprop="' + key + '"]')?.content).find(Boolean);
  const mainImage = page.querySelector("#landingImage, #imgBlkFront");
  let alternateImage;
  try { alternateImage = Object.keys(JSON.parse(mainImage?.getAttribute("data-a-dynamic-image") ?? "{}"))[0]; }
  catch {}
  const currentPrice = page.querySelector(
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .priceToPay .a-offscreen, " +
    "#corePrice_mobile_feature_div .apexPriceToPay .a-offscreen, #corePrice_desktop .priceToPay .a-offscreen, " +
    "#priceblock_dealprice, #priceblock_ourprice, #priceblock_saleprice");
  const imageOptions = [mainImage?.getAttribute("data-old-hires"), alternateImage, mainImage?.getAttribute("src"),
    meta("og:image:secure_url", "og:image", "image")];
  const image = imageOptions.map((candidate) => {
    if (!candidate) return "";
    try { return normalizeWebsite(new URL(candidate, url).href) || ""; }
    catch { return ""; }
  }).find((candidate) => candidate.startsWith("https:")) || "";
  const amount = currentPrice?.textContent?.trim() || meta("product:price:amount", "og:price:amount", "price") || "";
  const currency = meta("product:price:currency", "og:price:currency", "priceCurrency");
  const prefix = /^[A-Z]{3}$/.test(currency ?? "") && /^\d/.test(amount) ? currency + " " : "";
  return { image, price: /\d/.test(amount) && amount.length <= 40 ? prefix + amount : "" };
}

async function importProductPage(input) {
  const file = input.files[0];
  if (!file) return;
  const form = input.form;
  const website = form.elements.namedItem("url");
  const url = normalizeWebsite(website.value);
  const info = form.querySelector("#product-info");
  if (!url) { info.textContent = "Enter the product link before importing the page."; return; }
  if (file.size > 16_000_000) { info.textContent = "This saved page is too large. Choose an HTML-only file."; return; }
  try {
    const metadata = detailsFromSavedPage(await file.text(), url);
    if (!form.isConnected || normalizeWebsite(website.value) !== url) return;
    fillProductFields(form, metadata);
    info.textContent = metadata.image || metadata.price
      ? "Product details read from your saved page."
      : "Couldn’t find product details in this file. Save the product page as HTML and try again.";
  } catch {
    info.textContent = "Couldn’t read the saved page.";
  }
}

function lookupWebsite(form, url) {
  if (productLookup?.form === form && productLookup.url === url) return productLookup.done;
  resetProductLookup();
  const controller = new AbortController();
  const { signal } = controller;
  const info = form.querySelector("#product-info");
  info.textContent = "Looking for product details…";
  const done = api("product", { url }, AbortSignal.any([signal, AbortSignal.timeout(8000)])).then((metadata) => {
    if (signal.aborted || !editor.open) return;
    fillProductFields(form, metadata);
    info.textContent = metadata.message || (metadata.image || metadata.price
      ? "Product details found. You can edit them below."
      : "Couldn’t get product details from this link. You can import a saved product page or save the link by itself.");
  }).catch(() => {
    if (!signal.aborted) {
      fillProductFields(form, {});
      info.textContent = "Product lookup unavailable. You can import a saved product page or save the link by itself.";
    }
  });
  productLookup = { controller, form, url, done };
  return done;
}

function schedulePreview(input) {
  resetProductLookup();
  const url = normalizeWebsite(input.value);
  const info = input.form.querySelector("#product-info");
  input.form.querySelector("[data-product-import]").hidden = true;
  if (!url) {
    info.textContent = url === null ? "Enter a website link, such as example.com/product." : "Paste a product link to look up its image and price.";
    return;
  }
  lookupTimer = setTimeout(() => void lookupWebsite(input.form, url), 350);
}

async function run(target, task) {
  if (saving) return;
  saving = true;
  notice(target, "");
  const buttons = [...target.querySelectorAll("button:not(:disabled)")];
  buttons.forEach((button) => { button.disabled = true; });
  try { await task(); }
  catch (error) { notice(target, error.message); }
  finally {
    saving = false;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function itemAction(data, id = wishlist.id) {
  await api("wishlists/" + id, data);
  if (editor.open) editor.close();
  await render();
}

editor.addEventListener("input", (event) => {
  if (event.target.name === "url") schedulePreview(event.target);
  if (["image", "price"].includes(event.target.name)) delete event.target.dataset.auto;
});
editor.addEventListener("change", (event) => {
  if (event.target.name === "productPage") void importProductPage(event.target);
  if (event.target.name !== "for") return;
  const other = event.target.value === "other";
  editor.querySelector("#recipient-fields").hidden = !other;
  editor.querySelector('[name="name"]').required = other;
});
editor.addEventListener("close", resetProductLookup);
editor.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
editor.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const { type, item, originalUrl } = editor.dataset;
  const listId = wishlist?.id;
  void run(editor, async () => {
    if (type === "list") {
      const { id } = await api("wishlists", Object.fromEntries(new FormData(form)));
      editor.close();
      location.hash = id;
    } else {
      if (type === "remove") {
        await itemAction({ action: type, itemId: item }, listId);
        return;
      }
      const website = form.elements.namedItem("url");
      const url = normalizeWebsite(website.value);
      if (url === null) throw new Error("Enter a valid website link.");
      website.readOnly = true;
      try {
        if (url && url !== originalUrl) await lookupWebsite(form, url);
        const fields = Object.fromEntries(new FormData(form));
        delete fields.productPage;
        await itemAction({ ...fields, url, action: type, itemId: item }, listId);
      } finally {
        website.readOnly = false;
      }
    }
  });
});
app.addEventListener("submit", (event) => {
  if (event.target.id !== "auth-form") return;
  event.preventDefault();
  void run(app, async () => {
    const data = Object.fromEntries(new FormData(event.target));
    const { user } = await api("auth/" + authMode, data);
    account.user = user;
    location.hash = "home";
    await render();
  });
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "close") editor.close();
  if (action === "login" || action === "signup") { authMode = action; authPage(); }
  if (action === "retry") void start();
  if (action === "google") void run(app, async () => {
    const familyCode = button.form.elements.namedItem("familyCode")?.value;
    const data = Object.fromEntries(new FormData(button.form));
    if (authMode === "signup") {
      for (const name of ["firstName", "lastName", "familyCode"]) {
        const field = button.form.elements.namedItem(name);
        if (field && !field.reportValidity()) return;
      }
    }
    const { url } = await api("auth/google", {
      mode: authMode, familyCode, firstName: data.firstName,
      lastName: data.lastName, shippingAddress: data.shippingAddress,
    });
    location.assign(url);
  });
  if (action === "logout") void run(app, async () => {
    await api("auth/logout", {});
    account.user = null;
    authMode = "login";
    location.hash = "home";
    await render();
  });
  if (action === "discard-import") { setExtensionDraft(null); void render(); }
  if (action === "create-import-list") void run(app, async () => {
    try { await api("wishlists", { for: "self" }); }
    catch (error) { if (error.status !== 409) throw error; }
    await render();
  });
  if (action === "add-list" || action === "my-list") createListForm(action === "my-list");
  if (action === "add-item" || action === "purchase") itemForm(action === "purchase" ? "purchase" : "add");
  if (action === "edit") itemForm("edit", wishlist.items.find((item) => item.id === id));
  if (action === "remove") {
    modal("Remove this item?", "<p>This item will be removed from the wishlist.</p>", "Remove item", "remove");
    editor.dataset.item = id;
  }
  if (action === "claim" || action === "release") void run(app, async () => {
    try { await itemAction({ action, itemId: id }); }
    catch (error) { if (error.status === 409) await render(); throw error; }
  });
});
window.addEventListener("hashchange", () => {
  if (editor.open) editor.close();
  if (account) void render();
});

async function start() {
  getExtensionDraft();
  try {
    account = await api("account");
    const status = new URLSearchParams(location.search).get("auth");
    if (account.user || !status) await render();
    else {
      history.replaceState(null, "", "/");
      if (status === "signup") authMode = "signup";
      authPage(status === "signup" ? "Create an account with this Google account first." : "Google sign-in couldn’t be completed. Try again.");
    }
  } catch (error) {
    app.innerHTML = '<section class="panel empty"><h2>Couldn’t load the wishlist</h2><p role="alert">' + html(error.message) +
      '</p><button class="small-button" data-action="retry">Try again</button></section>';
  }
}
void start();
