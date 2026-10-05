/* ReceiptSplit — client-only receipt OCR + budget tracker. No servers, localStorage only. */
(function(){
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const money = n => (isFinite(n)?n:0).toLocaleString('en-US',{style:'currency',currency:'USD'});
const uid = () => Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4);
const todayISO = () => new Date().toISOString().slice(0,10);
const monthISO = d => (d||todayISO()).slice(0,7);

const CATS = [
  {id:'groceries', name:'Groceries / Food', icon:'🥑', color:'#16a34a'},
  {id:'dining',    name:'Dining Out',        icon:'🍔', color:'#f59e0b'},
  {id:'household', name:'Household & Hardware', icon:'🔧', color:'#0ea5e9'},
  {id:'electronics',name:'Electronics',       icon:'🔌', color:'#8b5cf6'},
  {id:'clothing',  name:'Clothing',          icon:'👕', color:'#ec4899'},
  {id:'health',    name:'Health & Pharmacy', icon:'💊', color:'#14b8a6'},
  {id:'transport', name:'Transport',         icon:'⛽', color:'#f97316'},
  {id:'fun',       name:'Entertainment',     icon:'🎬', color:'#6366f1'},
  {id:'utilities', name:'Utilities & Bills', icon:'💡', color:'#64748b'},
  {id:'other',     name:'Other',             icon:'📦', color:'#9ca3af'},
];
const catById = id => CATS.find(c=>c.id===id) || CATS[CATS.length-1];

/* keyword → category rules (local heuristic) */
const RULES = [
  [/milk|egg|bread|cheese|butter|yogurt|banana|apple|orange|grape|avocado|tomato|potato|onion|lettuce|spinach|carrot|chicken|beef|pork|fish|salmon|tuna|shrimp|rice|pasta|flour|sugar|cereal|oat|coffee|tea|juice|soda|water|snack|chip|cookie|candy|chocolate|frozen|pizza|deli|ham|turkey|bacon|produce|grocery|organic|ketchup|mayo|sauce|spice|salt|pepper|베이컨/i,'groceries'],
  [/restaurant|cafe|coffee shop|starbucks|mcdonald|burger|pizza hut|taco|sushi|ramen|diner|bar |grill|takeout|delivery|doordash|uber eats|latte|espresso|boba|bakery|donut|sandwich|brunch|dinner|lunch|breakfast/i,'dining'],
  [/drill|hammer|screw|nail|bolt|wrench|plier|tool|paint|lumber|wood|cement|ladder|tape measure|saw|garden|soil|fertilizer|shovel|rake|light bulb|battery|batteries|clean|detergent|mop|broom|bucket|paper towel|toilet|tissue|trash bag|sponge|hardware|lowe|home depot|ace |harbor freight/i,'household'],
  [/usb|cable|charger|phone|tablet|laptop|monitor|keyboard|mouse|headphone|earbud|speaker|camera|lens|tv |television|console|game|controller|drone|smart|alexa|echo|router|modem|ssd|hard drive|memory|printer|ink|electronic|best buy|hdmi|battery pack|power bank|watch/i,'electronics'],
  [/shirt|pant|jean|dress|shoe|sneaker|boot|jacket|coat|sweater|hoodie|sock|underwear|hat|cap|glove|scarf|belt|purse|bag|wallet|sunglass|clothing|apparel|nike|adidas|gap |h&m|zara|uniqlo/i,'clothing'],
  [/pharmacy|prescription|vitamin|aspirin|ibuprofen|tylenol|bandage|shampoo|soap|lotion|sunscreen|toothpaste|toothbrush|deodorant|razor|makeup|cosmetic|contact|lens solution|first aid|cvs|walgreen|rite aid/i,'health'],
  [/gas|fuel|shell|chevron|exxon|uber|lyft|taxi|bus|train|metro|subway|airline|flight|parking|toll|car wash|oil change|tire|auto|mechanic|transit/i,'transport'],
  [/movie|cinema|theater|concert|ticket|netflix|spotify|hulu|disney|game|toy|book|lego|sport|gym|golf|bowling|arcade|museum|zoo|amusement|entertain/i,'fun'],
  [/electric|water bill|gas bill|internet|phone bill|rent|mortgage|council|insurance|utility|comcast|verizon|at&t|t-mobile|power|sewer|trash/i,'utilities'],
];
function autoCategory(name){
  const t = ' ' + String(name||'').toLowerCase() + ' ';
  for (const [re,cat] of RULES) if (re.test(t)) return cat;
  return 'other';
}

/* ---------- state ---------- */
const LS_KEY = 'receiptsplit.v1';
function defaultState(){
  return {
    income: 4200,
    budgets: {groceries:700, dining:200, household:150, electronics:120, clothing:120, health:100, transport:250, fun:150, utilities:320, other:100},
    receipts: [], // {id, store, date, month, total, image?, updatedTs, items:[{name,price,cat}]}
    viewMonth: monthISO(),
    deviceId: null,
    deleted: {}, // receiptId -> deletion timestamp (tombstones for sync)
    clocks: { income: {ts:0,pid:''}, budgets: {}, reset: {ts:0,pid:''} }, // last-write-wins clocks for sync
  };
}
function load(){
  try{
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if(s && typeof s==='object'){
      const out = Object.assign(defaultState(), s);
      // migrate older saves that predate sync fields
      out.deleted = out.deleted || {};
      out.clocks = out.clocks || {};
      out.clocks.income = out.clocks.income || {ts:0,pid:''};
      out.clocks.budgets = out.clocks.budgets || {};
      out.clocks.reset = out.clocks.reset || {ts:0,pid:''};
      if(!out.deviceId) out.deviceId = uid() + uid();
      return out;
    }
  }catch(e){}
  const fresh = defaultState();
  fresh.deviceId = uid() + uid();
  return fresh;
}
let state = load();
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function seedIfEmpty(){
  if(state.receipts.length) return;
  const m = monthISO(), now = Date.now();
  state.receipts = [
    {id:uid(), store:'SuperMart', date:todayISO(), month:m, total:54.21, image:null, updatedTs:now, items:[
      {name:'Whole milk 1 gal', price:4.49, cat:'groceries'},
      {name:'Bananas 2 lb', price:1.78, cat:'groceries'},
      {name:'Sourdough bread', price:3.99, cat:'groceries'},
      {name:'Drill bit set 29pc', price:24.97, cat:'household'},
      {name:'USB-C cable 6ft', price:9.99, cat:'electronics'},
      {name:'Paper towels 6pk', price:8.99, cat:'household'},
    ]},
    {id:uid(), store:'Green Pharmacy', date:todayISO(), month:m, total:32.40, image:null, updatedTs:now, items:[
      {name:'Ibuprofen 100ct', price:8.49, cat:'health'},
      {name:'Shampoo', price:7.99, cat:'health'},
      {name:'Roast chicken deli', price:9.99, cat:'groceries'},
      {name:'Movie night popcorn', price:5.93, cat:'fun'},
    ]},
  ];
  save();
}

/* ---------- draft (pre-confirm) items ---------- */
let draft = []; // {id,name,price,cat}
let receiptImage = null;
function setDraft(items){ draft = items; renderReview(); }
function draftTotal(){ return draft.reduce((a,i)=>a+(+i.price||0),0); }

/* ---------- receipt text parsing ---------- */
const IGNORE_LINE = /subtotal|total|saving|savings|you save|balance|change|cash|credit|debit|visa|mastercard|amex|payment|thank|welcome|receipt|store|address|phone|cashier|clerk|order|member|reward|points|coupon|discount|tax\b|tender|auth|approval|ref |terminal|transaction|invoice|www\.|\.com|open|hours|manager|associate/i;
function parseReceiptText(text){
  const lines = String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const items = [];
  for(const raw of lines){
    if(/^\*{3,}|^-{3,}|^={3,}/.test(raw)) continue;
    // price at end: "MILK 1 GAL 4.49" or "... $4.49" or "2 x 3.99"
    const m = raw.match(/^(.*?)[\s·•\-:]*\$?\s*(\d{1,4}[.,]\d{2})\s*(?:ea|each)?$/);
    if(!m) continue;
    let name = m[1].replace(/^[\d\sx×*.\-#]+\s*(?:x\s*\d+)?/i,'').replace(/\s{2,}/g,' ').trim();
    name = name.replace(/[@*]\s*\d*[.,]?\d{1,2}\s*(ea|each|@)?$/i,'').replace(/\s+@\s*$/,'').trim();
    const price = parseFloat(m[2].replace(',','.'));
    if(!name || !(price>0)) continue;
    if(name.length < 2) continue;
    if(IGNORE_LINE.test(name) && !/taxable|grocery/i.test(name)) {
      // still allow lines like "TAX 2.31"? skip totals-ish lines entirely
      if(/^(total|subtotal|balance|change|cash|payment|amount due|total due)/i.test(name)) continue;
      if(name.length < 14) continue;
    }
    if(/^\d+$/.test(name)) continue;
    items.push({id:uid(), name:titleCase(name), price:Math.round(price*100)/100, cat:autoCategory(name)});
  }
  // drop likely tax/total dups: keep all but cap
  return items.slice(0,60);
}
function titleCase(s){
  s = s.toLowerCase().replace(/\s+/g,' ').trim();
  return s.replace(/\b\w/g, c=>c.toUpperCase());
}

/* ---------- OCR (lazy Tesseract) ---------- */
let tessLoading = false;
async function ensureTesseract(onProgress){
  if(window.Tesseract && window.Tesseract.recognize) return window.Tesseract;
  if(tessLoading) throw new Error('OCR engine still loading — try again in a moment.');
  tessLoading = true;
  try{
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    if(!window.Tesseract) throw new Error('OCR library failed to load (network blocked?).');
    return window.Tesseract;
  } finally { tessLoading = false; }
}
function loadScript(src){
  return new Promise((res,rej)=>{
    const s=document.createElement('script'); s.src=src; s.async=true; s.onload=res; s.onerror=()=>rej(new Error('Could not load '+src)); document.head.appendChild(s);
  });
}

/* ---------- rendering ---------- */
function toast(msg){
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  $('#toasts').appendChild(el); setTimeout(()=>el.remove(), 2600);
}
function renderTabs(){
  $$('.tab').forEach(b=>{
    const on = b.dataset.tab === currentTab;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
  });
  $$('.panel').forEach(p=>p.classList.remove('active'));
  $('#tab-'+currentTab).classList.add('active');
  // deep-linkable tabs: home-screen shortcuts (#scan/#budget) open the right tab
  try{ if(history.replaceState) history.replaceState(null, '', '#' + currentTab); }catch(e){}
}
let currentTab = 'scan';
try{
  const h = (location.hash || '').replace('#','');
  if(['scan','budget','history'].includes(h)) currentTab = h;
}catch(e){}

function renderReview(){
  const has = draft.length>0;
  $('#emptyItems').classList.toggle('hidden', has);
  $('#reviewWrap').classList.toggle('hidden', !has);
  const tb = $('#itemsBody'); tb.innerHTML='';
  const frag = document.createDocumentFragment();
  draft.forEach(it=>{
    const tr = document.createElement('tr');
    const c = catById(it.cat);
    tr.innerHTML =
      '<td><input type="text" value="" aria-label="Item name"></td>'+
      '<td class="num"><input type="number" min="0" step="0.01" value="" aria-label="Item price"></td>'+
      '<td><select aria-label="Category"></select></td>'+
      '<td><button class="icon-btn" title="Remove" aria-label="Remove item">🗑</button></td>';
    const [nameI, priceI] = tr.querySelectorAll('input');
    nameI.value = it.name; priceI.value = it.price;
    const sel = tr.querySelector('select');
    CATS.forEach(cc=>{
      const o=document.createElement('option'); o.value=cc.id; o.textContent=cc.icon+' '+cc.name; sel.appendChild(o);
    });
    sel.value = it.cat;
    nameI.addEventListener('input', ()=>{ it.name=nameI.value; renderSummaryOnly(); });
    priceI.addEventListener('input', ()=>{ it.price=parseFloat(priceI.value)||0; renderSummaryOnly(); $('#reviewTotal').textContent=money(draftTotal()); });
    sel.addEventListener('change', ()=>{ it.cat=sel.value; renderSummaryOnly(); });
    tr.querySelector('.icon-btn').addEventListener('click', ()=>{ draft=draft.filter(d=>d!==it); renderReview(); });
    frag.appendChild(tr);
  });
  tb.appendChild(frag);
  $('#reviewTotal').textContent = money(draftTotal());
  renderSummaryOnly();
}
function renderSummaryOnly(){
  const sums = {};
  draft.forEach(i=>{ sums[i.cat]=(sums[i.cat]||0)+(+i.price||0); });
  const box = $('#catSummary'); box.innerHTML='';
  Object.entries(sums).sort((a,b)=>b[1]-a[1]).forEach(([id,amt])=>{
    const c=catById(id);
    const s=document.createElement('span'); s.className='cat-pill';
    s.innerHTML='<span class="cat-dot" style="background:'+c.color+'"></span>'+c.icon+' '+c.name+' · <b>'+money(amt)+'</b>';
    box.appendChild(s);
  });
}

function monthReceipts(m){
  return state.receipts.filter(r=>(r.month||monthISO(r.date))===m);
}
function spendByCat(m){
  const out={}; CATS.forEach(c=>out[c.id]=0);
  monthReceipts(m).forEach(r=>r.items.forEach(i=>{ out[i.cat]=(out[i.cat]||0)+(+i.price||0); }));
  return out;
}
function totalBudgeted(){ return Object.values(state.budgets).reduce((a,b)=>a+(+b||0),0); }

function renderBudget(){
  const incEl=$('#incomeInput');
  if(document.activeElement!==incEl && incEl.value!=String(state.income)) incEl.value = state.income;
  if(!$('#monthInput').value) $('#monthInput').value = state.viewMonth || monthISO();
  state.viewMonth = $('#monthInput').value;
  $('#monthPill').textContent = state.viewMonth;
  const m = state.viewMonth;
  const spend = spendByCat(m);
  const budgeted = totalBudgeted();
  const spent = Object.values(spend).reduce((a,b)=>a+b,0);
  const income = +state.income||0;
  const left = income - spent;
  // header
  $('#hSpent').textContent = money(spent);
  $('#hIncome').textContent = money(income);
  $('#hLeft').textContent = money(left);
  $('#hLeft').style.color = left<0 ? '#fca5a5' : '#bbf7d0';
  // donut
  const pct = income>0 ? Math.min(100, spent/income*100) : 0;
  $('#donutPct').textContent = Math.round(pct)+'%';
  drawDonut(pct, left<0);
  $('#kBudgeted').textContent = money(budgeted);
  $('#kSpent').textContent = money(spent);
  $('#kLeft').textContent = money(Math.max(0,income-spent));
  // allocation bar
  const bar = $('#allocBar'); bar.innerHTML='';
  CATS.forEach(c=>{
    const b = +state.budgets[c.id]||0;
    if(b<=0 || income<=0) return;
    const d=document.createElement('div'); d.style.width=(b/income*100)+'%'; d.style.background=c.color; d.title=c.name+': '+money(b);
    bar.appendChild(d);
  });
  const un = income-budgeted;
  $('#allocText').textContent = money(budgeted)+' budgeted';
  const ue = $('#unallocText'); ue.textContent = (un<0?'Over by ':'')+money(Math.abs(un))+(un<0?'':' unallocated');
  ue.style.color = un<0 ? 'var(--bad)' : 'var(--muted)';
  // editors (built once; afterwards only values refresh so slider drags aren't interrupted)
  const ed = $('#budgetEditors');
  const maxR = Math.max(500, income*0.6);
  if(!ed.dataset.built){
    ed.innerHTML='';
    CATS.forEach(c=>{
      const row=document.createElement('div'); row.className='budget-edit'; row.dataset.cat=c.id;
      row.innerHTML='<span class="bname"><span class="cat-dot" style="background:'+c.color+'"></span>'+c.icon+' '+c.name+'</span>';
      const range=document.createElement('input'); range.type='range'; range.min='0'; range.step='10'; range.setAttribute('aria-label', c.name+' budget slider');
      const num=document.createElement('input'); num.type='number'; num.min='0'; num.step='10'; num.setAttribute('aria-label', c.name+' budget amount');
      range.addEventListener('input', ()=>{ state.budgets[c.id]=+range.value; num.value=range.value; save(); renderBudget(); });
      num.addEventListener('input', ()=>{ state.budgets[c.id]=+num.value||0; range.value=+num.value||0; save(); renderBudget(); });
      // broadcast once editing settles (avoids spamming the partner on every slider tick)
      const emitBudget=()=>{ RS.localOp({t:'budget-set', cat:c.id, value:+state.budgets[c.id]||0}); save(); renderBudget(); };
      range.addEventListener('change', emitBudget);
      num.addEventListener('change', emitBudget);
      row.appendChild(range); row.appendChild(num); ed.appendChild(row);
    });
    ed.dataset.built='1';
  }
  Array.from(ed.children).forEach(row=>{
    const c=row.dataset.cat;
    const range=row.querySelector('input[type=range]'), num=row.querySelector('input[type=number]');
    range.max=String(maxR);
    if(document.activeElement!==range) range.value=+state.budgets[c]||0;
    if(document.activeElement!==num) num.value=+state.budgets[c]||0;
  });
  // bars
  const bb=$('#budgetBars'); bb.innerHTML='';
  const over=[];
  CATS.forEach(c=>{
    const b=+state.budgets[c.id]||0, s=spend[c.id]||0;
    const denom=Math.max(b,s,1);
    const wrap=document.createElement('div'); wrap.className='bbar'+(s>b&&b>0?' over':'');
    const pctW=Math.min(100, s/denom*100), markPct=Math.min(100, b/denom*100);
    wrap.innerHTML='<div class="bbar-top"><span>'+c.icon+' '+c.name+'</span><span>'+money(s)+' / '+money(b)+'</span></div>'+
      '<div class="bbar-track"><div class="bbar-fill" style="width:'+pctW+'%;background:'+c.color+'"></div>'+
      (b>0?'<div class="bbar-budget-mark" style="left:calc('+markPct+'% - 1px)"></div>':'')+'</div>'+
      '<div class="bbar-sub">'+(b<=0 ? 'No budget set — spending tracked only.' : s>b ? ('Over budget by '+money(s-b)+' ⚠') : ('Remaining '+money(b-s))) +'</div>';
    bb.appendChild(wrap);
    if(b>0&&s>b) over.push(c.name);
  });
  const alert=$('#overAlert');
  if(over.length){ alert.classList.remove('hidden'); alert.textContent='⚠ Over budget in: '+over.join(', ')+' — consider moving money from an under-spent category.'; }
  else alert.classList.add('hidden');
  renderHistory();
}
function drawDonut(pct, over){
  const svg=$('#donut'); const R=48, C=2*Math.PI*R;
  const segs = [];
  const spend=spendByCat(state.viewMonth);
  let acc=0; const total=Math.max(1,Object.values(spend).reduce((a,b)=>a+b,0));
  CATS.forEach(c=>{
    const v=(spend[c.id]||0)/total; if(v<=0) return;
    segs.push('<circle cx="60" cy="60" r="'+R+'" stroke="'+c.color+'" stroke-dasharray="'+(v*C)+' '+C+'" stroke-dashoffset="'+(-acc*C+ C/4)+'" transform="rotate(-90 60 60)"/>');
    acc+=v;
  });
  svg.innerHTML='<circle cx="60" cy="60" r="'+R+'" stroke="#eef0f7"/>'+segs.join('');
}

function renderHistory(){
  const f=$('#histFilter');
  if(f.options.length<=1) CATS.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.icon+' '+c.name; f.appendChild(o); });
  const list=$('#historyList'); list.innerHTML='';
  const all=[...state.receipts].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  $('#kCount').textContent=all.length;
  const tot=all.reduce((a,r)=>a+(+r.total||r.items.reduce((x,i)=>x+(+i.price||0),0)),0);
  $('#kTotal').textContent=money(tot);
  const byCat={}; all.forEach(r=>r.items.forEach(i=>{byCat[i.cat]=(byCat[i.cat]||0)+(+i.price||0);}));
  const top=Object.entries(byCat).sort((a,b)=>b[1]-a[1])[0];
  $('#kTop').textContent=top?catById(top[0]).icon+' '+money(top[1]):'—';
  const filt=f.value;
  const shown=all.filter(r=>!filt||r.items.some(i=>i.cat===filt));
  if(!shown.length){ list.innerHTML='<div class="empty">No receipts yet. Scan your first one in the <strong>Scanner</strong> tab. 🧾</div>'; return; }
  shown.forEach(r=>{
    const card=document.createElement('div'); card.className='hist-card';
    const total=r.total!=null?+r.total:r.items.reduce((a,i)=>a+(+i.price||0),0);
    const chips=r.items.map(i=>{const c=catById(i.cat);return '<span class="cat-pill"><span class="cat-dot" style="background:'+c.color+'"></span>'+escapeHtml(i.name)+' · '+money(i.price)+' · '+c.icon+'</span>';}).join('');
    card.innerHTML='<div class="hist-top"><strong>'+escapeHtml(r.store||'Receipt')+' · '+(r.date||'')+'</strong><span><strong>'+money(total)+'</strong> <button class="icon-btn" data-del="'+r.id+'" title="Delete">🗑</button></span></div>'+
      '<div class="hist-items">'+chips+'</div>'+(r.image?'<img class="hist-thumb" src="'+r.image+'" alt="receipt photo" loading="lazy"/>':'');
    list.appendChild(card);
  });
  list.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click', ()=>{
    RS.localOp({t:'receipt-del', id:b.dataset.del}); save(); renderBudget(); renderHistory(); toast('Receipt deleted.');
  }));
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- shared-sync operation layer ----------
   Every mutation that must propagate to a connected partner goes through
   RS.localOp(op). Remote ops arrive via RS.remoteOp(op) and merge with
   last-write-wins clocks (budgets/income) and tombstones (receipt deletes),
   so two people editing at the same time converge instead of clobbering. */
