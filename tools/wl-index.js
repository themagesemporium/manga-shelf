// One-list wishlist: rebuild the alert index from every customer's custom.store_wishlist.
// Writes the shop metafield mme_app.wl_index = {keys:{"series|vol[|ln]" or "p:<productId>": [customerId...]}, pref:{customerId:'hourly'|'daily'|'off'}}.
// The Cloudflare worker (mme-friends) loads it at the top of each hour. Run by the nightly GitHub job, or in an admin tab with window._api: await _wiRun()
window._wiRun = async () => {
  const R = window._WI = { customers: 0, items: 0, keys: 0, err: [] };
  const wkey = it => it.s && +it.v ? String(it.s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + Math.round(+it.v) + (it.ln ? '|ln' : '') : it.p ? 'p:' + it.p : '';
  const keys = {}, pref = {}; let a = null;
  do { const r = await _api(`query($a:String){customers(first:250,after:$a){pageInfo{hasNextPage endCursor} nodes{id sw:metafield(namespace:"custom",key:"store_wishlist"){value}}}}`, { a });
    if (!r.data){ R.err.push(JSON.stringify(r.errors).slice(0, 200)); break; }
    for (const c of r.data.customers.nodes){ if (!c.sw) continue; let w; try { w = JSON.parse(c.sw.value); } catch(e){ continue; } const cid = c.id.split('/').pop();
      const its = Array.isArray(w.items) ? w.items : []; if (!its.length) continue; R.customers++; pref[cid] = (w.prefs && w.prefs.email) || 'hourly';
      for (const it of its){ const k = wkey(it); if (!k) continue; R.items++; const L = keys[k] = keys[k] || []; if (!L.includes(cid)) L.push(cid); } }
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null; } while (a);
  R.keys = Object.keys(keys).length;
  const shop = (await _api('{shop{id}}')).data.shop.id;
  // json metafields are size-capped, so the keys go out in parts of ~90 KB: wl_index (prefs + part count) and wl_index0..N
  const parts = [{}]; let size = 0; for (const [k, L] of Object.entries(keys)){ const n = k.length + L.join(',').length + 40; if (size + n > 90000){ parts.push({}); size = 0; } parts[parts.length - 1][k] = L; size += n; }
  const m = [{ ownerId: shop, namespace: 'mme_app', key: 'wl_index', type: 'json', value: JSON.stringify({ pref, parts: parts.length, at: new Date().toISOString() }) }]
    .concat(parts.map((P, i) => ({ ownerId: shop, namespace: 'mme_app', key: 'wl_index' + i, type: 'json', value: JSON.stringify(P) })));
  for (let i = 0; i < m.length; i += 20){ const w = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: m.slice(i, i + 20) });
    const ue = w.data ? w.data.metafieldsSet.userErrors : w.errors; if (ue && ue.length) R.err.push(JSON.stringify(ue).slice(0, 200)); }
  R.parts = parts.length;
  return R; };
