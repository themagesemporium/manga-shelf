// Nightly job (GitHub Actions): refreshes the app's store snapshot and the Want List counts with no Claude usage.
// Needs repo secrets SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (the "Mage Nightly" Dev Dashboard app, installed on the store).
// Gets a short-lived Admin API token with the client-credentials grant, then runs the same tools the browser uses
// (tools/snap-publish.js + snap-builder.js, tools/wantlist-build.js) through a window._api shim.
import fs from 'node:fs';
const SHOP = 'the-mages-emporium.myshopify.com', VER = '2026-10', ROOT = new URL('..', import.meta.url).pathname;
const out = (...a) => { console.log(...a); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, a.join(' ') + '\n\n'); };
const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
if (!id || !secret){ out('Missing SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET secrets.'); process.exit(1); }
const tr = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
const tj = await tr.json().catch(() => ({}));
if (!tj.access_token){ out('Could not get a store token:', tr.status, JSON.stringify(tj).slice(0, 300)); process.exit(1); }
const TOKEN = tj.access_token;
globalThis.window = globalThis;
// tools fetch repo files from raw.githubusercontent; serve them from this checkout instead (no CDN cache lag)
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => { const s = String(u); const m = s.match(/^https:\/\/raw\.githubusercontent\.com\/themagesemporium\/manga-shelf\/main\/([^?]+)/); if (m) return new Response(fs.readFileSync(ROOT + m[1])); return realFetch(u, o); };
window._api = async (query, variables) => {
  for (let i = 0; i < 6; i++){
    const r = await realFetch(`https://${SHOP}/admin/api/${VER}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': TOKEN }, body: JSON.stringify({ query, variables }) });
    if (r.status === 429 || r.status >= 500){ await new Promise(z => setTimeout(z, 2000 * (i + 1))); continue; }
    const j = await r.json(); if (j.errors && JSON.stringify(j.errors).includes('THROTTLED')){ await new Promise(z => setTimeout(z, 3000 * (i + 1))); continue; }
    if (j.errors) console.log('GraphQL error:', JSON.stringify(j.errors).slice(0, 300));
    if (!j.data) throw new Error('Shopify refused: ' + JSON.stringify(j.errors || j).slice(0, 300)); // e.g. a missing scope; stop instead of looping
    return j;
  }
  throw new Error('Shopify API kept throttling');
};
const load = f => (0, eval)(fs.readFileSync(ROOT + 'tools/' + f, 'utf8'));
let failed = false;
// 1) store snapshot
// skip the upload when nothing but the build time changed (keeps Shopify Files tidy and spares customers a re-download)
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => k !== 'at').map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
load('snap-publish.js'); await window._spRun(null, { same: (a, b) => canon(a) === canon(b) });
const SP = window._SP;
if (SP.same){ out(`Store snapshot: no changes since the last run (${Object.keys(window._SN.s).length} series), so nothing was uploaded.`); }
else if (SP.url && !SP.err.length){
  const cfgPath = ROOT + 'config.json', cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const oldAl = Object.keys(window._SN.al || {}).length, newAl = Object.keys(window._NEWSNAP.al || {}).length;
  cfg.snap = SP.url; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  out(`Store snapshot: ${SP.series} series, ${newAl} aliases (was ${oldAl}). New file ${SP.url.split('/').pop()}`);
} else { failed = true; out('Store snapshot NOT updated:', JSON.stringify(SP.err)); }
// 2) Want List counts
try { load('wantlist-build.js'); await window._wlRun(); const W = window._WL; out(`Want List: ${W.wishers} wishers, ${W.rows} rows in ${W.parts} parts.${W.err.length ? ' Errors: ' + JSON.stringify(W.err).slice(0, 300) : ''}`); if (W.err.length && !W.rows) failed = true; }
catch (e){ failed = true; out('Want List failed:', String(e).slice(0, 300)); }
process.exit(failed ? 1 : 0);
