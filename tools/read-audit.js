// Read audit (Megan, Nov 26 2026): every volume app customers logged as read (and every series they reviewed) this month
// should be matched to a shop series with the info Bingo and the challenges use: audience (Shojo/Shonen/Seinen/Josei/Kids/General),
// genres, total volumes (custom.series_volumes) and series status. Reads should never miss a square just because our data is incomplete.
// Run in a Shopify admin tab with window._api defined, then _raRun() (or _raRun({month:'2026-11'})). Progress in window._RA.
// Output (window._RAOUT, also written to shop metafield claude_tmp.read_audit):
//   missing:   [[snapKey, seriesName, ln, users, reads, ['aud','gen','t','ss'], publisher, age, genres, [productIds]], ...]
//              -> fill custom.audience / custom.genres / custom.series_volumes / custom.series_status on every product id listed
//   unmatched: [[shelfKey, name, onShelf(0/1), users, reads], ...]
//              -> add an alias to tools/snap-builder.js ALIAS (normName form, see below) if the shop has the series under
//                 another name, otherwise create the series (tools/newseries-finder.js + newseries-create.js; price check first,
//                 nothing goes live without a picture)
// Name matching mirrors the app's snapEntry(): key, key with -light-novel -> -ln, handleized name, then normName(name)+'|ln' in SN.al.
// For reads of books not on the shelf (shelf.other) the app matches by key, so aliases need the key form too:
// normName('the-demon-sword-...-ln') = 'thedemonsword...ln' + '|ln'.
window._raRun = async (opts = {}) => {
  const RA = window._RA = { st: 'load', customers: 0, users: 0, reads: 0, err: [] };
  try {
    const month = opts.month || new Date().toISOString().slice(0, 7);
    const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
    const SN = await (await fetch(cfg.snap)).json();
    const handleize = s => String(s).toLowerCase().replace(/['’]/g, '-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const normName = n => String(n || '').toLowerCase().replace(/\((manga|english|paperback|light novel)\)/g, ' ').replace(/^(the|a|an)\s+/, '').replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const baseName = n => n.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const snapKey = (ser, ln) => handleize(baseName(ser)) + (ln ? '-ln' : '');
    const isLN = (key, s) => /-ln$|-light-novel$/.test(key) || /light novel|\(novel\)/i.test(s.n || '');
    const NM = new Map(); Object.entries(SN.s).forEach(([k, e]) => { const q = normName(e.n) + (e.ln ? '|ln' : ''); if (!NM.has(q)) NM.set(q, k); });
    const AL0 = { sailormooneternaledition: 'pretty-guardian-sailor-moon-eternal-edition' };
    const entry = (key, s) => { const ln = s ? isLN(key, s) : /-ln$/.test(key); const c = [key, key.replace(/-light-novel$/, '-ln')]; if (s) c.push(snapKey(s.n, ln));
      for (const k of c) if (SN.s[k]) return k; const q = normName(s ? s.n : key) + (ln ? '|ln' : ''); const k = NM.get(q) || (SN.al && SN.al[q]) || AL0[q]; return k && SN.s[k] ? k : null; };
    const dec = async str => { const bin = Uint8Array.from(atob(str), c => c.charCodeAt(0)); return JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); };
    const by = {}; let after = null; RA.st = 'customers';
    const since = month + '-01';
    const F = [0, 1, 2, 3, 4, 5, 6, 7].map(i => `s${i}:metafield(namespace:"mme",key:"shelf${i}"){value}`).join(' ');
    for (let p = 0; p < 200; p++){
      const r = await _api(`query($a:String){customers(first:50,after:$a,query:"updated_at:>=${since}"){pageInfo{hasNextPage endCursor} nodes{id ${F}}}}`, { a: after });
      if (!r.data){ RA.err.push(JSON.stringify(r.errors).slice(0, 200)); break; }
      for (const c of r.data.customers.nodes){
        if (!c.s0) continue; RA.customers++;
        try {
          const str = [0, 1, 2, 3, 4, 5, 6, 7].map(i => c['s' + i] ? JSON.parse(c['s' + i].value) : '').join(''); if (!str) continue;
          const S = await dec(str); const cid = c.id.split('/').pop(); let any = false;
          const add = (k, isRead) => { const s = (S.series || {})[k] || (S.other || {})[k]; const own = !!(S.series || {})[k]; const id = k + '#' + (own ? 1 : 0);
            const o = by[id] || (by[id] = { k, n: s && s.n, own, s: own ? s : null, users: new Set(), reads: 0 }); o.users.add(cid); if (isRead) o.reads++; any = true; };
          const R = S.rl || {}; Object.keys(R).filter(d => d.startsWith(month)).forEach(d => R[d].forEach(t => { add(t.slice(0, t.lastIndexOf('|')), true); RA.reads++; }));
          Object.keys(S.series || {}).forEach(k => { const s = S.series[k]; if (s.rv || (s.vr && Object.keys(s.vr).length)) add(k, false); }); // reviewed series
          if (any) RA.users++;
        } catch (e){ RA.err.push(String(e).slice(0, 120)); }
      }
      if (!r.data.customers.pageInfo.hasNextPage) break; after = r.data.customers.pageInfo.endCursor;
    }
    RA.st = 'check';
    const missing = {}, unmatched = [];
    Object.values(by).forEach(o => {
      if (/^mystery-/.test(o.k)) return;
      const k = entry(o.k, o.own ? o.s : null);
      if (!k){ unmatched.push([o.k, o.n || '', o.own ? 1 : 0, o.users.size, o.reads]); return; }
      const e = SN.s[k], m = e.m || {}, miss = [];
      if (!m.aud) miss.push('aud'); if (!m.gen) miss.push('gen'); if (!e.t) miss.push('t'); if (!m.ss) miss.push('ss');
      if (!miss.length) return;
      const x = missing[k] || (missing[k] = [k, e.n, e.ln ? 1 : 0, 0, 0, miss, m.pub || '', m.age || '', m.gen || '', []]);
      x[3] += o.users.size; x[4] += o.reads;
      if (!x[9].length){ const ids = new Set(); (e.i || []).forEach(i => i[6] && ids.add(i[6])); Object.values(e.x || {}).forEach(L => L.forEach(i => i[6] && ids.add(i[6]))); x[9] = [...ids]; }
    });
    const out = window._RAOUT = { month, at: new Date().toISOString(), missing: Object.values(missing).sort((a, b) => b[4] - a[4]), unmatched: unmatched.sort((a, b) => b[4] - a[4]) };
    const shop = (await _api(`{shop{id}}`)).data.shop.id;
    await _api(`mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`, { m: [{ ownerId: shop, namespace: 'claude_tmp', key: 'read_audit', type: 'json', value: JSON.stringify(out) }] });
    RA.missing = out.missing.length; RA.unmatched = out.unmatched.length; RA.st = 'done';
  } catch (e){ RA.err.push(String(e).slice(0, 200)); RA.st = 'error'; }
  RA.fin = true; return RA;
};
