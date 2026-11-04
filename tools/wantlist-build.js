// Want List data: out-of-stock books customers want, grouped by series, counts only (no names).
// Run in a Shopify admin tab with window._api defined, then _wlRun(). Progress in window._WL.
// Sources: every customer's custom.store_wishlist items (website wishlist, kept live by Flow) and their app Wishlist (mme.shelf0..7).
// Writes JSON rows [[series, wishers, [[ "Vol N", count ], ...]], ...] to shop metafields claude_tmp.wantlist0, wantlist1, ...
// Build the page with tools/build_wantlist.py and publish it to the Want List artifact.
window._wlRun = async () => {
  const WL = window._WL = { st: 'customers', cust: 0, wishers: 0, products: 0, rows: 0, parts: 0, fin: false, err: [] };
  const SKIP = new Set(['99230547976']); // Megan's own account
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip')); return await new Response(s).text(); };
  const norm = s => String(s || '').toLowerCase().replace(/\s*\(light novel\)\s*/g, '').trim();
  const want = new Map(); // key -> {name, v, ln, who:Set}
  const add = (cid, name, v, ln) => { v = Math.round(+v); if (!name || !v) return; const k = norm(name) + '|' + v + '|' + (ln ? 1 : 0); let e = want.get(k); if (!e){ e = { name: String(name).replace(/\s*\(light novel\)\s*/i, '').trim(), v, ln: !!ln, who: new Set() }; want.set(k, e); } e.who.add(cid); };
  const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
  let a = null;
  do {
    const r = await _api(`query($a:String){customers(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id sw:metafield(namespace:"custom",key:"store_wishlist"){value} ${MF}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    for (const c of r.data.customers.nodes){
      const cid = c.id.split('/').pop(); if (SKIP.has(cid)) continue;
      if (c.sw && c.sw.value){ try { (JSON.parse(c.sw.value).items || []).forEach(x => add(cid, x.s, x.v, x.ln)); } catch (e) {} }
      if (c.m0 && c.m0.value){
        let b = ''; for (let i = 0; i < 8; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
        try { const sh = JSON.parse(await unGz(b)); Object.values(sh.series || {}).forEach(s => (s.want || []).forEach(v => add(cid, s.n, v, /light novel/i.test(s.n)))); } catch (e) { WL.err.push('shelf ' + cid); }
      }
    }
    WL.cust += r.data.customers.nodes.length;
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (a);
  WL.st = 'products'; const inStock = new Set(); a = null;
  do {
    const r = await _api(`query($a:String){products(first:250,after:$a,query:"status:active AND inventory_total:>0"){pageInfo{hasNextPage endCursor} nodes{productType se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    r.data.products.nodes.forEach(p => { if (p.se && p.vo) inStock.add(norm(p.se.value) + '|' + Math.round(parseFloat(p.vo.value)) + '|' + (p.productType === 'Light Novel' ? 1 : 0)); });
    WL.products += r.data.products.nodes.length;
    a = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (a);
  WL.st = 'group'; const S = new Map();
  for (const [k, e] of want){
    if (inStock.has(k)) continue;
    const sk = norm(e.name) + (e.ln ? '|ln' : ''); let g = S.get(sk);
    if (!g){ g = { n: e.name + (e.ln ? ' (Light Novel)' : ''), who: new Set(), vols: [] }; S.set(sk, g); }
    e.who.forEach(w => g.who.add(w)); g.vols.push([e.v, e.who.size]);
  }
  const rows = [...S.values()].map(g => [g.n, g.who.size, g.vols.sort((x, y) => x[0] - y[0]).map(([v, n]) => ['Vol ' + v, n])]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  WL.wishers = new Set([...want.values()].flatMap(e => [...e.who])).size; WL.rows = rows.length;
  WL.st = 'write'; const json = JSON.stringify(rows); window._WLJSON = json;
  const parts = []; for (let i = 0; i < json.length; i += 60000) parts.push(json.slice(i, i + 60000));
  const M = parts.map((v, i) => ({ ownerId: 'gid://shopify/Shop/19355029', namespace: 'claude_tmp', key: 'wantlist' + i, type: 'multi_line_text_field', value: v }));
  for (let i = 0; i < M.length; i += 5){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 5) }); if (!r.data || r.data.metafieldsSet.userErrors.length) WL.err.push('write'); }
  WL.parts = parts.length; WL.st = 'done'; WL.fin = true;
};
