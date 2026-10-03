'use strict';
/* כלכלת המשפחה – dashboard logic.
   Data model lives in data/data.enc.json (encrypted) or data/demo.json (demo user). */

const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const MS = ['ינו׳','פבר׳','מרץ','אפר׳','מאי','יוני','יולי','אוג׳','ספט׳','אוק׳','נוב׳','דצמ׳'];
const PAGES = [
  {id:'total',   t:'מבט כולל',            i:'<path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/>'},
  {id:'growth',  t:'צמיחה לאורך זמן',      i:'<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'},
  {id:'exp',     t:'הוצאות',               i:'<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/>', year:'exp'},
  {id:'inc',     t:'הכנסות',               i:'<path d="M12 3v18"/><path d="M17 7.5C17 5.6 14.8 4.5 12 4.5S7 5.6 7 7.5s2.2 3 5 3.5 5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3"/>', year:'inc'},
  {id:'balance', t:'הכנסות מול הוצאות',    i:'<path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 8l-3 7h6z"/><path d="M19 8l-3 7h6z"/>', year:'bal'},
  {id:'risk',    t:'ניהול סיכונים',        i:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'},
  {id:'graphs',  t:'גרפים',                i:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'},
  {id:'contacts',t:'אנשי קשר',             i:'<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'},
  {id:'inherit', t:'הורשה לילדים',         i:'<path d="M12 22V12"/><path d="M12 12C12 7 8 5 4 5c0 4 3 7 8 7z"/><path d="M12 12c0-5 4-7 8-7 0 4-3 7-8 7z"/>'},
  {id:'pt',      t:'פורטוגל',              i:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'},
];

const S = {data:null, mode:null, password:null, dirty:false, tab:'total', years:{}, edit:false, charts:[], closed:{}};
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sum = a => a.reduce((x, y) => x + (+y || 0), 0);
const today = () => new Date().toISOString().slice(0, 10);
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem('ff.' + k)); } catch { return null; } },
  set(k, v){ try { localStorage.setItem('ff.' + k, JSON.stringify(v)); } catch {} },
};

/* ---------- formatting ---------- */
function money(n, opts={}){
  if (n == null || n === '' || isNaN(n)) return '<span class="num">—</span>';
  const cur = opts.cur ?? '₪';
  const neg = n < 0, a = Math.abs(n);
  let s;
  if (opts.short && a >= 1e6) s = (a/1e6).toLocaleString('he-IL', {maximumFractionDigits: 2}) + 'M';
  else if (opts.short && a >= 1e4) s = Math.round(a/1e3).toLocaleString('he-IL') + 'K';
  else s = Math.round(a).toLocaleString('he-IL');
  return `<span class="num" dir="ltr">${neg ? '-' : ''}${cur}${s}</span>`;
}
const plain = (n, cur='₪') => (n < 0 ? '-' : '') + cur + Math.round(Math.abs(n)).toLocaleString('he-IL');
const pct = n => isFinite(n) ? `<span class="num" dir="ltr">${(n*100).toFixed(1)}%</span>` : '—';
function cell(n, cls=''){ return `<td class="n ${cls} ${!n ? 'zero' : ''}">${n ? money(n) : '–'}</td>`; }

/* ---------- crypto (AES-256-GCM, PBKDF2-SHA256) ---------- */
const b64e = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const b64d = s => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
async function deriveKey(pw, salt, iter){
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', hash:'SHA-256', salt, iterations:iter}, base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
async function decryptPayload(p, pw){
  const key = await deriveKey(pw, b64d(p.salt), p.iter);
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:b64d(p.iv)}, key, b64d(p.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function encryptPayload(obj, pw){
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 250000;
  const key = await deriveKey(pw, salt, iter);
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(obj)));
  return {v:1, kdf:'PBKDF2-SHA256', iter, salt:b64e(salt), iv:b64e(iv), ct:b64e(ct)};
}

/* ---------- GitHub sync ---------- */
const ghCfg = () => store.get('github');
async function ghRequest(method, body){
  const g = ghCfg();
  const url = `https://api.github.com/repos/${g.owner}/${g.repo}/contents/${g.path || 'data/data.enc.json'}` + (method === 'GET' ? `?ref=${g.branch || 'main'}` : '');
  const r = await fetch(url, {method, headers:{Authorization:`Bearer ${g.token}`, Accept:'application/vnd.github+json'}, body: body ? JSON.stringify(body) : undefined, cache:'no-store'});
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}
async function loadEncrypted(){
  const g = ghCfg();
  if (g && g.token) {
    try { const f = await ghRequest('GET'); return JSON.parse(atob(f.content.replace(/\s/g, ''))); } catch (e) { console.warn('GitHub load failed, using site copy', e); }
  }
  const r = await fetch('data/data.enc.json', {cache:'no-store'});
  if (!r.ok) throw new Error('missing data file');
  return r.json();
}

/* ---------- data helpers ---------- */
function normalize(d){
  for (const a of d.assets) { if (a.currency === 'EUR_X4') a.currency = 'EUR'; delete a.fx; }
  d.expenseTotalsOverride ||= {};
  d.settings ||= {}; d.settings.people ||= {p1:'רונן', p2:'טל'};
  for (const c of d.risk?.coverage || []) if (c.people['אפיר']) { c.people['אופיר'] = c.people['אפיר']; delete c.people['אפיר']; }
  return d;
}
const D = () => S.data;
const yearsOf = obj => Object.keys(obj).sort();
function assetValue(a){
  if (a.currency && a.currency !== 'ILS' && a.foreign) return a.foreign * (a.fx || D().rates[a.currency.toLowerCase()] || 1);
  return +a.value || 0;
}
function liabValue(l){
  if (l.currency && l.currency !== 'ILS' && l.foreign) return l.foreign * (l.fx || D().rates[l.currency.toLowerCase()] || 1);
  return +l.value || 0;
}
const totals = () => {
  const assets = sum(D().assets.map(assetValue)), liabilities = sum(D().liabilities.map(liabValue));
  return {assets, liabilities, net: assets - liabilities};
};
function expYear(y){
  const groups = D().expenses[y] || [];
  const out = {groups:[], total:Array(12).fill(0), fixed:Array(12).fill(0), variable:Array(12).fill(0)};
  groups.forEach((g, gi) => {
    const m = Array(12).fill(0);
    g.items.forEach(it => it.months.forEach((v, i) => {
      m[i] += +v || 0;
      if (!g.exclude) { out.total[i] += +v || 0; (it.fixed ? out.fixed : out.variable)[i] += +v || 0; }
    }));
    out.groups.push({...g, gi, months:m, sum:sum(m)});
  });
  const ov = D().expenseTotalsOverride[y];
  if (ov) out.official = ov.map((v, i) => +v || out.total[i]);
  out.reported = out.official || out.total;
  return out;
}
function incYear(y){
  const rows = D().incomes[y] || [];
  const total = Array(12).fill(0);
  rows.forEach(r => r.months.forEach((v, i) => total[i] += +v || 0));
  return {rows, total};
}
function dataMonths(y){ // months that count for averages: months with income (or expenses), never in the future
  const inc = D().incomes[y] ? incYear(y).total : [];
  let m = activeMonths(inc);
  if (!m.length && D().expenses[y]) m = activeMonths(expYear(y).reported);
  const now = new Date();
  if (+y === now.getFullYear()) m = m.filter(i => i <= now.getMonth());
  return m;
}
function activeMonths(...arrs){ // months that have data in any series
  return [...Array(12).keys()].filter(i => arrs.some(a => (+a[i] || 0) !== 0));
}
function incomeGroup(name){
  if (/משכורת/.test(name)) return 'משכורות';
  if (/שכירות|ABNB|APR/i.test(name)) return 'שכירות';
  if (/קצב/.test(name)) return 'קצבאות';
  if (/החזר/.test(name)) return 'החזרים';
  return 'אחר';
}
function personSalary(p){ // series [{m:'2024-01', v}]
  const out = [];
  for (const y of yearsOf(D().incomes)) {
    const r = D().incomes[y].find(r => r.name.includes('משכורת') && r.name.includes(p));
    if (r) r.months.forEach((v, i) => { if (v) out.push({m:`${y}-${String(i+1).padStart(2,'0')}`, v}); });
  }
  return out;
}
function propertyKey(domain){
  const s = domain.replace(/\n/g, ' ').replace(/^הוצאות דירה\s*/, '').replace(/[\d:]+/g, ' ').trim();
  return s.split(/\s+/)[0];
}
function mortgageSeries(){
  const props = {}, loans = {};
  for (const y of yearsOf(D().expenses)) {
    for (const g of D().expenses[y]) {
      for (const it of g.items) {
        it.months.forEach((v, i) => {
          if (!v) return;
          const m = `${y}-${String(i+1).padStart(2,'0')}`;
          if (/^משכנתא/.test(it.name.trim())) {
            const k = propertyKey(g.domain);
            props[k] ||= {label: g.domain.replace(/\n/g,' ').replace(/^הוצאות דירה\s*/,'').replace(/[:\d]+\s*\d*$/,'').trim(), pts:{}};
            props[k].label = g.domain.replace(/\n/g,' ').replace(/^הוצאות דירה\s*/,'').replace(/\s*[\d:\s]+$/,'').trim() || props[k].label;
            props[k].pts[m] = (props[k].pts[m] || 0) + v;
          }
          if (/הלוו?אה|הלואה/.test(it.name)) loans[m] = (loans[m] || 0) + v;
        });
      }
    }
  }
  return {props, loans};
}

