'use strict';
/* נתוני פנסיה וקרנות – a detailed look at every pension fund, study fund (השתלמות), provident fund (גמל)
   and managers' insurance, per person, from the pension agent's periodic report.
   Data lives in D().pensionReport = {asOf, produced, source, people:{p1:{…, funds:[…]}, p2:{…}}}. */

const PEN_ICON = '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/><path d="M4 20h16"/>';
const PEN = {who:'p1', closed:store.get('pensClosed') || {}, sort:{study:{k:'balance', d:-1}, other:{k:'balance', d:-1}}};
// a card whose body opens and closes from its header; open/closed is remembered on this device
function box(id, title, hint, body, cls = '', extra = ''){
  const closed = !!PEN.closed[id];
  return `<section class="card pbox ${cls} ${closed ? 'closed' : ''}"><div class="card-h pbox-h" data-tog="${esc(id)}" role="button" tabindex="0" aria-expanded="${!closed}">
    <h3><span class="chev" aria-hidden="true">▾</span>${title}</h3>${extra}${hint ? `<span class="hint">${hint}</span>` : ''}</div><div class="pbox-b">${body}</div></section>`;
}
// funds tables: click a column header to sort (first click: high → low)
const SORT_KEYS = {provider:f => f.provider || '', balance:f => f.balance || 0, fee:f => f.feeAcc ?? -1, deposit:f => f.deposit || 0,
  liquid:f => +(liquidAt(f) || 0), ytd:f => mainTrack(f)?.ret.ytd ?? -999, y1:f => mainTrack(f)?.ret.y1 ?? -999, a5:f => mainTrack(f)?.ret.a5 ?? -999};
