import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname, OUT = ROOT + 'sets-out/';
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

// Set audit (workflow "Sets"). MODE=report writes sets-out/plan.json + summary; MODE=apply makes the changes.
// Rules (bundles convention): Vol 1/2/3 not in stock -> DRAFT. A later volume sold -> shrink to Vol 1..end of the unbroken
// in-stock run. Complete sets that lose a volume become plain "Vol 1-N Set" (Complete Series tag dropped).
// Drafted sets whose Vol 1-3 are back -> restored at the current run. Runs never go past 30 books.
const MODE = process.env.MODE || 'report';
const q = async (query, v) => { const r = await window._api(query, v); return r.data; };
const SF = `id title status productType tags variants(first:1){nodes{id price sku inventoryQuantity}} se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value} ed:metafield(namespace:"custom",key:"edition"){value} bs:metafield(namespace:"custom",key:"bundle_set"){value}`;
// all sets
const sets = []; let cur = null;
do { const d = await q(`query($c:String){products(first:50,after:$c,query:"tag:Bundle AND -status:archived"){pageInfo{hasNextPage endCursor} nodes{id title handle status tags productType descriptionHtml seo{title description} variants(first:1){nodes{id price compareAtPrice productVariantComponents(first:60){nodes{id productVariant{id inventoryQuantity product{${SF}}}}}}}}}}`, { c: cur });
  sets.push(...d.products.nodes); cur = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null; } while (cur);
out(`${sets.length} sets (${sets.filter(s => s.status === 'ACTIVE').length} active, ${sets.filter(s => s.status === 'DRAFT').length} draft).`);
// singles of every series that has a set
const series = new Map(); const exlib = p => /ex.?library/i.test(p.title) || /EXLIB/i.test(p.variants.nodes[0]?.sku || '');
const serOf = s => { const c = s.variants.nodes[0]?.productVariantComponents.nodes.map(x => x.productVariant.product) || []; const f = c.find(p => p.se && p.se.value); return f ? f.se.value : null; };
const singles = {};
for (const s of sets){ const n = serOf(s); if (!n || singles[n]) continue;
  const L = []; let c2 = null; do { const d = await q(`query($c:String,$q:String){products(first:100,after:$c,query:$q){pageInfo{hasNextPage endCursor} nodes{${SF}}}}`, { c: c2, q: `${JSON.stringify(n.replace(/["\\]/g, ''))} AND -tag:Bundle` });
    L.push(...d.products.nodes.filter(p => p.se && p.se.value === n)); c2 = d.products.pageInfo.hasNextPage && L.length < 400 ? d.products.pageInfo.endCursor : null; } while (c2);
  singles[n] = L; }
const plan = [];
for (const s of sets){ const v = s.variants.nodes[0]; if (!v) continue; const comps = v.productVariantComponents.nodes.map(x => x.productVariant);
  const n = serOf(s); const vol = p => p.vo ? Math.round(parseFloat(p.vo.value)) : null;
  if (!n || !comps.length){ plan.push({ id: s.id, title: s.title, act: 'skip', why: 'no series/components' }); continue; }
  if (comps.some(p => p.product.ed && p.product.ed.value)){ const oos = comps.filter(p => !(p.inventoryQuantity > 0) || p.product.status !== 'ACTIVE');
    plan.push({ id: s.id, title: s.title, act: oos.length ? (s.status === 'ACTIVE' ? 'draft' : 'keep') : (s.status === 'DRAFT' ? 'restore-same' : 'ok'), why: 'edition set' + (oos.length ? ': out ' + oos.map(p => p.product.title).join(', ') : '') }); continue; }
  const L = (singles[n] || []).filter(p => p.productType === s.productType && !(p.ed && p.ed.value) && p.status === 'ACTIVE' && vol(p) > 0 && !/box set|collector|variant|sealed|special edition|deluxe/i.test(p.title));
  const inSet = new Set(comps.map(p => p.id));
  const pick = k => { const c = L.filter(p => vol(p) === k && p.variants.nodes[0].inventoryQuantity > 0); if (!c.length) return null;
    return c.find(p => inSet.has(p.variants.nodes[0].id)) || c.find(p => !exlib(p)) || null; };
  let R = 0; const chosen = []; while (R < 30){ const p = pick(R + 1); if (!p) break; chosen.push(p); R++; }
  const N = comps.length, complete = s.tags.includes('Complete Series');
  if (R < 3){ plan.push({ id: s.id, title: s.title, act: s.status === 'ACTIVE' ? 'draft' : 'keep', why: `Vol ${R + 1} out of stock` }); continue; }
  let to = R; if (complete && R >= N) to = N; // a complete set never grows
  if (to === N && comps.every(p => chosen.some(c => c.variants.nodes[0].id === p.id))){ plan.push({ id: s.id, title: s.title, act: s.status === 'DRAFT' ? 'restore-same' : 'ok' }); continue; }
  if (to > N && s.status === 'ACTIVE' && !process.env.GROW){ // in stock as is but could grow: only report
    const okNow = comps.every(p => p.inventoryQuantity > 0); if (okNow){ plan.push({ id: s.id, title: s.title, act: 'ok', why: `could grow to Vol 1-${to}` }); continue; } }
  plan.push({ id: s.id, title: s.title, act: to < N ? 'shrink' : (s.status === 'DRAFT' ? 'restore' : 'grow'), from: N, to, complete, ser: n, status: s.status,
    keep: chosen.slice(0, to).map(p => ({ pid: p.id, vid: p.variants.nodes[0].id, price: +p.variants.nodes[0].price, t: p.title })),
    drop: comps.filter(p => !chosen.slice(0, to).some(c => c.variants.nodes[0].id === p.id)).map(p => ({ pid: p.product.id, vid: p.id, t: p.product.title })),
    comp: v.productVariantComponents.nodes.map(x => ({ cid: x.id, vid: x.productVariant.id })), vid: v.id, handle: s.handle, desc: s.descriptionHtml, seo: s.seo, tags: s.tags, pt: s.productType }); }
