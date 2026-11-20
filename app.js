/* BlueLine — achats au Japon, rentabilité en direct. Données stockées uniquement sur l'appareil (IndexedDB). */
'use strict';
const APP_VERSION = '1.1.0';

/* ---------- Réglages ---------- */
const DEFAULTS = {
  budget: 10000, trip: 2500, nego: 5, fees: 5, red: 60, green: 80,
  tax: 10, broker: 150, duty: 2.7, vat: 20, game: 'Pokemon', manualRate: '',
  returnDate: '', customsRate: '', customsRateInfo: '', lastBackup: 0, lastGame: ''
};
const GAMES = [
  ['Pokemon', 'Pokémon'], ['OnePiece', 'One Piece'], ['YuGiOh', 'Yu-Gi-Oh!'], ['Magic', 'Magic'],
  ['Lorcana', 'Lorcana'], ['DragonBallSuper', 'Dragon Ball Super'], ['Digimon', 'Digimon'],
  ['WeissSchwarz', 'Weiß Schwarz'], ['UnionArena', 'Union Arena'], ['FleshAndBlood', 'Flesh and Blood'],
  ['Autre', 'Autre (recherche web)']
];
const CHIP_GAMES = ['Pokemon', 'OnePiece', 'YuGiOh', 'Magic', 'Lorcana', 'DragonBallSuper', 'Autre'];
const gameLabel = g => (GAMES.find(x => x[0] === g) || [, g])[1];
const defGame = () => S.lastGame || S.game;
let SIM_GAME = null;

let S = { ...DEFAULTS };
let RATE = { value: null, date: null, source: '' };
let PURCHASES = [];
let EDIT_PHOTOS = []; // photos du formulaire en cours {id?, kind, blob, thumb, _new}
let EDIT_DELETED = [];

/* ---------- IndexedDB ---------- */
const DB_NAME = 'tcgtrip', DB_VER = 1;
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('purchases')) d.createObjectStore('purchases', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) {
        const s = d.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('purchaseId', 'purchaseId');
      }
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const st = t.objectStore(store);
    let out;
    Promise.resolve(fn(st)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbGetAll = store => tx(store, 'readonly', st => reqP(st.getAll()));
const dbPut = (store, v, k) => tx(store, 'readwrite', st => { k === undefined ? st.put(v) : st.put(v, k); });
const dbDel = (store, k) => tx(store, 'readwrite', st => { st.delete(k); });
const dbGet = (store, k) => tx(store, 'readonly', st => reqP(st.get(k)));
async function photosOf(pid) {
  return tx('photos', 'readonly', st => reqP(st.index('purchaseId').getAll(pid)));
}

/* ---------- Format ---------- */
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = v => (v == null || !isFinite(v)) ? '—' : nf0.format(Math.round(v)) + ' €';
const eur2 = v => (v == null || !isFinite(v)) ? '—' : nf2.format(v) + ' €';
const yen = v => (v == null || !isFinite(v)) ? '—' : nf0.format(Math.round(v)) + ' ¥';
const pctTxt = p => (p == null || !isFinite(p)) ? '—' : (p >= 0 ? '+' : '') + nf0.format(Math.round(p)) + ' %';
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); }
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/* ---------- Calculs ---------- */
function currentRate() { const m = num(S.manualRate); return m || RATE.value; }
function colorOf(p) { if (p == null || !isFinite(p)) return 'none'; return p < S.red ? 'red' : (p < S.green ? 'orange' : 'green'); }
function estUnit(first, last, manual) {
  const m = num(manual); if (m) return m;
  const vals = [num(first), num(last)].filter(v => v && v > 0);
  if (!vals.length) return null;
  return Math.min(...vals) * (1 - S.nego / 100);
}
function calcLine(p) {
  const qty = Math.max(1, num(p.qty) || 1);
  const priceYen = num(p.priceYen) || 0;
  const refundYen = p.taxFree ? priceYen * S.tax / (100 + S.tax) : 0;
  const netYen = priceYen - refundYen;
  const rate = num(p.rate) || currentRate();
  const cost = rate ? netYen / rate : null;
  const u = estUnit(p.cmFirst, p.cmLast, p.manualEst);
  const est = u != null ? u * qty : null;
  const pct = (cost && est != null) ? (est / cost - 1) * 100 : null;
  return { qty, priceYen, refundYen, netYen, rate, cost, unit: u, est, pct, color: colorOf(pct) };
}
function totals(extra) {
  let cost = 0, est = 0, yenNet = 0, n = 0, missingEst = 0;
  const lines = PURCHASES.map(p => calcLine(p));
  if (extra) lines.push(extra);
  for (const c of lines) {
    if (c.cost == null) continue;
    n++; yenNet += c.netYen;
    if (c.est == null) { missingEst++; continue; }
    cost += c.cost; est += c.est;
  }
  const spentAll = lines.reduce((a, c) => a + (c.cost || 0), 0);
  const pct = cost ? (est / cost - 1) * 100 : null;
  const landed = spentAll * (1 + S.duty / 100) * (1 + S.vat / 100) + S.broker + S.trip;
  const profit = n ? est * (1 - S.fees / 100) - landed : null;
  return { cost, est, pct, color: colorOf(pct), n, missingEst, yenNet, spentAll, profit, left: S.budget - spentAll };
}

