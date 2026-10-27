// ==UserScript==
// @name         Torn Retribution List
// @namespace    torn-retribution-list
// @version      1.1
// @description  On your home page, lists the players who attacked you recently (skipping anonymous/stealthed attacks), counts repeat attackers, and gives a one-tap revenge link for each. Uses the official API (user > attacks, Limited key is enough).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- settings ----------------------------------------------------------
  const WINDOW_DAYS = 7;                          // how far back to look
  const MAX_PAGES = 5;                            // up to 100 attacks per page
  const MAX_LISTED = 15;                          // longest list shown
  const SHOW_PATH_RE = /^\/(index\.php)?$/i;      // pages where the panel shows (home page)
  const MIN_REFRESH_MS = 5000;                    // never hit the API more often than this
  const POLL_MS = 60000;                          // background refresh while the page is open

  // ---- API key -----------------------------------------------------------
  // First choice: the key the Find Target loader already stored from Torn PDA ('ht_api_key').
  // If that key can't read attacks, the panel offers a shortcut to make a key of its own ('ta_key').
  const OWN_SLOT = 'ta_key';
  const SHARED_SLOT = 'ht_api_key';
  // Opens Torn's "add new key" form with user > attacks pre-filled.
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=attacks&title=RetributionKey';
  function readSlot(slot) { try { return localStorage.getItem(slot) || ''; } catch (e) { return ''; } }
  let ownKey = readSlot(OWN_SLOT);
  const getKey = () => ownKey || readSlot(SHARED_SLOT);

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
    return { list, hidden, total };
  }

  // ---- UI ----------------------------------------------------------------
  const banner = document.createElement('div');
  banner.style.cssText =
    'display:block;margin:4px auto;padding:5px 12px;background:#333;color:#ddd;max-width:92%;' +
    'border:1px solid #777;border-radius:14px;font:13px sans-serif;text-align:center;cursor:pointer;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'display:none;margin:4px auto;padding:6px 10px;background:#1a1a1a;color:#ccc;max-width:92%;' +
    'border:1px solid #444;border-radius:6px;font:12px sans-serif;line-height:1.5;';
  banner.addEventListener('click', () => {
    if (setup.style.display === 'block') return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // Key setup panel (only appears if the shared key can't read attacks).
  const setup = document.createElement('div');
  setup.style.cssText =
    'display:none;margin:4px auto;padding:8px 12px;background:#1a1a1a;color:#ddd;max-width:92%;' +
    'border:1px solid #9d9;border-radius:6px;font:12px sans-serif;line-height:1.6;text-align:center;';
  const setupMsg = document.createElement('div');
  const setupLink = document.createElement('a');
  setupLink.href = KEY_URL;
  setupLink.textContent = '1. Create the key on Torn (settings pre-filled)';
  setupLink.style.cssText =
    'display:inline-block;margin:6px 0;padding:4px 12px;background:#2d5a2d;color:#fff;' +
    'border:1px solid #9d9;border-radius:12px;text-decoration:none;font:12px sans-serif;';
  const setupHint = document.createElement('div');
  setupHint.style.cssText = 'font-size:11px;color:#aaa;';
  setupHint.textContent = 'On that page press Create, copy the new key, then come back to the home page and paste it below.';
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
  saveBtn.style.cssText = 'margin:0 4px;padding:3px 14px;background:#333;color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;';
  setup.appendChild(setupMsg);
  setup.appendChild(setupLink);
  setup.appendChild(setupHint);
  setup.appendChild(keyInput);
  setup.appendChild(saveBtn);
  function showSetup(msg) {
    setupMsg.textContent = msg;
    if (setup.style.display === 'block') return; // already open: don't wipe a half-pasted key
    keyInput.value = '';
    setup.style.display = 'block';
  }
  function submitKey() {
    const k = keyInput.value.trim();
    if (!k) return;
    ownKey = k;
    try { localStorage.setItem(OWN_SLOT, ownKey); } catch (e) {}
    keyInput.value = '';
    setup.style.display = 'none';
    banner.textContent = '⚔ Checking the retribution list…';
    refresh(true);
  }
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); submitKey(); });
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });

  function ensureUI() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (banner.parentNode !== host || host.firstChild !== banner) host.insertBefore(banner, host.firstChild);
    if (panel.parentNode !== host) host.insertBefore(panel, banner.nextSibling);
    if (setup.parentNode !== host) host.insertBefore(setup, panel.nextSibling);
  }

  function link(href, text, css) {
    const a = document.createElement('a');
    a.href = href; a.target = '_blank'; a.textContent = text;
    if (css) a.style.cssText = css;
    return a;
  }

  function render(res) {
    const s = summarise(res);
    const times = s.list.reduce((n, e) => n + e.count, 0);
    const repeats = s.list.filter((e) => e.count > 1).length;
    let colour = '#9d9';
    if (repeats) colour = '#fc6';
    banner.style.borderColor = colour;
    banner.textContent = s.list.length
      ? '⚔ Attacked by ' + s.list.length + ' player' + (s.list.length === 1 ? '' : 's') + ' (' + times + 'x) in ' + WINDOW_DAYS + 'd' +
        (repeats ? ' · ' + repeats + ' repeat' : '') + (s.hidden ? ' · ' + s.hidden + ' anonymous' : '') + ' — tap'
      : '⚔ No named attackers in the last ' + WINDOW_DAYS + ' days' + (s.hidden ? ' (' + s.hidden + ' anonymous)' : '');

    panel.textContent = '';
    if (!s.list.length) {
      const d = document.createElement('div');
      d.textContent = s.total ? 'Every attack on you in this window was anonymous.' : 'Nobody has attacked you in this window.';
      panel.appendChild(d);
      return;
    }
    s.list.slice(0, MAX_LISTED).forEach((e, i) => {
      const row = document.createElement('div');
      row.style.cssText = (i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
      row.appendChild(link('https://www.torn.com/profiles.php?XID=' + e.id, e.name + ' [' + e.id + ']', 'color:#7cf;'));
      if (e.count > 1) {
        const rep = document.createElement('span');
        rep.textContent = '  🔁 ×' + e.count;
        rep.style.cssText = 'color:#fc6;font-weight:bold;';
        row.appendChild(rep);
      }
      row.appendChild(link('https://www.torn.com/loader.php?sid=attack&user2ID=' + e.id, '⚔ REVENGE',
        'margin-left:8px;padding:1px 6px;background:#7a1f1f;color:#fff;border:1px solid #b44;border-radius:3px;font-weight:bold;text-decoration:none;'));
      const info = document.createElement('div');
      info.style.color = '#bbb';
      info.textContent = 'Lvl ' + e.level + (e.faction ? ' · ' + e.faction : '') + ' · last: ' + (e.lastResult || '?') + ' ' + ago(e.last) +
        (e.count > 1 ? ' · ' + e.count + ' attacks' : '');
      row.appendChild(info);
      panel.appendChild(row);
    });
    if (s.list.length > MAX_LISTED) {
      const more = document.createElement('div');
      more.style.cssText = 'margin-top:6px;color:#888;';
      more.textContent = '…and ' + (s.list.length - MAX_LISTED) + ' more';
      panel.appendChild(more);
    }
  }

  // ---- refresh -----------------------------------------------------------
  let busy = false, lastRun = 0;
  async function refresh(force) {
    if (busy || (!force && Date.now() - lastRun < MIN_REFRESH_MS)) return;
    if (!getKey()) {
      banner.textContent = '⚔ Add an API key to see who attacked you';
      showSetup('This script needs an API key with access to your attacks.');
      return;
    }
    busy = true; lastRun = Date.now();
    try {
      const attacks = await loadAttacks(nowSec() - WINDOW_DAYS * 86400);
      setup.style.display = 'none';
      render(attacks);
    } catch (err) {
      if (err.code === 2 || err.code === 16) {
        banner.textContent = '⚔ ' + (err.code === 2 ? 'API key not accepted' : 'This key can\'t read your attacks');
        showSetup(err.code === 2 ? 'Torn didn\'t accept the key. Make a new one:' : 'The Torn PDA key can\'t read attacks. Make a key of its own:');
      } else if (err.code === 5) {
        banner.textContent = '⚔ Rate limited - retrying shortly';
      } else {
        banner.textContent = '⚔ API error: ' + err.message + (err.code != null ? ' (code ' + err.code + ')' : '');
      }
    }
    busy = false;
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    ensureUI();
    document.addEventListener('DOMContentLoaded', ensureUI);
    window.addEventListener('load', ensureUI);
    setInterval(ensureUI, 2000);
    banner.textContent = '⚔ Checking the retribution list…';
    refresh(true);
    setInterval(() => { if (document.visibilityState !== 'hidden') refresh(false); }, POLL_MS);
  }

  if (SHOW_PATH_RE.test(location.pathname)) start();
})();
