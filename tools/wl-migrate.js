// One-list wishlist: import the SE Wishlist Engine export (CSV) into each customer's custom.store_wishlist. Adds only; never removes what's there.
// In a Shopify admin tab with window._api: const f = <File>; await _wmRun(await f.text())   Progress in window._WM.
// CSV columns: email, shopify_customer_id, shopify_product_id, shopify_variant_id, title, shopify_product_handle, wishlist_status, created
window._wmRun = async (csv) => {
  const R = window._WM = { customers: 0, added: 0, kept: 0, skipped: 0, err: [], fin: false };
  const rows = []; { let i = 0, f = '', row = [], q = false; for (; i < csv.length; i++){ const c = csv[i];
    if (q){ if (c === '"' && csv[i + 1] === '"'){ f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ','){ row.push(f); f = ''; } else if (c === '\n' || c === '\r'){ if (c === '\r' && csv[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1) rows.push(row); row = []; } else f += c; }
    if (f || row.length){ row.push(f); rows.push(row); } }
  const H = rows.shift().map(h => h.trim()); const ix = n => H.indexOf(n);
  const C = ix('shopify_customer_id'), P = ix('shopify_product_id'), S = ix('wishlist_status'), D = ix('created'), HD = ix('shopify_product_handle'), T = ix('title');
  const last = {}; for (const r of rows){ const cid = r[C], pid = r[P]; if (!/^\d+$/.test(cid || '') || !/^\d+$/.test(pid || '')) continue; const k = cid + '|' + pid; const at = r[D] || '';
    if (!last[k] || at >= last[k].at) last[k] = { cid, pid, at, on: /added/i.test(r[S] || ''), h: String(r[HD] || '').split('/products/').pop(), t: r[T] }; }
  const by = {}; for (const e of Object.values(last)) if (e.on) (by[e.cid] = by[e.cid] || []).push(e);
  const pids = [...new Set(Object.values(by).flat().map(e => e.pid))], info = {};
  for (let i = 0; i < pids.length; i += 100){ const r = await _api(`query($ids:[ID!]!){nodes(ids:$ids){... on Product{id handle title productType se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value}}}}`, { ids: pids.slice(i, i + 100).map(p => 'gid://shopify/Product/' + p) });
    for (const n of (r.data && r.data.nodes) || []){ if (!n) continue; const vol = n.vo && +n.vo.value || +(String(n.title).match(/\bvol(?:ume)?\.?\s*(\d+(?:\.\d)?)/i) || [])[1] || 0;
      info[n.id.split('/').pop()] = { h: n.handle, t: n.title, s: n.se && n.se.value || '', v: vol, ln: /novel/i.test(n.productType || '') ? 1 : 0 }; } }
  const wkey = it => it.s && +it.v ? String(it.s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + Math.round(+it.v) + (it.ln ? '|ln' : '') : it.p ? 'p:' + it.p : '';
  const cids = Object.keys(by);
  for (let i = 0; i < cids.length; i += 25){ const chunk = cids.slice(i, i + 25);
    const cur = await _api(`query($ids:[ID!]!){nodes(ids:$ids){... on Customer{id sw:metafield(namespace:"custom",key:"store_wishlist"){value}}}}`, { ids: chunk.map(c => 'gid://shopify/Customer/' + c) });
    const m = [];
    for (const n of (cur.data && cur.data.nodes) || []){ if (!n) continue; const cid = n.id.split('/').pop(); let w = {}; try { w = JSON.parse(n.sw && n.sw.value || '{}') || {}; } catch(e){}
      w.items = Array.isArray(w.items) ? w.items : []; const have = new Set(w.items.map(wkey)); w.items.forEach(x => { if (x.p) have.add('p:' + x.p); }); let add = 0;
      for (const e of by[cid]){ const I = info[e.pid]; const it = { p: e.pid, at: String(e.at).slice(0, 10) }; if (I){ it.h = I.h; it.t = I.t; if (I.s && I.v){ it.s = I.s; it.v = I.v; if (I.ln) it.ln = 1; } } else { if (e.h) it.h = e.h; it.t = e.t; }
        const k = wkey(it); if (have.has(k) || have.has('p:' + e.pid)){ R.kept++; continue; } w.items.push(it); have.add(k); add++; R.added++; }
      if (!add) continue; R.customers++; w.updated = new Date().toISOString(); m.push({ ownerId: n.id, namespace: 'custom', key: 'store_wishlist', type: 'json', value: JSON.stringify(w) }); }
    if (m.length){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m }); const ue = r.data ? r.data.metafieldsSet.userErrors : r.errors; if (ue && ue.length) R.err.push(JSON.stringify(ue).slice(0, 200)); } }
  R.fin = true; return R; };