/* ---------- Taux de change (BCE via Frankfurter) ---------- */
async function fetchJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function fetchRateFor(date) {
  const path = date || 'latest';
  const urls = [
    `https://api.frankfurter.dev/v1/${path}?base=EUR&symbols=JPY`,
    `https://api.frankfurter.app/${path}?from=EUR&to=JPY`
  ];
  for (const u of urls) {
    try { const j = await fetchJSON(u); if (j && j.rates && j.rates.JPY) return { value: j.rates.JPY, date: j.date }; } catch (e) { }
  }
  throw new Error('taux indisponible');
}
async function refreshRate() {
  const cached = await dbGet('kv', 'rate');
  if (cached) RATE = cached;
  renderRateBadge();
  if (!navigator.onLine) return;
  try {
    const r = await fetchRateFor();
    RATE = { value: r.value, date: r.date, source: 'BCE', fetchedAt: Date.now() };
    await dbPut('kv', RATE, 'rate');
    renderRateBadge(); renderAll();
  } catch (e) { /* on garde le dernier taux */ }
}
function renderRateBadge() {
  const m = num(S.manualRate);
  const b = $('rateBadge');
  if (m) b.textContent = `1 € = ${nf2.format(m)} ¥ (manuel)`;
  else if (RATE.value) b.textContent = `1 € = ${nf2.format(RATE.value)} ¥ · ${RATE.date ? RATE.date.split('-').reverse().join('/') : ''}`;
  else b.textContent = 'Taux ¥ indisponible';
}
/* Taux douanier : cours BCE de l'avant-dernier mercredi du mois précédant le mois de retour */
function customsRefDate(returnISO) {
  const d = returnISO ? new Date(returnISO + 'T12:00:00') : new Date();
  const lastDayPrev = new Date(d.getFullYear(), d.getMonth(), 0, 12);
  const w = new Date(lastDayPrev);
  while (w.getDay() !== 3) w.setDate(w.getDate() - 1);
  w.setDate(w.getDate() - 7);
  return new Date(w.getTime() - w.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/* ---------- Navigation ---------- */
function go(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.goto === view || (view === 'form' && b.dataset.goto === 'list')));
  window.scrollTo(0, 0);
  if (view === 'customs') renderCustoms();
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); go(g.dataset.goto); }
});

/* ---------- Rendu tableau de bord ---------- */
function renderDash() {
  const t = totals();
  const card = $('statusCard');
  card.className = 'status-card' + (t.color !== 'none' ? ' s-' + t.color : '');
  $('statusPct').textContent = t.pct == null ? '—' : pctTxt(t.pct);
  const label = { red: 'ROUGE — en dessous du seuil', orange: 'ORANGE — rentable mais juste', green: 'VERT — objectif atteint', none: '' }[t.color];
  $('statusSub').textContent = t.n ? `${label}${t.missingEst ? ` · ${t.missingEst} achat(s) sans estimation` : ''}` : 'Aucun achat pour l\'instant';
  $('kSpent').textContent = eur(t.spentAll);
  $('kSpentY').textContent = yen(t.yenNet) + ' net';
  $('kEst').textContent = eur(t.est);
  $('kCount').textContent = `${PURCHASES.length} achat${PURCHASES.length > 1 ? 's' : ''}`;
  $('kLeft').textContent = eur(t.left);
  const r = currentRate();
  $('kLeftY').textContent = r ? yen(t.left * r) : '—';
  const kp = $('kProfit');
  kp.textContent = t.profit == null ? '—' : (t.profit >= 0 ? '+' : '') + eur(t.profit);
  kp.style.color = t.profit == null ? '' : (t.profit >= 0 ? 'var(--green)' : 'var(--red)');
  document.querySelectorAll('.tRed').forEach(e => e.textContent = S.red);
  document.querySelectorAll('.tGreen').forEach(e => e.textContent = S.green);
  // mix
  const sums = { red: 0, orange: 0, green: 0, none: 0 };
  PURCHASES.forEach(p => { const c = calcLine(p); sums[c.color] += c.cost || 0; });
  const tot = Object.values(sums).reduce((a, b) => a + b, 0);
  $('mixBox').innerHTML = tot ? `<b>Répartition du budget dépensé</b>
    <div class="bar"><div style="width:${sums.green / tot * 100}%;background:var(--green)"></div><div style="width:${sums.orange / tot * 100}%;background:var(--orange)"></div><div style="width:${sums.red / tot * 100}%;background:var(--red)"></div><div style="width:${sums.none / tot * 100}%;background:#9ca3af"></div></div>
    🟢 ${eur(sums.green)} · 🟠 ${eur(sums.orange)} · 🔴 ${eur(sums.red)}${sums.none ? ' · ⚪ ' + eur(sums.none) + ' sans estimation' : ''}` : '';
  // bannières
  const needBackup = PURCHASES.length && (Date.now() - (S.lastBackup || 0) > 20 * 3600 * 1000);
  $('backupBanner').classList.toggle('hidden', !needBackup);
  $('lastBackupTxt').textContent = S.lastBackup ? new Date(S.lastBackup).toLocaleString('fr-FR') : 'jamais';
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('installBanner').classList.toggle('hidden', !(ios && !standalone));
}

