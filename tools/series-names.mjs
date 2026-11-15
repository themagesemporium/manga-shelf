import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname, OUT = ROOT + 'names-out/';
fs.mkdirSync(OUT, { recursive: true });
const out = (...a) => { console.log(...a); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, a.join(' ') + '\n\n'); };
const save = (f, v) => fs.writeFileSync(OUT + f, JSON.stringify(v, null, 1));
const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
if (!id || !secret){ out('Missing secrets.'); process.exit(1); }
const tj = await (await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) })).json().catch(() => ({}));
if (!tj.access_token){ out('Could not get a store token'); process.exit(1); }
const TOKEN = tj.access_token;
globalThis.window = globalThis;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); const m = s.match(/^https:\/\/raw\.githubusercontent\.com\/themagesemporium\/manga-shelf\/main\/([^?]+)/); if (m) return new Response(fs.readFileSync(ROOT + m[1])); return realFetch(u, o); };
window._api = async (query, variables) => {
  for (let i = 0; i < 8; i++){
    const r = await realFetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query, variables }) });
    if (r.status === 429 || r.status >= 500){ await new Promise(z => setTimeout(z, 2000 * (i + 1))); continue; }
    const j = await r.json(); if (j.errors && JSON.stringify(j.errors).includes('THROTTLED')){ await new Promise(z => setTimeout(z, 3000 * (i + 1))); continue; }
    if (j.errors) console.log('GraphQL error:', JSON.stringify(j.errors).slice(0, 300));
    return j;
  }
  throw new Error('Shopify API kept throttling');
};

// Series-name audit (workflow "Names"). MODE=export: groups listings by custom.series + type and compares the series name with
// the listing titles; writes names-out/todo.json [[series, type, count, suggested, [example titles]]] for names that look broken
// (title base differs). MODE=apply: renames per tools/data/series-renames.json [[old, type, new], ...]: sets custom.series on
// every listing of that series+type, and retitles/re-points the series page (handle redirects).
const MODE = process.env.MODE || 'export';
const all = []; let cur = null;
do { const r = await window._api(`query($c:String){products(first:250,after:$c,query:"(product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel') AND -tag:Bundle AND -tag:'Shopify Collective'"){pageInfo{hasNextPage endCursor} nodes{id title productType status se:metafield(namespace:"custom",key:"series"){value}}}}`, { c: cur });
  all.push(...r.data.products.nodes); cur = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null; } while (cur);
const base = t => String(t).replace(/\s*[-–(]?\s*(BRAND NEW|Ex Library|Ex-Library|exlib).*$/i, '').replace(/\s+(Light Novel\s+)?(Vol\.?|Volume|Omnibus Vol\.?|Omnibus)\s*\d.*$/i, '').replace(/\s+Light Novel$/i, '').replace(/\s+Vol\.?$/i, '').trim();
const G = {}; all.forEach(p => { const s = p.se && p.se.value; if (!s) return; const k = s + '|' + p.productType; (G[k] = G[k] || []).push(p); });
if (MODE === 'export'){
  const out = []; const log = (...a) => { console.log(...a); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, a.join(' ') + '\n\n'); };
  for (const [k, L] of Object.entries(G)){ const [s, t] = k.split('|'); const cnt = {}; L.forEach(p => { const b = base(p.title); cnt[b] = (cnt[b] || 0) + 1; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; if (!top) continue; const n = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const bad = n(top[0]) !== n(s) && !n(top[0]).startsWith(n(s) + 'omnibus');
    const susp = /[.:,\-]$/.test(s) || s.length < 3;
    if (bad || susp) out.push([s, t, L.length, top[0], L.slice(0, 3).map(p => p.title)]); }
  out.sort((a, b) => b[2] - a[2]); save('todo.json', out); log(`${all.length} listings, ${Object.keys(G).length} series; ${out.length} names to check.`); process.exit(0);
}
const R = JSON.parse(fs.readFileSync(ROOT + 'tools/data/series-renames.json', 'utf8')); const M = []; let pages = 0;
for (const [old, t, nw] of R){ const L = G[old + '|' + t] || []; L.forEach(p => M.push({ ownerId: p.id, namespace: 'custom', key: 'series', type: 'single_line_text_field', value: nw }));
  const c = await window._api(`query($q:String){collections(first:20,query:$q){nodes{id title handle ruleSet{appliedDisjunctively rules{column relation condition conditionObject{... on CollectionRuleMetafieldCondition{metafieldDefinition{id}}}}}}}}`, { q: 'title:' + JSON.stringify(old) });
  for (const col of (c.data.collections.nodes || [])){ const rs = col.ruleSet; if (!rs || !rs.rules.some(r => r.condition === old)) continue;
    const rules = rs.rules.map(r => ({ column: r.column, relation: r.relation, condition: r.condition === old ? nw : r.condition, ...(r.conditionObject && r.conditionObject.metafieldDefinition ? { conditionObjectId: r.conditionObject.metafieldDefinition.id } : {}) }));
    const h = 'series-' + nw.toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + (/light novel/i.test(t) ? '-light-novel' : '');
    const u = await window._api(`mutation($c:CollectionInput!){collectionUpdate(input:$c){userErrors{message}}}`, { c: { id: col.id, title: col.title === old ? nw : col.title.replace(old, nw), handle: h, redirectNewHandle: true, ruleSet: { appliedDisjunctively: rs.appliedDisjunctively, rules } } });
    if (u.data.collectionUpdate.userErrors.length) out('page ERR ' + old + ': ' + JSON.stringify(u.data.collectionUpdate.userErrors)); else pages++; } }
let w = 0; for (let i = 0; i < M.length; i += 25){ const r = await window._api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 25) }); if (r.data.metafieldsSet.userErrors.length) out('ERR ' + JSON.stringify(r.data.metafieldsSet.userErrors).slice(0, 200)); else w += Math.min(25, M.length - i); }
out(`Renamed ${R.length} series: ${w} listings, ${pages} series pages.`);
