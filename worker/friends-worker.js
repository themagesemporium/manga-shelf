// My Manga Emporium: live friends (Cloudflare Worker + KV namespace bound as FRIENDS)
// Who is calling is proven by their Shopify customer-account token (checked against Shopify).
// KV keys:  tok:<hash> -> {cid,name} (1h)   own:<cid> -> {code,name,viewers:{cid:{name,st,at}}}   code:<code> -> cid
//           shelf:<cid> -> packed shelf (gzip base64)   fol:<cid> -> {ownerCid:{name,st,at}}
const ORIGIN = 'https://app.themagesemporium.com';
const CAAPI = 'https://shopify.com/19355029/account/customer/api/2026-10/graphql';
const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-max-age': '86400' };
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', ...cors } });
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
async function sha(t){ const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function who(env, req){ const t = req.headers.get('authorization'); if (!t) return null; const h = 'tok:' + await sha(t);
  const c = await env.FRIENDS.get(h, 'json'); if (c) return c;
  const r = await fetch(CAAPI, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: t, origin: ORIGIN, referer: ORIGIN + '/', 'user-agent': 'Mozilla/5.0 (MME friends)' }, body: JSON.stringify({ query: '{customer{id firstName emailAddress{emailAddress}}}' }) });
  if (!r.ok){ who.last = r.status + ' ' + (await r.text()).slice(0, 120); return null; } const j = await r.json(); const cu = j.data && j.data.customer; if (!cu) return null;
  const me = { cid: cu.id.split('/').pop(), name: cu.firstName || 'A friend', mail: cu.emailAddress ? String(cu.emailAddress.emailAddress).toLowerCase() : '' }; await env.FRIENDS.put(h, JSON.stringify(me), { expirationTtl: 3600 }); return me; }
const get = async (env, k) => (await env.FRIENDS.get(k, 'json')) || null;
const put = (env, k, v) => env.FRIENDS.put(k, JSON.stringify(v));

/* ---------- push notifications (Web Push, RFC 8291 aes128gcm + VAPID) ----------
   KV: vapid -> {pub (b64url raw), jwk (private)}  created here on first use, never leaves Cloudflare
       push:c:<cid> -> {h, prefs:{stock,orders,msgs,deals}, subs:[{endpoint,keys:{p256dh,auth}}]}
       push:h:<sha256('mme:'+cid)> -> cid      push:done:<id> -> '1' (sent, kept 10 days)
   Queue: the shop metafield mme_app.push_queue (json list, storefront-readable) written by tools/push-queue.js:
       [{id, h: <sha256('mme:'+cid)> or '*', k: 'stock'|'orders'|'msgs'|'deals', t: title, b: body, u: url, at, s: send-after ms (optional)}]
   A cron trigger (every 10 minutes) sends the new items. */
const STOREFRONT = 'https://themagesemporium.com/api/2025-07/graphql.json';
const SHOP_CID = env => env.SHOP_CID || '99230547976'; // Megan's own app account gets the shop alerts
const DESK = 'https://claude.ai/artifact/Ey2qeRAtftubrtAhQkz5GC';
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const n = a.reduce((t, x) => t + x.length, 0), o = new Uint8Array(n); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };
const te = new TextEncoder();
async function vapid(env){ let v = await get(env, 'vapid'); if (v) return v;
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = { pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)), jwk: await crypto.subtle.exportKey('jwk', k.privateKey) }; await put(env, 'vapid', v); return v; }
async function hkdf(salt, ikm, info, len){ const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8)); }
async function encrypt(sub, payload){ // RFC 8291
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(te.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, asPub, ct); }
async function vapidAuth(env, endpoint){ const v = await vapid(env); const aud = new URL(endpoint).origin;
  const enc = o => b64u(te.encode(JSON.stringify(o))); const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:themagesemporium@gmail.com' });
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned)); return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + v.pub; }
async function sendOne(env, sub, msg){ // -> HTTP status; 404/410 means the subscription is gone
  const body = await encrypt(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { authorization: await vapidAuth(env, sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' }, body });
  return r.status; }
async function sendTo(env, cid, msg, kind){ const rec = await get(env, 'push:c:' + cid); if (!rec || !rec.subs || !rec.subs.length) return 0; if (kind && rec.prefs && rec.prefs[kind] === false) return 0;
  let n = 0; const keep = []; for (const s of rec.subs){ let st = 0; try { st = await sendOne(env, s, msg); } catch(e){} if (st === 404 || st === 410) continue; keep.push(s); if (st >= 200 && st < 300) n++; }
  if (keep.length !== rec.subs.length){ rec.subs = keep; await put(env, 'push:c:' + cid, rec); } return n; }
/* ---- App cart reminder (Megan, Nov 24 2026): one push per cart, 24h after the last change, only if the books are still in it and no order came in since. Respects the 'cart' push toggle. ---- */
async function cartTick(env){ if (new Date().getUTCMinutes() >= 10) return; const C = (await get(env, 'cart:idx')) || {}; const now = Date.now(); let changed = false, sent = 0;
  for (const cid of Object.keys(C).slice(0, 40)){ const c = C[cid]; const age = now - c.at; if (age > 7 * 864e5){ delete C[cid]; changed = true; continue; } if (c.sent || age < 24 * 36e5) continue;
    try { const r = await fetch('https://themagesemporium.com/api/2025-07/graphql.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query($c:ID!){cart(id:$c){checkoutUrl totalQuantity lines(first:50){nodes{merchandise{... on ProductVariant{id product{title}}}}}}}', variables: { c: c.id } }) });
      const cart = ((await r.json()).data || {}).cart; c.sent = 1; changed = true; if (!cart || !cart.totalQuantity) { delete C[cid]; continue; }
      const since = new Date(c.at - 6e5).toISOString(); const o = await adm(env, `query($q:String){orders(first:1,query:$q){nodes{id}}}`, { q: `customer_id:${cid} AND created_at:>${since}` }); if (o.orders.nodes.length) { delete C[cid]; continue; }
      const vids = cart.lines.nodes.map(l => l.merchandise && l.merchandise.id).filter(Boolean).slice(0, 50); let last = null;
      if (vids.length){ const v = await adm(env, `query($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{inventoryQuantity product{title}}}}`, { ids: vids }); last = (v.nodes || []).find(x => x && x.inventoryQuantity === 1); }
      const n = cart.totalQuantity; const msg = last ? { t: '📚 Only one ' + last.product.title.slice(0, 50) + ' left!', b: `It’s still in your cart${n > 1 ? ` with ${n - 1} more` : ''}. Grab it before someone else does!`, u: cart.checkoutUrl, tag: 'cart' }
        : { t: '🛒 Your books are waiting!', b: `${n} ${n === 1 ? 'book is' : 'books are'} still in your cart at The Mage’s Emporium.`, u: cart.checkoutUrl, tag: 'cart' };
      sent += await sendTo(env, cid, msg, 'cart'); } catch(e){ await env.FRIENDS.put('cart:err', String(e && e.message || e).slice(0, 300), { expirationTtl: 7 * 86400 }); } }
  if (changed) await put(env, 'cart:idx', C); if (sent) await env.FRIENDS.put('cart:last', JSON.stringify({ at: now, sent }), { expirationTtl: 30 * 86400 }); }
