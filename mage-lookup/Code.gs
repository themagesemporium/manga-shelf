/** @OnlyCurrentDoc */
/**
 * Mage Lookup — ISBN look-up + Shopify draft maker for The Mage's Emporium.
 * Built by Claude for Megan, Nov 2026.
 *
 * Settings live in Extensions > Apps Script > Project Settings > Script properties:
 *   SHOP           the-mages-emporium            (store subdomain, no .myshopify.com)
 *   CLIENT_ID      from the Dev Dashboard app "Mage Lookup" > Settings
 *   CLIENT_SECRET  from the same page (never paste it anywhere else)
 *   GBOOKS_KEY     optional Google Books API key (works without one, with lower limits)
 *
 * Sheet "Lookup": put ISBNs in column A (row 2 down), then Mage Lookup menu > Look up new ISBNs.
 * Status flow: (blank) -> In store | Looked up | Not found  -> you/Claude set Ready -> Draft created
 */

const API_VERSION = '2026-10';
const SHEET = 'Lookup';
const HEAD = ['ISBN','Status','Title','Series','Vol','Format','Author','Publisher','Year','Pages','Cover URL',
  'Genre','Genres','Age','Audience','Size','Condition','Price','Series status','Series vols','Synopsis',
  'In store','Source','Product / notes'];
const C = {}; HEAD.forEach((h, i) => C[h] = i);           // column index (0-based) by name

/* ---------- menu ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Mage Lookup')
    .addItem('Look up new ISBNs', 'lookupNew')
    .addItem('Re-check selected rows', 'lookupSelected')
    .addSeparator()
    .addItem('Create drafts for Ready rows', 'createDrafts')
    .addSeparator()
    .addItem('Turn ON auto look-up (every 10 min)', 'autoOn')
    .addItem('Turn OFF auto look-up', 'autoOff')
    .addSeparator()
    .addItem('Set up sheet', 'setupSheet')
    .addItem('Test Shopify connection', 'testConnection')
    .addToUi();
}

function setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#fff3c9');
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  sh.getRange('A:A').setNumberFormat('@');                 // keep ISBNs as text (no 9.78E+12)
  const dv = (vals) => SpreadsheetApp.newDataValidation().requireValueInList(vals, true).setAllowInvalid(true).build();
  sh.getRange(2, C['Status'] + 1, 1000).setDataValidation(dv(['Looked up','In store','Not found','Ready','Draft created','Skip','Error']));
  sh.getRange(2, C['Format'] + 1, 1000).setDataValidation(dv(['Manga','Light Novel','Manhwa','Manhua','Graphic Novel']));
  sh.getRange(2, C['Age'] + 1, 1000).setDataValidation(dv(['All Ages','Teen','Older Teen','Mature']));
  sh.getRange(2, C['Audience'] + 1, 1000).setDataValidation(dv(['Kids','Shonen','Shojo','Seinen','Josei','General']));
  sh.getRange(2, C['Size'] + 1, 1000).setDataValidation(dv(['Standard','Oversized','Box Set','Small']));
  sh.getRange(2, C['Condition'] + 1, 1000).setDataValidation(dv(['Used','Brand New','Brand New Sealed']));
  sh.getRange(2, C['Series status'] + 1, 1000).setDataValidation(dv(['Complete','Ongoing','One-shot','English run ended early']));
  sh.getRange(2, C['Genre'] + 1, 1000).setDataValidation(dv(['Action','Adventure','Comedy','Drama','Ecchi','Fantasy','Horror','Mystery','Romance','Sci-Fi','Supernatural','Yaoi/BL','Yuri','Non-Fiction']));
  sh.setColumnWidth(C['Title'] + 1, 260); sh.setColumnWidth(C['Synopsis'] + 1, 300);
  SpreadsheetApp.getUi().alert('Sheet ready. Paste or scan ISBNs into column A, then use Mage Lookup > Look up new ISBNs.');
}

/* ---------- auto look-up timer ---------- */
function autoOn() {
  autoOff_(); ScriptApp.newTrigger('autoLookup').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('Auto look-up is ON ✅ New ISBNs in column A get looked up about every 10 minutes, even with the sheet closed.');
}
function autoOff() { const n = autoOff_(); SpreadsheetApp.getUi().alert(n ? 'Auto look-up is OFF.' : 'Auto look-up was already off.'); }
function autoOff_() { let n = 0; ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'autoLookup') { ScriptApp.deleteTrigger(t); n++; } }); return n; }
function autoLookup() {                                       // runs on the timer: only works if there is something new
  drainQueue_();                                              // move phone scans into the sheet first
  const cache = CacheService.getScriptCache(); if (cache.get('busy')) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET); if (!sh) return;
  const vals = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues();
  if (!vals.some(r => String(r[0]).trim() && !String(r[1]).trim())) return;
  cache.put('busy', '1', 330);
  try { lookupNew(); } finally { cache.remove('busy'); }
}

