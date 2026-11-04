// App wishlist -> website wishlist (SE Wishlist Engine import file).
// Run in a Shopify admin tab with window._api defined. Then call _wsRun().
// 1. Reads every app user's shelf (customer metafields mme.shelf0..7, gzip + base64) and collects their Wishlist volumes.
// 2. Skips volumes already on their website wishlist (customer metafield custom.store_wishlist, which Flow keeps in sync with SE).
// 3. Finds the shop listing for each remaining volume (custom.series + custom.volume, active, not Ex Library or a set).
// 4. Writes an SE-format import CSV to the shop metafield claude_tmp.wl_import (split into wl_import1, 2... if long).
// Progress and counts are in window._WS. Customers with nothing new are skipped.
window._wsRun = async () => {
  const WS = window._WS = { st: 'scan', scanned: 0, users: 0, wants: 0, rows: 0, noListing: 0, parts: 0, fin: false, err: [] };
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip')); return await new Response(s).text(); };
  const norm = s => String(s || '').toLowerCase().replace(/\s*\(light novel\)\s*/g, '').trim();
  const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
  const users = []; let a = null;
  do {
    const r = await _api(`query($a:String){customers(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id email:defaultEmailAddress{emailAddress} sw:metafield(namespace:"custom",key:"store_wishlist"){value} ${MF}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    for (const c of r.data.customers.nodes){
      if (!c.m0 || !c.m0.value) continue;
      let b = ''; for (let i = 0; i < 8; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
      try {
        const sh = JSON.parse(await unGz(b)); const w = [];
        Object.values(sh.series || {}).forEach(s => (s.want || []).forEach(v => w.push({ n: s.n, v: Math.round(+v), ln: /light novel/i.test(s.n) })));
        if (!w.length) continue;
        let have = []; try { have = (JSON.parse(c.sw && c.sw.value || '{}').items || []); } catch (e) { have = []; }
        const hs = new Set(have.map(x => norm(x.s) + '|' + Math.round(+x.v) + '|' + (x.ln ? 1 : 0)));
        const todo = w.filter(x => !hs.has(norm(x.n) + '|' + x.v + '|' + (x.ln ? 1 : 0)));
        if (todo.length) users.push({ cid: c.id.split('/').pop(), e: c.email && c.email.emailAddress, w: todo });
      } catch (e) { WS.err.push('shelf ' + c.id.split('/').pop()); }
    }
    WS.scanned += r.data.customers.nodes.length;
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (a);
  WS.users = users.length; WS.wants = users.reduce((x, u) => x + u.w.length, 0); WS.st = 'match';
  const cache = {}; const rows = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const u of users){
    if (!u.e) continue;
    for (const x of u.w){
      const n = x.n.replace(/\s*\(light novel\)/i, '').trim(); const key = n.toLowerCase() + (x.ln ? '|ln' : '');
      if (!cache[key]){
        const r = await _api(`query($q:String){products(first:100,query:$q){nodes{id title handle status productType vo:metafield(namespace:"custom",key:"volume"){value} se:metafield(namespace:"custom",key:"series"){value} variants(first:1){nodes{id}}}}}`, { q: `metafields.custom.series:"${n.replace(/"/g, '')}"` });
        cache[key] = r.data ? r.data.products.nodes.filter(p => p.se && p.se.value.toLowerCase() === n.toLowerCase() && (p.productType === 'Light Novel') === x.ln && p.status === 'ACTIVE' && !/Ex Library|Set$/i.test(p.title)) : [];
      }
      const p = cache[key].find(p => Math.round(parseFloat(p.vo && p.vo.value)) === x.v);
      if (!p){ WS.noListing++; continue; }
      rows.push([u.e, u.cid, p.id.split('/').pop(), p.variants.nodes[0].id.split('/').pop(), p.title, 'https://the-mages-emporium.myshopify.com/products/' + p.handle, 'Added wishlist', today]);
    }
  }
  WS.rows = rows.length; WS.st = 'write';
  const q = s => /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s;
  const csv = rows.length ? 'email,shopify_customer_id,shopify_product_id,shopify_variant_id,title,shopify_product_handle,wishlist_status,created\n' + rows.map(r => r.map(q).join(',')).join('\n') : '';
  window._WSCSV = csv;
  const parts = []; for (let i = 0; i < csv.length; i += 60000) parts.push(csv.slice(i, i + 60000));
  const M = parts.map((v, i) => ({ ownerId: 'gid://shopify/Shop/19355029', namespace: 'claude_tmp', key: 'wl_import' + (i ? i : ''), type: 'multi_line_text_field', value: v }));
  if (M.length){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M }); if (!r.data || r.data.metafieldsSet.userErrors.length) WS.err.push('write'); }
  WS.parts = parts.length; WS.st = 'done'; WS.fin = true;
};