async function runQueue(env){
  const r = await fetch(STOREFRONT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{shop{metafield(namespace:"mme_app",key:"push_queue"){value}}}' }) });
  const j = await r.json(); const raw = j.data && j.data.shop && j.data.shop.metafield && j.data.shop.metafield.value; if (!raw) return { sent: 0 };
  let Q = []; try { Q = JSON.parse(raw); } catch(e){ return { sent: 0 }; }
  let sent = 0; const now = Date.now();
  for (const it of Q.sort((a, b) => a.id - b.id)){
    if (it.s && +it.s > now) continue; // scheduled for later (e.g. Christmas morning)
    if (now - Math.max(+it.at || +it.id, +it.s || 0) > 3 * 864e5) continue; // too old
    const dk = 'push:done:' + it.id; if (await env.FRIENDS.get(dk)) continue; await env.FRIENDS.put(dk, '1', { expirationTtl: 10 * 86400 });
    const msg = { t: String(it.t || 'My Manga Emporium').slice(0, 80), b: String(it.b || '').slice(0, 200), u: it.u || '/', tag: it.k || 'mme' };
    if (it.h === '*'){ let cur; do { const l = await env.FRIENDS.list({ prefix: 'push:c:', cursor: cur }); for (const k of l.keys) sent += await sendTo(env, k.name.slice(7), msg, it.k); cur = l.list_complete ? null : l.cursor; } while (cur); }
    else { const cid = await env.FRIENDS.get('push:h:' + it.h); if (cid) sent += await sendTo(env, cid, msg, it.k); } }
  return { sent }; }

async function conNow(env){ let L = null; try { L = JSON.parse(await env.FRIENDS.get('cons') || 'null'); } catch(e){} if (!L){ L = []; try { const html = await (await fetch('https://themagesemporium.com/pages/upcoming-events')).text(); const MONS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']; html.split(/<\/p>|<br\s*\/?>|\n/i).map(x => x.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()).forEach(line => { const m = line.match(/^(.+?)\s+[-–—]\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}))?,?\s+(\d{4})/); if (!m) return; const mi = MONS.indexOf(m[2].toLowerCase().slice(0, 3)); if (mi < 0) return; const m2 = m[4] ? MONS.indexOf(m[4].toLowerCase().slice(0, 3)) : mi; L.push([Date.UTC(+m[6], mi, +m[3] - 1, 5), Date.UTC(+m[6], m2 < 0 ? mi : m2, (m[5] ? +m[5] : +m[3]) + 2, 5)]); }); } catch(e){} await env.FRIENDS.put('cons', JSON.stringify(L), { expirationTtl: 21600 }); } const now = Date.now(); return L.some(([s, e]) => now >= s && now < e); }
/* ---------- One-list wishlist (Nov 2026) ----------
   The list lives in each customer's Shopify metafield custom.store_wishlist (json):
     {updated, items:[{s: series, v: volume, ln: 1 for light novels, p: product id (optional), t: title (optional), at}], rm:[...], prefs:{email:'hourly'|'daily'|'off'}}
   The app reads/writes it directly (customer account). The website reaches it through the Shopify app proxy
   (themagesemporium.com/apps/mme/... -> this worker /proxy/..., signed by Shopify with the Mage Nightly app secret).
   Admin access: client-credentials token for the Mage Nightly app (env SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET).
   Alerts: every cron tick looks at products changed since the last tick; a wishlisted book that comes back in stock,
   or drops 10%+ in price, is queued for its wishers. Hourly folks get one email at the top of the hour, daily folks at 9am ET.
   Email goes through Resend (env RESEND_KEY) from alerts@mail.themagesemporium.com. App users with notifications on get a push right away.
   KV: adm:tok (Admin token)  wl:idx {keys:{key:[cid]}, pref:{cid:'hourly'|'daily'|'off'}, at}  wl:ps {key:[price, avail]}  wl:q {cid:[[kind,key,title,price,old,handle,img]]}  wl:last (ISO time of last product scan)  wl:sent:<hourbucket> */
const SHOPD = 'the-mages-emporium.myshopify.com', AV = '2026-10', SITE = 'https://themagesemporium.com';
async function admTok(env){ const t = await env.FRIENDS.get('adm:tok'); if (t) return t;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new Error('no-admin-secrets');
  const r = await fetch(`https://${SHOPD}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }) });
  const j = await r.json().catch(() => ({})); if (!j.access_token) throw new Error('admin-token ' + r.status);
  await env.FRIENDS.put('adm:tok', j.access_token, { expirationTtl: Math.max(600, (+j.expires_in || 86400) - 900) }); return j.access_token; }
async function adm(env, query, variables, tries){ tries = tries || 0; const r = await fetch(`https://${SHOPD}/admin/api/${AV}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': await admTok(env) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({})); if (r.status === 401) await env.FRIENDS.delete('adm:tok'); if (!j.data && tries < 3 && /THROTTLED/.test(JSON.stringify(j.errors || ''))){ await new Promise(res => setTimeout(res, 2500 * (tries + 1))); return adm(env, query, variables, tries + 1); } if (!j.data) throw new Error('admin ' + r.status + ' ' + JSON.stringify(j.errors || j).slice(0, 160)); return j.data; }
async function hmacHex(secret, msg){ const k = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function proxyCid(env, url){ // Shopify app proxy signature -> logged-in customer id ('' if logged out), or null if the request isn't from Shopify
  const q = new URLSearchParams(url.search); const sig = q.get('signature'); if (!sig || !env.SHOPIFY_CLIENT_SECRET) return null; q.delete('signature');
  const m = {}; for (const [k, v] of q) (m[k] = m[k] || []).push(v);
  const msg = Object.keys(m).sort().map(k => k + '=' + m[k].join(',')).join('');
  if (await hmacHex(env.SHOPIFY_CLIENT_SECRET, msg) !== sig) return null; if (Math.abs(Date.now() / 1000 - +q.get('timestamp')) > 3600) return null;
  return q.get('logged_in_customer_id') || ''; }
const wkey = it => it.s && +it.v ? String(it.s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + Math.round(+it.v) + (it.ln ? '|ln' : '') : it.p ? 'p:' + it.p : '';
const gid = cid => 'gid://shopify/Customer/' + cid;
async function wlGet(env, cid){ const d = await adm(env, `query($id:ID!){customer(id:$id){sw:metafield(namespace:"custom",key:"store_wishlist"){value}}}`, { id: gid(cid) });
  let w = {}; try { w = JSON.parse(d.customer && d.customer.sw && d.customer.sw.value || '{}') || {}; } catch(e){} if (!Array.isArray(w.items)) w.items = []; if (!Array.isArray(w.rm)) w.rm = []; w.prefs = w.prefs || {}; return w; }
async function wlPut(env, cid, w){ w.updated = new Date().toISOString(); w.rm = (w.rm || []).slice(-200);
  const d = await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: gid(cid), namespace: 'custom', key: 'store_wishlist', type: 'json', value: JSON.stringify(w) }] });
  const er = d.metafieldsSet.userErrors; if (er && er.length) throw new Error(er[0].message); await wlIndex(env, cid, w); return w; }
async function wlIndex(env, cid, w){ const X = (await get(env, 'wl:idx')) || { keys: {}, pref: {} }; X.keys = X.keys || {}; X.pref = X.pref || {};
  for (const k of Object.keys(X.keys)){ X.keys[k] = X.keys[k].filter(c => c !== cid); if (!X.keys[k].length) delete X.keys[k]; }
  for (const it of w.items){ const k = wkey(it); if (!k) continue; (X.keys[k] = X.keys[k] || []).push(cid); }
  X.pref[cid] = (w.prefs && w.prefs.email) || 'hourly'; await put(env, 'wl:idx', X); const R = (await get(env, 'wl:recent')) || {}; R[cid] = Date.now(); await put(env, 'wl:recent', R); }
// the website's heart, through the app proxy. GET -> {items,prefs}; POST {op:'add'|'rm', s,v,ln,p,t} | {op:'prefs', email} | {op:'merge', items:[...]} (guest hearts after login)
async function wlProxy(env, req, url){ const cid = await proxyCid(env, url); const JS = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (cid === null) return JS({ error: 'forbidden' }, 403); if (!cid) return JS({ login: true, items: [] });
  if (req.method !== 'POST') { const w = await wlGet(env, cid); return JS({ items: w.items, prefs: w.prefs }); }
  let b = {}; try { b = await req.json(); } catch(e){} const w = await wlGet(env, cid); const now = new Date().toISOString().slice(0, 10);
  const clean = it => { const o = {}; if (it.s && +it.v){ o.s = String(it.s).slice(0, 160); o.v = Math.round(+it.v * 10) / 10; if (it.ln) o.ln = 1; } if (it.p && /^\d+$/.test(String(it.p))) o.p = String(it.p); if (it.t) o.t = String(it.t).slice(0, 160); if (it.h && /^[a-z0-9-]+$/.test(String(it.h))) o.h = String(it.h).slice(0, 200); o.at = now; return wkey(o) ? o : null; };
  const has = k => w.items.findIndex(x => wkey(x) === k);
  if (b.op === 'add' || b.op === 'merge'){ for (const raw of (b.op === 'add' ? [b] : (Array.isArray(b.items) ? b.items.slice(0, 200) : []))){ const it = clean(raw); if (!it) continue; const k = wkey(it); if (has(k) < 0){ w.items.push(it); w.rm = w.rm.filter(x => wkey(x) !== k); } } }
  else if (b.op === 'rm'){ const it = clean(b); if (it){ const k = wkey(it); const pk = it.p ? 'p:' + it.p : ''; const before = w.items.length; w.items = w.items.filter(x => wkey(x) !== k && !(pk && x.p === it.p)); if (w.items.length !== before) w.rm.push({ s: it.s, v: it.v, ln: it.ln, p: it.p, at: now }); } }
  else if (b.op === 'prefs'){ if (['hourly', 'daily', 'off'].includes(b.email)) w.prefs.email = b.email; }
  else return JS({ error: 'bad op' }, 400);
  await wlPut(env, cid, w); return JS({ ok: 1, items: w.items, prefs: w.prefs }); }
// alert engine (called from the cron)
const ET_HOUR = () => +new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) % 24;
async function wlScan(env){ if (!env.SHOPIFY_CLIENT_ID) return { skip: 'no admin' };
  const X = await get(env, 'wl:idx'); if (!X || !X.keys) return { skip: 'no index' };
  const since = (await env.FRIENDS.get('wl:last')) || new Date(Date.now() - 15 * 60e3).toISOString(); const started = new Date().toISOString();
  const PS = (await get(env, 'wl:ps')) || {}; const Q = (await get(env, 'wl:q')) || {}; let changed = false, events = 0, a = null, pages = 0; const seen = {}; const seeded = !!(await env.FRIENDS.get('wl:seeded'));
  do { const d = await adm(env, `query($q:String,$a:String){products(first:100,after:$a,query:$q){pageInfo{hasNextPage endCursor} nodes{id title handle status productType totalInventory tags featuredMedia{preview{image{url}}} priceRangeV2{minVariantPrice{amount}} se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value}}}}`, { q: `updated_at:>'${since}'`, a });
    for (const n of d.products.nodes){ if ((n.tags || []).some(t => /shopify collective|zz delete/i.test(t))) continue; const pid = n.id.split('/').pop();
      const ln = /light novel|novel/i.test(n.productType || '') ? 1 : 0; const vol = n.vo && +n.vo.value || +(String(n.title).match(/\bvol(?:ume)?\.?\s*(\d+(?:\.\d)?)/i) || [])[1] || 0;
      const keys = ['p:' + pid]; if (n.se && n.se.value && vol) keys.push(wkey({ s: n.se.value, v: vol, ln }));
      const avail = n.status === 'ACTIVE' && n.totalInventory > 0, price = +n.priceRangeV2.minVariantPrice.amount;
      for (const k of keys){ if (seen[k]) continue; seen[k] = 1; const prev = PS[k];
        let kind = ''; if (avail && prev && !prev[1]) kind = 'back'; else if (avail && !prev && seeded) kind = 'new'; else if (avail && prev && prev[1] && price <= prev[0] * 0.9 + 0.001) kind = 'drop';
        const ref = prev && prev[1] && avail && kind !== 'drop' ? Math.max(price, prev[0]) : price; /* reference price only resets on a drop or a restock, so small cuts add up */
        if (!prev || prev[0] !== ref || prev[1] !== avail){ PS[k] = [ref, avail]; changed = true; }
        if (!kind || !X.keys[k]) continue;
        const ev = [kind, k, n.title, price, prev ? prev[0] : 0, n.handle, n.featuredMedia && n.featuredMedia.preview && n.featuredMedia.preview.image ? n.featuredMedia.preview.image.url : ''];
        for (const cid of X.keys[k]){ if (X.pref[cid] === 'off') continue; const L = Q[cid] = Q[cid] || []; if (!L.some(e => e[1] === k && e[0] === kind)) { L.push(ev); events++; }
          try { await sendTo(env, cid, { t: (kind === 'drop' ? '🏷️ Price drop: ' : '📚 Back in stock: ') + n.title.slice(0, 60), b: kind === 'drop' ? `Now $${price.toFixed(2)} (was $${(prev ? prev[0] : price).toFixed(2)})` : `$${price.toFixed(2)} at The Mage's Emporium`, u: SITE + '/products/' + n.handle, tag: 'wl-' + pid }, 'stock'); } catch(e){} } } }
    a = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null; pages++; } while (a && pages < 5);
  if (changed) await put(env, 'wl:ps', PS); if (events) await put(env, 'wl:q', Q); await env.FRIENDS.put('wl:last', started);
  const sent = await wlSend(env, Q, X); return { events, sent }; }
async function wlSend(env, Q, X){ const now = new Date(); if (now.getUTCMinutes() >= 10 || !env.RESEND_KEY) return 0; const bucket = 'wl:sent:' + now.toISOString().slice(0, 13); if (await env.FRIENDS.get(bucket)) return 0;
  const daily = ET_HOUR() === 9; const due = Object.keys(Q).filter(cid => Q[cid].length && (X.pref[cid] || 'hourly') !== 'off' && ((X.pref[cid] || 'hourly') === 'hourly' || daily)).slice(0, 100); if (!due.length) return 0;
  await env.FRIENDS.put(bucket, '1', { expirationTtl: 7200 });
  const d = await adm(env, `query($ids:[ID!]!){nodes(ids:$ids){... on Customer{id firstName defaultEmailAddress{emailAddress marketingState} sw:metafield(namespace:"custom",key:"store_wishlist"){value}}}}`, { ids: due.map(gid) });
  const mails = []; const done = [];
  for (const c of d.nodes || []){ if (!c) continue; const cid = c.id.split('/').pop(); const to = c.defaultEmailAddress && c.defaultEmailAddress.emailAddress; let pref = 'hourly'; try { pref = (JSON.parse(c.sw.value).prefs || {}).email || 'hourly'; } catch(e){}
    done.push(cid); if (!to || pref === 'off' || (pref === 'daily' && !daily)) { if (pref !== 'daily') continue; done.pop(); continue; }
    const ev = Q[cid]; const unsub = `https://mme-friends.themagesemporium.workers.dev/wl/unsub?c=${cid}&t=${(await hmacHex(env.SHOPIFY_CLIENT_SECRET, 'unsub:' + cid)).slice(0, 24)}`;
    const esc = s => String(s).replace(/[&<>"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
    const rows = ev.map(([kind, , title, price, old, handle, img]) => `<tr><td style="padding:8px 0;width:72px;vertical-align:top">${img ? `<img src="${esc(img)}&width=144" width="64" style="border-radius:6px;display:block">` : ''}</td><td style="padding:8px 0 8px 12px;vertical-align:top;font:15px/1.4 Arial,sans-serif;color:#1b2b4b"><a href="${SITE}/products/${esc(handle)}?utm_source=wishlist&utm_medium=email" style="color:#1b2b4b;font-weight:bold;text-decoration:none">${esc(title)}</a><br>${kind === 'drop' ? `<span style="color:#b4233b;font-weight:bold">Price drop: $${(+price).toFixed(2)}</span> <s style="color:#888">$${(+old).toFixed(2)}</s>` : `<span style="color:#2f7d4f;font-weight:bold">${kind === 'new' ? 'Now available' : 'Back in stock'}: $${(+price).toFixed(2)}</span>`}</td></tr>`).join('');
    const n = ev.length, subj = n === 1 ? (ev[0][0] === 'drop' ? 'Price drop on your wishlist: ' : 'Back in stock from your wishlist: ') + ev[0][2] : `${n} books on your wishlist are ready for you`;
    const html = `<div style="max-width:560px;margin:0 auto;padding:20px;font:15px/1.5 Arial,sans-serif;color:#1b2b4b"><p style="font-size:20px;font-weight:bold;margin:0 0 4px">Hi ${esc(c.firstName || 'there')}!</p><p style="margin:0 0 12px">Good news from The Mage's Emporium: ${n === 1 ? 'a book' : 'some books'} on your wishlist ${n === 1 ? 'is' : 'are'} ready for you. Used copies go fast!</p><table style="border-collapse:collapse;width:100%">${rows}</table><p style="margin:18px 0"><a href="${SITE}/pages/wishlist?utm_source=wishlist&utm_medium=email" style="background:#f0662b;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:bold">See your wishlist</a></p><p style="font-size:12px;color:#777">You're getting this because you hearted these books. Change how often you hear from us on your <a href="${SITE}/pages/wishlist" style="color:#777">wishlist page</a>, or <a href="${unsub}" style="color:#777">stop wishlist emails</a>.</p></div>`;
    mails.push({ from: "The Mage's Emporium <alerts@mail.themagesemporium.com>", to: [to], reply_to: 'themagesemporium@gmail.com', subject: subj.slice(0, 120), html, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }); }
  let sent = 0; if (mails.length){ const r = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' }, body: JSON.stringify(mails) }); if (r.ok) sent = mails.length; else { await env.FRIENDS.put('wl:err', (r.status + ' ' + (await r.text())).slice(0, 500), { expirationTtl: 7 * 86400 }); return 0; } }
  const Q2 = (await get(env, 'wl:q')) || {}; for (const cid of done) delete Q2[cid]; await put(env, 'wl:q', Q2); return sent; }
async function wlUnsub(env, url){ const cid = url.searchParams.get('c') || '', t = url.searchParams.get('t') || ''; const H = s => new Response(`<!doctype html><meta name=viewport content="width=device-width"><div style="font:16px Arial;max-width:480px;margin:40px auto;padding:0 16px">${s}</div>`, { headers: { 'content-type': 'text/html' } });
  if (!/^\d+$/.test(cid) || !env.SHOPIFY_CLIENT_SECRET || (await hmacHex(env.SHOPIFY_CLIENT_SECRET, 'unsub:' + cid)).slice(0, 24) !== t) return H('That link doesn’t look right.');
  const w = await wlGet(env, cid); w.prefs.email = 'off'; await wlPut(env, cid, w); return H('<b>Done.</b> You won’t get wishlist emails anymore. Your wishlist is still saved, and you can turn emails back on from your <a href="' + SITE + '/pages/wishlist">wishlist page</a>.'); }
// index rebuild: the nightly GitHub job writes the shop metafield mme_app.wl_index ({keys,pref}); load it when newer
async function wlLoadIndex(env){ const d = await adm(env, `{shop{metafield(namespace:"mme_app",key:"wl_index"){value updatedAt}}}`); const m = d.shop.metafield; if (!m) return 0;
  const cur = (await get(env, 'wl:idx')) || {}; if (cur.at && cur.at >= m.updatedAt) return 0; let H; try { H = JSON.parse(m.value); } catch(e){ return 0; }
  const n = Math.min(+H.parts || 0, 24); if (!n) return 0; const q = '{shop{' + [...Array(n).keys()].map(i => `p${i}:metafield(namespace:"mme_app",key:"wl_index${i}"){value}`).join(' ') + '}}';
  const P = (await adm(env, q)).shop; const keys = {}; for (let i = 0; i < n; i++){ try { Object.assign(keys, JSON.parse(P['p' + i].value)); } catch(e){ return 0; } }
  /* keep changes the worker saw since the nightly build (website hearts) */ const recent = (await get(env, 'wl:recent')) || {};
  const X = { keys, pref: H.pref || {}, at: m.updatedAt }; await put(env, 'wl:idx', X);
  for (const [cid, at] of Object.entries(recent)){ if (at < Date.parse(H.at || m.updatedAt)) delete recent[cid]; else { try { await wlIndex(env, cid, await wlGet(env, cid)); } catch(e){} } } await put(env, 'wl:recent', recent); return 1; }
// one-time baseline: remember every listing's price and stock (a few pages per tick) so the first alerts are real changes
async function wlSeed(env){ if (await env.FRIENDS.get('wl:seeded')) return 1; const PS = (await get(env, 'wl:ps')) || {}; let a = (await env.FRIENDS.get('wl:seedcur')) || null, pages = 0, done = false;
  do { const d = await adm(env, `query($a:String){products(first:250,after:$a,query:"-tag:'Shopify Collective'"){pageInfo{hasNextPage endCursor} nodes{id title status productType totalInventory priceRangeV2{minVariantPrice{amount}} se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value}}}}`, { a });
    for (const n of d.products.nodes){ const pid = n.id.split('/').pop(); const ln = /light novel|novel/i.test(n.productType || '') ? 1 : 0; const vol = n.vo && +n.vo.value || +(String(n.title).match(/\bvol(?:ume)?\.?\s*(\d+(?:\.\d)?)/i) || [])[1] || 0;
      const st = [+n.priceRangeV2.minVariantPrice.amount, n.status === 'ACTIVE' && n.totalInventory > 0]; PS['p:' + pid] = st; if (n.se && n.se.value && vol){ const k = wkey({ s: n.se.value, v: vol, ln }); if (!PS[k] || (st[1] && !PS[k][1])) PS[k] = st; } }
    a = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null; pages++; if (!a) done = true; } while (a && pages < 4);
  await put(env, 'wl:ps', PS); if (done){ await env.FRIENDS.put('wl:seeded', new Date().toISOString()); await env.FRIENDS.delete('wl:seedcur'); } else await env.FRIENDS.put('wl:seedcur', a); return done ? 1 : 0; }
async function wlTick(env){ try { if (!env.SHOPIFY_CLIENT_ID) return { skip: 'no admin' }; if (new Date().getUTCMinutes() < 10) await wlLoadIndex(env); if (!(await env.FRIENDS.get('wl:seeded'))){ await wlSeed(env); await env.FRIENDS.put('wl:last', new Date().toISOString()); return { seeding: 1 }; } return await wlScan(env); } catch(e){ await env.FRIENDS.put('wl:err', String(e).slice(0, 500), { expirationTtl: 7 * 86400 }); return { error: String(e) }; } }

/* ---------- AI features (Nov 2026): shelf scan, librarian, gift finder, vibe search, monthly wrap ----------
   Secret: env.ANTHROPIC_API_KEY (Megan adds it in Cloudflare → the worker → Settings → Variables and Secrets).
   Spending guard: shop metafield mme_app.ai_cfg {budget, off} (set from the Packing Desk); defaults budget 200.
   KV: ai:cat (in-stock catalog, built by the cron in chunks: ai:catb + ai:catcur)   ai:m:<YYYY-MM> {spent, calls, f:{feature:[n,cost]}, d:{day:cost}}
       ai:tot (spent since tracking began)  ai:log [last 60 calls]   ai:rl:<feature>:<who>:<day> (daily per-person limit)   ai:cfg (cached ai_cfg)
   The cron copies a summary to the shop metafield mme_app.ai_usage, which the Packing Desk reads. */
const AI_API = 'https://api.anthropic.com/v1/messages';
const AI_FAST = 'claude-haiku-5-5', AI_SMART = 'claude-sonnet-5-5';
const AI_PRICE = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10] }; // $ per million tokens (input, output)
const AI_LIMIT = { scan: 6, lib: 30, wrap: 4, gift: 20, search: 40, kid: 20, series: 20 }; // per person (or per visitor IP) per day
const AGES = ['all ages', 'teen', 'older teen', 'mature'];
const ageIx = a => { a = String(a || '').toLowerCase(); return a.includes('mature') ? 3 : a.includes('older') ? 2 : a.includes('teen') ? 1 : a.includes('all') ? 0 : 1; };
const ymd = () => new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10); // Eastern-ish day
async function aiCfg(env){ let c = await get(env, 'ai:cfg'); if (c) return c; c = { budget: 200, off: false };
  try { const d = await adm(env, '{shop{metafield(namespace:"mme_app",key:"ai_cfg"){value}}}'); const v = d.shop.metafield && JSON.parse(d.shop.metafield.value); if (v){ if (+v.budget > 0) c.budget = +v.budget; c.off = !!v.off; } } catch(e){}
  await env.FRIENDS.put('ai:cfg', JSON.stringify(c), { expirationTtl: 600 }); return c; }
async function aiLimit(env, feat, who){ const k = `ai:rl:${feat}:${who}:${ymd()}`; const n = +(await env.FRIENDS.get(k) || 0); if (n >= (AI_LIMIT[feat] || 20)) return false; await env.FRIENDS.put(k, String(n + 1), { expirationTtl: 2 * 86400 }); return true; }
class AiErr extends Error { constructor(code, msg){ super(msg); this.code = code; } }
async function aiCall(env, feat, { model = AI_FAST, system, messages, max_tokens = 1200 }){
  if (!env.ANTHROPIC_API_KEY) throw new AiErr('setup', 'The book helper isn’t switched on yet.');
  const cfg = await aiCfg(env); const mk = ymd().slice(0, 7); const M = (await get(env, 'ai:m:' + mk)) || { spent: 0, calls: 0, f: {}, d: {} };
  if (cfg.off) throw new AiErr('paused', 'The book helper is taking a break. Please try again later!');
  if (M.spent >= cfg.budget) throw new AiErr('budget', 'The book helper is resting until next month. Please try again later!');
  const r = await fetch(AI_API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: max_tokens + 3000, system, messages, output_config: { effort: 'low' } }) }); // room for adaptive thinking, which counts toward max_tokens
  const j = await r.json().catch(() => ({}));
  if (!r.ok){ await env.FRIENDS.put('ai:err', (r.status + ' ' + JSON.stringify(j).slice(0, 400)), { expirationTtl: 7 * 86400 }); throw new AiErr('api', 'The book helper hit a snag. Please try again in a minute.'); }
  const u = j.usage || {}; const P = AI_PRICE[model] || [2, 10]; const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  const cost = (inTok * P[0] + (u.output_tokens || 0) * P[1]) / 1e6;
  const day = ymd(); M.spent = +(M.spent + cost).toFixed(6); M.calls++; const F = M.f[feat] || [0, 0]; M.f[feat] = [F[0] + 1, +(F[1] + cost).toFixed(6)]; M.d[day] = +((M.d[day] || 0) + cost).toFixed(6);
  M.log = (M.log || []).concat([[Date.now(), feat, model === AI_FAST ? 'H' : 'S', u.input_tokens || 0, u.output_tokens || 0, +cost.toFixed(5)]]).slice(-60);
  await put(env, 'ai:m:' + mk, M);
  const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  await env.FRIENDS.put('ai:last', JSON.stringify({ feat, at: Date.now(), stop: j.stop_reason, types: (j.content || []).map(c => c.type), usage: u, text: out.slice(0, 600) }), { expirationTtl: 86400 });
  if (!out.trim()) throw new AiErr('api', 'The book helper hit a snag. Please try again in a minute.'); return out; }
