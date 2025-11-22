// main.js
// comments simple and direct. search time appears under search box and in result-stats.

// data structures
let forwardIndex = [];
let invertedIndex = {};
let lexicon = {};
let sortedTermsCache = {};
let appKeySet = new Set();

let CURRENT_RESULTS = [];
let CURRENT_PAGE = 1;
const PAGE_SIZE = 20;

const REQUIRED_COLS = ["appid","name","short_description","header_image","metacritic_score","recommendations_total","is_free"];
const STOP_WORDS = new Set(["a","an","the","and","or","but","is","of","in","to","for","with","on","at","by","from","up","down","out","about","into","as","then","now","it","its","are","was","were","be","been","that","this","must","can","will","i","my"]);

// small helpers
function escapeHtml(s){ return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function readFileAsText(file){ return new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsText(file); }); }
function simpleCSVSplit(line){ return line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/); }
function barrelForTerm(term){ if(!term || term.length === 0) return '_'; const c = term[0]; return (c >= 'a' && c <= 'z') ? c : '_'; }

// make sure invertedIndex[barrel][term] is a Set
function ensureInvertedSet(barrel, term){
  if(!invertedIndex || typeof invertedIndex !== 'object') invertedIndex = {};
  if(!invertedIndex[barrel] || typeof invertedIndex[barrel] !== 'object') invertedIndex[barrel] = {};
  const cur = invertedIndex[barrel][term];
  if(cur && typeof cur.add === 'function') return cur;
  if(Array.isArray(cur)){ const s = new Set(cur.map(x => String(x))); invertedIndex[barrel][term] = s; return s; }
  if(cur && typeof cur === 'object'){ const vals=[]; try{ for(const k in cur) vals.push(String(cur[k])); }catch(e){} const s=new Set(vals); invertedIndex[barrel][term] = s; return s; }
  const s = new Set(); invertedIndex[barrel][term] = s; return s;
}

// cache sorted terms for prefix search
function buildSortedTermsCache(){
  sortedTermsCache = {};
  for(const b in invertedIndex){
    try{ sortedTermsCache[b] = Object.keys(invertedIndex[b]).sort(); } catch(e){ sortedTermsCache[b] = []; }
  }
}

// switch page - show requested page
// NOTE: Previously this cleared search-time which wiped the ms display. now it does not touch search-time.
function showPage(pageId){
  const pages = ['home','upload','free','search','about'];
  pages.forEach(p => {
    const el = document.getElementById('page-' + p);
    if(el) el.classList.toggle('active', p === pageId);
    const btn = document.querySelector('.nav-btn[data-page="'+p+'"]');
    if(btn) btn.classList.toggle('active', p === pageId);
  });
  if(pageId === 'free') renderFreeGames(1);
  if(pageId === 'home'){
    if(forwardIndex.length > 0){
      document.getElementById('home-empty').style.display = 'none';
      document.getElementById('home-sections').style.display = '';
      renderHomeSections();
    } else {
      document.getElementById('home-empty').style.display = '';
      document.getElementById('home-sections').style.display = 'none';
    }
  }
  if(pageId === 'search'){
    const stats = document.getElementById('result-stats');
    if(stats) stats.textContent = 'Ready to search';
    // do not clear search-time here. we want to show ms after a search.
  }
}

// upload multiple files and show progress
async function handleCSVUpload(){
  const input = document.getElementById('fileInput');
  const info = document.getElementById('upload-info');
  if(!input || !input.files || input.files.length === 0){ if(info) info.textContent = 'Select at least one file.'; return; }
  const files = Array.from(input.files);
  const totalFiles = files.length;
  let totalProcessed = 0, totalAdded = 0;

  for(let idx=0; idx<files.length; idx++){
    const f = files[idx];
    if(info) info.textContent = `Uploading file ${idx+1}/${totalFiles}: ${f.name} - reading...`;
    try{
      const text = await readFileAsText(f);
      const summary = await processCSVWithProgress(text, (processedRows, totalRows) => {
        if(info) info.textContent = `Uploading ${idx+1}/${totalFiles}: ${f.name} - ${processedRows}/${totalRows} rows processed...`;
      });
      totalProcessed += summary.processedRows;
      totalAdded += summary.added;
    } catch(err){
      console.error(err);
      if(info) info.textContent = `Error reading ${f.name}: ${err.message || err}`;
    }
    await new Promise(r => setTimeout(r, 6));
  }

  buildSortedTermsCache();
  if(info) info.textContent = `Upload finished. Processed ${totalProcessed} rows. Added ${totalAdded} apps. Total apps: ${forwardIndex.length}`;
  document.getElementById('home-empty').style.display = 'none';
  document.getElementById('home-sections').style.display = '';
  renderHomeSections();
  showPage('home');
}