/* ---------- Simulateur ---------- */
function simLine() {
  return calcLine({ priceYen: $('sYen').value, qty: $('sQty').value, taxFree: $('sTaxFree').checked, cmFirst: $('sFirst').value, cmLast: $('sLast').value });
}
function setResult(el, pctEl, subEl, c, sub) {
  el.className = 'sim-result' + (c.color !== 'none' ? ' s-' + c.color : '');
  pctEl.textContent = pctTxt(c.pct);
  subEl.textContent = sub;
}
function renderSim() {
  const c = simLine();
  if (!c.cost) { setResult($('simLine'), $('simPct'), $('simSub'), { color: 'none', pct: null }, currentRate() ? 'Saisis un prix et un prix Cardmarket' : 'Taux du yen indisponible : renseigne-le dans Réglages'); }
  else {
    const verdict = { red: '❌ Ne pas acheter', orange: '⚠️ Seulement si compensé par du ×2', green: '✅ Achète', none: 'Ajoute un prix Cardmarket' }[c.color];
    setResult($('simLine'), $('simPct'), $('simSub'), c, `${verdict} · coût ${eur2(c.cost)}${c.refundYen ? ' (net de taxe)' : ''} → revente estimée ${eur2(c.est)}`);
  }
  const t = totals(c.cost ? c : null);
  setResult($('simCart'), $('simCartPct'), $('simCartSub'), t,
    c.cost ? `Budget restant après achat : ${eur(t.left)} · bénéfice projeté ${t.profit == null ? '—' : eur(t.profit)}` : 'Panier actuel');
}
['sYen', 'sQty', 'sTaxFree', 'sFirst', 'sLast'].forEach(id => $(id).addEventListener('input', renderSim));
$('sOpenCM').addEventListener('click', () => openCM(cmUrl($('sName').value, SIM_GAME || defGame())));
function renderSimGames() {
  const g = SIM_GAME || defGame();
  const list = CHIP_GAMES.includes(g) ? CHIP_GAMES : [g, ...CHIP_GAMES];
  $('sGames').innerHTML = list.map(k => `<button type="button" class="chip${k === g ? ' on' : ''}" data-game="${k}">${esc(gameLabel(k))}</button>`).join('');
}
$('sGames').addEventListener('click', e => { const b = e.target.closest('[data-game]'); if (!b) return; SIM_GAME = b.dataset.game; renderSimGames(); });
$('sSave').addEventListener('click', () => openForm(null, {
  name: $('sName').value, game: SIM_GAME || defGame(), priceYen: $('sYen').value, qty: $('sQty').value, taxFree: $('sTaxFree').checked,
  cmFirst: $('sFirst').value, cmLast: $('sLast').value
}));

/* ---------- Cardmarket ---------- */
function cmUrl(name, game) {
  const g = game || defGame(); const q = (name || '').trim();
  if (g === 'Autre') return `https://www.google.com/search?q=${encodeURIComponent('cardmarket ' + q)}`;
  if (!q) return `https://www.cardmarket.com/fr/${g}`;
  return `https://www.cardmarket.com/fr/${g}/Products/Search?searchString=${encodeURIComponent(q)}`;
}
function openCM(url) { window.open(url, '_blank', 'noopener'); }