const aiJSON = t => { const s = String(t || ''); const a = s.search(/[\[{]/); if (a < 0) return null; const close = s[a] === '[' ? ']' : '}';
  /* the first complete JSON value wins, so anything the model writes after it (second thoughts, stray tags) is ignored */
  for (let b = s.indexOf(close, a); b > -1; b = s.indexOf(close, b + 1)){ try { return JSON.parse(s.slice(a, b + 1)); } catch(e){} } return null; };
const aiPlain = t => { const s = String(t || ''); const cut = s.search(/[\[{<]/); return (cut < 0 ? s : s.slice(0, cut)).trim(); };

/* ---- catalog of in-stock books (own Manga + Light Novels + sets), rebuilt about hourly by the cron ---- */
const CAT_Q = `query($a:String){products(first:100,after:$a,query:"status:active AND inventory_total:>0 AND published_status:published AND (product_type:Manga OR product_type:'Light Novel') AND -tag:'Shopify Collective' AND -tag:'Mystery Box'"){pageInfo{hasNextPage endCursor} nodes{legacyResourceId title handle productType tags priceRangeV2{minVariantPrice{amount}} variants(first:1){nodes{legacyResourceId}} featuredMedia{preview{image{url(transform:{maxWidth:300})}}}
  se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} g1:metafield(namespace:"custom",key:"genre"){value} gs:metafield(namespace:"custom",key:"genres"){value} th:metafield(namespace:"custom",key:"themes"){value}
  sp:metafield(namespace:"custom",key:"spice_level"){value} gr:metafield(namespace:"custom",key:"gentle_read"){value} ss:metafield(namespace:"custom",key:"series_status"){value} au:metafield(namespace:"custom",key:"author"){value} an:metafield(namespace:"custom",key:"has_anime"){value} cn:metafield(namespace:"custom",key:"content_notes"){value} sv:metafield(namespace:"custom",key:"series_volumes"){value}}}}`;
const lst = v => { if (!v) return ''; try { const a = JSON.parse(v); return Array.isArray(a) ? a.join(', ') : String(v); } catch(e){ return String(v); } };
async function catTick(env){ if (!env.SHOPIFY_CLIENT_ID) return; const have = await env.FRIENDS.get('ai:catat'); const building = await env.FRIENDS.get('ai:catcur');
  if (!building && have && Date.now() - +have < 50 * 60e3) return; // fresh enough
  let cur = building && building !== 'start' ? building : null; let B = building ? ((await get(env, 'ai:catb')) || []) : [];
  for (let i = 0; i < 8; i++){ if (i) await new Promise(r => setTimeout(r, 4000)); // each page costs ~190 query points: pace them so Shopify doesn't throttle
    let d; for (let t = 0; ; t++){ try { d = await adm(env, CAT_Q, { a: cur }); break; } catch(e){ if (!/THROTTLED/.test(String(e)) || t >= 3) throw e; await new Promise(r => setTimeout(r, 8000 * (t + 1))); } } const p = d.products;
    for (const n of p.nodes){ const tags = n.tags || []; B.push({ i: n.legacyResourceId, vid: n.variants.nodes[0] && n.variants.nodes[0].legacyResourceId, t: n.title, h: n.handle, p: +(+n.priceRangeV2.minVariantPrice.amount).toFixed(2), s: (n.se && n.se.value) || n.title.replace(/\s+(Vol|Volume)\b.*$/i, ''), v: n.vo ? +n.vo.value : null,
      a: ageIx(n.ag && n.ag.value), g: [n.g1 && n.g1.value, lst(n.gs && n.gs.value)].filter(Boolean).join(', '), th: lst(n.th && n.th.value), sp: n.sp ? parseInt(n.sp.value) || 0 : 0, gr: n.gr && n.gr.value === 'true' ? 1 : 0, st: (n.ss && n.ss.value) || '', au: (n.au && n.au.value) || '', an: n.an && n.an.value === 'true' ? 1 : 0, cn: lst(n.cn && n.cn.value), sv: n.sv ? +n.sv.value : 0,
      hd: ((tags.find(t => /^Haul-\d{4}-\d{2}$/.test(t)) || '').replace(/^Haul-(\d\d)(\d\d)-(\d\d)$/, '20$1-$2-$3')) || '', set: tags.includes('Bundle') ? 1 : 0, ln: n.productType === 'Light Novel' ? 1 : 0, img: n.featuredMedia && n.featuredMedia.preview && n.featuredMedia.preview.image ? n.featuredMedia.preview.image.url : '' }); }
    if (!p.pageInfo.hasNextPage){ await put(env, 'ai:cat', B); await env.FRIENDS.put('ai:catat', String(Date.now())); await env.FRIENDS.delete('ai:catcur'); const oe = await env.FRIENDS.get('ai:err'); if (oe && /^catalog/.test(oe)) await env.FRIENDS.delete('ai:err'); await env.FRIENDS.delete('ai:catb'); return { done: B.length }; }
    cur = p.pageInfo.endCursor; }
  await put(env, 'ai:catb', B); await env.FRIENDS.put('ai:catcur', cur, { expirationTtl: 3 * 3600 }); return { building: B.length }; }
async function aiCat(env){ const c = await get(env, 'ai:cat'); if (!c || !c.length) throw new AiErr('setup', 'The book helper is still learning the shelves. Try again in an hour!'); return c; }
/* one row per series: its set if there is one (and it fits the budget), else its lowest in-stock volume */
function bySeries(cat, keep){ const S = {}; for (const b of cat){ if (keep && !keep(b)) continue; const k = (b.s + (b.ln ? '|ln' : '')).toLowerCase(); const o = S[k] || (S[k] = { k, s: b.s, ln: b.ln, a: b.a, g: b.g, th: b.th, sp: b.sp, gr: b.gr, st: b.st, au: b.au, an: b.an, cn: b.cn, sv: b.sv, items: [] }); o.items.push(b); if (!o.g && b.g) o.g = b.g; if (!o.th && b.th) o.th = b.th; }
  return Object.values(S); }
const words = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^(the|and|for|with|that|like|something|some|want|looking|manga|books?|read|reads|series|about|who|she|her|his|they|them|love|loves|really|very|good|great|into|more|any|not|but|have|has|from|kid|son|daughter|year|years|old)$/.test(w));
function scoreSeries(o, W, F){ let sc = 0; const hay = (o.s + ' ' + o.g + ' ' + o.th + ' ' + o.au).toLowerCase(); for (const w of W){ if (hay.includes(w)) sc += o.g.toLowerCase().includes(w) || o.th.toLowerCase().includes(w) ? 3 : 2; }
  for (const g of (F.genres || [])) if (o.g.toLowerCase().includes(String(g).toLowerCase())) sc += 4;
  for (const g of (F.themes || [])) if ((o.th + ' ' + o.g).toLowerCase().includes(String(g).toLowerCase())) sc += 3;
  if (F.gentle && o.gr) sc += 3; if (F.complete && /complete/i.test(o.st)) sc += 2; if (F.anime && o.an) sc += 2;
  if (o.items.some(b => b.set)) sc += 1; if (o.items.some(b => b.v === 1)) sc += 1; return sc + Math.min(o.items.length, 10) * 0.05; }
function pickItem(o, budget){ const sets = o.items.filter(b => b.set && (!budget || b.p <= budget)).sort((a, b) => b.p - a.p); const v1 = o.items.filter(b => !b.set).sort((a, b) => (a.v || 99) - (b.v || 99));
  return { set: sets[0] || null, first: v1[0] || null }; }
function filterSeries(cat, F, W){ const maxA = F.age_max == null ? 3 : F.age_max; const L = bySeries(cat, b => b.a <= maxA && (F.spice_max == null || b.sp <= F.spice_max) && (!F.max_price || b.p <= F.max_price) && (F.format === 'ln' ? b.ln : F.format === 'manga' ? !b.ln : true));
  const ex = new Set((F.exclude || []).map(x => String(x).toLowerCase())); return L.filter(o => !ex.has(o.s.toLowerCase()) && (F.japanese || !o.items.every(b => /japanese/i.test(b.t))) && (!F.needStart || o.items.some(b => b.set || b.v == null || b.v <= 1))).map(o => [scoreSeries(o, W, F), o]).sort((a, b) => b[0] - a[0]); }
const line = (o, n, budget) => { const { set, first } = pickItem(o, budget); const a = []; if (first) a.push(`v${first.v || 1}:$${first.p}`); if (set) a.push(`set:${set.t.replace(/^.*?(Vol \S+)/, '$1')}:$${set.p}`);
  return `${n}|${o.s}${o.ln ? ' (light novel)' : ''}|${AGES[o.a]}|${o.g}${o.th ? ' / ' + o.th : ''}|spice ${o.sp || '-'}${o.gr ? '|gentle' : ''}|${o.st || ''}${o.sv ? ' ' + o.sv + ' vols' : ''}${o.an ? '|anime' : ''}|${o.items.filter(b => !b.set).length} in stock|${a.join(' ')}`; };
const card = (b, why) => b && { id: b.i, vid: b.vid, title: b.t, handle: b.h, price: b.p, img: b.img, set: b.set, ln: b.ln, series: b.s, vol: b.v, why: why || '' };
const SHOP_VOICE = 'You are the friendly bookseller at The Mage’s Emporium, a small family-run used manga shop in South Carolina. Be warm, upbeat and brief (no more than 2 short sentences per book). Never invent books: only recommend from the CATALOG lines given, by their number. Respect the age ratings given. In each reason, only state facts that are in that book’s catalog line or that you are certain of; never guess plot details. Write reasons the way a friendly bookseller talks, about what makes it fun or a good fit (the vibe, the genre, a finished series, a set that saves money); don’t recite spice numbers, ratings or volume counts unless they answer what the shopper asked.';
async function rankWithAI(env, feat, ask, rows, n, budget){ const T = await aiCall(env, feat, { system: SHOP_VOICE + ` Reply with JSON only: {"intro":"one short friendly sentence","picks":[{"n":<catalog number>,"pick":"set"|"first","why":"short reason"}]} with up to ${n} picks, best first.`, messages: [{ role: 'user', content: `${ask}\n\nCATALOG (number|series|age|genres / themes|spice 1-5|status|in stock|prices):\n${rows.map(([, o], i) => line(o, i + 1, budget)).join('\n')}` }], max_tokens: 1400 });
  const J = aiJSON(T) || {}; const out = []; for (const p of (J.picks || [])){ const r = rows[(+p.n || 0) - 1]; if (!r) continue; const { set, first } = pickItem(r[1], budget); const b = p.pick === 'set' && set ? set : first || set; if (b && !out.some(x => x.id === b.i)) out.push(card(b, String(p.why || '').slice(0, 240))); if (out.length >= n) break; }
  return { intro: String(J.intro || '').slice(0, 300), picks: out }; }
async function parseWish(env, feat, q){ // free text -> filters
  const T = await aiCall(env, feat, { system: 'Turn a manga shopper’s request into search filters. Reply with JSON only: {"keywords":[...],"genres":[...],"themes":[...],"age_max":0-3 or null (0 all ages,1 teen,2 older teen,3 mature),"spice_max":1-5 or null,"gentle":bool,"complete":bool,"anime":bool,"format":"manga"|"ln"|null,"max_price":number or null,"exclude":[series names to leave out]}. Genres/themes use common manga words (romance, fantasy, isekai, horror, comedy, slice of life, shojo, shonen, BL, yuri, sports, mystery, action, sci-fi, found family, enemies to lovers, cozy, magic, school, workplace...). "No spice/clean" = spice_max 1; "a little romance" = spice_max 2.', messages: [{ role: 'user', content: String(q).slice(0, 600) }], max_tokens: 300 });
  return aiJSON(T) || {}; }

async function aiRoute(env, req, p, whoKey, me){ let b = {}; if (req.method === 'POST'){ try { b = await req.json(); } catch(e){} }
  const feat = p.split('/').pop(); if (!AI_LIMIT[feat]) return J({ error: 'not found' }, 404);
  if (!(await aiLimit(env, feat, whoKey))) return J({ error: 'That’s the limit for today. Come back tomorrow!', code: 'limit' }, 429);
  try {
    if (feat === 'scan'){ if (!me) return J({ error: 'Log in first' }, 401); const img = String(b.img || ''); if (!/^[A-Za-z0-9+/=]{1000,}$/.test(img) || img.length > 7e6) return J({ error: 'Please try a smaller photo.' }, 400);
      const T = await aiCall(env, 'scan', { model: AI_SMART, max_tokens: 3000, system: 'You read manga and light novel spines in shelf photos. List every book whose spine you can read. Reply with JSON only: {"books":[{"series":"English series title as printed","vol":number or null,"ln":true if a light novel,"sure":true or false}]}. One entry per physical book; if a volume number is unreadable use null and sure:false. Skip non-book items.', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: String(b.type || 'image/jpeg').replace(/[^a-z/]/g, ''), data: img } }, { type: 'text', text: 'Read the spines in this photo.' }] }] });
      const Jb = aiJSON(T) || {}; return J({ books: (Jb.books || []).slice(0, 200).map(x => ({ series: String(x.series || '').slice(0, 160), vol: x.vol == null ? null : +x.vol, ln: !!x.ln, sure: x.sure !== false })) }); }
    if (feat === 'series') return await aiSeries(env, b);
    if (feat === 'kid'){ const pid = String(b.pid || '').replace(/\D/g, ''); const q = String(b.q || '').trim().slice(0, 400); if (!pid || q.length < 3) return J({ error: 'Type your question first!' }, 400);
      const d = await adm(env, `query($id:ID!){product(id:$id){title productType status descriptionHtml ag:metafield(namespace:"custom",key:"age_rating"){value} cn:metafield(namespace:"custom",key:"content_notes"){value} sp:metafield(namespace:"custom",key:"spice_level"){value} g1:metafield(namespace:"custom",key:"genre"){value} gs:metafield(namespace:"custom",key:"genres"){value} th:metafield(namespace:"custom",key:"themes"){value} gr:metafield(namespace:"custom",key:"gentle_read"){value} se:metafield(namespace:"custom",key:"series"){value} au:metafield(namespace:"custom",key:"author"){value}}}`, { id: 'gid://shopify/Product/' + pid });
      const P = d.product; if (!P || P.status !== 'ACTIVE') return J({ error: 'We couldn’t find that book.' }, 404);
      const facts = `Title: ${P.title}\nSeries: ${(P.se && P.se.value) || ''}\nAuthor: ${(P.au && P.au.value) || ''}\nType: ${P.productType}\nAge rating: ${(P.ag && P.ag.value) || 'not listed'}\nGenres: ${[(P.g1 && P.g1.value), lst(P.gs && P.gs.value)].filter(Boolean).join(', ')}\nThemes: ${lst(P.th && P.th.value) || 'not listed'}\nContent notes: ${lst(P.cn && P.cn.value) || 'none listed'}\nSpice level (romance/sexual content, 1 Sweet to 5 Ghost Pepper): ${(P.sp && P.sp.value) || 'not listed'}\nGentle read: ${P.gr && P.gr.value === 'true' ? 'yes' : 'no'}\nDescription: ${String(P.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 900)}`;
      const T = await aiCall(env, 'kid', { max_tokens: 400, system: 'You help parents and gift-givers at The Mage’s Emporium, a family-run manga shop, decide whether a book suits a young reader. Answer in 2-4 short, warm, plain sentences. Base the answer on the BOOK FACTS (age rating, content notes, spice level, themes) and what is widely known about the series; say which facts you used. Don’t mention missing or unset fields (like a gentle-read flag). Be honest about anything a parent may want to know (violence, romance, language, scary scenes) without being graphic. Never promise it is perfect for a specific child: suggest the parent flip through it if they are unsure. If the question is not about this book’s suitability or content, answer briefly and kindly steer back. Plain text only, no lists or markdown.', messages: [{ role: 'user', content: `BOOK FACTS\n${facts}\n\nQUESTION: ${q}` }] });
      return J({ answer: String(T || '').trim().slice(0, 1200) }); }
    const cat = await aiCat(env);
    if (feat === 'search'){ const q = String(b.q || '').trim(); if (q.length < 3) return J({ error: 'Tell us a little more!' }, 400); const F = await parseWish(env, 'search', q); if (b.age_max != null) F.age_max = Math.min(+b.age_max, F.age_max == null ? 3 : F.age_max);
      F.needStart = !/\bvol(ume)?\s*[2-9]|next volume|continue/i.test(q); F.japanese = /japanese/i.test(q); const W = [...new Set(words(q).concat(F.keywords || []).map(w => String(w).toLowerCase()))]; const rows = filterSeries(cat, F, W).slice(0, 70);
      return J(await rankWithAI(env, 'search', `Shopper asked: "${q.slice(0, 400)}". Pick the best matches.`, rows, 12, F.max_price)); }
    if (feat === 'gift'){ const ageMap = { kid: 0, tween: 1, teen: 1, older: 2, adult: 3 }; const F = { age_max: ageMap[b.who] ?? 1, spice_max: b.who === 'adult' ? (b.spicy ? 5 : 3) : b.who === 'older' ? 3 : 2, max_price: +b.budget || null, genres: [], themes: [], needStart: true };
      const likes = String(b.likes || '').slice(0, 500); const W = words(likes + ' ' + (b.chips || []).join(' ')); const rows = filterSeries(cat, F, W).slice(0, 70);
      const ask = `Gift for ${({ kid: 'a kid (under 10)', tween: 'a tween (10–12)', teen: 'a teen (13–15)', older: 'an older teen (16–17)', adult: 'an adult' })[b.who] || 'a teen'}. They like: ${likes || 'not sure'} ${(b.chips || []).join(', ')}. Budget about $${+b.budget || 40}. ${b.newbie ? 'They are NEW to manga: favor complete short series, Vol 1 or sets.' : 'They already read manga: favor fresh picks.'} The shopper may not know manga, so explain each pick simply. Pick up to 6; picks marked "set" must fit the budget.`;
      return J(await rankWithAI(env, 'gift', ask, rows, 6, +b.budget || null)); }
    if (feat === 'lib'){ if (!me) return J({ error: 'Log in first' }, 401); const msg = String(b.msg || '').slice(0, 600); const sh = b.shelf || {}; const own = (sh.own || []).slice(0, 400).map(String);
      const ownL = new Set(own.map(x => x.toLowerCase())); const liked = (sh.top || []).slice(0, 15).map(String); const likedSet = new Set(liked.map(x => x.toLowerCase()));
      const likeG = {}; for (const o of bySeries(cat)) if (likedSet.has(o.s.toLowerCase())) String(o.g + ',' + o.th).split(/,\s*/).filter(Boolean).forEach(g => likeG[g.toLowerCase()] = (likeG[g.toLowerCase()] || 0) + 1);
      const F = { genres: Object.entries(likeG).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]), exclude: own, age_max: sh.age_max != null ? +sh.age_max : 3 };
      const W = words(msg); const rows = filterSeries(cat, F, W).slice(0, 60);
      const next = []; const last = sh.last || {}; for (const [ser, mx] of Object.entries(last).slice(0, 300)){ const hit = cat.find(x => !x.set && x.s.toLowerCase() === ser.toLowerCase() && x.v === +mx + 1); if (hit) next.push(hit); }
      const hist = (Array.isArray(b.hist) ? b.hist : []).slice(-6).map(h => ({ role: h.r === 'me' ? 'user' : 'assistant', content: String(h.t || '').slice(0, 800) })).filter(h => h.content);
      const ctx = `READER PROFILE: favorites: ${liked.join('; ') || 'not rated yet'}. Owns ${own.length} series. Wishlist: ${(sh.want || []).slice(0, 20).join('; ')}. Recently read: ${(sh.recent || []).slice(0, 10).join('; ')}.\nNEXT VOLUMES IN STOCK for series they own (mention if useful, as N1, N2...):\n${next.slice(0, 15).map((x, i) => `N${i + 1}|${x.t}|$${x.p}`).join('\n') || 'none'}\nCATALOG (series they don't own yet; number|series|age|genres / themes|spice|status|stock|prices):\n${rows.map(([, o], i) => line(o, i + 1)).join('\n')}`;
      const T = await aiCall(env, 'lib', { model: AI_SMART, max_tokens: 1200, system: SHOP_VOICE + ' You are chatting in the shop’s reading app as "the Librarian". Answer their message helpfully and conversationally (2-5 sentences), then recommend up to 4 books. Reply with JSON only: {"say":"your reply","picks":[{"n":<catalog number or "N1" style>,"pick":"set"|"first","why":"short reason tied to what they like"}]}. If they ask about something that isn’t books, gently steer back to manga.', messages: hist.concat([{ role: 'user', content: ctx + '\n\nTHEIR MESSAGE: ' + (msg || 'What should I read next?') }]) });
      const Jl = aiJSON(T) || { say: aiPlain(T).slice(0, 800), picks: [] }; const picks = [];
      for (const p of (Jl.picks || [])){ let bk = null; if (/^N\d+$/i.test(String(p.n))) bk = next[+String(p.n).slice(1) - 1]; else { const r = rows[(+p.n || 0) - 1]; if (r){ const { set, first } = pickItem(r[1]); bk = p.pick === 'set' && set ? set : first || set; } } if (bk && !picks.some(x => x.id === bk.i)) picks.push(card(bk, String(p.why || '').slice(0, 240))); if (picks.length >= 4) break; }
      return J({ say: String(Jl.say || '').slice(0, 1200), picks }); }
    if (feat === 'wrap'){ if (!me) return J({ error: 'Log in first' }, 401); const s = b.stats || {};
      const T = await aiCall(env, 'wrap', { max_tokens: 300, system: 'You write a fun, kind end-of-month reading recap for a manga reader. Reply with JSON only: {"title":"a playful 2-4 word reader title (like \\"Midnight Page-Turner\\" or \\"Shojo Sorceress\\")","blurb":"one upbeat sentence about their month, 25 words max"}. Never shame a slow month; celebrate any reading.', messages: [{ role: 'user', content: JSON.stringify(s).slice(0, 2000) }] });
      const Jw = aiJSON(T) || {}; return J({ title: String(Jw.title || 'Manga Adventurer').slice(0, 40), blurb: String(Jw.blurb || '').slice(0, 220) }); }
  } catch(e){ return J({ error: e.code ? e.message : 'Something went wrong. Please try again.', code: e.code || 'err' }, e.code === 'setup' || e.code === 'budget' || e.code === 'paused' ? 503 : 500); }
  return J({ error: 'not found' }, 404); }
