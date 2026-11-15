// Shelf fix: volumes customers logged on the wrong format or with overall numbering (Megan OK'd Nov 14 2026: "if it fixes it to correct values").
// Run in a Shopify admin tab with window._api defined: await _sfRun({dry:true}) first, then {dry:false}. Result in window._SF.
// Rule A (format swap): a volume on a manga entry that the shop's manga series doesn't have, that is past the manga's last known volume,
//   but that the shop's light novel series of the same name does have -> moved to the light novel entry (and the reverse).
// Rule B (Ascendance of a Bookworm light novels numbered 1-33 straight through) -> Part 1 (1-3), Part 2 (4-7), Part 3 (8-12), Part 4 (13-21), Part 5 (22-33).
// opt.allow: regex on the target series name; only those moves are made (review the dry run first).
// Owned, wishlist, read and per-volume reviews move with the volume. Shelves are only written when the customer has been idle 10+ minutes.
window._sfRun = async (opt = {}) => {
  const SF = window._SF = { shelves: 0, hits: [], wrote: [], busy: [], err: [], fin: false }; window._SFBAK = window._SFBAK || {};
  const SKIP = new Set(['99230547976']); const PARTS = 8, CHUNK = 125000;
  const normName = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const handleize = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const snapKey = (ser, ln) => handleize(String(ser).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()) + (ln ? '-ln' : '');
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
  const gz = async str => { const buf = new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); let o = ''; for (let i = 0; i < buf.length; i += 0x8000) o += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(o); };
  const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
  const SN = opt.snap || await (await fetch(cfg.snap)).json();
  const NM = new Map(); Object.entries(SN.s).forEach(([k, e]) => { const q = normName(e.n) + (e.ln ? '|ln' : ''); if (!NM.has(q)) NM.set(q, k); });
  const resolve = (key, name, ln) => { for (const k of [key, key.replace(/-light-novel$/, '-ln'), snapKey(name, ln)]) if (SN.s[k]) return k; const q = normName(name) + (ln ? '|ln' : ''); const k = NM.get(q) || (SN.al && SN.al[q]); return k && SN.s[k] ? k : null; };
  const volsOf = e => { const s = new Set((e.i || []).map(r => r[0])); Object.values(e.x || {}).forEach(L => L.forEach(r => s.add(r[0]))); return s; };
  const BW = [[1, 3, 'ascendance-of-a-bookworm-part-1-ln', 'Ascendance of a Bookworm Part 1'], [4, 7, 'ascendance-of-a-bookworm-part-2-ln', 'Ascendance of a Bookworm Part 2'], [8, 12, 'ascendance-of-a-bookworm-part-3-ln', 'Ascendance of a Bookworm Part 3'], [13, 21, 'ascendance-of-a-bookworm-part-4-ln', 'Ascendance of a Bookworm Part 4'], [22, 33, 'ascendance-of-a-bookworm-part-5-ln', 'Ascendance of a Bookworm Part 5']];
  const MF = [...Array(PARTS).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value type updatedAt}`).join(' ');
  let a = null;
  do {
    const r = await _api(`query($a:String){customers(first:50,after:$a){pageInfo{hasNextPage endCursor} nodes{id ${MF}}}}`, { a });
    if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
    for (const c of r.data.customers.nodes){
      const cid = c.id.split('/').pop(); if (SKIP.has(cid) || !c.m0 || !c.m0.value) continue;
      let b = ''; for (let i = 0; i < PARTS; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
      let sh; try { sh = JSON.parse(await unGz(b)); } catch (e) { SF.err.push('read ' + cid); continue; } SF.shelves++;
      const S = sh.series || {}; const changed = [];
      const moveVols = (fromKey, toKey, toName, pairs) => { // pairs: [[oldVol,newVol]]
        if (opt.allow && !opt.allow.test(toName)) return;
        const s = S[fromKey]; const T = S[toKey] = S[toKey] || { n: toName, v: [] }; const map = new Map(pairs);
        ['v', 'want', 'r', 'sell'].forEach(f => { if (!s[f] || !s[f].length) return; const keep = [], mv = []; s[f].forEach(x => (map.has(+x) ? mv : keep).push(x)); if (!mv.length) return; s[f] = keep; T[f] = [...new Set([...(T[f] || []), ...mv.map(x => map.get(+x))])].sort((p, q) => p - q); });
        if (s.vr){ Object.keys(s.vr).forEach(vol => { if (map.has(+vol)){ T.vr = T.vr || {}; if (T.vr[map.get(+vol)] == null) T.vr[map.get(+vol)] = s.vr[vol]; delete s.vr[vol]; } }); }
        Object.values(sh.rl || {}).forEach(L => L.forEach((t, i) => { const j = t.lastIndexOf('|'); if (t.slice(0, j) === fromKey && map.has(Math.round(+t.slice(j + 1)))) L[i] = toKey + '|' + map.get(Math.round(+t.slice(j + 1))); }));
        if (!(s.v || []).length && !(s.want || []).length && !(s.r || []).length && !(s.sell || []).length && !s.ed){ delete S[fromKey]; }
        changed.push(s.n + ' -> ' + toName + ' ' + pairs.map(p => p[0] === p[1] ? p[0] : p[0] + '>' + p[1]).join(','));
      };
      for (const key of Object.keys(S)){
        const s = S[key]; if (!s) continue; const ln = /-ln$/.test(key) || /light novel/i.test(s.n || '');
        const all = [...new Set([...(s.v || []), ...(s.want || []), ...(s.r || [])].map(x => +x).filter(x => x > 0 && Math.round(x) === x))];
        if (!all.length) continue;
        // Rule B
        if (ln && /^ascendance of a bookworm(\s*\(light novel\))?\s*$/i.test(String(s.n).trim())){
          const byPart = {}; all.forEach(v => { const p = BW.find(([lo, hi]) => v >= lo && v <= hi); if (p && SN.s[p[2]]) (byPart[p[2]] = byPart[p[2]] || [p, []])[1].push([v, v - p[0] + 1]); });
          Object.values(byPart).forEach(([p, pairs]) => moveVols(key, p[2], p[3] + ' (Light Novel)', pairs)); continue;
        }
        // Rule A
        const k = resolve(key, s.n, ln); if (!k) continue; const E = SN.s[k]; const have = volsOf(E); const top = Math.max(E.t || 0, 0, ...have);
        const k2 = NM.get(normName(E.n) + (ln ? '' : '|ln')); if (!k2 || k2 === k) continue; const E2 = SN.s[k2]; const have2 = volsOf(E2);
        const mv = all.filter(v => !have.has(v) && v > top && have2.has(v));
        if (mv.length) moveVols(key, k2, E2.n + (E2.ln ? ' (Light Novel)' : ''), mv.map(v => [v, v]));
      }
      if (!changed.length) continue;
      SF.hits.push([cid, changed]); if (opt.dry) continue;
      if (Date.now() - new Date(c.m0.updatedAt).getTime() < 10 * 60e3){ SF.busy.push(cid); continue; }
      const enc = await gz(JSON.stringify(sh)); if (enc.length > PARTS * CHUNK){ SF.err.push('too big ' + cid); continue; }
      window._SFBAK[cid] = b;
      const m = []; for (let i = 0; i < PARTS; i++){ const part = enc.slice(i * CHUNK, (i + 1) * CHUNK); const old = c['m' + i];
        if (part) m.push({ ownerId: c.id, namespace: 'mme', key: 'shelf' + i, type: c.m0.type || 'json', value: JSON.stringify(part) });
        else if (old && old.value && JSON.parse(old.value)) m.push({ ownerId: c.id, namespace: 'mme', key: 'shelf' + i, type: c.m0.type || 'json', value: 'null' }); }
      const w = await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m });
      if (!w.data || w.data.metafieldsSet.userErrors.length) SF.err.push('write ' + cid); else SF.wrote.push(cid);
    }
    a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (a);
  SF.fin = true; return SF;
};