/* ---------- Mage Scanner (phone web app, deployed "only myself") ---------- */
function doGet(e) {
  const tools = e && e.parameter && e.parameter.page === 'tools';
  return HtmlService.createHtmlOutputFromFile(tools ? 'ToolsPage' : 'Scanner')
    .setTitle(tools ? 'Mage Tools' : 'Mage Scanner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function addIsbn(raw) {
  const isbn = cleanIsbn_(raw);
  if (!isbn) return { ok: false, msg: 'That isn’t a book ISBN (it should be 13 digits starting 978 or 979).' };
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const p = props_(); const q = JSON.parse(p.getProperty('QUEUE') || '[]');
    const note = q.indexOf(isbn) >= 0 ? 'already scanned once, added again' : '';
    q.push(isbn); p.setProperty('QUEUE', JSON.stringify(q));
    return { ok: true, isbn, queued: q.length, note };
  } finally { lock.releaseLock(); }
}
function drainQueue_() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return 0;
  try {
    const p = props_(); const q = JSON.parse(p.getProperty('QUEUE') || '[]'); if (!q.length) return 0;
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET); if (!sh) return 0;
    const colA = sh.getRange('A:A').getValues(); let last = 1;
    for (let i = colA.length - 1; i >= 1; i--) if (String(colA[i][0]).trim()) { last = i + 1; break; }
    sh.getRange(last + 1, 1, q.length, 1).setValues(q.map(x => [x]));
    p.deleteProperty('QUEUE'); return q.length;
  } finally { lock.releaseLock(); }
}

/* ---------- Shopify ---------- */
function props_() { return PropertiesService.getScriptProperties(); }
function shopifyToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('shopify_token'); if (hit) return hit;
  const p = props_(); const shop = p.getProperty('SHOP') || 'the-mages-emporium';
  const id = p.getProperty('CLIENT_ID'), secret = p.getProperty('CLIENT_SECRET');
  if (!id || !secret) throw new Error('Add CLIENT_ID and CLIENT_SECRET in Project Settings > Script properties.');
  const r = UrlFetchApp.fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'post', payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Shopify login failed (' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 200));
  const j = JSON.parse(r.getContentText());
  cache.put('shopify_token', j.access_token, 6 * 3600);     // tokens last 24h; refresh every 6h
  return j.access_token;
}
function gql_(query, variables) {
  const shop = props_().getProperty('SHOP') || 'the-mages-emporium';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = UrlFetchApp.fetch(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Shopify-Access-Token': shopifyToken_() }, payload: JSON.stringify({ query, variables: variables || {} }) });
    const code = r.getResponseCode();
    if (code === 401) { CacheService.getScriptCache().remove('shopify_token'); continue; }
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (attempt + 1)); continue; }
    const j = JSON.parse(r.getContentText());
    if (j.errors) {
      if (JSON.stringify(j.errors).indexOf('THROTTLED') >= 0) { Utilities.sleep(2000); continue; }
      throw new Error(JSON.stringify(j.errors).slice(0, 300));
    }
    return j.data;
  }
  throw new Error('Shopify did not answer after 3 tries.');
}
function testConnection() {
  const d = gql_('{shop{name} productsCount{count}}');
  SpreadsheetApp.getUi().alert('Connected to ' + d.shop.name + ' (' + d.productsCount.count + ' products). ✅');
}

