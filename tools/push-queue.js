// Queue push notifications for app users. Run in a Shopify admin tab with window._api defined.
// _pqAdd([{cid: '<customerId>' | '*', k: 'msgs'|'stock'|'orders'|'deals', t: 'Title', b: 'Body text', u: '/', s: '2026-12-25T08:00:00-05:00' (optional: not before)}, ...])
// Writes the shop metafield mme_app.push_queue (storefront-readable). The friends worker's cron sends new items every
// 10 minutes to people who turned notifications on and kept that kind switched on. Customer ids are stored hashed.
// Keep the text friendly and free of personal details (it's readable by anyone who knows where to look).
// Result in window._PQ {added, size, err}.
window._pqAdd = async (items) => {
  const PQ = window._PQ = { added: 0, size: 0, err: [] };
  try {
    const sha = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const r = await _api(`{shop{id metafield(namespace:"mme_app",key:"push_queue"){value}}}`);
    let Q = []; try { Q = JSON.parse(r.data.shop.metafield.value) || []; } catch (e) {}
    let id = Math.max(Date.now(), ...Q.map(x => +x.id + 1));
    for (const it of items || []){ if (!it || !it.t) continue;
      Q.push({ id: id++, h: it.cid === '*' ? '*' : await sha('mme:' + String(it.cid).replace(/\D/g, '')), k: it.k || 'msgs', t: String(it.t).slice(0, 80), b: String(it.b || '').slice(0, 200), u: it.u || '/', at: Date.now(), ...(it.s ? { s: +new Date(it.s) } : {}) }); PQ.added++; }
    Q = Q.filter(x => Date.now() - Math.max(+x.at || +x.id, +x.s || 0) < 7 * 864e5).slice(-300); PQ.size = Q.length;
    const w = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: r.data.shop.id, namespace: 'mme_app', key: 'push_queue', type: 'json', value: JSON.stringify(Q) }] });
    if (w.data.metafieldsSet.userErrors.length) PQ.err.push(JSON.stringify(w.data.metafieldsSet.userErrors));
  } catch (e) { PQ.err.push(String(e).slice(0, 200)); }
  return PQ;
};
