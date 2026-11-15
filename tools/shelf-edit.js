// Shelf edit: move books customers logged under a wrong series name onto the right shop series and volume number.
// Run in a Shopify admin tab with window._api defined: await _seRun(ops, {dry:true}) first, then {dry:false}.
// ops: [{re: 'regex source (case-insensitive) matched against the shelf series name', ln: 0|1|null, to: '<snapshot key>', n: 'Display name', map: {1: 7}}]
//   map: old volume -> new volume (default {1: <vol>} when op.vol is given). Unmapped volumes keep their number.
// Only writes a shelf when the customer has been idle 10+ minutes (mme.shelf0 updatedAt), because the app saves without merging.
// Keeps a backup of every shelf it changes in window._SEBAK[customerId] (the compressed base64 string). Result in window._SE.
window._seRun = async (ops, opt = {}) => {
  const SE = window._SE = { shelves: 0, hits: [], wrote: [], busy: [], err: [], fin: false }; window._SEBAK = window._SEBAK || {};
  const SKIP = new Set(['99230547976']); const PARTS = 8, CHUNK = 125000;
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
  const gz = async str => { const buf = new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); let o = ''; for (let i = 0; i < buf.length; i += 0x8000) o += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(o); };
  const MF = [...Array(PARTS).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value type updatedAt}`).join(' ');
  const R = ops.map(o => Object.assign({}, o, { rx: new RegExp(o.re, 'i'), map: o.map || (o.vol ? { 1: o.vol } : {}) }));
  const mv = (arr, map) => [...new Set((arr || []).map(x => map[Math.round(+x)] != null && Math.round(+x) === +x ? map[+x] : x))].sort((a, b) => a - b);
  let a = null;
  do {
    const r = await _api(`query($a:String){customers(first:50,after:$a){pageInfo{hasNextPage endCursor} nodes{id ${MF}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    for (const c of r.data.customers.nodes){
      const cid = c.id.split('/').pop(); if (SKIP.has(cid) || !c.m0 || !c.m0.value) continue;
      let b = ''; for (let i = 0; i < PARTS; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
      let sh; try { sh = JSON.parse(await unGz(b)); } catch (e) { SE.err.push('read ' + cid); continue; } SE.shelves++;
      const S = sh.series || {}; let changed = [];
      for (const [key, s] of Object.entries(S)){
        const isLn = /-ln$/.test(key) || /light novel/i.test(s.n || '');
        const op = R.find(o => o.rx.test(s.n || '') && (o.ln == null || !!o.ln === isLn) && key !== o.to); if (!op) continue;
        const T = S[op.to] = S[op.to] || { n: op.n, v: [] };
        ['v', 'want', 'r', 'sell'].forEach(f => { if (s[f] && s[f].length){ T[f] = mv([...(T[f] || []), ...mv(s[f], op.map)], {}); } });
        if (s.vr){ T.vr = T.vr || {}; Object.entries(s.vr).forEach(([vol, rv]) => { const nv = op.map[+vol] != null ? op.map[+vol] : vol; if (T.vr[nv] == null) T.vr[nv] = rv; }); }
        ['st', 'rv', 'loc', 'cond'].forEach(f => { if (s[f] != null && T[f] == null) T[f] = s[f]; });
        // reading log entries "key|vol"
        Object.values(sh.rl || {}).forEach(L => L.forEach((t, i) => { const j = t.lastIndexOf('|'); if (t.slice(0, j) === key){ const vol = Math.round(+t.slice(j + 1)); L[i] = op.to + '|' + (op.map[vol] != null ? op.map[vol] : vol); } }));
        delete S[key]; changed.push(s.n + ' -> ' + op.n + ' ' + JSON.stringify(T.v));
      }
      if (!changed.length) continue;
      SE.hits.push([cid, changed]);
      if (opt.dry) continue;
      const idle = Date.now() - new Date(c.m0.updatedAt).getTime(); if (idle < 10 * 60e3){ SE.busy.push(cid); continue; }
      const enc = await gz(JSON.stringify(sh)); if (enc.length > PARTS * CHUNK){ SE.err.push('too big ' + cid); continue; }
      window._SEBAK[cid] = b;
      const m = []; for (let i = 0; i < PARTS; i++){ const part = enc.slice(i * CHUNK, (i + 1) * CHUNK); const old = c['m' + i];
        if (part) m.push({ ownerId: c.id, namespace: 'mme', key: 'shelf' + i, type: (c.m0.type || 'json'), value: JSON.stringify(part) });
        else if (old && old.value && JSON.parse(old.value)) m.push({ ownerId: c.id, namespace: 'mme', key: 'shelf' + i, type: (c.m0.type || 'json'), value: 'null' }); }
      const w = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m });
      if (!w.data || w.data.metafieldsSet.userErrors.length) SE.err.push('write ' + cid + ' ' + JSON.stringify(w.errors || w.data.metafieldsSet.userErrors).slice(0, 120)); else SE.wrote.push(cid);
    }
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (a);
  SE.fin = true; return SE;
};