function opNewer(a, b){
  if(!b) return true;
  if((a.ts||0) !== (b.ts||0)) return (a.ts||0) > (b.ts||0);
  return String(a.pid||'') > String(b.pid||'');
}
function snapshotState(){
  return JSON.parse(JSON.stringify({
    receipts: state.receipts, deleted: state.deleted || {},
    budgets: state.budgets, income: state.income, clocks: state.clocks,
  }));
}
function mergeSnapshot(snap){
  if(!snap || typeof snap!=='object') return false;
  state.deleted = state.deleted || {};
  state.clocks = state.clocks || {income:{ts:0,pid:''},budgets:{},reset:{ts:0,pid:''}};
  const rClock = (snap.clocks && snap.clocks.reset) || {ts:0,pid:''};
  // A newer wholesale reset (Clear all) wins over everything.
  if(opNewer(rClock, state.clocks.reset)){
    state.clocks.reset = {ts:rClock.ts, pid:rClock.pid||''};
    state.receipts = Array.isArray(snap.receipts) ? snap.receipts : [];
    state.budgets = Object.assign({}, state.budgets, snap.budgets || {});
    if(typeof snap.income === 'number') state.income = snap.income;
    state.clocks.income = (snap.clocks && snap.clocks.income) || state.clocks.income;
    state.clocks.budgets = Object.assign({}, state.clocks.budgets, (snap.clocks && snap.clocks.budgets) || {});
    Object.entries(snap.deleted || {}).forEach(([id,ts])=>{ state.deleted[id] = Math.max(state.deleted[id]||0, ts); });
    state.receipts = state.receipts.filter(r => (state.deleted[r.id]||0) < (r.updatedTs||0));
    return true;
  }
  let changed = false;
  Object.entries(snap.deleted || {}).forEach(([id,ts])=>{ if((state.deleted[id]||0) < ts){ state.deleted[id] = ts; changed = true; } });
  (snap.receipts || []).forEach(r=>{
    if(!r || !r.id) return;
    if((state.deleted[r.id]||0) >= (r.updatedTs||0)) return;
    const ix = state.receipts.findIndex(x=>x.id===r.id);
    if(ix < 0){ state.receipts.unshift(r); changed = true; }
    else if((r.updatedTs||0) > (state.receipts[ix].updatedTs||0)){ state.receipts[ix] = r; changed = true; }
  });
  const before = state.receipts.length;
  state.receipts = state.receipts.filter(r => (state.deleted[r.id]||0) < (r.updatedTs||0));
  if(state.receipts.length !== before) changed = true;
  state.receipts.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  Object.entries(snap.budgets || {}).forEach(([cat,val])=>{
    const clk = (snap.clocks && snap.clocks.budgets && snap.clocks.budgets[cat]) || {ts:0,pid:''};
    if(opNewer(clk, state.clocks.budgets[cat])){ state.budgets[cat] = val; state.clocks.budgets[cat] = {ts:clk.ts, pid:clk.pid||''}; changed = true; }
  });
  if(snap.clocks && snap.clocks.income && typeof snap.income === 'number' && opNewer(snap.clocks.income, state.clocks.income)){
    state.income = snap.income; state.clocks.income = {ts:snap.clocks.income.ts, pid:snap.clocks.income.pid||''}; changed = true;
  }
  return changed;
}
function applyOpToState(op){
  if(!op || !op.t) return false;
  state.deleted = state.deleted || {};
  state.clocks = state.clocks || {income:{ts:0,pid:''},budgets:{},reset:{ts:0,pid:''}};
  switch(op.t){
    case 'receipt-add': {
      const r = op.receipt;
      if(!r || !r.id) return false;
      if((state.deleted[r.id]||0) >= (r.updatedTs||0)) return false;
      const ix = state.receipts.findIndex(x=>x.id===r.id);
      if(ix >= 0){
        if((r.updatedTs||0) >= (state.receipts[ix].updatedTs||0)) state.receipts[ix] = r; else return false;
      } else state.receipts.unshift(r);
      if((state.deleted[r.id]||0) && (r.updatedTs||0) > state.deleted[r.id]) delete state.deleted[r.id];
      return true;
    }
    case 'receipt-del': {
      state.deleted[op.id] = Math.max(state.deleted[op.id]||0, op.ts||0);
      const ix = state.receipts.findIndex(x=>x.id===op.id);
      if(ix >= 0 && (op.ts||0) >= (state.receipts[ix].updatedTs||0)) state.receipts.splice(ix,1);
      return true;
    }
    case 'budget-set': {
      if(opNewer(op, state.clocks.budgets[op.cat])){
        state.budgets[op.cat] = op.value;
        state.clocks.budgets[op.cat] = {ts:op.ts, pid:op.pid||''};
        return true;
      }
      return false;
    }
    case 'income-set': {
      if(opNewer(op, state.clocks.income)){
        state.income = op.value;
        state.clocks.income = {ts:op.ts, pid:op.pid||''};
        return true;
      }
      return false;
    }
    case 'snapshot': return mergeSnapshot(op.snap);
    case 'reset': {
      if(opNewer(op, state.clocks.reset)){
        const keepDevice = state.deviceId, keepMonth = state.viewMonth;
        const fresh = defaultState();
        fresh.deviceId = keepDevice; fresh.viewMonth = keepMonth;
        fresh.clocks.reset = {ts:op.ts, pid:op.pid||''};
        fresh.clocks.income = {ts:op.ts, pid:op.pid||''};
        Object.keys(fresh.budgets).forEach(k=>{ fresh.clocks.budgets[k] = {ts:op.ts, pid:op.pid||''}; });
        state = fresh;
        return true;
      }
      return false;
    }
  }
  return false;
}

