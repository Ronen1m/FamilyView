'use strict';
/* עדכון נתונים – קליטת קבצי בנק, אשראי ופנסיה.
   Files are parsed in the browser (SheetJS); nothing leaves the device until the normal encrypted save.
   Every import is logged with its exact deltas so it can be undone. */

const IMP = {kind:null, file:null, rows:[], sheets:[], map:null, monthMode:'tx', onlyOpen:false, learn:true, pen:{}, penRows:[], pdfUrl:null, msg:''};
const KIND_LBL = {bank:'בנק', card:'אשראי', pen:'פנסיה וקרנות'};
const CARD_RX = /ישראכרט|isracard|מקס איט|max it|\bmax\b|כאל|\bcal\b|לאומי קארד|אמריקן אקספרס|american express|דיינרס|diners|ויזה|visa|מסטרקארד|כרטיס(?:י)? אשראי/i;
const PEN_RX = /פנסי|השתלמות|גמל|קרנות|תיק/;

function impData(){ const d = D(); d.imports ||= {log:[], rules:[]}; d.imports.log ||= []; d.imports.rules ||= []; return d.imports; }
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
  const wb = XLSX.read(await file.arrayBuffer(), {type:'array', cellDates:true, codepage:1255});
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
  let s = String(v ?? '').replace(/[₪$€,\s]|ש"ח|NIS|ILS/gi, '').trim();
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

/* ---------- classification ---------- */
function ruleFor(desc){
  const n = normDesc(desc); let best = null;
  for (const r of impData().rules) if (r.m && n.includes(r.m) && (!best || r.m.length > best.m.length)) best = r;
  return best;
}
function ruleToValue(r){
  if (!r) return '';
  if (r.v.t === 's') return 'skip';
  if (r.v.t === 'e') { const k = IMP.cats.findIndex(c => c.d === r.v.d && c.i === r.v.i); return k >= 0 ? 'e:' + k : ''; }
  if (r.v.t === 'i') { const k = IMP.incs.indexOf(r.v.n); return k >= 0 ? 'i:' + k : ''; }
  return '';
}
function seenHashes(){ const s = new Set(); for (const l of impData().log) for (const h of l.hashes || []) s.add(h); return s; }
function buildRows(kind, items){
  IMP.cats = catList(); IMP.incs = incList();
  const seen = seenHashes(), cnt = {};
  return items.map(it => {
    const base = `${kind}|${ymKey(it.date)}-${it.date.getDate()}|${normDesc(it.desc)}|${it.amt}`;
    cnt[base] = (cnt[base] || 0) + 1;
    const h = base + '|' + cnt[base];
    const row = {...it, h, dup:seen.has(h), v:'', why:''};
    const rule = ruleFor(it.desc);
    if (row.dup) { row.v = 'skip'; row.why = 'נקלט בעבר'; }
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
function learnRule(desc, v){
  const m = normDesc(desc); if (m.length < 2) return;
  const rules = impData().rules, i = rules.findIndex(r => r.m === m);
  if (i >= 0) rules[i].v = v; else rules.push({m, v});
}
function commitTx(){
  const ip = impData(), deltas = [], hashes = [];
  let total = 0;
  for (const r of IMP.rows) {
    if (!r.v) continue;
    if (r.v === 'skip') { if (!r.dup) { hashes.push(r.h); if (IMP.learn && r.why !== 'חיוב כרטיס – מפורט בקובץ האשראי' && r.why !== 'לפי כלל' && r.touched) learnRule(r.desc, {t:'s'}); } continue; }
    const {y, m} = rowMonth(r);
    if (r.v.startsWith('e:')) {
      const c = IMP.cats[+r.v.slice(2)];
      const x = {t:'e', y, d:c.d, i:c.i, m, v:r.amt}; applyDelta(x, 1); deltas.push(x); total += r.amt;
      if (IMP.learn && r.touched) learnRule(r.desc, {t:'e', d:c.d, i:c.i});
    } else if (r.v.startsWith('i:')) {
      const n = IMP.incs[+r.v.slice(2)];
      const x = {t:'i', y, n, m, v:-r.amt}; applyDelta(x, 1); deltas.push(x);
      if (IMP.learn && r.touched) learnRule(r.desc, {t:'i', n});
    }
    hashes.push(r.h);
  }
  if (!deltas.length && !hashes.length) return toast('אין שורות מסווגות לקליטה');
  ip.log.unshift({id:Date.now(), kind:IMP.kind, file:IMP.file, date:today(), n:deltas.length, total:r2(total), deltas, hashes});
  markDirty();
  toast(`נקלטו ${deltas.length} תנועות. לחצו "שמירה" כדי לשמור.`, 4000);
  resetImp(); render();
}
function undoImport(id){
  const ip = impData(), i = ip.log.findIndex(l => l.id === id); if (i < 0) return;
  const l = ip.log[i];
  if (l.kind === 'pen') { for (const x of l.changes) { const a = D().assets.find(a => a.name === x.name); if (a) Object.assign(a, x.prev); } }
  else for (const x of l.deltas || []) applyDelta(x, -1);
  ip.log.splice(i, 1); markDirty(); toast('הקליטה בוטלה'); render();
}
function resetImp(){ if (IMP.pdfUrl) URL.revokeObjectURL(IMP.pdfUrl); Object.assign(IMP, {file:null, rows:[], sheets:[], map:null, monthMode:'tx', onlyOpen:false, pen:{}, penRows:[], pdfUrl:null, msg:''}); }

/* ---------- file handling ---------- */
async function onTxFile(file, kind){
  resetImp(); IMP.kind = kind; IMP.file = file.name;
  if (!window.XLSX) { IMP.msg = 'רכיב קריאת האקסל לא נטען. רעננו את הדף ונסו שוב.'; return render(); }
  if (/\.pdf$/i.test(file.name)) { IMP.msg = 'קובץ PDF לא נקרא כאן. הורידו מהאתר את הקובץ בפורמט אקסל (xlsx/xls) או CSV.'; return render(); }
  try {
    IMP.sheets = await readSheets(file);
    let items = [];
    for (const sh of IMP.sheets) { sh.map = detect(sh.rows); items = items.concat(extract(sh, sh.map, kind)); }
    const first = IMP.sheets.find(s => s.map) || IMP.sheets[0];
    IMP.map = first;
    if (!items.length) IMP.msg = 'לא זיהיתי טבלת תנועות אוטומטית. בחרו למטה את שורת הכותרות ואת העמודות.';
    IMP.rows = buildRows(kind, items);
    if (!IMP.sheets.some(s => s.map)) IMP.sheets.forEach(s => s.map = guessManual(s.rows));
  } catch (e) { console.error(e); IMP.msg = 'לא הצלחתי לקרוא את הקובץ: ' + e.message; }
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

/* ---------- views: bank / card ---------- */
const UP_ICON = '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>';
function howTo(kind){
  if (kind === 'bank') return `<details class="note"><summary><b>איך מורידים את הקובץ מהבנק?</b></summary>
    <p>נכנסים לאתר הבנק ← <b>עובר ושב</b> ← <b>תנועות בחשבון</b> ← בוחרים טווח תאריכים ← <b>ייצוא לאקסל</b>. רוב הבנקים (לאומי, הפועלים, דיסקונט, מזרחי, הבינלאומי) מאפשרים xls או CSV, ושני הפורמטים עובדים כאן.</p>
    <p>חיובי כרטיסי אשראי בעו״ש מסומנים אוטומטית כ״דילוג״, כי הפירוט שלהם נקלט מקובץ האשראי. כך אותה הוצאה לא נספרת פעמיים.</p></details>`;
  return `<details class="note"><summary><b>איך מורידים את הקובץ מחברת האשראי?</b></summary>
    <p><b>ישראכרט / אמריקן אקספרס:</b> האזור האישי ← פירוט עסקאות ← ייצוא לאקסל.<br><b>מקס:</b> האזור האישי ← פירוט החיובים ← הורדה לאקסל.<br><b>כאל:</b> האזור האישי ← פירוט עסקאות ← ייצוא.</p>
    <p>הסכום שנקלט הוא <b>סכום החיוב</b> בשקלים. כדי שהחודש יתאים לדף החיוב ולא לתאריך הרכישה, בוחרים ״לפי תאריך החיוב״ או חודש ספציפי.</p></details>`;
}
function catOptions(r, kind){
  const groups = {};
  IMP.cats.forEach((c, k) => (groups[c.d] ||= []).push(`<option value="e:${k}" ${r.v === 'e:' + k ? 'selected' : ''}>${esc(c.i)}</option>`));
  const exp = Object.entries(groups).map(([d, o]) => `<optgroup label="${esc(oneLine(d))}">${o.join('')}</optgroup>`).join('');
  const inc = `<optgroup label="הכנסות">${IMP.incs.map((n, k) => `<option value="i:${k}" ${r.v === 'i:' + k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`;
  const incFirst = kind === 'bank' && r.amt < 0;
  return `<option value="" ${!r.v ? 'selected' : ''}>— לבחירה —</option><option value="skip" ${r.v === 'skip' ? 'selected' : ''}>דילוג (לא לקלוט)</option>${incFirst ? inc + exp : exp + (kind === 'bank' ? inc : '')}`;
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
    ${rules.map((r, i) => `<tr><td>${esc(r.m)}</td><td>${esc(lbl(r.v))}</td><td><button class="btn small danger" data-delrule="${i}" type="button">מחיקה</button></td></tr>`).join('')}
    </tbody></table></div></details>`;
}
function txView(kind){
  const has = IMP.kind === kind && IMP.file;
  const rows = has ? IMP.rows : [];
  const open = rows.filter(r => !r.v), assigned = rows.filter(r => r.v && r.v !== 'skip');
  const out = sum(rows.filter(r => r.amt > 0).map(r => r.amt)), inn = -sum(rows.filter(r => r.amt < 0).map(r => r.amt));
  const shown = IMP.onlyOpen ? rows.filter(r => !r.v) : rows;
  return `
  <section class="card"><div class="card-h"><h3>העלאת קובץ ${kind === 'bank' ? 'תנועות בנק' : 'פירוט אשראי'}</h3><span class="hint">xlsx · xls · csv · הקובץ נקרא רק במכשיר הזה</span></div>
    <label class="btn primary" style="justify-self:start">${UP_ICON ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UP_ICON}</svg>` : ''}בחירת קובץ<input type="file" id="txFile" accept=".xlsx,.xls,.csv,.xlsm,.pdf" hidden></label>
    ${has ? `<p style="margin:0">קובץ: <b>${esc(IMP.file)}</b> <button class="btn small ghost" id="txClear" type="button">ניקוי</button></p>` : ''}
    ${IMP.msg && IMP.kind === kind ? `<p class="note" style="margin:0">${esc(IMP.msg)}</p>` : ''}
    ${howTo(kind)}
  </section>
  ${has ? mapperHtml() : ''}
  ${has && rows.length ? `
  <div class="kpis">
    <div class="kpi"><span class="lbl">תנועות בקובץ</span><span class="val">${rows.length}</span><span class="sub">${rows.filter(r => r.dup).length} כבר נקלטו בעבר</span></div>
    <div class="kpi"><span class="lbl">${kind === 'bank' ? 'יציאות (חובה)' : 'סה״כ חיובים'}</span><span class="val down">${money(out)}</span><span class="sub">${inn ? (kind === 'bank' ? 'כניסות: ' : 'זיכויים: ') + plain(inn) : ''}</span></div>
    <div class="kpi"><span class="lbl">מסווגות</span><span class="val up">${assigned.length}</span><span class="sub">${rows.filter(r => r.v === 'skip').length} בדילוג</span></div>
    <div class="kpi"><span class="lbl">ממתינות לסיווג</span><span class="val ${open.length ? 'down' : ''}">${open.length}</span><span class="sub">שורות בלי סיווג לא ייקלטו</span></div>
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
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.desc)}">${esc(r.desc)}${r.why ? ` <span class="chip ${r.why === 'לפי כלל' ? 'fixed' : 'var'}">${esc(r.why)}</span>` : ''}</td>
      <td class="n ${r.amt < 0 ? 'up' : ''}">${money(kind === 'bank' && r.amt < 0 ? -r.amt : r.amt)}${r.amt < 0 ? ` <span class="chip yes">${kind === 'bank' ? 'זכות' : 'זיכוי'}</span>` : ''}</td>
      <td>${MS[mo.m]} ${mo.y.slice(2)}</td>
      <td><select class="inp" style="min-width:210px;padding:5px 8px" data-row="${i}">${catOptions(r, kind)}</select></td></tr>`; }).join('')}
    ${!shown.length ? '<tr><td colspan="5" class="hint">כל התנועות סווגו ✓</td></tr>' : ''}
    </tbody></table></div>
    <div class="row"><button class="btn primary" id="txCommit" type="button" ${assigned.length || rows.some(r => r.v === 'skip' && !r.dup) ? '' : 'disabled'}>קליטת ${assigned.length} תנועות ל${kind === 'bank' ? 'הוצאות ולהכנסות' : 'הוצאות'}</button>
      <span class="hint">הסכומים <b>מתווספים</b> לסכום הקיים בכל קטגוריה וחודש. אפשר לבטל כל קליטה.</span></div>
  </section>` : ''}
  ${logHtml([kind])}
  ${rulesHtml()}`;
}
function txAfter(kind){
  const f = $('#txFile'); if (f) f.onchange = e => { const file = e.target.files[0]; if (file) onTxFile(file, kind); };
  const c = $('#txClear'); if (c) c.onclick = () => { resetImp(); render(); };
  const mo = $('#txMonth'); if (mo) mo.onchange = () => { IMP.monthMode = mo.value; keepScroll(); };
  const oo = $('#txOnlyOpen'); if (oo) oo.onchange = () => { IMP.onlyOpen = oo.checked; keepScroll(); };
  const le = $('#txLearn'); if (le) le.onchange = () => { IMP.learn = le.checked; };
  $$('[data-row]').forEach(s => s.onchange = () => {
    const r = IMP.rows[+s.dataset.row]; r.v = s.value; r.touched = true; r.why = '';
    if (s.value) { const n = normDesc(r.desc); IMP.rows.forEach(o => { if (o !== r && !o.v && !o.dup && normDesc(o.desc) === n) { o.v = s.value; o.touched = true; } }); }
    keepScroll();
  });
  const cm = $('#txCommit'); if (cm) cm.onclick = commitTx;
  bindMapper(); bindLogRules();
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
async function onPenFile(file){
  IMP.kind = 'pen'; IMP.file = file.name; IMP.penRows = []; IMP.msg = '';
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
  <section class="card"><div class="card-h"><h3>העלאת דוח פנסיה וקרנות</h3><span class="hint">xlsx · csv · pdf</span></div>
    <label class="btn primary" style="justify-self:start"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UP_ICON}</svg>בחירת קובץ<input type="file" id="penFile" accept=".xlsx,.xls,.csv,.pdf" hidden></label>
    ${IMP.kind === 'pen' && IMP.file ? `<p style="margin:0">קובץ: <b>${esc(IMP.file)}</b>${IMP.pdfUrl ? ` · <a href="${IMP.pdfUrl}" target="_blank" rel="noopener">פתיחת הדוח בחלון נפרד</a>` : ''}</p>` : ''}
    ${IMP.kind === 'pen' && IMP.msg ? `<p class="note" style="margin:0">${esc(IMP.msg)}</p>` : ''}
    <details class="note"><summary><b>מאיפה מורידים?</b></summary>
      <p><b>ריכוז כל הקופות:</b> דוח מהמסלקה הפנסיונית, דרך הסוכן הפנסיוני או באתר ״הר הכסף״ של משרד האוצר. <b>קופה בודדת:</b> הדוח הרבעוני או השנתי המקוצר מהאזור האישי בחברה המנהלת. <b>תיק השקעות או קרן כספית:</b> דוח יתרות מהבנק או מבית ההשקעות.</p>
      <p>מקובץ אקסל היתרות נקלטות ומשויכות לנכסים אוטומטית. מקובץ PDF מקלידים את היתרות בטבלה. העדכון משנה את שווי הנכסים במבט הכולל.</p></details>
  </section>
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
  const f = $('#penFile'); if (f) f.onchange = e => { const file = e.target.files[0]; if (file) onPenFile(file); };
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
