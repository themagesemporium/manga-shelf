import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname, OUT = ROOT + 'spice-out/';
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

// Spice level + content notes backfill (workflow "Spice"). Rules: romance / BL / yuri always get a spice level (1 Sweet = none);
// other genres only when there is sexual content. Older Teen and Mature series get content notes.
// MODE=export -> spice-out/todo.json {key:{n,ln,c,g,a,au,d,sp?,cn?,need:"sp"|"cn"|"sp+cn"}} for series still missing them.
// MODE=apply -> (1) copies a series' spice / notes onto its volumes that lack them; (2) writes tools/spice-data.json
// {"<series>|<0/1>": {"sp":"1 Sweet"|"" , "cn":[...]}} ("" / [] = reviewed, nothing applies).
const MODE = process.env.MODE || 'export';
const DATA = ROOT + 'tools/spice-data.json'; const data = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : {};
const SP = ['1 Sweet','2 Ketchup','3 Salsa','4 Hot Sauce','5 Ghost Pepper'];
const CN = ['Graphic violence/gore','Strong language','Sexual content','Nudity','Sexual assault','Abuse','Self-harm/suicide','Drug use','Animal harm','Death of a loved one','Disturbing imagery'];
const all = []; let cur = null;
do { const r = await window._api(`query($c:String){products(first:250,after:$c,query:"status:active AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel') AND -tag:Bundle"){pageInfo{hasNextPage endCursor} nodes{id description se:metafield(namespace:"custom",key:"series"){value} pt:productType gs:metafield(namespace:"custom",key:"genres"){value} g1:metafield(namespace:"custom",key:"genre"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} au:metafield(namespace:"custom",key:"author"){value} sp:metafield(namespace:"custom",key:"spice_level"){value} cn:metafield(namespace:"custom",key:"content_notes"){value}}}}`, { c: cur });
  all.push(...r.data.products.nodes); cur = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null; } while (cur);
const S = {};
for (const p of all){ const n = p.se && p.se.value; if (!n) continue; const k = n + '|' + (p.pt === 'Light Novel' ? 1 : 0);
  const s = S[k] = S[k] || { n, ln: p.pt === 'Light Novel' ? 1 : 0, ids: [], sp: '', cn: [], g: new Set(), a: '', au: '', d: '' }; s.ids.push(p);
  if (p.sp && p.sp.value && !s.sp) s.sp = p.sp.value; try { const c = JSON.parse(p.cn && p.cn.value || '[]'); if (c.length > s.cn.length) s.cn = c; } catch(e){}
  try { JSON.parse(p.gs && p.gs.value || '[]').forEach(x => s.g.add(x)); } catch(e){} if (p.g1 && p.g1.value) s.g.add(p.g1.value);
  if (!s.a && p.ag) s.a = p.ag.value; if (!s.au && p.au) s.au = p.au.value;
  const d = String(p.description || '').replace(/\s+/g, ' ').replace(/^.*?(published in English by[^.]*\.|in \d{4}\.)\s*/i, ''); if (d.length > s.d.length) s.d = d.slice(0, 220); }
const ROM = /romance|yaoi|\bbl\b|boys.? love|yuri|girls.? love|shojo.?ai|shonen.?ai|smut|josei|ecchi|harem|hentai|adult/i;
const keys = Object.keys(S);
const needSp = s => !s.sp && (ROM.test([...s.g].join(' ')) || s.a === 'Mature');
const needCn = s => !s.cn.length && (s.a === 'Mature' || s.a === 'Older Teen');
out(`${all.length} listings, ${keys.length} series. Missing spice where needed: ${keys.filter(k => needSp(S[k])).length}; missing notes on Older Teen/Mature: ${keys.filter(k => needCn(S[k])).length}. Reviewed in spice-data.json: ${Object.keys(data).length}.`);
if (MODE === 'export'){ const todo = {};
  keys.filter(k => (needSp(S[k]) && !(data[k] && 'sp' in data[k])) || (needCn(S[k]) && !(data[k] && 'cn' in data[k]))).sort().forEach(k => { const s = S[k];
    todo[k] = { n: s.n, ln: s.ln, c: s.ids.length, g: [...s.g].join(', '), a: s.a, au: s.au, d: s.d, sp: s.sp || undefined, cn: s.cn.length ? s.cn : undefined, need: [needSp(s) && 'sp', needCn(s) && 'cn'].filter(Boolean).join('+') }; });
  save('todo.json', todo); out(`To review: ${Object.keys(todo).length} series.`); process.exit(0); }
const M = []; let copied = 0, fromData = 0, bad = [];
for (const k of keys){ const s = S[k], D = data[k] || {};
  let sp = s.sp || (D.sp && SP.includes(D.sp) ? D.sp : ''); if (D.sp && !SP.includes(D.sp)) bad.push(k + ' sp ' + D.sp);
  let cn = s.cn.length ? s.cn : (D.cn || []).filter(x => CN.includes(x)); (D.cn || []).filter(x => !CN.includes(x)).forEach(x => bad.push(k + ' cn ' + x));
  for (const p of s.ids){
    if (sp && !(p.sp && p.sp.value)){ M.push({ ownerId: p.id, namespace: 'custom', key: 'spice_level', type: 'single_line_text_field', value: sp }); s.sp ? copied++ : fromData++; }
    let has = []; try { has = JSON.parse(p.cn && p.cn.value || '[]'); } catch(e){}
    if (cn.length && !has.length){ M.push({ ownerId: p.id, namespace: 'custom', key: 'content_notes', type: 'list.single_line_text_field', value: JSON.stringify(cn) }); s.cn.length ? copied++ : fromData++; } } }
let w = 0; for (let i = 0; i < M.length; i += 25){ const r = await window._api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 25) }); const e = r.data.metafieldsSet.userErrors; if (e.length) out('ERR ' + JSON.stringify(e).slice(0, 200)); else w += Math.min(25, M.length - i); }
out(`Wrote ${w} fields (${copied} copied from sibling volumes, ${fromData} from spice-data.json).` + (bad.length ? ' Skipped bad values: ' + bad.slice(0, 10).join('; ') : ''));