/* ---------- events ---------- */
function bind(){
  $$('.tab').forEach(b=>b.addEventListener('click', ()=>{ currentTab=b.dataset.tab; renderTabs(); }));
  // upload
  const dz=$('#dropzone'), fi=$('#fileInput');
  $('#browseBtn').addEventListener('click', e=>{e.stopPropagation(); fi.removeAttribute('capture'); fi.click();});
  $('#cameraBtn').addEventListener('click', e=>{e.stopPropagation(); fi.setAttribute('capture','environment'); fi.click();});
  dz.addEventListener('click', ()=>fi.click());
  dz.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault(); fi.click();} });
  fi.addEventListener('change', ()=>{ if(fi.files[0]) handleFile(fi.files[0]); });
  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev, e=>{e.preventDefault(); dz.style.borderColor='var(--brand)';}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev, e=>{e.preventDefault(); dz.style.borderColor='';}));
  dz.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f) handleFile(f); });
  $('#removeImgBtn').addEventListener('click', ()=>{ receiptImage=null; receiptFile=null; previewReady=false; $('#imgPreview').removeAttribute('src'); $('#imgPreviewWrap').classList.add('hidden'); hideImgError(); updateOcrBtn(); });
  $('#demoBtn').addEventListener('click', loadDemo);
  $('#ocrBtn').addEventListener('click', runOCR);
  $('#parsePasteBtn').addEventListener('click', ()=>{
    const t=$('#pasteText').value.trim();
    if(!t){ toast('Paste some receipt text first.'); return; }
    const items=parseReceiptText(t);
    if(!items.length){ toast('Could not find priced lines — check the format.'); return; }
    setDraft(items); toast(items.length+' lines parsed — please confirm categories ✓'); switchTab('scan');
  });
  $('#addItemBtn').addEventListener('click', ()=>{
    const n=$('#newName').value.trim(), p=parseFloat($('#newPrice').value);
    if(!n||!(p>0)){ toast('Type an item name and price.'); return; }
    draft.push({id:uid(), name:titleCase(n), price:Math.round(p*100)/100, cat:autoCategory(n)});
    $('#newName').value=''; $('#newPrice').value=''; renderReview();
  });
  $('#clearItemsBtn').addEventListener('click', ()=>{ setDraft([]); });
  $('#confirmBtn').addEventListener('click', ()=>{
    if(!draft.length){ toast('Nothing to save.'); return; }
    const store=$('#storeInput').value.trim()||'Receipt';
    const date=$('#dateInput').value||todayISO();
    const items=draft.map(d=>({name:d.name||'Item', price:+d.price||0, cat:catById(d.cat).id}));
    const total=Math.round(items.reduce((a,i)=>a+i.price,0)*100)/100;
    const now=Date.now();
    RS.localOp({t:'receipt-add', receipt:{id:uid(), store, date, month:monthISO(date), total, image:receiptImage, updatedTs:now, items}});
    state.viewMonth=monthISO(date); $('#monthInput').value=state.viewMonth;
    save(); setDraft([]); $('#pasteText').value='';
    renderBudget(); renderHistory(); toast('Saved '+money(total)+' → '+store+' ✓');
    currentTab='budget'; renderTabs();
  });
  // budget events
  $('#incomeInput').addEventListener('input', e=>{ state.income=+e.target.value||0; save(); renderBudget(); });
  $('#incomeInput').addEventListener('change', e=>{ RS.localOp({t:'income-set', value:+e.target.value||0}); save(); renderBudget(); });
  $('#monthInput').addEventListener('change', e=>{ state.viewMonth=e.target.value||monthISO(); save(); renderBudget(); });
  $('#suggestBtn').addEventListener('click', ()=>{
    const I=+state.income||0;
    const sug={groceries:r(I*.22),dining:r(I*.08),household:r(I*.05),electronics:r(I*.04),clothing:r(I*.05),health:r(I*.05),transport:r(I*.12),fun:r(I*.07),utilities:r(I*.15),other:r(I*.04)};
    function r(x){return Math.round(x);}
    Object.entries(sug).forEach(([cat,value])=>RS.localOp({t:'budget-set', cat, value}));
    save(); renderBudget(); toast('Suggested split applied (adds to ~87%, rest = savings).');
  });
  $('#zeroBtn').addEventListener('click', ()=>{ CATS.forEach(c=>RS.localOp({t:'budget-set', cat:c.id, value:0})); save(); renderBudget(); });
  $('#histFilter').addEventListener('change', renderHistory);
  $('#exportBtn').addEventListener('click', ()=>{
    const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='receiptsplit-data.json'; a.click();
  });
  $('#wipeBtn').addEventListener('click', ()=>{ if(confirm('Delete all receipts and budgets? (Your partner sees this too.)')){ RS.localOp({t:'reset'}); save(); setDraft([]); renderBudget(); toast('Cleared.'); } });
  $('#seedBtn').addEventListener('click', ()=>{ const keepDevice=state.deviceId, keepClocks=state.clocks, keepDeleted=state.deleted; state=defaultState(); state.deviceId=keepDevice; state.clocks=keepClocks; state.deleted=keepDeleted; save(); seedIfEmpty(); save(); renderBudget(); toast('Sample data reloaded (this device only).'); });
  $('#dateInput').value=todayISO();
}
function switchTab(t){ currentTab=t; renderTabs(); }
function updateOcrBtn(){ $('#ocrBtn').disabled=!previewReady; }

