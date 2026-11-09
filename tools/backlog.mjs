// Backlog catch-up job (GitHub Actions, no Claude usage): runs the store clean-up tools that used to need a Chrome admin tab.
// Same token + window._api shim as nightly.mjs. Results go to the job summary and to backlog-out/*.json (uploaded as a run artifact).
// Steps: series pages (create missing for 2+ book series, fill descriptions/images, volume order), edition tags,
// listing completeness (copies missing series facts from sibling volumes), read-alikes, app shelf gaps report.
import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname, OUT = ROOT + 'backlog-out/';
fs.mkdirSync(OUT, { recursive: true });
const out = (...a) => { console.log(...a); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, a.join(' ') + '\n\n'); };
const save = (f, v) => fs.writeFileSync(OUT + f, JSON.stringify(v, null, 1));
const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
if (!id || !secret){ out('Missing secrets.'); process.exit(1); }
const tj = await (await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) })).json().catch(() => ({}));
if (!tj.access_token){ out('Could not get a store token'); process.exit(1); }
const TOKEN = tj.access_token;
globalThis.window = globalThis;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); const m = s.match(/^https:\/\/raw\.githubusercontent\.com\/themagesemporium\/manga-shelf\/main\/([^?]+)/); if (m) return new Response(fs.readFileSync(ROOT + m[1])); return realFetch(u, o); };
window._api = async (query, variables) => {
  for (let i = 0; i < 8; i++){
    const r = await realFetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query, variables }) });
    if (r.status === 429 || r.status >= 500){ await new Promise(z => setTimeout(z, 2000 * (i + 1))); continue; }
    const j = await r.json(); if (j.errors && JSON.stringify(j.errors).includes('THROTTLED')){ await new Promise(z => setTimeout(z, 3000 * (i + 1))); continue; }
    if (j.errors) console.log('GraphQL error:', JSON.stringify(j.errors).slice(0, 300));
    return j;
  }
  throw new Error('Shopify API kept throttling');
};
const load = f => (0, eval)(fs.readFileSync(ROOT + 'tools/' + f, 'utf8'));
const only = (process.env.STEPS || 'ages,lntitles,pages,editions,audit,readalikes,gaps').split(',');
const days = +(process.env.DAYS || 45);
const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const step = async (name, fn) => { if (!only.includes(name)) return; const t = Date.now(); try { await fn(); } catch (e){ out(`${name} failed:`, String(e).slice(0, 300)); } console.log(name, 'took', Math.round((Date.now() - t) / 1000), 's'); };

const cfg = JSON.parse(fs.readFileSync(ROOT + 'config.json', 'utf8'));
window._NEWSNAP = await (await realFetch(cfg.snap)).json();

await step('pages', async () => {
  load('series-pages.js'); const sc = await window._spScan(); await window._spRun(); await window._spFill(); await window._spOrder();
  const SP = window._SP, SF = window._SF, SO = window._SO;
  out(`Series pages: ${sc.pages} existing, ${sc.missing} missing -> ${SP.made} made (${SP.skip || 0} skipped). Filled ${SF.desc} descriptions and ${SF.img} images. Re-ordered ${SO.fixed} pages.${[...SP.err, ...SF.err, ...SO.err].length ? ' Errors: ' + JSON.stringify([...SP.err, ...SF.err, ...SO.err]).slice(0, 600) : ''}`);
  save('pages.json', { scan: sc, made: SP, fill: SF, order: SO });
});
await step('editions', async () => {
  load('edition-tag.js'); await window._etRun({ days }); const ET = window._ET;
  out(`Edition tags (last ${days} days): scanned ${ET.scanned}, wrote ${ET.written}, skipped ${ET.skipped.length}.${ET.err.length ? ' Errors: ' + JSON.stringify(ET.err).slice(0, 300) : ''}`);
  save('editions.json', ET);
});
await step('audit', async () => {
  load('listing-audit.js'); const all = { fixed: 0, rows: [] };
  for (const q of [`status:active AND inventory_total:>0 AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel')`, `created_at:>=${since} AND (product_type:Manga OR product_type:'Light Novel' OR product_type:Manhwa OR product_type:'Graphic Novel')`]){
    await window._laRun({ q, fix: true }); const LA = window._LA; all.fixed += LA.fixed;
    const seen = new Set(all.rows.map(r => r[1])); LA.rows.forEach(r => { if (!seen.has(r[1])) all.rows.push(r); });
    out(`Listing check (${q.slice(0, 60)}…): ${LA.n} listings, filled ${LA.fixed} missing fields from sibling volumes, ${LA.rows.length} still incomplete.${LA.err.length ? ' Errors: ' + JSON.stringify(LA.err).slice(0, 300) : ''}`);
  }
  const tally = {}; all.rows.forEach(r => r[2].forEach(p => { const k = p.replace(/ \d.*$/, '').replace(/series page .*/, 'series page').replace(/price .* under 6.99/, 'price under 6.99'); tally[k] = (tally[k] || 0) + 1; }));
  out('Still missing (count of listings): ' + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  save('audit.json', all);
});
await step('readalikes', async () => { load('readalikes.js'); await window._raRun(); const RA = window._RA; out(`Read-alikes: ${RA.n} series pages, ${RA.w} updated.${RA.e.length ? ' Errors: ' + JSON.stringify(RA.e).slice(0, 300) : ''}`); });
await step('gaps', async () => {
  load('app-gaps.js'); await window._agRun(); const G = window._AGOUT || {};
  out(`App shelf gaps (new since last run): ${(G.unmatched || []).length} unmatched names, ${(G.volGaps || []).length} series with missing volumes, ${(G.notes || []).length} customer notes/messages.`);
  save('gaps.json', G);
});

await step('ages', async () => { load('series-fixes.js'); const r = await window._ageRun(); out(`Age ratings: raised ${r.fixed} volumes in ${r.series.length} series to their series' highest rating.`); save('ages.json', r.series); });
await step('lntitles', async () => { load('series-fixes.js'); const r = await window._lnRun(); out(`Light novel titles: added "Light Novel" to ${r.length} titles.`); save('lntitles.json', r); });
process.exit(0);
