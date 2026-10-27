// ==UserScript==
// @name         Torn Shop Counter
// @namespace    torn-shop-counter
// @version      2.7
// @description  On city shop pages, counts the items you've bought since the daily reset (from your Torn log, via the official API; works with a custom key limited to user > log and the Shops log category) and shows how many you can still buy.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- settings ----------------------------------------------------------
  const DAILY_CAP = 100;                          // city shop items allowed per Torn day
  const SHOP_PATH_RE = /\/(shops|bigalgunshop)\.php/i; // pages where the counter shows
  // Verified against a real log: city shop purchases are log type 4200 ("Item shop buy", category Shops).
  // Used whenever the key isn't allowed to list log types (a Shops-only custom key can't).
  const FALLBACK_TYPE_IDS = ['4200'];
  // Which log entries count as city shop purchases (matched on the log type's title).
  const SHOP_TITLE_RE = /shop|store|pharmacy|big al|bits ?'?n'? ?bobs|cyber ?force|docks|jewel|pawn|print works|super ?store|sweet|clothes|recycling/i;
  const BUY_RE = /bought|buy|purchas/i;
  const EXCLUDE_RE = /abroad|travel|foreign|overseas|market|bazaar|auction|sell|sold/i;
  const MIN_REFRESH_MS = 3000;                    // never hit the API more often than this
  const POLL_MS = 30000;                          // background refresh while the page is open

  // ---- API key -----------------------------------------------------------
  // This script keeps its OWN key (separate from the target finder and from the
  // key Torn PDA fills in), because reading the log needs more access than a
  // limited key gives. It asks once and remembers it on this device.
  const KEY_SLOT = 'ts_log_key';
  // Opens Torn's "add new key" form with the right settings already filled in:
  // user > log, limited to the Shops log category (id 86), titled "ShopsKey".
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=log&logIds=86&title=ShopsKey';
  let API_KEY = '';
  try { API_KEY = localStorage.getItem(KEY_SLOT) || ''; } catch (e) { API_KEY = ''; }
  function ensureKey() { return !!API_KEY; }
  function saveKey(k) {
    k = (k || '').trim();
    if (!k) return false;
    API_KEY = k;
    try { localStorage.setItem(KEY_SLOT, API_KEY); } catch (e) {}
    return true;
  }

  // ---- time --------------------------------------------------------------
  // Torn's day starts at midnight Torn City Time, which is UTC.
  const nowSec = () => Math.floor(Date.now() / 1000);
  function resetTs(now) {
    const d = new Date(now * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  }
  function untilReset(now) {
    const s = resetTs(now) + 86400 - now;
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function tct(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' TCT';
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, params) {
    const q = new URLSearchParams(Object.assign({}, params, { key: API_KEY }));
    const r = await fetch('https://api.torn.com/v2/' + path + '?' + q.toString());
    const j = await r.json();
    if (j && j.error) {
      const err = new Error(j.error.error || 'API error');
      err.code = j.error.code;
      throw err;
    }
    return j;
  }

  function isShopTitle(title) {
    return SHOP_TITLE_RE.test(title) && BUY_RE.test(title) && !EXCLUDE_RE.test(title);
  }

  // Ask Torn which log types exist (v2: { logtypes: [ {id, title} ] }) and keep
  // the ones that look like city shop purchases.
  let shopTypes = null; // { id: title } or null if none matched / lookup failed
  let allTypeCount = 0;
  let typesTried = false;   // a log-only custom key may not be allowed to list log types; don't keep retrying
  let learnedIds = [];      // shop log type ids learned from entries when the type list isn't available
  async function loadTypes() {
    if (shopTypes || typesTried) return shopTypes;
    typesTried = true;
    try {
      const j = await api('torn/logtypes', {});
      const list = Array.isArray(j.logtypes) ? j.logtypes : [];
      allTypeCount = list.length;
      const found = {};
      list.forEach((t) => { if (t && t.title && isShopTitle(t.title)) found[t.id] = t.title; });
      // The log's own name for city shop purchases is "Item shop buy": if that type exists, use only it.
      const exact = {};
      Object.keys(found).forEach((k) => { if (/^\s*item shop buy\s*$/i.test(found[k])) exact[k] = found[k]; });
      if (Object.keys(exact).length) { Object.keys(found).forEach((k) => delete found[k]); Object.assign(found, exact); }
      shopTypes = Object.keys(found).length ? found : null;
    } catch (e) {
      if (e.code === 2) throw e; // bad key: surface it
      shopTypes = null;
    }
    return shopTypes;
  }

  // Pull today's log entries (v2: { log: [ {id, timestamp, details:{id,title,category}, data, params} ] }),
  // paging back if there are many.
  async function loadLog(from, typeIds) {
    const entries = new Map();
    let to = nowSec();
    let incomplete = false;
    for (let page = 0; page < 10; page++) {
      const params = { from: from, to: to, limit: 100, timestamp: nowSec() };
      if (typeIds && typeIds.length) params.log = typeIds.join(',');
      const j = await api('user/log', params);
      const rows = Array.isArray(j.log) ? j.log : [];
      if (!rows.length) break;
      let minTs = Infinity, added = 0;
      rows.forEach((r) => {
        const key = String(r.id);
        if (!entries.has(key)) { entries.set(key, r); added++; }
        minTs = Math.min(minTs, +r.timestamp || Infinity);
      });
      if (rows.length < 100) break;
      if (!added || !(minTs > from)) { incomplete = !added || incomplete; break; }
      to = minTs; // same-second entries are de-duplicated by id
      if (page === 9) incomplete = true;
    }
    return { list: Array.from(entries.values()), incomplete };
  }

  // How many items one log entry represents (falls back to 1 if it doesn't say).
  const entryTitle = (e) => (e && e.details && e.details.title) || e.title || '';
  const entryTypeId = (e) => (e && e.details && e.details.id != null) ? e.details.id : e.log;
  function entryQty(e) {
    const d = e && e.data ? e.data : {};
    if (Array.isArray(d.items)) {
      const s = d.items.reduce((a, i) => a + (+(i && (i.qty || i.quantity || i.amount)) || 1), 0);
      return { n: s || 1, known: true };
    }
    const keys = ['quantity', 'qty', 'amount', 'items_bought', 'item_amount', 'count'];
    for (let i = 0; i < keys.length; i++) {
      if (+d[keys[i]] > 0) return { n: +d[keys[i]], known: true };
    }
    return { n: 1, known: false };
  }

  // ---- UI ----------------------------------------------------------------
  const banner = document.createElement('div');
  banner.style.cssText =
    'display:block;margin:4px auto;padding:5px 12px;background:#333;color:#ddd;max-width:92%;' +
    'border:1px solid #777;border-radius:14px;font:13px sans-serif;text-align:center;cursor:pointer;';
  const diag = document.createElement('div');
  diag.style.cssText =
    'display:none;margin:4px auto;padding:6px 10px;background:#1a1a1a;color:#bbb;max-width:92%;' +
    'border:1px solid #444;border-radius:6px;font:11px sans-serif;line-height:1.5;';
  banner.addEventListener('click', () => {
    if (!API_KEY) { showSetup(); return; }
    diag.style.display = diag.style.display === 'none' ? 'block' : 'none';
  });
  const diagText = document.createElement('div');
  const keyBtn = document.createElement('button');
  keyBtn.textContent = 'Change API key';
  keyBtn.style.cssText =
    'margin-top:6px;padding:2px 10px;background:#333;color:#ddd;border:1px solid #777;' +
    'border-radius:10px;font:11px sans-serif;';
  keyBtn.addEventListener('click', (e) => { e.stopPropagation(); showSetup(); });
  diag.appendChild(diagText);
  diag.appendChild(keyBtn);

  // Key setup panel: a shortcut to Torn's key form (pre-filled) plus a box to paste the key into.
  const setup = document.createElement('div');
  setup.style.cssText =
    'display:none;margin:4px auto;padding:8px 12px;background:#1a1a1a;color:#ddd;max-width:92%;' +
    'border:1px solid #9d9;border-radius:6px;font:12px sans-serif;line-height:1.6;text-align:center;';
  const setupMsg = document.createElement('div');
  setupMsg.textContent = 'The shop counter needs its own API key (it reads your log).';
  const setupLink = document.createElement('a');
  setupLink.href = KEY_URL;
  setupLink.textContent = '1. Create the key on Torn (settings pre-filled)';
  setupLink.style.cssText =
    'display:inline-block;margin:6px 0;padding:4px 12px;background:#2d5a2d;color:#fff;' +
    'border:1px solid #9d9;border-radius:12px;text-decoration:none;font:12px sans-serif;';
  const setupHint = document.createElement('div');
  setupHint.style.cssText = 'font-size:11px;color:#aaa;';
  setupHint.textContent = 'On that page press Create, copy the new key, then come back to a shop page and paste it below.';
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = '2. Paste your key here';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('autocorrect', 'off');
  keyInput.spellcheck = false;
  keyInput.style.cssText =
    'display:block;margin:6px auto;width:80%;max-width:320px;padding:4px 8px;background:#111;color:#eee;' +
    'border:1px solid #777;border-radius:6px;font:12px monospace;box-sizing:border-box;';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save key';
  saveBtn.style.cssText =
    'margin:0 4px;padding:3px 14px;background:#333;color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText =
    'margin:0 4px;padding:3px 14px;background:#333;color:#ddd;border:1px solid #777;border-radius:10px;font:12px sans-serif;';
  setup.appendChild(setupMsg);
  setup.appendChild(setupLink);
  setup.appendChild(setupHint);
  setup.appendChild(keyInput);
  setup.appendChild(saveBtn);
  setup.appendChild(cancelBtn);
  function showSetup() {
    if (setup.style.display === 'block') return; // already open: don't wipe a half-pasted key
    keyInput.value = '';
    cancelBtn.style.display = API_KEY ? 'inline-block' : 'none';
    setup.style.display = 'block';
  }
  function submitKey() {
    if (!saveKey(keyInput.value)) return;
    keyInput.value = '';
    setup.style.display = 'none';
    shopTypes = null; typesTried = false; learnedIds = [];
    banner.textContent = '🛒 Checking shop purchases…';
    refresh(true);
  }
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); submitKey(); });
  cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); setup.style.display = 'none'; });
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });

  function ensureUI() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (banner.parentNode !== host || host.firstChild !== banner) host.insertBefore(banner, host.firstChild);
    if (diag.parentNode !== host) host.insertBefore(diag, banner.nextSibling);
    if (setup.parentNode !== host) host.insertBefore(setup, diag.nextSibling);
  }
  function errorText(err) {
    if (err.code === 2) return 'API key not accepted - check it';
    if (err.code === 16) return 'Key needs access to user > log (custom key with that selection, or Full)';
    if (err.code === 5) return 'Rate limited - retrying shortly';
    return 'API error: ' + err.message;
  }

  function render(res) {
    const left = DAILY_CAP - res.total;
    let colour = '#9d9';
    if (left <= 10) colour = '#fc6';
    if (left <= 0) colour = '#f88';
    banner.style.borderColor = colour;
    banner.textContent = left > 0
      ? '🛒 Shop items today: ' + res.total + ' / ' + DAILY_CAP + ' · ' + left + ' left'
      : '🛒 Shop limit reached: ' + res.total + ' / ' + DAILY_CAP;

    const now = nowSec();
    const lines = [
      'Daily reset: 00:00 TCT (in ' + untilReset(now) + ')',
      'Matching log types: ' + (res.typeTitles.length ? res.typeTitles.length + ' types: ' + res.typeTitles.join(' | ') : 'type list not available to this key - using log type ' + FALLBACK_TYPE_IDS.join(', ') + ' ("Item shop buy")'),
      'Entries today: ' + res.count + ' · items counted: ' + res.total,
    ];
    if (res.unknownQty) lines.push(res.unknownQty + ' entr' + (res.unknownQty === 1 ? 'y' : 'ies') + " didn't state a quantity, counted as 1 each");
    if (res.incomplete) lines.push('Warning: more log entries than could be read - the count may be low');
    res.recent.forEach((e) => lines.push('• ' + tct(e.timestamp) + ' ' + (entryTitle(e) || ('log ' + entryTypeId(e)))));
    if (res.recent[0]) {
      let sample = '';
      try { sample = JSON.stringify(res.recent[0].data); } catch (x) {}
      lines.push('Sample entry data: ' + (sample || '{}').slice(0, 220));
    }
    if (!res.typeTitles.length && allTypeCount) lines.push('(' + allTypeCount + ' log types checked)');
    diagText.textContent = '';
    lines.forEach((l) => { const d = document.createElement('div'); d.textContent = l; diagText.appendChild(d); });
  }

  // Ask Torn what this key is allowed to do and show it in the details panel.
  let infoShown = false;
  async function showKeyInfo() {
    if (infoShown) return;
    infoShown = true;
    const d = document.createElement('div');
    d.textContent = 'Checking what this key can do…';
    diagText.appendChild(d);
    try {
      const j = await api('key/info', {});
      let t = JSON.stringify(j);
      if (API_KEY) t = t.split(API_KEY).join('(key hidden)');
      d.textContent = 'Key info: ' + t.slice(0, 700);
    } catch (e) {
      d.textContent = 'Key info unavailable: ' + e.message + (e.code != null ? ' (code ' + e.code + ')' : '');
    }
    setTimeout(() => { infoShown = false; }, 60000);
  }

  // ---- refresh -----------------------------------------------------------
  let busy = false, lastRun = 0, last = null;
  async function refresh(force) {
    if (busy || (!force && Date.now() - lastRun < MIN_REFRESH_MS)) return;
    if (!ensureKey()) { banner.textContent = '🛒 Add an API key to count shop items (tap here)'; showSetup(); return; }
    busy = true; lastRun = Date.now();
    try {
      const types = await loadTypes();
      const from = resetTs(nowSec());
      // Always ask for specific log types: a Shops-only key is refused if it asks for the whole log.
      const ids = types ? Object.keys(types) : (learnedIds.length ? learnedIds : FALLBACK_TYPE_IDS);
      const log = await loadLog(from, ids);
      const mine = log.list.filter((e) => {
        if ((+e.timestamp || 0) < from) return false;
        if (types) return Object.prototype.hasOwnProperty.call(types, String(entryTypeId(e)));
        return isShopTitle(entryTitle(e));
      });
      if (!types) mine.forEach((e) => { const id = String(entryTypeId(e)); if (learnedIds.indexOf(id) < 0) learnedIds.push(id); });
      let total = 0, unknownQty = 0;
      mine.forEach((e) => { const q = entryQty(e); total += q.n; if (!q.known) unknownQty++; });
      mine.sort((a, b) => b.timestamp - a.timestamp);
      last = {
        total, unknownQty, count: mine.length, incomplete: log.incomplete,
        typeTitles: types ? Object.keys(types).map((k) => types[k]) : [],
        viaTitles: !types,
        recent: mine.slice(0, 3),
      };
      render(last);
    } catch (err) {
      banner.textContent = '🛒 ' + errorText(err);
      diagText.textContent = 'Details: ' + err.message + (err.code != null ? ' (code ' + err.code + ')' : '');
      if (err.code === 2 || err.code === 16) diag.style.display = 'block'; // show the Change API key button
      if (err.code === 16) showKeyInfo();
    }
    busy = false;
  }

  // The counter only runs on shop pages: recognised by address, or by the
  // "Buy items" heading that every shop page has.
  function isShopPage() {
    if (SHOP_PATH_RE.test(location.pathname)) return true;
    // Fallback for shop pages at other addresses: an element whose whole text is
    // "Buy items" (not just text that mentions it, like a profile bio would).
    if (/profiles\.php|forums\.php|messages\.php|factions\.php/i.test(location.pathname)) return false;
    return [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span,a')].some(
      (el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === 'buy items'
    );
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    ensureUI();
    document.addEventListener('DOMContentLoaded', ensureUI);
    window.addEventListener('load', ensureUI);
    setInterval(ensureUI, 2000);
    banner.textContent = '🛒 Checking shop purchases…';
    refresh(true);
    setInterval(() => { if (document.visibilityState !== 'hidden') refresh(false); }, POLL_MS);
    // After any tap (e.g. Buy), re-check shortly: the log updates a moment after a purchase.
    document.addEventListener('click', () => {
      setTimeout(() => refresh(false), 2000);
      setTimeout(() => refresh(false), 5000);
    }, true);
  }

  if (isShopPage()) {
    start();
  } else {
    let tries = 0;
    const wait = setInterval(() => {
      if (isShopPage()) { clearInterval(wait); start(); }
      else if (++tries > 10) clearInterval(wait);
    }, 1000);
  }
})();
