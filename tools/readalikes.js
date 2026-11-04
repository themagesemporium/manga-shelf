// Read-alikes: recompute custom.read_alikes (up to 6 series pages) for every series page.
// Skips the same franchise (shared main title word) and the same author. Scores by shared genres/themes, same audience, same format, close age rating and spice; skips the same franchise.
// Needs _api. Run _raRun(); progress in window._RA.
window._raRun = async () => {
  window._RA = { st: 'pull', n: 0, w: 0, e: [], fin: false };
  const N = t => String(t || '').toLowerCase().replace(/\(light novel\)/g, '').replace(/&/g, 'and').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  // 1. one product's facts per series (first product with genres wins), plus stock
  const S = {}; let a = null;
  do {
    const r = await _api(`query($a:String){products(first:250,after:$a,query:"(product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel') AND -tag:'Shopify Collective'"){pageInfo{hasNextPage endCursor} nodes{productType totalInventory se:metafield(namespace:"custom",key:"series"){value} g:metafield(namespace:"custom",key:"genres"){value} th:metafield(namespace:"custom",key:"themes"){value} au:metafield(namespace:"custom",key:"audience"){value} ag:metafield(namespace:"custom",key:"age_rating"){value} sp:metafield(namespace:"custom",key:"spice_level"){value} fm:metafield(namespace:"custom",key:"format"){value} at:metafield(namespace:"custom",key:"author"){value}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    r.data.products.nodes.forEach(n => {
      if (!n.se || !n.se.value) return; const k = N(n.se.value) + '|' + n.productType;
      const e = S[k] = S[k] || { g: [], th: [], au: '', ag: '', sp: 0, fm: n.productType, inv: 0, at: '' };
      const J = x => { try { return JSON.parse(x && x.value || '[]'); } catch (z) { return []; } };
      if (!e.g.length) e.g = J(n.g); if (!e.th.length) e.th = J(n.th);
      e.au = e.au || (n.au && n.au.value) || ''; e.ag = e.ag || (n.ag && n.ag.value) || '';
      e.sp = e.sp || parseInt(n.sp && n.sp.value) || 0; e.at = e.at || (n.at && n.at.value) || ''; e.inv += n.totalInventory > 0 ? n.totalInventory : 0;
    });
    a = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (a);
  // 2. series pages
  _RA.st = 'pages'; const C = []; a = null;
  do {
    const r = await _api(`query($a:String){collections(first:250,after:$a,query:"handle:series-*"){pageInfo{hasNextPage endCursor} nodes{id handle title productsCount ruleSet{rules{column relation condition}}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    C.push(...r.data.collections.nodes); a = r.data.collections.pageInfo.hasNextPage ? r.data.collections.pageInfo.endCursor : null;
  } while (a);
  const P = C.filter(c => !c.title.startsWith('ZZ') && !c.handle.endsWith('-new') && c.productsCount > 0).map(c => {
    const rs = (c.ruleSet && c.ruleSet.rules) || []; const sw = rs.find(r => r.column === 'TITLE' && r.relation === 'STARTS_WITH'); const ty = rs.find(r => r.column === 'TYPE');
    const f = S[N(sw ? sw.condition : c.title) + '|' + (ty ? ty.condition : 'Manga')] || S[N(c.title) + '|' + (ty ? ty.condition : 'Manga')];
    return f ? { id: c.id, t: c.title, w: (N(c.title).split(' ').filter(x => x.length >= 4 && !['with','from','your','that','this'].includes(x))[0] || N(c.title)), nt: N(c.title), n: c.productsCount, ...f } : null;
  }).filter(Boolean);
  _RA.n = P.length;
  // 3. score + write
  _RA.st = 'write'; const AGE = { 'All Ages': 0, 'Teen': 1, 'Older Teen': 2, 'Mature': 3 }; const M = [];
  for (const p of P){
    if (!p.g.length) continue; const mature = p.ag === 'Mature' || p.sp >= 4;
    const sc = P.filter(q => q.id !== p.id && !q.nt.includes(p.w) && !p.nt.includes(q.w) && !(p.at && q.at === p.at) && q.g.length && (mature || (q.ag !== 'Mature' && q.sp < 4))).map(q => {
      const sg = q.g.filter(x => p.g.includes(x)).length; if (!sg) return null;
      let s = sg * 2 / Math.max(p.g.length, q.g.length) * 3 + q.th.filter(x => p.th.includes(x)).length * 1.5;
      if (p.au && q.au === p.au) s += 1.2; if (q.fm === p.fm) s += 0.8;
      if (p.ag && q.ag) s -= Math.abs((AGE[p.ag] || 1) - (AGE[q.ag] || 1)) * 0.6;
      if (p.sp && q.sp) s -= Math.abs(p.sp - q.sp) * 0.4;
      s += Math.min(q.n, 20) / 40 + (q.inv > 0 ? 0.6 : 0); return [s, q.id];
    }).filter(Boolean).sort((x, y) => y[0] - x[0]).slice(0, 6).map(x => x[1]);
    if (sc.length) M.push({ ownerId: p.id, namespace: 'custom', key: 'read_alikes', type: 'list.collection_reference', value: JSON.stringify(sc) });
  }
  for (let j = 0; j < M.length; j += 25){
    const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(j, j + 25) });
    if (r.data && !r.data.metafieldsSet.userErrors.length) _RA.w += Math.min(25, M.length - j); else _RA.e.push(JSON.stringify(r.data ? r.data.metafieldsSet.userErrors[0] : r.errors).slice(0, 100));
  }
  _RA.st = 'done'; _RA.fin = true;
};