/* ---------- look-ups ---------- */
function lookupNew() { drainQueue_(); runLookup_(row => !String(row[C['Status']]).trim() && String(row[C['ISBN']]).trim()); }
function lookupSelected() {
  const sel = SpreadsheetApp.getActiveRange(); const a = sel.getRow(), b = a + sel.getNumRows() - 1;
  runLookup_((row, r) => r >= a && r <= b && String(row[C['ISBN']]).trim());
}
function runLookup_(want) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  const data = sh.getDataRange().getValues();
  const started = Date.now(); let done = 0, left = 0;
  // 1) batch-check the store for every wanted ISBN (25 per query)
  const rows = [];
  for (let i = 1; i < data.length; i++) if (want(data[i], i + 1)) rows.push(i);
  const isbns = rows.map(i => cleanIsbn_(data[i][C['ISBN']]));
  const inStore = storeByIsbn_(isbns.filter(Boolean));
  for (const i of rows) {
    if (Date.now() - started > 300000) { left++; continue; }   // stay under the 6-minute limit
    const row = data[i]; const isbn = cleanIsbn_(row[C['ISBN']]);
    const out = row.slice(); while (out.length < HEAD.length) out.push('');
    out[C['ISBN']] = isbn || row[C['ISBN']];
    if (!isbn) { out[C['Status']] = 'Error'; out[C['Product / notes']] = 'Not a valid ISBN'; writeRow_(sh, i + 1, out); continue; }
    try {
      const hits = inStore[isbn] || [];
      if (hits.length) {
        out[C['In store']] = hits.map(h => `${h.title} (${h.status === 'ACTIVE' ? 'active' : h.status.toLowerCase()}, stock ${h.totalInventory})`).join(' | ');
        out[C['Product / notes']] = hits.map(h => h.id.split('/').pop()).join(', ');
      }
      const info = lookupBook_(isbn);
      if (info) fill_(out, info, isbn);
      out[C['Status']] = hits.length ? 'In store' : (info ? 'Looked up' : 'Not found');
      if (!info && !hits.length) out[C['Product / notes']] = 'Not in Google Books or Open Library — fill in by hand';
    } catch (e) { out[C['Status']] = 'Error'; out[C['Product / notes']] = String(e.message || e).slice(0, 200); }
    writeRow_(sh, i + 1, out); done++;
  }
  SpreadsheetApp.getActive().toast(`Looked up ${done} ISBN${done === 1 ? '' : 's'}` + (left ? ` — ${left} left, run it again` : ''), 'Mage Lookup', 8);
}
function writeRow_(sh, r, vals) { sh.getRange(r, 1, 1, HEAD.length).setValues([vals.slice(0, HEAD.length)]); }

function cleanIsbn_(v) {
  let s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 10) s = isbn10to13_(s);
  return /^97[89]\d{10}$/.test(s) ? s : '';
}
function isbn10to13_(s10) {
  const core = '978' + s10.slice(0, 9); let sum = 0;
  for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - sum % 10) % 10);
}
function isbn13to10_(s13) {
  if (!s13.startsWith('978')) return '';
  const core = s13.slice(3, 12); let sum = 0;
  for (let i = 0; i < 9; i++) sum += (+core[i]) * (10 - i);
  const c = (11 - sum % 11) % 11; return core + (c === 10 ? 'X' : String(c));
}

function storeByIsbn_(isbns) {
  const out = {};
  for (let k = 0; k < isbns.length; k += 25) {
    const chunk = isbns.slice(k, k + 25);
    const q = chunk.map(x => `barcode:${x} OR sku:${x}`).join(' OR ');
    const d = gql_(`query($q:String!){products(first:100, query:$q){nodes{id title status totalInventory variants(first:1){nodes{sku barcodes(first:3){nodes{value}}}}}}}`, { q });
    d.products.nodes.forEach(p => {
      const v = p.variants.nodes[0] || {}; const codes = [v.sku].concat((v.barcodes ? v.barcodes.nodes : []).map(b => b.value));
      codes.forEach(c => { c = String(c || ''); if (chunk.indexOf(c) >= 0) { (out[c] = out[c] || []); if (!out[c].some(x => x.id === p.id)) out[c].push(p); } });
    });
  }
  return out;
}

