'use strict';
/* תחזיות – "מה המצב שלי בגיל X".
   Nothing changes: the same salary keeps flowing into the same funds, the same monthly savings, mortgages keep being paid.
   Every instrument is rolled forward month by month to the end of the year in which the chosen person reaches the chosen age.
   Inputs live on the page and are saved in D().settings.forecast. */

const FC_ICON = '<path d="M3 20h18"/><path d="M5 16l4-5 4 3 6-8"/><circle cx="19" cy="6" r="1.6"/>';
const FC_DEF = {who:'p1', show:null, age:60, saving:null, savRet:2, ret:7, infl:2.5, real:false, reRet:3, mortRate:4, stop1:67, stop2:65, coef:null, assets:{}};
const FC_GROUP_RET = {'תיקי מסחר עצמאי':7, 'קריפטו':7, 'קרנות הון (חול)':7, 'קרנות כספית':4, 'עוש אמריקה':0, 'מטח':0};
const FC_CAT = {pension:'פנסיה', study:'קרנות השתלמות', gemel:'גמל וביטוח מנהלים', liquid:'השקעות וחסכונות', save:'חיסכון חודשי', re:'נדל״ן (נטו)'};
const FC = {open:{}};

function FS(){
  const s = D().settings; s.forecast ||= {};
  const f = s.forecast;
  scenarioLoad('forecast', f);
  for (const [k, v] of Object.entries(FC_DEF)) if (f[k] === undefined) f[k] = typeof v === 'object' && v ? {} : v;
  if (!Array.isArray(f.show) || !f.show.length) f.show = ['p1', 'p2'];
  if (f.saving == null) f.saving = (typeof RS === 'function' && +RS().savings) || 0; // starts from the monthly savings in "פרישה מוקדמת"
  if (f.coef == null) f.coef = (typeof RS === 'function' && RS().pen1?.coef) || 200;
  return f;
}
const fcBirth = k => { const r = typeof RS === 'function' ? RS() : {}; return +(k === 'p1' ? r.birth1 : r.birth2) || (k === 'p1' ? 1980 : 1982); };
const fcName = k => (D().settings.people || {})[k] || k;

// default per-asset assumptions (return % a year, monthly deposit)
function assetAssume(a, F){
  const cur = F.assets[a.name];
  if (cur) return cur;
  return {ret:FC_GROUP_RET[a.group] ?? F.ret, dep:0}; // the monthly savings has its own line (F.saving)
}

