'use strict';
/* עדכון נתונים – קליטת קבצי בנק, אשראי ופנסיה.
   Files are parsed in the browser (SheetJS); nothing leaves the device until the normal encrypted save.
   Every import is logged with its exact deltas so it can be undone. */

const IMP = {kind:null, file:null, rows:[], sheets:[], map:null, monthMode:'tx', onlyOpen:false, learn:true, pen:{}, penRows:[], pdfUrl:null, msg:'', card:'', pdfInfo:null};
const KIND_LBL = {bank:'בנק', card:'אשראי', pen:'פנסיה וקרנות'};
const CARD_RX = /ישראכרט|isracard|מקס איט|max it|\bmax\b|כאל|\bcal\b|לאומי קארד|אמריקן אקספרס|american express|דיינרס|diners|ויזה|visa|מסטרקארד|כרטיס(?:י)? אשראי/i;
const PEN_RX = /פנסי|השתלמות|גמל|קרנות|תיק/;

function impData(){ const d = D(); d.imports ||= {log:[], rules:[]}; d.imports.log ||= []; d.imports.rules ||= []; d.imports.pending ||= []; d.imports.cards ||= {}; return d.imports; }
const lastYearOf = o => yearsOf(o).pop();
const nowStamp = () => new Date().toLocaleDateString('he-IL').replace(/\//g, '.');
const normDesc = s => String(s ?? '').replace(/\d+/g, ' ').replace(/[*"'׳״]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const r2 = n => Math.round(n * 100) / 100;
const ymKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const fmtDate = d => d ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}` : '';
const oneLine = s => String(s).replace(/\n/g, ' ');

function catList(){ const y = lastYearOf(D().expenses); return (D().expenses[y] || []).flatMap(g => g.items.map(it => ({d:g.domain, i:it.name}))); }
function incList(){ const y = lastYearOf(D().incomes); return (D().incomes[y] || []).map(r => r.name); }

/* ---------- parsing ---------- */
async function readSheets(file){
  const buf = await file.arrayBuffer();
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4000));
  if (/<html|<table/i.test(head)) { // "xls" files that are really web pages (e.g. Leumi): read every table row
    const cs = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
    let txt; try { txt = new TextDecoder(cs).decode(buf); } catch { txt = new TextDecoder('utf-8').decode(buf); }
    const doc = new DOMParser().parseFromString(txt, 'text/html');
    const rows = [...doc.querySelectorAll('tr')].filter(tr => !tr.querySelector('tr'))
      .map(tr => [...tr.children].map(td => td.textContent.replace(/[\u200b-\u200f\u00a0]/g, ' ').replace(/\s+/g, ' ').trim()));
    return [{name:'דף', rows}];
  }
  const wb = XLSX.read(buf, {type:'array', cellDates:true, codepage:1255});
  return wb.SheetNames.map(n => ({name:n, rows:XLSX.utils.sheet_to_json(wb.Sheets[n], {header:1, raw:true, defval:''})}));
}
function toDate(v){
  if (v instanceof Date && !isNaN(v)) { const t = new Date(v.getTime() + 12 * 3600e3); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
  if (typeof v === 'number' && v > 20000 && v < 80000) { const t = new Date(Math.round((v - 25569) * 864e5)); return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const d = new Date(y, +m[2] - 1, +m[1]); return isNaN(d) ? null : d; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}
function toNum(v){
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[₪$€,\s\u200b-\u200f]|ש"ח|NIS|ILS/gi, '').trim();
  if (!s) return NaN;
  let neg = false;
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : (neg ? -Math.abs(n) : n);
}
const hdrOf = row => row.map(c => String(c ?? '').replace(/\s+/g, ' ').trim());
function findCol(hdr, pats){ for (const p of pats) { const i = hdr.findIndex(h => p.test(h)); if (i >= 0) return i; } return -1; }
function detect(rows){
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const hdr = hdrOf(rows[r]);
    if (!hdr.some(h => /תאריך/.test(h))) continue;
    const debit = findCol(hdr, [/^חובה/, /חובה/]), credit = findCol(hdr, [/^זכות/, /זכות/]);
    const amount = findCol(hdr, [/סכום חיוב/, /סכום לחיוב/, /^סכום$/, /סכום ב?ש/, /סכום(?! עסקה מקורי)/, /סכום/]);
    if (amount < 0 && debit < 0 && credit < 0) continue;
    const date = findCol(hdr, [/תאריך עסקה/, /תאריך רכישה/, /^תאריך$/, /תאריך(?! ערך)(?! חיוב)/, /תאריך/]);
    const charge = findCol(hdr, [/תאריך חיוב/]);
    const desc = findCol(hdr, [/שם בית ה?עסק/, /בית ה?עסק/, /תיאור/, /תאור/, /הפעולה/, /פרטים/, /אסמכתא/]);
    const useDC = debit >= 0 || credit >= 0;
    return {hr:r, hdr, date, charge, desc, amount: useDC ? -1 : amount, debit, credit};
  }
  return null;
}
function extract(sheet, map, kind){
  const out = [];
  if (!map) return out;
  for (let r = map.hr + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const date = toDate(row[map.date]);
    if (!date) continue;
    let amt;
    if (map.amount >= 0) { const v = toNum(row[map.amount]); if (isNaN(v)) continue; amt = kind === 'bank' ? -v : v; }
    else { const db = toNum(row[map.debit]), cr = toNum(row[map.credit]); amt = (isNaN(db) ? 0 : Math.abs(db)) - (isNaN(cr) ? 0 : Math.abs(cr)); }
    if (!amt) continue;
    const charge = map.charge >= 0 ? toDate(row[map.charge]) : null;
    out.push({date, charge, desc:String(row[map.desc] ?? '').replace(/\s+/g, ' ').trim() || '(ללא תיאור)', amt:r2(amt), sheet:sheet.name});
  }
  return out;
}

/* ---------- card statements in PDF (e.g. Leumi "פרוט עסקאות לכרטיס") ----------
   pdf.js returns Hebrew lines right-to-left, so a number comes back as reversed pieces: "10" "." "194" → 194.10 */
function pdfSegs(tokens){
  // group neighbouring tokens into number runs and text runs
  const runs = [];
  for (const t0 of tokens) {
    const t = t0.replace(/[​-‏]/g, ''); if (!t.trim()) continue;
    const k = /^[\d.,\/\-]+$/.test(t) ? 'n' : 't', last = runs[runs.length - 1];
    if (last && last.k === k) last.v.push(t); else runs.push({k, v:[t]});
  }
  // punctuation with no digits between two texts ("COM" "." "TEMU") belongs to the text
  for (let i = runs.length - 2; i > 0; i--) if (runs[i].k === 'n' && !runs[i].v.some(x => /\d/.test(x)) && runs[i - 1].k === 't' && runs[i + 1].k === 't') { runs[i - 1].v.push(...runs[i].v, ...runs[i + 1].v); runs.splice(i, 2); }
  return runs.map(r => {
    if (r.k === 'n') { const n = r.v.slice().reverse().join(''); return /\d/.test(n) ? {n} : null; }
    const latin = !r.v.some(x => /[֐-׿]/.test(x));       // English names also come back reversed
    return {t:(latin ? r.v.slice().reverse().join('') : r.v.join(' ')).replace(/\s+/g, ' ').trim()};
  }).filter(Boolean);
}
function parseCardPdf(lines){
  const res = {items:[], card:'', period:null, total:null};
  for (const tk of lines) {
    const sg = pdfSegs(tk), txt = tk.join(' ');
    if (/לכרטיס|פרוט עסקאות/.test(txt)) { const n = sg.filter(x => x.n).pop(); if (n && /^\d{4}$/.test(n.n)) res.card = n.n; }
    if (/לתקופה/.test(txt)) { const mi = MONTHS.findIndex(m => txt.includes(m)), y = (sg.find(x => x.n && /^\d{4}$/.test(x.n)) || {}).n; if (mi >= 0 && y) res.period = new Date(+y, mi, 1); continue; }
    if (/^סה"?כ/.test((tk[0] || '').trim())) { const n = sg.find(x => x.n); if (n) res.total = toNum(n.n); continue; }
    if (!sg.length || !sg[0].n) continue;
    const date = toDate(sg[0].n); if (!date) continue;
    const nums = sg.slice(1).filter(x => x.n), texts = sg.filter(x => x.t);
    if (!nums.length || !texts.length) continue;
    const amt = toNum(nums[nums.length - 1].n); // "סכום חיוב" – the last amount in the row
    if (isNaN(amt) || !amt) continue;          // 0 = e.g. card fee that was waived
    res.items.push({date, charge:res.period, desc:texts[0].t.replace(/\s+/g, ' '), amt:r2(amt), sheet:'PDF', card:res.card});
  }
  return res;
}

/* ---------- classification ---------- */
// a rule learned on a specific card (r.c) wins there and is not applied to other cards (e.g. "סופר" → סופר טל only on Tal's card)
// rules with a reference amount (r.a) tell apart charges with the same name (e.g. 3 policies of one insurer): the closest amount wins
function ruleFor(desc, card, amt){
  const n = normDesc(desc); let best = null, score = -1, gap = Infinity;
  for (const r of impData().rules) {
    if (!r.m || !n.includes(r.m) || (r.c && r.c !== card)) continue;
    const sc = r.m.length + (r.c ? 1000 : 0), g = r.a != null && amt != null ? Math.abs(r.a - amt) : Infinity;
    if (sc > score || (sc === score && g < gap)) { best = r; score = sc; gap = g; }
  }
  return best;
}
function ruleToValue(r){
  if (!r) return '';
  if (r.v.t === 's') return 'skip';
  if (r.v.t === 'e') { const k = IMP.cats.findIndex(c => c.d === r.v.d && c.i === r.v.i); return k >= 0 ? 'e:' + k : ''; }
  if (r.v.t === 'i') { const k = IMP.incs.indexOf(r.v.n); return k >= 0 ? 'i:' + k : ''; }
  return '';
}
function seenHashes(){ const s = new Set(); for (const l of impData().log) for (const h of l.hashes || []) s.add(h); for (const q of impData().pending) s.add(q.h); return s; }
function buildRows(kind, items){
  IMP.cats = catList(); IMP.incs = incList();
  const seen = seenHashes(), cnt = {};
  return items.map(it => {
    const base = `${kind}|${ymKey(it.date)}-${it.date.getDate()}|${normDesc(it.desc)}|${it.amt}`;
    cnt[base] = (cnt[base] || 0) + 1;
    const h = base + '|' + cnt[base];
    const row = {...it, h, dup:seen.has(h), v:'', why:''};
    const rule = ruleFor(it.desc, it.card, it.amt);
    if (row.dup) { row.v = 'skip'; row.why = impData().pending.some(q => q.h === h) ? 'ממתין לתשובה' : 'נקלט בעבר'; }
    else if (rule) { row.v = ruleToValue(rule); row.why = row.v ? 'לפי כלל' : ''; }
    else if (kind === 'bank' && it.amt > 0 && CARD_RX.test(it.desc)) { row.v = 'skip'; row.why = 'חיוב כרטיס – מפורט בקובץ האשראי'; }
    return row;
  });
}
function rowMonth(r){
  if (IMP.monthMode === 'charge' && r.charge) return {y:String(r.charge.getFullYear()), m:r.charge.getMonth()};
  if (/^\d{4}-\d{2}$/.test(IMP.monthMode)) { const [y, m] = IMP.monthMode.split('-'); return {y, m:+m - 1}; }
  return {y:String(r.date.getFullYear()), m:r.date.getMonth()};
}

/* ---------- writing into the data ---------- */
function ensureYear(y){
  const d = D();
  if (!d.expenses[y]) { const ly = lastYearOf(d.expenses); d.expenses[y] = d.expenses[ly].map(g => ({domain:g.domain, items:g.items.map(it => ({name:it.name, fixed:it.fixed, months:Array(12).fill(0)}))})); }
  if (!d.incomes[y]) { const ly = lastYearOf(d.incomes); d.incomes[y] = d.incomes[ly].map(r => ({name:r.name, months:Array(12).fill(0)})); }
}
function ensureItem(y, dom, name){
  ensureYear(y);
  const ys = D().expenses[y];
  let g = ys.find(g => g.domain === dom); if (!g) { g = {domain:dom, items:[]}; ys.push(g); }
  let it = g.items.find(i => i.name === name); if (!it) { it = {name, fixed:false, months:Array(12).fill(0)}; g.items.push(it); }
  return it;
}
function ensureInc(y, name){
  ensureYear(y);
  const ys = D().incomes[y];
  let r = ys.find(r => r.name === name); if (!r) { r = {name, months:Array(12).fill(0)}; ys.push(r); }
  return r;
}
function applyDelta(x, sign){
  if (x.t === 'e') { const it = ensureItem(x.y, x.d, x.i); it.months[x.m] = r2((+it.months[x.m] || 0) + sign * x.v); }
  else if (x.t === 'i') { const r = ensureInc(x.y, x.n); r.months[x.m] = r2((+r.months[x.m] || 0) + sign * x.v); }
}
function learnRule(desc, v, card){
  const m = normDesc(desc); if (m.length < 2) return;
  const rules = impData().rules, i = rules.findIndex(r => r.m === m && (r.c || '') === (card || '') && r.a == null);
  if (i >= 0) rules[i].v = v; else rules.push(card ? {m, v, c:card} : {m, v});
}
// amounts already in a month that did not come from an earlier import are usually the plan (copied forward).
// before adding, ask whether the file's amount replaces that plan or comes on top of it.
const cellKey = x => x.t === 'e' ? `e|${x.y}|${x.m}|${x.d}|${x.i}` : `i|${x.y}|${x.m}|${x.n}`;
function cellNow(x){
  if (x.t === 'e') { const it = (D().expenses[x.y] || []).find(g => g.domain === x.d)?.items.find(i => i.name === x.i); return {v:+(it?.months[x.m]) || 0, fixed:!!it?.fixed}; }
  const r = (D().incomes[x.y] || []).find(r => r.name === x.n); return {v:+(r?.months[x.m]) || 0, fixed:true};
}
function plannedCells(xs){
  const imported = {}; for (const l of impData().log) for (const d of l.deltas || []) imported[cellKey(d)] = (imported[cellKey(d)] || 0) + d.v;
  const cells = {}; for (const x of xs) (cells[cellKey(x)] ||= {x, add:0}).add += x.v;
  return Object.entries(cells).map(([k, c]) => { const now = cellNow(c.x), planned = r2(now.v - (imported[k] || 0)); return {k, x:c.x, add:r2(c.add), planned, mode:now.fixed ? 'replace' : 'add'}; })
    .filter(c => Math.abs(c.planned) > 0.005);
}
function txDeltas(){ // what the classified rows would add, before writing anything
  const xs = [];
  for (const r of IMP.rows) {
    if (!r.v || r.v === 'skip' || r.v === 'later') continue;
    const {y, m} = rowMonth(r);
    if (r.v.startsWith('e:')) { const c = IMP.cats[+r.v.slice(2)]; xs.push({t:'e', y, d:c.d, i:c.i, m, v:r.amt}); }
    else if (r.v.startsWith('i:')) xs.push({t:'i', y, n:IMP.incs[+r.v.slice(2)], m, v:-r.amt});
  }
  return xs;
}
function confirmHtml(kind){
  if (!IMP.confirm) return '';
  const lbl = x => x.t === 'e' ? `${oneLine(x.d)} ← ${x.i}` : 'הכנסה: ' + x.n;
  return `<section class="card ask" id="confirmBox"><div class="card-h"><h3>יש כבר סכום בחודשים האלה</h3><span class="hint">הסכום הקיים לא הגיע מקליטה קודמת – לרוב זה התכנון שהועתק מחודש קודם. מה לעשות עם הסכום מהקובץ?</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>חודש</th><th>קטגוריה</th><th class="n">רשום עכשיו</th><th class="n">מהקובץ</th><th>מה לעשות</th></tr></thead><tbody>
    ${IMP.confirm.map((c, i) => `<tr><td>${MS[c.x.m]} ${String(c.x.y).slice(2)}</td><td>${esc(lbl(c.x))}</td><td class="n">${money(c.planned)}</td><td class="n">${money(c.add)}</td>
      <td><select class="inp" style="padding:5px 8px" data-cmode="${i}"><option value="replace" ${c.mode === 'replace' ? 'selected' : ''}>להחליף (הקיים הוא תכנון) → ${plain(c.add)}</option><option value="add" ${c.mode === 'add' ? 'selected' : ''}>להוסיף (הוצאה נוספת) → ${plain(r2(c.planned + c.add))}</option></select></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row"><button class="btn primary" id="confirmGo" type="button">אישור וקליטה</button><button class="btn ghost" id="confirmBack" type="button">חזרה לסיווג</button></div></section>`;
}
function commitTx(){
  if (!IMP.confirm) { const pc = plannedCells(txDeltas()); if (pc.length) { IMP.confirm = pc; keepScroll(); setTimeout(() => $('#confirmBox')?.scrollIntoView({behavior:'smooth', block:'start'}), 60); return; } }
  const ip = impData(), deltas = [], hashes = [], later = [], id = Date.now();
  let total = 0;
  for (const r of IMP.rows) {
    if (!r.v) continue;
    if (r.v === 'later') { if (!r.dup) later.push(r); continue; }
    if (r.v === 'skip') { if (!r.dup) { hashes.push(r.h); if (IMP.learn && r.why !== 'חיוב כרטיס – מפורט בקובץ האשראי' && r.why !== 'לפי כלל' && r.touched) learnRule(r.desc, {t:'s'}, r.card); } continue; }
    const {y, m} = rowMonth(r);
    if (r.v.startsWith('e:')) {
      const c = IMP.cats[+r.v.slice(2)];
      const x = {t:'e', y, d:c.d, i:c.i, m, v:r.amt}; applyDelta(x, 1); deltas.push(x); total += r.amt;
      if (IMP.learn && r.touched) learnRule(r.desc, {t:'e', d:c.d, i:c.i}, r.card);
    } else if (r.v.startsWith('i:')) {
      const n = IMP.incs[+r.v.slice(2)];
      const x = {t:'i', y, n, m, v:-r.amt}; applyDelta(x, 1); deltas.push(x);
      if (IMP.learn && r.touched) learnRule(r.desc, {t:'i', n}, r.card);
    }
    hashes.push(r.h);
  }
  for (const c of IMP.confirm || []) if (c.mode === 'replace') { const x = {...c.x, v:-c.planned, plan:true}; applyDelta(x, 1); deltas.push(x); total -= x.t === 'e' ? c.planned : 0; }
  IMP.confirm = null;
  if (!deltas.length && !hashes.length && !later.length) return toast('אין שורות מסווגות לקליטה');
  for (const r of later) { const {y, m} = rowMonth(r); ip.pending.push({id:id + '-' + ip.pending.length, imp:id, kind:IMP.kind, file:IMP.file, desc:r.desc, amt:r.amt, date:ymKey(r.date) + '-' + String(r.date.getDate()).padStart(2, '0'), y, m, h:r.h, card:r.card || ''}); }
  ip.log.unshift({id, kind:IMP.kind, file:IMP.file, date:today(), n:deltas.length, total:r2(total), deltas, hashes});
  markDirty();
  toast(`נקלטו ${deltas.length} תנועות${later.length ? ` · ${later.length} נשמרו כשאלות פתוחות` : ''}. לחצו "שמירה" כדי לשמור.`, 4500);
  resetImp(); render();
}
function undoImport(id){
  const ip = impData(), i = ip.log.findIndex(l => l.id === id); if (i < 0) return;
  const l = ip.log[i];
  if (l.kind === 'pen') {
    for (const x of l.changes) {
      if (x.liab) { const b = D().liabilities.find(b => b.name === x.liab); if (b) Object.assign(b, x.prev); continue; }
      if (x.snap) { const h = D().netWorthHistory, i = h.findIndex(r => r.date === x.snap); if (i >= 0) { if (x.prev) h[i] = x.prev; else h.splice(i, 1); } continue; }
      if (x.report) { const r = D().pensionReport ||= {people:{}}; r.people ||= {}; if (x.prev) r.people[x.report] = x.prev; else delete r.people[x.report]; if (x.meta) Object.assign(r, x.meta); continue; }
      const a = D().assets.find(a => a.name === x.name); if (a) Object.assign(a, x.prev);
    }
  }
  else for (const x of l.deltas || []) applyDelta(x, -1);
  ip.pending = ip.pending.filter(q => q.imp !== l.id); // its open questions go too
  ip.log.splice(i, 1); markDirty(); toast('הקליטה בוטלה'); render();
}
function resetImp(){ if (IMP.pdfUrl) URL.revokeObjectURL(IMP.pdfUrl); Object.assign(IMP, {file:null, rows:[], sheets:[], map:null, monthMode:'tx', onlyOpen:false, pen:{}, penRows:[], pdfUrl:null, msg:'', card:'', pdfInfo:null, confirm:null}); }

/* ---------- file handling ---------- */
// one line per file: month, card, how many transactions, and whether the sum matches the statement's own total
function fileInfo(name, items, period, card, stated){
  const tot = r2(sum(items.map(i => i.amt))), ok = stated == null || Math.abs(tot - stated) < 0.02;
  return {t:`${period ? MONTHS[period.getMonth()] + ' ' + period.getFullYear() : name}${card ? ' · כרטיס ' + card : ''}: ${items.length} תנועות, ${plain(tot)}${stated == null ? '' : ok ? ' ✓ תואם לסה״כ בדוח' : ` ⚠ בדוח כתוב ${plain(stated)}`}`, bad:!ok};
}
async function readOne(f, kind, single){ // → {items, info}
  if (/\.pdf$/i.test(f.name)) {
    if (kind !== 'card') return {items:[], info:{t:`${f.name}: קובץ PDF של בנק לא נקרא כאן – הורידו אקסל או CSV`, bad:true}};
    const r = parseCardPdf(await pdfLines(f));
    if (!r.items.length) return {items:[], info:{t:`${f.name}: לא זוהו עסקאות`, bad:true}};
    return {items:r.items, info:fileInfo(f.name, r.items, r.period, r.card, r.total)};
  }
  if (!window.XLSX) return {items:[], info:{t:`${f.name}: רכיב קריאת האקסל לא נטען – רעננו את הדף`, bad:true}};
  const sheets = await readSheets(f);
  let items = [];
  for (const sh of sheets) { sh.map = detect(sh.rows); items = items.concat(extract(sh, sh.map, kind)); }
  if (single) { IMP.sheets = sheets; IMP.map = sheets.find(s => s.map) || sheets[0]; if (!sheets.some(s => s.map)) sheets.forEach(s => s.map = guessManual(s.rows)); }
  if (!items.length) return {items, info:{t:`${f.name}: לא זוהתה טבלת תנועות${single ? ' – בחרו למטה את שורת הכותרות ואת העמודות' : ' – העלו אותו לבד כדי למפות עמודות'}`, bad:true}};
  let card = '', per = null, stated = null;
  if (kind === 'card') { // card number, statement month and total (Leumi / Diners style files)
    const all = sheets.flatMap(sh => sh.rows.map(r => r.map(c => String(c ?? '')).join(' ')));
    const top = all.slice(0, 20).join(' ');
    const cm = top.match(/לכרטיס[^\d]{0,40}?(\d{4})(?!\d)/), pm = top.match(/לתקופה:?\s*(\S+)\s+(\d{4})/);
    if (cm) { card = cm[1]; items.forEach(i => i.card = card); }
    per = pm && MONTHS.indexOf(pm[1]) >= 0 ? new Date(+pm[2], MONTHS.indexOf(pm[1]), 1) : null;
    if (per) items.forEach(i => { if (!i.charge) i.charge = per; });
    const totRow = all.filter(t => /סה"?כ/.test(t)).pop(), tm = totRow && totRow.match(/סה"?כ:?\s*(-?[\d,]+\.\d\d)/);
    stated = tm ? toNum(tm[1]) : null;
  }
  return {items, info:fileInfo(f.name, items, per, card, stated)};
}
// any number of files at once (PDF, xlsx, xls, csv – also mixed, also several cards)
async function onTxFile(input, kind){
  const seen = new Set(), files = Array.from(input.length != null ? input : [input]).filter(f => { const k = f.name + '|' + f.size; if (seen.has(k)) return false; seen.add(k); return true; });
  resetImp(); IMP.kind = kind; IMP.file = files.map(f => f.name).join(', ');
  IMP.msg = files.length > 1 ? `קורא ${files.length} קבצים…` : ''; render();
  let items = []; const info = [];
  for (const f of files) {
    try { const r = await readOne(f, kind, files.length === 1); items = items.concat(r.items); info.push(r.info); }
    catch (e) { console.error(e); info.push({t:`${f.name}: לא הצלחתי לקרוא (${e.message})`, bad:true}); }
  }
  IMP.pdfInfo = info;
  items.sort((a, b) => a.date - b.date);
  IMP.rows = buildRows(kind, items);
  IMP.msg = items.length ? '' : 'לא זוהו תנועות בקבצים.';
  render();
}
function guessManual(rows){ // first row with >=3 non-empty cells
  const hr = Math.max(0, rows.findIndex(r => r.filter(c => String(c).trim()).length >= 3));
  return {hr, hdr:hdrOf(rows[hr] || []), date:0, charge:-1, desc:1, amount:2, debit:-1, credit:-1, manual:true};
}
function reExtract(){
  const sh = IMP.map; sh.map.hdr = hdrOf(sh.rows[sh.map.hr] || []);
  IMP.rows = buildRows(IMP.kind, extract(sh, sh.map, IMP.kind));
  IMP.msg = IMP.rows.length ? '' : 'עדיין לא נמצאו תנועות עם המיפוי הזה.';
  render();
}

/* ---------- asking: suggestions and questions ---------- */
// keyword hints: [what the business name looks like, which category names fit, prefer the card owner's own row]
const HINTS = [
  [/סופר.?פארם|בית מרקחת|\bbe\b|גוד פארם/i, /פארם/],
  [/סופר|שופרסל|רמי לוי|יוחננוף|ויקטורי|טיב טעם|קואופ|מגה|אושר עד|חצי חינם|משק |מכולת|מינימרקט|ירקות|פירות|עמיר שיווק|נתיב החסד|קשת טעמים|יוניברס/i, /^סופר(?! פארם)/, true],
  [/מאפ|פינקיצ'?ן|ללא גלוטן|לחם |בייקרי/i, /מאפי/, true],
  [/(ביטוח|בטוח) חיים/i, /ביטוח חיים/, false, 'amount'],
  [/ביטוח|בטוח|הראל|הפניקס|מגדל|כלל |איילון|מנורה/i, /ביטוח/, false, 'amount'],
  [/hotel|radisson|gasthof|hostel|motel|airbnb|booking\.com|\bb\. ?w\./i, /מלונות/],
  [/caf[eé]|restaurant|burger|gastro|cuis|beer|\bbar\b|pizz|kuchel|bistro|grill|sushi|trattoria|brasserie/i, /מסעדות בחול/],
  [/billa|hofer|spar\b|lidl|rewe|aldi|carrefour|tesco|mercadona|pingo|continente|monoprix/i, /הוצאות חו"ל/],
  [/oebb|ticket|train|metro|uber|bolt|taxi|airport|ryanair|wizz|easyjet|lufthansa/i, /טיסות|הוצאות חו"ל/],
  [/עמלת עסקאות מט"?ח|עמלת המרה|הנחה בעמלת/i, /הוצאות חו"ל/],
  [/temu|ali.?express|shein/i, /TEMO|ALI/i],
  [/amazon/i, /AMAZON/i], [/iherb/i, /iherb/i], [/ksp/i, /KSP/i], [/דקטלון|decathlon/i, /דקאטלון/],
  [/מסעד|קפה|ארומה|קפיט|פיצ|בורגר|סושי|יאמי|שווארמ|פלאפל|גלידה|wolt|וולט|תן ביס|מאפ|בייקרי/i, /^מסעדות ויציאות|^קפה|מסעדות/],
  [/ד"?ר |מרפא|קליניק|אסותא|רופא|שיניים|פיזיו|אופטי|רפוא/i, /^טיפולים|^רפואה/, true, 'בריאות'],
  [/חניון|חניה|פנגו|סלופארק|cello/i, /חני/], [/דלק|סונול|דור אלון|\bten\b|yellow|פז /i, /דלק|תחבורה/],
  [/גן |חינוך|בית ספר|מתנ"?ס|חוג/i, /^גן|^חוג|^לימודים/],
  [/איקאה|ikea|הום סנטר|ace|מקס סטוק|max stock|מקס ראשון|ביג |שקם/i, /כל מיני/],
  [/ספר|סטימצקי|צעצוע|toys|משחק/i, /ספרים|משחקים/],
  [/כושר|פיטנס|fitness|סטודיו/i, /כושר|אימונים/, true, 'ספורט'],
];
// how far an amount is from what a category usually costs (its latest non-zero month)
function amtGap(c, amt){
  const y = lastYearOf(D().expenses), it = (D().expenses[y] || []).find(g => g.domain === c.d)?.items.find(i => i.name === c.i);
  const ref = it ? [...it.months].reverse().find(v => +v > 0) : 0;
  return ref ? Math.abs(ref - amt) / Math.max(ref, Math.abs(amt)) : 9;
}
function cardOwner(card){ const o = card && impData().cards[card]; return o ? (D().settings.people || {})[o] || '' : ''; }
function suggestFor(r){
  const out = [], add = v => { if (v && v !== 'skip' && !out.includes(v)) out.push(v); };
  const n = normDesc(r.desc);
  for (const ru of impData().rules) if (ru.m && n.includes(ru.m)) add(ruleToValue(ru)); // learned on another card
  const owner = cardOwner(r.card), others = Object.values(D().settings.people || {}).filter(x => x && x !== owner);
  for (const [rx, cat, own] of HINTS) {
    if (!rx.test(r.desc)) continue;
    let ks = IMP.cats.map((c, k) => ({c, k})).filter(x => cat.test(x.c.i));
    if (HINTS.find(h => h[0] === rx)[3] === 'amount') ks.sort((a, b) => amtGap(a.c, r.amt) - amtGap(b.c, r.amt)); // insurance: the row whose usual amount is closest
    if (own && owner) {
      const mine = ks.filter(x => x.c.i.includes(owner));
      if (mine.length) ks = mine;
      else { // e.g. only "טיפולים רונן" exists → offer a new "טיפולים טל" row in the same section
        const other = ks.find(x => others.some(o => x.c.i.includes(o)));
        if (other) { const o = others.find(o => other.c.i.includes(o)); add('n:' + other.c.d + '|' + other.c.i.replace(o, owner)); }
        ks = ks.filter(x => !others.some(o => x.c.i.includes(o)));
      }
    }
    ks.slice(0, 3).forEach(x => add('e:' + x.k));
  }
  if (!out.length) { // words of the business name that appear in a category name
    const words = r.desc.split(/[\s\-–.,"']+/).filter(w => w.length >= 3 && !/בע"?מ|ראשון|ציונה/.test(w));
    IMP.cats.forEach((c, k) => { const cw = c.i.split(/[\s\-–\/(),"']+/); if (words.some(w => cw.includes(w))) add('e:' + k); });
  }
  return out.slice(0, 3);
}
const valLabel = v => v === 'skip' ? 'לא לקלוט' : v.startsWith('e:') ? IMP.cats[+v.slice(2)]?.i : v.startsWith('i:') ? 'הכנסה: ' + IMP.incs[+v.slice(2)] : v.startsWith('n:') ? '＋ ' + v.slice(2).split('|')[1] + ' (שורה חדשה)' : '';
// a new expense row: create it (in every year that has the section) and refresh the category list without breaking existing choices
function addCategory(dom, name){
  const keep = r => r.v && r.v.startsWith('e:') ? IMP.cats[+r.v.slice(2)] : null;
  const memo = IMP.rows.map(keep);
  ensureItem(lastYearOf(D().expenses), dom, name); markDirty();
  IMP.cats = catList();
  IMP.rows.forEach((r, i) => { const c = memo[i]; if (c) r.v = 'e:' + IMP.cats.findIndex(x => x.d === c.d && x.i === c.i); });
  return 'e:' + IMP.cats.findIndex(x => x.d === dom && x.i === name);
}
// one question per business: all rows with the same name are answered together
function questionGroups(rows){
  const g = new Map();
  rows.forEach(r => { const k = normDesc(r.desc) + '|' + (r.card || '') + (/ביטוח|בטוח/.test(r.desc) ? '|' + r.amt : ''); /* several policies of one insurer = several questions */ if (!g.has(k)) g.set(k, {desc:r.desc, card:r.card, rows:[]}); g.get(k).rows.push(r); });
  return [...g.values()];
}
function questionHtml(q, idx, kind, src){
  const tot = sum(q.rows.map(r => r.amt)), sug = suggestFor(q.rows[0]);
  const ds = [...new Set(q.rows.map(r => fmtDate(r.date instanceof Date ? r.date : new Date(r.date))))], dates = ds.slice(0, 3).join(', ') + (ds.length > 3 ? '…' : '');
  return `<div class="q">
    <div class="q-h"><b>${esc(q.desc)}</b><span class="hint">${q.rows.length > 1 ? q.rows.length + ' עסקאות · ' : ''}${money(kind === 'bank' && tot < 0 ? -tot : tot)}${tot < 0 ? (kind === 'bank' ? ' (זכות)' : ' (זיכוי)') : ''} · ${dates}${q.card ? ' · כרטיס ' + esc(q.card) : ''}</span></div>
    <div class="q-opts">${sug.length ? '<span class="hint">אולי:</span>' : ''}${sug.map(v => `<button class="btn small q-sug" type="button" data-q="${src}:${idx}" data-v="${v}">${esc(valLabel(v))}</button>`).join('')}
      <select class="inp q-sel" data-qsel="${src}:${idx}">${catOptions({v:'', amt:tot}, kind).replace('— לבחירה —', sug.length ? 'משהו אחר…' : 'לאן לשייך?')}</select>
      <button class="btn small ghost" type="button" data-qnew="${src}:${idx}">＋ שורה חדשה</button>
      ${src === 'now' ? `<button class="btn small ghost" type="button" data-q="${src}:${idx}" data-v="later" title="לקלוט את השאר ולשמור את השאלה הזאת לאחר כך">אחר כך</button>` : ''}</div>
    ${IMP.newFor === src + ':' + idx ? `<div class="q-opts"><select class="inp q-sel" id="qnDom">${[...new Set(IMP.cats.map(c => c.d))].map(d => `<option>${esc(d)}</option>`).join('')}</select><input class="inp" id="qnName" placeholder="שם השורה, למשל: טיפולים ${esc(cardOwner(q.card) || '')}" style="width:auto;min-width:200px"><button class="btn small primary" type="button" id="qnAdd" data-qkey="${src}:${idx}">הוספה ושיוך</button></div>` : ''}
  </div>`;
}
function ownerQuestionHtml(){
  const cards = [...new Set(IMP.rows.map(r => r.card).filter(Boolean))].filter(c => !impData().cards[c]);
  const pp = D().settings.people || {};
  return cards.map(c => `<div class="q"><div class="q-h"><b>של מי כרטיס ${esc(c)}?</b><span class="hint">כדי שסופר, טיפולים וכו׳ ישויכו לשורה של בעל הכרטיס</span></div>
    <div class="q-opts">${Object.entries(pp).map(([k, n]) => `<button class="btn small" type="button" data-owner="${k}" data-card="${esc(c)}">${esc(n)}</button>`).join('')}<button class="btn small ghost" type="button" data-owner="shared" data-card="${esc(c)}">משותף</button></div></div>`).join('');
}
function askHtml(kind){
  const open = IMP.rows.filter(r => !r.v && !r.dup);
  IMP.qs = questionGroups(open);
  const own = ownerQuestionHtml();
  if (!IMP.qs.length && !own) return '';
  return `<section class="card ask"><div class="card-h"><h3>יש לי ${IMP.qs.length + (own.match(/class="q"/g) || []).length} שאלות</h3><span class="hint">לא ידעתי לאן לשייך. תשובה אחת חלה על כל העסקאות מאותו בית עסק ונשמרת ככלל לפעם הבאה. ״אחר כך״ – קולטים את השאר והשאלה נשמרת.</span></div>
    ${own}${IMP.qs.map((q, i) => questionHtml(q, i, kind, 'now')).join('')}</section>`;
}
function pendingOf(kind){ return impData().pending.filter(q => q.kind === kind); }
function pendingHtml(kind){
  const list = pendingOf(kind); if (!list.length) return '';
  if (!(IMP.kind === kind && IMP.file && IMP.cats)) { IMP.cats = catList(); IMP.incs = incList(); }
  IMP.pq = questionGroups(list.map(q => ({...q, date:new Date(q.date)})));
  return `<section class="card ask"><div class="card-h"><h3>שאלות פתוחות מקליטות קודמות (${IMP.pq.length})</h3><span class="hint">הסכום יתווסף לחודש של העסקה ברגע שתענו</span></div>
    ${IMP.pq.map((q, i) => questionHtml(q, i, kind, 'old')).join('')}</section>`;
}
function answerPending(q, v){
  const ip = impData(), deltas = [], hashes = []; let total = 0;
  for (const p of q.rows) {
    hashes.push(p.h);
    if (v.startsWith('e:')) { const c = IMP.cats[+v.slice(2)]; const x = {t:'e', y:p.y, d:c.d, i:c.i, m:p.m, v:p.amt}; applyDelta(x, 1); deltas.push(x); total += p.amt; }
    else if (v.startsWith('i:')) { const x = {t:'i', y:p.y, n:IMP.incs[+v.slice(2)], m:p.m, v:-p.amt}; applyDelta(x, 1); deltas.push(x); }
  }
  const ids = new Set(q.rows.map(p => p.id));
  ip.pending = ip.pending.filter(p => !ids.has(p.id));
  ip.log.unshift({id:Date.now(), kind:q.rows[0].kind, file:'תשובה: ' + q.desc, date:today(), n:deltas.length, total:r2(total), deltas, hashes});
  learnRule(q.desc, v === 'skip' ? {t:'s'} : v.startsWith('e:') ? {t:'e', d:IMP.cats[+v.slice(2)].d, i:IMP.cats[+v.slice(2)].i} : {t:'i', n:IMP.incs[+v.slice(2)]}, q.card);
  markDirty(); toast(v === 'skip' ? 'סומן כ״לא לקלוט״' : `נוסף ל״${valLabel(v)}״. לחצו "שמירה" כדי לשמור.`, 3500); keepScroll();
}
function bindAsk(){
  const answer = (key, v) => {
    if (!v) return;
    if (v.startsWith('n:')) { const [dom, name] = v.slice(2).split('|'); v = addCategory(dom, name); IMP.newFor = null; }
    const [src, i] = key.split(':'), q = (src === 'now' ? IMP.qs : IMP.pq)[+i]; if (!q) return;
    if (src === 'old') return answerPending(q, v);
    IMP.confirm = null;
    q.rows.forEach(r => { r.v = v; r.touched = v !== 'later'; r.why = v === 'later' ? 'אחר כך' : 'תשובה'; });
    keepScroll();
  };
  $$('[data-q]').forEach(b => b.onclick = () => answer(b.dataset.q, b.dataset.v));
  $$('[data-qsel]').forEach(s => s.onchange = () => answer(s.dataset.qsel, s.value));
  $$('[data-qnew]').forEach(b => b.onclick = () => { IMP.newFor = IMP.newFor === b.dataset.qnew ? null : b.dataset.qnew; keepScroll(); setTimeout(() => $('#qnName')?.focus(), 50); });
  const qa = $('#qnAdd'); if (qa) qa.onclick = () => { const name = $('#qnName').value.trim(); if (!name) return $('#qnName').focus(); answer(qa.dataset.qkey, 'n:' + $('#qnDom').value + '|' + name); };
  $$('[data-owner]').forEach(b => b.onclick = () => {
    impData().cards[b.dataset.card] = b.dataset.owner; markDirty(); keepScroll(); // suggestions now prefer the owner's rows
  });
}
function navBadges(){
  if (!S.data) return;
  for (const [tab, kind] of [['upCard', 'card'], ['upBank', 'bank']]) {
    const b = $(`#nav .nav-btn[data-tab="${tab}"]`); if (!b) continue;
    const n = questionGroups(pendingOf(kind)).length; let s = b.querySelector('.nav-badge');
    if (!n) { s?.remove(); continue; }
    if (!s) { s = document.createElement('span'); s.className = 'nav-badge'; b.appendChild(s); }
    s.textContent = n; s.title = n + ' שאלות פתוחות';
  }
}

/* ---------- views: bank / card ---------- */
const UP_ICON = '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>';
function howTo(kind){
  if (kind === 'bank') return `<details class="note"><summary><b>איך מורידים את הקובץ מהבנק?</b></summary>
    <p>נכנסים לאתר הבנק ← <b>עובר ושב</b> ← <b>תנועות בחשבון</b> ← בוחרים טווח תאריכים ← <b>ייצוא לאקסל</b>. רוב הבנקים (לאומי, הפועלים, דיסקונט, מזרחי, הבינלאומי) מאפשרים xls או CSV, ושני הפורמטים עובדים כאן.</p>
    <p>חיובי כרטיסי אשראי בעו״ש מסומנים אוטומטית כ״דילוג״, כי הפירוט שלהם נקלט מקובץ האשראי. כך אותה הוצאה לא נספרת פעמיים.</p></details>`;
  return `<details class="note"><summary><b>איך מורידים את הקובץ מחברת האשראי?</b></summary>
    <p><b>ישראכרט / אמריקן אקספרס:</b> האזור האישי ← פירוט עסקאות ← ייצוא לאקסל.<br><b>מקס:</b> האזור האישי ← פירוט החיובים ← הורדה לאקסל.<br><b>כאל:</b> האזור האישי ← פירוט עסקאות ← ייצוא.<br><b>כרטיס לאומי (דרך אתר הבנק):</b> כרטיסי אשראי ← פירוט עסקאות ← שמירה/הדפסה כ־PDF. אפשר לבחור כמה קבצים (חודשים) יחד.</p>
    <p>הסכום שנקלט הוא <b>סכום החיוב</b> בשקלים. כדי שהחודש יתאים לדף החיוב ולא לתאריך הרכישה, בוחרים ״לפי תאריך החיוב״ או חודש ספציפי.</p></details>`;
}
function catOptions(r, kind){
  const groups = {};
  IMP.cats.forEach((c, k) => (groups[c.d] ||= []).push(`<option value="e:${k}" ${r.v === 'e:' + k ? 'selected' : ''}>${esc(c.i)}</option>`));
  const exp = Object.entries(groups).map(([d, o]) => `<optgroup label="${esc(oneLine(d))}">${o.join('')}</optgroup>`).join('');
  const inc = `<optgroup label="הכנסות">${IMP.incs.map((n, k) => `<option value="i:${k}" ${r.v === 'i:' + k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`;
  const incFirst = kind === 'bank' && r.amt < 0;
  return `<option value="" ${!r.v ? 'selected' : ''}>— לבחירה —</option><option value="skip" ${r.v === 'skip' ? 'selected' : ''}>דילוג (לא לקלוט)</option>${r.v === 'later' ? '<option value="later" selected>לשאול אותי אחר כך</option>' : ''}${incFirst ? inc + exp : exp + (kind === 'bank' ? inc : '')}`;
}
function monthOptions(){
  const opts = [`<option value="tx" ${IMP.monthMode === 'tx' ? 'selected' : ''}>לפי תאריך העסקה</option>`];
  if (IMP.rows.some(r => r.charge)) opts.push(`<option value="charge" ${IMP.monthMode === 'charge' ? 'selected' : ''}>לפי תאריך החיוב</option>`);
  const now = new Date();
  for (let k = 0; k < 15; k++) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1), v = ymKey(d); opts.push(`<option value="${v}" ${IMP.monthMode === v ? 'selected' : ''}>הכל לחודש ${MONTHS[d.getMonth()]} ${d.getFullYear()}</option>`); }
  return opts.join('');
}
function mapperHtml(){
  const sh = IMP.map; if (!sh || !sh.map) return '';
  const m = sh.map, hdr = hdrOf(sh.rows[m.hr] || []);
  const sel = (key, allowNone) => `<select class="inp" data-map="${key}">${allowNone ? `<option value="-1" ${m[key] < 0 ? 'selected' : ''}>—</option>` : ''}${hdr.map((h, i) => `<option value="${i}" ${m[key] === i ? 'selected' : ''}>${esc(h || 'עמודה ' + (i + 1))}</option>`).join('')}</select>`;
  return `<details class="card" ${IMP.rows.length ? '' : 'open'}><summary><b>מיפוי עמודות</b> <span class="hint">(${esc(sh.name)}) – לשנות רק אם הזיהוי האוטומטי שגוי</span></summary>
    <div class="row" style="margin-top:10px">
      ${IMP.sheets.length > 1 ? `<label class="field">גיליון<select class="inp" id="mapSheet">${IMP.sheets.map((s, i) => `<option value="${i}" ${s === sh ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      <label class="field">שורת כותרות<input class="inp" id="mapHr" inputmode="numeric" value="${m.hr + 1}"></label>
      <label class="field">תאריך${sel('date')}</label>
      <label class="field">תיאור${sel('desc')}</label>
      <label class="field">סכום${sel('amount', true)}</label>
      <label class="field">חובה${sel('debit', true)}</label>
      <label class="field">זכות${sel('credit', true)}</label>
      <label class="field">תאריך חיוב${sel('charge', true)}</label>
    </div><p class="hint" style="margin:6px 0 0">בבנק: עמודת ״סכום״ אחת עם מינוס להוצאה, או עמודות ״חובה״ ו״זכות״ נפרדות.</p></details>`;
}
function logHtml(kinds){
  const log = impData().log.filter(l => kinds.includes(l.kind)).slice(0, 12);
  if (!log.length) return '';
  return `<section class="card"><div class="card-h"><h3>קליטות אחרונות</h3><span class="hint">ביטול מחזיר את המספרים בדיוק כפי שהיו</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>תאריך</th><th>סוג</th><th>קובץ</th><th class="n">שורות</th><th class="n">סכום</th><th></th></tr></thead><tbody>
    ${log.map(l => `<tr><td>${esc(l.date)}</td><td>${KIND_LBL[l.kind] || ''}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(l.file || '')}</td><td class="n">${l.n}</td><td class="n">${l.kind === 'pen' ? '' : money(l.total)}</td>
      <td><button class="btn small danger" data-undo="${l.id}" type="button">ביטול</button></td></tr>`).join('')}
    </tbody></table></div></section>`;
}
function rulesHtml(){
  const rules = impData().rules; if (!rules.length) return '';
  const lbl = v => v.t === 's' ? 'דילוג' : v.t === 'i' ? 'הכנסה: ' + v.n : oneLine(v.d) + ' ← ' + v.i;
  return `<details class="card"><summary><b>כללי סיווג שנלמדו</b> <span class="hint">(${rules.length})</span></summary>
    <div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>כשהתיאור מכיל</th><th>מסווג ל־</th><th></th></tr></thead><tbody>
    ${rules.map((r, i) => `<tr><td>${esc(r.m)}${r.c ? ` <span class="chip var">כרטיס ${esc(r.c)}</span>` : ''}${r.a != null ? ` <span class="chip var">≈ ${plain(r.a)}</span>` : ''}</td><td>${esc(lbl(r.v))}</td><td><button class="btn small danger" data-delrule="${i}" type="button">מחיקה</button></td></tr>`).join('')}
    </tbody></table></div></details>`;
}
function txView(kind){
  const has = IMP.kind === kind && IMP.file;
  const rows = has ? IMP.rows : [];
  const open = rows.filter(r => !r.v), assigned = rows.filter(r => r.v && r.v !== 'skip' && r.v !== 'later'), later = rows.filter(r => r.v === 'later' && !r.dup);
  const out = sum(rows.filter(r => r.amt > 0).map(r => r.amt)), inn = -sum(rows.filter(r => r.amt < 0).map(r => r.amt));
  const shown = IMP.onlyOpen ? rows.filter(r => !r.v) : rows;
  return `
  <section class="card"><div class="card-h"><h3>העלאת קובץ ${kind === 'bank' ? 'תנועות בנק' : 'פירוט אשראי'}</h3><span class="hint">xlsx · xls · csv${kind === 'card' ? ' · PDF של כרטיס לאומי' : ''} · הקובץ נקרא רק במכשיר הזה</span></div>
    <label class="btn primary" style="justify-self:start">${UP_ICON ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UP_ICON}</svg>` : ''}בחירת קבצים (אפשר כמה יחד)<input type="file" id="txFile" accept=".xlsx,.xls,.csv,.xlsm,.pdf" multiple hidden></label>
    ${has ? `<p style="margin:0">קובץ: <b>${esc(IMP.file)}</b> <button class="btn small ghost" id="txClear" type="button">ניקוי</button></p>` : ''}
    ${IMP.msg && IMP.kind === kind ? `<p class="note" style="margin:0">${esc(IMP.msg)}</p>` : ''}
    ${has && IMP.pdfInfo ? `<ul class="pdf-info">${IMP.pdfInfo.map(x => `<li class="${x.bad ? 'down' : ''}">${esc(x.t)}</li>`).join('')}</ul>` : ''}
    ${howTo(kind)}
  </section>
  ${pendingHtml(kind)}
  ${has ? mapperHtml() : ''}
  ${has && rows.length ? confirmHtml(kind) + askHtml(kind) : ''}
  ${has && rows.length ? `
  <div class="kpis">
    <div class="kpi"><span class="lbl">תנועות בקובץ</span><span class="val">${rows.length}</span><span class="sub">${rows.filter(r => r.dup).length} כבר נקלטו בעבר</span></div>
    <div class="kpi"><span class="lbl">${kind === 'bank' ? 'יציאות (חובה)' : 'סה״כ חיובים'}</span><span class="val down">${money(out)}</span><span class="sub">${inn ? (kind === 'bank' ? 'כניסות: ' : 'זיכויים: ') + plain(inn) : ''}</span></div>
    <div class="kpi"><span class="lbl">מסווגות</span><span class="val up">${assigned.length}</span><span class="sub">${rows.filter(r => r.v === 'skip').length} בדילוג</span></div>
    <div class="kpi"><span class="lbl">ממתינות לסיווג</span><span class="val ${open.length ? 'down' : ''}">${open.length}</span><span class="sub">${later.length ? later.length + ' לאחר כך · ' : ''}שורות בלי סיווג לא ייקלטו</span></div>
  </div>
  <section class="card">
    <div class="card-h"><h3>סיווג תנועות</h3><span class="hint">סיווג של שורה אחת חל גם על שורות זהות שעוד לא סווגו</span></div>
    <div class="row">
      <label class="field" style="max-width:280px">שיוך לחודש<select class="inp" id="txMonth">${monthOptions()}</select></label>
      <label class="row" style="gap:6px;font-weight:600;font-size:13.5px"><input type="checkbox" id="txOnlyOpen" ${IMP.onlyOpen ? 'checked' : ''}> רק לא מסווגות</label>
      <label class="row" style="gap:6px;font-weight:600;font-size:13.5px"><input type="checkbox" id="txLearn" ${IMP.learn ? 'checked' : ''}> ללמוד כללים לפעם הבאה</label>
    </div>
    <div class="tbl-wrap" style="max-height:60vh"><table><thead><tr><th>תאריך</th><th>תיאור</th><th class="n">סכום</th><th>חודש</th><th>סיווג</th></tr></thead><tbody>
    ${shown.map(r => { const i = rows.indexOf(r), mo = rowMonth(r); return `<tr ${r.dup ? 'style="opacity:.55"' : ''}>
      <td>${fmtDate(r.date)}</td>
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.desc)}">${esc(r.desc)}${r.why ? ` <span class="chip ${r.why === 'לפי כלל' || r.why === 'תשובה' ? 'fixed' : 'var'}">${esc(r.why)}</span>` : ''}</td>
      <td class="n ${r.amt < 0 ? 'up' : ''}">${money(kind === 'bank' && r.amt < 0 ? -r.amt : r.amt)}${r.amt < 0 ? ` <span class="chip yes">${kind === 'bank' ? 'זכות' : 'זיכוי'}</span>` : ''}</td>
      <td>${MS[mo.m]} ${mo.y.slice(2)}</td>
      <td><select class="inp" style="min-width:210px;padding:5px 8px" data-row="${i}">${catOptions(r, kind)}</select></td></tr>`; }).join('')}
    ${!shown.length ? '<tr><td colspan="5" class="hint">כל התנועות סווגו ✓</td></tr>' : ''}
    </tbody></table></div>
    <div class="row"><button class="btn primary" id="txCommit" type="button" ${assigned.length || later.length || rows.some(r => r.v === 'skip' && !r.dup) ? '' : 'disabled'}>קליטת ${assigned.length} תנועות ל${kind === 'bank' ? 'הוצאות ולהכנסות' : 'הוצאות'}${later.length ? ` (+${later.length} לשאלות פתוחות)` : ''}</button>
      <span class="hint">הסכומים <b>מתווספים</b> לסכום הקיים בכל קטגוריה וחודש. אפשר לבטל כל קליטה.</span></div>
  </section>` : ''}
  ${logHtml([kind])}
  ${rulesHtml()}`;
}
function txAfter(kind){
  const f = $('#txFile'); if (f) f.onchange = e => { const fs = e.target.files; if (fs && fs.length) onTxFile(fs, kind); };
  const c = $('#txClear'); if (c) c.onclick = () => { resetImp(); render(); };
  const mo = $('#txMonth'); if (mo) mo.onchange = () => { IMP.monthMode = mo.value; keepScroll(); };
  const oo = $('#txOnlyOpen'); if (oo) oo.onchange = () => { IMP.onlyOpen = oo.checked; keepScroll(); };
  const le = $('#txLearn'); if (le) le.onchange = () => { IMP.learn = le.checked; };
  $$('[data-row]').forEach(s => s.onchange = () => {
    IMP.confirm = null; // classification changed → the plan check runs again on the next press
    const r = IMP.rows[+s.dataset.row]; r.v = s.value; r.touched = true; r.why = '';
    if (s.value) { const n = normDesc(r.desc); IMP.rows.forEach(o => { if (o !== r && !o.v && !o.dup && normDesc(o.desc) === n) { o.v = s.value; o.touched = true; } }); }
    keepScroll();
  });
  const cm = $('#txCommit'); if (cm) cm.onclick = commitTx;
  bindMapper(); bindLogRules(); bindAsk();
  $$('[data-cmode]').forEach(s => s.onchange = () => { IMP.confirm[+s.dataset.cmode].mode = s.value; });
  const cg = $('#confirmGo'); if (cg) cg.onclick = commitTx;
  const cb = $('#confirmBack'); if (cb) cb.onclick = () => { IMP.confirm = null; keepScroll(); };
}
function bindMapper(){
  const ms = $('#mapSheet'); if (ms) ms.onchange = () => { IMP.map = IMP.sheets[+ms.value]; IMP.map.map ||= guessManual(IMP.map.rows); reExtract(); };
  const hr = $('#mapHr'); if (hr) hr.onchange = () => { const v = (+hr.value || 1) - 1; IMP.map.map.hr = Math.max(0, v); reExtract(); };
  $$('[data-map]').forEach(s => s.onchange = () => { const k = s.dataset.map; IMP.map.map[k] = +s.value; if (k === 'amount' && +s.value >= 0) { IMP.map.map.debit = -1; IMP.map.map.credit = -1; } if ((k === 'debit' || k === 'credit') && +s.value >= 0) IMP.map.map.amount = -1; reExtract(); });
}
function bindLogRules(){
  $$('[data-undo]').forEach(b => b.onclick = () => { if (b.dataset.sure) return undoImport(+b.dataset.undo); b.dataset.sure = 1; b.textContent = 'בטוח?'; });
  $$('[data-delrule]').forEach(b => b.onclick = () => { impData().rules.splice(+b.dataset.delrule, 1); markDirty(); keepScroll(); });
}
function keepScroll(){ const y = window.scrollY, tw = $('.tbl-wrap[style*="max-height"]'), ty = tw ? tw.scrollTop : 0; render(); window.scrollTo(0, y); const tw2 = $('.tbl-wrap[style*="max-height"]'); if (tw2) tw2.scrollTop = ty; }

VIEWS.upBank = () => txView('bank');
VIEWS.upBank.after = () => txAfter('bank');
VIEWS.upCard = () => txView('card');
VIEWS.upCard.after = () => txAfter('card');

/* ---------- view: pension & funds ---------- */
function penAssets(){ return D().assets.map((a, i) => ({a, i})).filter(x => PEN_RX.test(x.a.group || '')); }
const isForeign = a => a.currency && a.currency !== 'ILS' && a.foreign;
const curSym = a => isForeign(a) ? (a.currency === 'EUR' ? '€' : '$') : '₪';
function matchAsset(name){
  const STOP = /^(קרן|קופת|קופה|ביטוח|חברה|בע"?מ|מנהלת|של|חשבון|מסלול|כללי|ל?תגמולים)$/;
  const toks = normDesc(name).split(' ').filter(t => t.length > 1 && !STOP.test(t));
  let best = -1, score = 0;
  for (const {a, i} of penAssets()) { const n = normDesc(a.name); const s = toks.filter(t => n.includes(t) || n.includes(t.replace(/ה$/, 'יה'))).length; if (s > score) { score = s; best = i; } }
  return score ? best : -1;
}
/* ---------- pension agent report (PDF, e.g. "דוח שוטף" by גל ברם) → structured data ----------
   pdf.js gives each line right-to-left; amounts come as "1,232,366" with a separate "₪" token. */
const pN = t => { const v = parseFloat(String(t ?? '').replace(/[₪,%\s]/g, '')); return isNaN(v) ? null : v; };
const isNumT = t => /^-?[\d,]+(\.\d+)?%?$/.test(String(t).trim());
function parsePenReport(lines){
  const L = lines.map(l => l.filter(t => t.trim() && t.trim() !== '₪' && t !== '|').map(t => t.replace(/^₪\s*/, '').trim()));
  const flat = L.map(l => l.join(' | '));
  const find = (rx, from = 0) => { for (let i = from; i < L.length; i++) if (L[i].some(t => rx.test(t))) return i; return -1; };
  const after = (lbl, from = 0) => { for (let i = from; i < L.length; i++) { const j = L[i].indexOf(lbl); if (j >= 0) return L[i][j + 1]; } return null; };
  const P = {funds:[]};
  const hi = find(/^עבור הלקוח$/);
  if (hi < 0 || !L[hi + 1]) return null;
  const head = L[hi + 1]; // [asOf, "name id", agent]
  P.asOf = head.find(t => /^\d\d\/\d\d\/\d{4}$/.test(t)) || '';
  P.client = (head.find(t => /[֐-׿]/.test(t) && /\d{6,}/.test(t)) || head[1] || '').replace(/\d+/g, '').trim();
  P.agent = head[head.length - 1] || '';
  P.produced = after('הופק בתאריך') || '';
  P.total = pN(after('סך החיסכון שצברת'));
  P.ytd = pN(after('תשואה מתחילת שנה'));
  for (const [k, lbl] of [['stocks', 'חשיפה למניות'], ['abroad', 'חשיפה לחו"ל'], ['fx', 'חשיפה למט"ח'], ['traded', 'נכסים סחירים']]) { for (const l of L) { const j = l.indexOf(lbl); if (j >= 0 && isNumT(l[j + 1] || '')) { P[k] = pN(l[j + 1]); break; } } }
  const mi = find(/^תמהיל השקעה$/); P.mix = [];
  if (mi >= 0) for (const l of L.slice(mi + 1, mi + 7)) for (let j = 0; j + 1 < l.length; j += 2) if (!isNumT(l[j]) && /%$/.test(l[j + 1]) && pN(l[j + 1])) P.mix.push([l[j], pN(l[j + 1])]);
  P.mix.sort((a, b) => b[1] - a[1]);
  const si = find(/^סך הוני מהחיסכון$/);
  if (si >= 0) { const v = L[si + 1].map(pN); [P.lumpSum, P.depositsMonthly, P.pensionNo] = v; }
  const pw = L.find(l => l[0] === 'פנסיה' && l.length === 3 && isNumT(l[1]) && isNumT(l[2])); if (pw) P.pensionWith = pN(pw[2]);
  const li = find(/^תאריך התחלה$/);
  if (li >= 0 && L[li + 1] && /^\d\d\/\d\d\/\d{4}$/.test(L[li + 1][0])) { const t = L[li + 1]; P.loan = {start:t[0], amount:pN(t[1]), product:t[2], rate:pN(t[3]), monthly:pN(t[4]), balance:pN(t[5]), end:t[6]}; }
  const ci = find(/^כיסויים לאובדן כושר עבודה$/);
  if (ci >= 0 && L[ci + 1]) { const t = L[ci + 1]; P.coverDisab = pN(t[0]); P.coverDeath = pN(t[t.length - 1]); }
  // one section per product: ["1","קרן פנסיה חדשה מקיפה"]
  const TYPES = /^(קרן פנסיה חדשה מקיפה|קרן פנסיה חדשה כללית|קרן השתלמות|קופת גמל לתגמולים ופיצויים|ביטוח מנהלים|קופת גמל להשקעה|קרן פנסיה ותיקה)$/;
  const starts = []; L.forEach((l, i) => { if (l.length === 2 && /^\d+$/.test(l[0]) && TYPES.test(l[1])) starts.push(i); });
  starts.forEach((s, n) => {
    const e = n + 1 < starts.length ? starts[n + 1] : L.length, F = {type:L[s][1]};
    for (let k = s - 1; k >= Math.max(0, s - 4); k--) {
      const j = L[k].indexOf('צבירה'); if (j >= 0) { F.balance = pN(L[k][j + 1]); if (L[k].includes('קצבה חזויה') && L[k + 1]) { F.pensionNo = pN(L[k + 1][0]); F.pensionWith = pN(L[k + 1][1]); } break; }
    }
    const B = L.slice(s + 1, e);
    const jl = B.findIndex(l => l.includes('הצטרפות'));
    if (jl >= 0) { const l = B[jl]; F.join = l[l.indexOf('הצטרפות') + 1]; F.provider = l.filter(t => t !== 'הצטרפות' && t !== F.join)[0] || (B[jl - 1] || [])[0]; }
    if (!F.provider) F.provider = (B[0] || [])[0];
    const pl = B.find(l => l[0] === 'מספר פוליסה'); if (pl) { F.policy = pl[1]; F.status = pl.includes('לא פעיל') ? 'לא פעיל' : 'פעיל'; }
    const hk = B.findIndex(l => l.includes('מיופה כוח'));
    F.deposit = 0; F.salary = 0;
    if (hk >= 0 && B[hk + 1]) {
      const h = B[hk], v = B[hk + 1], d = {};
      if (h.length === v.length) h.forEach((x, i) => d[x] = v[i]);
      else { const pc = v.filter(t => /%$/.test(t)), nums = v.filter(t => isNumT(t) && !/%$/.test(t)); // fall back: by kind of value
        if (h.includes('דמי ניהול מהפקדה')) { d['דמי ניהול מהפקדה'] = pc[0]; d['דמי ניהול מצבירה'] = pc[1]; } else d['דמי ניהול מצבירה'] = pc[0];
        if (h.includes('שכר למוצר')) d['שכר למוצר'] = nums[0]; if (h.includes('הפקדה שוטפת')) d['הפקדה שוטפת'] = nums[h.includes('שכר למוצר') ? 1 : 0]; }
      F.feeDep = pN(d['דמי ניהול מהפקדה']); F.feeAcc = pN(d['דמי ניהול מצבירה']);
      F.deposit = pN(d['הפקדה שוטפת']) || 0; F.salary = pN(d['שכר למוצר']) || 0;
      F.employer = d['מעסיק'] && !/שכיר כללי/.test(d['מעסיק']) ? d['מעסיק'] : '—';
      if (d['מקדם מובטח לפרישה']) F.coef = pN(d['מקדם מובטח לפרישה']);
    }
    // returns: [name, balance, share, month, ytd, 12m, 3y, 5y, avg3, avg5]
    F.tracks = [];
    const rk = B.findIndex(l => l[0] === 'אחרון');
    if (rk >= 0) for (let k = rk + 1; k < B.length; k++) {
      const l = B[k];
      if (/^(סוג כיסוי|מבוטח ראשי|מעסיק|סכום הלוואה|לא התקבל מידע)$/.test(l[0]) || /^פיצויים/.test(l[0])) break;
      if (l.length >= 4 && /%$/.test(l[2] || '') && isNumT(l[1])) {
        let name = l[0]; const nx = B[k + 1];
        if (nx && nx.length === 1 && !/%|\d{3}/.test(nx[0].replace(/S&P\s*\d+|\d+\s*S&P/, ''))) name += ' ' + nx[0];
        name = name.replace(/\s+/g, ' ').replace(/^[-\s\d]+(?=\D)/, '')
          .replace(/P 500 S|500 S&P|S&P\s*500|S&P(?! ?500)/g, 'S&P 500').replace(/S&P 500 מדד/, 'מדד S&P 500').replace(/מדד 500 S&P 500/, 'מדד S&P 500').replace(/מדד S&P 500 S&P 500/, 'מדד S&P 500').trim();
        const vals = l.slice(3).map(pN), keys = ['m', 'ytd', 'y1', 'c3', 'c5', 'a3', 'a5'], R = {};
        vals.forEach((v, i) => { if (keys[i]) R[keys[i]] = v; });
        if (pN(l[2])) F.tracks.push({name, share:pN(l[2]), balance:pN(l[1]), ret:R});
      }
    }
    const ck = B.findIndex(l => l[0] === 'סוג כיסוי' && l[1] === 'שיעור כיסוי');
    if (ck >= 0) { F.cover = []; for (const l of B.slice(ck + 1)) { if (!/%$/.test(l[1] || '')) break; F.cover.push({type:l[0], rate:pN(l[1]), pension:pN(l[2]), cost:l[3] != null ? pN(l[3]) : null}); } }
    const rid = B.filter(l => l[1] === 'אבדן כושר עבודה').map(l => { const nums = l.slice(2).map(pN); return {name:l[0], cover:nums[0] || 0, premium:nums[1] || 0}; });
    if (rid.length) F.riders = rid;
    const dk = B.findIndex(l => l[0] === 'מעסיק' && l.includes('חודש שכר'));
    if (dk >= 0 && B[dk + 1] && !B[dk + 1].some(t => /ניוד/.test(t))) {
      const h = B[dk], v = B[dk + 1];
      if (v.length <= h.length && /\d\d\/\d{4}/.test(v.join(' '))) { const d = {}, hh = h.slice(h.length - v.length); hh.forEach((x, i) => d[x] = v[i]); // no employer column → align from the end
        const [mm, yy] = String(d['חודש שכר'] || '').split('/'), [ad, am, ay] = P.asOf.split('/');
        if (yy && (+ay * 12 + +am) - (+yy * 12 + +mm) <= 6) F.last = {month:d['חודש שכר'], salary:pN(d['שכר מדווח']), employee:pN(d['הפקדת עובד']), employer:pN(d['הפקדת מעסיק']), severance:pN(d['הפקדת פיצויים']), total:pN(d['סה״כ הפקדה'])};
      }
    }
    P.funds.push(F);
  });
  return P.funds.length || P.total ? P : null;
}
function penPersonOf(P){
  const ppl = D().settings.people || {};
  for (const [k, n] of Object.entries(ppl)) if (n && P.client.split(/[\s\-]+/).includes(n)) return k;
  for (const [k, n] of Object.entries(ppl)) if (n && P.client.includes(n)) return k;
  return null;
}
const shortDate = s => { const m = String(s || '').match(/(\d\d)\/(\d\d)\/\d\d(\d\d)/); return m ? `${m[1]}.${m[2]}.${m[3]}` : nowStamp(); };
// what a report changes in "מבט כולל": pension (מקיפה + כללית) and its expected pension, study funds total, pension loan
function penPlan(k, P){
  const name = (D().settings.people || {})[k], out = [];
  const pen = P.funds.filter(f => /קרן פנסיה חדשה/.test(f.type)), study = P.funds.filter(f => f.type === 'קרן השתלמות');
  const aP = D().assets.find(a => /פנסי/.test(a.group || '') && a.name.includes(name));
  const aS = D().assets.find(a => /השתלמות/.test(a.group || '') && a.name.includes(name));
  if (aP && pen.length) out.push({asset:aP, value:Math.round(sum(pen.map(f => f.balance || 0))), pension:Math.round(sum(pen.map(f => f.pensionNo || 0))) || null});
  if (aS && study.length) out.push({asset:aS, value:Math.round(sum(study.map(f => f.balance || 0)))});
  if (P.loan) { const l = D().liabilities.find(l => /פנסיה/.test(l.name)); if (l) out.push({liab:l, value:Math.round(P.loan.balance)}); }
  return out;
}
async function onPenFiles(files){
  IMP.kind = 'pen'; IMP.file = files.map(f => f.name).join(', '); IMP.penRows = []; IMP.msg = ''; IMP.penReports = [];
  if (IMP.pdfUrl) URL.revokeObjectURL(IMP.pdfUrl); IMP.pdfUrl = null;
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name)), other = files.filter(f => !/\.pdf$/i.test(f.name));
  IMP.msg = pdfs.length ? `קורא ${pdfs.length} דוחות…` : ''; render();
  const bad = [];
  for (const f of pdfs) {
    try {
      const P = parsePenReport(await pdfLines(f));
      const k = P && penPersonOf(P);
      if (!P || !k) { bad.push(f); continue; }
      IMP.penReports = IMP.penReports.filter(r => r.k !== k).concat({k, P, file:f.name, plan:penPlan(k, P)});
    } catch (e) { console.error(e); bad.push(f); }
  }
  IMP.msg = bad.length ? `לא זיהיתי דוח מוכר ב־${bad.map(f => f.name).join(', ')}. אפשר להקליד את היתרות בטבלה למטה.` : '';
  if (bad.length === 1 && !IMP.penReports.length) IMP.pdfUrl = URL.createObjectURL(bad[0]);
  if (other.length) return onPenFile(other[0], true);
  render();
}
function applyPenReports(){
  const changes = [], d = D(), r = d.pensionReport ||= {people:{}};
  r.people ||= {};
  const meta = {asOf:r.asOf, produced:r.produced, source:r.source};
  for (const {k, P, plan} of IMP.penReports) {
    for (const x of plan) {
      if (x.liab) { changes.push({liab:x.liab.name, prev:{value:x.liab.value}}); x.liab.value = x.value; continue; }
      const a = x.asset; changes.push({name:a.name, prev:{value:a.value, foreign:a.foreign, updated:a.updated, pension:a.pension}});
      a.value = x.value; if (x.pension) a.pension = x.pension; a.updated = shortDate(P.asOf);
    }
    changes.push({report:k, prev:r.people[k] ? JSON.parse(JSON.stringify(r.people[k])) : null, meta});
    const {client, agent, ...keep} = P; r.people[k] = keep;
    r.asOf = P.asOf; r.produced = P.produced; r.source = `${agent || 'הסוכן'}`;
  }
  if ($('#penSnap')?.checked !== false) {
    const t = totals(), h = d.netWorthHistory, e = h.find(x => x.date === today());
    const row = {date:today(), assets:Math.round(t.assets), liabilities:Math.round(t.liabilities), net:Math.round(t.net)};
    changes.push({snap:today(), prev:e ? {...e} : null});
    if (e) Object.assign(e, row); else h.push(row);
  }
  impData().log.unshift({id:Date.now(), kind:'pen', file:IMP.penReports.map(x => `דוח ${x.P.agent || ''} ${x.P.asOf} – ${(d.settings.people || {})[x.k]}`).join(' · '), date:today(), n:changes.filter(c => !c.report && !c.snap).length, changes});
  markDirty(); toast(`עודכנו ${IMP.penReports.length} דוחות: מבט כולל ופנסיה וקרנות. לחצו "שמירה" כדי לשמור.`, 4500);
  IMP.penReports = []; IMP.file = null; IMP.msg = ''; render();
}
function penReportsHtml(){
  if (!IMP.penReports?.length) return '';
  const nm = k => esc((D().settings.people || {})[k] || k);
  return `<section class="card ask"><div class="card-h"><h3>זוהו ${IMP.penReports.length} דוחות</h3><span class="hint">בדקו ולחצו ״עדכון״ – אפשר לבטל אחר כך</span></div>
    ${IMP.penReports.map(({k, P, file, plan}) => `<div class="q">
      <div class="q-h"><b>${nm(k)}</b><span class="hint">${esc(file)} · דוח ${esc(P.agent || '')} נכון ל־${esc(P.asOf)} · ${P.funds.length} מוצרים · סך החיסכון ${plain(P.total || 0)}</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>מה מתעדכן</th><th class="n">היום</th><th class="n">לפי הדוח</th><th class="n">שינוי</th></tr></thead><tbody>
      ${plan.map(x => { const cur = x.liab ? liabValue(x.liab) : assetValue(x.asset), lbl = x.liab ? x.liab.name : x.asset.name; return `<tr><td>${esc(lbl)}${x.pension ? `<div class="hint" style="font-size:12px">קצבה חזויה ${plain(x.asset.pension || 0)} → ${plain(x.pension)}</div>` : ''}</td><td class="n">${money(cur)}</td><td class="n"><b>${money(x.value)}</b></td><td class="n ${x.value - cur >= 0 ? 'up' : 'down'}">${x.value - cur >= 0 ? '+' : '−'}${plain(Math.abs(x.value - cur))}</td></tr>`; }).join('')}
      <tr><td>עמוד ״פנסיה וקרנות״</td><td colspan="3" class="hint">כל ${P.funds.length} המוצרים: דמי ניהול, תשואות, הפקדות, כיסויים</td></tr>
      </tbody></table></div></div>`).join('')}
    <div class="row"><button class="btn primary" id="penApply" type="button">עדכון</button>
      <label class="row" style="gap:6px;font-weight:600;font-size:13.5px"><input type="checkbox" id="penSnap" checked> לשמור גם תמונת מצב לגרף הצמיחה</label></div>
  </section>`;
}
async function onPenFile(file, keep){
  IMP.kind = 'pen'; if (!keep) { IMP.file = file.name; IMP.msg = ''; } IMP.penRows = [];
  if (IMP.pdfUrl) URL.revokeObjectURL(IMP.pdfUrl); IMP.pdfUrl = null;
  if (/\.pdf$/i.test(file.name)) { IMP.pdfUrl = URL.createObjectURL(file); IMP.msg = 'דוח PDF: פתחו אותו בחלון נפרד והקלידו את היתרות בטבלה למטה.'; return render(); }
  try {
    const sheets = await readSheets(file);
    for (const sh of sheets) {
      for (let r = 0; r < Math.min(sh.rows.length, 40); r++) {
        const hdr = hdrOf(sh.rows[r]);
        const bal = findCol(hdr, [/יתרה/, /צבירה/, /סה"?כ חיסכון/, /שווי/, /סכום/]);
        const nm = findCol(hdr, [/שם (ה)?(קופה|מוצר|קרן|תכנית|תוכנית)/, /^מוצר/, /קופה/, /קרן/, /שם/, /חברה/, /גוף/]);
        if (bal < 0 || nm < 0 || bal === nm) continue;
        const pen = findCol(hdr, [/קצבה/]);
        for (let k = r + 1; k < sh.rows.length; k++) {
          const row = sh.rows[k], v = toNum(row[bal]), n = String(row[nm] ?? '').trim();
          if (!n || isNaN(v) || !v) continue;
          const pv = pen >= 0 ? toNum(row[pen]) : NaN;
          IMP.penRows.push({name:n, v, pension:isNaN(pv) ? null : pv, to:matchAsset(n)});
        }
        break;
      }
    }
    if (!IMP.penRows.length) IMP.msg = 'לא זיהיתי טבלה עם שם קופה ויתרה. אפשר להקליד את היתרות בטבלה למטה.';
    IMP.penRows.forEach(r => { if (r.to >= 0) IMP.pen[r.to] = {...(IMP.pen[r.to] || {}), v:r.v, ...(r.pension ? {p:r.pension} : {})}; });
  } catch (e) { IMP.msg = 'לא הצלחתי לקרוא את הקובץ: ' + e.message; }
  render();
}
function commitPen(){
  const changes = [];
  for (const [k, st] of Object.entries(IMP.pen)) {
    const a = D().assets[+k]; if (!a || (st.v == null && st.p == null)) continue;
    const prev = {value:a.value, foreign:a.foreign, updated:a.updated, pension:a.pension};
    if (st.v != null && !isNaN(st.v)) { if (isForeign(a)) a.foreign = st.v; else a.value = st.v; }
    if (st.p != null && !isNaN(st.p)) a.pension = st.p;
    a.updated = nowStamp();
    changes.push({name:a.name, prev});
  }
  if (!changes.length) return toast('לא הוזנו ערכים חדשים');
  if ($('#penSnap')?.checked) {
    const t = totals(), h = D().netWorthHistory, e = h.find(x => x.date === today());
    const row = {date:today(), assets:Math.round(t.assets), liabilities:Math.round(t.liabilities), net:Math.round(t.net)};
    if (e) Object.assign(e, row); else h.push(row);
  }
  impData().log.unshift({id:Date.now(), kind:'pen', file:IMP.file || 'הזנה ידנית', date:today(), n:changes.length, changes});
  markDirty(); toast(`עודכנו ${changes.length} נכסים. לחצו "שמירה" כדי לשמור.`, 4000);
  IMP.pen = {}; IMP.penRows = []; IMP.file = null; IMP.msg = ''; render();
}
VIEWS.upPen = () => {
  const list = penAssets(), staged = Object.keys(IMP.pen).length;
  const before = sum(list.map(x => assetValue(x.a)));
  const after = sum(list.map(({a, i}) => { const st = IMP.pen[i]; if (!st || st.v == null) return assetValue(a); return isForeign(a) ? st.v * (a.fx || D().rates[a.currency.toLowerCase()] || 1) : st.v; }));
  const opts = sel => `<option value="-1">— לא לשייך —</option>` + list.map(({a, i}) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  return `
  <section class="card"><div class="card-h"><h3>העלאת דוח פנסיה וקרנות</h3><span class="hint">PDF של הסוכן · xlsx · csv</span></div>
    <label class="btn primary" style="justify-self:start"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UP_ICON}</svg>בחירת קבצים (אפשר כמה יחד)<input type="file" id="penFile" accept=".xlsx,.xls,.csv,.pdf" multiple hidden></label>
    ${IMP.kind === 'pen' && IMP.file ? `<p style="margin:0">קובץ: <b>${esc(IMP.file)}</b>${IMP.pdfUrl ? ` · <a href="${IMP.pdfUrl}" target="_blank" rel="noopener">פתיחת הדוח בחלון נפרד</a>` : ''}</p>` : ''}
    ${IMP.kind === 'pen' && IMP.msg ? `<p class="note" style="margin:0">${esc(IMP.msg)}</p>` : ''}
    <details class="note"><summary><b>מאיפה מורידים?</b></summary>
      <p><b>ריכוז כל הקופות:</b> דוח מהמסלקה הפנסיונית, דרך הסוכן הפנסיוני או באתר ״הר הכסף״ של משרד האוצר. <b>קופה בודדת:</b> הדוח הרבעוני או השנתי המקוצר מהאזור האישי בחברה המנהלת. <b>תיק השקעות או קרן כספית:</b> דוח יתרות מהבנק או מבית ההשקעות.</p>
      <p><b>הדוח השוטף של הסוכן (PDF):</b> נקרא אוטומטית – לכל אחד מכם בנפרד, ואפשר לבחור את שני הדוחות יחד. מתעדכנים במבט הכולל הפנסיה (מקיפה + כללית) והקצבה החזויה, קרנות ההשתלמות וההלוואה מהפנסיה, ובעמוד ״פנסיה וקרנות״ כל המוצרים. מקובץ אקסל היתרות משויכות לנכסים אוטומטית.</p></details>
  </section>
  ${penReportsHtml()}
  ${IMP.penRows.length ? `<section class="card"><div class="card-h"><h3>שורות שזוהו בקובץ</h3><span class="hint">בדקו שכל קופה משויכת לנכס הנכון</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>שם בקובץ</th><th class="n">יתרה</th><th class="n">קצבה</th><th>שיוך לנכס</th></tr></thead><tbody>
    ${IMP.penRows.map((r, k) => `<tr><td>${esc(r.name)}</td><td class="n">${money(r.v)}</td><td class="n">${r.pension ? money(r.pension) : ''}</td><td><select class="inp" style="padding:5px 8px" data-penmap="${k}">${opts(r.to)}</select></td></tr>`).join('')}
    </tbody></table></div></section>` : ''}
  <div class="kpis">
    <div class="kpi"><span class="lbl">שווי פנסיה וקרנות כעת</span><span class="val">${money(before)}</span><span class="sub">${list.length} נכסים</span></div>
    <div class="kpi"><span class="lbl">אחרי העדכון</span><span class="val">${money(after)}</span><span class="sub ${after - before >= 0 ? 'up' : 'down'}">${staged ? (after - before >= 0 ? '▲ ' : '▼ ') + plain(Math.abs(after - before)) : 'עדיין לא הוזנו ערכים'}</span></div>
  </div>
  <section class="card"><div class="card-h"><h3>עדכון יתרות</h3><span class="hint">ריק = ללא שינוי</span></div>
    <div class="tbl-wrap"><table><thead><tr><th class="sticky-col">נכס</th><th>סוג</th><th class="n">שווי נוכחי</th><th>עודכן</th><th class="n">יתרה חדשה</th><th class="n">קצבה חודשית</th></tr></thead><tbody>
    ${list.map(({a, i}) => { const st = IMP.pen[i] || {}; return `<tr>
      <td class="sticky-col">${esc(a.name)}</td><td>${esc(a.group)}</td>
      <td class="n">${isForeign(a) ? money(a.foreign, {cur:curSym(a)}) : money(assetValue(a))}</td><td>${esc(a.updated || '')}</td>
      <td class="n"><input class="cell" data-penv="${i}" inputmode="decimal" placeholder="${curSym(a)}" value="${st.v ?? ''}"></td>
      <td class="n">${/פנסי/.test(a.group) ? `<input class="cell" data-penp="${i}" inputmode="decimal" placeholder="${a.pension ?? ''}" value="${st.p ?? ''}">` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="row"><button class="btn primary" id="penCommit" type="button" ${staged ? '' : 'disabled'}>עדכון ${staged || ''} נכסים</button>
      <label class="row" style="gap:6px;font-weight:600;font-size:13.5px"><input type="checkbox" id="penSnap" checked> לשמור גם תמונת מצב לגרף הצמיחה</label></div>
  </section>
  ${logHtml(['pen'])}`;
};
VIEWS.upPen.after = () => {
  const f = $('#penFile'); if (f) f.onchange = e => { const fs = [...(e.target.files || [])]; if (fs.length) onPenFiles(fs); };
  const ap = $('#penApply'); if (ap) ap.onclick = applyPenReports;
  const setSt = (i, k, raw) => { const v = raw.trim() === '' ? null : toNum(raw); if (v != null && isNaN(v)) return toast('יש להזין מספר'); const st = IMP.pen[i] || {}; st[k] = v; if (st.v == null && st.p == null) delete IMP.pen[i]; else IMP.pen[i] = st; keepScroll(); };
  $$('[data-penv]').forEach(el => el.onchange = () => setSt(+el.dataset.penv, 'v', el.value));
  $$('[data-penp]').forEach(el => el.onchange = () => setSt(+el.dataset.penp, 'p', el.value));
  $$('[data-penmap]').forEach(s => s.onchange = () => {
    const r = IMP.penRows[+s.dataset.penmap];
    if (r.to >= 0) delete IMP.pen[r.to];
    r.to = +s.value;
    if (r.to >= 0) IMP.pen[r.to] = {v:r.v, ...(r.pension ? {p:r.pension} : {})};
    keepScroll();
  });
  const c = $('#penCommit'); if (c) c.onclick = commitPen;
  bindLogRules();
};