/* ---------- charts ---------- */
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
const PALETTE_L = ['#0d6b5f','#b8702a','#3c64b1','#8a4f9e','#c0453f','#2f8f8a','#a08a1c','#5d6f2e','#b25d86','#6b7a86'];
const PALETTE_D = ['#3db3a1','#e2a35c','#7a9be0','#c18bd6','#ef7067','#5fc6c0','#d5bd4a','#9cb25a','#e08bb3','#9aa8b3'];
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
const pal = i => (isDark() ? PALETTE_D : PALETTE_L)[i % 10];
function destroyCharts(){ S.charts.forEach(c => c.destroy()); S.charts = []; }
function chart(id, cfg){
  const el = document.getElementById(id); if (!el || !window.Chart) return;
  const ink = css('--muted'), grid = css('--line');
  Chart.defaults.font.family = css('--f-body') || 'Assistant';
  Chart.defaults.color = ink;
  const money_tick = v => Math.abs(v) >= 1e6 ? +(v/1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e4 ? Math.round(v/1e3) + 'K' : Math.abs(v) >= 1e3 ? +(v/1e3).toFixed(1) + 'K' : v;
  const base = {
    responsive:true, maintainAspectRatio:false, animation:{duration:250},
    interaction:{mode:'index', intersect:false},
    plugins:{
      legend:{rtl:true, textDirection:'rtl', position:'bottom', labels:{boxWidth:12, boxHeight:12, usePointStyle:false, padding:14}},
      tooltip:{rtl:true, textDirection:'rtl', callbacks:{label:c => ` ${c.dataset.label}: ${plain(c.parsed.y ?? c.parsed)}`}},
    },
  };
  if (cfg.type !== 'doughnut') base.scales = {
    x:{grid:{display:false}, ticks:{color:ink}, stacked:!!cfg.stacked, reverse:true},
    y:{grid:{color:grid}, border:{display:false}, ticks:{color:ink, callback:money_tick}, stacked:!!cfg.stacked, position:'right'},
  };
  if (cfg.type === 'doughnut') { base.plugins.legend.display = false; base.cutout = '62%'; base.plugins.tooltip.callbacks = {label:c => ` ${c.label}: ${plain(c.parsed)}`}; delete base.interaction; }
  const opts = deepMerge(base, cfg.options || {});
  S.charts.push(new Chart(el, {type:cfg.type, data:cfg.data, options:opts}));
}
function deepMerge(a, b){ for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] || {}, b[k]); else a[k] = b[k]; } return a; }

