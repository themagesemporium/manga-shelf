// Counts what customers see in the app's "needs a quick check" list (same rules as index.html fixList), across all app shelves.
// Run in a Shopify admin tab with window._api defined: _fsRun(). Result in window._FS {shelves, users, vol, name, spell, flag, unmatched, rows, fin}.
// rows: [customerId, typedName, kind, shopSeries]. Skips Megan's own account.
window._fsRun = async () => {
  const FS = window._FS = { shelves: 0, users: 0, vol: 0, name: 0, spell: 0, flag: 0, unmatched: 0, rows: [], fin: false, err: [] };
  try {
    const nn = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const hz = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const sk = (s, ln) => hz(String(s).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()) + (ln ? '-ln' : '');
    const ed = (a, b, max) => { let prev = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++){ const cur = [i]; let lo = i; for (let j = 1; j <= b.length; j++){ cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (cur[j] < lo) lo = cur[j]; } if (lo > max) return max + 1; prev = cur; } return prev[b.length]; };
    const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
    const SN = await (await fetch(cfg.snap)).json(); const NM = new Map(); Object.entries(SN.s).forEach(([k, e]) => { const q = nn(e.n) + (e.ln ? '|ln' : ''); if (!NM.has(q)) NM.set(q, k); });
    const NV = new Set(SN.nv || []);
    const isLN = (k, s) => /-ln$|-light-novel$/.test(k) || /light novel/i.test(s.n); const lang = k => /-(japanese|spanish|french|italian|german|chinese|korean)$/.test(k);
    const ent = (k, s) => { const ln = isLN(k, s); for (const x of [k, k.replace(/-light-novel$/, '-ln'), sk(s.n, ln)]) if (SN.s[x]) return x; const q = nn(s.n) + (ln ? '|ln' : ''); const z = NM.get(q) || (SN.al && SN.al[q]); return z && SN.s[z] ? z : null; };
    const find = (n, ln) => { const q = nn(n); for (const x of (ln ? [q + '|ln', q] : [q, q + '|ln'])){ const k = NM.get(x) || (SN.al && SN.al[x]); if (k && SN.s[k]) return k; } return null; };
    const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
    const MF = [...Array(8).keys()].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
    let a = null; const users = new Set();
    do { const r = await _api(`query($a:String){customers(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{id ${MF}}}}`, { a });
      if (!r.data){ await new Promise(z => setTimeout(z, 3000)); continue; }
      for (const c of r.data.customers.nodes){ const cid = c.id.split('/').pop(); if (cid === '99230547976' || !c.m0 || !c.m0.value) continue;
        let b = ''; for (let i = 0; i < 8; i++){ const m = c['m' + i]; if (!m || !m.value) break; const v = JSON.parse(m.value); if (!v) break; b += v; }
        let sh; try { sh = JSON.parse(await unGz(b)); } catch (e){ FS.err.push(cid); continue; } FS.shelves++;
        Object.entries(sh.series || {}).forEach(([k, s]) => { if (lang(k) || s.fxNo || s.ed) return;
          if (!s.fxOk && NV.has(nn(s.n))){ FS.flag++; users.add(cid); FS.rows.push([cid, s.n, 'flag', '']); return; }
          if (ent(k, s)) return; const ln = isLN(k, s); const n = String(s.n).replace(/\(light novel\)/ig, ' ').replace(/\s+/g, ' ').trim();
          const m = n.match(/^(.*?)[\s,:#-]*(?:\b(?:vol(?:ume)?\.?|episode|ep\.?|part|book|no\.?)\s*)?#?\s*(\d{1,3})(?:\s*(?:\/|of)\s*\d{1,3})?\s*$/i);
          if (m && m[1].trim().length >= 3){ const c2 = find(m[1], ln); if (c2){ FS.vol++; users.add(cid); FS.rows.push([cid, s.n, 'vol', SN.s[c2].n]); return; } }
          const q = nn(n); if (q.length >= 5){ const h = new Set(); NM.forEach((key, x) => { const [bb, l] = x.split('|'); if (!!l !== ln) return; if (bb !== q && bb.startsWith(q)) h.add(key); }); if (h.size === 1){ FS.name++; users.add(cid); FS.rows.push([cid, s.n, 'name', SN.s[[...h][0]].n]); return; } }
          if (q.length >= 6){ const lim = q.length >= 12 ? 2 : 1; let best = null, bd = 9, tie = false; NM.forEach((key, x) => { const [bb, l] = x.split('|'); if (!!l !== ln || Math.abs(bb.length - q.length) > lim) return; const d = ed(q, bb, lim); if (d <= lim){ if (d < bd){ bd = d; best = key; tie = false; } else if (d === bd && key !== best) tie = true; } }); if (best && !tie){ FS.spell++; users.add(cid); FS.rows.push([cid, s.n, 'spell', SN.s[best].n]); return; } }
          FS.unmatched++; }); }
      a = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null; } while (a);
    FS.users = users.size;
  } catch (e){ FS.err.push(String(e).slice(0, 200)); }
  FS.fin = true;
};