let receiptFile = null, previewReady = false;
const IMG_EXTS = ['jpg','jpeg','png','webp','gif','bmp','heic','heif'];
function isHeicFile(f){ return /heic|heif/i.test(f.type||'') || /\.hei[cf]$/i.test(f.name||''); }
function showImgError(msg){ const el=$('#imgError'); if(el){ el.textContent=msg; el.classList.remove('hidden'); } else toast(msg); }
function hideImgError(){ const el=$('#imgError'); if(el) el.classList.add('hidden'); }

/* success path shared by normal uploads and converted HEIC files */
function onPreviewReady(img, label){
  $('#imgPreviewWrap').classList.remove('hidden');
  $('#imgMeta').textContent = label;
  makeThumbnail(img);
  previewReady = true; updateOcrBtn();
  toast('Photo loaded — hit “Scan receipt with OCR”.');
}
function makeThumbnail(img){
  try{
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const max = 900, k = Math.min(1, max / Math.max(w, h));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    receiptImage = cv.toDataURL('image/jpeg', 0.72);
  }catch(e){ receiptImage = null; /* thumbnail is optional; OCR uses the preview */ }
}

let heicLoading = false;
async function convertHeic(f){
  toast('Converting iPhone photo…');
  try{
    if(!window.heic2any){
      if(heicLoading) throw new Error('converter still loading');
      heicLoading = true;
      try{ await loadScript('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js'); }
      finally{ heicLoading = false; }
      if(!window.heic2any) throw new Error('converter failed to load');
    }
    const out = await window.heic2any({blob:f, toType:'image/jpeg', quality:0.85});
    const blob = Array.isArray(out) ? out[0] : out;
    const img = $('#imgPreview');
    img.onload = ()=>onPreviewReady(img, (f.name||'photo')+' (converted) · '+Math.round(blob.size/1024)+' KB');
    img.onerror = ()=>{ $('#imgPreviewWrap').classList.add('hidden'); showImgError('That photo couldn’t be converted. Try re-saving it as JPG, or paste the receipt text below instead.'); };
    img.src = URL.createObjectURL(blob);
  }catch(err){
    console.error(err);
    $('#imgPreviewWrap').classList.add('hidden');
    showImgError('This iPhone photo (HEIC) can’t be read here. Fix: iPhone Settings → Camera → Formats → “Most Compatible”, then retake — or paste the receipt text below instead.');
  }
}

