// New-series listing creator (admin tab, after window._api). For app series the shop has never listed.
// _ncCreate(jobs, rows): jobs = [[idx, typedName, isLN, [vols]], ...]; rows from tools/newseries-finder.js
// ([idx, vol, isbn13, year, lowPrice, coverId, future, amazonTitle, author, publisher, readingAge, categories, pages]).
// Creates ACTIVE, 0-stock, outofstock+placeholder+backfill listings (Megan, Nov 4 2026: "No need to hide them or draft them.
// Just keep inventory at 0 and price check it first"), priced Amazon low x 0.8 -> .99 (min $6.99; no Amazon price: $12.99, err high),
// with every field filled (genre/age/spice/content notes inferred from Amazon categories and reading age).
// If an ISBN is already in the shop under another series name, nothing is created and window._NC2.alias gets
// [typedName, isLN, existingSeriesName] so the app can be taught the alias. Progress in window._NC2.
window._ncCreate = async (jobs, rows) => {
  const NC = window._NC2 = { i: 0, n: rows.length, ok: [], alias: [], skip: [], err: [], fin: false };
  const PUB = ['99151176','95614271806','189169672','189202440','75340054612','71894630484','183566344','75566678100','75384291412','225359823166','252121121086','255414141246'].map(x => ({ publicationId: 'gid://shopify/Publication/' + x }));
  const LOC = 'gid://shopify/Location/24217416', MONTH = (() => { const d = new Date(); return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0'); })();
  const tc = s => /[A-Z]/.test(s) ? s : s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).replace(/\b(A|An|The|And|Of|In|On|To|For|With|Is)\b/g, (m, w, o) => o ? w.toLowerCase() : w);
  const vendorOf = p => { p = String(p || '').trim(); const M = [[/tokyopop/i, 'Tokyopop'], [/viz/i, 'Viz Media'], [/yen/i, 'Yen Press'], [/kodansha/i, 'Kodansha'], [/vertical/i, 'Vertical'], [/seven seas|ghost ship/i, 'Seven Seas'], [/square enix/i, 'Square Enix'], [/j-?novel/i, 'J-Novel Club'], [/digital manga|dmp/i, 'Digital Manga Publishing'], [/juné|june\b/i, 'June'], [/dark horse/i, 'Dark Horse'], [/del rey/i, 'Del Rey'], [/cmx|dc comics/i, 'CMX'], [/netcomics/i, 'NETCOMICS'], [/aurora|deux/i, 'Aurora'], [/sublime/i, 'SuBLime'], [/lezhin/i, 'Lezhin'], [/tappytoon/i, 'Tappytoon'], [/ize press/i, 'Ize Press'], [/one peace/i, 'One Peace Books'], [/airship/i, 'Airship'], [/udon/i, 'Udon'], [/kuma/i, 'Kuma'], [/denpa/i, 'Denpa'], [/irodori/i, 'Irodori'], [/cross infinite/i, 'Cross Infinite World'], [/inklore/i, 'Inklore'], [/wordsmith/i, 'Wordsmith Press']];
    for (const [re, v] of M) if (re.test(p)) return v; return p.replace(/,?\s*(LLC|Inc\.?|Ltd\.?|Publishing|Books)$/i, '').trim() || 'Unknown'; };
  const genreOf = (cats, t, name) => { const s = (cats + ' ' + t + ' ' + name).toLowerCase();
    if (/yaoi|boys'? ?love|\bbl\b|gay|omega|alpha/.test(s)) return 'Yaoi/BL'; if (/yuri|girls'? ?love|lesbian/.test(s)) return 'Yuri';
    if (/horror/.test(s)) return 'Horror'; if (/romance|love|marriage|bride|kiss|darling|boyfriend|girlfriend|crush|husband|wife|heart/.test(s)) return 'Romance';
    if (/fantasy|isekai|demon|witch|magic|dragon|villainess|reincarnat|another world|sword|knight|prince|princess/.test(s)) return 'Fantasy';
    if (/science fiction|sci-fi|mecha|space/.test(s)) return 'Sci-Fi'; if (/comedy|humor|funny/.test(s)) return 'Comedy';
    if (/mystery|detective|thriller|crime/.test(s)) return 'Mystery'; if (/action|martial|fight|battle/.test(s)) return 'Action';
    if (/sports|basketball|soccer|baseball|volleyball/.test(s)) return 'Sports'; if (/slice of life|cooking|food/.test(s)) return 'Slice of Life'; return 'Drama'; };
  const ageOf = (age, genre, t) => { const m = String(age).match(/(\d+)/); const n = m ? +m[1] : 0;
    if (n >= 18 || /\b18\+|mature|adult|explicit/i.test(t)) return 'Mature'; if (n >= 16) return 'Older Teen'; if (n >= 12 && n < 16) return 'Teen';
    return genre === 'Yaoi/BL' ? 'Mature' : (genre === 'Romance' || genre === 'Yuri' || genre === 'Horror') ? 'Older Teen' : 'Teen'; };
  const band = p => p < 5 ? 'Under $5' : p <= 10 ? '$5-$10' : '$10+';
  const byIdx = {}; jobs.forEach(j => byIdx[j[0]] = j);
  // Series name from the Amazon title (fixes typos in what customers typed); the typed name becomes an app alias.
  const clean = t => String(t || '').replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/[,:]?\s*(vol\.?|volume|book|#)\s*\d+.*$/i, '').replace(/\s+\d+\s*[:,].*$/, '').replace(/,\s*\d+\s*$/, '').replace(/\s+\d+\s*$/, '').replace(/\s*[:\-–]\s*$/, '').trim();
  const nameOf = {}; rows.forEach(r => { if (nameOf[r[0]] == null){ const c = clean(r[7]); const typed = (byIdx[r[0]] || [, ''])[1]; const nt = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    nameOf[r[0]] = c && nt(c).length >= 3 && (nt(c).includes(nt(typed).slice(0, 6)) || nt(typed).includes(nt(c).slice(0, 6))) ? c : null; } });
  NC.newAlias = [];
  const seen = new Set();
  for (const r of rows){
    NC.i++;
    try {
      const [idx, vol, isbn, yr, low, img, fut, at, au, pub, age, cats] = r; const job = byIdx[idx]; if (!job){ NC.skip.push(isbn + ' nojob'); continue; }
      if (fut || seen.has(isbn) || !/\.jpg$|^[\w+-]+$/.test(img || '')){ NC.skip.push(job[1] + ' ' + vol + ' fut/dup/noimg'); continue; } seen.add(isbn);
      const ex = await _api(`query($q:String){productVariants(first:1,query:$q){nodes{product{title productType se:metafield(namespace:"custom",key:"series"){value}}}}}`, { q: 'barcode:' + isbn + ' OR sku:' + isbn });
      if (ex.data && ex.data.productVariants.nodes.length){ const p = ex.data.productVariants.nodes[0].product; if (p.se && p.se.value) NC.alias.push([job[1], job[2], p.se.value, p.productType === 'Light Novel' ? 1 : 0]); NC.skip.push(job[1] + ' ' + vol + ' exists'); continue; }
      const ln = !!job[2], typed = tc(job[1].replace(/\s*\(light novel\)\s*/i, '').trim()), name = nameOf[idx] || typed;
      if (name !== typed && !NC.newAlias.some(x => x[0] === job[1])) NC.newAlias.push([job[1], job[2] ? 1 : 0, name]);
      const oneShot = job[3].length === 1 && vol === 1 && !/(vol\.?|volume)\s*\d/i.test(at);
      const kind = ln ? 'Light Novel' : 'Manga';
      const title = oneShot ? name + (ln ? ' Light Novel' : '') : name + (ln ? ' Light Novel' : '') + ' Vol ' + vol;
      const genre = genreOf(cats || '', at || '', name), agr = ageOf(age, genre, at || ''), vendor = vendorOf(pub);
      const price = low > 0 ? Math.max(6.99, Math.round(low * 0.8) - 0.01) : 12.99;
      const author = String(au || '').trim();
      const romance = /Yaoi|Yuri|Romance/.test(genre);
      const spice = romance ? (agr === 'Mature' ? '4 Hot Sauce' : agr === 'Older Teen' ? '2 Ketchup' : '1 Sweet') : (agr === 'Mature' ? '3 Salsa' : null);
      const notes = agr === 'Mature' ? (romance ? ['Sexual content', 'Nudity'] : ['Graphic violence/gore', 'Sexual content']) : agr === 'Older Teen' ? (romance ? ['Sexual content'] : ['Graphic violence/gore']) : null;
      const intro = `<p class="book-intro">${title}${author ? ' by ' + author : ''}. ${/^[AEIOU]/.test(genre) ? 'An' : 'A'} ${genre} ${ln ? 'light novel' : 'manga'} rated ${agr}, published in English by ${vendor}${yr ? ' in ' + yr : ''}.</p>`;
      const seoT = title + (/light novel$/i.test(title) ? '' : ' ' + kind) + " | The Mage's Emporium";
      const seoD = title + (author ? ' by ' + author : '') + '. ' + genre + ' ' + kind.toLowerCase() + ' rated ' + agr + ". Used from The Mage's Emporium, free shipping on $35+.";
      const vols = Math.max(...job[3], vol);
      const mf = [['series', 'single_line_text_field', name], ['volume', 'number_decimal', vol + '.0'], ['genre', 'single_line_text_field', genre], ['genres', 'list.single_line_text_field', JSON.stringify(genre === 'Romance' ? ['Romance'] : romance ? ['Romance', genre] : [genre])],
        ['age_rating', 'single_line_text_field', agr], ['series_volumes', 'number_integer', String(vols)], ['series_status', 'single_line_text_field', oneShot ? 'One-shot' : 'Ongoing'], ['has_anime', 'boolean', 'false'],
        ['language', 'single_line_text_field', 'English'], ['condition', 'single_line_text_field', 'Used'], ['size', 'single_line_text_field', 'Standard'], ['format', 'single_line_text_field', kind], ['color_type', 'single_line_text_field', 'Black & White']]
        .concat(author ? [['author', 'single_line_text_field', author]] : []).concat(yr ? [['original_publication_year', 'single_line_text_field', yr]] : [])
        .concat(spice ? [['spice_level', 'single_line_text_field', spice]] : []).concat(notes ? [['content_notes', 'list.single_line_text_field', JSON.stringify(notes)]] : [])
        .map(([key, type, value]) => ({ namespace: 'custom', key, type, value }))
        .concat([{ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: seoT }, { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: seoD },
          { namespace: 'mm-google-shopping', key: 'condition', type: 'single_line_text_field', value: 'used' }, { namespace: 'mm-google-shopping', key: 'custom_label_0', type: 'string', value: kind }, { namespace: 'mm-google-shopping', key: 'custom_label_3', type: 'string', value: band(price) }]);
      const tags = ['outofstock', 'placeholder', 'backfill', MONTH].concat(agr === 'Mature' ? ['Mature'] : []).concat(oneShot ? ['One Shot'] : []);
      const input = { title, vendor, productType: kind, status: 'ACTIVE', tags, descriptionHtml: intro, seo: { title: seoT, description: seoD }, category: 'gid://shopify/TaxonomyCategory/me-1-3', metafields: mf,
        files: [{ originalSource: 'https://m.media-amazon.com/images/I/' + String(img).replace(/\.jpg$/, '') + '.jpg', contentType: 'IMAGE', alt: title }],
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], price: price.toFixed(2), barcode: isbn, sku: isbn, inventoryPolicy: 'DENY', inventoryItem: { tracked: true, measurement: { weight: { value: 6, unit: 'OUNCES' } } }, inventoryQuantities: [{ locationId: LOC, name: 'available', quantity: 0 }] }] };
      const res = await _api(`mutation($i:ProductSetInput!){productSet(input:$i,synchronous:true){product{id} userErrors{field message}}}`, { i: input });
      const pr = res.data && res.data.productSet.product; if (!pr){ NC.err.push(title + ' ' + JSON.stringify(res.data ? res.data.productSet.userErrors : res.errors).slice(0, 160)); continue; }
      await _api(`mutation($id:ID!,$i:[PublicationInput!]!){publishablePublish(id:$id,input:$i){userErrors{message}}}`, { id: pr.id, i: PUB });
      NC.ok.push([pr.id.split('/').pop(), title, price]);
    } catch (e) { NC.err.push(String(e).slice(0, 120)); }
  }
  NC.fin = true;
};
// After creating: _ncCovers() checks every created listing's cover (READY and wider than 100 px); bad ones are set to DRAFT and listed in _NC2.nocover.
window._ncCovers = async () => { const NC = window._NC2; NC.nocover = [];
  for (let i = 0; i < NC.ok.length; i += 50){ const ids = NC.ok.slice(i, i + 50).map(x => 'gid://shopify/Product/' + x[0]);
    const r = await _api(`query($i:[ID!]!){nodes(ids:$i){... on Product{id title featuredMedia{status preview{image{width}}}}}}`, { i: ids });
    for (const p of (r.data ? r.data.nodes : [])){ if (!p) continue; const m = p.featuredMedia; if (!m || (m.status === 'READY' && !(m.preview && m.preview.image && m.preview.image.width > 100)) || m.status === 'FAILED'){ NC.nocover.push(p.title); await _api(`mutation($p:ProductUpdateInput!){productUpdate(product:$p){userErrors{message}}}`, { p: { id: p.id, status: 'DRAFT' } }); } } }
  return NC.nocover.length; };