/* ---------- Liste ---------- */
let thumbCache = {};
async function renderList() {
  const box = $('purchaseList');
  if (!PURCHASES.length) { box.innerHTML = '<p class="fine center">Aucun achat. Utilise « + Achat » ou le simulateur.</p>'; return; }
  const sorted = [...PURCHASES].sort((a, b) => b.id.localeCompare(a.id));
  box.innerHTML = sorted.map(p => {
    const c = calcLine(p);
    return `<div class="item c-${c.color}" data-id="${esc(p.id)}">
      <div class="noimg" data-thumb="${esc(p.id)}"></div>
      <div class="mid"><div class="t">${esc(p.id)} · ${esc(p.name || 'Sans nom')}</div>
        <div class="s">${esc(p.shop || '')}${p.shop ? ' · ' : ''}${yen(c.priceYen)} → ${eur(c.cost)} · estimé ${eur(c.est)}</div></div>
      <div class="pill p-${c.color}">${pctTxt(c.pct)}</div></div>`;
  }).join('');
  for (const p of sorted) {
    const el = box.querySelector(`[data-thumb="${CSS.escape(p.id)}"]`);
    if (!el) continue;
    if (!(p.id in thumbCache)) {
      const ph = await photosOf(p.id);
      const pick = ph.find(x => x.kind === 'produit') || ph[0];
      thumbCache[p.id] = pick ? pick.thumb : null;
    }
    if (thumbCache[p.id]) { const img = new Image(); img.src = thumbCache[p.id]; el.replaceWith(img); }
  }
}
$('purchaseList').addEventListener('click', e => {
  const it = e.target.closest('.item'); if (!it) return;
  const p = PURCHASES.find(x => x.id === it.dataset.id); if (p) openForm(p);
});
$('btnNew').addEventListener('click', () => openForm(null));

/* ---------- Formulaire ---------- */
function nextId() {
  const max = PURCHASES.reduce((m, p) => Math.max(m, parseInt(String(p.id).slice(1)) || 0), 0);
  return 'A' + String(max + 1).padStart(3, '0');
}
function fillGames(sel, value) { sel.innerHTML = GAMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); sel.value = value || defGame(); }
async function openForm(p, prefill) {
  const isNew = !p; const d = p || {};
  const pre = prefill || {};
  $('formTitle').textContent = isNew ? 'Nouvel achat' : `Achat ${d.id}`;
  $('fId').value = d.id || '';
  $('fName').value = d.name ?? pre.name ?? '';
  fillGames($('fGame'), d.game || pre.game || defGame());
  $('fCat').value = d.cat || 'Scellé';
  $('fShop').value = d.shop || '';
  $('fDate').value = d.date || todayISO();
  $('fYen').value = d.priceYen ?? pre.priceYen ?? '';
  $('fQty').value = d.qty ?? pre.qty ?? 1;
  $('fTaxFree').checked = d.taxFree ?? pre.taxFree ?? false;
  $('fRate').value = d.rate ?? (currentRate() ? Math.round(currentRate() * 100) / 100 : '');
  $('fFirst').value = d.cmFirst ?? pre.cmFirst ?? '';
  $('fLast').value = d.cmLast ?? pre.cmLast ?? '';
  $('fManual').value = d.manualEst ?? '';
  $('fPay').value = d.pay || 'Carte Qonto SAS';
  $('fCM').value = d.cmUrl || '';
  $('fCM').dataset.auto = d.cmUrl ? '0' : '1';
  $('fNotes').value = d.notes || '';
  $('fDelete').classList.toggle('hidden', isNew);
  EDIT_PHOTOS = isNew ? [] : (await photosOf(d.id)).map(x => ({ ...x }));
  EDIT_DELETED = [];
  renderFormPhotos(); updateFormCalc(); syncCM();
  go('form');
}
function formObj() {
  return {
    id: $('fId').value || nextId(), name: $('fName').value.trim(), game: $('fGame').value, cat: $('fCat').value,
    shop: $('fShop').value.trim(), date: $('fDate').value, priceYen: num($('fYen').value), qty: num($('fQty').value) || 1,
    taxFree: $('fTaxFree').checked, rate: num($('fRate').value), cmFirst: num($('fFirst').value), cmLast: num($('fLast').value),
    manualEst: num($('fManual').value), pay: $('fPay').value, cmUrl: $('fCM').value.trim(), notes: $('fNotes').value.trim()
  };
}
function updateFormCalc() {
  const c = calcLine(formObj());
  $('fCalc').innerHTML = c.cost ? `Net ${yen(c.netYen)}${c.refundYen ? ` (remb. ${yen(c.refundYen)})` : ''} = <b>${eur2(c.cost)}</b> · revente estimée <b>${eur2(c.est)}</b> · <span class="pill p-${c.color}">${pctTxt(c.pct)}</span>` : 'Saisis le prix en ¥ et le taux.';
}
function syncCM() { if ($('fCM').dataset.auto === '1') $('fCM').value = cmUrl($('fName').value, $('fGame').value); }
['fYen', 'fQty', 'fTaxFree', 'fRate', 'fFirst', 'fLast', 'fManual'].forEach(id => $(id).addEventListener('input', updateFormCalc));
['fName', 'fGame'].forEach(id => { $(id).addEventListener('input', syncCM); $(id).addEventListener('change', syncCM); });
$('fCM').addEventListener('input', () => { $('fCM').dataset.auto = '0'; });
$('fOpenCM').addEventListener('click', () => openCM($('fCM').value || cmUrl($('fName').value, $('fGame').value)));
$('fCancel').addEventListener('click', () => go('list'));
$('fDelete').addEventListener('click', async () => {
  const id = $('fId').value; if (!id) return;
  if (!confirm(`Supprimer l'achat ${id} et ses photos ?`)) return;
  for (const ph of await photosOf(id)) await dbDel('photos', ph.id);
  await dbDel('purchases', id); delete thumbCache[id];
  PURCHASES = PURCHASES.filter(p => p.id !== id);
  renderAll(); go('list'); toast('Achat supprimé');
});
$('pForm').addEventListener('submit', async e => {
  e.preventDefault();
  const p = formObj();
  if (!p.priceYen) { toast('Indique le prix en ¥'); return; }
  if (!p.rate) { toast('Taux ¥/€ manquant'); return; }
  const isNew = !$('fId').value;
  p.updatedAt = Date.now(); if (isNew) p.createdAt = Date.now();
  await dbPut('purchases', p);
  if (p.game && p.game !== S.lastGame) { S.lastGame = p.game; SIM_GAME = null; await saveSettings(); renderSimGames(); }
  for (const id of EDIT_DELETED) await dbDel('photos', id);
  let i = 0;
  for (const ph of EDIT_PHOTOS) {
    if (ph._new) { const { _new, ...rest } = ph; rest.id = `${p.id}_${rest.kind}_${Date.now()}_${i++}`; rest.purchaseId = p.id; await dbPut('photos', rest); }
  }
  delete thumbCache[p.id];
  const idx = PURCHASES.findIndex(x => x.id === p.id);
  if (idx >= 0) PURCHASES[idx] = p; else PURCHASES.push(p);
  renderAll(); go('list');
  const c = calcLine(p);
  toast(`${p.id} enregistré · ${pctTxt(c.pct)}`);
});