save('plan.json', plan);
const cnt = {}; plan.forEach(p => cnt[p.act] = (cnt[p.act] || 0) + 1); out('Plan: ' + JSON.stringify(cnt));
plan.filter(p => !['ok','keep','skip'].includes(p.act)).forEach(p => out(`- ${p.act}: ${p.title}${p.to ? ` -> Vol 1-${p.to}` : ''}${p.why ? ' (' + p.why + ')' : ''}`));
if (MODE !== 'apply') process.exit(0);
const log = []; const E = (r, w) => { const e = JSON.stringify(r).match(/"userErrors":\[([^\]]+)\]/); if (e || r.errors) { out('ERR ' + w + ': ' + (e ? e[1] : JSON.stringify(r.errors)).slice(0, 250)); return true; } return false; };
for (const p of plan){
  if (p.act === 'draft'){ const r = await window._api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, status: 'DRAFT' } }); if (!E(r, p.title)) log.push(['Drafted', p.title, p.why || '']); continue; }
  if (p.act === 'restore-same'){ const r = await window._api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, status: 'ACTIVE' } }); if (!E(r, p.title)) log.push(['Restored', p.title, '']); continue; }
  if (!['shrink','restore','grow'].includes(p.act)) continue;
  const lt = p.pt === 'Light Novel' ? ' (Light Novel)' : ''; const title = `${p.ser}${lt && !/light novel/i.test(p.ser) ? lt : ''} Vol 1-${p.to} Set`;
  const handle = title.toLowerCase().replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const vols = p.keep.map((k, i) => `Vol ${i + 1}`).join(', ');
  let desc = String(p.desc || '').replace(/(<p class="book-intro">.*?)\b(complete set|Vol 1-\d+ set|set)( by )/i, `$1Vol 1-${p.to} set$3`);
  const para = `<p>Start the series with Vol 1-${p.to} in one order. This set includes ${vols} (${p.to} books) at 10% off the individual prices.</p>`;
  desc = /<\/p>\s*<p>[^]*?This set includes[^]*?<\/p>/.test(desc) ? desc.replace(/(<\/p>\s*)<p>(?:(?!<p>)[^])*?This set includes[^]*?<\/p>/, `$1${para}`) : desc + para;
  const fmt = p.pt === 'Light Novel' ? 'Light Novel' : 'Manga';
  const seo = { title: `${title} ${/light novel/i.test(title) ? '' : fmt}`.trim(), description: String(p.seo && p.seo.description || '').replace(/^.*? by /, `${title} by `) };
  const tags = p.tags.filter(t => !(t === 'Complete Series' && p.to < p.from) && t !== 'outofstock');
  let r = await window._api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, title, handle, redirectNewHandle: true, descriptionHtml: desc, seo, tags, status: 'ACTIVE' } }); if (E(r, p.title)) continue;
  const have = new Set(p.comp.map(c => c.vid)), want = new Set(p.keep.map(k => k.vid));
  r = await window._api(`mutation($i:[ProductVariantRelationshipUpdateInput!]!){productVariantRelationshipBulkUpdate(input:$i){userErrors{message}}}`, { i: [{ parentProductVariantId: p.vid,
    productVariantRelationshipsToRemove: p.comp.filter(c => !want.has(c.vid)).map(c => c.vid),
    productVariantRelationshipsToCreate: p.keep.filter(k => !have.has(k.vid)).map(k => ({ id: k.vid, quantity: 1 })) }] }); if (E(r, p.title + ' components')) continue;
  const sum = p.keep.reduce((a, k) => a + k.price, 0);
  r = await window._api(`mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{message}}}`, { p: p.id, v: [{ id: p.vid, price: (Math.round(sum * 0.9 * 100) / 100).toFixed(2), compareAtPrice: sum.toFixed(2) }] }); E(r, p.title + ' price');
  const M = [{ ownerId: p.id, namespace: 'custom', key: 'bundle_items', type: 'list.product_reference', value: JSON.stringify(p.keep.map(k => k.pid)) }].concat(p.keep.map(k => ({ ownerId: k.pid, namespace: 'custom', key: 'bundle_set', type: 'product_reference', value: p.id })));
  for (let i = 0; i < M.length; i += 25){ r = await window._api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 25) }); E(r, p.title + ' metafields'); }
  const dropped = p.drop.filter(d => !p.keep.some(k => k.pid === d.pid));
  if (dropped.length){ r = await window._api(`mutation($m:[MetafieldIdentifierInput!]!){metafieldsDelete(metafields:$m){userErrors{message}}}`, { m: dropped.map(d => ({ ownerId: d.pid, namespace: 'custom', key: 'bundle_set' })) }); E(r, p.title + ' unlink'); }
  log.push([p.act === 'shrink' ? 'Shrunk' : p.act === 'grow' ? 'Grew' : 'Restored', `${p.title} → ${title}`, `$${(sum * 0.9).toFixed(2)}`]); }
save('log.json', log); out('Done: ' + log.length + ' changes.'); log.forEach(l => out('- ' + l.join(' | ')));