/* the website reaches the AI through the Shopify app proxy (/apps/mme/ai/<feature> -> /proxy/ai/<feature>) */
async function aiProxy(env, req, url){ const cid = await proxyCid(env, url); if (cid === null) return new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
  const feat = url.pathname.split('/').pop(); if (feat !== 'gift' && feat !== 'search' && feat !== 'kid' && feat !== 'series') return new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  const whoKey = cid ? 'c' + cid : 'ip' + (await sha(req.headers.get('cf-connecting-ip') || 'x')).slice(0, 16);
  const r = await aiRoute(env, req, '/ai/' + feat, whoKey, null); return new Response(r.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); } // always 200: Shopify swaps error statuses for its own error page
/* hourly copy of the spend summary to the shop metafield mme_app.ai_usage (the Packing Desk reads it) */
async function aiFlush(env){ if (!env.SHOPIFY_CLIENT_ID) return; const last = +(await env.FRIENDS.get('ai:flushat') || 0); if (Date.now() - last < 55 * 60e3) return;
  const months = {}; let log = []; const now = new Date(); for (let i = 0; i < 6; i++){ const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15)); const mk = d.toISOString().slice(0, 7); const M = await get(env, 'ai:m:' + mk); if (M){ months[mk] = { spent: M.spent, calls: M.calls, f: M.f, d: M.d }; log = log.concat(M.log || []); } }
  log.sort((a, b) => b[0] - a[0]); const cfg = await aiCfg(env);
  const val = { updated: new Date().toISOString(), months, log: log.slice(0, 60), budget: cfg.budget, off: cfg.off, cat: (await env.FRIENDS.get('ai:catat')) || null, err: await env.FRIENDS.get('ai:err'), key: !!env.ANTHROPIC_API_KEY };
  const sid = (await adm(env, '{shop{id}}')).shop.id; const d = await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: sid, namespace: 'mme_app', key: 'ai_usage', type: 'json', value: JSON.stringify(val) }] });
  if (d.metafieldsSet.userErrors.length) await env.FRIENDS.put('ai:err', 'flush ' + d.metafieldsSet.userErrors[0].message, { expirationTtl: 86400 }); await env.FRIENDS.put('ai:flushat', String(Date.now())); }