/* Photos : compression + miniature */
function loadImg(file) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { res(img); }; img.onerror = rej; img.src = url; });
}
function drawScaled(img, max, q) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function processFile(file, kind) {
  const img = await loadImg(file);
  const full = drawScaled(img, 1800, 0.82);
  const blob = await new Promise(r => full.toBlob(r, 'image/jpeg', 0.82));
  const thumb = drawScaled(img, 240, 0.7).toDataURL('image/jpeg', 0.7);
  URL.revokeObjectURL(img.src);
  return { kind, blob, thumb, _new: true, createdAt: Date.now() };
}
async function onFiles(input, kind) {
  const files = [...input.files]; input.value = '';
  for (const f of files) { try { EDIT_PHOTOS.push(await processFile(f, kind)); } catch (e) { toast('Photo illisible'); } }
  renderFormPhotos();
}
$('fTicket').addEventListener('change', e => onFiles(e.target, 'ticket'));
$('fProduct').addEventListener('change', e => onFiles(e.target, 'produit'));
$('fProductLib').addEventListener('change', e => onFiles(e.target, 'produit'));
function renderFormPhotos() {
  for (const [kind, box] of [['ticket', $('thumbsTicket')], ['produit', $('thumbsProduct')]]) {
    box.innerHTML = '';
    EDIT_PHOTOS.forEach((ph, i) => {
      if (ph.kind !== kind) return;
      const d = document.createElement('div'); d.className = 'thumb';
      d.innerHTML = `<img src="${ph.thumb}" alt=""><button type="button" aria-label="Retirer">✕</button>`;
      d.querySelector('img').onclick = () => showPhoto(ph);
      d.querySelector('button').onclick = () => { if (ph.id) EDIT_DELETED.push(ph.id); EDIT_PHOTOS.splice(i, 1); renderFormPhotos(); };
      box.appendChild(d);
    });
  }
}
function showPhoto(ph) { const u = URL.createObjectURL(ph.blob); $('viewerImg').src = u; $('viewer').classList.remove('hidden'); }
$('viewer').addEventListener('click', () => { $('viewer').classList.add('hidden'); URL.revokeObjectURL($('viewerImg').src); });

