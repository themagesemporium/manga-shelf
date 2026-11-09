// Apply researched series facts to every listing in a series (only fills EMPTY fields; never overwrites).
// Run in a Shopify admin tab with window._api defined:
//   await _rsApply(await (await fetch(RAW + 'tools/data/research/out_1a.json')).text())
// Input: {"done":[{"s":series,"t":productType,"set":{field:value}}]}. Progress in window._RA2.
window._rsApply = async (json) => {
  const D = typeof json === 'string' ? JSON.parse(json) : json;
  const R = window._RA2 = { i: 0, n: D.done.length, prods: 0, fields: 0, none: [], err: [], fin: false };
  const TYPE = { age_rating: 'single_line_text_field', genre: 'single_line_text_field', series_status: 'single_line_text_field', spice_level: 'single_line_text_field', author: 'single_line_text_field', language: 'single_line_text_field', series_volumes: 'number_integer', has_anime: 'boolean', content_notes: 'list.single_line_text_field' };
  const OK = {
    age_rating: ['All Ages', 'Teen', 'Older Teen', 'Mature'],
    genre: ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Seinen', 'Shojo', 'Shonen', 'Supernatural', 'Yaoi/BL', 'Yuri', 'Non-Fiction', 'Educational', 'Informational'],
    series_status: ['Complete', 'Ongoing', 'One-shot', 'English run ended early', 'On hiatus'],
    spice_level: ['1 Sweet', '2 Ketchup', '3 Salsa', '4 Hot Sauce', '5 Ghost Pepper'],
    content_notes: ['Graphic violence/gore', 'Strong language', 'Sexual content', 'Nudity', 'Sexual assault', 'Abuse', 'Self-harm/suicide', 'Drug use', 'Animal harm', 'Death of a loved one', 'Disturbing imagery'] };
  const keys = Object.keys(TYPE);
  const MFQ = keys.map(k => `${k.replace(/_/g, '')}:metafield(namespace:"custom",key:"${k}"){value}`).join(' ');
  const val = (k, v) => {
    if (v == null) return null;
    if (k === 'content_notes'){ if (!Array.isArray(v)) return null; const a = v.filter(x => OK.content_notes.includes(x)); return JSON.stringify(a); }
    if (k === 'has_anime') return typeof v === 'boolean' ? String(v) : null;
    if (k === 'series_volumes'){ const n = parseInt(v, 10); return n > 0 ? String(n) : null; }
    if (OK[k] && !OK[k].includes(v)) return null;
    return String(v).trim() || null; };
  for (const it of D.done){
    R.i++;
    try {
      const sets = Object.entries(it.set || {}).map(([k, v]) => [k, val(k, v)]).filter(([k, v]) => TYPE[k] && v != null);
      if (!sets.length) continue;
      let a = null, prods = [];
      do { const r = await _api(`query($q:String,$a:String){products(first:100,after:$a,query:$q){pageInfo{hasNextPage endCursor} nodes{id productType tags ser:metafield(namespace:"custom",key:"series"){value} ${MFQ}}}}`, { q: `metafields.custom.series:"${String(it.s).replace(/"/g, '')}"`, a });
        if (!r.data){ R.err.push(it.s + ': ' + JSON.stringify(r.errors).slice(0, 100)); break; }
        prods = prods.concat(r.data.products.nodes); a = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null; } while (a);
      prods = prods.filter(p => p.ser && p.ser.value === it.s && (!it.t || it.t === 'None' || p.productType === it.t) && !p.tags.some(t => /^(Bundle|Shopify Collective)$/i.test(t)));
      if (!prods.length){ R.none.push(it.s); continue; }
      const mf = [];
      for (const p of prods) for (const [k, v] of sets){ const cur = p[k.replace(/_/g, '')]; if (cur && cur.value != null && cur.value !== '' && cur.value !== '[]' && !(k === 'genre' && cur.value === 'None')) continue; if (k === 'content_notes' && v === '[]' && cur && cur.value === '[]') continue; mf.push({ ownerId: p.id, namespace: 'custom', key: k, type: TYPE[k], value: v }); }
      for (let i = 0; i < mf.length; i += 25){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message field}}}`, { m: mf.slice(i, i + 25) }); const ue = r.data ? r.data.metafieldsSet.userErrors : r.errors; if (ue && ue.length) R.err.push(it.s + ': ' + JSON.stringify(ue).slice(0, 150)); else R.fields += Math.min(25, mf.length - i); }
      R.prods += prods.length;
    } catch (e){ R.err.push(it.s + ': ' + String(e).slice(0, 100)); }
  }
  R.fin = true; return R;
};