let LAST_STATUS = {};
function fetchJson_(url, tag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try { r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'MageLookup/1.0 (themagesemporium.com)' } }); }
    catch (e) { LAST_STATUS[tag] = 'unreachable'; Utilities.sleep(1200 * (attempt + 1)); continue; }   // site briefly down: wait and retry
    const code = r.getResponseCode(); LAST_STATUS[tag] = code;
    if (code === 429 && tag === 'gb') return null;                 // Google Books daily limit hit: skip it, Open Library fills in
    if (code === 429 || code >= 500) { Utilities.sleep(1500 * (attempt + 1)); continue; }
    if (code !== 200) return null;
    try { return JSON.parse(r.getContentText()); } catch (e) { return null; }
  }
  return null;
}
function lookupBook_(isbn) {
  const key = props_().getProperty('GBOOKS_KEY');
  let info = null;
  const g = fetchJson_(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=US` + (key ? `&key=${key}` : ''), 'gb');
  if (g && g.items && g.items.length) {
    const v = g.items[0].volumeInfo || {};
    info = { src: 'Google Books', title: [v.title, v.subtitle].filter(Boolean).join(': '), authors: v.authors || [], publisher: v.publisher || '',
      date: v.publishedDate || '', pages: v.pageCount || '', desc: v.description || '', cats: v.categories || [], maturity: v.maturityRating || '',
      img: v.imageLinks ? (v.imageLinks.thumbnail || '').replace('http://', 'https://').replace('&edge=curl', '').replace('zoom=1', 'zoom=0') : '' };
  }
  const o = fetchJson_(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`, 'ol');
  const ob = o && o['ISBN:' + isbn];
  if (ob) {
    const oi = { src: 'Open Library', title: [ob.title, ob.subtitle].filter(Boolean).join(': '), authors: (ob.authors || []).map(a => a.name),
      publisher: (ob.publishers || [])[0] ? ob.publishers[0].name : '', date: ob.publish_date || '', pages: ob.number_of_pages || '', desc: '',
      cats: (ob.subjects || []).slice(0, 8).map(s => s.name), img: ob.cover ? (ob.cover.large || ob.cover.medium || '') : '' };
    if (!info) info = oi;
    else {                                                   // fill gaps from Open Library
      ['publisher', 'pages', 'date'].forEach(f => { if (!info[f] && oi[f]) info[f] = oi[f]; });
      if (!info.authors.length) info.authors = oi.authors;
      if (!info.img && oi.img) info.img = oi.img;
      info.src = 'Google Books + Open Library';
    }
  }
  return info;
}

const PUBLISHERS = [ // tidy imprint names to the vendor names the store uses
  [/viz|shonen\s*(sunday|jump)|shojo\s*beat|haikasoru/i, 'Viz Media'], [/yen\s*(press|on)/i, 'Yen Press'], [/kodansha/i, 'Kodansha'], [/seven\s*seas|ghost\s*ship/i, 'Seven Seas'],
  [/square\s*enix/i, 'Square Enix Manga'], [/dark\s*horse/i, 'Dark Horse'], [/tokyopop/i, 'Tokyopop'], [/vertical/i, 'Vertical'],
  [/j-?novel/i, 'J-Novel Club'], [/one\s*peace/i, 'One Peace Books'], [/airship/i, 'Seven Seas'], [/udon/i, 'UDON Entertainment'],
  [/titan/i, 'Titan Comics'], [/denpa/i, 'Denpa'], [/del\s*rey/i, 'Del Rey'], [/cross\s*infinite/i, 'Cross Infinite World'],
  [/sol\s*press/i, 'SOL Press'], [/ize\s*press/i, 'Ize Press'], [/tapas/i, 'Tapas'], [/inklore/i, 'Inklore']];

