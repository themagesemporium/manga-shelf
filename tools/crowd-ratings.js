// Crowd spice & gentle-read ratings (Megan, Nov 8 2026: option 2, automatic).
// Customers rate a series in the app (shelf.series[k].ux = {sp: 0-5, gr: true/false}). Nightly, this tallies every shelf:
//  - when 3+ customers agree on a value and a listing has no rating yet, it fills that listing in (all volumes and editions of the series);
//  - when 3+ agree on a value that differs from the shop's rating, the crowd wins too (Megan, Nov 8: "It can override ratings if three or more agree").
//    Changed ratings are listed in claude_tmp.crowd_changes for the record.
// Run with window._api defined: await _crRun(). Result in window._CR.
window._crRun = async (opt = {}) => {
  const CR = window._CR = { voters: 0, series: 0, set: 0, conflicts: [], err: [] };
  const NEED = opt.need || 3, SPICE = ['', '1 Sweet', '2 Ketchup', '3 Salsa', '4 Hot Sauce', '5 Ghost Pepper'];
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
  const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
  const SN = window._SN || await (await fetch(cfg.snap)).json();
  const votes = {}; const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
  let a = null;
  do { const r = await _api(`query($a:String){customers(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id ${MF}}}}`, { a });
    const c = r.data.customers;
    for (const n of c.nodes){ if (!n.m0) continue; let o; try { const parts = [...Array(8).keys()].map(i => n['m' + i] && n['m' + i].value).filter(Boolean).map(v => JSON.parse(v)); o = JSON.parse(await unGz(parts.join(''))); } catch(e){ continue; }
      let any = false; for (const [k, s] of Object.entries(o.series || {})){ if (!s || !s.ux) continue; const key = SN.s[k] ? k : (s.mk && SN.s[s.mk] ? s.mk : null); if (!key) continue;
        const V = votes[key] = votes[key] || { sp: {}, gr: {} }; if (s.ux.sp >= 1 && s.ux.sp <= 5) V.sp[s.ux.sp] = (V.sp[s.ux.sp] || 0) + 1; if (s.ux.gr != null) V.gr[!!s.ux.gr] = (V.gr[!!s.ux.gr] || 0) + 1; any = true; }
      if (any) CR.voters++; }
    a = c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null; } while (a);
  const top = m => { const e = Object.entries(m).sort((x, y) => y[1] - x[1]); return e.length && e[0][1] >= NEED && !(e[1] && e[1][1] === e[0][1]) ? e[0] : null; };
  const writes = [];
  for (const [key, V] of Object.entries(votes)){ const sp = top(V.sp), gr = top(V.gr); if (!sp && !gr) continue; CR.series++;
    const e = SN.s[key]; const pids = [...(e.i || []), ...Object.values(e.x || {}).flat()].map(x => x[6]).filter(Boolean).map(id => 'gid://shopify/Product/' + id);
    for (let i = 0; i < pids.length; i += 100){ const r = await _api(`query($i:[ID!]!){nodes(ids:$i){... on Product{id sp:metafield(namespace:"custom",key:"spice_level"){value} gr:metafield(namespace:"custom",key:"gentle_read"){value}}}}`, { i: pids.slice(i, i + 100) });
      for (const p of r.data.nodes.filter(Boolean)){
        if (sp){ const cur = p.sp ? parseInt(p.sp.value) : null; if (cur == null) writes.push({ ownerId: p.id, namespace: 'custom', key: 'spice_level', type: 'single_line_text_field', value: SPICE[+sp[0]] });
          else if (cur !== +sp[0]){ writes.push({ ownerId: p.id, namespace: 'custom', key: 'spice_level', type: 'single_line_text_field', value: SPICE[+sp[0]] }); CR.conflicts.push({ key, name: e.n, field: 'spice', shop: cur, crowd: +sp[0], votes: sp[1], pid: p.id }); } }
        if (gr){ const cur = p.gr ? p.gr.value === 'true' : null, want = gr[0] === 'true'; if (cur == null) writes.push({ ownerId: p.id, namespace: 'custom', key: 'gentle_read', type: 'boolean', value: String(want) });
          else if (cur !== want){ writes.push({ ownerId: p.id, namespace: 'custom', key: 'gentle_read', type: 'boolean', value: String(want) }); CR.conflicts.push({ key, name: e.n, field: 'gentle', shop: cur, crowd: want, votes: gr[1], pid: p.id }); } } } } }
  for (let i = 0; i < writes.length; i += 25){ const r = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: writes.slice(i, i + 25) }); const ue = r.data.metafieldsSet.userErrors; if (ue.length) CR.err.push(ue[0].message); else CR.set += Math.min(25, writes.length - i); }
  // one conflict row per series + field (with every listing id), for the Desk
  const by = {}; CR.conflicts.forEach(c => { const k = c.key + '|' + c.field; const o = by[k] = by[k] || { key: c.key, name: c.name, field: c.field, shop: c.shop, crowd: c.crowd, votes: c.votes, pids: [] }; o.pids.push(c.pid); });
  const rows = Object.values(by);
  await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: (await _api('{shop{id}}')).data.shop.id, namespace: 'claude_tmp', key: 'crowd_changes', type: 'json', value: JSON.stringify({ at: new Date().toISOString(), rows }) }] });
  CR.conflicts = rows; return CR; };
