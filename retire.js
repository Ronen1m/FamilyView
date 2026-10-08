'use strict';
/* פרישה מוקדמת – year-by-year simulation in today's money (real terms).
   Phases, as in the Israeli early-retirement calculators:
   1. Work until the chosen retirement year: monthly savings go into the liquid portfolio, pension keeps receiving deposits.
   2. "Bridge": from retirement until each pension starts – income = net rent (after mortgages and rent tax) + other income,
      and the gap to the desired income is withdrawn from the liquid portfolio (grossed up for 25% capital-gains tax on the gain part).
   3. From pension age – add the pension annuity (balance at start ÷ conversion coefficient) and National Insurance old-age pension.
   The earliest retirement year is the first year in which the portfolio never runs out until the end age. */

const RET_DEF = {
  desired: null, birth1: 1978, birth2: 1980, planYear: null, endAge: 90,
  realReturn: 4, pensionReturn: 3.5, mortRate: 3, gainShare: 40, cgt: 25, rentTax: 10,
  savings: null, other: null,
  pen1: {age:67, coef:200, deposit:9000}, pen2: {age:65, coef:200, deposit:6700},
  bl1: {age:67, amount:2750}, bl2: {age:65, amount:2750},
  payoffAtRetire: false, liquidGroups: null, props: null,
};
const normKey = s => String(s || '').replace(/\n/g, ' ').replace(/^(משכנתא|שכירות|הוצאות דירה)\s*/, '').replace(/porto|פורטו/i, 'פורטו').replace(/APR|ABNB/gi, '').replace(/[\s\-:"'()]/g, '').toLowerCase();
const nearYear = () => String(new Date().getFullYear());
function lastNonZero(arr){ for (let i = arr.length - 1; i >= 0; i--) if (+arr[i]) return +arr[i]; return 0; }
function avgNonZero(arr){ const v = arr.filter(x => +x); return v.length ? sum(v) / v.length : 0; }
function fullYear(){ const y = +nearYear(); return String(D().expenses[String(y - 1)] ? y - 1 : y); }

/* ---------- defaults from the family data ---------- */
function defaultProps(){
  const y = nearYear(), inc = D().incomes[y] || [], exp = D().expenses[fullYear()] || [], expNow = D().expenses[y] || [];
  const props = [];
  const add = (name) => { let p = props.find(p => p.key === normKey(name)); if (!p) { p = {key:normKey(name), name, rent:0, mortgage:0, payment:0, costs:0, use:true}; props.push(p); } return p; };
  for (const l of D().liabilities) if (/משכנתא/.test(l.name) && liabValue(l) > 0) { const p = add(l.name.replace(/^משכנתא\s*/, '')); p.mortgage = Math.round(liabValue(l)); p.mortName = l.name; }
  for (const r of inc) if (/שכירות|ABNB/i.test(r.name)) {
    const k = normKey(r.name);
    const p = props.find(p => k.startsWith(p.key) || p.key.startsWith(k)) || add(r.name.replace(/^שכירות\s*/, '').replace(/\s*APR ABNB/i, ''));
    p.rent += Math.round(/ABNB/i.test(r.name) ? avgNonZero(r.months) : lastNonZero(r.months));
  }
  for (const p of props) {
    const dom = expNow.find(g => normKey(g.domain).startsWith(p.key) || (p.key && normKey(g.domain).includes(p.key)));
    if (dom) {
      const m = dom.items.find(i => /^משכנתא/.test(i.name.trim())); if (m) p.payment = Math.round(lastNonZero(m.months));
      const domFull = exp.find(g => g.domain === dom.domain) || dom;
      p.costs = Math.round(sum(domFull.items.filter(i => !/משכנתא/.test(i.name)).map(i => avgNonZero(i.months.slice(0, 12)) * i.months.filter(x => +x).length / 12)));
    }
  }
  return props.filter(p => p.rent || p.mortgage);
}
function defaultLiquid(){ return D().assetGroups.filter(g => !/נדל|פנסי/.test(g)); }
function defaultDesired(){
  const y = fullYear(), e = expYear(y), act = activeMonths(e.reported);
  const skip = /משכנתא|הלוו?אה|הפקדה|השתלמות/;
  const removable = sum((D().expenses[y] || []).flatMap(g => g.items.filter(i => skip.test(i.name) || /הלוואות/.test(g.domain)).map(i => sum(i.months))));
  return Math.round((sum(e.reported) - removable) / Math.max(1, act.length) / 1000) * 1000;
}
function defaultSavings(){
  const y = fullYear(), b = balanceYear(y), act = activeMonths(b.inc).filter(i => b.exp[i]);
  const mort = sum(defaultProps().map(p => p.payment)); // mortgage principal is already counted in expenses; keep savings net
  return Math.max(0, Math.round(sum(act.map(i => b.free[i])) / Math.max(1, act.length) / 500) * 500);
}
function defaultOther(){
  const inc = D().incomes[nearYear()] || [], r = inc.find(r => /סולאר/.test(r.name));
  return r ? Math.round(avgNonZero(r.months)) : 0;
}
function RS(){
  const s = D().settings;
  if (!s.retire) s.retire = {};
  const r = s.retire;
  for (const [k, v] of Object.entries(RET_DEF)) if (r[k] === undefined) r[k] = typeof v === 'object' && v ? JSON.parse(JSON.stringify(v)) : v;
  if (r.desired == null) r.desired = defaultDesired();
  if (r.savings == null) r.savings = defaultSavings();
  if (r.other == null) r.other = defaultOther();
  if (!r.liquidGroups) r.liquidGroups = defaultLiquid();
  if (!r.props) r.props = defaultProps();
  return r;
}

/* ---------- simulation ---------- */
function liquidNow(r){ return sum(D().assets.filter(a => r.liquidGroups.includes(a.group)).map(assetValue)); }
function pensionNow(i){ const p = [D().settings.people.p1, D().settings.people.p2][i]; const a = D().assets.find(a => /פנסי/.test(a.group || '') && a.name.includes(p)); return a ? assetValue(a) : 0; }
function simulate(r, R){
  const y0 = +nearYear(), rr = r.realReturn / 100, rp = r.pensionReturn / 100, mi = r.mortRate / 100;
  const tax = 1 - (r.cgt / 100) * (r.gainShare / 100);
  const P0 = liquidNow(r);
  let P = P0, saved = 0, drawn = 0, surplus = 0, growthAfter = 0, payoff = 0;
  const pen = [{bal:pensionNow(0), monthly:0, ...r.pen1, birth:r.birth1}, {bal:pensionNow(1), monthly:0, ...r.pen2, birth:r.birth2}];
  const bl = [{...r.bl1, birth:r.birth1}, {...r.bl2, birth:r.birth2}];
  const props = r.props.filter(p => p.use).map(p => ({...p, bal:+p.mortgage || 0, end:(+p.mortgage || 0) > 0 ? null : 'none'}));
  const rows = []; let fail = null, atRetire = null, startP = null;
  const endYear = r.birth1 + r.endAge;
  for (let y = y0; y <= endYear; y++) {
    const working = y < R;
    if (y === R) startP = P;
    if (y === R && r.payoffAtRetire) { payoff = sum(props.map(p => p.bal)); P -= payoff; props.forEach(p => { if (p.bal > 0) { p.bal = 0; p.end = y; } }); }
    let mortPay = 0; const payBy = {};
    for (const p of props) if (p.bal > 0 && p.payment > 0) {
      const due = p.bal * (1 + mi), pay = Math.min(due, p.payment * 12);
      p.bal = Math.max(0, due - pay); mortPay += pay; payBy[p.name] = pay;
      if (p.bal <= 0 && !p.end) p.end = y;
    }
    const rentGross = sum(props.map(p => (+p.rent || 0) * 12)), costs = sum(props.map(p => (+p.costs || 0) * 12));
    const rentTaxAmt = rentGross * r.rentTax / 100;
    const rentNet = rentGross - rentTaxAmt - costs - mortPay;
    let pension = 0, natIns = 0; const penBy = [0, 0], blBy = [0, 0];
    pen.forEach((p, i) => {
      const age = y - p.birth;
      if (age < p.age) { if (working) p.bal += p.deposit * 12; p.bal *= 1 + rp; }
      else { if (!p.monthly) p.monthly = p.bal / p.coef; pension += p.monthly * 12; penBy[i] = p.monthly * 12; }
    });
    bl.forEach((b, i) => { if (y - b.birth >= b.age) { natIns += b.amount * 12; blBy[i] = b.amount * 12; } });
    const other = (+r.other || 0) * 12, want = r.desired * 12;
    let draw = 0;
    if (working) { P += r.savings * 12; saved += r.savings * 12; }
    else {
      const gap = want - (rentNet + pension + natIns + other);
      if (gap > 0) { draw = gap / tax; P -= draw; drawn += draw; } else { P -= gap; surplus += -gap; }
    }
    if (y === R) atRetire = {P:startP, rentGross, rentTaxAmt, costs, mortPay, payBy, rentNet, pension, penBy, natIns, blBy, other, gap:want - (rentNet + pension + natIns + other)};
    if (P < 0 && fail == null && !working) fail = y;
    rows.push({y, age1:y - r.birth1, age2:y - r.birth2, working, P:Math.max(P, 0), rentNet, pension, natIns, other, draw:working ? 0 : Math.min(draw, draw + Math.min(P, 0)), want, mortBal:sum(props.map(p => p.bal))});
    const g = P * rr; if (!working) growthAfter += g; P += g;
  }
  const ends = props.filter(p => +p.mortgage > 0).map(p => ({name:p.name, end:p.payment > 0 || p.end ? p.end : null, noPay:!p.payment && p.end !== R}));
  const known = ends.filter(e => e.end).map(e => e.end);
  const mortFree = known.length ? Math.max(...known) : null;
  return {rows, fail, mortFree, ends, atRetire, ok:fail == null, P0, saved, drawn, surplus, growthAfter, payoff, startP, endP:rows.length ? rows[rows.length - 1].P : 0};
}
function earliest(r){
  const y0 = +nearYear(), last = r.birth1 + 67;
  for (let R = y0; R <= last; R++) if (simulate(r, R).ok) return R;
  return null;
}

/* ---------- view ---------- */

const RET_INFO = {open:null};
const ib = key => `<button class="info-btn ${RET_INFO.open === key ? 'on' : ''}" data-info="${key}" type="button" title="מה זה ואיך מחושב" aria-label="הסבר">!</button>`;
function mortSub(sim){
  const k = sim.ends.filter(e => e.end).sort((a, b) => a.end - b.end), miss = sim.ends.filter(e => !e.end);
  if (!sim.ends.length) return 'אין משכנתאות';
  const parts = k.map(e => `${e.name} ${e.end}`);
  return (parts.length > 1 ? 'לפי נכס: ' : '') + parts.join(' · ') + (miss.length ? ` · ${miss.map(e => e.name).join(', ')}: חסר החזר` : '');
}
function infoTitle(k, R){ return {best:'פרישה מוקדמת אפשרית – איך נקבעת השנה', check:`בדיקת פרישה ב־${R} – מה המשמעות`, passive:`הכנסה פסיבית ב־${R} – מאיפה מגיע הכסף`, liquid:'מה זה התיק הנזיל ומאיפה הסכום', mort:'מתי נגמרות המשכנתאות'}[k]; }
function infoBody(k, r, R, best, sim){
  const at = sim.atRetire || {}, p1 = D().settings.people.p1, p2 = D().settings.people.p2, m = v => plain(v / 12), row = (a, b, cls = '') => `<tr class="${cls}"><td>${a}</td><td class="n">${b}</td></tr>`;
  const tbl = rows => `<div class="tbl-wrap"><table><tbody>${rows}</tbody></table></div>`;
  if (k === 'best') return `<p class="info-p">בודקים כל שנה, מהיום ועד ש${esc(p1)} בן 67, ומריצים את כל התוכנית קדימה עד גיל ${r.endAge}. השנה המוקדמת היא <b>הראשונה שבה התיק הנזיל לא מתרוקן אף פעם</b> – כלומר כל שנה, השכירות נטו + הקצבאות + ההכנסות הנוספות, יחד עם משיכה מהתיק, מכסים את היעד של ${plain(r.desired)} לחודש.</p>
    <p class="info-p">מה מקדים את השנה: יעד נמוך יותר, חיסכון חודשי גבוה יותר, תשואה גבוהה יותר, סיום מוקדם של משכנתאות. מה מאחר: יעד גבוה, תחילת קצבה מאוחרת, נכסים שלא מסומנים כנזילים.</p>
    ${best ? `<p class="info-p">התוצאה כרגע: <b>${best}</b> – ${esc(p1)} בגיל ${best - r.birth1}, ${esc(p2)} בגיל ${best - r.birth2}.</p>` : ''}`;
  if (k === 'check') return `<p class="info-p"><b>"הכסף מספיק"</b> = אם פורשים ב־${R}, בכל שנה עד גיל ${r.endAge} יש מספיק כסף ליעד של ${plain(r.desired)} לחודש, והתיק הנזיל לא יורד מתחת לאפס. <b>"נשאר"</b> = כמה יישאר בתיק הנזיל בגיל ${r.endAge}, בכסף של היום. זה בנוסף לדירות, שנשארות בבעלותכם (ולא נמכרות בחישוב).</p>
    ${tbl(row('תיק נזיל בתחילת ' + R, plain(sim.startP)) + (sim.payoff ? row('סילוק משכנתאות בפרישה', '−' + plain(sim.payoff)) : '') + row('נמשך מהתיק לאורך השנים (כולל מס רווחי הון)', '−' + plain(sim.drawn)) + row('עודפים שהוחזרו לתיק (שנים שההכנסה הפסיבית גבוהה מהיעד)', '+' + plain(sim.surplus)) + row(`תשואה ריאלית של ${r.realReturn}% בשנה`, '+' + plain(sim.growthAfter)) + row(`נשאר בגיל ${r.endAge}`, plain(sim.endP), 'total'))}
    <p class="info-p hint">מגיל הקצבה ההכנסה הפסיבית בדרך כלל גבוהה מהיעד, ולכן התיק חוזר לגדול – זה מה שיוצר את הסכום הגדול בסוף. אם רוצים לחיות על יותר, מעלים את היעד.</p>`;
  if (k === 'passive') {
    const pr = Object.entries(at.payBy || {}).map(([n, v]) => row('&nbsp;&nbsp;החזר משכנתא – ' + esc(n), '−' + m(v))).join('');
    return `<p class="info-p">הכנסה שמגיעה בלי לעבוד, בחודש ממוצע של ${R}. ההפרש עד היעד נמשך מהתיק הנזיל (ראו "תיק נזיל").</p>
    ${tbl(row('שכירות ברוטו (כל הנכסים המסומנים)', m(at.rentGross)) + row(`מס על שכירות ${r.rentTax}%`, '−' + m(at.rentTaxAmt)) + row('הוצאות שוטפות של הדירות', '−' + m(at.costs)) + pr + row('<b>שכירות נטו</b>', m(at.rentNet)) +
      row('קצבת פנסיה – ' + esc(p1), at.penBy[0] ? m(at.penBy[0]) : `מגיל ${r.pen1.age}`) + row('קצבת פנסיה – ' + esc(p2), at.penBy[1] ? m(at.penBy[1]) : `מגיל ${r.pen2.age}`) +
      row('ביטוח לאומי – ' + esc(p1), at.blBy[0] ? m(at.blBy[0]) : `מגיל ${r.bl1.age}`) + row('ביטוח לאומי – ' + esc(p2), at.blBy[1] ? m(at.blBy[1]) : `מגיל ${r.bl2.age}`) +
      row('הכנסות נוספות (סולארי וכו׳)', m(at.other)) + row('סה״כ הכנסה פסיבית', m(at.rentNet + at.pension + at.natIns + at.other), 'total') + row('היעד', m(r.desired * 12)) +
      row(at.gap > 0 ? 'חסר – נמשך מהתיק הנזיל' : 'עודף – חוזר לתיק', m(Math.abs(at.gap)), 'total'))}
    <p class="info-p hint">את הסכומים משנים בטבלאות "נכסים מניבים", "קצבאות" ו"הנחות" למטה.</p>`;
  }
  if (k === 'liquid') {
    const gs = r.liquidGroups.map(g => [g, sum(D().assets.filter(a => a.group === g).map(assetValue))]).filter(x => x[1]);
    const years = Math.max(0, R - +nearYear());
    return `<p class="info-p"><b>תיק נזיל</b> = כסף שאפשר לממש ולמשוך ממנו בפרישה – לא דירות ולא פנסיה. הסכומים נלקחים מעמוד "מבט כולל", לפי סוגי הנכסים שמסומנים ב"הנחות" למטה.</p>
    ${tbl(gs.map(([g, v]) => row(esc(g), plain(v))).join('') + row('סה״כ היום', plain(sim.P0), 'total') +
      row(`חיסכון ${plain(r.savings)} לחודש × ${years} שנים`, '+' + plain(sim.saved)) + row(`תשואה ריאלית ${r.realReturn}% עד ${R}`, '+' + plain(sim.startP - sim.P0 - sim.saved)) + row(`בתחילת ${R}`, plain(sim.startP), 'total'))}
    <p class="info-p hint">"כלל 4%" הוא כלל אצבע: אפשר למשוך כ־4% מהתיק בשנה לאורך זמן. כאן: ${plain(sim.startP * 0.04 / 12)} לחודש. החישוב בעמוד מדויק יותר – שנה אחרי שנה.</p>`;
  }
  if (k === 'mort') return `<p class="info-p">כל משכנתא מחושבת בנפרד: היתרה גדלה בריבית הריאלית (${r.mortRate}%) ופוחתת בהחזר החודשי, עד שהיא מגיעה לאפס. המספר בריבוע הוא <b>השנה של המשכנתא האחרונה</b> – מאז כל השכירות נכנסת להכנסה.${r.payoffAtRetire ? ' מסומן סילוק מוקדם – כל היתרות נסגרות מהתיק הנזיל בשנת הפרישה.' : ''}</p>
    ${tbl(sim.ends.map(e => row(esc(e.name), e.end ? String(e.end) : 'לא מחושב – חסר החזר חודשי')).join(''))}
    <p class="info-p hint">יתרה והחזר לכל נכס – בטבלת "נכסים מניבים". נכס בלי החזר חודשי לא נכלל בחישוב סיום המשכנתאות.</p>`;
  return '';
}

const RET_ICON = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M4 4l3 3"/>';
function rin(path, val, opt={}){ return `<input class="${opt.cls || 'inp'}" data-ret="${path}" inputmode="decimal" value="${esc(val ?? '')}" ${opt.w ? `style="width:${opt.w}"` : ''}>`; }
VIEWS.retire = () => {
  const r = RS(), y0 = +nearYear();
  const best = earliest(r);
  const R = r.planYear || best || y0 + 10;
  const sim = simulate(r, R), at = sim.atRetire || {};
  const p1 = D().settings.people.p1, p2 = D().settings.people.p2;
  const passive = (at.rentNet || 0) + (at.pension || 0) + (at.natIns || 0) + (at.other || 0);
  const cover = passive / (r.desired * 12);
  const swr = (at.P || 0) * 0.04;
  const groups = D().assetGroups;
  return `
  <section class="card retire-top">
    <div class="card-h"><h3>מה היעד?</h3><span class="hint">כל הסכומים בשקלים של היום (אחרי אינפלציה)</span></div>
    <div class="row" style="align-items:flex-end">
      <label class="field big">הכנסה חודשית נטו מבוקשת בפרישה ${rin('desired', r.desired, {cls:'inp big-inp'})}</label>
      <label class="field">שנת פרישה לבדיקה<select class="inp" id="retPlan"><option value="">המוקדמת ביותר – ${best || "אין"}</option>${Array.from({length:30}, (_, k) => y0 + k).map(y => `<option ${r.planYear === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label class="field">חיסכון חודשי עד הפרישה ${rin('savings', r.savings)}</label>
      <label class="field">שנת לידה ${esc(p1)} ${rin('birth1', r.birth1)}</label>
      <label class="field">שנת לידה ${esc(p2)} ${rin('birth2', r.birth2)}</label>
    </div>
  </section>
  <div class="kpis">
    <div class="kpi hero">${ib('best')}<span class="lbl">פרישה מוקדמת אפשרית</span><span class="val">${best ? best : 'לא לפני 67'}</span><span class="sub">${best ? `${esc(p1)} בגיל ${best - r.birth1} · ${esc(p2)} בגיל ${best - r.birth2}` : 'הכסף לא מספיק עד גיל ' + r.endAge}</span></div>
    <div class="kpi">${ib('check')}<span class="lbl">בדיקת פרישה ב־${R}</span><span class="val ${sim.ok ? 'up' : 'down'}">${sim.ok ? '✓ הכסף מספיק' : '✗ הכסף לא מספיק'}</span><span class="sub">${sim.ok ? `בגיל ${r.endAge} יישארו בתיק הנזיל ${plain(sim.endP)}` : `התיק הנזיל מתרוקן ב־${sim.fail} (גיל ${sim.fail - r.birth1})`}</span></div>
    <div class="kpi">${ib('passive')}<span class="lbl">הכנסה פסיבית ב־${R}</span><span class="val">${money(passive / 12)}</span><span class="sub">${pct(cover)} מהיעד · ${at.gap > 0 ? `${plain(at.gap / 12)} נמשכים מהתיק הנזיל` : 'אין צורך למשוך מהתיק'}</span></div>
    <div class="kpi">${ib('liquid')}<span class="lbl">תיק נזיל בתחילת ${R}</span><span class="val">${money(at.P)}</span><span class="sub">היום ${plain(sim.P0)} + חיסכון ותשואה עד הפרישה</span></div>
    <div class="kpi">${ib('mort')}<span class="lbl">המשכנתא האחרונה מסתיימת</span><span class="val">${sim.mortFree || '—'}</span><span class="sub">${mortSub(sim)}</span></div>
  </div>
  ${RET_INFO.open ? `<section class="card info-panel"><div class="card-h"><h3>${esc(infoTitle(RET_INFO.open, R))}</h3><button class="btn small ghost" id="infoClose" type="button">סגירה ✕</button></div>${infoBody(RET_INFO.open, r, R, best, sim)}</section>` : ''}
  <section class="card"><div class="card-h"><h3>מקורות ההכנסה מול היעד – פרישה ב־${R}</h3><span class="hint">לכל שנה: שכירות נטו, קצבאות, ביטוח לאומי ומשיכה מהתיק</span></div><div class="chart tall"><canvas id="cRetInc"></canvas></div></section>
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>התיק הנזיל לאורך השנים</h3></div><div class="chart"><canvas id="cRetPort"></canvas></div></section>
    <section class="card"><div class="card-h"><h3>יתרת משכנתאות</h3></div><div class="chart"><canvas id="cRetMort"></canvas></div></section>
  </div>
  <section class="card"><div class="card-h"><h3>נכסים מניבים</h3><span class="hint">שכירות, משכנתא והוצאות לחודש – לשנות לפי הצורך</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>בחישוב</th><th class="sticky-col">נכס</th><th class="n">שכירות</th><th class="n">יתרת משכנתא</th><th class="n">החזר חודשי</th><th class="n">הוצאות שוטפות</th><th class="n">נטו אחרי מס ומשכנתא</th></tr></thead><tbody>
    ${r.props.map((p, i) => `<tr><td><input type="checkbox" data-retchk="props.${i}.use" ${p.use ? 'checked' : ''}></td><td class="sticky-col">${esc(p.name)}${p.mortgage && !p.payment ? ' <span class="chip var">חסר החזר</span>' : ''}</td>
      <td class="n">${rin(`props.${i}.rent`, p.rent, {cls:'cell'})}</td><td class="n">${rin(`props.${i}.mortgage`, p.mortgage, {cls:'cell'})}</td><td class="n">${rin(`props.${i}.payment`, p.payment, {cls:'cell'})}</td><td class="n">${rin(`props.${i}.costs`, p.costs, {cls:'cell'})}</td>
      <td class="n">${money(p.rent * (1 - r.rentTax / 100) - p.costs - p.payment)}</td></tr>`).join('')}
    <tr class="total"><td></td><td class="sticky-col">סה״כ</td><td class="n">${money(sum(r.props.filter(p => p.use).map(p => +p.rent)))}</td><td class="n">${money(sum(r.props.filter(p => p.use).map(p => +p.mortgage)))}</td><td class="n">${money(sum(r.props.filter(p => p.use).map(p => +p.payment)))}</td><td class="n">${money(sum(r.props.filter(p => p.use).map(p => +p.costs)))}</td><td class="n">${money(sum(r.props.filter(p => p.use).map(p => p.rent * (1 - r.rentTax / 100) - p.costs - p.payment)))}</td></tr>
    </tbody></table></div>
    <label class="row" style="gap:6px;font-weight:600;font-size:13.5px"><input type="checkbox" data-retchk="payoffAtRetire" ${r.payoffAtRetire ? 'checked' : ''}> לסלק את כל המשכנתאות מהתיק הנזיל בשנת הפרישה</label>
  </section>
  <div class="grid2">
    <section class="card"><div class="card-h"><h3>קצבאות</h3></div>
      <div class="tbl-wrap"><table><thead><tr><th></th><th class="n">${esc(p1)}</th><th class="n">${esc(p2)}</th></tr></thead><tbody>
        <tr><td>צבירה בפנסיה היום</td><td class="n">${money(pensionNow(0))}</td><td class="n">${money(pensionNow(1))}</td></tr>
        <tr><td>הפקדה חודשית עד הפרישה</td><td class="n">${rin('pen1.deposit', r.pen1.deposit, {cls:'cell'})}</td><td class="n">${rin('pen2.deposit', r.pen2.deposit, {cls:'cell'})}</td></tr>
        <tr><td>גיל תחילת קצבה (60 ומעלה)</td><td class="n">${rin('pen1.age', r.pen1.age, {cls:'cell'})}</td><td class="n">${rin('pen2.age', r.pen2.age, {cls:'cell'})}</td></tr>
        <tr><td>מקדם המרה</td><td class="n">${rin('pen1.coef', r.pen1.coef, {cls:'cell'})}</td><td class="n">${rin('pen2.coef', r.pen2.coef, {cls:'cell'})}</td></tr>
        <tr><td>ביטוח לאומי – גיל</td><td class="n">${rin('bl1.age', r.bl1.age, {cls:'cell'})}</td><td class="n">${rin('bl2.age', r.bl2.age, {cls:'cell'})}</td></tr>
        <tr><td>ביטוח לאומי – לחודש</td><td class="n">${rin('bl1.amount', r.bl1.amount, {cls:'cell'})}</td><td class="n">${rin('bl2.amount', r.bl2.amount, {cls:'cell'})}</td></tr>
        <tr class="total"><td>קצבה צפויה בתחילתה</td><td class="n">${money(simPen(r, R, 0))}</td><td class="n">${money(simPen(r, R, 1))}</td></tr>
      </tbody></table></div></section>
    <section class="card"><div class="card-h"><h3>הנחות</h3><span class="hint">באחוזים לשנה, מעל האינפלציה</span></div>
      <div class="row">
        <label class="field">תשואה ריאלית – תיק נזיל ${rin('realReturn', r.realReturn)}</label>
        <label class="field">תשואה ריאלית – פנסיה ${rin('pensionReturn', r.pensionReturn)}</label>
        <label class="field">ריבית משכנתא ריאלית ${rin('mortRate', r.mortRate)}</label>
        <label class="field">מס רווחי הון ${rin('cgt', r.cgt)}</label>
        <label class="field">חלק הרווח במשיכה ${rin('gainShare', r.gainShare)}</label>
        <label class="field">מס על שכירות ${rin('rentTax', r.rentTax)}</label>
        <label class="field">הכנסות נוספות לחודש ${rin('other', r.other)}</label>
        <label class="field">החישוב עד גיל ${rin('endAge', r.endAge)}</label>
      </div>
      <div><b style="font-size:13px;color:var(--muted)">מה נחשב תיק נזיל (אפשר לממש):</b>
        <div class="row" style="margin-top:6px">${groups.filter(g => !/נדל/.test(g)).map(g => `<label class="row" style="gap:5px;font-size:13.5px"><input type="checkbox" data-retgrp="${esc(g)}" ${r.liquidGroups.includes(g) ? 'checked' : ''}> ${esc(g)}</label>`).join('')}</div>
        <p class="hint" style="margin:6px 0 0">היום: ${plain(liquidNow(r))}</p></div>
    </section>
  </div>
  <details class="card"><summary><b>איך זה מחושב</b></summary>
    <div style="display:grid;gap:8px;margin-top:10px;font-size:14px">
      <p style="margin:0">החישוב שנה אחרי שנה, בכסף של היום, כמו במחשבוני הפרישה המוקדמת בישראל:</p>
      <p style="margin:0"><b>עד הפרישה</b> – החיסכון החודשי נכנס לתיק הנזיל, הפנסיה ממשיכה לקבל הפקדות, והמשכנתאות נפרעות לפי ההחזר.</p>
      <p style="margin:0"><b>תקופת הגישור</b> – מהפרישה ועד שהקצבאות מתחילות: השכירות נטו (אחרי מס, הוצאות והחזרי משכנתא) והכנסות נוספות, וההפרש עד היעד נמשך מהתיק הנזיל. על החלק של הרווח במשיכה משולם מס רווחי הון.</p>
      <p style="margin:0"><b>מגיל הקצבה</b> – קצבת הפנסיה (צבירה ÷ מקדם המרה; אפשר להתחיל מגיל 60, במקדם פחות טוב) וקצבת אזרח ותיק מביטוח לאומי (1,838 ₪ ליחיד ב־2026, ועד 50% תוספת ותק).</p>
      <p style="margin:0"><b>שנת הפרישה המוקדמת</b> היא השנה הראשונה שבה התיק הנזיל לא נגמר עד גיל ${r.endAge}. אחרי סיום המשכנתאות השכירות כולה נכנסת להכנסה.</p>
      <p class="hint" style="margin:0">הערכה בלבד ולא ייעוץ. גיל פרישה לגברים 67, לנשים עולה בהדרגה ל־65. פטור ממס על שכירות עד 5,654 ₪ לחודש, או מסלול 10%.</p>
    </div></details>`;
};
function simPen(r, R, i){
  const p = i ? {...r.pen2, birth:r.birth2} : {...r.pen1, birth:r.birth1};
  let bal = pensionNow(i); const y0 = +nearYear();
  for (let y = y0; y < p.birth + p.age; y++) { if (y < R) bal += p.deposit * 12; bal *= 1 + r.pensionReturn / 100; }
  return bal / p.coef;
}
VIEWS.retire.after = () => {
  const r = RS(), best = earliest(r), R = r.planYear || best || +nearYear() + 10, sim = simulate(r, R);
  const rows = sim.rows.filter(x => x.y >= Math.min(R, +nearYear() + 1));
  const lbl = rows.map(x => `${x.y} (${x.age1})`);
  const k = v => Math.round(v / 12);
  chart('cRetInc', {type:'bar', stacked:true, data:{labels:lbl, datasets:[
    {label:'שכירות נטו', data:rows.map(x => x.working ? 0 : k(Math.max(0, x.rentNet))), backgroundColor:pal(2), stack:'s'},
    {label:'קצבת פנסיה', data:rows.map(x => x.working ? 0 : k(x.pension)), backgroundColor:pal(0), stack:'s'},
    {label:'ביטוח לאומי', data:rows.map(x => x.working ? 0 : k(x.natIns)), backgroundColor:pal(3), stack:'s'},
    {label:'הכנסות נוספות', data:rows.map(x => x.working ? 0 : k(x.other)), backgroundColor:pal(5), stack:'s'},
    {label:'משיכה מהתיק', data:rows.map(x => k(x.draw)), backgroundColor:pal(1), stack:'s'},
    {type:'line', label:'יעד', data:rows.map(x => x.working ? null : k(x.want)), borderColor:css('--ink'), backgroundColor:css('--ink'), borderDash:[5, 4], pointRadius:0, borderWidth:2, stack:'line'},
  ]}});
  const all = sim.rows;
  chart('cRetPort', {type:'line', data:{labels:all.map(x => `${x.y} (${x.age1})`), datasets:[{label:'תיק נזיל', data:all.map(x => Math.round(x.P)), borderColor:pal(0), backgroundColor:pal(0) + '22', fill:true, pointRadius:0, tension:.2}]}});
  chart('cRetMort', {type:'line', data:{labels:all.map(x => `${x.y}`), datasets:[{label:'יתרת משכנתאות', data:all.map(x => Math.round(x.mortBal)), borderColor:pal(4), backgroundColor:pal(4) + '22', fill:true, pointRadius:0, tension:.2}]}});
  const set = (path, v) => { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => o[k], r); o[last] = v; };
  $$('[data-ret]').forEach(el => el.onchange = () => { const v = +String(el.value).replace(/[,₪\s]/g, ''); if (isNaN(v)) return toast('יש להזין מספר'); set(el.dataset.ret, v); markDirty(); keepScrollR(); });
  $$('[data-retchk]').forEach(el => el.onchange = () => { set(el.dataset.retchk, el.checked); markDirty(); keepScrollR(); });
  $$('[data-retgrp]').forEach(el => el.onchange = () => { const g = el.dataset.retgrp; r.liquidGroups = el.checked ? [...new Set([...r.liquidGroups, g])] : r.liquidGroups.filter(x => x !== g); markDirty(); keepScrollR(); });
  $$('[data-info]').forEach(b => b.onclick = () => { RET_INFO.open = RET_INFO.open === b.dataset.info ? null : b.dataset.info; keepScrollR(); });
  const ic = $('#infoClose'); if (ic) ic.onclick = () => { RET_INFO.open = null; keepScrollR(); };
  const pl = $('#retPlan'); if (pl) pl.onchange = () => { r.planYear = pl.value ? +pl.value : null; keepScrollR(); };
};
function keepScrollR(){ const y = window.scrollY; render(); window.scrollTo(0, y); }

/* place "פרישה מוקדמת" right before "הורשה לילדים" */
(function(){
  if (PAGES.some(p => p.id === 'retire')) return;
  const i = PAGES.findIndex(p => p.id === 'inherit');
  PAGES.splice(i >= 0 ? i : PAGES.length, 0, {id:'retire', t:'פרישה מוקדמת', i:RET_ICON});
  if (S.data) { buildNav(); if (location.hash.slice(1) === 'retire') { S.tab = 'retire'; render(); } }
})();