function fill_(out, info, isbn) {
  const set = (col, val) => { if (!String(out[C[col]]).trim() && val !== undefined && val !== null && val !== '') out[C[col]] = val; };
  let raw = String(info.title || '').trim();
  const isLN = /light\s*novel/i.test(raw + ' ' + (info.cats || []).join(' ')) || /\b(yen on|j-novel)\b/i.test(info.publisher || '');
  const isManhwa = /manhwa|webtoon/i.test(raw + ' ' + (info.cats || []).join(' '));
  // series + volume, e.g. "Ouran High School Host Club, Vol. 2" / "Spy x Family, Vol. 1" / "Frieren: Beyond Journey's End, Vol. 3"
  let series = raw, vol = '';
  const m = raw.match(/^(.*?)[\s,:(]*(?:vol(?:ume)?\.?|#|book)\s*(\d+(?:\.\d+)?)/i) || raw.match(/^(.*?)[\s,:]+(\d{1,3})$/);
  if (m) { series = m[1]; vol = m[2]; }
  series = series.replace(/\((light novel|manga)\)/ig, '').replace(/[\s,:;-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  const fmt = isLN ? 'Light Novel' : (isManhwa ? 'Manhwa' : 'Manga');
  const vendor = (PUBLISHERS.find(p => p[0].test(info.publisher || '')) || [null, info.publisher || ''])[1];
  const yr = (String(info.date).match(/\d{4}/) || [''])[0];
  set('Series', series); set('Vol', vol ? Number(vol) : '');
  set('Title', series + (fmt === 'Light Novel' ? ' Light Novel' : '') + (vol ? ' Vol ' + Number(vol) : ''));
  set('Format', fmt); set('Author', (info.authors || []).join(', ')); set('Publisher', vendor); set('Year', yr); set('Pages', info.pages);
  set('Cover URL', info.img || defaultCover_(isbn)); set('Synopsis', String(info.desc || '').replace(/<[^>]+>/g, '').slice(0, 1500));
  set('Condition', 'Used'); set('Size', 'Standard'); set('Price', 6.99);
  if (info.maturity === 'MATURE') set('Age', 'Mature');
  out[C['Source']] = info.src + (LAST_STATUS.gb && LAST_STATUS.gb !== 200 ? ' (Google Books ' + LAST_STATUS.gb + ')' : '');
}
function defaultCover_(isbn) {
  const i10 = isbn13to10_(isbn);
  return i10 ? `https://m.media-amazon.com/images/P/${i10}.01._SCLZZZZZZZ_.jpg` : `https://images.penguinrandomhouse.com/cover/${isbn}`;
}

/* ---------- drafts ---------- */
const GENRE_MO = { Comedy: '71462060350', Drama: '71460356414', Romance: '71460421950', Fantasy: '71460094270', Action: '71460389182' };
const AGE_MO = { 'All Ages': '71505969470', 'Teen': '71459209534', 'Older Teen': '71459209534', 'Mature': '71506002238' };
const GENS = ['Action','Adventure','Comedy','Drama','Fantasy','Historical','Horror','Mystery','Psychological','Romance','Sci-Fi','Slice of Life','Sports','Supernatural','Thriller','Ecchi','Yaoi/BL','Yuri','Non-Fiction'];

function createDrafts() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  const data = sh.getDataRange().getValues(); const started = Date.now(); let made = 0, left = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i]; if (String(row[C['Status']]).trim() !== 'Ready') continue;
    if (Date.now() - started > 300000) { left++; continue; }
    try {
      const input = buildProduct_(row);
      const d = gql_('mutation($input:ProductSetInput!){productSet(synchronous:true, input:$input){product{id handle} userErrors{field message}}}', { input });
      const res = d.productSet;
      if (res.userErrors && res.userErrors.length) throw new Error(res.userErrors.map(e => e.message).join('; '));
      sh.getRange(i + 1, C['Status'] + 1).setValue('Draft created');
      sh.getRange(i + 1, C['Product / notes'] + 1).setValue(res.product.id.split('/').pop() + ' · ' + res.product.handle);
      made++;
    } catch (e) {
      sh.getRange(i + 1, C['Status'] + 1).setValue('Error');
      sh.getRange(i + 1, C['Product / notes'] + 1).setValue(String(e.message || e).slice(0, 250));
    }
  }
  SpreadsheetApp.getActive().toast(`Created ${made} draft${made === 1 ? '' : 's'}` + (left ? ` — ${left} left, run it again` : ''), 'Mage Lookup', 8);
}

function buildProduct_(row) {
  const g = s => String(row[C[s]] === undefined ? '' : row[C[s]]).trim();
  const isbn = cleanIsbn_(g('ISBN')); if (!isbn) throw new Error('Bad ISBN');
  const title0 = g('Title'), series = g('Series') || title0, vol = g('Vol'), vendor = g('Publisher');
  if (!title0 || !vendor) throw new Error('Title and Publisher are required');
  const ptype = ['Manga','Light Novel','Manhwa','Manhua','Graphic Novel'].indexOf(g('Format')) >= 0 ? g('Format') : 'Manga';
  const genre = g('Genre') || 'Drama';
  const gens = g('Genres').split(/\s*,\s*/).filter(x => GENS.indexOf(x) >= 0); if (!gens.length && GENS.indexOf(genre) >= 0) gens.push(genre);
  const age = AGE_MO[g('Age')] ? g('Age') : 'Teen';
  const aud = ['Kids','Shonen','Shojo','Seinen','Josei','General'].indexOf(g('Audience')) >= 0 ? g('Audience') : 'General';
  const size = ['Standard','Oversized','Box Set','Small'].indexOf(g('Size')) >= 0 ? g('Size') : 'Standard';
  const cond = g('Condition') || 'Used'; const isNew = /new/i.test(cond);
  const price = Number(g('Price') || 6.99).toFixed(2);
  const sstat = ['Complete','Ongoing','One-shot','English run ended early'].indexOf(g('Series status')) >= 0 ? g('Series status') : 'Ongoing';
  const year = g('Year'); const kind = { 'Light Novel': 'light novel', Manhwa: 'manhwa', Manhua: 'manhua', 'Graphic Novel': 'graphic novel' }[ptype] || 'manga';
  const title = title0 + (cond === 'Brand New Sealed' ? ' - Brand New Sealed' : (cond === 'Brand New' ? ' - BRAND NEW CONDITION' : ''));
  const art = /^[AEIOU]/.test(genre) ? 'An' : 'A';
  const intro = `${title0} by ${g('Author') || 'Unknown'}. ${art} ${genre} ${kind} rated ${age}, published in English by ${vendor}${year ? ' in ' + year : ''}.`;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mf = [['author', g('Author')], ['genre', genre], ['audience', aud], ['age_rating', age], ['language', 'English'], ['condition', isNew ? 'New' : 'Used'],
    ['size', size], ['format', ptype], ['series', series], ['series_status', sstat], ['color_type', ptype === 'Graphic Novel' ? 'Full Color' : 'Black & White'],
    ['has_anime', 'false']].filter(x => x[1]);
  if (vol) mf.push(['volume', String(vol)]);
  if (gens.length) mf.push(['genres', JSON.stringify(gens)]);
  if (Number(g('Series vols'))) mf.push(['series_volumes', String(Number(g('Series vols')))]);
  if (year) mf.push(['original_publication_year', year]);
  const metafields = mf.map(x => ({ namespace: 'custom', key: x[0], value: x[1] }));
  if (GENRE_MO[genre]) metafields.push({ namespace: 'shopify', key: 'genre', type: 'list.metaobject_reference', value: JSON.stringify(['gid://shopify/Metaobject/' + GENRE_MO[genre]]) });
  metafields.push(
    { namespace: 'shopify', key: 'target-audience', type: 'list.metaobject_reference', value: JSON.stringify(['gid://shopify/Metaobject/' + AGE_MO[age]]) },
    { namespace: 'shopify', key: 'language-version', type: 'list.metaobject_reference', value: '["gid://shopify/Metaobject/71459242302"]' },
    { namespace: 'shopify', key: 'book-cover-type', type: 'list.metaobject_reference', value: '["gid://shopify/Metaobject/172526731582"]' },
    { namespace: 'mm-google-shopping', key: 'condition', type: 'single_line_text_field', value: isNew ? 'new' : 'used' },
    { namespace: 'mm-google-shopping', key: 'custom_label_0', type: 'string', value: ptype === 'Light Novel' ? 'Light Novel' : 'Manga' },
    { namespace: 'mm-google-shopping', key: 'custom_label_1', type: 'string', value: aud },
    { namespace: 'mm-google-shopping', key: 'custom_label_3', type: 'string', value: Number(price) < 5 ? 'Under $5' : (Number(price) < 10 ? '$5-$10' : '$10+') },
    { namespace: 'mm-google-shopping', key: 'custom_label_4', type: 'string', value: 'No Anime' });
  const word = ptype === 'Light Novel' ? 'Light Novel' : (ptype === 'Manhwa' ? 'Manhwa' : 'Manga');
  const p = {
    title, vendor, productType: ptype, category: 'gid://shopify/TaxonomyCategory/me-1-3', status: 'DRAFT',
    tags: ['outofstock', 'placeholder', 'lookup-draft'].concat(sstat === 'One-shot' ? ['One Shot'] : []),
    descriptionHtml: `<p class="book-intro">${esc(intro)}</p>` + (g('Synopsis') ? `<p>${esc(g('Synopsis'))}</p>` : ''),
    metafields,
    seo: { title: `${vendor}'s ${title} ${word} for only ${price} at The Mage's`, description: `Buy ${vendor}'s ${title} ${word} for only ${price} at The Mage's Emporium!` },
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [{ optionValues: [{ optionName: 'Title', name: 'Default Title' }], price, sku: isbn, barcodes: [{ type: 'ISBN', value: isbn }], inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true, requiresShipping: true, measurement: { weight: { value: size === 'Oversized' ? 0.75 : 0.3748, unit: 'POUNDS' } } } }]
  };
  if (g('Cover URL')) p.files = [{ originalSource: g('Cover URL'), contentType: 'IMAGE', alt: title0 }];
  return p;
}
