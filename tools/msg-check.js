// Light check for new messages customers sent from the app (Messages screen feedback and "needs a quick check" notes).
// Run in a Shopify admin tab with window._api defined: _mcRun(). Result in window._MC {shelves, rows, fin, err}.
// rows: [customerId, firstName lastInitial, kind ('message'|'note'), seriesName, text, date, seenKey]. Only items not yet marked seen.
// After handling: _mcSeen() marks every row in _MC.rows seen (same list as app-gaps: shop metafield mme_app.gaps_seen).
// Reply to a customer in their app: load app-gaps.js and use _agReply('<customerId>', 'text') (only with Megan's OK).
window._mcRun = async () => {
  const MC = window._MC = { shelves: 0, rows: [], fin: false, err: [] };
  try {
    const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
    const s0 = await _api(`{shop{metafield(namespace:"mme_app",key:"gaps_seen"){value}}}`);
    const seen = new Set(JSON.parse((s0.data && s0.data.shop.metafield && s0.data.shop.metafield.value) || '[]'));
    const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
    let a = null;
    do { const r = await _api(`query($a:String){customers(first:100,after:$a,query:"metafields.mme.shelf0:*"){pageInfo{hasNextPage endCursor} nodes{id firstName lastName ${MF}}}}`, { a });
      if (!r.data){ MC.err.push(JSON.stringify(r.errors || '').slice(0, 150)); break; }
      for (const c of r.data.customers.nodes){ const cid = c.id.split('/').pop(); if (cid === '99230547976' || !c.m0 || !c.m0.value) continue;
        let b = ''; for (let i = 0; i < 8; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
        let sh; try { sh = JSON.parse(await unGz(b)); } catch (e){ MC.err.push('shelf ' + cid); continue; } MC.shelves++;
        const who = [c.firstName || '', c.lastName ? c.lastName[0] + '.' : ''].join(' ').trim() || 'Customer ' + cid;
        (sh.fb || []).forEach(m => { const k = 'fb|' + cid + '|' + m.at; if (m && m.t && !seen.has(k)) MC.rows.push([cid, who, 'message', '', m.t, new Date(m.at).toISOString().slice(0, 16), k]); });
        Object.entries(sh.series || {}).forEach(([key, s]) => { if (s.fxNote && s.fxNote.t){ const k = 'note|' + cid + '|' + key + '|' + s.fxNote.at; if (!seen.has(k)) MC.rows.push([cid, who, 'note', s.n, s.fxNote.t, s.fxNote.at, k]); } }); }
      a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null; } while (a);
  } catch (e){ MC.err.push(String(e).slice(0, 200)); }
  MC.fin = true;
};
window._mcSeen = async () => {
  const s0 = await _api(`{shop{metafield(namespace:"mme_app",key:"gaps_seen"){value}}}`);
  const seen = new Set(JSON.parse((s0.data.shop.metafield && s0.data.shop.metafield.value) || '[]')); (_MC.rows || []).forEach(r => seen.add(r[6]));
  const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: 'gid://shopify/Shop/19355029', namespace: 'mme_app', key: 'gaps_seen', type: 'json', value: JSON.stringify([...seen]) }] });
  return seen.size + ' seen ' + JSON.stringify(r.data && r.data.metafieldsSet.userErrors);
};
