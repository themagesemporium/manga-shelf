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
  const r = await fetch(CAAPI, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: t, origin: ORIGIN, referer: ORIGIN + '/', 'user-agent': 'Mozilla/5.0 (MME friends)' }, body: JSON.stringify({ query: '{customer{id firstName}}' }) });
  if (!r.ok){ who.last = r.status + ' ' + (await r.text()).slice(0, 120); return null; } const j = await r.json(); const cu = j.data && j.data.customer; if (!cu) return null;
  const me = { cid: cu.id.split('/').pop(), name: cu.firstName || 'A friend' }; await env.FRIENDS.put(h, JSON.stringify(me), { expirationTtl: 3600 }); return me; }
const get = async (env, k) => (await env.FRIENDS.get(k, 'json')) || null;
const put = (env, k, v) => env.FRIENDS.put(k, JSON.stringify(v));

export default {
  async fetch(req, env){
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url); const p = url.pathname;
    const me = await who(env, req); if (!me) return J({ error: 'login', detail: who.last || '' }, 401);
    let body = {}; if (req.method === 'POST' || req.method === 'PUT'){ try { body = await req.json(); } catch(e){} }
    const own = (await get(env, 'own:' + me.cid)) || { code: null, name: me.name, viewers: {} };

    if (p === '/state'){ const fol = (await get(env, 'fol:' + me.cid)) || {}; const following = [];
      for (const [oc, f] of Object.entries(fol)){ const o = await get(env, 'own:' + oc); const st = o && o.code && o.viewers[me.cid] ? o.viewers[me.cid].st : 'gone';
        following.push({ cid: oc, name: (o && o.name) || f.name, st, shelf: st === 'ok' ? await env.FRIENDS.get('shelf:' + oc) : null }); }
      return J({ me: { name: me.name, live: !!own.code, code: own.code, viewers: Object.entries(own.viewers).map(([c, v]) => ({ cid: c, name: v.name, st: v.st, at: v.at })) }, following }); }
    if (p === '/on'){ if (!own.code){ own.code = rnd(10); await env.FRIENDS.put('code:' + own.code, me.cid); } own.name = me.name; await put(env, 'own:' + me.cid, own); return J({ code: own.code }); }
    if (p === '/off'){ if (own.code) await env.FRIENDS.delete('code:' + own.code); await env.FRIENDS.delete('own:' + me.cid); await env.FRIENDS.delete('shelf:' + me.cid); return J({ ok: 1 }); }
    if (p === '/shelf'){ if (!own.code) return J({ error: 'not sharing' }, 400); const s = String(body.s || ''); if (s.length > 2e6) return J({ error: 'too big' }, 413);
      await env.FRIENDS.put('shelf:' + me.cid, s); return J({ ok: 1 }); }
    if (p === '/request'){ const oc = await env.FRIENDS.get('code:' + String(body.code || '')); if (!oc) return J({ error: 'This invite link was turned off.' }, 404); if (oc === me.cid) return J({ error: 'That’s your own link.' }, 400);
      const o = await get(env, 'own:' + oc); if (!o) return J({ error: 'gone' }, 404); if (!o.viewers[me.cid]) o.viewers[me.cid] = { name: me.name, st: 'ask', at: Date.now() }; await put(env, 'own:' + oc, o);
      const fol = (await get(env, 'fol:' + me.cid)) || {}; fol[oc] = { name: o.name, at: Date.now() }; await put(env, 'fol:' + me.cid, fol); return J({ ok: 1, name: o.name, st: o.viewers[me.cid].st }); }
    if (p === '/approve' || p === '/revoke'){ const v = own.viewers[String(body.cid || '')]; if (!v) return J({ error: 'not found' }, 404);
      if (p === '/approve') v.st = 'ok'; else delete own.viewers[String(body.cid)]; await put(env, 'own:' + me.cid, own); return J({ ok: 1 }); }
    if (p === '/unfollow'){ const oc = String(body.cid || ''); const fol = (await get(env, 'fol:' + me.cid)) || {}; delete fol[oc]; await put(env, 'fol:' + me.cid, fol);
      const o = await get(env, 'own:' + oc); if (o && o.viewers[me.cid]){ delete o.viewers[me.cid]; await put(env, 'own:' + oc, o); } return J({ ok: 1 }); }
    return J({ error: 'not found' }, 404);
  }
};