const SORT_LBL = {provider:'גוף · מסלול', balance:'צבירה', fee:'דמי ניהול', deposit:'הפקדה', liquid:'נזילה', ytd:'מתחילת השנה', y1:'12 ח׳', a5:'ממוצע 5ש׳'};
function sth(kind, k, num = true){
  const st = PEN.sort[kind], on = st.k === k;
  return `<th class="${num ? 'n ' : ''}sortable ${on ? 'on' : ''}" data-sort="${kind}:${k}" title="מיון">${SORT_LBL[k]}<span class="arr">${on ? (st.d < 0 ? '▼' : '▲') : '↕'}</span></th>`;
}
function sortFunds(list, kind){
  const st = PEN.sort[kind], fn = SORT_KEYS[st.k] || SORT_KEYS.balance;
  return list.slice().sort((a, b) => { const x = fn(a), y = fn(b); return (typeof x === 'string' ? x.localeCompare(y, 'he') : x - y) * st.d; });
}
// small tables (returns, coverage): sort the rows in place by the clicked column
function domSort(th){
  const tbl = th.closest('table'), i = [...th.parentNode.children].indexOf(th), body = tbl.tBodies[0];
  const d = th.dataset.d === '-1' ? 1 : -1; th.parentNode.querySelectorAll('th').forEach(h => { h.dataset.d = ''; h.classList.remove('on'); h.querySelector('.arr') && (h.querySelector('.arr').textContent = '↕'); });
  th.dataset.d = d; th.classList.add('on'); th.querySelector('.arr').textContent = d < 0 ? '▼' : '▲';
  const val = tr => { const t = tr.children[i]?.textContent.replace(/[₪,%+\s]/g, '') || ''; const n = parseFloat(t.replace('−', '-')); return isNaN(n) ? tr.children[i]?.textContent.trim() || '' : n; };
  [...body.rows].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y), 'he') : x - y) * d; }).forEach(r => body.appendChild(r));
}
const sh = l => `<th class="${l[1] ? 'n ' : ''}sortable">${l[0]}<span class="arr">↕</span></th>`;
const TYPE_SHORT = {
  'קרן פנסיה חדשה מקיפה':'פנסיה מקיפה', 'קרן פנסיה חדשה כללית':'פנסיה משלימה (כללית)',
  'קרן השתלמות':'קרן השתלמות', 'קופת גמל לתגמולים ופיצויים':'קופת גמל', 'ביטוח מנהלים':'ביטוח מנהלים',
};
const isPension = f => /קרן פנסיה/.test(f.type);
const isStudy = f => /השתלמות/.test(f.type);
const fp = (v, d = 2) => v == null ? '<span class="hint">—</span>' : `<span class="num ${v > 0 ? 'up' : v < 0 ? 'down' : ''}" dir="ltr">${v > 0 ? '+' : ''}${v.toFixed(d)}%</span>`;
const fee = v => v == null ? '—' : `<span class="num" dir="ltr">${v.toFixed(2)}%</span>`;
const pDate = s => { const m = String(s || '').match(/(\d\d)\/(\d\d)\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
const fDate = d => d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : '—';
// yearly fees in shekels: % of the balance + % of a year of deposits
const feeCost = f => (f.balance || 0) * (f.feeAcc || 0) / 100 + (f.deposit || 0) * 12 * (f.feeDep || 0) / 100;
// study funds can be withdrawn tax-free 6 years after they were opened
const liquidAt = f => { const d = pDate(f.join); return d ? new Date(d.getFullYear() + 6, d.getMonth(), d.getDate()) : null; };
const mainTrack = f => (f.tracks || []).slice().sort((a, b) => b.share - a.share)[0];

function penPeople(){
  const r = D().pensionReport; if (!r) return [];
  const names = D().settings.people || {};
  return ['p1', 'p2'].filter(k => r.people?.[k]).map(k => ({k, name:names[k] || k, P:r.people[k]}));
}

function personKpis(P){
  const yearFee = sum(P.funds.map(feeCost));
  return `<div class="kpis">
    <div class="kpi hero"><span class="lbl">סך החיסכון</span><span class="val">${money(P.total)}</span><span class="sub">תשואה מתחילת השנה ${fp(P.ytd, 1)}</span></div>
    <div class="kpi"><span class="lbl">קצבה חזויה לפרישה</span><span class="val">${money(P.pensionNo)}</span><span class="sub">בלי הפקדות נוספות · עם הפקדות ${plain(P.pensionWith)}</span></div>
    <div class="kpi"><span class="lbl">הפקדות בחודש</span><span class="val">${money(P.depositsMonthly)}</span><span class="sub">בכל המוצרים יחד</span></div>
    <div class="kpi"><span class="lbl">חיסכון הוני</span><span class="val">${money(P.lumpSum)}</span><span class="sub">השתלמות, גמל ותגמולים להון</span></div>
    <div class="kpi"><span class="lbl">דמי ניהול בשנה (הערכה)</span><span class="val down">${money(yearFee)}</span><span class="sub">${(yearFee / P.total * 100).toFixed(2)}% מהחיסכון</span></div>
    ${P.loan ? `<div class="kpi"><span class="lbl">הלוואה מהפנסיה</span><span class="val">${money(P.loan.balance)}</span><span class="sub">${plain(P.loan.monthly)} בחודש · עד ${esc(P.loan.end)}</span></div>` : ''}
  </div>`;
}

function mixCard(P, who){
  const groups = {};
  for (const f of P.funds) groups[TYPE_SHORT[f.type] || f.type] = (groups[TYPE_SHORT[f.type] || f.type] || 0) + f.balance;
  const g = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const bar = (lbl, v) => v == null ? '' : `<div class="pbar"><span>${lbl}</span><div class="pbar-t"><i style="width:${v}%"></i></div><b class="num" dir="ltr">${v}%</b></div>`;
  return `<div class="grid2">
    ${box('mix', 'לפי סוג מוצר', '', `<div class="donut-row pen-donut"><div class="chart" style="height:200px"><canvas id="cPenMix_${who}"></canvas></div>
      <div class="legend-list">${g.map(([n, v], i) => `<div class="legend-row"><span class="sw" style="background:${pal(i)}"></span><span>${esc(n)}</span><span>${money(v, {short:true})}</span><span></span></div>`).join('')}</div></div>`)}
    ${box('exp', 'חשיפה ותמהיל השקעה', 'לפי דיווח הגופים', `${bar('מניות', P.stocks)}${bar('חו״ל', P.abroad)}${bar('מט״ח', P.fx)}${bar('נכסים סחירים', P.traded)}
      <div class="mix-chips">${(P.mix || []).map(([n, v]) => `<span class="chip">${esc(n.replace(/\s*,\s*/g, ', '))} <b dir="ltr">${v}%</b></span>`).join('')}</div>`)}</div>`;
}

function returnsTable(f){
  if (!f.tracks?.length) return '';
  return `<div class="tbl-wrap"><table class="ret-tbl dsort"><thead><tr>${[['מסלול'], ['חודש', 1], ['מתחילת השנה', 1], ['12 ח׳', 1], ['3 שנים', 1], ['5 שנים', 1], ['ממוצע שנתי 5ש׳', 1]].map(sh).join('')}</tr></thead><tbody>
    ${f.tracks.map(t => `<tr><td>${esc(t.name)}${f.tracks.length > 1 ? ` <span class="hint">(${t.share}%)</span>` : ''}</td><td class="n">${fp(t.ret.m)}</td><td class="n">${fp(t.ret.ytd)}</td><td class="n">${fp(t.ret.y1)}</td><td class="n">${fp(t.ret.c3)}</td><td class="n">${fp(t.ret.c5)}</td><td class="n">${fp(t.ret.a5)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function pensionCard(f){
  const l = f.last;
  return box('pen-' + (f.policy || f.type), esc(TYPE_SHORT[f.type] || f.type), `${esc(f.provider)} · ${money(f.balance)}`, `
    <div class="fund-kpis">
      <div><span class="lbl">צבירה</span><b>${money(f.balance)}</b></div>
      <div><span class="lbl">קצבה חזויה</span><b>${money(f.pensionNo)}</b><span class="hint">עם הפקדות ${plain(f.pensionWith)}</span></div>
      <div><span class="lbl">דמי ניהול</span><b>${fee(f.feeDep)} <span class="hint">מהפקדה</span></b><b>${fee(f.feeAcc)} <span class="hint">מצבירה</span></b></div>
      <div><span class="lbl">דמי ניהול בשנה</span><b>${money(feeCost(f))}</b><span class="hint">הערכה</span></div>
    </div>
    <dl class="fund-dl">
      <div><dt>פוליסה</dt><dd>${esc(f.policy || '—')}</dd></div>
      <div><dt>הצטרפות</dt><dd>${esc(f.join || '—')}</dd></div>
      <div><dt>מעסיק</dt><dd>${esc(f.employer || '—')}</dd></div>
      <div><dt>שכר מבוטח</dt><dd>${f.salary ? plain(f.salary) : '—'}</dd></div>
      <div><dt>הפקדה חודשית</dt><dd>${f.deposit ? plain(f.deposit) : '—'}</dd></div>
      ${l ? `<div><dt>הפקדה אחרונה (${esc(l.month)})</dt><dd>עובד ${plain(l.employee || 0)} · מעסיק ${plain(l.employer || 0)}${l.severance ? ' · פיצויים ' + plain(l.severance) : ''}</dd></div>` : ''}
    </dl>
    ${returnsTable(f)}
    ${f.cover?.length ? `<details class="cover"><summary><b>כיסויים ביטוחיים בקרן</b> <span class="hint">נכות ${plain(f.cover[0].pension)} בחודש · עלות ${plain(sum(f.cover.map(c => c.cost || 0)))} בחודש</span></summary>
      <div class="tbl-wrap"><table class="dsort"><thead><tr>${[['כיסוי'], ['שיעור', 1], ['קצבה בחודש', 1], ['עלות בחודש', 1]].map(sh).join('')}</tr></thead><tbody>
      ${f.cover.map(c => `<tr><td>${esc(c.type)}</td><td class="n">${c.rate}%</td><td class="n">${money(c.pension)}</td><td class="n">${c.cost ? money(c.cost) : '<span class="hint">כלול</span>'}</td></tr>`).join('')}
      </tbody></table></div></details>` : ''}`, 'fund', `<span class="chip ${f.status === 'פעיל' ? 'yes' : 'no'}">${esc(f.status)}</span>`);
}

function studyTable(list, title, hint, kind){
  if (!list.length) return '';
  const now = new Date();
  const rows = sortFunds(list, kind);
  const tot = sum(rows.map(f => f.balance));
  const keys = ['provider', 'balance', 'fee', 'deposit', ...(kind === 'study' ? ['liquid'] : []), 'ytd', 'y1', 'a5'];
  return box(kind, title, hint, `
    <div class="tbl-wrap"><table><thead><tr>${keys.map(k => sth(kind, k, !['provider', 'liquid'].includes(k))).join('')}</tr></thead><tbody>
    ${rows.map(f => { const t = mainTrack(f) || {ret:{}}, liq = liquidAt(f);
      return `<tr><td><b>${esc(f.provider)}</b> <span class="chip ${f.status === 'פעיל' ? 'yes' : 'no'}">${esc(f.status)}</span>${f.type === 'ביטוח מנהלים' ? ' <span class="chip var">מנהלים</span>' : f.type.includes('גמל') ? ' <span class="chip var">גמל</span>' : ''}<div class="hint" style="font-size:12.5px">${esc(t.name || '')}${f.tracks.length > 1 ? ` +${f.tracks.length - 1}` : ''} · מ־${esc(f.join || '')}</div></td>
      <td class="n"><b>${money(f.balance)}</b></td><td class="n">${fee(f.feeAcc)}${f.feeDep ? `<div class="hint">${fee(f.feeDep)} מהפקדה</div>` : ''}</td>
      <td class="n">${f.deposit ? plain(f.deposit) : '<span class="hint">—</span>'}</td>
      ${kind === 'study' ? `<td>${liq && liq <= now ? '<span class="chip yes">נזילה ✓</span>' : `<span class="chip var">${fDate(liq)}</span>`}</td>` : ''}
      <td class="n">${fp(t.ret.ytd)}</td><td class="n">${fp(t.ret.y1)}</td><td class="n">${fp(t.ret.a5)}</td></tr>`; }).join('')}
    <tr class="total"><td>סה״כ (${rows.length})</td><td class="n">${money(tot)}</td><td class="n hint">${(sum(rows.map(f => f.balance * (f.feeAcc || 0))) / tot).toFixed(2)}% ממוצע</td><td class="n">${plain(sum(rows.map(f => f.deposit || 0)))}</td>${kind === 'study' ? `<td>${money(sum(rows.filter(f => (liquidAt(f) || now) <= now).map(f => f.balance)))} נזיל</td>` : ''}<td colspan="3"></td></tr>
    </tbody></table></div>
    <div class="fund-list"><label class="fl-sort">מיון לפי <select class="inp" data-sortsel="${kind}">${keys.map(k => `<option value="${k}" ${PEN.sort[kind].k === k ? 'selected' : ''}>${SORT_LBL[k]}</option>`).join('')}</select></label>${rows.map(f => { const t = mainTrack(f) || {ret:{}}, liq = liquidAt(f); return `<div class="fl-item">
      <div class="fl-h"><b>${esc(f.provider)}</b><span class="chip ${f.status === 'פעיל' ? 'yes' : 'no'}">${esc(f.status)}</span><b class="fl-bal">${money(f.balance)}</b></div>
      <div class="hint">${esc(t.name || '')} · מ־${esc(f.join || '')}</div>
      <div class="fl-meta">דמי ניהול ${fee(f.feeAcc)}${f.deposit ? ` · הפקדה ${plain(f.deposit)}` : ''}${kind === 'study' ? ` · ${liq && liq <= now ? 'נזילה ✓' : 'נזילה ב־' + fDate(liq)}` : ''}</div>
      <div class="fl-meta">מתחילת השנה ${fp(t.ret.ytd)} · 12 ח׳ ${fp(t.ret.y1)} · ממוצע 5ש׳ ${fp(t.ret.a5)}</div></div>`; }).join('')}
      <div class="fl-item fl-tot"><b>סה״כ ${rows.length}</b><b>${money(tot)}</b></div></div>
    ${list.some(f => f.riders?.length) ? list.filter(f => f.riders?.some(r => r.cover || r.premium)).map(f => `<details class="cover"><summary><b>כיסויים ב${esc(f.provider)}</b> <span class="hint">אובדן כושר עבודה ${plain(sum(f.riders.map(r => r.cover || 0)))} בחודש · פרמיה ${plain(sum(f.riders.map(r => r.premium || 0)))}</span></summary>
      <ul class="plain-list">${f.riders.filter(r => r.cover || r.premium).map(r => `<li>${esc(r.name)}: ${r.cover ? 'כיסוי ' + plain(r.cover) + ' · ' : ''}פרמיה ${plain(r.premium || 0)}</li>`).join('')}</ul></details>`).join('') : ''}`);
}

function insights(P){
  const out = [], study = P.funds.filter(isStudy);
  const small = study.filter(f => f.balance < 20000);
  if (study.length > 3) out.push(`${study.length} חשבונות קרן השתלמות${small.length ? `, מהם ${small.length} עם פחות מ־₪20,000` : ''}.`);
  const inactive = P.funds.filter(f => f.status !== 'פעיל');
  if (inactive.length) out.push(`${inactive.length} מוצרים לא פעילים (בלי הפקדות): ${inactive.map(f => esc(f.provider)).join(', ')}.`);
  const hi = P.funds.filter(f => (f.feeAcc || 0) >= 1);
  if (hi.length) out.push(`דמי ניהול מצבירה של 1% ומעלה: ${hi.map(f => `${esc(f.provider)} ${fee(f.feeAcc)} (${plain(f.balance)})`).join(', ')}.`);
  const soon = study.map(f => ({f, d:liquidAt(f)})).filter(x => x.d && x.d > new Date()).sort((a, b) => a.d - b.d)[0];
  if (soon) out.push(`קרן ההשתלמות הבאה שתהיה נזילה: ${esc(soon.f.provider)} (${plain(soon.f.balance)}) ב־${fDate(soon.d)}.`);
  if (P.coverDisab) out.push(`ביטוח אובדן כושר עבודה מעבר לקרן הפנסיה: ${plain(P.coverDisab)} בחודש.`);
  return out.length ? box('ins', 'במבט מהיר', '', `<ul class="plain-list">${out.map(x => `<li>${x}</li>`).join('')}</ul>`, 'note-card') : '';
}

VIEWS.pens = () => {
  const r = D().pensionReport, ppl = penPeople();
  if (!r || !ppl.length) return `<section class="card"><p>עדיין אין כאן נתונים. מעלים את הדוח השוטף של הסוכן הפנסיוני בעמוד ״העלאת מסמך פנסיה וקרנות״.</p></section>`;
  if (!ppl.some(p => p.k === PEN.who)) PEN.who = ppl[0].k;
  const cur = ppl.find(p => p.k === PEN.who), P = cur.P;
  const fam = {total:sum(ppl.map(p => p.P.total)), no:sum(ppl.map(p => p.P.pensionNo)), with:sum(ppl.map(p => p.P.pensionWith)), dep:sum(ppl.map(p => p.P.depositsMonthly)), fee:sum(ppl.flatMap(p => p.P.funds.map(feeCost)))};
  const pens = P.funds.filter(isPension), study = P.funds.filter(isStudy), other = P.funds.filter(f => !isPension(f) && !isStudy(f));
  return `
  <div class="pen-top">
    <div class="seg" role="tablist">${ppl.map(p => `<button type="button" role="tab" class="${p.k === PEN.who ? 'on' : ''}" data-who="${p.k}">${esc(p.name)} <span class="hint">${plain(p.P.total)}</span></button>`).join('')}</div>
    <div class="pen-acts"><button class="btn small ghost" type="button" data-all="open">פתיחת הכל</button><button class="btn small ghost" type="button" data-all="close">סגירת הכל</button></div>
    <div class="pen-src"><span class="hint">דוח ${esc(r.source || '')} · נכון ל־${esc(r.asOf || '')}</span>
      <span class="fam-line"><b>שניכם יחד:</b> ${plain(fam.total)} · קצבה ${plain(fam.no)}–${plain(fam.with)} בחודש · הפקדות ${plain(fam.dep)} בחודש · דמי ניהול ~${plain(fam.fee)} בשנה</span></div>
  </div>
  ${personKpis(P)}
  ${insights(P)}
  ${mixCard(P, PEN.who)}
  ${pens.length ? `<h2 class="sec-h">קרנות פנסיה</h2><div class="fund-grid">${pens.map(pensionCard).join('')}</div>` : ''}
  ${studyTable(study, 'קרנות השתלמות', 'נזילה = 6 שנים מתאריך ההצטרפות', 'study')}
  ${studyTable(other, 'קופות גמל וביטוח מנהלים', 'סכומים קטנים יחסית', 'other')}`;
};
VIEWS.pens.after = () => {
  const re = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };
  $$('[data-who]').forEach(b => b.onclick = () => { PEN.who = b.dataset.who; re(); });
  const tog = id => { if (PEN.closed[id]) delete PEN.closed[id]; else PEN.closed[id] = 1; store.set('pensClosed', PEN.closed); re(); };
  $$('[data-tog]').forEach(h => { h.onclick = e => { if (!e.target.closest('a,button:not([data-tog]),select,input')) tog(h.dataset.tog); }; h.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tog(h.dataset.tog); } }; });
  $$('[data-all]').forEach(b => b.onclick = () => { const ids = $$('[data-tog]').map(h => h.dataset.tog); if (b.dataset.all === 'close') ids.forEach(id => PEN.closed[id] = 1); else ids.forEach(id => delete PEN.closed[id]); store.set('pensClosed', PEN.closed); re(); });
  $$('[data-sort]').forEach(th => th.onclick = () => { const [kind, k] = th.dataset.sort.split(':'), st = PEN.sort[kind]; if (st.k === k) st.d = -st.d; else { st.k = k; st.d = k === 'provider' || k === 'liquid' ? 1 : -1; } re(); });
  $$('[data-sortsel]').forEach(sel => sel.onchange = () => { const st = PEN.sort[sel.dataset.sortsel]; st.k = sel.value; st.d = sel.value === 'provider' || sel.value === 'liquid' ? 1 : -1; re(); });
  $$('table.dsort th.sortable').forEach(th => th.onclick = () => domSort(th));
  const P = D().pensionReport?.people?.[PEN.who]; if (!P) return;
  const groups = {}; for (const f of P.funds) groups[TYPE_SHORT[f.type] || f.type] = (groups[TYPE_SHORT[f.type] || f.type] || 0) + f.balance;
  const g = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  chart('cPenMix_' + PEN.who, {type:'doughnut', pctLabels:true, data:{labels:g.map(x => x[0]), datasets:[{data:g.map(x => x[1]), backgroundColor:g.map((_, i) => pal(i)), borderWidth:0}]}});
};

/* place "פנסיה וקרנות" in the menu and set the menu order */
(function(){
  if (PAGES.some(p => p.id === 'pens')) return;
  let i = PAGES.findIndex(p => p.id === 'retire'); if (i < 0) i = PAGES.findIndex(p => p.id === 'inherit');
  PAGES.splice(i >= 0 ? i : PAGES.length, 0, {id:'pens', t:'פנסיה וקרנות', i:PEN_ICON});
  // menu order (pens.js loads last, after every page has been added)
  const ORDER = ['total', 'growth', 'exp', 'inc', 'balance', 'risk', 'pens', 'retire', 'inherit', 'graphs', 'pt', 'contacts'];
  const rank = p => { const r = ORDER.indexOf(p.id); return r < 0 ? 900 + PAGES.indexOf(p) : r; };
  const main = PAGES.filter(p => !p.sec).sort((a, b) => rank(a) - rank(b)), rest = PAGES.filter(p => p.sec);
  PAGES.splice(0, PAGES.length, ...main, ...rest);
  if (S.data) { buildNav(); if (location.hash.slice(1) === 'pens') { S.tab = 'pens'; render(); } }
})();