function handleFile(f){
  if(!f) return;
  hideImgError();
  const ext = String(f.name||'').split('.').pop().toLowerCase();
  // Note: some phones (notably iPhones sharing HEIC) report an empty MIME
  // type, so fall back to the file extension instead of rejecting outright.
  if(!(f.type||'').startsWith('image/') && !IMG_EXTS.includes(ext)){ toast('Please choose an image file.'); return; }
  receiptFile = f; previewReady = false; updateOcrBtn();
  const url = URL.createObjectURL(f);
  const img = $('#imgPreview');
  img.onload = ()=>onPreviewReady(img, (f.name||'photo')+' · '+Math.round(f.size/1024)+' KB');
  img.onerror = ()=>{
    if(isHeicFile(f)) convertHeic(f); // browser can't decode HEIC → convert it
    else{
      $('#imgPreviewWrap').classList.add('hidden');
      showImgError('Couldn’t read that image file. Try a JPG/PNG photo, or paste the receipt text below instead.');
    }
  };
  img.src = url;
}

/* Downscaled source for OCR: full 12MP phone photos are slow and can fail
   inside the OCR engine — 1800px on the long edge is plenty for receipts. */
function ocrSource(){
  const img = $('#imgPreview');
  const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
  if(!w || !h) return img.src;
  const k = Math.min(1, 1800 / Math.max(w, h));
  if(k >= 1) return img.src;
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.9);
}