/* ---- nightly listing fixer (about 3am Eastern): fills missing themes / spice / content notes / anime info on new own listings when Haiku is confident; flags the rest.
   Result: shop metafield mme_app.ai_fixes {at, fixed:[[title, fields]], flags:[[title, why]]} (the Desk To-Do tab shows it). Same values go to every volume of the series that lacks them. */
const SPICE = ['1 Sweet', '2 Ketchup', '3 Salsa', '4 Hot Sauce', '5 Ghost Pepper'];
const NOTES = ['Graphic violence/gore', 'Strong language', 'Sexual content', 'Nudity', 'Sexual assault', 'Abuse', 'Self-harm/suicide', 'Drug use', 'Animal harm', 'Death of a loved one', 'Disturbing imagery'];
async function aiFixer(env){ if (!env.SHOPIFY_CLIENT_ID || !env.ANTHROPIC_API_KEY) return; const h = new Date().getUTCHours(); if (h !== 8) return; const day = ymd(); if (await env.FRIENDS.get('ai:fix:' + day)) return; await env.FRIENDS.put('ai:fix:' + day, '1', { expirationTtl: 3 * 86400 });
  const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const F = `id title productType status s:metafield(namespace:"custom",key:"series"){value} au:metafield(namespace:"custom",key:"author"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} g1:metafield(namespace:"custom",key:"genre"){value} gs:metafield(namespace:"custom",key:"genres"){value} th:metafield(namespace:"custom",key:"themes"){value} sp:metafield(namespace:"custom",key:"spice_level"){value} cn:metafield(namespace:"custom",key:"content_notes"){value} an:metafield(namespace:"custom",key:"has_anime"){value}`;
  const d = await adm(env, `{products(first:120,query:"created_at:>${since} AND (product_type:Manga OR product_type:'Light Novel') AND -tag:'Shopify Collective' AND -tag:Bundle"){nodes{${F}}}}`);
  const S = {}; for (const p of d.products.nodes){ const k = ((p.s && p.s.value) || p.title.replace(/\s+(Vol|Volume)\b.*$/i, '')) + '|' + p.productType; (S[k] = S[k] || []).push(p); }
  const fixed = [], flags = []; let n = 0;
  for (const [k, ps] of Object.entries(S)){ if (n >= 8) break; const [series, type] = k.split('|');
    const sib = (await adm(env, `query($q:String!){products(first:60,query:$q){nodes{${F}}}}`, { q: `title:${JSON.stringify(series)} AND product_type:${JSON.stringify(type)} AND -tag:'Shopify Collective'` })).products.nodes.filter(p => (p.s ? p.s.value : '') === series || p.title.startsWith(series));
    const all = sib.length ? sib : ps; const pick = f => (all.find(p => p[f] && p[f].value) || {})[f];
    const age = pick('ag') && pick('ag').value || '', genre = [pick('g1') && pick('g1').value, pick('gs') && lst(pick('gs').value)].filter(Boolean).join(', ');
    const romance = /romance|bl\b|boys.? love|yaoi|yuri|shojo|josei/i.test(genre);
    const need = { themes: !pick('th'), spice: !pick('sp') && romance, notes: !pick('cn') && /older teen|mature/i.test(age), anime: !pick('an') };
    if (!Object.values(need).some(Boolean)) continue; n++;
    const T = await aiCall(env, 'fix', { max_tokens: 500, system: `You fill in missing catalog info for a used manga shop. Use only what you reliably know about this exact English-published series. Reply with JSON only: {"known":true|false,"confidence":"high"|"low","themes":[up to 5 short themes like "found family","isekai","enemies to lovers","school life","revenge"],"spice":one of ${JSON.stringify(SPICE)} or null,"notes":[any of ${JSON.stringify(NOTES)}],"has_anime":true|false|null,"anime_title":"" ,"why":"one short sentence"}. Spice is only about sexual content (no sexual content = "1 Sweet"). If you are not sure you know this series, set known false.`, messages: [{ role: 'user', content: `Series: ${series}\nType: ${type}\nAuthor: ${pick('au') ? pick('au').value : ''}\nAge rating: ${age}\nGenres: ${genre}\nNeeded: ${Object.keys(need).filter(x => need[x]).join(', ')}` }] });
    const R = aiJSON(T) || {}; if (!R.known || R.confidence !== 'high'){ flags.push([series, 'Not sure about: ' + Object.keys(need).filter(x => need[x]).join(', ') + (R.why ? ' (' + String(R.why).slice(0, 120) + ')' : '')]); continue; }
    const M = [], got = [];
    for (const p of all){ if (need.themes && !(p.th && p.th.value) && Array.isArray(R.themes) && R.themes.length){ M.push({ ownerId: p.id, namespace: 'custom', key: 'themes', value: JSON.stringify(R.themes.slice(0, 5).map(x => String(x).slice(0, 40))) }); }
      if (need.spice && !(p.sp && p.sp.value) && SPICE.includes(R.spice)) M.push({ ownerId: p.id, namespace: 'custom', key: 'spice_level', value: R.spice });
      if (need.notes && !(p.cn && p.cn.value) && Array.isArray(R.notes)){ const v = R.notes.filter(x => NOTES.includes(x)); if (v.length) M.push({ ownerId: p.id, namespace: 'custom', key: 'content_notes', value: JSON.stringify(v) }); }
      if (need.anime && !(p.an && p.an.value) && typeof R.has_anime === 'boolean'){ M.push({ ownerId: p.id, namespace: 'custom', key: 'has_anime', value: String(R.has_anime) }); if (R.has_anime && R.anime_title) M.push({ ownerId: p.id, namespace: 'custom', key: 'anime_title', value: String(R.anime_title).slice(0, 120) }); } }
    for (let i = 0; i < M.length; i += 25){ const r = await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{field message}}}`, { m: M.slice(i, i + 25) }); const er = r.metafieldsSet.userErrors; if (er.length){ flags.push([series, 'Save problem: ' + er[0].message]); break; } }
    if (M.length){ if (need.themes && R.themes) got.push('themes: ' + R.themes.slice(0, 5).join(', ')); if (need.spice && R.spice) got.push('spice: ' + R.spice); if (need.notes && R.notes && R.notes.length) got.push('notes: ' + R.notes.join(', ')); if (need.anime && typeof R.has_anime === 'boolean') got.push('anime: ' + (R.has_anime ? (R.anime_title || 'yes') : 'no')); fixed.push([series + ' (' + all.length + ' listings)', got.join(' · ')]); } }
  const sid = (await adm(env, '{shop{id}}')).shop.id; await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: sid, namespace: 'mme_app', key: 'ai_fixes', type: 'json', value: JSON.stringify({ at: new Date().toISOString(), fixed, flags }) }] }); }

/* ---- shared: decode an app shelf (mme.shelf0..7 = JSON strings of one base64 gzip blob) ---- */
const SHELF_Q = [...Array(8).keys()].map(i => `s${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
async function shelfDecode(c){ let b = ''; for (let i = 0; i < 8; i++){ const m = c && c['s' + i]; if (!m || !m.value) break; let v; try { v = JSON.parse(m.value); } catch(e){ v = m.value; } if (!v) break; b += v; }
  if (b.length < 5) return null; try { const bin = Uint8Array.from(atob(b), ch => ch.charCodeAt(0)); return JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); } catch(e){ return null; } }
const cleanS = s => String(s || '').replace(/\s*\(Light Novel\)$/i, '').toLowerCase();

/* ---- Series guide (product pages): where to start, is it finished, what it's like, what else is like it ---- */
async function aiSeries(env, b){ const pid = String(b.pid || '').replace(/\D/g, ''); const q = String(b.q || '').trim().slice(0, 400); if (!pid || q.length < 3) return J({ error: 'Type your question first!' }, 400);
  const d = await adm(env, `query($id:ID!){product(id:$id){title productType status descriptionHtml se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value} au:metafield(namespace:"custom",key:"author"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} g1:metafield(namespace:"custom",key:"genre"){value} gs:metafield(namespace:"custom",key:"genres"){value} th:metafield(namespace:"custom",key:"themes"){value} ss:metafield(namespace:"custom",key:"series_status"){value} sv:metafield(namespace:"custom",key:"series_volumes"){value} an:metafield(namespace:"custom",key:"anime_title"){value} sp:metafield(namespace:"custom",key:"spice_level"){value}}}`, { id: 'gid://shopify/Product/' + pid });
  const P = d.product; if (!P || P.status !== 'ACTIVE') return J({ error: 'We couldn’t find that book.' }, 404);
  const series = (P.se && P.se.value) || P.title.replace(/\s+(Vol|Volume)\b.*$/i, ''); const ln = P.productType === 'Light Novel';
  let cat = []; try { cat = await aiCat(env); } catch(e){}
  const mine = cat.filter(x => x.s.toLowerCase() === series.toLowerCase() && !!x.ln === ln); const vols = [...new Set(mine.filter(x => !x.set && x.v != null).map(x => x.v))].sort((a, c) => a - c); const sets = mine.filter(x => x.set);
  const gen = [(P.g1 && P.g1.value), lst(P.gs && P.gs.value)].filter(Boolean).join(', ');
  const rows = filterSeries(cat, { genres: gen.split(/,\s*/).slice(0, 4), exclude: [series], age_max: ageIx(P.ag && P.ag.value) + 1, needStart: true }, words(gen + ' ' + lst(P.th && P.th.value))).slice(0, 30);
  const facts = `Series: ${series}${ln ? ' (light novel)' : ''}\nThis listing: ${P.title}\nAuthor: ${(P.au && P.au.value) || ''}\nAge rating: ${(P.ag && P.ag.value) || 'not listed'}\nGenres: ${gen}\nThemes: ${lst(P.th && P.th.value)}\nSeries status: ${(P.ss && P.ss.value) || 'unknown'}${P.sv && P.sv.value ? ', ' + P.sv.value + ' volumes in English' : ''}\nAnime: ${(P.an && P.an.value) || 'none listed'}\nIn stock at the shop now: ${vols.length ? 'Vol ' + vols.join(', ') : 'only this one'}${sets.length ? '; sets: ' + sets.map(x => x.t + ' $' + x.p).join('; ') : ''}\nDescription: ${String(P.descriptionHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 800)}`;
  const T = await aiCall(env, 'series', { model: AI_SMART, max_tokens: 700, system: SHOP_VOICE + ' You answer shoppers’ questions about one manga series on its product page. Use the SERIES FACTS first and what is widely and reliably known about the series. NEVER spoil plot twists, deaths, endings or who ends up together; if a question can’t be answered without spoilers, say so kindly. Be honest when unsure. If they ask what else they might like, recommend up to 3 from the CATALOG by number. Only say a volume or set is in stock if the SERIES FACTS line "In stock at the shop now" lists it; anything not listed there is not in stock. Get it right the first time: never correct yourself after answering. Reply with exactly one JSON object and nothing before or after it: {"answer":"2-5 friendly sentences, plain text","picks":[catalog numbers]}.', messages: [{ role: 'user', content: `SERIES FACTS\n${facts}\n\nCATALOG (similar series in stock):\n${rows.map(([, o], i) => line(o, i + 1)).join('\n')}\n\nQUESTION: ${q}` }] });
  const Jx = aiJSON(T) || { answer: aiPlain(T).slice(0, 900) || 'Sorry, I got mixed up on that one. Please try asking again!' }; const picks = []; for (const n of (Jx.picks || []).slice(0, 3)){ const r = rows[(+n || 0) - 1]; if (!r) continue; const { set, first } = pickItem(r[1]); const bk = first || set; if (bk) picks.push(card(bk, '')); }
  return J({ answer: String(Jx.answer || '').slice(0, 1400), picks }); }

/* ---- Mystery box curator (cron): picks books for new mystery box orders -> order metafield custom.box_picks (the Desk shows them on the order) ---- */
const BOX_RE = /mystery|blind date with manga/i;
async function boxSave(env, oid, val){ const raw = await fetch(`https://${SHOPD}/admin/api/${AV}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': await admTok(env) }, body: JSON.stringify({ query: `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, variables: { m: [{ ownerId: oid, namespace: 'custom', key: 'box_picks', type: 'json', value: JSON.stringify(val) }] } }) });
  const j = await raw.json().catch(() => ({})); if (j.data && j.data.metafieldsSet && !j.data.metafieldsSet.userErrors.length) return 'order';
  await env.FRIENDS.put('ai:boxerr', JSON.stringify(j.errors || (j.data && j.data.metafieldsSet && j.data.metafieldsSet.userErrors) || j).slice(0, 300), { expirationTtl: 7 * 86400 });
  const sd = await adm(env, '{shop{id metafield(namespace:"mme_app",key:"box_picks"){value}}}'); let M = {}; try { M = JSON.parse(sd.shop.metafield.value) || {}; } catch(e){}
  M[oid] = val; const ks = Object.keys(M); if (ks.length > 60) ks.slice(0, ks.length - 60).forEach(k => delete M[k]);
  const w = await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: sd.shop.id, namespace: 'mme_app', key: 'box_picks', type: 'json', value: JSON.stringify(M) }] });
  if (w.metafieldsSet && w.metafieldsSet.userErrors.length) throw new Error('box shop save ' + w.metafieldsSet.userErrors[0].message); return 'shop'; }
