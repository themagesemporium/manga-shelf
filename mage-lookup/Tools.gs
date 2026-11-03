/**
 * Mage Tools — staff screens for The Mage's Emporium (built by Claude for Megan, Nov 2026).
 * Lives in the Mage Lookup Apps Script next to Code.gs and uses its Shopify connection (gql_, cleanIsbn_, addIsbn).
 * Open:  <your web app URL>?page=tools
 *
 *  1. Order check: pick an unfulfilled order, scan each book as you pack, get "Done" when everything matches.
 *  2. Scan to stock: every scan adds +1. Books not in the shop go to the price-check list (and the Lookup sheet).
 */
const TOOLS_LOCATION = 'gid://shopify/Location/24217416';

/* ---------- helpers ---------- */
function toolsCodes_(v) {                       // every form a barcode/SKU can take, for matching
  const raw = String(v || '').toUpperCase().replace(/-EXLIB$/, '').replace(/[^0-9X]/g, '');
  const out = [];
  if (raw) out.push(raw);
  const isbn = cleanIsbn_(raw); if (isbn && out.indexOf(isbn) < 0) out.push(isbn);
  return out;
}
function toolsMonthTag_() { return Utilities.formatDate(new Date(), 'America/New_York', 'yyMM'); }
function toolsFindVariant_(code) {
  const codes = toolsCodes_(code); if (!codes.length) return null;
  const q = codes.map(c => `barcode:${c} OR sku:${c}`).join(' OR ');
  const d = gql_(`query($q:String){productVariants(first:5,query:$q){nodes{id sku barcode inventoryItem{id inventoryLevel(locationId:"${TOOLS_LOCATION}"){quantities(names:["available"]){quantity}}}
    product{id title status tags featuredMedia{preview{image{url(transform:{maxWidth:120})}}}}}}}`, { q });
  const n = d.productVariants.nodes;
  if (!n.length) return null;
  // prefer an exact barcode match on an active listing
  n.sort((a, b) => (b.product.status === 'ACTIVE') - (a.product.status === 'ACTIVE'));
  return n[0];
}

/* ---------- 1. Order check ---------- */
function toolsOrders() {
  const d = gql_(`{orders(first:40,sortKey:CREATED_AT,reverse:true,query:"fulfillment_status:unfulfilled AND status:open"){nodes{id name createdAt sourceName
    customer{firstName lastName} lineItems(first:60){nodes{title quantity sku variant{barcode sku} image{url(transform:{maxWidth:120})}}}}}}`);
  return d.orders.nodes.map(o => ({
    id: o.id, name: o.name, date: o.createdAt.slice(0, 10), src: o.sourceName || '',
    who: o.customer ? [o.customer.firstName, (o.customer.lastName || '').slice(0, 1)].filter(Boolean).join(' ') : '',
    items: o.lineItems.nodes.filter(l => l.quantity > 0).map(l => {
      const codes = [].concat(toolsCodes_(l.sku), toolsCodes_(l.variant && l.variant.barcode), toolsCodes_(l.variant && l.variant.sku));
      return { t: l.title.replace(/ Used (English )?Manga.*$/i, ''), q: l.quantity, img: l.image ? l.image.url : '', codes: codes.filter((c, i) => codes.indexOf(c) === i) };
    })
  })).filter(o => o.items.length);
}
function toolsWhatIs(code) {                     // a scan that isn't in the order: say what book it is
  const v = toolsFindVariant_(code);
  return v ? { t: v.product.title } : { t: '' };
}

/* ---------- 2. Scan to stock ---------- */
function toolsAdd(code, haul) {
  const codes = toolsCodes_(code);
  if (!codes.length) return { ok: false, msg: 'That doesn’t look like a barcode.' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const v = toolsFindVariant_(code);
    if (!v) return toolsPriceAdd_(codes[codes.length - 1]);
    const lvl = v.inventoryItem.inventoryLevel;
    const before = lvl ? lvl.quantities[0].quantity : 0;
    const key = 'add-' + v.id.split('/').pop() + '-' + Date.now();
    const r = gql_(`mutation($in:InventoryAdjustQuantitiesInput!){inventoryAdjustQuantities(input:$in) @idempotent(key:"${key}"){userErrors{message}}}`, {
      in: { name: 'available', reason: 'received', changes: [{ inventoryItemId: v.inventoryItem.id, locationId: TOOLS_LOCATION, delta: 1, changeFromQuantity: before }] } });
    const err = r.inventoryAdjustQuantities.userErrors; if (err.length) return { ok: false, msg: err[0].message };
    // tags: back in stock gets the month tag; the haul tag (if typed) goes on every scan
    const tags = v.product.tags.slice(); let add = [], remove = [];
    if (before <= 0) { remove = tags.filter(t => /^(outofstock|placeholder|placeholder-current|placeholder-oop)$/i.test(t)); add.push('BackInStock', toolsMonthTag_()); }
    if (haul) add.push(String(haul).trim());
    add = add.filter(t => t && tags.indexOf(t) < 0);
    if (add.length) gql_(`mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}`, { id: v.product.id, t: add });
    if (remove.length) gql_(`mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}`, { id: v.product.id, t: remove });
    const img = v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image ? v.product.featuredMedia.preview.image.url : '';
    return { ok: true, t: v.product.title, qty: before + 1, back: before <= 0, draft: v.product.status !== 'ACTIVE', img };
  } finally { lock.releaseLock(); }
}

/* ---------- price-check list (new books) ---------- */
function toolsPriceAdd_(isbn) {
  const p = props_(); const list = JSON.parse(p.getProperty('PRICECHECK') || '{}');
  list[isbn] = (list[isbn] || 0) + 1; p.setProperty('PRICECHECK', JSON.stringify(list));
  try { if (list[isbn] === 1) addIsbn(isbn); } catch (e) {}   // also queue it for Mage Lookup's look-up
  return { ok: true, isNew: true, isbn, count: list[isbn], total: Object.keys(list).length };
}
function toolsPriceList() {
  const list = JSON.parse(props_().getProperty('PRICECHECK') || '{}');
  return Object.keys(list).map(k => ({ isbn: k, n: list[k] }));
}
function toolsPriceClear() { props_().deleteProperty('PRICECHECK'); return true; }
