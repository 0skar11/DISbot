// عدّل رقم الواتساب (بصيغة دولية بدون +) والعملة من هنا
const WHATSAPP = "201000000000";
const CURRENCY = "ج.م";

const PRODUCTS = [
  { id: 1, name: "عود ملكي", cat: "عود", notes: "عود كمبودي، عنبر، خشب الصندل", price: 1450, size: "100 مل", c: ["#3b2a1a", "#8a5a2b"] },
  { id: 2, name: "ليل الشرق", cat: "رجالي", notes: "جلد، توابل، باتشولي", price: 980, size: "100 مل", c: ["#14213d", "#3c5a99"] },
  { id: 3, name: "أمواج", cat: "رجالي", notes: "حمضيات، نعناع، مسك أبيض", price: 760, size: "100 مل", c: ["#0b6e8a", "#4cc3d9"] },
  { id: 4, name: "وردة الصباح", cat: "نسائي", notes: "ورد دمشقي، لتشي، فانيلا", price: 890, size: "75 مل", c: ["#b03a6b", "#f19ac0"] },
  { id: 5, name: "ياسمين", cat: "نسائي", notes: "ياسمين، زهر البرتقال، مسك", price: 840, size: "75 مل", c: ["#c9a24a", "#f7e7b4"] },
  { id: 6, name: "مسك الطهارة", cat: "مسك", notes: "مسك أبيض نقي، خفيف ودافئ", price: 420, size: "50 مل", c: ["#9aa5a0", "#e5ece8"] },
  { id: 7, name: "عنبر وفانيلا", cat: "نسائي", notes: "عنبر، فانيلا، كراميل", price: 910, size: "100 مل", c: ["#7a3e12", "#e0913d"] },
  { id: 8, name: "دهن عود مركّز", cat: "عود", notes: "دهن عود هندي مركّز", price: 2100, size: "12 مل", c: ["#1c1c1c", "#5a4a2a"] },
];

const $ = (s) => document.querySelector(s);
const fmt = (n) => n.toLocaleString("ar-EG") + " " + CURRENCY;
let cart = {};
try { cart = JSON.parse(localStorage.getItem("cart") || "{}"); } catch {}
let cat = "الكل";

const bottle = ([a, b], id) => `
<svg viewBox="0 0 80 110"><defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect x="30" y="4" width="20" height="16" rx="3" fill="#222"/><rect x="34" y="20" width="12" height="9" fill="#c9a24a"/>
<rect x="8" y="29" width="64" height="76" rx="12" fill="url(#g${id})"/><rect x="18" y="48" width="44" height="34" rx="4" fill="#fff" fill-opacity=".8"/></svg>`;

function renderChips() {
  const cats = ["الكل", ...new Set(PRODUCTS.map((p) => p.cat))];
  $("#chips").innerHTML = cats.map((c) => `<button class="chip ${c === cat ? "on" : ""}" data-c="${c}">${c}</button>`).join("");
}

function renderGrid() {
  const q = $("#search").value.trim();
  const list = PRODUCTS.filter((p) => (cat === "الكل" || p.cat === cat) && (p.name + p.notes).includes(q));
  $("#empty").hidden = list.length > 0;
  $("#grid").innerHTML = list.map((p) => `
    <article class="card">
      <div class="pic" style="background:linear-gradient(160deg,${p.c[1]}22,${p.c[0]}22)">${bottle(p.c, p.id)}</div>
      <div class="info">
        <span class="cat">${p.cat}</span><h3>${p.name}</h3>
        <p class="notes">${p.notes}</p>
        <div class="buy"><span class="price">${fmt(p.price)} <small>/ ${p.size}</small></span>
        <button class="add" data-add="${p.id}">أضف للسلة</button></div>
      </div>
    </article>`).join("");
}

const entries = () => Object.entries(cart).map(([id, n]) => ({ p: PRODUCTS.find((x) => x.id == id), n })).filter((e) => e.p);
const total = () => entries().reduce((s, e) => s + e.p.price * e.n, 0);

function renderCart() {
  localStorage.setItem("cart", JSON.stringify(cart));
  const es = entries();
  $("#cartCount").textContent = es.reduce((s, e) => s + e.n, 0);
  $("#total").textContent = fmt(total());
  $("#items").innerHTML = es.length ? es.map(({ p, n }) => `
    <div class="line"><div class="t">${p.name}<small>${fmt(p.price)}</small></div>
    <div class="qty"><button data-d="-1" data-id="${p.id}">−</button><b>${n}</b><button data-d="1" data-id="${p.id}">+</button></div></div>`).join("")
    : '<p class="empty">السلة فارغة</p>';
  $("#order button").disabled = !es.length;
}

function toggle(open) {
  $("#drawer").classList.toggle("open", open);
  $("#drawer").setAttribute("aria-hidden", String(!open));
  $("#overlay").hidden = !open;
}

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.dataset.c) { cat = t.dataset.c; renderChips(); renderGrid(); }
  if (t.dataset.add) { cart[t.dataset.add] = (cart[t.dataset.add] || 0) + 1; renderCart(); toggle(true); }
  if (t.dataset.d) {
    const id = t.dataset.id;
    cart[id] = (cart[id] || 0) + Number(t.dataset.d);
    if (cart[id] <= 0) delete cart[id];
    renderCart();
  }
});
$("#search").addEventListener("input", renderGrid);
$("#openCart").onclick = () => toggle(true);
$("#closeCart").onclick = $("#overlay").onclick = () => toggle(false);

$("#order").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const lines = entries().map(({ p, n }) => `• ${p.name} (${p.size}) × ${n} = ${fmt(p.price * n)}`);
  const msg = ["طلب جديد 🛍️", ...lines, `الإجمالي: ${fmt(total())}`, "",
    `الاسم: ${f.get("name")}`, `الموبايل: ${f.get("phone")}`, `العنوان: ${f.get("address")}`].join("\n");
  window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
});

$("#waLink").href = `https://wa.me/${WHATSAPP}`;
$("#yr").textContent = new Date().getFullYear();
renderChips(); renderGrid(); renderCart();
