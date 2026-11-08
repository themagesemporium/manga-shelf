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

/* Con dates from the shop's Upcoming Events page ("Name - Month D(-D), YYYY - City"); window = day before through day after. Cached 6 h. */
async function conNow(env){ let L = null; try { L = JSON.parse(await env.FRIENDS.get('cons') || 'null'); } catch(e){}
  if (!L){ L = []; try { const html = await (await fetch('https://themagesemporium.com/pages/upcoming-events')).text(); const MONS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      html.split(/<\/p>|<br\s*\/?>|\n/i).map(x => x.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()).forEach(line => {
        const m = line.match(/^(.+?)\s+[-–—]\s+([A-Za-z]+)\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}))?,?\s+(\d{4})/); if (!m) return;
        const mi = MONS.indexOf(m[2].toLowerCase().slice(0, 3)); if (mi < 0) return; const m2 = m[4] ? MONS.indexOf(m[4].toLowerCase().slice(0, 3)) : mi;
        /* dates in US Eastern: midnight ET = 05:00 UTC (close enough across DST for a day-wide window) */
        L.push([Date.UTC(+m[6], mi, +m[3] - 1, 5), Date.UTC(+m[6], m2 < 0 ? mi : m2, (m[5] ? +m[5] : +m[3]) + 2, 5)]); }); } catch(e){}
    await env.FRIENDS.put('cons', JSON.stringify(L), { expirationTtl: 21600 }); }
  const now = Date.now(); return L.some(([s, e]) => now >= s && now < e); }

export default {
  async fetch(req, env){
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url); const p = url.pathname;
    if (p === '/push/key') return J({ key: (await vapid(env)).pub });
    /* Shop alerts to Megan's phone (her customer account's push subscription).
       /notify/order: from Shopify Flow (Order created -> Send HTTP request), header x-mme-key = env.NOTIFY_KEY. */
    if (p === '/notify/order' && req.method === 'POST'){
      if (!env.NOTIFY_KEY || req.headers.get('x-mme-key') !== env.NOTIFY_KEY) return J({ error: 'forbidden' }, 403);
      let o = {}; try { o = await req.json(); } catch(e){}
      /* Convention weekends: when the order took the last copy of a book, say so (Megan takes single copies to cons). */
      const last = (Array.isArray(o.last) ? o.last : []).filter(Boolean).map(String);
      if (last.length && await conNow(env)){
        const n = await sendTo(env, SHOP_CID(env), { t: ('⚠️ Last copy sold · ' + String(o.name || '')).slice(0, 80), b: last.join(' · ').slice(0, 200), u: DESK + '#pick', tag: 'shop-order' });
        return J({ sent: n, last: last.length }); }
      const n = await sendTo(env, SHOP_CID(env), { t: ('🛒 New order ' + String(o.name || '')).slice(0, 80), b: [o.total ? '$' + o.total : '', o.items ? o.items + ' item' + (+o.items === 1 ? '' : 's') : '', o.channel || '', o.who || ''].filter(Boolean).join(' · ').slice(0, 200), u: DESK + '#pack', tag: 'shop-order' });
      return J({ sent: n }); }
    const me = await who(env, req); if (!me) return J({ error: 'login', detail: who.last || '' }, 401);
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
  async scheduled(event, env, ctx){ ctx.waitUntil(runQueue(env)); }
};