async function aiBoxes(env){ if (!env.SHOPIFY_CLIENT_ID || !env.ANTHROPIC_API_KEY) return; const cfg = await aiCfg(env); if (cfg.off) return;
  const since = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
  /* Nov 25: the old single query (25 orders x 8 shelf fields x 40 lines) cost more than the API allows and failed every time ("Throttled").
     Now: a cheap list first, then the full details only for the box orders that still need picks. */
  const d = await adm(env, `{orders(first:20,sortKey:CREATED_AT,reverse:true,query:"created_at:>${since} AND (fulfillment_status:unfulfilled OR fulfillment_status:partial OR fulfillment_status:on_hold) AND status:open"){nodes{id bp:metafield(namespace:"custom",key:"box_picks"){id} lineItems(first:15){nodes{title unfulfilledQuantity product{tags}}}}}}`);
  let SB = {}; try { const sb = await adm(env, '{shop{metafield(namespace:"mme_app",key:"box_picks"){value}}}'); SB = JSON.parse(sb.shop.metafield.value) || {}; } catch(e){}
  const ids = d.orders.nodes.filter(o => !o.bp && !SB[o.id] && o.lineItems.nodes.some(li => BOX_RE.test(li.title) && li.unfulfilledQuantity > 0 && !(li.product && li.product.tags.includes('Shopify Collective')))).slice(0, 3).map(o => o.id);
  const todo = []; for (const id of ids){ const x = await adm(env, `query($id:ID!){order(id:$id){id name customer{id ${SHELF_Q}} lineItems(first:40){nodes{title variantTitle quantity unfulfilledQuantity customAttributes{key value} originalUnitPriceSet{shopMoney{amount}} product{id tags}}}}}`, { id }); if (x.order) todo.push(x.order); }
  if (!todo.length) return; const cat = await aiCat(env); const res = (await get(env, 'ai:boxres')) || {}; const now = Date.now(); for (const k of Object.keys(res)) if (now - res[k][1] > 14 * 864e5) delete res[k];
  for (const o of todo){ const boxes = o.lineItems.nodes.filter(li => BOX_RE.test(li.title) && li.unfulfilledQuantity > 0); let need = 0, mature = false, kids = false, perBook = 7; const props = [];
    for (const li of boxes){ const m = (li.variantTitle + ' ' + li.title).match(/(\d+)\s*(?:random\s*)?(?:books?|volumes?|vols?|manga)\b/i); const n = m ? +m[1] : 0; need += n * li.unfulfilledQuantity; if (/mature|18\+/i.test(li.title + li.variantTitle)) mature = true; if (/\bkid|children|all ages/i.test(li.title + li.variantTitle)) kids = true; if (n) perBook = Math.min(perBook, +li.originalUnitPriceSet.shopMoney.amount / n); (li.customAttributes || []).forEach(a => { if (a.value && !a.key.startsWith('_')) props.push(a.key + ': ' + a.value); }); }
    const val = { by: 'ai', at: new Date().toISOString(), picks: [], note: '' };
    if (!need || need > 40){ val.note = 'The book helper couldn’t tell how many books this box needs, so pick by hand.'; await boxSave(env, o.id, val); continue; }
    let own = new Set(), likes = []; const sh = o.customer ? await shelfDecode(o.customer) : null;
    if (sh && sh.series) for (const s of Object.values(sh.series)){ if (!s || !s.n) continue; (s.v || []).forEach(v => own.add(cleanS(s.n) + '|' + v)); if ((s.st || 0) >= 4) likes.push(s.n); }
    let past = []; if (o.customer){ try { const pd = await adm(env, `query($id:ID!){customer(id:$id){orders(first:15,sortKey:CREATED_AT,reverse:true){nodes{lineItems(first:50){nodes{product{id}}}}}}}`, { id: o.customer.id }); past = pd.customer.orders.nodes.flatMap(x => x.lineItems.nodes.map(l => l.product && l.product.id.split('/').pop())).filter(Boolean); } catch(e){} }
    const pastSet = new Set(past); const maxA = mature ? 3 : kids ? 0 : 2; const cap = Math.max(6.99, perBook * 1.75);
    const pool = cat.filter(x => !x.set && x.a <= maxA && (mature || x.sp <= 3) && x.p <= cap && !res[x.i] && !pastSet.has(String(x.i)) && !own.has(cleanS(x.s) + '|' + x.v) && !/ex library/i.test(x.t));
    const textWant = props.join(' ') + ' ' + likes.join(' '); const W = words(textWant);
    const scored = pool.map(x => { let sc = Math.random() * 2; const hay = (x.s + ' ' + x.g + ' ' + x.th).toLowerCase(); W.forEach(w => { if (hay.includes(w)) sc += 2; }); if (x.v === 1) sc += 1.5; return [sc, x]; }).sort((a, c) => c[0] - a[0]).slice(0, 90).map(r => r[1]);
    if (scored.length < need){ val.note = 'Not enough matching books in stock for the book helper to pick this box. Pick by hand.'; }
    else { let ids = []; try { const T = await aiCall(env, 'box', { max_tokens: 600, system: `You pick books for a used manga shop's mystery box. Choose exactly ${need} different books from the LIST by number. Rules: about half should be Vol 1s (great starting points), the rest a fun mix; no more than 2 from the same series; match what the customer says they like if they said anything; never pick a series or volume they say they already own. Reply with JSON only: {"picks":[numbers],"why":"one short sentence for the packer"}.`, messages: [{ role: 'user', content: `CUSTOMER NOTES: ${props.join(' | ').slice(0, 1500) || 'none (random assortment)'}\nTHEIR APP FAVORITES: ${likes.slice(0, 15).join('; ') || 'none'}\nBOX: ${need} books${mature ? ', mature box' : ''}\n\nLIST (number|title|age|genres|price):\n${scored.map((x, i) => `${i + 1}|${x.t}|${AGES[x.a]}|${x.g}|$${x.p}`).join('\n')}` }] });
        const R = aiJSON(T) || {}; ids = [...new Set((R.picks || []).map(n => +n - 1).filter(n => scored[n]))].slice(0, need); val.note = String(R.why || '').slice(0, 240); } catch(e){ val.note = 'The book helper had a hiccup, so these are best guesses.'; }
      const chosen = [], perS = {}; ids.map(n => scored[n]).forEach(x => { if ((perS[x.s] || 0) < 2){ chosen.push(x); perS[x.s] = (perS[x.s] || 0) + 1; } });
      for (const x of scored){ if (chosen.length >= need) break; if (chosen.includes(x) || (perS[x.s] || 0) >= 2) continue; chosen.push(x); perS[x.s] = (perS[x.s] || 0) + 1; }
      val.picks = chosen.map(x => ({ pid: x.i, title: x.t, series: x.s, vol: x.v, price: x.p, handle: x.h })); chosen.forEach(x => res[x.i] = [o.name, now]);
      val.note = '✨ Picked by the book helper' + (props.length ? ' using their notes' : '') + (sh ? ', skipping books on their app shelf' : '') + '. ' + val.note; }
    await boxSave(env, o.id, val); }
  await put(env, 'ai:boxres', res); }

