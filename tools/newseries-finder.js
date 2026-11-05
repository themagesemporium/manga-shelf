// New-series finder (paste into an amazon.com tab). For series the shop has never listed.
// Set window._NJ = [[idx, seriesName, isLN(0/1), [vols]], ...] then _nsRun(_NJ). Progress/result in window._NS2:
// rows [idx, vol, isbn13, year, lowestPrice, coverId, future, amazonTitle, author, publisher, readingAge, cats, pages]
// Matching is strict: every word of the series name (except stop words) must be in the Amazon title, print format only,
// no foreign editions/box sets, and the volume number must match (a title without a number only counts for Vol 1).
(() => {
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'my', 'vol', 'volume', 'manga', 'light', 'novel', 'yaoi']);
  const to13 = s => { const b = '978' + s.slice(0, 9); let t = 0; for (let k = 0; k < 12; k++) t += (+b[k]) * (k % 2 ? 3 : 1); return b + ((10 - t % 10) % 10); };
  const srch = async q => { const h = await (await fetch('/s?k=' + encodeURIComponent(q) + '&i=stripbooks')).text(); const d = new DOMParser().parseFromString(h, 'text/html');
    return [...d.querySelectorAll('[data-asin][data-component-type="s-search-result"]')].slice(0, 12).map(e => ({ a: e.dataset.asin, t: ((e.querySelector('h2') || {}).textContent || '').trim(), f: [...e.querySelectorAll('a.a-text-bold')].map(x => x.textContent.trim()).join('/') })); };
  const dp = async a => { const h = await (await fetch('/dp/' + a)).text(); const d = new DOMParser().parseFromString(h, 'text/html');
    const ps = [...h.matchAll(/(?:New & Used|Used and New|Used|New)\s*(?:\(\d+\))?\s*from\s*\$\s*([\d,]+\.\d\d)/g)].map(m => +m[1].replace(',', '')).filter(x => x > 0);
    const det = [...d.querySelectorAll('#detailBullets_feature_div li, #rpi-attribute-book_details-publisher, .rpi-attribute-content, #detailBulletsWrapper_feature_div li')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
    const get = re => { for (const t of det){ const m = t.match(re); if (m) return m[1].trim(); } return ''; };
    const dt = (h.match(/Publication date[^<]*<\/span>\s*<span[^>]*>([^<]+)/) || [])[1] || get(/Publication date\s*[:‏‎\s]*(.+)/);
    const img = ((d.querySelector('#landingImage,#imgBlkFront') || {}).src || '').split('/').pop().replace(/\._[^.]+_\./, '.');
    const isbn = /^[01]\d{8}[\dX]$/.test(a) ? to13(a) : ((h.match(/979-?\d{10}/) || [''])[0].replace('-', ''));
    const au = [...d.querySelectorAll('#bylineInfo .author a, #bylineInfo .author .a-link-normal')].map(x => x.textContent.trim()).filter(x => x && !/Visit|Learn|Follow/i.test(x)).filter((x, i, A) => A.indexOf(x) === i).slice(0, 3).join(', ');
    let pub = get(/Publisher\s*[:‏‎\s]*([^;(]+)/).replace(/[‏‎]/g, '').replace(/\s*\(.*$/, '').replace(/,?\s*(LLC|Inc\.?|Ltd\.?)$/i, '').trim();
    const age = get(/Reading age\s*[:‏‎\s]*(.+)/).replace(/[‏‎]/g, '').trim();
    const pages = (get(/(\d+)\s*pages/) || '');
    const cats = [...h.matchAll(/in\s*<a[^>]*>([^<]{3,60})<\/a>/g)].map(m => m[1].replace(/&amp;/g, '&').trim()).filter(c => !/Books$|^See Top/.test(c)).slice(0, 4).join('|');
    return { isbn, yr: (String(dt).match(/(19|20)\d\d/) || [''])[0], p: ps.length ? Math.min(...ps) : 0, img, fut: /will be released on/i.test(h) ? 1 : 0, au, pub, age, cats, pages }; };
  window._nsFind = async ([i, ser, ln, vols]) => {
    const kw = norm(ser).split(' ').filter(w => w && !STOP.has(w) && !/^\d+$/.test(w)); if (!kw.length) kw.push(norm(ser)); const out = [];
    for (const v of vols){
      let r = []; try { r = await srch(ser + (ln ? ' light novel' : '') + (vols.length > 1 || v > 1 ? ' vol ' + v : '')); } catch (e) { continue; }
      const re = new RegExp('(vol\\.?|volume|\\b)\\s*0?' + v + '(?![\\d\\-–])', 'i');
      const c = r.filter(x => { const t = norm(x.t); if (!kw.every(w => t.split(' ').includes(w))) return false;
        if (!/paperback|hardcover/i.test(x.f)) return false;
        if (/german|french|italian|spanish|portuguese|japanese edition|box set|\b\d+\s*-\s*\d+\b|coloring|calendar|art ?book|guide/i.test(x.t)) return false;
        const hasNum = /(vol\.?|volume|book|#)\s*\d+|,\s*\d+\s*(\(|$)|\s\d+\s*(:|\(|$)/i.test(x.t);
        if (hasNum ? !re.test(x.t) : v !== 1) return false;
        if (ln ? !/novel/i.test(x.t) : /light novel|\(novel\)/i.test(x.t)) return false;
        return /^[01]\d{8}[\dX]$/.test(x.a) || /^B0/.test(x.a); });
      if (!c.length) continue; let d; try { d = await dp(c[0].a); } catch (e) { continue; } if (!d.isbn) continue;
      out.push([i, v, d.isbn, d.yr, d.p, d.img, d.fut, c[0].t.slice(0, 80), d.au, d.pub, d.age, d.cats, d.pages]);
    }
    return out; };
  window._nsRun = B => { const S = window._NS2 = { i: 0, n: B.length, rows: [], none: [], fin: false, err: [] }; let k = 0;
    const w = async () => { while (k < B.length){ const j = B[k++]; try { const r = await window._nsFind(j); if (r.length) S.rows.push(...r); else S.none.push(j[0]); } catch (e) { S.err.push(j[1] + ' ' + e); } S.i++; } };
    Promise.all([w(), w(), w()]).then(() => S.fin = true); };
})();