/* ---------- Douane ---------- */
function customsData() {
  const t = totals();
  const r = num(S.customsRate) || currentRate();
  const value = r ? t.yenNet / r : 0;
  const duty = value * S.duty / 100;
  const vat = (value + duty) * S.vat / 100;
  return { rate: r, yenNet: t.yenNet, value, duty, vat, toPay: duty + vat, broker: S.broker, total: duty + vat + S.broker };
}
function renderCustoms() {
  $('cReturn').value = S.returnDate || '';
  $('cRate').value = S.customsRate || '';
  $('cRateInfo').textContent = S.customsRateInfo ? `(${S.customsRateInfo})` : (num(S.customsRate) ? '' : '(vide = taux du jour)');
  const c = customsData();
  $('customsTbl').innerHTML = `
    <tr><td>Marchandises (net de taxe JP)</td><td>${yen(c.yenNet)}</td></tr>
    <tr><td>Taux utilisé</td><td>${c.rate ? nf2.format(c.rate) + ' ¥/€' : '—'}</td></tr>
    <tr><td>Valeur en douane</td><td>${eur2(c.value)}</td></tr>
    <tr><td>Droits de douane (${nf2.format(S.duty)} %)</td><td>${eur2(c.duty)}</td></tr>
    <tr><td>TVA d'import (${S.vat} %)</td><td>${eur2(c.vat)}</td></tr>
    <tr class="total"><td>À payer à la douane</td><td>${eur2(c.toPay)}</td></tr>
    <tr><td>+ Transitaire (estimation)</td><td>${eur2(c.broker)}</td></tr>
    <tr><td>Coût rendu en France (marchandises + douane + transitaire)</td><td>${eur2(c.value + c.total)}</td></tr>`;
}
$('cReturn').addEventListener('change', async () => { S.returnDate = $('cReturn').value; await saveSettings(); fetchCustoms(); });
$('cRate').addEventListener('change', async () => { S.customsRate = $('cRate').value; S.customsRateInfo = 'saisi manuellement'; await saveSettings(); renderCustoms(); });
$('cFetch').addEventListener('click', fetchCustoms);
async function fetchCustoms() {
  const ref = customsRefDate(S.returnDate);
  if (new Date(ref + 'T18:00:00') > new Date()) { S.customsRateInfo = `pas encore publié (réf. ${ref.split('-').reverse().join('/')}) — taux du jour utilisé`; S.customsRate = ''; await saveSettings(); renderCustoms(); return; }
  try {
    const r = await fetchRateFor(ref);
    S.customsRate = String(r.value); S.customsRateInfo = `BCE du ${r.date.split('-').reverse().join('/')}, mois de retour`;
    await saveSettings(); renderCustoms(); toast('Taux douanier récupéré');
  } catch (e) { toast('Hors ligne : taux douanier non récupéré'); }
}

