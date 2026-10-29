// ==UserScript==
// @name         Torn Faction Attackers
// @namespace    torn-faction-attackers
// @version      1.0
// @description  On your faction page, adds an "Attackers" button. Tap it to see who has been attacking your faction mates: repeat attackers, which of your mates they hit, their level and faction, results, and a profile link for each. Uses the official API (faction > attacks; needs a key from someone with faction API access).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes

  // ---- settings ----------------------------------------------------------
  const WINDOWS = [1, 3, 7];                 // day choices shown as buttons
  const DEFAULT_DAYS = 3;
  const MAX_PAGES = 8;                       // up to 100 attacks per page
  const MAX_LISTED = 30;
  const CACHE_SECONDS = 60;                  // reuse data this long when reopening

  // ---- API key -----------------------------------------------------------
  // Own key slot only (never another script's key). Torn PDA fills the placeholder with your key; if that key
  // can't read faction attacks, the panel offers a shortcut to create one of its own.
  const OWN_SLOT = 'fa_key';
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&faction=attacks&title=FactionAttackersKey';
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = (PDA_KEY && !PDA_KEY.startsWith('###')) ? PDA_KEY : '';
  function readSlot(s) { try { return localStorage.getItem(s) || ''; } catch (e) { return ''; } }
  let ownKey = readSlot(OWN_SLOT);
  const getKey = () => ownKey || pdaKey;

  // ---- helpers -----------------------------------------------------------
  const nowSec = () => Math.floor(Date.now() / 1000);
  function ago(ts) {
    const s = Math.max(0, nowSec() - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const profileUrl = (id) => 'https://www.torn.com/profiles.php?XID=' + id;
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
  function btn(text, onclick, active) {
    const b = el('button', 'margin:0 0 0 6px;padding:3px 10px;background:' + (active ? '#2d5a2d' : '#333') +
      ';color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;', text);
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(b); });
    return b;
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, params) {
    const q = new URLSearchParams(Object.assign({}, params, { key: getKey(), comment: 'TornFactionAttackers' }));
    const r = await fetch('https://api.torn.com/v2/' + path + '?' + q.toString());
    const j = await r.json();
    if (j && j.error) {
      const err = new Error(j.error.error || 'API error');
      err.code = j.error.code;
      throw err;
    }
    return j;
  }

  // Incoming attacks on faction members since `from`, newest first, paging back with `to`.
  async function loadAttacks(from) {
    const seen = new Map();
    let to = nowSec();
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await api('faction/attacks', { filters: 'incoming', limit: 100, sort: 'desc', from: from, to: to, timestamp: nowSec() });
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

  // "Won" = the attacker beat the defender. Anything else (Lost, Stalemate, Escape, Timeout) did no damage.
  const WIN_RE = /^(attacked|mugged|hospitalized|arrested|special|looted)$/i;
  const isWin = (r) => WIN_RE.test(r || '');

  function summarise(attacks) {
    const byAtk = new Map(), byVic = new Map();
    let hidden = 0, wins = 0;
    attacks.forEach((a) => {
      const who = a.attacker, vic = a.defender;
      const ts = +a.ended || +a.started || 0;
      const win = isWin(a.result);
      if (win) wins++;
      if (vic && vic.id) {
        let v = byVic.get(vic.id);
        if (!v) { v = { id: vic.id, name: vic.name, count: 0, wins: 0, last: 0 }; byVic.set(vic.id, v); }
        v.count++; if (win) v.wins++; if (ts > v.last) v.last = ts;
      }
      if (!who || a.is_stealthed || !who.id) { hidden++; return; }
      let e = byAtk.get(who.id);
      if (!e) {
        e = { id: who.id, name: who.name, level: who.level, faction: who.faction && who.faction.name, count: 0, wins: 0, last: 0, lastResult: '', victims: new Map() };
        byAtk.set(who.id, e);
      }
      e.count++; if (win) e.wins++;
      if (vic && vic.id) e.victims.set(vic.id, vic.name || vic.id);
      if (ts >= e.last) { e.last = ts; e.lastResult = a.result || ''; e.level = who.level; e.name = who.name; e.faction = who.faction && who.faction.name; }
    });
    const sortFn = (x, y) => (y.count - x.count) || (y.last - x.last);
    return {
      attackers: Array.from(byAtk.values()).sort(sortFn),
      victims: Array.from(byVic.values()).sort(sortFn),
      hidden, wins, total: attacks.length, ts: nowSec(),
    };
  }

  // ---- state -------------------------------------------------------------
  let days = DEFAULT_DAYS, view = 'attackers';
  let data = null, dataDays = 0, problem = null, busy = false;

  async function refresh(force) {
    if (busy) return;
    if (!getKey()) { problem = { code: 'nokey' }; render(); return; }
    if (!force && data && dataDays === days && nowSec() - data.ts < CACHE_SECONDS) { render(); return; }
    busy = true; render();
    try {
      data = summarise(await loadAttacks(nowSec() - days * 86400));
      dataDays = days;
      problem = null;
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busy = false;
    render();
  }

  // ---- overlay -----------------------------------------------------------
  const overlay = el('div', 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.6);overflow:auto;-webkit-overflow-scrolling:touch;');
  const sheet = el('div', 'margin:40px auto;padding:10px 12px;background:#1a1a1a;color:#ccc;width:92%;max-width:480px;box-sizing:border-box;border:1px solid #777;border-radius:8px;font:13px sans-serif;line-height:1.5;');
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  function close() { overlay.style.display = 'none'; }
  function open() {
    (document.body || document.documentElement).appendChild(overlay);
    overlay.style.display = 'block';
    render();
    refresh(false);
  }

  const keyInput = el('input', 'display:block;margin:6px auto;width:90%;max-width:320px;padding:4px 8px;background:#111;color:#eee;border:1px solid #777;border-radius:6px;font:12px monospace;box-sizing:border-box;');
  keyInput.type = 'text';
  keyInput.placeholder = '2. Paste your key here';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('autocorrect', 'off');
  keyInput.spellcheck = false;
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

  function setupBlock(msg) {
    const box = el('div', 'text-align:center;padding:6px 0;');
    box.appendChild(el('div', '', msg));
    box.appendChild(link(KEY_URL, '1. Create the key on Torn (settings pre-filled)',
      'display:inline-block;margin:8px 0;padding:4px 12px;background:#2d5a2d;color:#fff;border:1px solid #9d9;border-radius:12px;text-decoration:none;font:12px sans-serif;'));
    box.appendChild(el('div', 'font-size:11px;color:#aaa;', 'The key must belong to someone with faction API access. Press Create, copy the key, come back and paste it.'));
    box.appendChild(keyInput);
    box.appendChild(btn('Save key', submitKey));
    return box;
  }

  // ---- copy --------------------------------------------------------------
  function listText() {
    const head = 'Faction attackers (last ' + days + (days === 1 ? ' day' : ' days') + ')';
    if (view === 'victims') {
      return [head + ' - by faction mate'].concat(data.victims.map((v) => v.name + ' [' + v.id + '] - hit ' + v.count + 'x (' + v.wins + ' lost the fight)')).join('\n');
    }
    const blocks = data.attackers.map((e) =>
      e.name + ' [' + e.id + '] - ' + e.count + 'x on ' + Array.from(e.victims.values()).join(', ') + '\nLvl ' + e.level +
      (e.faction ? ' \u00b7 ' + e.faction : '') + ' \u00b7 last: ' + (e.lastResult || '?') + ' ' + ago(e.last) + '\n' + profileUrl(e.id));
    const parts = [head].concat(blocks);
    if (data.hidden) parts.push(data.hidden + ' anonymous not shown');
    return parts.join('\n\n');
  }
  function flash(b, msg) {
    const old = b.textContent;
    b.textContent = msg;
    setTimeout(() => { if (b.isConnected) b.textContent = old; }, 1800);
  }
  async function copyList(b) {
    const text = listText();
    try { await navigator.clipboard.writeText(text); flash(b, '\u2713'); return; } catch (e) {}
    try {
      const ta = el('textarea', 'position:fixed;top:0;left:0;opacity:0;');
      ta.value = text;
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { flash(b, '\u2713'); return; }
    } catch (e) {}
    const ta = el('textarea', 'display:block;width:100%;height:120px;margin-top:8px;background:#111;color:#eee;border:1px solid #777;border-radius:6px;font:11px monospace;box-sizing:border-box;');
    ta.value = text; ta.readOnly = true;
    sheet.appendChild(ta); ta.focus(); ta.select();
  }

  // ---- render ------------------------------------------------------------
  function render() {
    if (overlay.style.display !== 'block') return;
    sheet.textContent = '';
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
    head.appendChild(el('b', 'font-size:14px;color:#fff;', '\ud83d\udee1 Faction attackers'));
    const x = el('span', 'padding:0 6px;font-size:20px;cursor:pointer;color:#aaa;', '\u00d7');
    x.addEventListener('click', close);
    head.appendChild(x);
    sheet.appendChild(head);

    if (problem && problem.code === 'nokey') { sheet.appendChild(setupBlock('This needs an API key with faction attacks access.')); return; }
    if (problem && problem.code === 2) { sheet.appendChild(setupBlock('Torn didn\'t accept the key. Make a new one:')); return; }
    if (problem && problem.code === 16) { sheet.appendChild(setupBlock('This key can\'t read faction attacks (needs faction API access). Make a key of its own:')); return; }

    // controls: day window and view
    const ctl = el('div', 'display:flex;flex-wrap:wrap;gap:4px 0;align-items:center;margin-bottom:8px;');
    ctl.appendChild(el('span', 'color:#888;', 'Last'));
    WINDOWS.forEach((d) => ctl.appendChild(btn(d + 'd', () => { days = d; refresh(false); }, d === days)));
    ctl.appendChild(el('span', 'width:10px;'));
    ctl.appendChild(btn('By attacker', () => { view = 'attackers'; render(); }, view === 'attackers'));
    ctl.appendChild(btn('By mate', () => { view = 'victims'; render(); }, view === 'victims'));
    sheet.appendChild(ctl);

    if (problem && problem.code === 5) sheet.appendChild(el('div', 'color:#fc6;', 'Rate limited - try again in a minute.'));
    else if (problem) sheet.appendChild(el('div', 'color:#f88;', 'API error: ' + problem.message + (problem.code != null ? ' (code ' + problem.code + ')' : '')));

    if (!data || dataDays !== days) { sheet.appendChild(el('div', '', busy ? 'Loading\u2026' : 'No data yet.')); return; }

    sheet.appendChild(el('div', 'color:#aaa;margin-bottom:6px;',
      data.total + ' attacks on your faction \u00b7 ' + data.wins + ' went the attacker\'s way \u00b7 ' + data.attackers.length + ' known attackers'));

    if (view === 'victims') {
      if (!data.victims.length) sheet.appendChild(el('div', '', 'No attacks on your faction in this window.'));
      data.victims.slice(0, MAX_LISTED).forEach((v, i) => {
        const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
        row.appendChild(link(profileUrl(v.id), v.name + ' [' + v.id + ']', 'color:#7cf;'));
        row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  \u00d7' + v.count));
        row.appendChild(el('div', 'color:#bbb;', v.wins + ' hit(s) landed \u00b7 last ' + ago(v.last)));
        sheet.appendChild(row);
      });
    } else {
      if (!data.attackers.length) sheet.appendChild(el('div', '', data.total ? 'Every attack in this window was anonymous.' : 'No attacks on your faction in this window.'));
      data.attackers.slice(0, MAX_LISTED).forEach((e, i) => {
        const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
        row.appendChild(link(profileUrl(e.id), e.name + ' [' + e.id + ']', 'color:#7cf;'));
        if (e.count > 1) row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  \ud83d\udd01 \u00d7' + e.count));
        row.appendChild(el('div', 'color:#bbb;', 'Lvl ' + e.level + (e.faction ? ' \u00b7 ' + e.faction : ' \u00b7 no faction') +
          ' \u00b7 last: ' + (e.lastResult || '?') + ' ' + ago(e.last)));
        row.appendChild(el('div', 'color:#999;font-size:12px;', 'Hit: ' + Array.from(e.victims.values()).join(', ')));
        sheet.appendChild(row);
      });
      if (data.attackers.length > MAX_LISTED) sheet.appendChild(el('div', 'margin-top:6px;color:#888;', '\u2026and ' + (data.attackers.length - MAX_LISTED) + ' more'));
    }

    const foot = el('div', 'margin-top:10px;padding-top:6px;border-top:1px solid #444;font-size:11px;color:#888;display:flex;justify-content:space-between;align-items:center;');
    foot.appendChild(el('span', 'flex:1;min-width:0;', 'Updated ' + ago(data.ts) + (data.hidden ? ' \u00b7 ' + data.hidden + ' anonymous not shown' : '')));
    const acts = el('span', 'flex:none;white-space:nowrap;margin-left:8px;');
    acts.appendChild(btn('\ud83d\udccb', copyList));
    acts.appendChild(btn(busy ? '\u2026' : '\ud83d\udd04', () => refresh(true)));
    foot.appendChild(acts);
    sheet.appendChild(foot);
  }

  // ---- launcher button (faction page only) ------------------------------
  const onFactionPage = () => /\/factions\.php/i.test(location.pathname);
  const launcher = el('button', 'position:fixed;right:10px;bottom:70px;z-index:2147483646;padding:7px 14px;background:#2a2a2a;color:#ddd;border:1px solid #9d9;border-radius:14px;font:bold 13px sans-serif;cursor:pointer;', '\ud83d\udee1 Attackers');
  launcher.type = 'button';
  launcher.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
  function ensureLauncher() {
    if (!onFactionPage()) { if (launcher.parentNode) launcher.remove(); return; }
    const host = document.body || document.documentElement;
    if (host && launcher.parentNode !== host) host.appendChild(launcher);
  }
  ensureLauncher();
  document.addEventListener('DOMContentLoaded', ensureLauncher);
  window.addEventListener('load', ensureLauncher);
  setInterval(ensureLauncher, 1500);
})();
