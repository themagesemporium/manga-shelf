// Listing completeness audit. Run in a Shopify admin tab with window._api defined.
// _laRun({q:'tag:Haul-2611-04'})  or  _laRun({q:'created_at:>=2026-11-04'})  ; add fix:true to copy missing series-level
// fields from sibling volumes (same custom.series + product type) and remove prices from SEO text.
// Progress/result in window._LA: rows [title, id, [problems]] for anything still incomplete after fixing; fixed = fields filled.
// Skips sets (tag Bundle), Shopify Collective and partner products.
window._laRun = async (opt = {}) => {
  const LA = window._LA = { st: 'load', n: 0, fixed: 0, rows: [], fin: false, err: [] };
  const SER = ['author', 'genre', 'genres', 'themes', 'audience', 'age_rating', 'series_volumes', 'series_status', 'has_anime', 'anime_title', 'spice_level', 'content_notes', 'language', 'original_status', 'original_volumes', 'color_type'];
  const MFQ = ['series', 'volume', 'original_publication_year', 'condition', ...SER].map(k => `${k.replace(/_/g, '')}:metafield(namespace:"custom",key:"${k}"){value type}`).join(' ');
  const g = (p, k) => { const m = p[k.replace(/_/g, '')]; return m && m.value != null && m.value !== '' && m.value !== '[]' ? m.value : null; };
  const handleize = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let list = [], a = null;
  do {
    const r = await _api(`query($a:String,$q:String){products(first:100,after:$a,query:$q){pageInfo{hasNextPage endCursor} nodes{id title vendor productType status tags seo{title description} featuredMedia{status preview{image{width}}} variants(first:1){nodes{price barcode}} ${MFQ}}}}`, { a, q: opt.q });
    if (!r.data){ LA.err.push(JSON.stringify(r.errors).slice(0, 150)); break; }
    list = list.concat(r.data.products.nodes); a = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null;
  } while (a);
  list = list.filter(p => !p.tags.some(t => /^(Bundle|Shopify Collective)$/i.test(t)) && !/Set$/.test(p.title)); LA.n = list.length;
  LA.st = 'check'; const sibCache = {}, pageCache = {};
  for (const p of list){
    const prob = [], fill = [], ser = g(p, 'series'), ln = p.productType === 'Light Novel';
    if (!p.productType) prob.push('product type');
    if (!p.vendor || /mage/i.test(p.vendor)) prob.push('vendor (publisher)');
    const v = p.variants.nodes[0] || {};
    if (!v.barcode) prob.push('ISBN/barcode');
    if (!(+v.price >= 6.99) && !/Ex Library/i.test(p.title)) prob.push('price ' + v.price + ' under 6.99');
    if (!p.featuredMedia || p.featuredMedia.status !== 'READY' || !(p.featuredMedia.preview && p.featuredMedia.preview.image && p.featuredMedia.preview.image.width > 100)) prob.push('cover image');
    if (/\$\d/.test(((p.seo.title || '') + ' ' + (p.seo.description || '')).replace(/\$35\+/g, ''))) {
      if (opt.fix){ const k = p.productType || 'Manga'; await _api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, seo: { title: p.title + (new RegExp(k + '$', 'i').test(p.title) ? '' : ' ' + k) + " | The Mage's Emporium", description: p.title + (g(p, 'author') ? ' by ' + g(p, 'author') : '') + '. ' + (g(p, 'genre') ? g(p, 'genre') + ' ' + k.toLowerCase() : k) + (g(p, 'age_rating') ? ' rated ' + g(p, 'age_rating') : '') + ". " + (/brand new|sealed/i.test(p.title) ? 'New' : 'Used') + " from The Mage's Emporium, free shipping on $35+." } } }); LA.fixed++; }
      else prob.push('price in SEO text');
    }
    if (!ser) prob.push('series'); if (!g(p, 'volume')) prob.push('volume');
    // siblings: same series + type
    let sib = [];
    if (ser){
      const ck = ser + '|' + ln;
      if (!sibCache[ck]){ const r = await _api(`query($q:String){products(first:100,query:$q){nodes{id productType ${MFQ}}}}`, { q: `metafields.custom.series:"${ser.replace(/"/g, '')}"` }); sibCache[ck] = r.data ? r.data.products.nodes.filter(x => g(x, 'series') === ser && (x.productType === 'Light Novel') === ln) : []; }
      sib = sibCache[ck].filter(x => x.id !== p.id);
      const maxVol = Math.max(0, ...sibCache[ck].map(x => +g(x, 'volume') || 0));
      if (+g(p, 'series_volumes') && maxVol > +g(p, 'series_volumes')) prob.push(`series_volumes ${g(p, 'series_volumes')} < highest listed vol ${maxVol}`);
      // series page when the series has 2+ volumes
      if ((+g(p, 'series_volumes') || sibCache[ck].length) > 1){
        const h = 'series-' + handleize(ser) + (ln ? '-light-novel' : '');
        if (!(h in pageCache)){ const r = await _api(`query($h:String!){collectionByHandle(handle:$h){id}}`, { h }); pageCache[h] = !!(r.data && r.data.collectionByHandle); }
        if (!pageCache[h]) prob.push('series page ' + h);
      }
    }
    for (const k of SER){
      if (g(p, k)) continue;
      const s = sib.find(x => g(x, k));
      if (s && opt.fix){ fill.push({ ownerId: p.id, namespace: 'custom', key: k, type: s[k.replace(/_/g, '')].type, value: s[k.replace(/_/g, '')].value }); continue; }
      const age = g(p, 'age_rating') || (sib.find(x => g(x, 'age_rating')) || {}).agerating?.value || '';
      const gen = (g(p, 'genre') || '') + ' ' + (g(p, 'genres') || '');
      const need = { author: 1, genre: 1, age_rating: 1, series_volumes: 1, series_status: 1, has_anime: 1, language: 1,
        spice_level: /romance|yaoi|bl\b|boys|yuri|girls' love|josei|smut/i.test(gen),
        content_notes: /older teen|mature|adult/i.test(age) }[k];
      if (need) prob.push(k + (s ? '' : ' (no sibling has it)'));
    }
    if (!g(p, 'original_publication_year')) prob.push('original_publication_year');
    if (!g(p, 'condition')) prob.push('condition');
    if (fill.length){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: fill }); if (r.data && !r.data.metafieldsSet.userErrors.length) LA.fixed += fill.length; else LA.err.push('fill ' + p.title); }
    if (prob.length) LA.rows.push([p.title, p.id.split('/').pop(), prob]);
  }
  LA.st = 'done'; LA.fin = true;
};
