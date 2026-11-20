const app = document.querySelector("#app");
const editor = document.querySelector("#editor");
const addPerson = document.querySelector("#header-add");

const symbols = {
  gift: '<path d="M4 11h16v10H4zM2 7h20v4H2zM12 7v14m0-14c-9 0-7-7-3-4l3 4c9 0 7-7 3-4z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.4 8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4m-4 4v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

function icon(name, size = 19) {
  return '<svg class="icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + symbols[name] + '</svg>';
}

function html(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function button(text, attribute, style = "button") {
  return '<button type="button" class="' + style + '" ' + attribute + '>' + text + '</button>';
}

function empty(symbol, title, description, extra = "", first = false) {
  return '<div class="empty' + (first ? " first-empty" : "") + '"><div class="empty-icon">' + icon(symbol, 28) +
    '</div><h2>' + title + '</h2><p>' + description + '</p>' + extra + '</div>';
}

async function api(query = "", data, signal) {
  const response = await fetch("/api/wishlist" + query, {
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

let family;
let activeRequest;
let saving = false;

function personLink(person, index, selected) {
  const initials = person.name.split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0].toLocaleUpperCase()).join("");
  return '<a class="person" href="#' + html(person.id) + '"' + (selected ? ' aria-current="page"' : '') +
    '><span class="avatar shade-' + index % 4 + '">' + html(initials) + '</span><span class="person-name">' + html(person.name) +
    (person.isOwner ? '<span class="you">You</span>' : "") + '</span>' + icon("chevron", 17) + '</a>';
}

function listHeader(person, purchasesView) {
  const base = "#" + html(person.id);
  const tabs = person.isOwner ? "" : '<nav class="tabs" aria-label="Wishlist views"><a href="' + base + '"' +
    (purchasesView ? "" : ' aria-current="page"') + '>Wishlist</a><a href="' + base + '/purchases"' +
    (purchasesView ? ' aria-current="page"' : "") + '>' + icon("lock", 15) + ' Purchases</a></nav>';
  const controls = person.isOwner ? button("＋ Add item", 'data-form="wish"')
    : purchasesView ? button("＋ Record a gift", 'data-form="purchase"') : "";
  return '<div class="list-heading"><h2>' + html(person.name) + '’s wishlist</h2>' + controls + '</div>' + tabs;
}

function wishRow(wish, controls = "") {
  const note = wish.note ? "<p>" + html(wish.note) + "</p>" : "";
  const url = wish.url ? '<a class="product-link" target="_blank" rel="noreferrer" href="' + html(wish.url) + '">Product link ↗</a>' : "";
  return '<li class="entry"><span class="entry-icon">' + icon("gift") + '</span><div class="entry-text"><strong>' +
    html(wish.title) + '</strong>' + note + url + '</div>' + controls + '</li>';
}

function purchaseRow(purchase) {
  const buyer = purchase.isMine ? "Bought by you" : "Bought by " + html(purchase.buyerName);
  const undo = purchase.isMine ? button("Undo", 'data-action="undoPurchase" data-id="' + html(purchase.id) + '"', "text-button") : "";
  return '<li class="entry"><span class="entry-icon purchased">' + icon("check") + '</span><div class="entry-text"><strong>' +
    html(purchase.title) + '</strong><p>' + buyer + '</p></div>' + undo + '</li>';
}

function entries(rows) {
  return '<ul class="entries">' + rows.join("") + '</ul>';
}

function purchasesPanel(person, wishes, purchases) {
  const bought = new Set(purchases.map((purchase) => purchase.wishId));
  const available = wishes.filter((wish) => !bought.has(wish.id));
  return '<div class="list-content"><p class="privacy">' + icon("lock", 16) + ' ' + html(person.name) +
    ' can’t see this view.</p><h3>Already bought</h3>' +
    (purchases.length ? entries(purchases.map(purchaseRow)) : '<p class="section-empty">No purchases have been recorded yet.</p>') +
    '<h3>Wishlist ideas</h3>' + (available.length ? entries(available.map((wish) => wishRow(wish,
      button(icon("check", 16) + " Mark bought", 'data-action="buyWish" data-id="' + html(wish.id) + '"', "small-button")))) :
      '<p class="section-empty">No unpurchased wishlist items.</p>') + '</div>';
}

async function render() {
  if (!family) return;
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  const [id, page] = location.hash.slice(1).split("/");
  const person = family.people.find((member) => member.id === id) ?? family.people[0];
  const purchasesView = Boolean(person && !person.isOwner && id === person.id && page === "purchases");
  const section = person
    ? listHeader(person, purchasesView) + '<p id="notice" class="inline-error" role="alert" hidden></p><div id="items"><p class="loading" role="status">Loading this list…</p></div>'
    : empty("gift", "Start the first wishlist", "Add yourself or a family member to give their gift ideas a home.", button("＋ Add a family member", 'data-form="person"'), true);
  app.dataset.person = person?.id ?? "";
  app.innerHTML = '<div class="workspace"><aside aria-label="Family members"><div class="sidebar-title"><h2>Family members</h2><span>' +
    family.people.length + '</span></div><nav class="family-list" aria-label="Wishlists">' +
    family.people.map((member, index) => personLink(member, index, member.id === person?.id)).join("") +
    button("＋ Add a family member", 'data-form="person"', "add-person") +
    '</nav></aside><section class="panel list-panel" aria-label="' +
    (person ? html(person.name) + '’s wishlist' : 'Get started') + '">' + section + '</section></div>';
  if (!person) return;
  const outlet = app.querySelector("#items");
  const query = "?person=" + encodeURIComponent(person.id);
  try {
    const [wishlist, purchases] = await Promise.all([
      api(query, undefined, controller.signal),
      purchasesView ? api(query + "&view=purchases", undefined, controller.signal) : null,
    ]);
    if (controller.signal.aborted) return;
    outlet.innerHTML = purchases
      ? purchasesPanel(person, wishlist.wishes, purchases.purchases)
      : wishlist.wishes.length
        ? '<div class="list-content">' + entries(wishlist.wishes.map((wish) => wishRow(wish))) + '</div>'
        : empty("heart", "No gift ideas yet", person.isOwner ? "Add something you’d love to receive." : html(person.name) + " hasn’t added any gift ideas yet.");
  } catch (error) {
    if (!controller.signal.aborted) outlet.innerHTML = '<div class="empty"><p role="alert">' + html(error.message) +
      '</p>' + button("Try again", 'data-action="refresh"', "small-button") + '</div>';
  }
}

const giftInput = '<label>Gift name<input name="title" placeholder="e.g. A new jigsaw puzzle" autofocus required maxlength="160"></label>';
const forms = {
  person: {
    title: "Add a family member", label: "Add person", action: "addPerson",
    fields: '<label>Display name<input name="name" placeholder="e.g. Aunt Jamie" autofocus required maxlength="80"></label>' +
      '<label>Recipient’s ChatGPT sign-in email<input name="email" type="email" required maxlength="254" placeholder="name@example.com" aria-describedby="email-help"></label>' +
      '<p class="field-help" id="email-help">Use the email they’ll sign in with so they can add wishes and their purchases stay hidden.</p>' +
      button("Use my email", 'data-action="myEmail"', "text-button fill-email"),
  },
  wish: {
    title: "Add a gift idea", label: "Add item", action: "addWish",
    fields: giftInput + '<label>Product link <span>Optional</span><input type="url" name="url" maxlength="2048" placeholder="https://…"></label>' +
      '<label>Notes <span>Optional</span><textarea name="note" maxlength="500" rows="3" placeholder="Size, color, or anything helpful"></textarea></label>',
  },
  purchase: { title: "Record a gift", label: "Record gift", action: "addPurchase", fields: giftInput },
};

function openForm(spec) {
  if (!spec || saving || editor.open) return;
  editor.dataset.action = spec.action;
  editor.dataset.person = app.dataset.person ?? "";
  editor.innerHTML = '<form><div class="dialog-heading"><h2 id="editor-title">' + spec.title + '</h2>' +
    button("×", 'aria-label="Close" data-action="close"', "icon-button") + '</div>' + spec.fields +
    '<p class="inline-error" role="alert" hidden></p><div class="dialog-actions">' +
    button("Cancel", 'data-action="close"', "small-button") + '<button class="button">' + spec.label + '</button></div></form>';
  editor.showModal();
}

async function save(data, form) {
  if (saving) return;
  saving = true;
  const controls = [...(form ?? app).querySelectorAll("button")];
  const alert = form?.querySelector("[role=alert]") ?? app.querySelector("#notice");
  if (alert) alert.hidden = true;
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await api("", data);
    if (form) editor.close();
    if (data.action === "addPerson") {
      family = await api();
      history.replaceState(null, "", "#" + result.id);
    }
    await render();
  } catch (error) {
    const visibleAlert = alert?.isConnected ? alert : app.querySelector("#notice");
    if (visibleAlert) { visibleAlert.textContent = error.message; visibleAlert.hidden = false; }
  } finally {
    saving = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}

editor.addEventListener("submit", (event) => {
  event.preventDefault();
  void save({ ...Object.fromEntries(new FormData(event.target)), action: editor.dataset.action, personId: editor.dataset.person }, event.target);
});
editor.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
window.addEventListener("hashchange", () => { if (!saving && editor.open) editor.close(); void render(); });
document.addEventListener("click", (event) => {
  const control = event.target.closest("button[data-form], button[data-action]");
  if (!control) return;
  const { form, action, id } = control.dataset;
  const personId = app.dataset.person;
  if (form) openForm(forms[form]);
  if (action === "close" && !saving) editor.close();
  if (action === "myEmail") control.form.elements.namedItem("email").value = family.viewerEmail;
  if (action === "buyWish") void save({ action, personId, wishId: id });
  if (action === "undoPurchase") void save({ action, personId, purchaseId: id });
  if (action === "refresh") void render();
  if (action === "retry") void start();
});

async function start() {
  try {
    family = await api();
    addPerson.hidden = false;
    await render();
  } catch (error) {
    const signedOut = error.status === 401;
    const control = signedOut
      ? '<a class="button" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a>'
      : button("Try again", 'data-action="retry"');
    app.innerHTML = '<section class="panel">' + empty("gift", signedOut ? "Sign in to see the lists" : "Couldn’t open the wishlists", html(error.message), control) + '</section>';
  }
}

void start();
