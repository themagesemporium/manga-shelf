// Edition tagging: finds omnibus / 2-in-1 / 3-in-1 / deluxe / collector's / box set listings that have no custom.edition yet
// and fills custom.edition, custom.edition_of (main series name), custom.contains_volumes ("4-6") and custom.edition_number.
// Run in a Shopify admin tab with window._api defined: _etRun({days: 3}) (only products created in the last N days; omit for all).
// Dry run: _etRun({dry: true}). Progress/result in window._ET {st, scanned, rows, written, skipped, err, fin}.
// rows: [id, title, type, number, contains, base]. Rows whose main series isn't in the app snapshot are still written
// (the snapshot then shows them as a series of their own editions). Box sets with no series metafield are skipped.
window._etRun = async (opt = {}) => {
  const ET = window._ET = { st: 'snap', scanned: 0, rows: [], written: 0, skipped: [], err: [], fin: false };
  try {
    const nn = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
    const SN = await (await fetch(cfg.snap)).json(); const NM = new Map(); Object.entries(SN.s).forEach(([k, e]) => { const q = nn(e.n); if (!NM.has(q)) NM.set(q, k); });
    const RX = /omnibus|[23][- ]in[- ]1|deluxe|collector'?s?\s+edition|collector'?s?\)|vizbig|big edition|perfect edition|ultimate edition|box ?set|\bvol\.?\s*\d+\s*(-|–|\+|\*|and|&)\s*(vol\.?\s*)?\d+|includes vol/i;
    const NOT = /trading card|funko|figure|dvd|blu-?ray|poster|keychain|plush|art ?book|artbook|guide ?book|coloring|before chainsaw man|sealed bundle|episode/i;
    const parse = p => { const t = p.title;
      let type = /3[- ]in[- ]1/i.test(t) ? '3-in-1' : /2[- ]in[- ]1/i.test(t) ? '2-in-1' : /box ?set/i.test(t) ? 'Box Set' : /deluxe|vizbig|big edition|perfect edition|ultimate edition/i.test(t) ? 'Deluxe' : /collector/i.test(t) ? 'Collector' : 'Omnibus';
      let a = null, b = null; const m = t.match(/(?:vol(?:ume)?s?\.?|includes|#)\s*(\d+)\s*(?:-|–|and|&|\+|\*|to)\s*(?:vol(?:ume)?\.?\s*)?(\d+)/i) || t.match(/\b(\d+)\s*(?:-|–|\+|\*)\s*(\d+)\b/);
      if (m && +m[2] > +m[1] && +m[2] - +m[1] < 15){ a = +m[1]; b = +m[2]; }
      let n = null; const mn = t.match(/(?:omnibus|edition|in-1|in 1|deluxe|collection|box set)\)?[^0-9]{0,12}(?:vol(?:ume)?\.?|#|book|part)\s*(\d+)(?!\s*(?:-|–|and|&|\+|\*)\s*\d)/i); if (mn) n = +mn[1];
      const w = t.match(/(?:volume|book)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i); if (!n && w) n = ['one','two','three','four','five','six','seven','eight','nine','ten'].indexOf(w[1].toLowerCase()) + 1;
      if (!n && !a){ const m2 = t.match(/(?:vol(?:ume)?\.?|#)\s*(\d+)\b/i); if (m2) n = +m2[1]; }
      if (!n && a){ const z = b - a + 1; n = b % z === 0 ? b / z : a; }
      if (!n && p.vo) n = Math.round(+p.vo.value); if (!n) n = 1;
      if (!a && (type === '2-in-1' || type === '3-in-1')){ const z = type === '2-in-1' ? 2 : 3; a = n * z - z + 1; b = n * z; }
      const strip = s => String(s).replace(/\(([^)]*(omnibus|edition|in-1|in 1|deluxe|collector)[^)]*)\)/ig, ' ').replace(/\b(the\s+)?(complete\s+)?(collection\s+)?(omnibus|[23][- ]in[- ]1|deluxe|collector'?s?|vizbig|big|perfect|ultimate)(\s+(edition|collection))?\b.*$/i, '').replace(/\s+(vol(ume)?\.?|#|book)\s*\d.*$/i, '').replace(/\s*\b(box ?set|the edition|complete series|complete edition|complete collection)\b.*$/i, '').replace(/[\s,:\-–]+$/, '').trim();
      let base = strip((p.se && p.se.value) || t) || strip(t); const k = NM.get(nn(base)) || (SN.al && SN.al[nn(base)]); if (k && SN.s[k]) base = SN.s[k].n;
      return [p.id.split('/').pop(), t, type, n, a && b ? a + '-' + b : '', base]; };
    ET.st = 'scan';
    const q = "-tag:Bundle AND -tag:'Shopify Collective'" + (opt.days ? ' AND created_at:>' + new Date(Date.now() - opt.days * 864e5).toISOString().slice(0, 10) : '');
    let after = null;
    do { const r = await _api(`query($a:String,$q:String){products(first:250,after:$a,query:$q){pageInfo{hasNextPage endCursor} nodes{id title se:metafield(namespace:"custom",key:"series"){value} vo:metafield(namespace:"custom",key:"volume"){value} ed:metafield(namespace:"custom",key:"edition"){value}}}}`, { a: after, q });
      if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
      r.data.products.nodes.forEach(p => { ET.scanned++; if (p.ed || !RX.test(p.title)) return; if (NOT.test(p.title)){ ET.skipped.push(p.title.slice(0, 60)); return; }
        if (/box ?set/i.test(p.title) && !p.se){ ET.skipped.push(p.title.slice(0, 60)); return; }
        if (/collector/i.test(p.title) && !/collector'?s?\s+edition|collector'?s?\)/i.test(p.title) && !/omnibus|in-1|deluxe/i.test(p.title)) return;
        ET.rows.push(parse(p)); });
      after = r.data.products.pageInfo.hasNextPage ? r.data.products.pageInfo.endCursor : null; } while (after);
    if (!opt.dry){ ET.st = 'write'; const M = [];
      ET.rows.forEach(([id, , type, n, c, base]) => { const o = 'gid://shopify/Product/' + id;
        M.push({ ownerId: o, namespace: 'custom', key: 'edition', type: 'single_line_text_field', value: type }, { ownerId: o, namespace: 'custom', key: 'edition_of', type: 'single_line_text_field', value: base });
        if (c) M.push({ ownerId: o, namespace: 'custom', key: 'contains_volumes', type: 'single_line_text_field', value: c });
        if (n) M.push({ ownerId: o, namespace: 'custom', key: 'edition_number', type: 'number_integer', value: String(n) }); });
      for (let i = 0; i < M.length; i += 25){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: M.slice(i, i + 25) });
        if (!r.data || r.data.metafieldsSet.userErrors.length) ET.err.push(i + ' ' + JSON.stringify(r.errors || r.data.metafieldsSet.userErrors[0]).slice(0, 120)); else ET.written += M.slice(i, i + 25).length; } }
    ET.st = 'done';
  } catch (e) { ET.err.push(String(e).slice(0, 200)); }
  ET.fin = true;
};