/* ---------- Export Excel ---------- */
const FILL = { red: 'FFFCA5A5', orange: 'FFFCD34D', green: 'FF86EFAC', none: 'FFE5E7EB' };
const LABEL = { red: 'ROUGE', orange: 'ORANGE', green: 'VERT', none: '—' };
async function waitExcel() { for (let i = 0; i < 50 && !window.ExcelJS; i++) await new Promise(r => setTimeout(r, 100)); if (!window.ExcelJS) throw new Error('ExcelJS absent'); }
async function buildExcel() {
  await waitExcel();
  const wb = new ExcelJS.Workbook(); wb.creator = 'BlueLine'; wb.created = new Date();
  const t = totals(); const cu = customsData();
  const head = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } }, alignment: { vertical: 'middle', wrapText: true } };

  // Synthèse
  const s = wb.addWorksheet('Synthèse');
  s.columns = [{ width: 38 }, { width: 22 }];
  s.addRow(['BlueLine — synthèse du voyage']).font = { bold: true, size: 16 };
  s.addRow([`Export du ${new Date().toLocaleString('fr-FR')}`]);
  s.addRow([]);
  const st = s.addRow(['RENTABILITÉ DU PANIER', t.pct == null ? '—' : `${pctTxt(t.pct)} — ${LABEL[t.color]}`]);
  st.font = { bold: true, size: 14 }; st.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[t.color] } };
  const rows = [
    ['Nombre d\'achats', PURCHASES.length], ['Total dépensé (€, net de taxe JP)', +t.spentAll.toFixed(2)], ['Total dépensé (¥ net)', Math.round(t.yenNet)],
    ['Total revente estimée (€)', +t.est.toFixed(2)], ['Budget prévu (€)', S.budget], ['Budget restant (€)', +t.left.toFixed(2)],
    ['Coût du voyage (€)', S.trip], ['Droits + TVA import estimés (€)', +cu.toPay.toFixed(2)], ['Transitaire (€)', S.broker],
    ['Frais de vente (%)', S.fees], ['Bénéfice projeté (€)', t.profit == null ? '' : +t.profit.toFixed(2)],
    [], ['Seuils', `Rouge < ${S.red} % · Orange ${S.red}–${S.green} % · Vert ≥ ${S.green} %`], ['Marge de négo appliquée (%)', S.nego],
    ['Taux ¥/€ du jour', currentRate() ? +currentRate().toFixed(2) : '']
  ];
  rows.forEach(r => s.addRow(r));
  s.getColumn(2).numFmt = '#,##0.00';

  // Achats
  const a = wb.addWorksheet('Achats', { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    ['N°', 7], ['Date', 11], ['Boutique', 18], ['Article', 30], ['Jeu', 11], ['Catégorie', 13], ['Qté', 5], ['Prix ¥ TTC', 11], ['Tax-free', 8],
    ['Remb. ¥', 10], ['Net ¥', 11], ['Taux ¥/€', 9], ['Coût €', 10], ['1er prix CM €/u', 11], ['Dern. vente CM €/u', 11], ['Estimation € (total)', 12],
    ['Marge %', 9], ['Statut', 10], ['Paiement', 16], ['Lien Cardmarket', 16], ['Notes', 24], ['Photo', 13]
  ];
  a.columns = cols.map(([h, w]) => ({ header: h, width: w }));
  a.getRow(1).eachCell(c => Object.assign(c, head)); a.getRow(1).height = 32;
  const sorted = [...PURCHASES].sort((x, y) => x.id.localeCompare(y.id));
  let r = 2;
  for (const p of sorted) {
    const c = calcLine(p);
    const row = a.getRow(r);
    row.values = [p.id, p.date || '', p.shop || '', p.name || '', gameLabel(p.game), p.cat || '', c.qty,
      Math.round(c.priceYen), p.taxFree ? 'Oui' : 'Non', Math.round(c.refundYen), Math.round(c.netYen), c.rate ? +c.rate.toFixed(2) : '',
      c.cost != null ? +c.cost.toFixed(2) : '', p.cmFirst ?? '', p.cmLast ?? '', c.est != null ? +c.est.toFixed(2) : '',
      c.pct != null ? +(c.pct / 100).toFixed(4) : '', LABEL[c.color], p.pay || '', p.cmUrl ? { text: 'Ouvrir', hyperlink: p.cmUrl } : '', p.notes || '', ''];
    row.height = 62; row.alignment = { vertical: 'middle', wrapText: true };
    row.getCell(17).numFmt = '0%';
    [8, 10, 11].forEach(i => row.getCell(i).numFmt = '#,##0');
    [13, 16].forEach(i => row.getCell(i).numFmt = '#,##0.00');
    const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[c.color] } };
    row.getCell(17).fill = fill; row.getCell(18).fill = fill; row.getCell(18).font = { bold: true };
    if (p.cmUrl) row.getCell(20).font = { color: { argb: 'FF2563EB' }, underline: true };
    const ph = await photosOf(p.id);
    const pick = ph.find(x => x.kind === 'produit') || ph[0];
    if (pick) {
      const id = wb.addImage({ base64: pick.thumb, extension: 'jpeg' });
      a.addImage(id, { tl: { col: 21.1, row: r - 1 + 0.08 }, ext: { width: 76, height: 76 } });
    }
    r++;
  }
  const tr = a.getRow(r + 1);
  tr.getCell(4).value = 'TOTAL'; tr.getCell(11).value = Math.round(t.yenNet); tr.getCell(13).value = +t.spentAll.toFixed(2); tr.getCell(16).value = +t.est.toFixed(2);
  tr.getCell(17).value = t.pct != null ? +(t.pct / 100).toFixed(4) : ''; tr.getCell(17).numFmt = '0%'; tr.getCell(18).value = LABEL[t.color];
  tr.getCell(17).fill = tr.getCell(18).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[t.color] } };
  tr.font = { bold: true }; tr.getCell(11).numFmt = '#,##0'; [13, 16].forEach(i => tr.getCell(i).numFmt = '#,##0.00');
  a.autoFilter = { from: 'A1', to: 'V1' };

  // Douane
  const d = wb.addWorksheet('Douane');
  d.columns = [{ width: 46 }, { width: 18 }];
  d.addRow(['Récapitulatif douane (indicatif — le transitaire fait foi)']).font = { bold: true, size: 14 };
  d.addRow([]);
  [['Marchandises net de taxe JP (¥)', Math.round(cu.yenNet)], ['Taux de change retenu (¥ pour 1 €)', cu.rate ? +cu.rate.toFixed(2) : ''],
  ['Source du taux', S.customsRateInfo || 'taux du jour'], ['Valeur en douane (€)', +cu.value.toFixed(2)],
  [`Droits de douane ${S.duty} % (€)`, +cu.duty.toFixed(2)], [`TVA d'import ${S.vat} % (€)`, +cu.vat.toFixed(2)],
  ['Total à payer à la douane (€)', +cu.toPay.toFixed(2)], ['Transitaire estimé (€)', S.broker],
  ['Date de retour', S.returnDate || ''], ['Nomenclature', '9504 40 00 — cartes à jouer'], ['Nombre de tickets / achats', PURCHASES.length]
  ].forEach(x => d.addRow(x));
  d.getRow(9).font = { bold: true };
  return wb.xlsx.writeBuffer();
}
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30000); return true;
}
const stamp = () => todayISO();
$('xExcel').addEventListener('click', async () => {
  try { toast('Préparation de l\'Excel…'); const buf = await buildExcel(); await deliver(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `blueline_${stamp()}.xlsx`); }
  catch (e) { console.error(e); toast('Erreur export Excel'); }
});
async function buildZip() {
  const zip = new JSZip(); const all = await dbGetAll('photos');
  const counters = {};
  all.sort((a, b) => a.id.localeCompare(b.id)).forEach(ph => {
    const k = ph.purchaseId + '_' + ph.kind; counters[k] = (counters[k] || 0) + 1;
    zip.file(`${ph.purchaseId}_${ph.kind}_${counters[k]}.jpg`, ph.blob);
  });
  return zip.generateAsync({ type: 'blob' });
}
$('xZip').addEventListener('click', async () => {
  try { toast('Préparation du ZIP…'); const b = await buildZip(); await deliver(new Blob([b], { type: 'application/zip' }), `blueline_photos_${stamp()}.zip`); }
  catch (e) { console.error(e); toast('Erreur export photos'); }
});

