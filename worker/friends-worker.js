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
async function adm(env, query, variables){ const r = await fetch(`https://${SHOPD}/admin/api/${AV}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': await admTok(env) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({})); if (r.status === 401) await env.FRIENDS.delete('adm:tok'); if (!j.data) throw new Error('admin ' + r.status + ' ' + JSON.stringify(j.errors || j).slice(0, 160)); return j.data; }
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
  const clean = it => { const o = {}; if (it.s && +it.v){ o.s = String(it.s).slice(0, 160); o.v = Math.round(+it.v * 10) / 10; if (it.ln) o.ln = 1; } if (it.p && /^\d+$/.test(String(it.p))) o.p = String(it.p); if (it.t) o.t = String(it.t).slice(0, 160); o.at = now; return wkey(o) ? o : null; };
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
    if (p === '/wl/unsub') return wlUnsub(env, url);
    if (p === '/wl/status'){ return J({ admin: !!env.SHOPIFY_CLIENT_ID, mail: !!env.RESEND_KEY, last: await env.FRIENDS.get('wl:last'), err: await env.FRIENDS.get('wl:err'), keys: Object.keys(((await get(env, 'wl:idx')) || {}).keys || {}).length }); }
    const me = await who(env, req); if (!me) return J({ error: 'login', detail: who.last || '' }, 401);
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
  async scheduled(event, env, ctx){ ctx.waitUntil(runQueue(env)); ctx.waitUntil(wlTick(env)); }
};