/* ---------- the instruments ---------- */
function fcInstruments(F){
  const out = [], rep = D().pensionReport, people = ['p1', 'p2'];
  const short = {'קרן פנסיה חדשה מקיפה':'פנסיה מקיפה', 'קרן פנסיה חדשה כללית':'פנסיה משלימה', 'קרן השתלמות':'השתלמות', 'קופת גמל לתגמולים ופיצויים':'קופת גמל', 'ביטוח מנהלים':'ביטוח מנהלים'};
  if (rep?.people) {
    for (const k of people) for (const [i, f] of (rep.people[k]?.funds || []).entries()) {
      const cat = /פנסיה/.test(f.type) ? 'pension' : /השתלמות/.test(f.type) ? 'study' : 'gemel';
      const active = f.status === 'פעיל';
      // managers' insurance deposits are mostly insurance premiums → they do not build savings
      const dep = active && f.type !== 'ביטוח מנהלים' ? (f.deposit || 0) : 0;
      out.push({id:`${k}-${i}`, owner:k, cat, name:`${short[f.type] || f.type} · ${f.provider}`, now:f.balance || 0, dep, depNet:dep * (1 - (f.feeDep || 0) / 100),
        ret:F.ret, fee:f.feeAcc || 0, feeDep:f.feeDep || 0, reportPension:f.pensionWith});
    }
  } else { // no report yet: use the pension / study-fund assets
    for (const a of D().assets.filter(a => /פנסי|השתלמות/.test(a.group || ''))) {
      const k = a.name.includes(fcName('p2')) ? 'p2' : 'p1';
      out.push({id:'a-' + a.name, owner:k, cat:/פנסי/.test(a.group) ? 'pension' : 'study', name:a.name, now:assetValue(a), dep:0, depNet:0, ret:F.ret, fee:0, feeDep:0});
    }
  }
  for (const a of D().assets) {
    if (/פנסי|השתלמות/.test(a.group || '') && rep?.people) continue;
    if (/פנסי|השתלמות/.test(a.group || '')) continue;
    if (/נדל/.test(a.group || '')) { out.push({id:'re-' + a.name, owner:'', cat:'re', name:a.name, now:assetValue(a), dep:0, depNet:0, ret:F.reRet, fee:0, asset:a}); continue; }
    const as = assetAssume(a, F);
    out.push({id:'a-' + a.name, owner:'', cat:'liquid', name:a.name, group:a.group, now:assetValue(a), dep:+as.dep || 0, depNet:+as.dep || 0, ret:+as.ret, fee:0, asset:a});
  }
  // the household's monthly savings (what is left each month), set on the page
  if (+F.saving) out.push({id:'save', owner:'', cat:'save', name:'חיסכון חודשי (כסף פנוי)', now:0, dep:+F.saving, depNet:+F.saving, ret:+F.savRet || 0, fee:0});
  return out;
}
// loans: mortgages (balance, payment) from "פרישה מוקדמת" + the pension loan from the report
function fcLoans(F){
  const loans = [], used = new Set();
  const props = typeof RS === 'function' ? RS().props || [] : [];
  for (const p of props) {
    const l = D().liabilities.find(l => l.name === p.mortName); if (!l) continue;
    used.add(l.name); loans.push({name:l.name, prop:p.name, bal:liabValue(l), pay:+p.payment || 0, rate:F.mortRate});
  }
  const pl = D().pensionReport?.people?.p1?.loan;
  for (const l of D().liabilities) {
    if (used.has(l.name)) continue;
    const isPenLoan = /פנסיה/.test(l.name) && pl;
    loans.push({name:l.name, bal:liabValue(l), pay:isPenLoan ? pl.monthly : 0, rate:isPenLoan ? pl.rate : 0});
  }
  return loans;
}

/* ---------- simulation ---------- */
function fcRun(F){
  const now = new Date(), y0 = now.getFullYear(), m0 = now.getMonth();
  // who is shown: one person → only their funds; both → their funds plus everything shared (investments, real estate, loans)
  const show = F.show, both = show.length > 1;
  if (!both) F.who = show[0];
  const who = F.who, birth = fcBirth(who), Y = birth + (+F.age || 0);
  const months = Math.max(0, (Y - y0) * 12 + (11 - m0));
  const ins = fcInstruments(F).filter(i => i.owner ? show.includes(i.owner) : both), loans = both ? fcLoans(F) : [];
  const stopAt = {p1:(fcBirth('p1') + +F.stop1 - y0) * 12 + (11 - m0), p2:(fcBirth('p2') + +F.stop2 - y0) * 12 + (11 - m0)};
  const st = ins.map(i => ({...i, v:i.now, paid:0}));
  const ls = loans.map(l => ({...l, v:l.bal, end:null}));
  const start = fcSnap(st, ls), years = [{y:y0, ...start}];
  for (let m = 1; m <= months; m++) {
    for (const s of st) {
      const g = Math.pow(1 + s.ret / 100, 1 / 12) - 1 - s.fee / 1200;
      s.v = s.v * (1 + g);
      const working = !s.owner || m <= stopAt[s.owner];
      if (working && s.depNet) { s.v += s.depNet; s.paid += s.dep; }
    }
    for (const l of ls) {
      if (l.v <= 0) continue;
      l.v = l.v * (1 + l.rate / 1200) - l.pay;
      if (l.v <= 0) { l.v = 0; const d = new Date(y0, m0 + m, 1); l.end = d.getFullYear(); }
      else if (!l.pay) {} // no payment known → stays as is (plus interest if any)
    }
    if ((m0 + m) % 12 === 11 || m === months) { const y = new Date(y0, m0 + m, 1).getFullYear(); const last = years[years.length - 1]; const snap = {y, ...fcSnap(st, ls)}; if (last.y === y) years[years.length - 1] = snap; else years.push(snap); }
  }
  const disc = F.real ? Math.pow(1 + F.infl / 100, months / 12) : 1;
  return {Y, months, birth, st, ls, years, start, disc, both, show, ages:{p1:Y - fcBirth('p1'), p2:Y - fcBirth('p2')}};
}
function fcSnap(st, ls){
  const c = {}; for (const s of st) c[s.cat] = (c[s.cat] || 0) + s.v;
  const debt = sum(ls.map(l => Math.max(0, l.v)));
  const mort = sum(ls.filter(l => l.prop).map(l => Math.max(0, l.v)));
  return {pension:c.pension || 0, study:(c.study || 0) + (c.gemel || 0), liquid:c.liquid || 0, save:c.save || 0, re:(c.re || 0) - mort, debt, net:sum(Object.values(c)) - debt};
}