/* ---------- Sauvegarde / restauration ---------- */
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();
async function buildBackup() {
  const photos = await dbGetAll('photos');
  const ph = [];
  for (const p of photos) ph.push({ ...p, blob: await blobToDataURL(p.blob) });
  const { lastBackup, ...settings } = S;
  return new Blob([JSON.stringify({ app: 'blueline', version: APP_VERSION, exportedAt: new Date().toISOString(), settings, purchases: PURCHASES, photos: ph })], { type: 'application/json' });
}
$('xBackup').addEventListener('click', async () => {
  try {
    toast('Préparation de la sauvegarde…');
    const ok = await deliver(await buildBackup(), `blueline_sauvegarde_${stamp()}.json`);
    if (ok) { S.lastBackup = Date.now(); await saveSettings(); renderDash(); toast('Sauvegarde exportée'); }
  } catch (e) { console.error(e); toast('Erreur sauvegarde'); }
});
$('xRestore').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.app !== 'blueline' && j.app !== 'tcg-trip') throw new Error('format');
    if (!confirm(`Restaurer ${j.purchases.length} achats et ${j.photos.length} photos ? Les données actuelles seront remplacées.`)) return;
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction(['purchases', 'photos'], 'readwrite'); t.objectStore('purchases').clear(); t.objectStore('photos').clear(); t.oncomplete = res; t.onerror = rej; });
    for (const p of j.purchases) await dbPut('purchases', p);
    for (const p of j.photos) await dbPut('photos', { ...p, blob: await dataURLToBlob(p.blob) });
    S = { ...DEFAULTS, ...j.settings, lastBackup: Date.now() }; await saveSettings();
    thumbCache = {}; await loadAll(); toast('Sauvegarde restaurée');
  } catch (err) { console.error(err); toast('Fichier de sauvegarde invalide'); }
});

/* ---------- Réglages ---------- */
const SET_MAP = { stBudget: 'budget', stTrip: 'trip', stNego: 'nego', stFees: 'fees', stRed: 'red', stGreen: 'green', stTax: 'tax', stBroker: 'broker', stDuty: 'duty', stVat: 'vat', stGame: 'game', stManualRate: 'manualRate' };
function renderSettings() {
  fillGames($('stGame'), S.game);
  for (const [id, k] of Object.entries(SET_MAP)) $(id).value = S[k] ?? '';
  $('versionTxt').textContent = `BlueLine v${APP_VERSION} · données stockées sur cet appareil uniquement`;
}
async function saveSettings() { await dbPut('kv', S, 'settings'); }
$('setForm').addEventListener('submit', async e => {
  e.preventDefault();
  for (const [id, k] of Object.entries(SET_MAP)) {
    const v = $(id).value;
    S[k] = (k === 'game' || k === 'manualRate') ? v : (num(v) ?? DEFAULTS[k]);
  }
  if (S.green < S.red) S.green = S.red;
  await saveSettings(); renderRateBadge(); renderAll(); toast('Réglages enregistrés');
});

/* ---------- Démarrage ---------- */
function renderAll() { renderDash(); renderSim(); renderList(); if ($('view-customs').classList.contains('active')) renderCustoms(); }
async function loadAll() {
  const saved = await dbGet('kv', 'settings');
  S = { ...DEFAULTS, ...(saved || {}) };
  PURCHASES = await dbGetAll('purchases');
  renderSettings(); renderSimGames(); renderRateBadge(); renderAll();
}
function mountIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(i => { const svg = (window.ICONS || {})[i.dataset.icon]; if (svg) i.outerHTML = svg; });
}
(async function init() {
  mountIcons();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { }
  await loadAll();
  refreshRate();
  window.addEventListener('online', refreshRate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (!RATE.fetchedAt || Date.now() - RATE.fetchedAt > 3 * 3600 * 1000)) refreshRate(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