/* ---------- UI shell ---------- */
function toast(msg, ms=2600, undo){
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  if (undo) { const b = document.createElement('button'); b.className = 'undo'; b.type = 'button'; b.textContent = 'ביטול'; b.onclick = () => { undo(); t.hidden = true; }; t.appendChild(b); }
  clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, undo ? 6000 : ms);
}
function removeRow(arr, idx, label){
  const [row] = arr.splice(idx, 1); markDirty(); rerenderKeep();
  toast(`"${label}" הוסרה`, 0, () => { arr.splice(idx, 0, row); rerenderKeep(); });
}
function rerenderKeep(){ const y = window.scrollY; render(); window.scrollTo(0, y); }
function markDirty(){ if (S.mode === 'demo') { if (!S.demoWarned) { toast('מצב דמו: השינויים זמניים ולא נשמרים'); S.demoWarned = true; } return; } S.dirty = true; $('#savebar').hidden = false; }
function buildNav(){
  $('#nav').innerHTML = PAGES.map(p => `<button class="nav-btn" data-tab="${p.id}" type="button"><svg viewBox="0 0 24 24">${p.i}</svg>${p.t}</button>`).join('');
  $$('#nav .nav-btn').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; location.hash = S.tab; document.body.classList.remove('nav-open'); render(); });
}
function setYearSel(kind){
  const wrap = $('#yearWrap'), sel = $('#yearSel');
  if (!kind) { wrap.hidden = true; return; }
  const ys = kind === 'inc' ? yearsOf(D().incomes) : kind === 'exp' ? yearsOf(D().expenses) : [...new Set([...yearsOf(D().incomes), ...yearsOf(D().expenses)])].sort();
  const cur = S.years[kind] && ys.includes(S.years[kind]) ? S.years[kind] : (ys.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : ys[ys.length-1]);
  S.years[kind] = cur;
  sel.innerHTML = ys.slice().reverse().map(y => `<option ${y === cur ? 'selected' : ''}>${y}</option>`).join('');
  sel.onchange = () => { S.years[kind] = sel.value; render(); };
  wrap.hidden = false;
}
function render(){
  destroyCharts();
  const p = PAGES.find(p => p.id === S.tab) || PAGES[0];
  $$('#nav .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === p.id));
  $('#pageTitle').textContent = p.t;
  setYearSel(p.year);
  document.body.classList.toggle('edit-on', S.edit);
  $('#modePill').innerHTML = S.mode === 'demo' ? '<span class="pill demo">דמו · נתונים בדויים</span>' : '';
  $('#updatedLbl').textContent = 'עודכן: ' + (D().meta.updated || '');
  $('#familyLbl').textContent = D().settings.familyName || 'המשפחה שלנו';
  document.title = `${D().settings.familyName || 'המשפחה שלנו'} · ניתוח פיננסי`;
  const page = $('#page');
  page.innerHTML = VIEWS[p.id]();
  bindEditable(page);
  if (VIEWS[p.id].after) VIEWS[p.id].after();
  page.scrollTop = 0;
}

/* Editable inputs: data-path="a.b.0.c" data-kind="num|text|date" */
function getPath(path){ return path.split('.').reduce((o, k) => o?.[k], D()); }
function setPath(path, v){ const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => o[k], D()); o[last] = v; }
function inp(path, kind='num', cls=''){
  const v = getPath(path);
  return `<input class="cell ${cls}" data-path="${esc(path)}" data-kind="${kind}" ${kind === 'num' ? 'inputmode="decimal"' : ''} value="${esc(v ?? '')}">`;
}
function bindEditable(root){
  $$('input[data-path]', root).forEach(el => el.addEventListener('change', () => {
    let v = el.value.trim();
    if (el.dataset.kind === 'num') { v = v === '' ? 0 : +v.replace(/[,₪\s]/g, ''); if (isNaN(v)) { toast('יש להזין מספר'); return; } }
    setPath(el.dataset.path, v);
    if (el.dataset.touch) setPath(el.dataset.touch, new Date().toLocaleDateString('he-IL').replace(/\//g, '.'));
    markDirty();
    if (el.dataset.rerender !== 'no') { const y = window.scrollY; render(); window.scrollTo(0, y); }
  }));
}

/* ---------- views ---------- */
const VIEWS = {};

VIEWS.total = () => {
  const d = D(), t = totals();
  const hist = d.netWorthHistory, last = hist[hist.length-1];
  const delta = last ? t.net - last.net : 0;
  const byGroup = d.assetGroups.map(g => ({g, v: sum(d.assets.filter(a => a.group === g).map(assetValue))})).filter(x => x.v);
  const E = S.edit;
  return `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">שווי משפחתי נטו</span><span class="val">${money(t.net)}</span><span class="sub">${last ? `${delta >= 0 ? '▲' : '▼'} ${plain(Math.abs(delta))} מאז תמונת המצב של ${last.date}` : ''}</span></div>
    <div class="kpi"><span class="lbl">שווי משפחתי מלא (נכסים)</span><span class="val">${money(t.assets)}</span><span class="sub">${d.assets.length} נכסים</span></div>
    <div class="kpi"><span class="lbl">שווי התחייבויות כולל</span><span class="val down">${money(t.liabilities)}</span><span class="sub">${pct(t.liabilities / t.assets)} מהנכסים</span></div>
    <div class="kpi"><span class="lbl">שערי מטבע</span><span class="val" style="font-size:18px">$ ${d.rates.usd} · € ${d.rates.eur}</span><span class="sub">משמשים להמרת נכסים במט״ח (בהגדרות)</span></div>
  </div>
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>נכסים לפי סוג</h3></div>
      <div class="donut-row">
        <div class="chart short"><canvas id="cAssets"></canvas></div>
        <div class="legend-list">${byGroup.sort((a,b) => b.v - a.v).map((x, i) => `<div class="legend-row"><span class="sw" style="background:${pal(i)}"></span><span>${esc(x.g)}</span><span>${money(x.v, {short:true})}</span><span class="pct">${pct(x.v / t.assets)}</span></div>`).join('')}</div>
      </div>
    </section>
    <section class="card"><div class="card-h"><h3>התחייבויות</h3>${E ? '<button class="btn small" id="addLiab" type="button">+ התחייבות</button>' : ''}</div>
      <div class="tbl-wrap"><table><thead><tr><th>מקור התחייבות</th><th class="n">סכום</th><th class="n">מט״ח</th></tr></thead><tbody>
      ${d.liabilities.map((l, i) => `<tr><td>${E ? inp(`liabilities.${i}.name`, 'text', 'wide') : esc(l.name)}</td>
        <td class="n">${E && !l.foreign ? inp(`liabilities.${i}.value`) : money(liabValue(l))}</td>
        <td class="n">${l.foreign ? (E ? inp(`liabilities.${i}.foreign`) : money(l.foreign, {cur:l.currency === 'EUR' ? '€' : '$'})) : ''}</td></tr>`).join('')}
      <tr class="total"><td>סה״כ</td><td class="n">${money(t.liabilities)}</td><td></td></tr></tbody></table></div>
    </section>
  </div>
  <section class="card">
    <div class="card-h"><h3>פירוט נכסים</h3><span class="hint">${E ? 'עדכון ערך מעדכן אוטומטית את תאריך העדכון' : 'לחצו "עריכה" כדי לעדכן ערכים'}</span>
      ${E ? '<button class="btn small" id="addAsset" type="button">+ נכס</button>' : ''}
      <button class="btn small primary" id="snapBtn" type="button">שמירת תמונת מצב לגרף</button></div>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky-col">נכס</th><th>סוג</th><th class="n">שווי (₪)</th><th class="n">מט״ח</th><th class="n">סכום קנייה</th><th class="n">קצבה חודשית</th><th>כתובת</th><th>עדכון אחרון</th></tr></thead><tbody>
    ${d.assetGroups.map(g => {
      const rows = d.assets.map((a, i) => ({a, i})).filter(x => x.a.group === g);
      if (!rows.length) return '';
      return rows.map(({a, i}) => `<tr>
        <td class="sticky-col">${E ? inp(`assets.${i}.name`, 'text', 'wide') : esc(a.name)}</td>
        <td>${esc(g)}</td>
        <td class="n">${E && (!a.currency || a.currency === 'ILS') ? inp(`assets.${i}.value`).replace('<input', `<input data-touch="assets.${i}.updated"`) : money(assetValue(a))}</td>
        <td class="n">${a.currency && a.currency !== 'ILS' ? (E ? inp(`assets.${i}.foreign`).replace('<input', `<input data-touch="assets.${i}.updated"`) : money(a.foreign, {cur:a.currency === 'EUR' ? '€' : '$'})) + (a.fx ? ` <span class="chip var" title="שער ידני">×${a.fx}</span>` : '') : ''}</td>
        <td class="n">${a.buyPrice ? money(a.buyPrice) : ''}</td>
        <td class="n">${a.pension ? money(a.pension) : ''}</td>
        <td>${esc(a.address || '')}</td>
        <td>${esc(a.updated || '')}</td></tr>`).join('');
    }).join('')}
    <tr class="total"><td class="sticky-col">סה״כ נכסים</td><td></td><td class="n">${money(t.assets)}</td><td colspan="5"></td></tr>
    </tbody></table></div>
  </section>`;
};
VIEWS.total.after = () => {
  const d = D(), t = totals();
  const byGroup = d.assetGroups.map(g => ({g, v: sum(d.assets.filter(a => a.group === g).map(assetValue))})).filter(x => x.v).sort((a,b) => b.v - a.v);
  chart('cAssets', {type:'doughnut', data:{labels:byGroup.map(x => x.g), datasets:[{data:byGroup.map(x => x.v), backgroundColor:byGroup.map((_, i) => pal(i)), borderColor:css('--surface'), borderWidth:2}]}});
  $('#snapBtn').onclick = () => {
    const t = totals();
    const h = D().netWorthHistory, e = h.find(x => x.date === today());
    const row = {date:today(), assets:Math.round(t.assets), liabilities:Math.round(t.liabilities), net:Math.round(t.net)};
    if (e) Object.assign(e, row); else h.push(row);
    markDirty(); toast('תמונת המצב נוספה לגרף הצמיחה');
  };
  const aa = $('#addAsset'); if (aa) aa.onclick = () => { D().assets.push({name:'נכס חדש', group:D().assetGroups[0], value:0, currency:'ILS', updated:''}); markDirty(); render(); };
  const al = $('#addLiab'); if (al) al.onclick = () => { D().liabilities.push({name:'התחייבות חדשה', value:0}); markDirty(); render(); };
};

VIEWS.growth = () => {
  const h = D().netWorthHistory, t = totals();
  const first = h[0], last = h[h.length-1];
  const years = first ? (new Date(last.date) - new Date(first.date)) / 3.156e10 : 0;
  const cagr = first && years > 0.2 ? Math.pow(last.net / first.net, 1/years) - 1 : NaN;
  return `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">שווי נטו היום (מחושב)</span><span class="val">${money(t.net)}</span><span class="sub">לפי הערכים בעמוד מבט כולל</span></div>
    <div class="kpi"><span class="lbl">צמיחה מאז ${first?.date || ''}</span><span class="val ${last?.net >= first?.net ? 'up' : 'down'}">${first ? money(last.net - first.net) : '—'}</span><span class="sub">${first ? pct(last.net/first.net - 1) : ''}</span></div>
    <div class="kpi"><span class="lbl">קצב צמיחה שנתי</span><span class="val">${pct(cagr)}</span><span class="sub">לפי ${h.length} תמונות מצב</span></div>
    <div class="kpi"><span class="lbl">התחייבויות – שינוי</span><span class="val">${first ? money(last.liabilities - first.liabilities) : '—'}</span><span class="sub">מ־${first ? plain(first.liabilities) : ''}</span></div>
  </div>
  <section class="card"><div class="card-h"><h3>שווי משפחתי לאורך זמן</h3><span class="hint">נקודה חדשה נוספת בלחיצה על "שמירת תמונת מצב" בעמוד מבט כולל</span></div>
    <div class="chart tall"><canvas id="cGrowth"></canvas></div></section>
  <section class="card"><div class="card-h"><h3>תמונות מצב</h3></div>
    <div class="tbl-wrap"><table><thead><tr><th>תאריך</th><th class="n">נכסים</th><th class="n">התחייבויות</th><th class="n">נטו</th><th class="n">שינוי</th>${S.edit ? '<th></th>' : ''}</tr></thead><tbody>
    ${h.map((r, i) => `<tr><td>${r.date}</td><td class="n">${money(r.assets)}</td><td class="n">${money(r.liabilities)}</td><td class="n"><b>${money(r.net)}</b></td>
      <td class="n ${i && r.net >= h[i-1].net ? 'up' : 'down'}">${i ? money(r.net - h[i-1].net) : ''}</td>${S.edit ? `<td><button class="btn small danger" data-del="${i}" type="button">מחיקה</button></td>` : ''}</tr>`).reverse().join('')}
    </tbody></table></div></section>`;
};
VIEWS.growth.after = () => {
  const h = D().netWorthHistory;
  const lbl = h.map(r => new Date(r.date).toLocaleDateString('he-IL', {month:'short', year:'2-digit'}));
  chart('cGrowth', {type:'line', data:{labels:lbl, datasets:[
    {label:'שווי נטו', data:h.map(r => r.net), borderColor:pal(0), backgroundColor:pal(0) + '22', fill:true, tension:.25, borderWidth:2.5, pointRadius:3},
    {label:'נכסים', data:h.map(r => r.assets), borderColor:pal(2), tension:.25, borderWidth:1.5, pointRadius:2},
    {label:'התחייבויות', data:h.map(r => r.liabilities), borderColor:pal(4), tension:.25, borderWidth:1.5, pointRadius:2, borderDash:[4,4]},
  ]}});
  $$('[data-del]').forEach(b => b.onclick = () => { h.splice(+b.dataset.del, 1); markDirty(); render(); });
};

VIEWS.exp = () => {
  const y = S.years.exp, e = expYear(y), act = dataMonths(y);
  const n = act.length || 1, tot = sum(e.total);
  const actTot = sum(act.map(i => e.reported[i]));
  const lastM = act[act.length-1];
  const legacy = !!e.official;
  const top = e.groups.filter(g => !g.exclude).sort((a, b) => b.sum - a.sum);
  const E = S.edit;
  const rows = e.groups.map(g => {
    const closed = S.closed[y + g.gi] ?? true;
    return `<tr class="grp ${closed ? 'closed' : ''}" data-grp="${y + g.gi}"><td class="sticky-col"><span class="caret">◂</span>${esc(g.domain)}</td>${g.months.map(v => cell(v)).join('')}<td class="n">${money(g.sum)}</td></tr>` +
      (closed ? '' : g.items.map(it => {
        const ii = g.items.indexOf(it);
        const p = `expenses.${y}.${g.gi}.items.${ii}`;
        return `<tr><td class="sticky-col">${E ? `<button class="xbtn" data-delitem="${y}.${g.gi}.${ii}" title="הסרת השורה" aria-label="הסרת השורה" type="button">✕</button>` + inp(p + '.name', 'text', 'wide') : esc(it.name)}${legacy ? '' : `<button class="chip ${it.fixed ? 'fixed' : 'var'}" data-fix="${p}" title="${E ? 'לחיצה מחליפה קבועה/משתנה' : ''}" type="button">${it.fixed ? 'קבועה' : 'משתנה'}</button>`}</td>
          ${it.months.map((v, i) => E ? `<td class="n">${inp(p + '.months.' + i)}</td>` : cell(v)).join('')}<td class="n">${money(sum(it.months))}</td></tr>`;
      }).join('') + (E ? `<tr><td class="sticky-col"><button class="btn small" data-additem="${y}.${g.gi}" type="button">+ קטגוריה ב${esc(g.domain)}</button></td><td colspan="13"></td></tr>` : ''));
  }).join('');
  return `
  <div class="kpis">
    <div class="kpi"><span class="lbl">סה״כ הוצאות ${y}</span><span class="val">${money(sum(e.reported))}</span><span class="sub">${e.reported.some((v, i) => v && !act.includes(i)) ? 'כולל הוצאות מתוכננות לחודשים הבאים' : act.length + ' חודשים'}</span></div>
    <div class="kpi"><span class="lbl">ממוצע חודשי</span><span class="val">${money(actTot / n)}</span><span class="sub">ממוצע על ${act.length} חודשים (${act.length ? MS[act[0]] + '–' + MS[act[act.length-1]] : ''})</span></div>
    ${legacy ? '' : `<div class="kpi"><span class="lbl">הוצאות קבועות</span><span class="val">${money(sum(e.fixed))}</span><span class="sub">${pct(sum(e.fixed) / tot)} מסך ההוצאות</span></div>
    <div class="kpi"><span class="lbl">הוצאות משתנות</span><span class="val">${money(sum(e.variable))}</span><span class="sub">${pct(sum(e.variable) / tot)} מסך ההוצאות</span></div>`}
    ${lastM != null ? `<div class="kpi"><span class="lbl">${MONTHS[lastM]} – החודש האחרון</span><span class="val">${money(e.reported[lastM])}</span><span class="sub">${top[0] ? 'הכי גבוה: ' + esc(top[0].domain) : ''}</span></div>` : ''}
  </div>
  ${legacy ? `<p class="note"><b>נתונים היסטוריים (${y}):</b> בשנה זו הסיכומים החודשיים נלקחים מגיליון "הכנסות מול הוצאות" כפי שהיו באקסל. בפירוט לפי קטגוריות יש פערים בחלק מהחודשים, ותחומים שלא נכללו בסיכום מסומנים בהתאם.</p>` : ''}
  <div class="grid21">
    <section class="card"><div class="card-h"><h3>הוצאות לפי חודש ותחום</h3></div><div class="chart tall"><canvas id="cExpM"></canvas></div></section>
    <section class="card"><div class="card-h"><h3>חלוקה שנתית לפי תחום</h3></div>
      <div class="chart short"><canvas id="cExpD"></canvas></div>
      <div class="legend-list">${top.slice(0, 8).map((g, i) => `<div class="legend-row"><span class="sw" style="background:${pal(i)}"></span><span>${esc(g.domain)}</span><span>${money(g.sum, {short:true})}</span><span class="pct">${pct(g.sum / tot)}</span></div>`).join('')}</div>
    </section>
  </div>
  <section class="card">
    <div class="card-h"><h3>פירוט הוצאות ${y}</h3><span class="hint">לחיצה על תחום פותחת את הקטגוריות</span>
      <button class="btn small" id="openAll" type="button">פתיחת הכול</button><button class="btn small" id="closeAll" type="button">סגירת הכול</button></div>
    <div class="tbl-wrap" style="max-height:70vh"><table>
      <thead><tr><th class="sticky-col">תחום / קטגוריה</th>${MS.map(m => `<th class="n">${m}</th>`).join('')}<th class="n">סה״כ</th></tr></thead>
      <tbody>${rows}
        ${legacy ? '' : `<tr class="total"><td class="sticky-col">סה״כ הוצאות קבועות</td>${e.fixed.map(v => cell(v)).join('')}<td class="n">${money(sum(e.fixed))}</td></tr>
        <tr class="total"><td class="sticky-col">סה״כ הוצאות משתנות</td>${e.variable.map(v => cell(v)).join('')}<td class="n">${money(sum(e.variable))}</td></tr>`}
        <tr class="total"><td class="sticky-col">סה״כ הוצאות חודשיות</td>${e.reported.map(v => cell(v)).join('')}<td class="n">${money(sum(e.reported))}</td></tr>
      </tbody></table></div>
  </section>`;
};
VIEWS.exp.after = () => {
  const y = S.years.exp, e = expYear(y);
  const top = e.groups.filter(g => !g.exclude).sort((a, b) => b.sum - a.sum);
  const main = top.slice(0, 7), rest = top.slice(7);
  const ds = main.map((g, i) => ({label:g.domain, data:g.months, backgroundColor:pal(i), stack:'s'}));
  if (rest.length) ds.push({label:'אחר', data:MS.map((_, i) => sum(rest.map(g => g.months[i]))), backgroundColor:pal(9), stack:'s'});
  chart('cExpM', {type:'bar', stacked:true, data:{labels:MS, datasets:ds}});
  chart('cExpD', {type:'doughnut', data:{labels:top.map(g => g.domain), datasets:[{data:top.map(g => g.sum), backgroundColor:top.map((_, i) => i < 8 ? pal(i) : pal(9)), borderColor:css('--surface'), borderWidth:2}]}});
  $$('tr.grp').forEach(tr => tr.onclick = () => { S.closed[tr.dataset.grp] = !(S.closed[tr.dataset.grp] ?? true); const sy = window.scrollY; render(); window.scrollTo(0, sy); });
  $('#openAll').onclick = () => { e.groups.forEach(g => S.closed[y + g.gi] = false); render(); };
  $('#closeAll').onclick = () => { e.groups.forEach(g => S.closed[y + g.gi] = true); render(); };
  $$('[data-fix]').forEach(b => b.onclick = ev => { ev.stopPropagation(); if (!S.edit) { toast('יש להיכנס למצב עריכה כדי לשנות'); return; } const it = getPath(b.dataset.fix); it.fixed = !it.fixed; markDirty(); const sy = window.scrollY; render(); window.scrollTo(0, sy); });
  $$('[data-delitem]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const [yy, gi, ii] = b.dataset.delitem.split('.'); const arr = D().expenses[yy][gi].items; removeRow(arr, +ii, arr[+ii].name); });
  $$('[data-additem]').forEach(b => b.onclick = () => { const [yy, gi] = b.dataset.additem.split('.'); D().expenses[yy][gi].items.push({name:'קטגוריה חדשה', fixed:false, months:Array(12).fill(0)}); markDirty(); render(); });
};

VIEWS.inc = () => {
  const y = S.years.inc, inc = incYear(y), act = dataMonths(y), n = act.length || 1, tot = sum(inc.total);
  const groups = {};
  inc.rows.forEach(r => { const g = incomeGroup(r.name); groups[g] = (groups[g] || 0) + sum(r.months); });
  const E = S.edit;
  const p1 = D().settings.people.p1, p2 = D().settings.people.p2;
  const sal = name => sum((inc.rows.find(r => r.name.includes('משכורת') && r.name.includes(name)) || {months:[]}).months);
  return `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">סה״כ הכנסות ${y}</span><span class="val">${money(tot)}</span><span class="sub">${act.length} חודשים עם נתונים</span></div>
    <div class="kpi"><span class="lbl">ממוצע חודשי</span><span class="val">${money(tot / n)}</span><span class="sub">על פני חודשים עם נתונים</span></div>
    <div class="kpi"><span class="lbl">משכורת ${esc(p1)}</span><span class="val">${money(sal(p1))}</span><span class="sub">ממוצע ${plain(sal(p1) / n)} לחודש</span></div>
    <div class="kpi"><span class="lbl">משכורת ${esc(p2)}</span><span class="val">${money(sal(p2))}</span><span class="sub">ממוצע ${plain(sal(p2) / n)} לחודש</span></div>
    <div class="kpi"><span class="lbl">הכנסות משכירות</span><span class="val">${money(groups['שכירות'] || 0)}</span><span class="sub">${pct((groups['שכירות'] || 0) / tot)} מההכנסות</span></div>
  </div>
  <section class="card"><div class="card-h"><h3>הכנסות לפי חודש וסוג</h3></div><div class="chart tall"><canvas id="cInc"></canvas></div></section>
  <section class="card">
    <div class="card-h"><h3>פירוט הכנסות ${y}</h3>${E ? '<button class="btn small" id="addInc" type="button">+ מקור הכנסה</button>' : ''}</div>
    <div class="tbl-wrap"><table>
      <thead><tr><th class="sticky-col">מקור הכנסה</th>${MS.map(m => `<th class="n">${m}</th>`).join('')}<th class="n">סה״כ</th></tr></thead>
      <tbody>${inc.rows.map((r, ri) => `<tr><td class="sticky-col">${E ? `<button class="xbtn" data-delinc="${ri}" title="הסרת השורה" aria-label="הסרת השורה" type="button">✕</button>` + inp(`incomes.${y}.${ri}.name`, 'text', 'wide') : esc(r.name)}</td>${r.months.map((v, i) => E ? `<td class="n">${inp(`incomes.${y}.${ri}.months.${i}`)}</td>` : cell(v)).join('')}<td class="n">${money(sum(r.months))}</td></tr>`).join('')}
      <tr class="total"><td class="sticky-col">סה״כ</td>${inc.total.map(v => cell(v)).join('')}<td class="n">${money(tot)}</td></tr></tbody>
    </table></div>
  </section>`;
};
VIEWS.inc.after = () => {
  const y = S.years.inc, inc = incYear(y);
  const order = ['משכורות','שכירות','קצבאות','החזרים','אחר'];
  const ds = order.map((g, i) => ({label:g, data:MS.map((_, m) => sum(inc.rows.filter(r => incomeGroup(r.name) === g).map(r => +r.months[m] || 0))), backgroundColor:pal(i === 0 ? 0 : i === 1 ? 2 : i === 2 ? 3 : i === 3 ? 1 : 9)})).filter(d => sum(d.data));
  chart('cInc', {type:'bar', stacked:true, data:{labels:MS, datasets:ds}});
  $$('[data-delinc]').forEach(b => b.onclick = () => { const arr = D().incomes[y]; removeRow(arr, +b.dataset.delinc, arr[+b.dataset.delinc].name); });
  const a = $('#addInc'); if (a) a.onclick = () => { D().incomes[y].push({name:'מקור חדש', months:Array(12).fill(0)}); markDirty(); render(); };
};

function balanceYear(y){
  const inc = D().incomes[y] ? incYear(y).total : Array(12).fill(0);
  const exp = D().expenses[y] ? expYear(y).reported : Array(12).fill(0);
  return {inc, exp, free: inc.map((v, i) => v - exp[i])};
}
VIEWS.balance = () => {
  const y = S.years.bal, b = balanceYear(y);
  const act = dataMonths(y), n = act.length || 1;
  const I = sum(act.map(i => b.inc[i])), X = sum(act.map(i => b.exp[i]));
  const allYears = [...new Set([...yearsOf(D().incomes), ...yearsOf(D().expenses)])].sort();
  return `
  <div class="kpis">
    <div class="kpi"><span class="lbl">הכנסות ${y}</span><span class="val up">${money(I)}</span><span class="sub">ממוצע ${plain(I / n)} לחודש</span></div>
    <div class="kpi"><span class="lbl">הוצאות ${y}</span><span class="val down">${money(X)}</span><span class="sub">ממוצע ${plain(X / n)} לחודש</span></div>
    <div class="kpi hero"><span class="lbl">כסף פנוי</span><span class="val">${money(I - X)}</span><span class="sub">ממוצע ${plain((I - X) / n)} לחודש</span></div>
    <div class="kpi"><span class="lbl">שיעור חיסכון</span><span class="val">${pct((I - X) / I)}</span><span class="sub">מההכנסות נשאר בצד</span></div>
  </div>
  <p class="note">החישוב כולל רק חודשים שיש בהם הכנסות (${act.map(i => MS[i]).join(', ') || '—'}), כדי שחודשים עתידיים עם הוצאות קבועות מתוכננות לא יעוותו את התמונה.</p>
  <section class="card"><div class="card-h"><h3>הכנסות מול הוצאות – ${y}</h3></div><div class="chart tall"><canvas id="cBal"></canvas></div></section>
  <section class="card"><div class="card-h"><h3>פירוט חודשי</h3></div>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky-col"></th>${MS.map(m => `<th class="n">${m}</th>`).join('')}<th class="n">סה״כ שנתי</th><th class="n">ממוצע</th></tr></thead><tbody>
      <tr><td class="sticky-col">הכנסות</td>${b.inc.map(v => cell(v)).join('')}<td class="n">${money(sum(b.inc))}</td><td class="n">${money(sum(b.inc) / n)}</td></tr>
      <tr><td class="sticky-col">הוצאות</td>${b.exp.map(v => cell(v)).join('')}<td class="n">${money(sum(b.exp))}</td><td class="n">${money(X / n)}</td></tr>
      <tr class="total"><td class="sticky-col">כסף פנוי</td>${b.free.map((v, i) => `<td class="n ${v < 0 ? 'down' : ''}">${act.includes(i) ? money(v) : '–'}</td>`).join('')}<td class="n">${money(I - X)}</td><td class="n">${money((I - X) / n)}</td></tr>
      <tr class="pctrow"><td class="sticky-col">% הוצאות מההכנסות</td>${b.exp.map((v, i) => `<td class="n">${act.includes(i) && b.inc[i] ? pct(v / b.inc[i]) : '–'}</td>`).join('')}<td class="n">${pct(X / I)}</td><td class="n"></td></tr>
      <tr class="pctrow"><td class="sticky-col">% כסף פנוי מההכנסות</td>${b.free.map((v, i) => `<td class="n ${v < 0 ? 'down' : 'up'}">${act.includes(i) && b.inc[i] ? pct(v / b.inc[i]) : '–'}</td>`).join('')}<td class="n">${pct((I - X) / I)}</td><td class="n"></td></tr>
    </tbody></table></div></section>
  <section class="card"><div class="card-h"><h3>סיכום רב־שנתי</h3></div>
    <div class="tbl-wrap"><table><thead><tr><th>שנה</th><th class="n">הכנסות</th><th class="n">הוצאות</th><th class="n">כסף פנוי</th><th class="n">שיעור חיסכון</th><th class="n">חודשים</th></tr></thead><tbody>
    ${allYears.slice().reverse().map(yy => { const bb = balanceYear(yy), a = activeMonths(bb.inc).filter(i => bb.exp[i]); const ii = sum(a.map(i => bb.inc[i])), xx = sum(a.map(i => bb.exp[i]));
      return `<tr><td><b>${yy}</b></td><td class="n">${money(ii)}</td><td class="n">${money(xx)}</td><td class="n ${ii - xx < 0 ? 'down' : 'up'}">${money(ii - xx)}</td><td class="n">${pct((ii - xx) / ii)}</td><td class="n">${a.length}</td></tr>`; }).join('')}
    </tbody></table></div><p class="note" style="margin:0">בסיכום הרב־שנתי נספרים רק חודשים שיש בהם גם הכנסות וגם הוצאות.</p></section>`;
};
VIEWS.balance.after = () => {
  const y = S.years.bal, b = balanceYear(y);
  chart('cBal', {type:'bar', data:{labels:MS, datasets:[
    {label:'הכנסות', data:b.inc, backgroundColor:pal(0), order:2},
    {label:'הוצאות', data:b.exp, backgroundColor:pal(1), order:2},
    {type:'line', label:'כסף פנוי', data:b.free.map((v, i) => b.inc[i] ? v : null), borderColor:css('--ink'), backgroundColor:css('--ink'), tension:.25, pointRadius:3, order:1},
  ]}});
};

VIEWS.risk = () => {
  const r = D().risk, people = ['רונן','טל','מתן','אופיר','יובל'].map(p => mapName(p));
  const show = v => v == null ? '' : typeof v === 'number' ? money(v) : v === 'קיים' ? '<span class="chip yes">קיים</span>' : /לא קיים|אין/.test(v) ? `<span class="chip no">${esc(v)}</span>` : esc(v);
  const premTot = people.map(p => sum(r.coverage.map(c => typeof c.people[p]?.premium === 'number' ? c.people[p].premium : 0)));
  const sv = r.survivors;
  return `
  <div class="kpis">
    <div class="kpi"><span class="lbl">קצבת שארים – אם ${esc(people[0])} נפטר</span><span class="val">${money((sv.ifRonenDies.orphan || 0) + (sv.ifRonenDies.tal || 0))}</span><span class="sub">ל${esc(people[1])} ${plain(sv.ifRonenDies.tal || 0)} · ליתום ${plain(sv.ifRonenDies.orphan || 0)}</span></div>
    <div class="kpi"><span class="lbl">קצבת שארים – אם ${esc(people[1])} נפטרת</span><span class="val">${money((sv.ifTalDies.orphan || 0) + (sv.ifTalDies.ronen || 0))}</span><span class="sub">ל${esc(people[0])} ${plain(sv.ifTalDies.ronen || 0)} · ליתום ${plain(sv.ifTalDies.orphan || 0)}</span></div>
    <div class="kpi"><span class="lbl">פרמיות חודשיות (כל המשפחה)</span><span class="val">${money(sum(premTot))}</span><span class="sub">סכום עמודות הפרמיה בטבלה</span></div>
  </div>
  <section class="card"><div class="card-h"><h3>כיסויים לפי בן משפחה</h3><span class="hint">ערך הכיסוי, ומתחתיו הפרמיה החודשית</span></div>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky-col">כיסוי</th>${people.map(p => `<th class="n risk-person">${esc(p)}</th>`).join('')}</tr></thead><tbody>
    ${r.coverage.map(c => `<tr><td class="sticky-col">${esc(c.label)}</td>${people.map(p => { const x = c.people[p]; if (!x) return '<td class="n zero">–</td>';
        return `<td class="n">${show(x.value)}${x.premium != null && x.premium !== '' ? `<span class="prem">${typeof x.premium === 'number' ? (x.premium ? 'פרמיה ' + plain(x.premium) : 'ללא פרמיה') : esc(x.premium)}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}
    <tr class="total"><td class="sticky-col">סה״כ פרמיות חודשיות</td>${premTot.map(v => `<td class="n">${money(v)}</td>`).join('')}</tr>
    </tbody></table></div>
    <p class="note">בגיליון המקורי מופיעים גם אחוזי חלוקת קצבת שארים (40% ליתום, 60% לבן/בת הזוג). עריכה של טבלה זו תתווסף בשלב הבא – אפשר להגיד לי מה לעדכן.</p>
  </section>`;
};
function mapName(p){ // demo data renames people
  const m = {'רונן':D().settings.people.p1, 'טל':D().settings.people.p2};
  if (D().meta.demo) Object.assign(m, {'מתן':'עומר', 'אופיר':'איתי', 'יובל':'נועה'});
  return m[p] || p;
}

VIEWS.graphs = () => `
  <section class="card"><div class="card-h"><h3>משכורות – ${esc(D().settings.people.p1)} ו${esc(D().settings.people.p2)}</h3><span class="hint">נטו לפי דוחות הבנק, כולל חודשי מענקים</span></div><div class="chart tall"><canvas id="cSal"></canvas></div></section>
  <section class="card"><div class="card-h"><h3>החזרי משכנתא לפי נכס</h3><span class="hint">מחושב מהשורות "משכנתא" בגיליונות ההוצאות</span></div><div class="chart tall"><canvas id="cMort"></canvas></div></section>
  <section class="card"><div class="card-h"><h3>החזרי הלוואות</h3></div><div class="chart"><canvas id="cLoans"></canvas></div></section>`;
VIEWS.graphs.after = () => {
  const {p1, p2} = D().settings.people;
  const s1 = personSalary(p1), s2 = personSalary(p2);
  const months = [...new Set([...s1.map(x => x.m), ...s2.map(x => x.m)])].sort();
  const lbl = m => { const [y, mm] = m.split('-'); return `${MS[+mm-1]} ${y.slice(2)}`; };
  const ser = (s, ms) => ms.map(m => (s.find(x => x.m === m) || {}).v ?? null);
  chart('cSal', {type:'line', data:{labels:months.map(lbl), datasets:[
    {label:p1, data:ser(s1, months), borderColor:pal(0), backgroundColor:pal(0), tension:.2, pointRadius:2, spanGaps:true},
    {label:p2, data:ser(s2, months), borderColor:pal(1), backgroundColor:pal(1), tension:.2, pointRadius:2, spanGaps:true},
  ]}});
  const {props, loans} = mortgageSeries();
  const pm = [...new Set(Object.values(props).flatMap(p => Object.keys(p.pts)))].sort();
  chart('cMort', {type:'line', data:{labels:pm.map(lbl), datasets:Object.values(props).map((p, i) => ({label:p.label, data:pm.map(m => p.pts[m] ?? null), borderColor:pal(i + 2), backgroundColor:pal(i + 2), tension:.2, pointRadius:1.5, spanGaps:false}))}});
  const lm = Object.keys(loans).sort();
  chart('cLoans', {type:'bar', data:{labels:lm.map(lbl), datasets:[{label:'החזר הלוואות חודשי', data:lm.map(m => loans[m]), backgroundColor:pal(4)}]}});
};

const ICONS = {
  shield:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  piggy:'<path d="M19 11c0-3.3-3.1-6-7-6S5 7.7 5 11c0 1.8.9 3.4 2.3 4.5L7 19h3l.5-1.5h3L14 19h3l-.3-3.4A5.6 5.6 0 0 0 19 11z"/><path d="M19 10h2"/><circle cx="15" cy="10" r=".8"/><path d="M10 6.5h4"/>',
  chart:'<path d="M3 20h18"/><path d="M6 16l4-5 3 3 5-7"/><path d="M14 7h4v4"/>',
  house:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  person:'<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
};
function contactIcon(topic){
  const t = topic || '';
  if (/פורטוגל|חו"ל|ארה"?ב/.test(t) && /דיר|בתים|נדל/.test(t)) return ['globe', 'blue'];
  if (/ביטוח/.test(t)) return ['shield', ''];
  if (/פנסי|השתלמות|גמל/.test(t)) return ['piggy', 'gold'];
  if (/קרן|השקע|תיק/.test(t)) return ['chart', 'gold'];
  if (/בתים|דיר|נדל/.test(t)) return ['house', 'blue'];
  return ['person', ''];
}
VIEWS.contacts = () => {
  const c = D().contacts, E = S.edit;
  return `
  ${E ? '<div><button class="btn small" id="addContact" type="button">+ איש קשר</button></div>' : ''}
  <div class="contacts">${c.map((x, i) => E ? `<div class="contact">
      <label class="field">שם ${inp(`contacts.${i}.name`, 'text', 'inp')}</label>
      <label class="field">תחום אחריות ${inp(`contacts.${i}.topic`, 'text', 'inp')}</label>
      <label class="field">טלפון ${inp(`contacts.${i}.phone`, 'text', 'inp')}</label>
      <label class="field">עדכונים ${inp(`contacts.${i}.notes`, 'text', 'inp')}</label>
      <button class="btn small danger" data-delc="${i}" type="button">מחיקה</button></div>` :
    `<div class="contact">${(([ic, cl]) => `<span class="c-ico ${cl}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[ic]}</svg></span>`)(contactIcon(x.topic))}<b>${esc(x.name)}</b><div class="topic">${esc(x.topic)}</div>
      <div class="phone"><span class="num" dir="ltr" style="user-select:all">${esc(x.phone)}</span>
        <a class="btn small" href="tel:${esc(x.phone.replace(/[^\d+]/g, ''))}">חיוג</a>
        <a class="btn small" href="https://wa.me/${esc(x.phone.replace(/[^\d]/g, ''))}" target="_blank" rel="noopener">וואטסאפ</a>
        <button class="btn small" data-copy="${esc(x.phone)}" type="button">העתקה</button></div>
      ${x.notes ? `<div class="notes">${esc(x.notes)}</div>` : ''}</div>`).join('')}</div>`;
};
VIEWS.contacts.after = () => {
  $$('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('המספר הועתק'), () => toast('לא ניתן להעתיק – סמנו את המספר ידנית')));
  $$('[data-delc]').forEach(b => b.onclick = () => { D().contacts.splice(+b.dataset.delc, 1); markDirty(); render(); });
  const a = $('#addContact'); if (a) a.onclick = () => { D().contacts.push({name:'', topic:'', phone:'', notes:''}); markDirty(); render(); };
};

VIEWS.inherit = () => {
  const h = D().inheritance, g = h.growth, years = [];
  for (let y = h.baseYear; y <= h.endYear; y++) years.push(y);
  const proj = years.map(y => h.items.map(it => it.base * Math.pow(g, y - h.baseYear)));
  const last = proj[proj.length-1];
  return `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">שווי צפוי ב־${h.endYear}</span><span class="val">${money(sum(last))}</span><span class="sub">ב־${h.baseYear}: ${plain(sum(proj[0]))}</span></div>
    <div class="kpi"><span class="lbl">תשואה שנתית מונחת</span><span class="val">${pct(g - 1)}</span><span class="sub">ניתן לשינוי בהגדרות</span></div>
    <div class="kpi"><span class="lbl">מכפיל לאורך התקופה</span><span class="val">×${(sum(last) / sum(proj[0])).toFixed(2)}</span><span class="sub">${h.endYear - h.baseYear} שנים</span></div>
  </div>
  <section class="card"><div class="card-h"><h3>תחזית צבירה</h3><span class="hint">ערכי בסיס ${h.baseYear} כפי שהוזנו ידנית באקסל</span></div><div class="chart tall"><canvas id="cInh"></canvas></div></section>
  <section class="card"><div class="card-h"><h3>טבלת תחזית</h3></div>
    <div class="tbl-wrap" style="max-height:60vh"><table><thead><tr><th class="sticky-col">שנה</th>${h.items.map(it => `<th class="n">${esc(it.name)}</th>`).join('')}<th class="n">סה״כ</th></tr></thead><tbody>
    ${h.history.map(r => `<tr><td class="sticky-col">${r.year} <span class="chip var">בפועל</span></td>${r.values.map(v => cell(v)).join('')}<td class="n">${money(sum(r.values))}</td></tr>`).join('')}
    ${years.map((y, yi) => `<tr ${yi === 0 ? 'class="total"' : ''}><td class="sticky-col">${y}${yi === 0 ? ' <span class="chip fixed">בסיס</span>' : ''}</td>${proj[yi].map((v, ii) => yi === 0 && S.edit ? `<td class="n">${inp(`inheritance.items.${ii}.base`)}</td>` : cell(v)).join('')}<td class="n">${money(sum(proj[yi]))}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">התוכן של עמוד זה עוד ייבנה יחד. כרגע: ערך בסיס לכל רכיב כפול תשואה שנתית קבועה. בשורה 27 באקסל מופיעים מספרים (3.5, 2.1, 2.9, 1.4, 0.6, 0.29) שלא ברור למה הם מתייחסים.</p>
  </section>`;
};
VIEWS.inherit.after = () => {
  const h = D().inheritance, years = [];
  for (let y = h.baseYear; y <= h.endYear; y++) years.push(y);
  chart('cInh', {type:'line', stacked:true, data:{labels:years, datasets:h.items.map((it, i) => ({label:it.name, data:years.map(y => it.base * Math.pow(h.growth, y - h.baseYear)), borderColor:pal(i), backgroundColor:pal(i) + '55', fill:true, pointRadius:0, tension:.2}))}});
};

VIEWS.pt = () => {
  const p = D().portugal, E = S.edit, eur = D().rates.eur;
  const units = [...new Set(p.transfers.map(t => t.unit))];
  const byUnit = units.map(u => ({u, v:sum(p.transfers.filter(t => t.unit === u).map(t => t.amount))}));
  const tot = sum(byUnit.map(x => x.v));
  const ptAssets = D().assets.filter(a => /פורטוגל/.test(a.name));
  const ptLiab = D().liabilities.filter(l => /פורטו|ליסבון|סינטרה|גאיה/.test(l.name));
  const abnb = Object.entries(D().incomes).map(([y, rows]) => ({y, v:sum(rows.filter(r => /ABNB|APR/i.test(r.name)).flatMap(r => r.months))})).filter(x => x.v);
  return `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">סה״כ הועבר</span><span class="val">${money(tot, {cur:'€'})}</span><span class="sub">≈ ${plain(tot * eur)} לפי שער ${eur}</span></div>
    ${byUnit.map(x => `<div class="kpi"><span class="lbl">${esc(x.u)}</span><span class="val">${money(x.v, {cur:'€'})}</span><span class="sub">${p.transfers.filter(t => t.unit === x.u).length} העברות</span></div>`).join('')}
    ${ptAssets.map(a => `<div class="kpi"><span class="lbl">שווי ${esc(a.name.replace('פורטוגל - ', ''))}</span><span class="val">${money(assetValue(a))}</span><span class="sub">${a.foreign ? '€' + Math.round(a.foreign).toLocaleString('he-IL') : ''}</span></div>`).join('')}
    ${ptLiab.map(l => `<div class="kpi"><span class="lbl">${esc(l.name)}</span><span class="val down">${money(liabValue(l))}</span><span class="sub">${l.foreign ? '€' + Math.round(l.foreign).toLocaleString('he-IL') : ''}</span></div>`).join('')}
  </div>
  <section class="card"><div class="card-h"><h3>העברות כספים</h3>${E ? '<button class="btn small" id="addPt" type="button">+ העברה</button>' : ''}</div>
    <div class="tbl-wrap"><table><thead><tr><th>ייעוד</th><th class="n">סכום (€)</th><th>מטרה</th><th>תאריך העברה</th>${E ? '<th></th>' : ''}</tr></thead><tbody>
    ${p.transfers.map((t, i) => `<tr><td>${E ? inp(`portugal.transfers.${i}.unit`, 'text') : esc(t.unit)}</td><td class="n">${E ? inp(`portugal.transfers.${i}.amount`) : money(t.amount, {cur:'€'})}</td>
      <td>${E ? inp(`portugal.transfers.${i}.purpose`, 'text', 'wide') : esc(t.purpose)}</td><td>${E ? inp(`portugal.transfers.${i}.date`, 'text') : esc(t.date)}</td>${E ? `<td><button class="btn small danger" data-delpt="${i}" type="button">מחיקה</button></td>` : ''}</tr>`).join('')}
    <tr class="total"><td>סה״כ</td><td class="n">${money(tot, {cur:'€'})}</td><td colspan="${E ? 3 : 2}"></td></tr></tbody></table></div>
  </section>
  ${abnb.length ? `<section class="card"><div class="card-h"><h3>הכנסות השכרה (Airbnb)</h3></div><div class="tbl-wrap"><table><thead><tr><th>שנה</th><th class="n">הכנסה</th></tr></thead><tbody>${abnb.map(x => `<tr><td>${x.y}</td><td class="n">${money(x.v)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
};
VIEWS.pt.after = () => {
  $$('[data-delpt]').forEach(b => b.onclick = () => { D().portugal.transfers.splice(+b.dataset.delpt, 1); markDirty(); render(); });
  const a = $('#addPt'); if (a) a.onclick = () => { D().portugal.transfers.push({unit:'דירה1', amount:0, purpose:'', date:new Date().toLocaleDateString('he-IL').replace(/\//g, '.')}); markDirty(); render(); };
};

/* ---------- settings ---------- */
function openSettings(){
  const d = D(), g = ghCfg() || {}, demo = S.mode === 'demo';
  const latest = yearsOf(d.expenses).pop(), next = String(+latest + 1);
  $('#settingsPanel').innerHTML = `
    <div class="row"><h2 style="font-size:20px;margin-inline-end:auto">הגדרות</h2><button class="btn ghost" data-close type="button">סגירה ✕</button></div>
    ${demo ? '<p class="note"><b>מצב דמו.</b> אפשר לשחק ולשנות הכול – השינויים נשארים רק בדפדפן הזה עד היציאה, ולא נוגעים בנתונים האמיתיים של המשפחה.</p>' : ''}
    <section class="set-sec"><h3>שערי מטבע</h3><p>משמשים להמרת נכסים והתחייבויות במט״ח לשקלים.</p>
      <div class="row"><label class="field">דולר ($)<input class="inp" id="sUsd" inputmode="decimal" value="${d.rates.usd}"></label><label class="field">אירו (€)<input class="inp" id="sEur" inputmode="decimal" value="${d.rates.eur}"></label></div></section>
    <section class="set-sec"><h3>שם המשפחה</h3><p>מוצג בראש התפריט ובכותרת הדפדפן.</p>
      <label class="field">שם<input class="inp" id="sFam" value="${esc(d.settings.familyName || '')}"></label></section>
    <section class="set-sec"><h3>שמות בני הזוג</h3><p>משמשים לזיהוי שורות המשכורת בהכנסות ולגרפים.</p>
      <div class="row"><label class="field">בן/בת זוג 1<input class="inp" id="sP1" value="${esc(d.settings.people.p1)}"></label><label class="field">בן/בת זוג 2<input class="inp" id="sP2" value="${esc(d.settings.people.p2)}"></label></div></section>
    <section class="set-sec"><h3>הורשה לילדים</h3>
      <div class="row"><label class="field">תשואה שנתית (%)<input class="inp" id="sGrowth" inputmode="decimal" value="${((d.inheritance.growth - 1) * 100).toFixed(1)}"></label><label class="field">שנת סיום<input class="inp" id="sEnd" inputmode="numeric" value="${d.inheritance.endYear}"></label></div></section>
    <section class="set-sec"><h3>שנה חדשה</h3><p>יוצר את ${next} בהוצאות ובהכנסות עם אותן קטגוריות ואפסים בכל החודשים.</p>
      <div><button class="btn" id="sNewYear" type="button" ${d.expenses[next] ? 'disabled' : ''}>הוספת שנת ${next}</button></div></section>
    ${demo ? '' : `<section class="set-sec"><h3>סנכרון עם GitHub</h3>
      <p>הנתונים נשמרים מוצפנים בקובץ אחד במאגר. כדי לשמור ישירות מהדפדפן (גם מהטלפון), הזינו Personal Access Token עם הרשאת Contents: Read and write למאגר הזה בלבד. הפרטים נשמרים רק במכשיר הזה.</p>
      <div class="row"><label class="field">בעלים (owner)<input class="inp" id="gOwner" value="${esc(g.owner || '')}" dir="ltr"></label><label class="field">מאגר (repo)<input class="inp" id="gRepo" value="${esc(g.repo || '')}" dir="ltr"></label></div>
      <div class="row"><label class="field">ענף<input class="inp" id="gBranch" value="${esc(g.branch || 'main')}" dir="ltr"></label><label class="field">נתיב קובץ<input class="inp" id="gPath" value="${esc(g.path || 'data/data.enc.json')}" dir="ltr"></label></div>
      <label class="field">טוקן<input class="inp" id="gToken" type="password" value="${esc(g.token || '')}" dir="ltr" autocomplete="off"></label>
      <div class="row"><button class="btn" id="gSave" type="button">שמירת פרטי חיבור</button><button class="btn" id="gTest" type="button">בדיקת חיבור</button><span id="gStatus"></span></div></section>
    <section class="set-sec"><h3>שינוי סיסמה</h3><p>הסיסמה החדשה תחול מהשמירה הבאה. שמרו אותה במקום בטוח – בלעדיה אי אפשר לפתוח את הנתונים.</p>
      <div class="row"><label class="field">סיסמה חדשה<input class="inp" id="sPw1" type="password" autocomplete="new-password"></label><label class="field">אימות<input class="inp" id="sPw2" type="password" autocomplete="new-password"></label></div>
      <div><button class="btn" id="sPw" type="button">עדכון סיסמה</button></div></section>`}
    <section class="set-sec"><h3>גיבוי</h3><p>הורדת קובץ הנתונים המוצפן (לשמירה ידנית במאגר), או ייבוא קובץ נתונים.</p>
      <div class="row"><button class="btn" id="sDl" type="button" ${demo ? 'disabled' : ''}>הורדת קובץ מוצפן</button>
        <label class="btn">ייבוא JSON<input type="file" id="sImp" accept=".json,application/json" hidden></label></div></section>
    <section class="set-sec"><h3>מראה</h3><div class="row">
      <button class="btn small" data-theme-set="" type="button">לפי המכשיר</button><button class="btn small" data-theme-set="light" type="button">בהיר</button><button class="btn small" data-theme-set="dark" type="button">כהה</button></div></section>`;
  $('#settings').hidden = false;
  const num = (id, fallback) => { const v = +$(id).value; return isNaN(v) ? fallback : v; };
  const apply = () => {
    d.settings.familyName = $('#sFam').value.trim() || d.settings.familyName;
    d.rates.usd = num('#sUsd', d.rates.usd); d.rates.eur = num('#sEur', d.rates.eur);
    d.settings.people.p1 = $('#sP1').value.trim() || d.settings.people.p1; d.settings.people.p2 = $('#sP2').value.trim() || d.settings.people.p2;
    d.inheritance.growth = 1 + num('#sGrowth', (d.inheritance.growth - 1) * 100) / 100; d.inheritance.endYear = Math.max(d.inheritance.baseYear + 1, num('#sEnd', d.inheritance.endYear));
    markDirty(); render();
  };
  ['#sFam','#sUsd','#sEur','#sP1','#sP2','#sGrowth','#sEnd'].forEach(id => $(id).onchange = apply);
  $('#sNewYear').onclick = () => {
    d.expenses[next] = d.expenses[latest].map(gr => ({domain:gr.domain, items:gr.items.map(it => ({name:it.name, fixed:it.fixed, months:Array(12).fill(0)}))}));
    const li = yearsOf(d.incomes).pop(); d.incomes[next] = d.incomes[li].map(r => ({name:r.name, months:Array(12).fill(0)}));
    markDirty(); toast(`נוספה שנת ${next}`); openSettings(); render();
  };
  const readGh = () => ({owner:$('#gOwner').value.trim(), repo:$('#gRepo').value.trim(), branch:$('#gBranch').value.trim() || 'main', path:$('#gPath').value.trim() || 'data/data.enc.json', token:$('#gToken').value.trim()});
  if (!demo) {
  $('#gSave').onclick = () => { store.set('github', readGh()); toast('פרטי החיבור נשמרו במכשיר'); };
  $('#gTest').onclick = async () => { store.set('github', readGh()); const st = $('#gStatus'); st.innerHTML = '<span class="pill muted">בודק…</span>';
    try { await ghRequest('GET'); st.innerHTML = '<span class="pill ok">מחובר ✓</span>'; } catch (e) { st.innerHTML = `<span class="pill dirty">${esc(e.message)} – בדקו שם מאגר וטוקן</span>`; } };
  $('#sPw').onclick = () => { const a = $('#sPw1').value, b = $('#sPw2').value;
    if (a.length < 8) return toast('סיסמה צריכה להכיל לפחות 8 תווים'); if (a !== b) return toast('הסיסמאות אינן זהות');
    S.password = a; markDirty(); toast('הסיסמה תתעדכן בשמירה הבאה'); };
  }
  $('#sDl').onclick = async () => download(JSON.stringify(await encryptPayload(D(), S.password)), 'data.enc.json');
  $('#sImp').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { let j = JSON.parse(await f.text()); if (j.ct) j = await decryptPayload(j, S.password); if (!j.expenses || !j.incomes) throw 0; S.data = normalize(j); markDirty(); toast('הנתונים יובאו'); closeSettings(); render(); } catch { toast('הקובץ לא נקרא – ודאו שזה קובץ נתונים תקין עם אותה סיסמה'); } };
  $$('[data-theme-set]').forEach(b => b.onclick = () => { const t = b.dataset.themeSet; if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; store.set('theme', t); render(); });
  $$('#settings [data-close]').forEach(b => b.onclick = closeSettings);
}
function closeSettings(){ $('#settings').hidden = true; }
function download(text, name){
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type:'application/json'})); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast('הקובץ ירד. יש להעלות אותו למאגר בנתיב data/data.enc.json');
}

/* ---------- save ---------- */
async function save(){
  if (S.mode === 'demo') return toast('מצב דמו: השינויים לא נשמרים');
  const btn = $('#saveBtn'); btn.disabled = true; btn.textContent = 'שומר…';
  try {
    D().meta.updated = today();
    const payload = await encryptPayload(D(), S.password);
    const g = ghCfg();
    if (g && g.token) {
      let sha; try { sha = (await ghRequest('GET')).sha; } catch {}
      await ghRequest('PUT', {message:`עדכון נתונים ${today()}`, content:btoa(JSON.stringify(payload)), branch:g.branch || 'main', sha});
      toast('נשמר ב־GitHub ✓');
    } else {
      download(JSON.stringify(payload), 'data.enc.json');
    }
    S.dirty = false; $('#savebar').hidden = true; render();
  } catch (e) { toast('השמירה נכשלה: ' + e.message + '. בדקו את פרטי GitHub בהגדרות.', 5000); }
  btn.disabled = false; btn.textContent = 'שמירה';
}

/* ---------- login ---------- */
async function enter(mode, data, pw){
  S.mode = mode; S.data = normalize(data); S.password = pw;
  $('#login').hidden = true; $('#app').hidden = false;
  const h = location.hash.slice(1); if (PAGES.some(p => p.id === h)) S.tab = h;
  buildNav(); render();
}
async function doLogin(user, pw){
  const err = $('#loginErr'); err.textContent = '';
  if (user.trim().toLowerCase() === 'demo') {
    if (pw !== 'demo') { err.textContent = 'סיסמת הדמו היא demo'; return; }
    const r = await fetch('data/demo.json', {cache:'no-store'}); return enter('demo', await r.json(), null);
  }
  if (!window.crypto?.subtle) { err.textContent = 'הדפדפן לא תומך בפענוח. יש לפתוח את האתר בכתובת https.'; return; }
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = 'פותח…';
  try { const p = await loadEncrypted(); const d = await decryptPayload(p, pw); await enter('real', d, pw); }
  catch (e) { err.textContent = e.name === 'OperationError' ? 'סיסמה שגויה' : 'לא ניתן לטעון את הנתונים (' + e.message + ')'; }
  btn.disabled = false; btn.textContent = 'כניסה';
}

/* ---------- boot ---------- */
(function boot(){
  const th = store.get('theme'); if (th) document.documentElement.dataset.theme = th;
  $('#loginForm').onsubmit = e => { e.preventDefault(); doLogin($('#user').value, $('#pass').value); };
  $('#demoBtn').onclick = () => doLogin('demo', 'demo');
  if (location.hash === '#demo') { history.replaceState(null, '', location.pathname); doLogin('demo', 'demo'); }
  $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  $('#settingsBtn').onclick = () => { document.body.classList.remove('nav-open'); openSettings(); };
  $('#logoutBtn').onclick = () => { if (S.dirty && !$('#logoutBtn').dataset.sure) { $('#logoutBtn').dataset.sure = 1; toast('יש שינויים שלא נשמרו. לחיצה נוספת תצא בלי לשמור.', 4000); return; } location.hash = ''; location.reload(); };
  $('#editBtn').onclick = () => { S.edit = !S.edit; $('#editBtn').textContent = S.edit ? '✓ סיום עריכה' : '✎ עריכה'; render(); };
  $('#saveBtn').onclick = save;
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S.data && render());
})();