const DEMO_TEXT = [
'SUPERMART  #4217',
'WHOLE MILK 1 GAL 4.49',
'BANANAS 2 LB @ .89 1.78',
'SOURDOUGH BREAD 3.99',
'DEWALT DRILL BIT SET 29PC 24.97',
'USB-C CABLE 6FT BRAIDED 9.99',
'PAPER TOWELS 6 ROLLS 8.99',
'CHEDDAR CHEESE 8OZ 3.49',
'SUBTOTAL 57.70','TAX 3.12','TOTAL 60.82','CASH 61.00','CHANGE 0.18','THANK YOU!'
].join('\n');
function loadDemo(){
  setDraft(parseReceiptText(DEMO_TEXT));
  $('#storeInput').value='SuperMart';
  $('#dateInput').value=todayISO();
  toast(draft.length+' items detected — confirm each category, then save ✓');
  $('#reviewWrap').scrollIntoView({behavior:'smooth', block:'nearest'});
}

async function runOCR(){
  if(!previewReady || !$('#imgPreview').src){ toast('Upload a photo first — wait for the preview to appear, then scan.'); return; }
  const box=$('#ocrStatus'); box.classList.remove('hidden');
  const txt=$('#ocrStatusText'), bar=$('#ocrBar');
  $('#ocrBtn').disabled = true;
  try{
    txt.textContent='Loading OCR engine…'; bar.style.width='8%';
    const T=await ensureTesseract();
    txt.textContent='Reading receipt…'; bar.style.width='30%';
    const src=ocrSource();
    const {data}=await T.recognize(src,'eng',{logger:mm=>{ if(mm.status==='recognizing text'&&mm.progress){ bar.style.width=(30+mm.progress*65)+'%'; txt.textContent='Reading receipt… '+Math.round(mm.progress*100)+'%'; } }});
    bar.style.width='100%'; txt.textContent='Parsing lines…';
    const items=parseReceiptText(data.text||'');
    if(!items.length){ toast('OCR read the photo but found no priced lines — try a sharper photo or paste text.'); }
    else { setDraft(items); toast(items.length+' items detected — please confirm categories ✓'); }
  }catch(err){
    console.error(err);
    toast('OCR failed: '+err.message+' — try the demo or paste text.');
  }finally{
    updateOcrBtn();
    setTimeout(()=>box.classList.add('hidden'), 800);
  }
}

