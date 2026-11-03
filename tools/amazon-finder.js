// Amazon finder for back-fill (paste into an amazon.com tab). Set window._B1 = [[idx, series, isLN(0/1), [vols]], ...] first.
// Result: window._AJ.rows = [idx, vol, isbn13, year, lowestUsedNewPrice, coverId, future(0/1), amazonTitle]
window._srch=async(q)=>{const h=await (await fetch('/s?k='+encodeURIComponent(q)+'&i=stripbooks')).text();const d=new DOMParser().parseFromString(h,'text/html');return [...d.querySelectorAll('[data-asin][data-component-type="s-search-result"]')].slice(0,12).map(e=>({a:e.dataset.asin,t:((e.querySelector('h2')||{}).textContent||'').trim(),f:[...e.querySelectorAll('a.a-text-bold')].map(x=>x.textContent.trim()).join('/')}));};
window._to13=s=>{const b='978'+s.slice(0,9);let t=0;for(let k=0;k<12;k++)t+=(+b[k])*(k%2?3:1);return b+((10-t%10)%10);};
window._dp=async a=>{const h=await (await fetch('/dp/'+a)).text();const d=new DOMParser().parseFromString(h,'text/html');const re=/(?:New & Used|Used and New|Used|New)\s*(?:\(\d+\))?\s*from\s*\$\s*([\d,]+\.\d\d)/g;const ps=[...h.matchAll(re)].map(m=>+m[1].replace(',','')).filter(x=>x>0);
 const dt=(h.match(/Publication date[^<]*<\/span>\s*<span[^>]*>([^<]+)/)||[])[1]||'';const img=((d.querySelector('#landingImage,#imgBlkFront')||{}).src||'').split('/').pop().replace(/\._[^.]+_\./,'.');
 let isbn=/^[01]\d{8}[\dX]$/.test(a)?_to13(a):((h.match(/979-?\d{10}/)||[''])[0].replace('-',''));const yr=(dt.match(/(19|20)\d\d/)||[''])[0];return {isbn,yr,p:ps.length?Math.min(...ps):0,img,fut:/will be released on/i.test(h)?1:0};};
window._norm=s=>s.toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const STOPW=new Set(['the','and','for','with','from','that','this','into','your','are','was','not','you','its','have']);
window._find=async(job)=>{const [i,ser,ln,vols]=job;const kw=_norm(ser).split(' ').filter(w=>w.length>2&&!STOPW.has(w)).slice(0,3);if(!kw.length)kw.push(_norm(ser));const out=[];
 for(const v of vols){let r=[];try{r=await _srch(ser+(ln?' light novel':'')+' vol '+v);}catch(e){continue;}
  const re=new RegExp('(vol\\.?|volume|\\b)\\s*0?'+v+'(?![\\d\\-–])','i');
  const c=r.filter(x=>{const t=_norm(x.t);return kw.every(w=>t.includes(w))&&/paperback|hardcover/i.test(x.f)&&!/edition\)|german|french|italian|spanish|portuguese|box set|\b\d+\s*-\s*\d+\b/i.test(x.t)&&re.test(x.t.replace(/300 years|80,000/i,''))&&(ln?/novel/i.test(x.t):!/light novel|\(novel\)/i.test(x.t))&&(/^[01]\d{8}[\dX]$/.test(x.a)||/^B0/.test(x.a));});
  if(!c.length)continue;let d;try{d=await _dp(c[0].a);}catch(e){continue;}if(!d.isbn)continue;out.push([i,v,d.isbn,d.yr,d.p,d.img,d.fut,c[0].t.slice(0,60)]);}
 return out;};
window._runFind=(B)=>{window._AJ={i:0,n:B.length,rows:[],fin:false,err:[]};let k=0;const w=async()=>{while(k<B.length){const j=B[k++];try{_AJ.rows.push(...await _find(j));}catch(e){_AJ.err.push(j[1]+' '+e)}_AJ.i++;}};Promise.all([w(),w(),w()]).then(()=>_AJ.fin=true);};