/* ---- New for you (nightly, ~4am Eastern): new arrivals matched to app readers -> shop metafield mme_app.new_for_you (Desk Restocks tab: review + Send) ---- */
async function aiNewForYou(env){ if (!env.SHOPIFY_CLIENT_ID || !env.ANTHROPIC_API_KEY) return; if (new Date().getUTCHours() !== 9) return; const day = ymd(); if (await env.FRIENDS.get('ai:nfy:' + day)) return; await env.FRIENDS.put('ai:nfy:' + day, '1', { expirationTtl: 3 * 86400 });
  const cfg = await aiCfg(env); if (cfg.off) return; const cat = await aiCat(env); const cut = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const fresh = cat.filter(x => x.hd && x.hd >= cut); if (!fresh.length) return;
  const custs = []; let after = null; for (let pg = 0; pg < 3; pg++){ const d = await adm(env, `query($a:String){customers(first:60,after:$a,sortKey:UPDATED_AT,reverse:true){pageInfo{hasNextPage endCursor} nodes{id firstName displayName ${SHELF_Q}}}}`, { a: after }); for (const c of d.customers.nodes) if (c.s0 && c.s0.value) custs.push(c); if (!d.customers.pageInfo.hasNextPage) break; after = d.customers.pageInfo.endCursor; }
  const sent = (await get(env, 'ai:nfysent')) || {}; const out = [];
  for (const c of custs){ const sh = await shelfDecode(c); if (!sh || !sh.series) continue; const cid = c.id.split('/').pop(); const prev = new Set(sent[cid] || []);
    const own = {}, wants = new Set(), likeG = {}; for (const s of Object.values(sh.series)){ if (!s || !s.n) continue; const k = cleanS(s.n); own[k] = new Set((s.v || []).map(Number)); (s.want || []).forEach(v => wants.add(k + '|' + v)); }
    for (const x of cat){ const k = cleanS(x.s); if (own[k] && own[k].size) String(x.g + ',' + x.th).toLowerCase().split(/,\s*/).filter(Boolean).forEach(g => likeG[g] = (likeG[g] || 0) + 1); }
    const topG = Object.entries(likeG).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
    const strong = [], weak = []; for (const x of fresh){ if (x.set || prev.has(x.i)) continue; const k = cleanS(x.s); if (wants.has(k + '|' + x.v)) continue; // wishlist books go out as restock alerts already
      if (own[k]){ if (x.v != null && !own[k].has(x.v) && own[k].size && x.v <= Math.max(...own[k]) + 2) strong.push(x); }
      else if (x.v === 1 || x.v == null){ const g = (x.g + ',' + x.th).toLowerCase(); if (topG.some(t => g.includes(t)) && x.a <= 3) weak.push(x); } }
    const picks = strong.slice(0, 3).concat(weak.slice(0, Math.max(0, 3 - strong.length))); if (!strong.length && weak.length < 2) continue;
    out.push({ cid, who: c.firstName || c.displayName || 'Reader', picks: picks.slice(0, 3).map(x => ({ pid: x.i, title: x.t, price: x.p, handle: x.h, next: !!own[cleanS(x.s)] })) }); if (out.length >= 25) break; }
  if (out.length){ try { const T = await aiCall(env, 'nfy', { max_tokens: 2500, system: 'Write short app messages from Megan, owner of The Mage’s Emporium (a small family-run used manga shop), telling a reader about new arrivals picked for them. Her voice: warm, upbeat, short (2-3 sentences), exclamation points, maybe a :), "we" for the shop. Never use the reader’s name. Mention the books by title; for ones marked next, say it’s the next volume in a series they’re collecting. Reply with JSON only: {"<cid>":"message", ...}.', messages: [{ role: 'user', content: JSON.stringify(out.map(o => ({ cid: o.cid, books: o.picks.map(p => ({ title: p.title, next: p.next })) }))) }] });
      const M = aiJSON(T) || {}; out.forEach(o => { o.msg = String(M[o.cid] || '').slice(0, 600) || ('New arrivals we think you’ll love: ' + o.picks.map(p => p.title).join(', ') + '! :)'); }); } catch(e){ out.forEach(o => o.msg = 'New arrivals we think you’ll love: ' + o.picks.map(p => p.title).join(', ') + '! :)'); }
    out.forEach(o => { sent[o.cid] = [...new Set((sent[o.cid] || []).concat(o.picks.map(p => p.pid)))].slice(-80); }); await put(env, 'ai:nfysent', sent); }
  const sid = (await adm(env, '{shop{id}}')).shop.id; await adm(env, `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: sid, namespace: 'mme_app', key: 'new_for_you', type: 'json', value: JSON.stringify({ at: new Date().toISOString(), list: out }) }] }); }

/* Series blurbs (Nov 2026): listings whose description is only the one-line intro get tagged "zz needs-blurb" (by Claude, and daily by aiBlurbTag for
   new listings). Each cron tick takes up to 4 series: copy a sibling's blurb if one exists, else Sonnet writes a 2-3 sentence spoiler-free premise
   (or SKIPs if it doesn't reliably know the series; those get "zz blurb-skip" for Megan). The blurb goes in after <p class="book-intro">. */
const BLURB_TAG = 'zz needs-blurb', BLURB_SKIP = 'zz blurb-skip';
const introOnly = h => String(h || '').replace(/<p class="book-intro">[\s\S]*?<\/p>/, '').replace(/<p>\s*Condition:[\s\S]*?<\/p>/i, '').replace(/<[^>]+>/g, '').trim().length < 60;
const blurbOf = h => { const m = String(h || '').replace(/<p class="book-intro">[\s\S]*?<\/p>/, '').match(/<p>(?!\s*Condition:)([\s\S]{60,1200}?)<\/p>/i); return m ? m[1].trim() : ''; };
const withBlurb = (h, b) => { h = String(h || ''); const p = `<p>${b}</p>`; return /<p class="book-intro">[\s\S]*?<\/p>/.test(h) ? h.replace(/(<p class="book-intro">[\s\S]*?<\/p>)/, `$1${p}`) : p + h; };
async function aiBlurbs(env){ if (!env.SHOPIFY_CLIENT_ID || !env.ANTHROPIC_API_KEY) return; const cfg = await aiCfg(env); if (cfg.off) return;
  const F = `id title productType tags descriptionHtml s:metafield(namespace:"custom",key:"series"){value} au:metafield(namespace:"custom",key:"author"){value} g:metafield(namespace:"custom",key:"genre"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} yr:metafield(namespace:"custom",key:"original_publication_year"){value} vendor`;
  const d = await adm(env, `{products(first:40,query:"tag:'${BLURB_TAG}'"){nodes{${F}}}}`); const ps = d.products.nodes; if (!ps.length) return;
  const S = {}; for (const p of ps){ const k = ((p.s && p.s.value) || p.title.replace(/\s+(Vol|Volume)\b.*$/i, '')) + '|' + p.productType; (S[k] = S[k] || []).push(p); }
  const st = (await get(env, 'ai:blurb')) || { done: 0, copied: 0, wrote: 0, skipped: 0, skip: [] }; let n = 0;
  for (const [k, list] of Object.entries(S)){ if (n >= 4) break; n++; const [series, type] = k.split('|');
    let blurb = '';
    const sib = (await adm(env, `query($q:String!){products(first:40,query:$q){nodes{title productType descriptionHtml s:metafield(namespace:"custom",key:"series"){value}}}}`, { q: `metafields.custom.series:${JSON.stringify(series)}` })).products.nodes.filter(x => x.productType === type && x.s && x.s.value === series);
    for (const x of sib){ const b = blurbOf(x.descriptionHtml); if (b){ blurb = b; break; } }
    let how = 'copied';
    if (!blurb){ const p0 = list[0]; how = 'wrote';
      const T = await aiCall(env, 'blurb', { model: AI_SMART, max_tokens: 400, system: `You write short product blurbs for a used manga shop. Write the premise of the WHOLE SERIES in 2 or 3 plain sentences (40 to 70 words): who the main character is, the setup, and the feel of the story. No spoilers beyond the first volume, no hype words ("must-read", "masterpiece", "epic"), no em dashes, no quotes, no prices, no volume numbers. Only write it if you reliably know this exact series as published in English; if you are not sure, or the title could be a different work, reply SKIP. Reply with JSON only: {"blurb":"..."} or {"skip":true}.`, messages: [{ role: 'user', content: JSON.stringify({ series, format: type === 'Light Novel' ? 'light novel' : 'manga', example_title: p0.title, author: p0.au && p0.au.value, genre: p0.g && p0.g.value, age_rating: p0.ag && p0.ag.value, publisher: p0.vendor, year: p0.yr && p0.yr.value }) }] });
      const R = aiJSON(T) || {}; blurb = !R.skip && typeof R.blurb === 'string' ? R.blurb.replace(/[<>]/g, '').replace(/\s*[—–]\s*/g, ', ').trim().slice(0, 700) : ''; }
    if (blurb){ for (const p of list){ const upd = introOnly(p.descriptionHtml) ? withBlurb(p.descriptionHtml, blurb) : p.descriptionHtml;
        await adm(env, `mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, descriptionHtml: upd } });
        await adm(env, `mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}`, { id: p.id, t: [BLURB_TAG] }); st.done++; }
      st[how]++; }
    else { for (const p of list){ await adm(env, `mutation($id:ID!){a:tagsRemove(id:$id,tags:["${BLURB_TAG}"]){userErrors{message}} b:tagsAdd(id:$id,tags:["${BLURB_SKIP}"]){userErrors{message}}}`, { id: p.id }); } st.skipped++; st.skip = st.skip.concat([series]).slice(-200); } }
  st.at = new Date().toISOString(); await put(env, 'ai:blurb', st); }
async function aiBlurbTag(env){ if (!env.SHOPIFY_CLIENT_ID) return; if (new Date().getUTCHours() !== 10) return; const day = ymd(); if (await env.FRIENDS.get('ai:btag:' + day)) return; await env.FRIENDS.put('ai:btag:' + day, '1', { expirationTtl: 3 * 86400 });
  const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const d = await adm(env, `{products(first:150,query:"created_at:>${since} AND (product_type:Manga OR product_type:'Light Novel') AND -tag:'Shopify Collective' AND -tag:Bundle AND -tag:'${BLURB_SKIP}'"){nodes{id descriptionHtml}}}`);
  for (const p of d.products.nodes) if (introOnly(p.descriptionHtml)) await adm(env, `mutation($id:ID!){tagsAdd(id:$id,tags:["${BLURB_TAG}"]){userErrors{message}}}`, { id: p.id }); }
async function aiTick(env){ const hr = new Date().getUTCHours(); const fixHour = (hr === 8 && !(await env.FRIENDS.get('ai:fix:' + ymd()))) || (hr === 9 && !(await env.FRIENDS.get('ai:nfy:' + ymd()))); try { await aiBoxes(env); } catch(e){ await env.FRIENDS.put('ai:err', 'boxes ' + String(e).slice(0, 300), { expirationTtl: 86400 }); } try { if (!fixHour) await catTick(env); } catch(e){ await env.FRIENDS.put('ai:err', 'catalog ' + String(e).slice(0, 300), { expirationTtl: 86400 }); } try { await aiFlush(env); } catch(e){} try { await aiFixer(env); } catch(e){ await env.FRIENDS.put('ai:err', 'fixer ' + String(e).slice(0, 300), { expirationTtl: 86400 }); } try { await aiNewForYou(env); } catch(e){ await env.FRIENDS.put('ai:err', 'new-for-you ' + String(e).slice(0, 300), { expirationTtl: 86400 }); } try { if (!fixHour){ await aiBlurbTag(env); await aiBlurbs(env); } } catch(e){ await env.FRIENDS.put('ai:err', 'blurbs ' + String(e).slice(0, 300), { expirationTtl: 86400 }); } }

