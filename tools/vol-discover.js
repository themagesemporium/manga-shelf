// Volume discovery (paste into an amazon.com tab). For each job [idx, seriesName, isLN, []] it searches Amazon books
// (2 result pages) and fills job[3] with 1..highest English print volume number found (max 60). No numbered volume but a
// matching print book -> [1] (one-shot). Nothing matching -> left empty. Progress in window._VD.
(() => {
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'my', 'vol', 'volume', 'manga', 'light', 'novel', 'yaoi']);
  const page = async (q, p) => { const h = await (await fetch('/s?k=' + encodeURIComponent(q) + '&i=stripbooks' + (p > 1 ? '&page=' + p : ''))).text(); const d = new DOMParser().parseFromString(h, 'text/html');
    return [...d.querySelectorAll('[data-asin][data-component-type="s-search-result"]')].map(e => ({ t: ((e.querySelector('h2') || {}).textContent || '').trim(), f: [...e.querySelectorAll('a.a-text-bold')].map(x => x.textContent.trim()).join('/') })); };
  window._vdOne = async j => { const [, ser, ln] = j; const kw = norm(ser).split(' ').filter(w => w && !STOP.has(w) && !/^\d+$/.test(w)); const ns = norm(ser);
    let r = []; for (const p of [1, 2]){ try { r = r.concat(await page(ser + (ln ? ' light novel' : ' manga'), p)); /* the word manga keeps Amazon in Books (it ignores i=stripbooks for some queries) */ } catch(e){} await new Promise(z => setTimeout(z, 600)); }
    let max = 0, any = false;
    for (const x of r){ const t = norm(x.t); if (!((' ' + t + ' ').includes(' ' + ns + ' ') || (kw.length >= 2 && kw.every(w => t.split(' ').includes(w))) || (kw.length === 1 && t.split(' ').includes(kw[0])))) continue;
      if (!/paperback|hardcover/i.test(x.f)) continue; if (/german|french|italian|spanish|portuguese|japanese edition|box set|coloring|calendar/i.test(x.t)) continue;
      if (ln ? !/novel/i.test(x.t) : /light novel|\(novel\)/i.test(x.t)) continue;
      any = true; const m = x.t.match(/(?:vol\.?|volume|book|#)\s*(\d{1,2})\b/i) || x.t.match(/,\s*(\d{1,2})\s*(?:\(|$)/); if (m && +m[1] <= 60) max = Math.max(max, +m[1]); }
    j[3] = max ? Array.from({ length: max }, (_, k) => k + 1) : any ? [1] : []; return j; };
  window._vdRun = J => { const S = window._VD = { i: 0, n: J.length, fin: false }; let k = 0;
    const w = async () => { while (k < J.length){ const j = J[k++]; try { await window._vdOne(j); } catch(e){} S.i++; } };
    Promise.all([w(), w()]).then(() => S.fin = true); };
})();
