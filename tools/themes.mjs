// Themes backfill (GitHub Actions, workflow "Themes"). MODE=export: every manga/LN series where no listing has custom.themes
// and that isn't in tools/themes-data.json yet -> themes-out/todo.json {key:{n,ln,t,g,a,d}} for Claude to classify.
// MODE=apply: writes tools/themes-data.json ({"<series>|<0/1 LN>": ["Isekai", ...]}, [] = reviewed, none apply) to every
// listing of that series (merged with any themes already there). Theme choices must match the custom.themes definition.
import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname, OUT = ROOT + 'themes-out/';
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
fs.mkdirSync(OUT, { recursive: true });
const MODE = process.env.MODE || 'export';
const DATA = ROOT + 'tools/themes-data.json';
const data = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : {};
const OK = ['Isekai','Reincarnation','Villainess','School Life','Magical Girl','Mecha','Martial Arts','Monsters & Demons','Vampires','Ninjas & Samurai','Cooking & Food','Music & Idols','Games & Virtual Worlds','Time Travel','Workplace','Found Family'];
// every book listing with its series, type, themes, genres, audience and a bit of description
const all = []; let cur = null;
do {
  const r = await window._api(`query($c:String){products(first:250,after:$c,query:"status:active AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel')"){pageInfo{hasNextPage endCursor} nodes{id productType description se:metafield(namespace:"custom",key:"series"){value} th:metafield(namespace:"custom",key:"themes"){value} gs:metafield(namespace:"custom",key:"genres"){value} au:metafield(namespace:"custom",key:"audience"){value}}}}`, { c: cur });
  all.push(...r.data.products.nodes); cur = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
} while (cur);
const S = {};
for (const p of all){ const n = p.se && p.se.value; if (!n) continue; const ln = p.productType === 'Light Novel' ? 1 : 0; const k = n + '|' + ln;
  const s = S[k] = S[k] || { n, ln, ids: [], th: new Set(), g: '', a: '', d: '' }; s.ids.push(p.id);
  try { JSON.parse(p.th && p.th.value || '[]').forEach(x => s.th.add(x)); } catch(e){}
  if (!s.g && p.gs) s.g = JSON.parse(p.gs.value || '[]').join(', '); if (!s.a && p.au) s.a = p.au.value;
  const d = String(p.description || '').replace(/\s+/g, ' ').replace(/^.*?(published in English by[^.]*\.|in \d{4}\.)\s*/i, ''); if (d.length > s.d.length) s.d = d.slice(0, 260); }
const keys = Object.keys(S);
out(`${all.length} listings, ${keys.length} series; ${keys.filter(k => S[k].th.size).length} have themes; ${Object.keys(data).length} reviewed in themes-data.json.`);
if (MODE === 'export'){
  const todo = {}; keys.filter(k => !S[k].th.size && !(k in data)).sort().forEach(k => { const s = S[k]; todo[k] = { n: s.n, ln: s.ln, c: s.ids.length, g: s.g, a: s.a, d: s.d }; });
  save('todo.json', todo); out(`To classify: ${Object.keys(todo).length} series.`);
} else {
  let w = 0, bad = []; const M = [];
  for (const [k, th] of Object.entries(data)){ const s = S[k]; if (!s || !th.length) continue; const t = th.filter(x => OK.includes(x)); bad.push(...th.filter(x => !OK.includes(x)));
    const merged = [...new Set([...s.th, ...t])]; if (merged.length === s.th.size) continue;
    s.ids.forEach(id => M.push({ ownerId: id, namespace: 'custom', key: 'themes', type: 'list.single_line_text_field', value: JSON.stringify(merged) })); }
  for (let i = 0; i < M.length; i += 25){ const r = await window._api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 25) }); const e = r.data.metafieldsSet.userErrors; if (e.length) out('errors:', JSON.stringify(e).slice(0, 200)); else w += Math.min(25, M.length - i); }
  out(`Wrote themes on ${w} listings.` + (bad.length ? ' Unknown themes skipped: ' + [...new Set(bad)].join(', ') : ''));
}