export default {
  async fetch(req, env){
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url); const p = url.pathname;
    if (p === '/push/key') return J({ key: (await vapid(env)).pub });
    /* Shop alerts to Megan's phone (her customer account's push subscription).
       /notify/order: from Shopify Flow (Order created -> Send HTTP request), header x-mme-key = env.NOTIFY_KEY. */
    if (p === '/notify/order' && req.method === 'POST'){
      if (!env.NOTIFY_KEY || req.headers.get('x-mme-key') !== env.NOTIFY_KEY) return J({ error: 'forbidden' }, 403);
      let o = {}; try { o = await req.json(); } catch(e){} const last = (Array.isArray(o.last) ? o.last : []).filter(Boolean).map(String); if (last.length && await conNow(env)){ const n = await sendTo(env, SHOP_CID(env), { t: ('⚠️ Last copy sold · ' + String(o.name || '')).slice(0, 80), b: last.join(' · ').slice(0, 200), u: DESK + '#pick', tag: 'shop-order' }); return J({ sent: n, last: last.length }); }
      const n = await sendTo(env, SHOP_CID(env), { t: ('🛒 New order ' + String(o.name || '')).slice(0, 80), b: [o.total ? '$' + o.total : '', o.items ? o.items + ' item' + (+o.items === 1 ? '' : 's') : '', o.channel || '', o.who || ''].filter(Boolean).join(' · ').slice(0, 200), u: DESK + '#pack', tag: 'shop-order' });
      return J({ sent: n }); }
    if (p.startsWith('/proxy/wl')) return wlProxy(env, req, url);
    if (p.startsWith('/proxy/ai/')) return aiProxy(env, req, url);
    if (p === '/ai/status'){ const mk = ymd().slice(0, 7); const M = (await get(env, 'ai:m:' + mk)) || {}; const c = await get(env, 'ai:cat'); return J({ key: !!env.ANTHROPIC_API_KEY, catalog: c ? c.length : 0, building: !!(await env.FRIENDS.get('ai:catcur')), built: ((await get(env, 'ai:catb')) || []).length, catAt: await env.FRIENDS.get('ai:catat'), month: mk, spent: M.spent || 0, calls: M.calls || 0, err: await env.FRIENDS.get('ai:err'), last: await get(env, 'ai:last'), flushed: await env.FRIENDS.get('ai:flushat'), blurbs: await get(env, 'ai:blurb'), boxerr: await env.FRIENDS.get('ai:boxerr'), v: 13 }); }
    if (p === '/wl/unsub') return wlUnsub(env, url);
    if (p === '/wl/status'){ return J({ admin: !!env.SHOPIFY_CLIENT_ID, mail: !!env.RESEND_KEY, last: await env.FRIENDS.get('wl:last'), err: await env.FRIENDS.get('wl:err'), keys: Object.keys(((await get(env, 'wl:idx')) || {}).keys || {}).length }); }
    const me = await who(env, req); if (!me) return J({ error: 'login', detail: who.last || '' }, 401);
    if (p.startsWith('/ai/')) return aiRoute(env, req, p, 'c' + me.cid, me);
    /* /wl/touch: the app saved the customer's wishlist itself; refresh this customer in the alert index */
    if (p === '/wl/touch' && req.method === 'POST'){ try { await wlIndex(env, me.cid, await wlGet(env, me.cid)); return J({ ok: 1 }); } catch(e){ return J({ error: String(e).slice(0, 120) }, 500); } }
    /* /notify/msg: a customer sent a message or Find request in the app */
    if (p === '/notify/msg' && req.method === 'POST'){ if (me.cid === SHOP_CID(env)) return J({ ok: 1 });
      const rk = 'nmsg:' + me.cid; if (await env.FRIENDS.get(rk)) return J({ ok: 1, later: 1 }); await env.FRIENDS.put(rk, '1', { expirationTtl: 120 });
      let b = {}; try { b = await req.clone().json(); } catch(e){}
      const n = await sendTo(env, SHOP_CID(env), { t: ('💬 ' + (me.name || 'A customer') + ' sent an app message').slice(0, 80), b: String(b.t || '').slice(0, 200), u: DESK + '#msgs', tag: 'shop-msg' });
      return J({ sent: n }); }
    let body = {}; if (req.method === 'POST' || req.method === 'PUT'){ try { body = await req.json(); } catch(e){} }
    const own = (await get(env, 'own:' + me.cid)) || { code: null, name: me.name, viewers: {} };

    if (p === '/state'){ const fol = (await get(env, 'fol:' + me.cid)) || {}; const following = [];
      const asks = me.mail ? ((await get(env, 'ask:' + await sha(me.mail))) || []) : [];
      for (const [oc, f] of Object.entries(fol)){ if (oc.startsWith('mail:')){ following.push({ cid: oc, name: f.name, st: 'ask' }); continue; } const o = await get(env, 'own:' + oc); const st = o && o.code && o.viewers[me.cid] ? o.viewers[me.cid].st : 'gone';
        following.push({ cid: oc, name: (o && o.name) || f.name, st, shelf: st === 'ok' ? await env.FRIENDS.get('shelf:' + oc) : null }); }
      return J({ me: { name: me.name, live: !!own.code, code: own.code, viewers: Object.entries(own.viewers).map(([c, v]) => ({ cid: c, name: v.name, st: v.st, at: v.at })), asks }, following }); }
    if (p === '/ask'){ const mail = String(body.email || '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(mail)) return J({ error: 'Type a valid email' }, 400); if (mail === me.mail) return J({ error: 'That’s your own email' }, 400);
      const k = 'ask:' + await sha(mail); const list = (await get(env, k)) || []; if (!list.find(a => a.cid === me.cid)) list.push({ cid: me.cid, name: me.name, at: Date.now() }); await put(env, k, list.slice(-50));
      const fol = (await get(env, 'fol:' + me.cid)) || {}; fol['mail:' + (await sha(mail)).slice(0, 16)] = { name: mail, at: Date.now() }; await put(env, 'fol:' + me.cid, fol); return J({ ok: 1 }); }
    if (p === '/answer'){ const k = 'ask:' + await sha(me.mail); const list = (await get(env, k)) || []; const a = list.find(x => x.cid === String(body.cid || '')); if (!a) return J({ error: 'not found' }, 404);
      await put(env, k, list.filter(x => x !== a)); const afol = (await get(env, 'fol:' + a.cid)) || {}; delete afol['mail:' + (await sha(me.mail)).slice(0, 16)];
      if (body.yes){ if (!own.code){ own.code = rnd(10); await env.FRIENDS.put('code:' + own.code, me.cid); } own.name = me.name; own.viewers[a.cid] = { name: a.name, st: 'ok', at: Date.now() }; await put(env, 'own:' + me.cid, own); afol[me.cid] = { name: me.name, at: Date.now() }; }
      await put(env, 'fol:' + a.cid, afol); return J({ ok: 1, live: !!own.code }); }
    if (p === '/on'){ if (!own.code){ own.code = rnd(10); await env.FRIENDS.put('code:' + own.code, me.cid); } own.name = me.name; await put(env, 'own:' + me.cid, own); return J({ code: own.code }); }
    if (p === '/off'){ if (own.code) await env.FRIENDS.delete('code:' + own.code); await env.FRIENDS.delete('own:' + me.cid); await env.FRIENDS.delete('shelf:' + me.cid); return J({ ok: 1 }); }
    if (p === '/shelf'){ if (!own.code) return J({ error: 'not sharing' }, 400); const s = String(body.s || ''); if (s.length > 2e6) return J({ error: 'too big' }, 413);
      await env.FRIENDS.put('shelf:' + me.cid, s); return J({ ok: 1 }); }
    if (p === '/peek'){ const oc = await env.FRIENDS.get('code:' + String(body.code || '')); if (!oc) return J({ error: 'This invite link was turned off.' }, 404); const o = await get(env, 'own:' + oc);
      return J({ name: (o && o.name) || 'A friend', self: oc === me.cid, st: o && o.viewers[me.cid] ? o.viewers[me.cid].st : null }); }
    if (p === '/request'){ const oc = await env.FRIENDS.get('code:' + String(body.code || '')); if (!oc) return J({ error: 'This invite link was turned off.' }, 404); if (oc === me.cid) return J({ error: 'That’s your own link.' }, 400);
      const o = await get(env, 'own:' + oc); if (!o) return J({ error: 'gone' }, 404); if (!o.viewers[me.cid]) o.viewers[me.cid] = { name: me.name, st: 'ask', at: Date.now() }; await put(env, 'own:' + oc, o);
      const fol = (await get(env, 'fol:' + me.cid)) || {}; fol[oc] = { name: o.name, at: Date.now() }; await put(env, 'fol:' + me.cid, fol); return J({ ok: 1, name: o.name, st: o.viewers[me.cid].st }); }
    if (p === '/approve' || p === '/revoke'){ const v = own.viewers[String(body.cid || '')]; if (!v) return J({ error: 'not found' }, 404);
      if (p === '/approve') v.st = 'ok'; else delete own.viewers[String(body.cid)]; await put(env, 'own:' + me.cid, own); return J({ ok: 1 }); }
    if (p === '/unfollow'){ const oc = String(body.cid || ''); const fol = (await get(env, 'fol:' + me.cid)) || {}; delete fol[oc]; await put(env, 'fol:' + me.cid, fol); if (oc.startsWith('mail:')) return J({ ok: 1 });
      const o = await get(env, 'own:' + oc); if (o && o.viewers[me.cid]){ delete o.viewers[me.cid]; await put(env, 'own:' + oc, o); } return J({ ok: 1 }); }
    if (p === '/push/sub'){ const sub = body.sub; if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return J({ error: 'bad subscription' }, 400);
      const h = await sha('mme:' + me.cid); const rec = (await get(env, 'push:c:' + me.cid)) || { h, prefs: {}, subs: [] };
      rec.subs = rec.subs.filter(s => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }]).slice(-5);
      if (body.prefs) rec.prefs = body.prefs; await put(env, 'push:c:' + me.cid, rec); await env.FRIENDS.put('push:h:' + h, me.cid); return J({ ok: 1 }); }
    if (p === '/cart/track'){ const C = (await get(env, 'cart:idx')) || {}; const id = String(body.id || ''); const n = Math.max(0, +body.n || 0);
      if (!/^gid:\/\/shopify\/Cart\//.test(id) || !n) delete C[me.cid]; else { const prev = C[me.cid]; C[me.cid] = { id, n, at: Date.now(), sent: prev && prev.id === id ? prev.sent || 0 : 0 }; }
      await put(env, 'cart:idx', C); return J({ ok: 1 }); }
    if (p === '/push/prefs'){ const rec = await get(env, 'push:c:' + me.cid); if (!rec) return J({ error: 'not subscribed' }, 404); rec.prefs = body.prefs || {}; await put(env, 'push:c:' + me.cid, rec); return J({ ok: 1 }); }
    if (p === '/push/unsub'){ const rec = await get(env, 'push:c:' + me.cid); if (rec){ rec.subs = rec.subs.filter(s => s.endpoint !== body.endpoint); if (rec.subs.length) await put(env, 'push:c:' + me.cid, rec); else { await env.FRIENDS.delete('push:c:' + me.cid); await env.FRIENDS.delete('push:h:' + rec.h); } } return J({ ok: 1 }); }
    if (p === '/push/test'){ const n = await sendTo(env, me.cid, { t: '🔔 Notifications are on!', b: 'This is how news from The Mage’s Emporium will look.', u: '/', tag: 'test' }); return J({ sent: n }); }
    if (p === '/forget'){ // delete everything this person has in the friends service
      { const pr = await get(env, 'push:c:' + me.cid); if (pr){ await env.FRIENDS.delete('push:c:' + me.cid); await env.FRIENDS.delete('push:h:' + pr.h); } }
      if (own.code) await env.FRIENDS.delete('code:' + own.code);
      for (const c of Object.keys(own.viewers || {})){ const f = await get(env, 'fol:' + c); if (f && f[me.cid]){ delete f[me.cid]; await put(env, 'fol:' + c, f); } }
      const fol = (await get(env, 'fol:' + me.cid)) || {};
      for (const oc of Object.keys(fol)){ if (oc.startsWith('mail:')) continue; const o = await get(env, 'own:' + oc); if (o && o.viewers[me.cid]){ delete o.viewers[me.cid]; await put(env, 'own:' + oc, o); } }
      await env.FRIENDS.delete('own:' + me.cid); await env.FRIENDS.delete('shelf:' + me.cid); await env.FRIENDS.delete('fol:' + me.cid);
      if (me.mail) await env.FRIENDS.delete('ask:' + await sha(me.mail)); return J({ ok: 1 }); }
    return J({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx){ ctx.waitUntil(runQueue(env)); ctx.waitUntil(wlTick(env)); ctx.waitUntil(aiTick(env)); ctx.waitUntil(cartTick(env).catch(() => {})); }
};
