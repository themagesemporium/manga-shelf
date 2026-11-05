// One-call app snapshot refresh. Run in a Shopify admin tab with window._api defined, then _spRun().
// Loads the live snapshot from config.json into window._SN (keeps its aliases), runs tools/snap-builder.js,
// uploads the new snapshot to Shopify Files and waits until it is READY. Progress/result in window._SP:
// {st, series, url, fin, err}. Afterwards set config.json "snap" to _SP.url in the repo, commit and push.
window._spRun = async (extraAl) => {
  const SP = window._SP = { st: 'load', series: 0, url: '', fin: false, err: [] };
  try {
    const cfg = await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/config.json?' + Date.now())).json();
    window._SN = await (await fetch(cfg.snap)).json();
    SP.st = 'build';
    (0, eval)(await (await fetch('https://raw.githubusercontent.com/themagesemporium/manga-shelf/main/tools/snap-builder.js?' + Date.now())).text());
    while (!window._SB.fin) await new Promise(z => setTimeout(z, 3000));
    if (window._SB.err.length || !window._NEWSNAP){ SP.err.push('build ' + JSON.stringify(window._SB.err).slice(0, 200)); SP.fin = true; return; }
    const N = window._NEWSNAP; if (extraAl) N.al = Object.assign({}, N.al || {}, extraAl);
    SP.series = Object.keys(N.s).length;
    if (SP.series < 0.9 * Object.keys(_SN.s).length){ SP.err.push('new snapshot is much smaller than the old one; not uploaded'); SP.fin = true; return; }
    SP.st = 'upload';
    const body = JSON.stringify(N), fn = 'mme-snap-' + Date.now() + '.json';
    const st = await _api(`mutation($i:[StagedUploadInput!]!){stagedUploadsCreate(input:$i){stagedTargets{url resourceUrl parameters{name value}} userErrors{message}}}`, { i: [{ filename: fn, mimeType: 'application/json', resource: 'FILE', httpMethod: 'POST', fileSize: String(new Blob([body]).size) }] });
    const t = st.data.stagedUploadsCreate.stagedTargets[0]; const fd = new FormData(); t.parameters.forEach(p => fd.append(p.name, p.value)); fd.append('file', new Blob([body], { type: 'application/json' }), fn);
    await fetch(t.url, { method: 'POST', body: fd });
    const fc = await _api(`mutation($f:[FileCreateInput!]!){fileCreate(files:$f){files{id} userErrors{message}}}`, { f: [{ originalSource: t.resourceUrl, contentType: 'FILE' }] });
    const fid = fc.data.fileCreate.files[0].id;
    for (let i = 0; i < 20 && !SP.url; i++){ await new Promise(z => setTimeout(z, 3000)); const r = await _api(`{node(id:"${fid}"){... on GenericFile{url fileStatus}}}`); if (r.data.node.url) SP.url = r.data.node.url.split('?')[0]; }
    if (!SP.url){ SP.err.push('upload not ready'); SP.fin = true; return; }
    const chk = await (await fetch(SP.url)).json(); if (Object.keys(chk.s).length !== SP.series) SP.err.push('uploaded file check failed');
    SP.st = 'done';
  } catch (e) { SP.err.push(String(e).slice(0, 200)); }
  SP.fin = true;
};
