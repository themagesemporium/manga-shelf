// Shopkeeper record (Megan, Nov 25 2026): every manga / light novel volume that has ever been in stock at the shop,
// kept apart from her collector shelf so it earns no collector XP. The app shows it as an owner-only card on the Stats tab.
// File: shop-record.json in the repo root  {v:1, at, n, s:{seriesKey:[vols]}, m:{'YYYY-MM':newVolumes}, seeded}
// Run with window._api defined (nightly.mjs shim or an admin tab):
//   await _srRun(rec, seedIds)  ->  updated record (rec may be null). seedIds: numeric product ids to fold in once.
// Every run also folds in the snapshot rows that are in stock now (window._NEWSNAP or _SN), so new lots and restocks
// land within one refresh. Series keys match the app snapshot: custom.series -> handleize(baseName) (+ '-ln').
window._srRun = async (rec, seedIds) => {
  const R = rec && rec.s ? rec : { v: 1, s: {}, m: {} };
  R.m = R.m || {};
  const month = new Date().toISOString().slice(0, 7);
  const handleize = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const baseName = n => n.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const snapKey = (ser, ln) => handleize(baseName(ser)) + (ln ? '-ln' : '');
  let added = 0;
  const add = (k, v, count) => {
    if (!k || !(v > 0)) return; v = Math.round(v);
    const L = R.s[k] = R.s[k] || [];
    if (L.includes(v)) return;
    L.push(v); L.sort((a, b) => a - b); added++;
    if (count) R.m[month] = (R.m[month] || 0) + 1;
  };
  const out = { seeded: 0, seedMissed: 0, fromSnap: 0, added: 0 };
  // 1) one-time seed from the ever-stocked product list
  if (seedIds && seedIds.length && !R.seeded){
    for (let i = 0; i < seedIds.length; i += 100){
      const ids = seedIds.slice(i, i + 100).map(x => 'gid://shopify/Product/' + x);
      const r = await _api(`query($ids:[ID!]!){nodes(ids:$ids){... on Product{id productType title ser:metafield(namespace:"custom",key:"series"){value} vol:metafield(namespace:"custom",key:"volume"){value} lang:metafield(namespace:"custom",key:"language"){value} ed:metafield(namespace:"custom",key:"edition"){value}}}}`, { ids });
      (r && r.data ? r.data.nodes : []).forEach(x => {
        if (!x){ out.seedMissed++; return; }
        const lang = x.lang ? String(x.lang.value).toLowerCase() : '';
        // editions (omnibus, box set...) number their own volumes, so they don't count as single volumes here
        const ser = x.ser && x.ser.value;
        if (!ser || (lang && lang !== 'english') || (x.ed && x.ed.value && x.ed.value !== 'Single')){ out.seedMissed++; return; }
        const ln = /light novel/i.test(x.productType);
        const vol = x.vol ? +x.vol.value : 1;
        const before = added; add(snapKey(ser, ln), vol, false); if (added > before) out.seeded++;
      });
    }
    R.seeded = new Date().toISOString().slice(0, 10);
  }
  // 2) everything in stock right now (new lots, restocks, buyback books)
  const S = (window._NEWSNAP && window._NEWSNAP.s) || (window._SN && window._SN.s) || {};
  Object.entries(S).forEach(([k, e]) => (e.i || []).forEach(r => { if (r[2] > 0){ const b = added; add(k, r[0], !!R.seeded); if (added > b) out.fromSnap++; } }));
  R.n = Object.values(R.s).reduce((a, L) => a + L.length, 0);
  out.added = added;
  if (added || !R.at) R.at = new Date().toISOString();
  window._SR = out;
  return R;
};
