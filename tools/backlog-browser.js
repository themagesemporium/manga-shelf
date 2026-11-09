// Browser version of tools/backlog.mjs: run in a Shopify admin tab with window._api defined (Megan's admin session has write access).
// _blRun('ages,lntitles,pages,editions,audit,readalikes,gaps', {days:60}) ; progress/log in window._BL {step, log[], fin}
window._blRun = async (steps, opt = {}) => {
  const BL = window._BL = { step: '', log: [], fin: false };
  const out = s => { BL.log.push(s); console.log(s); };
  const load = async f => (0, eval)(await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/tools/' + f + '?' + Date.now())).text());
  const only = String(steps || 'ages,lntitles,pages,editions,audit,readalikes,gaps').split(','), days = opt.days || 45;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const step = async (n, fn) => { if (!only.includes(n)) return; BL.step = n; try { await fn(); } catch (e){ out(n + ' failed: ' + String(e).slice(0, 200)); } };
  const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
  window._NEWSNAP = await (await fetch(cfg.snap)).json();
  await step('ages', async () => { await load('series-fixes.js'); const r = await window._ageRun(); out(`Age ratings: raised ${r.fixed} volumes in ${r.series.length} series to their series' highest rating.`); BL.ages = r.series; });
  await step('lntitles', async () => { await load('series-fixes.js'); const r = await window._lnRun(); out(`Light novel titles: added "Light Novel" to ${r.length} titles.`); BL.ln = r; });
  await step('pages', async () => { await load('series-pages.js'); const sc = await window._spScan(); await window._spRun(); await window._spFill(); await window._spOrder();
    out(`Series pages: ${sc.pages} existing, ${sc.missing} missing -> ${window._SP.made} made. Filled ${window._SF.desc} descriptions, ${window._SF.img} images. Re-ordered ${window._SO.fixed}. Errors ${[...window._SP.err, ...window._SF.err, ...window._SO.err].length}`); BL.pageErr = [...window._SP.err, ...window._SF.err, ...window._SO.err].slice(0, 30); });
  await step('editions', async () => { await load('edition-tag.js'); await window._etRun({ days }); const ET = window._ET; out(`Edition tags: scanned ${ET.scanned}, wrote ${ET.written}, skipped ${ET.skipped.length}, errors ${ET.err.length}`); });
  await step('audit', async () => { await load('listing-audit.js'); const all = { fixed: 0, rows: [] };
    for (const q of [`status:active AND inventory_total:>0 AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel')`, `created_at:>=${since} AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel')`]){
      await window._laRun({ q, fix: true }); const LA = window._LA; all.fixed += LA.fixed; const seen = new Set(all.rows.map(r => r[1])); LA.rows.forEach(r => { if (!seen.has(r[1])) all.rows.push(r); }); }
    const tally = {}; all.rows.forEach(r => r[2].forEach(p => { const k = p.replace(/ \d.*$/, '').replace(/series page .*/, 'series page').replace(/price .* under 6.99/, 'price under 6.99'); tally[k] = (tally[k] || 0) + 1; }));
    out(`Listing check: filled ${all.fixed} fields from sibling volumes; ${all.rows.length} listings still incomplete: ` + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')); BL.audit = all; });
  await step('readalikes', async () => { await load('readalikes.js'); await window._raRun(); out(`Read-alikes: ${window._RA.n} series pages, ${window._RA.w} updated.`); });
  await step('gaps', async () => { await load('app-gaps.js'); await window._agRun(); const G = window._AGOUT || {}; out(`App gaps: ${(G.unmatched || []).length} unmatched names, ${(G.volGaps || []).length} series missing volumes, ${(G.notes || []).length} notes.`); });
  BL.step = 'done'; BL.fin = true;
};
