// Series-wide fixes. Needs window._api.
// _ageRun(): a series uses its highest volume's age rating (Megan's rule: never lower a rating). Same custom.series + product type. Skips Shopify Collective.
// _lnRun(): light novel titles end in "Light Novel" (store convention), e.g. "Spice and Wolf Vol 17 Light Novel".
window._ageRun = async () => {
  const R = ['All Ages', 'Teen', 'Older Teen', 'Mature'], P = []; let a = null;
  do { const r = await _api(`query($a:String){products(first:250,after:$a,query:"(product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel') AND -tag:'Shopify Collective'"){pageInfo{hasNextPage endCursor} nodes{id productType s:metafield(namespace:"custom",key:"series"){value} ar:metafield(namespace:"custom",key:"age_rating"){value}}}}`, { a });
    const p = r.data.products; P.push(...p.nodes); a = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null; } while (a);
  const G = {}; P.forEach(p => { const s = p.s && p.s.value; if (!s) return; (G[s + '|' + p.productType] = G[s + '|' + p.productType] || []).push(p); });
  const fix = [], series = [];
  for (const [k, list] of Object.entries(G)){ const rs = list.map(p => R.indexOf(p.ar && p.ar.value)).filter(i => i >= 0); if (!rs.length) continue; const top = Math.max(...rs);
    const low = list.filter(p => R.indexOf(p.ar && p.ar.value) !== top); if (!low.length) continue;
    low.forEach(p => fix.push({ ownerId: p.id, namespace: 'custom', key: 'age_rating', type: 'single_line_text_field', value: R[top] })); series.push([k.split('|')[0], R[top], low.length]); }
  let fixed = 0;
  for (let i = 0; i < fix.length; i += 25){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: fix.slice(i, i + 25) }); if (r.data && !r.data.metafieldsSet.userErrors.length) fixed += Math.min(25, fix.length - i); }
  return { listings: P.length, fixed, series };
};
window._lnRun = async () => {
  const P = []; let a = null;
  do { const r = await _api(`query($a:String){products(first:250,after:$a,query:"product_type:'Light Novel' AND -tag:'Shopify Collective'"){pageInfo{hasNextPage endCursor} nodes{id title tags}}}`, { a });
    const p = r.data.products; P.push(...p.nodes); a = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null; } while (a);
  const done = [];
  for (const p of P.filter(p => !/novel|\bLN\b/i.test(p.title) && !p.tags.some(t => /^bundle$/i.test(t)) && !/\bset\b/i.test(p.title))){
    const t = p.title.replace(/\s+-\s+(BRAND NEW CONDITION|Pre-Order|Ex Library)$/i, ''), nt = t.replace(/\s+$/, '') + ' Light Novel' + p.title.slice(t.length);
    const r = await _api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, title: nt } }); if (r.data && !r.data.productUpdate.userErrors.length) done.push([p.title, nt]); }
  return done;
};