/* rule chips */
function renderChips(){
  const box=$('#ruleChips');
  const examples=[['🥑 milk, eggs, bananas','groceries'],['🍔 starbucks, sushi','dining'],['🔧 drill, paint, detergent','household'],['🔌 usb, headphones, tv','electronics'],['👕 shirt, shoes','clothing'],['💊 pharmacy, shampoo','health'],['⛽ gas, uber, parking','transport'],['🎬 movie, gym, books','fun']];
  box.innerHTML=examples.map(e=>'<span>'+e[0]+'</span>').join('');
}

/* init */
seedIfEmpty();
bind();
renderChips();
renderTabs();
renderReview();
renderBudget();
updateOcrBtn();
window.__parseReceiptText = parseReceiptText;
window.__autoCategory = autoCategory;
/* Bridge for share.js (live household sync). No-op safe when share.js isn't loaded. */
window.RS = {
  pid(){ return state.deviceId; },
  snapshot: snapshotState,
  localOp(op){
    op.ts = Date.now(); op.pid = state.deviceId;
    applyOpToState(op);
    save();
    window.dispatchEvent(new CustomEvent('rs-local', {detail: op}));
  },
  remoteOp(op){
    const changed = applyOpToState(op);
    if(changed){ save(); renderBudget(); if($('#reviewWrap') && !$('#reviewWrap').classList.contains('hidden')) renderSummaryOnly(); }
    return changed;
  },
  renderAll(){ renderBudget(); },
};
})();
