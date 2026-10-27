// ==UserScript==
// @name         Torn Retribution List
// @namespace    torn-retribution-list
// @version      2.0
// @description  Adds a "Retribution List" entry to Torn's navigation menu. Tap it on any page to see who attacked you recently (anonymous attacks skipped), with repeat-attacker counts and a one-tap revenge link. Uses the official API (user > attacks, a Limited key is enough).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes

  // ---- settings ----------------------------------------------------------
  const WINDOW_DAYS = 7;                          // how far back to look
  const MAX_PAGES = 5;                            // up to 100 attacks per page
  const MAX_LISTED = 20;                          // longest list shown
  const ENTRY_LABEL = 'Retribution List';
  const BG_REFRESH_MS = 3 * 60 * 1000;            // refresh the count in the background at most this often
  const OPEN_REFRESH_MS = 30 * 1000;              // when opening the list, refresh if older than this

  // ---- API key -----------------------------------------------------------
  // Uses a key saved here, else the Torn PDA key (placeholder below), else the one the
  // Find Target loader stored ('ht_api_key'). If those can't read attacks, the list offers
  // a shortcut to make a key of its own.
  const OWN_SLOT = 'ta_key';
  const SHARED_SLOT = 'ht_api_key';
  const CACHE_SLOT = 'tr_cache';
  // Opens Torn's "add new key" form with user > attacks pre-filled.
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=attacks&title=RetributionKey';
  // Torn PDA swaps this placeholder for your own key when the script is pasted straight into it.
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = (PDA_KEY && !PDA_KEY.startsWith('###')) ? PDA_KEY : '';
  function readSlot(slot) { try { return localStorage.getItem(slot) || ''; } catch (e) { return ''; } }
  let ownKey = readSlot(OWN_SLOT);
  const getKey = () => ownKey || pdaKey || readSlot(SHARED_SLOT);

  // ---- time --------------------------------------------------------------
  const nowSec = () => Math.floor(Date.now() / 1000);
  function ago(ts) {
    const s = Math.max(0, nowSec() - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, params) {
    const q = new URLSearchParams(Object.assign({}, params, { key: getKey(), comment: 'TornRetributionList' }));
    const r = await fetch('https://api.torn.com/v2/' + path + '?' + q.toString());
    const j = await r.json();
    if (j && j.error) {
      const err = new Error(j.error.error || 'API error');
      err.code = j.error.code;
      throw err;
    }
    return j;
  }

  // Incoming attacks since `from`, newest first, paging back with `to`.
  async function loadAttacks(from) {
    const seen = new Map();
    let to = nowSec();
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await api('user/attacks', { filters: 'incoming', limit: 100, sort: 'desc', from: from, to: to, timestamp: nowSec() });
      const rows = Array.isArray(j.attacks) ? j.attacks : [];
      if (!rows.length) break;
      let minTs = Infinity, added = 0;
      rows.forEach((a) => {
        const k = String(a.id);
        if (!seen.has(k)) { seen.set(k, a); added++; }
        minTs = Math.min(minTs, +a.started || Infinity);
      });
      if (rows.length < 100 || !added || !(minTs > from)) break;
      to = minTs;
    }
    return Array.from(seen.values());
  }

  // Group non-anonymous attackers: { id, name, level, faction, count, last, lastResult }
  function summarise(attacks) {
    const by = new Map();
    let hidden = 0, total = 0;
    attacks.forEach((a) => {
      total++;
      const who = a.attacker;
      if (!who || a.is_stealthed || !who.id) { hidden++; return; }
      const ts = +a.ended || +a.started || 0;
      let e = by.get(who.id);
      if (!e) { e = { id: who.id, name: who.name, level: who.level, faction: who.faction && who.faction.name, count: 0, last: 0, lastResult: '' }; by.set(who.id, e); }
      e.count++;
      if (ts >= e.last) { e.last = ts; e.lastResult = a.result || ''; e.level = who.level; e.name = who.name; e.faction = who.faction && who.faction.name; }
    });
    const list = Array.from(by.values()).sort((x, y) => (y.count - x.count) || (y.last - x.last));
    return { list, hidden, total, ts: nowSec() };
  }

  // ---- state -------------------------------------------------------------
  let data = null;            // last summary { list, hidden, total, ts }
  let problem = null;         // { code, message } from the last failed refresh
  let busy = false;
  try { const c = JSON.parse(readSlot(CACHE_SLOT) || 'null'); if (c && Array.isArray(c.list)) data = c; } catch (e) { data = null; }

  async function refresh(force) {
    if (busy) return;
    if (!getKey()) { problem = { code: 'nokey' }; updateBadge(); render(); return; }
    if (!force && data && Date.now() / 1000 - data.ts < 20) return;
    busy = true;
    if (overlay.style.display === 'block') render();
    try {
      data = summarise(await loadAttacks(nowSec() - WINDOW_DAYS * 86400));
      problem = null;
      try { localStorage.setItem(CACHE_SLOT, JSON.stringify(data)); } catch (e) {}
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busy = false;
    updateBadge();
    render();
  }

  // ---- overlay (the list itself) ----------------------------------------
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.6);' +
    'overflow:auto;-webkit-overflow-scrolling:touch;';
  const sheet = document.createElement('div');
  sheet.style.cssText =
    'margin:40px auto;padding:10px 12px;background:#1a1a1a;color:#ccc;width:92%;max-width:480px;box-sizing:border-box;' +
    'border:1px solid #777;border-radius:8px;font:13px sans-serif;line-height:1.5;';
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeList(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeList(); });

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = '2. Paste your key here';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('autocorrect', 'off');
  keyInput.spellcheck = false;
  keyInput.style.cssText =
    'display:block;margin:6px auto;width:90%;max-width:320px;padding:4px 8px;background:#111;color:#eee;' +
    'border:1px solid #777;border-radius:6px;font:12px monospace;box-sizing:border-box;';
  function submitKey() {
    const k = keyInput.value.trim();
    if (!k) return;
    ownKey = k;
    try { localStorage.setItem(OWN_SLOT, ownKey); } catch (e) {}
    keyInput.value = '';
    problem = null;
    refresh(true);
  }
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(href, text, css) {
    const a = el('a', css, text);
    a.href = href; a.target = '_blank';
    return a;
  }
  function btn(text, onclick) {
    const b = el('button', 'margin:0 4px;padding:3px 14px;background:#333;color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;', text);
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(); });
    return b;
  }

  function setupBlock(msg) {
    const box = el('div', 'text-align:center;padding:6px 0;');
    box.appendChild(el('div', '', msg));
    box.appendChild(link(KEY_URL, '1. Create the key on Torn (settings pre-filled)',
      'display:inline-block;margin:8px 0;padding:4px 12px;background:#2d5a2d;color:#fff;border:1px solid #9d9;border-radius:12px;text-decoration:none;font:12px sans-serif;'));
    box.appendChild(el('div', 'font-size:11px;color:#aaa;', 'On that page press Create, copy the new key, then come back and open this list again to paste it.'));
    box.appendChild(keyInput);
    box.appendChild(btn('Save key', submitKey));
    return box;
  }

  function render() {
    if (overlay.style.display !== 'block') return;
    sheet.textContent = '';
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
    head.appendChild(el('b', 'font-size:14px;color:#fff;', '⚔ ' + ENTRY_LABEL + ' (last ' + WINDOW_DAYS + ' days)'));
    const x = el('span', 'padding:0 6px;font-size:20px;cursor:pointer;color:#aaa;', '×');
    x.addEventListener('click', closeList);
    head.appendChild(x);
    sheet.appendChild(head);

    if (problem && problem.code === 'nokey') { sheet.appendChild(setupBlock('This list needs an API key with access to your attacks.')); return; }
    if (problem && problem.code === 2) { sheet.appendChild(setupBlock('Torn didn\'t accept the key. Make a new one:')); return; }
    if (problem && problem.code === 16) { sheet.appendChild(setupBlock('The Torn PDA key can\'t read attacks. Make a key of its own:')); return; }
    if (problem && problem.code === 5) sheet.appendChild(el('div', 'color:#fc6;', 'Rate limited - try again in a minute.'));
    else if (problem) sheet.appendChild(el('div', 'color:#f88;', 'API error: ' + problem.message + (problem.code != null ? ' (code ' + problem.code + ')' : '')));

    if (!data) { sheet.appendChild(el('div', '', busy ? 'Loading…' : 'No data yet.')); return; }

    if (!data.list.length) {
      sheet.appendChild(el('div', '', data.total ? 'Every attack on you in this window was anonymous.' : 'Nobody has attacked you in this window.'));
    }
    data.list.slice(0, MAX_LISTED).forEach((e, i) => {
      const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
      row.appendChild(link('https://www.torn.com/profiles.php?XID=' + e.id, e.name + ' [' + e.id + ']', 'color:#7cf;'));
      if (e.count > 1) row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  🔁 ×' + e.count));
      row.appendChild(link('https://www.torn.com/loader.php?sid=attack&user2ID=' + e.id, '⚔ REVENGE',
        'margin-left:8px;padding:1px 6px;background:#7a1f1f;color:#fff;border:1px solid #b44;border-radius:3px;font-weight:bold;text-decoration:none;'));
      row.appendChild(el('div', 'color:#bbb;',
        'Lvl ' + e.level + (e.faction ? ' · ' + e.faction : '') + ' · last: ' + (e.lastResult || '?') + ' ' + ago(e.last) +
        (e.count > 1 ? ' · ' + e.count + ' attacks' : '')));
      sheet.appendChild(row);
    });
    if (data.list.length > MAX_LISTED) sheet.appendChild(el('div', 'margin-top:6px;color:#888;', '…and ' + (data.list.length - MAX_LISTED) + ' more'));

    const foot = el('div', 'margin-top:10px;padding-top:6px;border-top:1px solid #444;font-size:11px;color:#888;display:flex;justify-content:space-between;align-items:center;');
    foot.appendChild(el('span', '', 'Updated ' + ago(data.ts) + (data.hidden ? ' · ' + data.hidden + ' anonymous not shown' : '')));
    foot.appendChild(btn(busy ? 'Refreshing…' : 'Refresh', () => refresh(true)));
    sheet.appendChild(foot);
  }

  function openList() {
    (document.body || document.documentElement).appendChild(overlay);
    overlay.style.display = 'block';
    render();
    refresh(!data || Date.now() / 1000 - data.ts > OPEN_REFRESH_MS / 1000);
  }
  function closeList() { overlay.style.display = 'none'; }

  // ---- menu entry --------------------------------------------------------
  // Torn's menu is a list of rows, each an <a> holding an icon and a label (class names carry a
  // random suffix, so match on the stable prefixes). We copy an ordinary row, e.g. "Home", relabel
  // it, and append it to the end of the same list, so it picks up the menu's own look on phone and desktop.
  const ENTRY_ATTR = 'data-retribution-entry';
  let badge = null;
  function updateBadge() {
    if (!badge) return;
    const n = data && data.list ? data.list.length : 0;
    badge.textContent = n ? ' (' + n + ')' : '';
  }
  function findMenu() {
    const names = ['Home', 'Items', 'City', 'Gym', 'Crimes'];
    const spans = Array.prototype.slice.call(document.querySelectorAll('[class*="linkName"]'));
    for (let i = 0; i < names.length; i++) {
      const span = spans.find((s) => s.textContent.trim() === names[i]);
      const a = span && span.closest('a');
      if (!a || !a.parentElement || !a.parentElement.parentElement || !a.parentElement.parentElement.parentElement) continue;
      const row = a.parentElement;               // the row holding the <a>
      const area = row.parentElement;            // one menu item
      const container = area.parentElement;      // the whole list
      if (area.querySelectorAll('a').length !== 1) continue; // want a plain entry, not an expandable group
      return { span, a, area, container };
    }
    return null;
  }
  function ensureEntry() {
    const m = findMenu();
    if (!m) return;
    if (m.container.querySelector('[' + ENTRY_ATTR + ']')) return;
    const clone = m.area.cloneNode(true);
    clone.setAttribute(ENTRY_ATTR, '1');
    clone.className = String(clone.className).replace(/\S*active\S*/g, '').trim(); // never look like the current page
    Array.prototype.forEach.call(clone.querySelectorAll('*'), (n) => {
      if (typeof n.className === 'string' && /active/i.test(n.className)) n.className = n.className.replace(/\S*active\S*/gi, '').trim();
      n.removeAttribute('id');
    });
    const a = clone.querySelector('a');
    a.setAttribute('href', '#');
    a.removeAttribute('target');
    a.removeAttribute('aria-current');
    const iconBox = clone.querySelector('[class*="defaultIcon"]') || clone.querySelector('[class*="svgIconWrap"]');
    if (iconBox) { iconBox.textContent = ''; iconBox.appendChild(el('span', 'font-size:13px;line-height:14px;display:inline-block;', '⚔')); }
    const label = clone.querySelector('[class*="linkName"]');
    label.textContent = ENTRY_LABEL;
    badge = el('span', '', '');
    label.appendChild(badge);
    updateBadge();
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openList(); }, true);
    m.container.appendChild(clone);
  }

  // The menu is rebuilt by Torn at times (page changes, opening the hamburger), so keep checking.
  ensureEntry();
  document.addEventListener('DOMContentLoaded', ensureEntry);
  window.addEventListener('load', ensureEntry);
  setInterval(ensureEntry, 1500);

  // Keep the count in the menu entry fresh without waiting for a tap.
  function backgroundRefresh() {
    if (!getKey()) return;
    if (data && Date.now() / 1000 - data.ts < BG_REFRESH_MS / 1000) return;
    refresh(true);
  }
  setTimeout(backgroundRefresh, 1500);
  setInterval(() => { if (document.visibilityState !== 'hidden') backgroundRefresh(); }, BG_REFRESH_MS);
})();