// process CSV with progress callback
async function processCSVWithProgress(csvText, progressCb){
  const lines = csvText.split('\n').filter(l => l.trim().length > 0);
  if(lines.length < 2) throw new Error('File has no data rows');
  const headers = simpleCSVSplit(lines[0].toLowerCase()).map(h => h.trim().replace(/['"]+/g,''));
  const colMap = {}; REQUIRED_COLS.forEach(c => colMap[c] = headers.indexOf(c));
  const missing = REQUIRED_COLS.filter(c => colMap[c] === -1);
  if(missing.length) throw new Error('Missing required columns: ' + missing.join(', '));

  const genreCols = ['genres','genre','tags','categories','category'];
  let genreIndex = -1;
  for(const g of genreCols){ const idx = headers.indexOf(g); if(idx !== -1){ genreIndex = idx; break; } }

  let processed = 0, added = 0;
  const BATCH = 1000;
  const totalRows = lines.length - 1;

  for(let i = 1; i < lines.length; i += BATCH){
    const chunk = lines.slice(i, i + BATCH);
    for(const line of chunk){
      if(!line.trim()){ processed++; if(progressCb) progressCb(processed, totalRows); continue; }
      const parts = simpleCSVSplit(line);
      const rawAppid = (parts[colMap.appid] || '').trim().replace(/['"]+/g,'');
      const name = (parts[colMap.name] || '').trim().replace(/['"]+/g,'');
      const shortDescription = (parts[colMap.short_description] || '').trim().replace(/['"]+/g,'');
      const headerImage = (parts[colMap.header_image] || '').trim().replace(/['"]+/g,'');
      const metacriticScore = parseInt(parts[colMap.metacritic_score], 10) || 0;
      const recommendationsTotal = parseInt(parts[colMap.recommendations_total], 10) || 0;
      const isFreeRaw = (parts[colMap.is_free] || '').trim().toLowerCase();
      const isFree = (isFreeRaw === 'true' || isFreeRaw === '1' || isFreeRaw === 'yes');

      const key = rawAppid || (name || '').toLowerCase().trim();
      if(!key){ processed++; if(progressCb) progressCb(processed, totalRows); continue; }
      if(appKeySet.has(key)){ processed++; if(progressCb) progressCb(processed, totalRows); continue; }

      const docId = forwardIndex.length;
      const doc = { appid: rawAppid, name, shortDescription, headerImage, metacriticScore, recommendationsTotal, isFree, docId };
      forwardIndex.push(doc);
      appKeySet.add(key);
      added++; processed++;

      const combined = ((name || '') + ' ' + (shortDescription || '')).toLowerCase().replace(/-/g,' ').replace(/[^\w\s]/g,'');
      const words = combined.split(/\s+/).filter(w => w && !STOP_WORDS.has(w));
      for(const w of words){
        const barrel = barrelForTerm(w);
        const setForTerm = ensureInvertedSet(barrel, w);
        setForTerm.add(docId.toString());
        lexicon[w] = true;
      }

      if(genreIndex !== -1){
        const rawGenre = (parts[genreIndex] || '').toLowerCase();
        const tokens = rawGenre.split(/[\|,;\/]+/).map(x => x.trim()).filter(Boolean);
        for(const t of tokens){
          const token = t.replace(/[^\w\s]/g,'').toLowerCase();
          if(!token) continue;
          const bs = barrelForTerm(token);
          const s = ensureInvertedSet(bs, token);
          s.add(docId.toString());
          lexicon[token] = true;
        }
      }

      if(progressCb) progressCb(processed, totalRows);
    }
    await new Promise(r => setTimeout(r, 1));
  }

  return { processedRows: lines.length - 1, added };
}

// main search - shows ms in search-time element and in result-stats
function doSearch(page = 1){
  if(forwardIndex.length === 0){ alert('No data loaded. Upload a file first.'); return; }

  const searchTimeEl = document.getElementById('search-time');
  if(searchTimeEl) searchTimeEl.textContent = 'Searching...';

  const q = (document.getElementById('searchBox')?.value || '').toLowerCase().trim();
  const start = performance.now();

  let results = [];
  if(!q){ results = forwardIndex.slice(); }
  else {
    const normalized = q.replace(/-/g,' ').replace(/[^\w\s]/g,'');
    const terms = normalized.split(/\s+/).filter(t => t && !STOP_WORDS.has(t));
    if(terms.length === 0) results = forwardIndex.slice();
    else {
      let finalIDs = null;
      for(const t of terms){
        const barrel = barrelForTerm(t);
        const bucket = invertedIndex[barrel];
        if(!bucket){ finalIDs = new Set(); break; }
        const termsList = sortedTermsCache[barrel] || Object.keys(bucket).sort();
        let s = 0, e = termsList.length - 1;
        while(s <= e){ const m = Math.floor((s + e) / 2); if(termsList[m] < t) s = m + 1; else e = m - 1; }
        const idsSet = new Set();
        for(let i = s; i < termsList.length && termsList[i].startsWith(t); i++){
          const setFor = bucket[termsList[i]];
          if(!setFor) continue;
          if(typeof setFor.add === 'function') setFor.forEach(id => idsSet.add(id));
          else if(Array.isArray(setFor)) setFor.forEach(id => idsSet.add(String(id)));
          else try { Object.values(setFor).forEach(v => idsSet.add(String(v))); } catch(e){}
        }
        if(finalIDs === null) finalIDs = idsSet;
        else finalIDs = new Set([...finalIDs].filter(x => idsSet.has(x)));
        if(finalIDs.size === 0) break;
      }
      if(!finalIDs || finalIDs.size === 0) results = [];
      else results = Array.from(finalIDs).map(id => forwardIndex[parseInt(id,10)]).filter(Boolean);
    }
  }

  // category filter
  const cat = document.getElementById('categorySelect')?.value || '';
  if(cat){
    if(cat === 'popular') results = results.filter(d => d.recommendationsTotal >= 5000);
    else if(cat === 'free') results = results.filter(d => d.isFree);
    else if(cat === 'metacritic') results = results.filter(d => d.metacriticScore >= 80);
    else {
      const cLower = cat.toLowerCase();
      results = results.filter(d => ((d.name||'') + ' ' + (d.shortDescription||'')).toLowerCase().includes(cLower));
    }
  }

  // numeric filters
  const minM = parseInt(document.getElementById('minMeta')?.value || 0,10) || 0;
  const minR = parseInt(document.getElementById('minRec')?.value || 0,10) || 0;
  results = results.filter(d => d.metacriticScore >= minM && d.recommendationsTotal >= minR);

  // title priority and sort
  if(q){
    const qWords = q.split(/\s+/).map(s => s.trim()).filter(Boolean);
    const titleMatches = [], others = [];
    for(const d of results){
      const nameLower = (d.name || '').toLowerCase();
      const isTitle = qWords.some(w => nameLower.includes(w));
      if(isTitle) titleMatches.push(d); else others.push(d);
    }
    titleMatches.sort((a,b) => b.metacriticScore - a.metacriticScore);
    others.sort((a,b) => b.metacriticScore - a.metacriticScore);
    results = [...titleMatches, ...others];
  } else {
    results.sort((a,b) => b.recommendationsTotal - a.recommendationsTotal);
  }

  CURRENT_RESULTS = results;
  CURRENT_PAGE = page;
  renderResultsPage(page);

  const end = performance.now();
  const elapsed = (end - start).toFixed(2);

  if(searchTimeEl) searchTimeEl.textContent = `Search time: ${elapsed} ms`;
  const stats = document.getElementById('result-stats');
  if(stats) stats.innerHTML = `Search time: <b>${elapsed}</b> ms. Found <b>${results.length}</b> results.`;
  showPage('search');
}

// render results and pagination (no change)
function renderResultsPage(page){
  const start = (page - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const pageItems = CURRENT_RESULTS.slice(start, end);
  const list = document.getElementById('results-list');
  if(!list) return;
  list.innerHTML = '';
  for(const d of pageItems){
    const item = document.createElement('div');
    item.className = 'game-result';
    item.onclick = () => window.open('https://store.steampowered.com/app/' + d.appid, '_blank');
    item.innerHTML = `
      <div class="thumb"><img src="${escapeHtml(d.headerImage||'')}" onerror="this.src='';" style="width:100%;height:100%;object-fit:cover" /></div>
      <div class="info">
        <h3 style="margin:0 0 6px">${escapeHtml(d.name)}</h3>
        <p style="margin:0;color:#9fb1bf">${escapeHtml((d.shortDescription||'').substring(0,350))}</p>
        <p style="margin-top:8px;color:#9fb1bf">Metacritic: <b>${d.metacriticScore}</b> | Recs: <b>${d.recommendationsTotal.toLocaleString()}</b> | ${d.isFree ? '<span style="color:#a6f3b3">Free</span>' : 'Paid'}</p>
      </div>
    `;
    list.appendChild(item);
  }
  renderPagination();
  document.querySelector('.container')?.scrollIntoView({ behavior:'smooth', block:'start' });
}

// pagination and rest unchanged...
function renderPagination(){
  const pager = document.getElementById('pagination');
  if(!pager) return;
  pager.innerHTML = '';
  const totalPages = Math.max(1, Math.ceil(CURRENT_RESULTS.length / PAGE_SIZE));
  const maxButtons = 9;
  let start = 1, end = totalPages;
  if(totalPages > maxButtons){
    const half = Math.floor(maxButtons / 2);
    start = Math.max(1, CURRENT_PAGE - half);
    end = Math.min(totalPages, start + maxButtons - 1);
    if(end - start + 1 < maxButtons) start = Math.max(1, end - maxButtons + 1);
  }
  for(let i = start; i <= end; i++){
    const btn = document.createElement('button');
    btn.textContent = i;
    if(i === CURRENT_PAGE) btn.className = 'active';
    btn.onclick = () => { CURRENT_PAGE = i; renderResultsPage(i); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    pager.appendChild(btn);
  }
}

function renderHomeSections(){
  const mapping = [
    { id: 'popular-row', selector: d => d.recommendationsTotal >= 5000, sort: (a,b)=>b.recommendationsTotal - a.recommendationsTotal, sectionId: null },
    { id: 'free-row', selector: d => d.isFree, sort: (a,b)=>b.recommendationsTotal - a.recommendationsTotal, sectionId: null },
    { id: 'meta-row', selector: d => d.metacriticScore >= 80, sort: (a,b)=>b.metacriticScore - a.metacriticScore, sectionId: null },
    { id: 'sports-row', selector: d => detectCategoryInDoc(d,'sports'), sort: (a,b)=>b.recommendationsTotal - a.recommendationsTotal, sectionId: 'sports-section' },
    { id: 'horror-row', selector: d => detectCategoryInDoc(d,'horror'), sort: (a,b)=>b.recommendationsTotal - a.recommendationsTotal, sectionId: 'horror-section' },
    { id: 'simulation-row', selector: d => detectCategoryInDoc(d,'simulation'), sort: (a,b)=>b.recommendationsTotal - a.recommendationsTotal, sectionId: 'simulation-section' }
  ];

  mapping.forEach(entry => {
    const container = document.getElementById(entry.id);
    if(!container) return;
    const parentSection = entry.sectionId ? document.getElementById(entry.sectionId) : container.parentElement;
    const matches = forwardIndex.filter(entry.selector);
    if(!matches || matches.length === 0){ if(parentSection) parentSection.style.display = 'none'; return; }
    if(parentSection) parentSection.style.display = '';
    matches.sort(entry.sort);
    const items = matches.slice(0,12);
    container.innerHTML = '';
    items.forEach(d => {
      const card = document.createElement('div');
      card.className = 'card';
      card.onclick = () => window.open('https://store.steampowered.com/app/' + d.appid, '_blank');
      card.onmouseenter = () => card.style.transform = 'scale(1.03)';
      card.onmouseleave = () => card.style.transform = '';
      card.innerHTML = `<img src="${escapeHtml(d.headerImage||'')}" onerror="this.src='';" /><div class="meta"><h3>${escapeHtml(d.name)}</h3><p>${escapeHtml((d.shortDescription||'').substring(0,90))}</p></div>`;
      container.appendChild(card);
    });
  });
}

function detectCategoryInDoc(doc, category){
  const cat = category.toLowerCase();
  const hay = ((doc.name||'') + ' ' + (doc.shortDescription||'')).toLowerCase();
  if(hay.includes(cat)) return true;
  if(lexicon[cat]){
    const barrel = barrelForTerm(cat);
    const bucket = invertedIndex[barrel];
    if(bucket && bucket[cat]){
      const setFor = bucket[cat];
      if(typeof setFor.has === 'function') return setFor.has(String(doc.docId));
      if(Array.isArray(setFor)) return setFor.includes(String(doc.docId));
    }
  }
  return false;
}

let suggTimer = null;
function debouncedSuggestions(){ if(suggTimer) clearTimeout(suggTimer); suggTimer = setTimeout(showSuggestions, 160); }
function showSuggestions(){
  const q = (document.getElementById('searchBox')?.value || '').toLowerCase().trim();
  const cont = document.getElementById('suggestions');
  cont.innerHTML = '';
  if(!q) return;
  const matches = [];
  let c = 0;
  for(const t in lexicon){ if(t.startsWith(q)){ matches.push(t); c++; if(c>=8) break; } }
  if(matches.length === 0) return;
  const box = document.createElement('div');
  box.style.background = '#0f2a3a';
  box.style.padding = '6px';
  box.style.borderRadius = '6px';
  box.style.boxShadow = '0 8px 20px rgba(0,0,0,0.5)';
  matches.forEach(m => {
    const row = document.createElement('div');
    row.style.padding = '8px';
    row.style.cursor = 'pointer';
    row.style.color = '#dff3ff';
    row.textContent = m;
    row.onclick = () => { document.getElementById('searchBox').value = m; doSearch(1); cont.innerHTML = ''; };
    box.appendChild(row);
  });
  cont.appendChild(box);
}

function filterByCategory(){ doSearch(1); }
function applySortAndRender(){
  const sortVal = document.getElementById('sortSelect')?.value || 'metacritic';
  if(sortVal === 'metacritic') CURRENT_RESULTS.sort((a,b)=>b.metacriticScore-a.metacriticScore);
  else if(sortVal === 'recommendations') CURRENT_RESULTS.sort((a,b)=>b.recommendationsTotal-a.recommendationsTotal);
  else if(sortVal === 'alphabetical') CURRENT_RESULTS.sort((a,b)=>a.name.localeCompare(b.name));
  renderResultsPage(CURRENT_PAGE);
}

function renderFreeGames(page=1){
  const freeList = forwardIndex.filter(d => d.isFree).slice();
  const sortVal = document.getElementById('sortFree')?.value || 'recommendations';
  if(sortVal === 'recommendations') freeList.sort((a,b)=>b.recommendationsTotal - a.recommendationsTotal);
  else if(sortVal === 'metacritic') freeList.sort((a,b)=>b.metacriticScore - a.metacriticScore);
  else freeList.sort((a,b)=>a.name.localeCompare(b.name));
  const start = (page-1)*PAGE_SIZE;
  const pageItems = freeList.slice(start, start+PAGE_SIZE);
  const container = document.getElementById('free-results');
  container.innerHTML = '';
  pageItems.forEach(d => {
    const node = document.createElement('div');
    node.className = 'game-result';
    node.onclick = () => window.open('https://store.steampowered.com/app/' + d.appid, '_blank');
    node.innerHTML = `<div class="thumb"><img src="${escapeHtml(d.headerImage||'')}" onerror="this.src='';" style="width:100%;height:100%;object-fit:cover" /></div>
      <div class="info"><h3 style="margin:0 0 6px">${escapeHtml(d.name)}</h3><p style="margin:0;color:#9fb1bf">${escapeHtml((d.shortDescription||'').substring(0,260))}</p>
      <p style="margin-top:8px;color:#9fb1bf">Metacritic: <b>${d.metacriticScore}</b> | Recs: <b>${d.recommendationsTotal.toLocaleString()}</b></p></div>`;
    container.appendChild(node);
  });
  const totalPages = Math.max(1, Math.ceil(freeList.length / PAGE_SIZE));
  const pag = document.getElementById('free-pagination'); pag.innerHTML = '';
  for(let i=1;i<=totalPages;i++){ const b=document.createElement('button'); b.textContent=i; if(i===page) b.className='active'; b.onclick = ()=> renderFreeGames(i); pag.appendChild(b); }
}

window.onload = function(){
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', ()=> { const page = b.getAttribute('data-page'); showPage(page); }));
  const fileInput = document.getElementById('fileInput');
  if(fileInput) fileInput.onchange = () => { const info = document.getElementById('upload-info'); const f = fileInput.files && fileInput.files[0]; if(info) info.textContent = f ? 'Selected: ' + f.name : 'No file selected'; };
  if(forwardIndex.length === 0){ document.getElementById('home-empty').style.display = ''; document.getElementById('home-sections').style.display = 'none'; } else renderHomeSections();
  document.addEventListener('click', e => { const sb = document.getElementById('searchBox'); const sug = document.getElementById('suggestions'); if(!sb) return; if(!sb.contains(e.target) && sug) sug.innerHTML = ''; });
};
