'use strict';
/* עדכון נתונים – חשבון חברת החשמל (מערכת סולארית).
   Reads the "זיכוי בגין יצור" table from the IEC PDF bill in the browser (pdf.js),
   assigns every meter-reading line to the month of its reading date and ADDS it to the
   solar income row (a month split between two bills gets both parts).
   Each bill is logged by its number, so the same bill can't be imported twice, and can be undone. */

KIND_LBL.solar = 'חשמל סולארי';
const SOLAR_DEFAULT = 'חברת חשמל (סולארי)';
const SOL = {file:null, bills:[], msg:'', busy:false, row:null};

function loadPdfJs(){
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = 'vendor/pdf.min.js';
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; ok(); };
    s.onerror = () => fail(new Error('רכיב קריאת ה־PDF לא נטען'));
    document.head.appendChild(s);
  });
}
async function pdfLines(file){
  await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({x:it.transform[4], y:it.transform[5], s:it.str.trim()}));
    items.sort((a, b) => b.y - a.y || b.x - a.x);
    let cur = null;
    for (const it of items) {
      if (!cur || Math.abs(cur.y - it.y) > 2.5) { cur = {y:it.y, items:[]}; lines.push(cur); }
      cur.items.push(it);
    }
  }
  return lines.map(l => l.items.sort((a, b) => b.x - a.x).map(i => i.s));
}
const solNum = s => { const m = String(s).replace(/,/g, '').match(/^(-)?(\d+\.\d\d)(-)?$/); return m ? +m[2] * (m[1] || m[3] ? -1 : 1) : null; };
function parseIec(lines){
  const flat = lines.map(t => t.join(' ')).join('\n');
  const billNo = (flat.match(/\b(20\d\d-\d{9})\b/) || [])[1] || null;
  let start = null, end = null;
  for (const toks of lines) {
    const ds = toks.join(' ').match(/\d\d\/\d\d\/20\d\d/g);
    if (ds && ds.length >= 2 && /תקופה|הפוקת/.test(toks.join(' '))) {
      const dd = ds.slice(0, 2).map(s => { const [d, m, y] = s.split('/'); return new Date(+y, +m - 1, +d); }).sort((a, b) => a - b);
      [start, end] = dd; break;
    }
  }
  const rows = [];
  let total = null;
  for (const toks of lines) {
    const line = toks.join(' ');
    const short = toks.map(t => t.match(/^(\d\d)\/(\d\d)$/)).filter(Boolean);
    const nums = toks.map(solNum).filter(v => v != null);
    if (short.length === 2 && nums.some(v => v < 0)) {
      const amt = -nums.filter(v => v < 0)[0];
      const mk = ([, d, m]) => {
        const cands = [start, end].filter(Boolean).map(b => new Date(b.getFullYear(), +m - 1, +d));
        const ok = cands.find(c => (!start || c >= new Date(start - 8 * 864e5)) && (!end || c <= new Date(+end + 8 * 864e5)));
        return ok || cands[0] || new Date(new Date().getFullYear(), +m - 1, +d);
      };
      const [a, b] = short.map(mk).sort((x, y) => x - y);
      rows.push({from:a, to:b, amt:r2(amt), kwh:(() => { const price = nums.find(v => v > 5 && v < 300); return price ? Math.round(amt * 100 / price) : null; })()});
    } else if (/יצור|רוצי/.test(line) && /סה"?כ|כ"הס/.test(line) && !short.length && nums.length) {
      total = Math.abs(nums.find(v => v < 0) ?? nums[0]);
    }
  }
  return {billNo, start, end, rows, total};
}
function solarIncName(){
  const names = incList();
  return SOL.row || names.find(n => /סולאר/.test(n)) || names.find(n => /חשמל/.test(n)) || SOLAR_DEFAULT; // a missing row is created on import
}
const billKey = b => 'iec|' + (b.billNo || `${fmtDate(b.start)}-${fmtDate(b.end)}`);
function billSeen(b){
  const k = billKey(b);
  return impData().log.some(l => l.key === k) || (D().meta.importedDocs || []).some(x => b.billNo && x.includes(b.billNo));
}
// several bills at once: each is read and checked on its own, then all new readings go in together (one undo entry per bill)
async function onSolarFiles(files){
  Object.assign(SOL, {file:files.map(f => f.name).join(', '), bill:null, bills:[], msg:'', busy:true}); render();
  for (const f of files) {
    try {
      if (!/\.pdf$/i.test(f.name)) throw new Error('יש לבחור את קובץ ה־PDF של החשבון');
      const bill = parseIec(await pdfLines(f));
      if (!bill.rows.length) throw new Error('לא נמצאה טבלת "זיכוי בגין יצור" – ודאו שזה חשבון חברת החשמל של המערכת הסולארית');
      if (SOL.bills.some(x => x.bill && billKey(x.bill) === billKey(bill))) continue; // same bill chosen twice
      SOL.bills.push({file:f.name, bill});
    } catch (e) { console.error(e); SOL.bills.push({file:f.name, err:e.message}); }
  }
  SOL.bills.sort((x, y) => (x.bill?.start || 0) - (y.bill?.start || 0));
  SOL.busy = false; render();
}
const solNew = () => (SOL.bills || []).filter(x => x.bill && !billSeen(x.bill));
function commitSolar(){
  const list = solNew(); if (!list.length) return;
  const n = solarIncName(); let tot = 0;
  for (const {file, bill:b} of list) {
    const deltas = [];
    for (const r of b.rows) { const x = {t:'i', y:String(r.to.getFullYear()), n, m:r.to.getMonth(), v:r.amt}; applyDelta(x, 1); deltas.push(x); }
    const t = r2(sum(b.rows.map(r => r.amt))); tot += t;
    impData().log.unshift({id:Date.now() + Math.random(), kind:'solar', key:billKey(b), file:file + (b.billNo ? ' · ' + b.billNo : ''), date:today(), n:deltas.length, total:t, deltas, hashes:[]});
  }
  markDirty(); toast(`נקלטו ${list.length} חשבונות: נוספו ${plain(tot)} להכנסות "${n}". לחצו "שמירה" כדי לשמור.`, 4500);
  Object.assign(SOL, {file:null, bills:[], msg:''}); render();
}
const SUN_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
VIEWS.upSolar = () => {
  const bills = SOL.bills || [], ok = bills.filter(x => x.bill), fresh = solNew(), n = solarIncName();
  const curVal = r => { const y = String(r.to.getFullYear()), row = (D().incomes[y] || []).find(x => x.name === n); return row ? +row.months[r.to.getMonth()] || 0 : 0; };
  const rows = fresh.flatMap(x => x.bill.rows.map(r => ({...r, file:x.file, billNo:x.bill.billNo}))).sort((a, b) => a.to - b.to);
  const sumRows = r2(sum(rows.map(r => r.amt)));
  // months that receive more than one reading (from one bill or several) are shown with the combined "after" value
  const after = {}; for (const r of rows) { const k = ymKey(r.to); after[k] = (after[k] ?? curVal(r)) + r.amt; }
  return `
  <section class="card"><div class="card-h"><h3>העלאת חשבון חברת החשמל</h3><span class="hint">PDF · אפשר כמה חשבונות יחד · הקובץ נקרא רק במכשיר הזה</span></div>
    <label class="btn primary" style="justify-self:start"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${UP_ICON}</svg>בחירת חשבונות (PDF, אפשר כמה יחד)<input type="file" id="solFile" accept=".pdf,application/pdf" multiple hidden></label>
    ${SOL.file ? `<p style="margin:0">קבצים: <b>${esc(SOL.file)}</b>${SOL.busy ? ' · קורא…' : ''} <button class="btn small ghost" id="solClear" type="button">ניקוי</button></p>` : ''}
    ${bills.length ? `<ul class="pdf-info">${bills.map(x => { if (x.err) return `<li class="down">${esc(x.file)}: ${esc(x.err)}</li>`; const b = x.bill, t = r2(sum(b.rows.map(r => r.amt))), okT = b.total == null || Math.abs(b.total - t) < 0.05, seen = billSeen(b);
      return `<li class="${seen || !okT ? 'down' : ''}">${esc(x.file)} · חשבונית ${esc(b.billNo || '—')} · ${fmtDate(b.start)}–${fmtDate(b.end)}: ${b.rows.length} קריאות, ${plain(t)}${b.total == null ? '' : okT ? ' ✓ תואם לסה״כ בחשבון' : ` ⚠ בחשבון כתוב ${plain(b.total)}`}${seen ? ' · כבר נקלט – יידלג' : ''}</li>`; }).join('')}</ul>` : ''}
    ${SOL.msg ? `<p class="note" style="margin:0">${esc(SOL.msg)}</p>` : ''}
    <details class="note"><summary><b>מה נקלט ואיך?</b></summary>
      <p>מכל חשבון נלקחת רק טבלת <b>"זיכוי בגין יצור"</b> (עמוד 2). כל שורת קריאה נכנסת לחודש של תאריך הקריאה, ו<b>מתווספת</b> לסכום שכבר קיים באותו חודש. כך חודש שמתחלק בין שני חשבונות מקבל את שני החלקים.</p>
      <p>עלות מערכתית, מע"מ וזיכויי ריבית לא נכנסים. חשבון שכבר נקלט מזוהה לפי מספר החשבונית ולא ייקלט פעמיים. בדף הבנק מסמנים את זיכוי חברת החשמל כ"דילוג", כדי שלא ייספר פעמיים.</p></details>
  </section>
  ${ok.length ? `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">זיכוי ייצור לקליטה</span><span class="val">${money(sumRows)}</span><span class="sub">${fresh.length} חשבונות · ${rows.length} קריאות</span></div>
    <div class="kpi"><span class="lbl">חשבונות שכבר נקלטו</span><span class="val" style="font-size:18px">${ok.length - fresh.length}</span><span class="sub">${ok.length - fresh.length ? 'לא ייקלטו שוב' : 'אין'}</span></div>
  </div>
  ${rows.length ? `<section class="card"><div class="card-h"><h3>קריאות מונה</h3>
      <label class="field" style="max-width:260px">קליטה לשורת הכנסה<select class="inp" id="solRow">${[...new Set([...incList(), n])].map(x => `<option ${x === n ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label></div>
    <div class="tbl-wrap"><table><thead><tr><th>תקופת קריאה</th><th>חודש</th>${fresh.length > 1 ? '<th>חשבונית</th>' : ''}<th class="n">קוט"ש</th><th class="n">זיכוי</th><th class="n">קיים בחודש</th><th class="n">אחרי הקליטה</th></tr></thead><tbody>
    ${rows.map((r, i) => { const k = ymKey(r.to), last = rows.findLastIndex(x => ymKey(x.to) === k) === i; return `<tr>
      <td>${fmtDate(r.from)} – ${fmtDate(r.to)}</td><td>${MONTHS[r.to.getMonth()]} ${r.to.getFullYear()}</td>${fresh.length > 1 ? `<td class="hint">${esc(r.billNo || '')}</td>` : ''}<td class="n">${r.kwh ?? ''}</td>
      <td class="n up">${money(r.amt)}</td><td class="n">${money(curVal(r))}</td><td class="n"><b>${last ? money(after[k]) : '↓'}</b></td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="row"><button class="btn primary" id="solCommit" type="button">הוספה להכנסות${fresh.length > 1 ? ` (${fresh.length} חשבונות)` : ''}</button>
      <span class="hint">כל חשבון נרשם בנפרד ב״קליטות אחרונות״ – אפשר לבטל כל אחד.</span></div>
  </section>` : `<section class="card"><p class="hint" style="margin:0">כל החשבונות שנבחרו כבר נקלטו. כדי לקלוט מחדש, בטלו קודם את הקליטה הקודמת למטה.</p></section>`}` : ''}
  ${logHtml(['solar'])}`;
};
VIEWS.upSolar.after = () => {
  const f = $('#solFile'); if (f) f.onchange = e => { const fs = [...(e.target.files || [])]; if (fs.length) onSolarFiles(fs); };
  const c = $('#solClear'); if (c) c.onclick = () => { Object.assign(SOL, {file:null, bills:[], msg:''}); render(); };
  const r = $('#solRow'); if (r) r.onchange = () => { SOL.row = r.value; keepScroll(); };
  const cm = $('#solCommit'); if (cm) cm.onclick = commitSolar;
  bindLogRules();
};

/* add the page to the "עדכון נתונים" menu, right after the pension upload */
(function(){
  if (PAGES.some(p => p.id === 'upSolar')) return;
  const i = PAGES.findIndex(p => p.id === 'upPen');
  PAGES.splice(i >= 0 ? i + 1 : PAGES.length, 0, {id:'upSolar', t:'העלאת חשבון חשמל (סולארי)', sec:'עדכון נתונים', i:SUN_ICON});
  if (S.data) { buildNav(); if (location.hash.slice(1) === 'upSolar') { S.tab = 'upSolar'; render(); } }
})();