/* ---------- view ---------- */
VIEWS.forecast = () => {
  const F = FS(), R = fcRun(F), d = v => v / R.disc, M = v => money(d(v)), P = v => plain(d(v));
  const ppl = ['p1', 'p2'].filter(k => D().settings.people?.[k]), shown = ppl.filter(k => F.show.includes(k)), both = R.both;
  const whoLbl = both ? 'שניכם' : fcName(shown[0]);
  const nowY = new Date().getFullYear(), ageNow = nowY - fcBirth(F.who);
  const bad = +F.age <= ageNow;
  const by = cat => R.st.filter(s => s.cat === cat);
  const tot = cat => sum(by(cat).map(s => s.v));
  const fin = R.years[R.years.length - 1];
  const inp = (k, v) => `<input class="inp" data-fc="${k}" inputmode="decimal" value="${v}">`;
  const person = k => {
    const pen = by('pension').filter(s => s.owner === k), stu = by('study').filter(s => s.owner === k), gem = by('gemel').filter(s => s.owner === k);
    const penBal = sum(pen.map(s => s.v)), age = R.ages[k], stopAge = k === 'p1' ? +F.stop1 : +F.stop2;
    const ann = penBal / F.coef;
    const rep = D().pensionReport?.people?.[k];
    return `<section class="card fc-person"><div class="card-h"><h3>${esc(fcName(k))} <span class="hint">· בגיל ${age} ב־${R.Y}</span></h3>${age >= stopAge ? '<span class="chip var">כבר לא מפקידים</span>' : `<span class="chip yes">מפקידים עד גיל ${stopAge}</span>`}</div>
      <div class="fund-kpis">
        <div><span class="lbl">צבירה בפנסיה</span><b>${M(penBal)}</b><span class="hint">היום ${plain(sum(pen.map(s => s.now)))}</span></div>
        <div><span class="lbl">קצבה חודשית</span><b>${M(ann)}</b><span class="hint">צבירה ÷ מקדם ${F.coef}${age < 60 ? ' · אפשר למשוך מגיל 60' : ''}</span></div>
        <div><span class="lbl">קרנות השתלמות</span><b>${M(sum(stu.map(s => s.v)))}</b><span class="hint">היום ${plain(sum(stu.map(s => s.now)))}</span></div>
        ${gem.length ? `<div><span class="lbl">גמל וביטוח מנהלים</span><b>${M(sum(gem.map(s => s.v)))}</b><span class="hint">היום ${plain(sum(gem.map(s => s.now)))}</span></div>` : ''}
      </div>
      ${rep?.pensionWith ? `<p class="hint" style="margin:0">להשוואה: בדוח הסוכן הקצבה החזויה בגיל פרישה עם המשך הפקדות היא ${plain(rep.pensionWith)} (בערכים של הדוח).</p>` : ''}
    </section>`;
  };
  const rowsOf = cat => by(cat).sort((a, b) => b.v - a.v);
  const table = (cat, cols) => {
    const rows = rowsOf(cat); if (!rows.length) return '';
    const open = FC.open[cat] ?? true;
    return `<section class="card pbox ${open ? '' : 'closed'}"><div class="card-h pbox-h" data-fctog="${cat}" role="button" tabindex="0"><h3><span class="chev">▾</span>${FC_CAT[cat]}</h3><span class="hint">היום ${plain(sum(rows.map(s => s.now)))} → ב־${R.Y}: <b>${P(sum(rows.map(s => s.v)))}</b></span></div>
      <div class="pbox-b"><div class="tbl-wrap"><table><thead><tr><th>מכשיר</th>${cols.owner ? '<th>של</th>' : ''}<th class="n">היום</th><th class="n">הפקדה חודשית</th><th class="n">תשואה</th>${cols.fee ? '<th class="n">דמי ניהול</th>' : ''}<th class="n">ב־${R.Y}</th><th class="n">פי</th></tr></thead><tbody>
      ${rows.map(s => `<tr><td>${esc(s.name)}${s.group ? `<div class="hint" style="font-size:12px">${esc(s.group)}</div>` : ''}</td>${cols.owner ? `<td>${esc(fcName(s.owner))}</td>` : ''}<td class="n">${money(s.now)}</td><td class="n">${s.dep ? plain(s.dep) : '<span class="hint">—</span>'}</td><td class="n" dir="ltr">${s.ret}%</td>${cols.fee ? `<td class="n" dir="ltr">${s.fee.toFixed(2)}%</td>` : ''}<td class="n"><b>${M(s.v)}</b></td><td class="n hint">${s.now ? '×' + (d(s.v) / s.now).toFixed(1) : ''}</td></tr>`).join('')}
      </tbody></table></div></div></section>`;
  };
  const reRows = R.st.filter(s => s.cat === 're');
  const reTable = reRows.length ? `<section class="card"><div class="card-h"><h3>נדל״ן ומשכנתאות</h3><span class="hint">עליית ערך ${F.reRet}% בשנה · ריבית משכנתא ${F.mortRate}% · ההחזר החודשי מעמוד פרישה מוקדמת</span></div>
    <div class="grid2">
      <div class="tbl-wrap"><table><thead><tr><th>נכס</th><th class="n">שווי היום</th><th class="n">שווי ב־${R.Y}</th></tr></thead><tbody>
        ${reRows.map(s => `<tr><td>${esc(s.name)}</td><td class="n">${money(s.now)}</td><td class="n"><b>${M(s.v)}</b></td></tr>`).join('')}
        <tr class="total"><td>סה״כ</td><td class="n">${money(sum(reRows.map(s => s.now)))}</td><td class="n">${M(sum(reRows.map(s => s.v)))}</td></tr></tbody></table></div>
      <div class="tbl-wrap"><table><thead><tr><th>הלוואה</th><th class="n">היום</th><th class="n">ב־${R.Y}</th><th>מסתיימת</th></tr></thead><tbody>
        ${R.ls.filter(l => l.bal).map(l => `<tr><td>${esc(l.name)}${l.pay ? `<div class="hint" style="font-size:12px">${plain(l.pay)} בחודש</div>` : ''}</td><td class="n">${money(l.bal)}</td><td class="n"><b>${M(Math.max(0, l.v))}</b></td><td>${l.end ? `<span class="chip yes">${l.end}</span>` : l.pay ? `<span class="chip var">אחרי ${R.Y}</span>` : '<span class="hint">אין החזר ידוע</span>'}</td></tr>`).join('')}
        <tr class="total"><td>סה״כ</td><td class="n">${money(sum(R.ls.map(l => l.bal)))}</td><td class="n">${M(sum(R.ls.map(l => Math.max(0, l.v))))}</td><td></td></tr></tbody></table></div>
    </div></section>` : '';
  const assumeRows = D().assets.filter(a => !/פנסי|השתלמות|נדל/.test(a.group || '')).map(a => { const as = assetAssume(a, F); return `<tr><td>${esc(a.name)}<div class="hint" style="font-size:12px">${esc(a.group)}</div></td><td class="n">${money(assetValue(a))}</td>
    <td class="n"><input class="inp" data-fca="${esc(a.name)}|ret" inputmode="decimal" value="${as.ret}" style="width:64px"> %</td><td class="n"><input class="inp" data-fca="${esc(a.name)}|dep" inputmode="numeric" value="${as.dep}" style="width:90px"> ₪</td></tr>`; }).join('');

  return `
  <section class="card fc-ask">
    <div class="fc-q">
      ${ppl.map(k => `<label class="fc-chk ${F.show.includes(k) ? 'on' : ''}"><input type="checkbox" data-fcshow="${k}" ${F.show.includes(k) ? 'checked' : ''}> ${esc(fcName(k))}</label>`).join('')}
      <span class="fc-q-t">בגיל</span><input class="inp fc-age" data-fc="age" inputmode="numeric" value="${F.age}">
      ${both ? `<span class="hint">של</span><div class="seg seg-sm">${ppl.map(k => `<button type="button" class="${k === F.who ? 'on' : ''}" data-fcwho="${k}">${esc(fcName(k))}</button>`).join('')}</div>` : ''}
      <span class="hint">→ שנת <b>${R.Y}</b> · היום ${ageNow}${both ? ppl.filter(k => k !== F.who).map(k => ` · ${esc(fcName(k))} בגיל ${R.ages[k]}`).join('') : ''}</span>
    </div>
    <div class="fc-mini">
      <label>תשואה ${inp('ret', F.ret)}%</label>
      <label>מקדם ${inp('coef', F.coef)}</label>
      <label>הפקדות עד ${ppl.map(k => inp(k === 'p1' ? 'stop1' : 'stop2', k === 'p1' ? F.stop1 : F.stop2)).join('/')}</label>
      ${both ? `<label class="fc-save">חיסכון חודשי <input class="inp wide" data-fc="saving" inputmode="numeric" value="${F.saving}">₪</label><label title="החיסכון צמוד למדד – ברירת המחדל 2% בשנה">ריבית (צמוד) ${inp('savRet', F.savRet)}%</label>` : ''}
      ${both ? `<label>נדל״ן ${inp('reRet', F.reRet)}%</label><label>משכנתא ${inp('mortRate', F.mortRate)}%</label>` : ''}
      <label>אינפלציה ${inp('infl', F.infl)}%</label>
      <label class="fc-real"><input type="checkbox" data-fcchk="real" ${F.real ? 'checked' : ''}> בשקלים של היום</label>
      <span class="hint" title="אותה משכורת ואותן הפקדות לקרנות (לפי דוח הפנסיה), אותו חיסכון חודשי, המשכנתאות ממשיכות להשתלם">ⓘ הכל נמשך כמו היום · ${F.real ? 'בשקלים של היום' : 'נומינלי'}</span>
    </div>
  </section>
  ${bad ? `<section class="card"><p>הגיל צריך להיות גדול מהגיל היום (${ageNow}).</p></section>` : `
  <div class="kpis">
    <div class="kpi hero"><span class="lbl">${both ? 'שווי נקי' : 'סך החיסכון של ' + esc(whoLbl)} ב־${R.Y}</span><span class="val">${M(fin.net)}</span><span class="sub">היום ${plain(R.start.net)}</span></div>
    <div class="kpi"><span class="lbl">פנסיה${both ? ' (שניכם)' : ''}</span><span class="val">${M(tot('pension'))}</span><span class="sub">קצבה ${P(tot('pension') / F.coef)} בחודש</span></div>
    <div class="kpi"><span class="lbl">השתלמות וגמל</span><span class="val">${M(tot('study') + tot('gemel'))}</span><span class="sub">היום ${plain(sum([...by('study'), ...by('gemel')].map(s => s.now)))}</span></div>
    ${both && +F.saving ? (() => { const sv = R.st.find(x => x.cat === 'save'), paid = sv ? sv.paid : 0, val = sv ? sv.v : 0;
      return `<div class="kpi"><span class="lbl">חיסכון חודשי שנצבר</span><span class="val">${M(val)}</span><span class="sub">${plain(+F.saving)} בחודש × ${Math.round(R.months)} חודשים = ${plain(paid)} הופקדו${val - paid > 0 ? ` · ${P(val - paid)} רווח` : ''}</span></div>`; })() : ''}
    ${both ? `<div class="kpi"><span class="lbl">השקעות וחסכונות</span><span class="val">${M(tot('liquid'))}</span><span class="sub">ברוקרים, קרנות, קריפטו, פיקדונות</span></div>
    <div class="kpi"><span class="lbl">נדל״ן נטו</span><span class="val">${M(fin.re)}</span><span class="sub">שווי פחות משכנתאות</span></div>` : ''}
  </div>
  <div class="${shown.length > 1 ? 'grid2' : ''}">${shown.map(person).join('')}</div>
  <section class="card"><div class="card-h"><h3>איך זה נבנה, שנה אחרי שנה</h3><span class="hint">${F.real ? 'בשקלים של היום' : 'נומינלי'}</span></div><div class="chart tall"><canvas id="cFc"></canvas></div></section>
  ${table('pension', {owner:1, fee:1})}
  ${table('study', {owner:1, fee:1})}
  ${table('gemel', {owner:1, fee:1})}
  ${table('liquid', {})}
  ${table('save', {})}
  ${reTable}
  ${both ? '' : `<p class="hint">השקעות משותפות (ברוקרים, קרנות, קריפטו) ונדל״ן מוצגים כששניכם מסומנים.</p>`}
  ${!both ? '' : `<details class="card"><summary><b>הנחות לכל השקעה</b> <span class="hint">תשואה שנתית והפקדה חודשית לכל ברוקר / קרן / חשבון</span></summary>
    <div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>השקעה</th><th class="n">היום</th><th class="n">תשואה בשנה</th><th class="n">הפקדה בחודש</th></tr></thead><tbody>${assumeRows}</tbody></table></div>
    <p class="hint">החיסכון החודשי נקבע בראש העמוד (״חיסכון חודשי״) ונצבר בשורה נפרדת. כאן אפשר להוסיף הפקדה קבועה להשקעה מסוימת. בקרנות הפנסיה, ההשתלמות והגמל ההפקדות לקוחות מדוח הפנסיה, והתשואה היא ${F.ret}% פחות דמי הניהול של כל קרן.</p>
  </details>`}`}`;
};
VIEWS.forecast.after = () => {
  const F = FS(), re = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };
  const keep = () => scenarioSave('forecast', F); // stays on this device – no "save" needed
  const num = el => { const t = String(el.value).replace(/[,₪%\s]/g, ''); if (t === '' || t === '-' || isNaN(+t)) return null; return +t; };
  liveInputs('[data-fc]', 'data-fc', el => { const v = num(el); if (v == null) return false; F[el.dataset.fc] = v; keep(); });
  $$('[data-fcchk]').forEach(el => el.onchange = () => { F[el.dataset.fcchk] = el.checked; keep(); re(); });
  $$('[data-fcshow]').forEach(el => el.onchange = () => { const k = el.dataset.fcshow; const set = new Set(F.show); if (el.checked) set.add(k); else set.delete(k); if (!set.size) { el.checked = true; return toast('צריך לסמן לפחות אחד'); } F.show = ['p1', 'p2'].filter(x => set.has(x)); keep(); re(); });
  $$('[data-fcwho]').forEach(b => b.onclick = () => { F.who = b.dataset.fcwho; keep(); re(); });
  liveInputs('[data-fca]', 'data-fca', el => { const [name, k] = el.dataset.fca.split('|'), a = D().assets.find(a => a.name === name), v = num(el); if (v == null || !a) return false; F.assets[name] = {...assetAssume(a, F), [k]:v}; keep(); });
  $$('[data-fctog]').forEach(h => h.onclick = () => { const c = h.dataset.fctog; FC.open[c] = h.parentNode.classList.contains('closed'); re(); });
  const big = $('.fc-age'); if (big) big.onkeydown = e => { if (e.key === 'Enter') big.blur(); };
  const el = $('#cFc'); if (!el) return;
  const R = fcRun(F);
  const Ys = R.years, y0 = Ys[0].y, disc = y => F.real ? Math.pow(1 + F.infl / 100, y - y0) : 1;
  const ser = (k, i) => ({label:{pension:'פנסיה', study:'השתלמות וגמל', liquid:'השקעות וחסכונות', save:'חיסכון חודשי', re:'נדל״ן נטו'}[k], data:Ys.map(x => Math.round(x[k] / disc(x.y))), backgroundColor:pal(i), stack:'s'});
  chart('cFc', {type:'bar', stacked:true, data:{labels:Ys.map(x => `${x.y} (${x.y - fcBirth(F.who)})`), datasets:R.both ? [ser('pension', 0), ser('study', 1), ser('liquid', 2), ...(+F.saving ? [ser('save', 4)] : []), ser('re', 3)] : [ser('pension', 0), ser('study', 1)]}});
};

/* place "תחזיות" after "פנסיה וקרנות" (pens.js sets the final menu order) */
(function(){
  if (PAGES.some(p => p.id === 'forecast')) return;
  const i = PAGES.findIndex(p => p.id === 'inherit');
  PAGES.splice(i >= 0 ? i : PAGES.length, 0, {id:'forecast', t:'תחזיות', i:FC_ICON});
  if (S.data) { buildNav(); if (location.hash.slice(1) === 'forecast') { S.tab = 'forecast'; render(); } }
})();
