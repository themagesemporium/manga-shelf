// App stats for the Packing Desk "App Stats" tab. Run in a Shopify admin tab with window._api defined: await _asRun().
// Result in window._AS: {at, accounts, joinedSinceEmail, active24, active7, byDay, books, series, want, read, reviews, messages, top}.
// Then write it to the Packing Desk with ArtifactData: set stats/app (url https://claude.ai/artifact/Ey2qeRAtftubrtAhQkz5GC).
// An "account" = a customer whose app shelf (mme.shelf0..2) is non-empty. "Joined" = when that shelf was first saved.
window._asRun = async () => {
  const unGz = async b => { const bin = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); };
  const now = Date.now(), D = 864e5, launch = Date.parse('2026-11-06T16:36:00Z');
  const A = { at: now, accounts: 0, joinedSinceEmail: 0, active24: 0, active7: 0, books: 0, series: 0, want: 0, read: 0, reviews: 0, messages: 0 };
  const days = {}, top = {}; let after = null;
  do {
    const r = await _api(`query($a:String){customers(first:100,after:$a,query:"updated_at:>2026-10-25"){pageInfo{hasNextPage endCursor} nodes{${[0, 1, 2].map(i => `m${i}:metafield(namespace:"mme",key:"shelf${i}"){value createdAt updatedAt}`).join(' ')} ib:metafield(namespace:"mme",key:"inbox"){value}}}}`, { a: after });
    for (const c of r.data.customers.nodes){
      const b = [0, 1, 2].map(i => c['m' + i] ? JSON.parse(c['m' + i].value || '""') : '').join(''); if (b.length < 5) continue;
      A.accounts++; const j = Date.parse(c.m0.createdAt), l = Date.parse(c.m0.updatedAt);
      if (j >= launch) A.joinedSinceEmail++; if (now - l < D) A.active24++; if (now - l < 7 * D) A.active7++;
      const day = new Date(j).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); days[day] = (days[day] || 0) + 1;
      try { A.messages += (JSON.parse(c.ib.value).fb || []).length; } catch (e) {}
      try { const d = JSON.parse(await unGz(b)); for (const s of Object.values(d.series || {})){ const v = (s.v || []).length; if (v){ A.series++; A.books += v; top[s.n] = (top[s.n] || 0) + 1; } A.want += (s.want || []).length; A.read += (s.r || []).length; A.reviews += Object.keys(s.rv || {}).length; } } catch (e) {}
    }
    after = r.data.customers.pageInfo.hasNextPage ? r.data.customers.pageInfo.endCursor : null;
  } while (after);
  A.byDay = Object.entries(days).sort(); A.top = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return window._AS = A;
};
