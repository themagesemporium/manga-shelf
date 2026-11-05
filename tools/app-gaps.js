// App gaps: series and volumes on customers' app shelves (owned or wishlist) that the shop has no listing for.
// Run in a Shopify admin tab with window._api defined, then _agRun(). Progress in window._AG.
// Loads the live app snapshot (config.json "snap") itself. Skips Megan's own account.
// Names already handled are kept in the shop metafield mme_app.gaps_seen (json list of "normName|ln" keys),
// so each run reports only NEW unmatched names. Pass _agRun({seed:true}) once to mark everything current as seen.
// Output (window._AGOUT, also written to shop metafield claude_tmp.app_gaps):
//   unmatched: [[name, ln(0/1), users, [vols]], ...]  -> fix with an alias in the snapshot "al" map, or create the series
//   volGaps:   [[snapKey, seriesName, ln, [vols], users], ...] -> back-fill those volumes (tools/backfill-create.js)
//   notes:     [[customerId, seriesName, note, date, vols, key], ...] -> notes customers left from the app's "needs a volume number" list;
//              plus messages sent from the app's Messages screen (key 'fb', name '(message)', date = timestamp);
//              mark handled with _agMarkSeen(["note|<customerId>|<key>|<date>"] or ["fb|<customerId>|<timestamp>"])
// Reply to a customer (shows in their app's Messages): _agReply('<customerId>', 'text'). Load tools/push-queue.js first to also send a push notification.
window._agRun = async (opt = {}) => {
  const AG = window._AG = { st: 'snap', shelves: 0, unmatched: 0, volGaps: 0, fin: false, err: [] };
  const SKIP = new Set(['99230547976']);
  const normName = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const handleize = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const snapKey = (ser, ln) => handleize(String(ser).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()) + (ln ? '-ln' : '');
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
  const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
  const SN = window._SN = await (await fetch(cfg.snap)).json();
  const NM = new Map(); Object.entries(SN.s).forEach(([k, e]) => { const q = normName(e.n) + (e.ln ? '|ln' : ''); if (!NM.has(q)) NM.set(q, k); });
  const resolve = (key, name, ln) => { for (const k of [key, key.replace(/-light-novel$/, '-ln'), snapKey(name, ln)]) if (SN.s[k]) return k; const q = normName(name) + (ln ? '|ln' : ''); const k = NM.get(q) || (SN.al && SN.al[q]); return k && SN.s[k] ? k : null; };
  const seenR = await _api(`{shop{metafield(namespace:"mme_app",key:"gaps_seen"){value}}}`);
  const seen = new Set(JSON.parse((seenR.data && seenR.data.shop.metafield && seenR.data.shop.metafield.value) || '[]'));
  const un = new Map(), vg = new Map(), notes = [];
  AG.st = 'customers';
  const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
  let a = null;
  do {
    const r = await _api(`query($a:String){customers(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id ${MF}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    for (const c of r.data.customers.nodes){
      const cid = c.id.split('/').pop(); if (SKIP.has(cid) || !c.m0 || !c.m0.value) continue;
      let b = ''; for (let i = 0; i < 8; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
      try {
        const sh = JSON.parse(await unGz(b)); AG.shelves++;
        (sh.fb || []).forEach(m => { if (m && m.t && !seen.has('fb|' + cid + '|' + m.at)) notes.push([cid, '(message)', m.t, m.at, '', 'fb']); });
        Object.entries(sh.series || {}).forEach(([key, s]) => {
                    if (s.fxNote && s.fxNote.t && !seen.has('note|' + cid + '|' + key + '|' + s.fxNote.at)) notes.push([cid, s.n, s.fxNote.t, s.fxNote.at, (s.v || []).join(','), key]);
          const ln = /-ln$/.test(key) || /light novel/i.test(s.n); const vols = [...new Set([...(s.v || []), ...(s.want || [])].map(x => Math.round(+x)).filter(x => x > 0))];
          const k = resolve(key, s.n, ln);
          if (!k){ const q = normName(s.n) + (ln ? '|ln' : ''); if (seen.has(q)) return; let e = un.get(q); if (!e){ e = { n: String(s.n).replace(/\s*\(light novel\)\s*/i, '').trim(), ln, who: new Set(), v: new Set(), q }; un.set(q, e); } e.who.add(cid); vols.forEach(x => e.v.add(x)); return; }
          const have = new Set((SN.s[k].i || []).map(x => x[0])); const miss = vols.filter(x => !have.has(x)); if (!miss.length) return;
          let e = vg.get(k); if (!e){ e = { n: SN.s[k].n, ln: SN.s[k].ln ? 1 : 0, who: new Set(), v: new Set() }; vg.set(k, e); } e.who.add(cid); miss.forEach(x => e.v.add(x));
        });
      } catch (e) { AG.err.push('shelf ' + cid); }
    }
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (a);
  const sv = s => [...s].sort((x, y) => x - y);
  const out = window._AGOUT = {
    unmatched: [...un.values()].map(e => [e.n, e.ln ? 1 : 0, e.who.size, sv(e.v)]),
    notes,
    volGaps: [...vg.entries()].map(([k, e]) => [k, e.n, e.ln, sv(e.v), e.who.size]).filter(r => !seen.has('vol|' + r[0] + '|' + r[3].join(','))),
  };
  AG.unmatched = out.unmatched.length; AG.volGaps = out.volGaps.length; AG.notes = notes.length;
  if (opt.seed){
    un.forEach(e => seen.add(e.q)); out.volGaps.forEach(r => seen.add('vol|' + r[0] + '|' + r[3].join(',')));
    await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: 'gid://shopify/Shop/19355029', namespace: 'mme_app', key: 'gaps_seen', type: 'json', value: JSON.stringify([...seen]) }] });
    AG.seeded = seen.size;
  }
  AG.st = 'write';
  const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: 'gid://shopify/Shop/19355029', namespace: 'claude_tmp', key: 'app_gaps', type: 'json', value: JSON.stringify(out) }] });
  if (!r.data || r.data.metafieldsSet.userErrors.length) AG.err.push('write');
  AG.st = 'done'; AG.fin = true;
};
// After handling a run's results, mark them seen so they aren't reported again:
// _agMarkSeen(["normname|ln", ...], ["vol|<snapKey>|<vols joined by ,>", ...]) - or just _agMarkSeen() to mark everything in _AGOUT.
window._agMarkSeen = async (keys) => {
  const normName = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const r0 = await _api(`{shop{metafield(namespace:"mme_app",key:"gaps_seen"){value}}}`);
  const seen = new Set(JSON.parse((r0.data.shop.metafield && r0.data.shop.metafield.value) || '[]'));
  (keys || [..._AGOUT.unmatched.map(u => normName(u[0]) + (u[1] ? '|ln' : '')), ..._AGOUT.volGaps.map(v => 'vol|' + v[0] + '|' + v[3].join(',')), ...(_AGOUT.notes || []).map(n => n[5] === 'fb' ? 'fb|' + n[0] + '|' + n[3] : 'note|' + n[0] + '|' + n[5] + '|' + n[3])]).forEach(k => seen.add(k));
  const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: 'gid://shopify/Shop/19355029', namespace: 'mme_app', key: 'gaps_seen', type: 'json', value: JSON.stringify([...seen]) }] });
  return seen.size + ' seen ' + JSON.stringify(r.data && r.data.metafieldsSet.userErrors);
};
// Turn volume gaps into back-fill input: sets window._NEWSNAP (= _SN), window._HB (rows for backfill-create.js _prep/_create)
// and returns the _B1 rows to paste into the Amazon tab for amazon-finder.js. maxVols caps how many volumes this run handles.
window._agToHB = (maxVols = 20) => {
  window._NEWSNAP = window._NEWSNAP || _SN; const HB = window._HB = []; let n = 0, i = 0;
  for (const [k, name, ln, vols] of _AGOUT.volGaps){
    const e = _NEWSNAP.s[k]; const rows = (e && e.i || []).filter(r => r[6]); if (!rows.length) continue;
    const take = vols.slice(0, Math.max(0, maxVols - n)); if (!take.length) break; n += take.length;
    const tpl = rows.find(r => r[2] > 0) || rows[0];
    HB.push([k, e.n, ln ? 1 : 0, rows.length, Math.max(e.t || 0, ...rows.map(r => r[0]), ...take), take, rows.filter(r => r[2] > 0).length, tpl[6], i++]);
  }
  return JSON.stringify(HB.map(h => [h[8], h[1], h[2], h[5]]));
};
window._agReply = async (cid, text) => {
  const id = 'gid://shopify/Customer/' + cid; const r0 = await _api(`{customer(id:"${id}"){metafield(namespace:"custom",key:"app_msgs"){value}}}`);
  let L = []; try { L = JSON.parse(r0.data.customer.metafield.value) || []; } catch (e) {}
  L.push({ t: String(text).slice(0, 1000), at: Date.now(), from: 'shop' }); L = L.slice(-50);
  const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: id, namespace: 'custom', key: 'app_msgs', type: 'json', value: JSON.stringify(L) }] });
  // also a push notification, if they turned them on (needs tools/push-queue.js loaded; skipped otherwise)
  if (window._pqAdd) { try { await window._pqAdd([{ cid, k: 'msgs', t: '💬 The Mage’s Emporium replied', b: 'Tap to read it in the app.', u: '/' }]); } catch (e) {} }
  return JSON.stringify(r.data && r.data.metafieldsSet.userErrors);
};
