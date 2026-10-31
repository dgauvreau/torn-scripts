// ==UserScript==
// @name         Torn Faction Attackers
// @namespace    torn-faction-attackers
// @version      3.1
// @description  While your faction has a live chain, a small strip on the faction page and targets list shows the chain count and timer plus how many hits your faction mates are taking and from whom. Tap it for the full list: repeat attackers, which mates they hit, level, faction, results and profile links. A By faction view groups attackers by their faction, and the strip names the faction behind most of the recent hits, so you can see at a glance whether the people hitting your mates are one faction. Refreshes itself. Uses the official API (faction > chain and attacks; needs a key from someone with faction API access).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes

  // ---- settings ----------------------------------------------------------
  const CHAIN_POLL_MS = 10000;             // how often the chain is checked
  const ATTACK_POLL_MS = 30000;            // how often attacks are re-read while a chain is live or the list is open
  const RECENT_SEC = 300;                  // "just now" hits: the strip highlights when someone hit in this window
  const FALLBACK_WINDOW_SEC = 3600;        // "since chain start" falls back to this if the start time isn't known
  const WINDOWS = [['chain', 'Chain'], [900, '15m'], [3600, '1h'], [86400, '24h']];
  const MAX_PAGES = 6;                     // up to 100 attacks per page
  const MAX_LISTED = 30;

  // ---- API key -----------------------------------------------------------
  // Own key slot only (never another script's key). Torn PDA fills the placeholder with your key; if that key
  // can't read faction data, the panel offers a shortcut to create one of its own.
  const OWN_SLOT = 'fa_key';
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&faction=attacks,chain&title=FactionAttackersKey';
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
  const mmss = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const profileUrl = (id) => 'https://www.torn.com/profiles.php?XID=' + id;
  const factionUrl = (id) => 'https://www.torn.com/factions.php?step=profile&ID=' + id;
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
    b.type = 'button';
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
  const diag = { chain: '', atk: '', mode: '', log: '', logSummary: '' };
  const isKeyErr = (e) => e && (e.code === 2 || e.code === 5 || e.code === 16);
  let ownFactionId = 0;
  async function getOwnFactionId() {
    if (ownFactionId) return ownFactionId;
    const j = await api('faction/basic', { timestamp: nowSec() });
    const b = (j && (j.basic || j)) || {};
    ownFactionId = +b.id || 0;
    return ownFactionId;
  }
  // Page of attacks on our faction. First asks Torn for incoming-only; if Torn rejects that, reads all attacks and keeps the ones on our own members.
  async function attackPage(from, to) {
    const base = { limit: 100, sort: 'desc', from: from, to: to, timestamp: nowSec() };
    if (diag.mode !== 'all') {
      try {
        const j = await api('faction/attacks', Object.assign({ filters: 'incoming' }, base));
        diag.mode = 'incoming';
        return Array.isArray(j.attacks) ? j.attacks : [];
      } catch (e) {
        if (isKeyErr(e)) throw e;
        diag.mode = 'all';
        diag.atk = 'incoming filter failed (' + e.message + '); reading all attacks';
      }
    }
    const fid = await getOwnFactionId();
    const j = await api('faction/attacks', base);
    const rows = Array.isArray(j.attacks) ? j.attacks : [];
    const kept = fid ? rows.filter((a) => a.defender && a.defender.faction && +a.defender.faction.id === fid) : rows;
    kept._rawCount = rows.length;
    kept._minTs = rows.reduce((m, a) => Math.min(m, +a.started || Infinity), Infinity);
    return kept;
  }
  async function loadAttacks(from) {
    const seen = new Map();
    let to = nowSec();
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await attackPage(from, to);
      if (page === 0) {
        const first = rows[0];
        diag.atk = (diag.mode === 'all' ? 'all-attacks mode \u00b7 ' : 'incoming \u00b7 ') + rows.length + ' rows' +
          (first ? ' \u00b7 fields: ' + Object.keys(first).join(',') : '');
      }
      const rawCount = rows._rawCount != null ? rows._rawCount : rows.length;
      if (!rawCount) break;
      let minTs = rows._minTs != null ? rows._minTs : Infinity, added = 0;
      rows.forEach((a) => {
        const k = String(a.id);
        if (!seen.has(k)) { seen.set(k, a); added++; }
        minTs = Math.min(minTs, +a.started || Infinity);
      });
      if (rawCount < 100 || (!added && rows._minTs == null) || !(minTs > from)) break;
      to = minTs;
    }
    return Array.from(seen.values());
  }

  // "Won" = the attacker beat the defender. Anything else (Lost, Stalemate, Escape, Timeout) did no damage.
  const WIN_RE = /^(attacked|mugged|hospitalized|arrested|special|looted)$/i;
  const isWin = (r) => WIN_RE.test(r || '');

  function summarise(attacks) {
    const byAtk = new Map(), byVic = new Map(), byFac = new Map(), recentFac = new Map(), byCode = new Map();
    let hidden = 0, wins = 0, recent = 0;
    const recentAtk = new Set();
    const cutoff = nowSec() - RECENT_SEC;
    attacks.forEach((a) => {
      const who = a.attacker, vic = a.defender;
      const ts = +a.ended || +a.started || 0;
      {
        const fo = (who && who.faction) || a.attacker_faction || null;
        if (a.code) byCode.set(String(a.code), { fid: fo && fo.id ? +fo.id : 0, faction: fo && fo.name ? fo.name : '', name: who && who.name ? who.name : '', hidden: !who || !who.id || !!a.is_stealthed });
      }
      const win = isWin(a.result);
      if (win) wins++;
      if (ts >= cutoff) { recent++; if (who && who.id && !a.is_stealthed) recentAtk.add(who.id); }
      if (vic && vic.id) {
        let v = byVic.get(vic.id);
        if (!v) { v = { id: vic.id, name: vic.name, count: 0, wins: 0, last: 0 }; byVic.set(vic.id, v); }
        v.count++; if (win) v.wins++; if (ts > v.last) v.last = ts;
      }
      if (!who || a.is_stealthed || !who.id) { hidden++; return; }
      const fid = who.faction && who.faction.id ? who.faction.id : 0;
      const fname = who.faction && who.faction.name ? who.faction.name : 'No faction';
      let f = byFac.get(fid);
      if (!f) { f = { id: fid, name: fname, count: 0, wins: 0, last: 0, attackers: new Map(), victims: new Map() }; byFac.set(fid, f); }
      f.count++; if (win) f.wins++; if (ts > f.last) f.last = ts;
      f.attackers.set(who.id, who.name || who.id);
      if (vic && vic.id) f.victims.set(vic.id, vic.name || vic.id);
      if (ts >= cutoff) {
        let r = recentFac.get(fid);
        if (!r) { r = { id: fid, name: fname, count: 0, attackers: new Set() }; recentFac.set(fid, r); }
        r.count++; r.attackers.add(who.id);
      }
      let e = byAtk.get(who.id);
      if (!e) {
        e = { id: who.id, name: who.name, level: who.level, faction: who.faction && who.faction.name, factionId: fid, count: 0, wins: 0, last: 0, lastResult: '', victims: new Map() };
        byAtk.set(who.id, e);
      }
      e.count++; if (win) e.wins++;
      if (vic && vic.id) e.victims.set(vic.id, vic.name || vic.id);
      if (ts >= e.last) { e.last = ts; e.lastResult = a.result || ''; e.level = who.level; e.name = who.name; e.faction = who.faction && who.faction.name; e.factionId = fid; }
    });
    const sortFn = (x, y) => (y.count - x.count) || (y.last - x.last);
    const facs = Array.from(byFac.values()).map((f) => { f.people = f.attackers.size; return f; })
      .sort((x, y) => (y.count - x.count) || (y.people - x.people) || (y.last - x.last));
    // Top faction among the recent hits; "No faction" never counts as a group.
    const topRecent = Array.from(recentFac.values()).filter((r) => r.id).sort((x, y) => (y.count - x.count) || (y.attackers.size - x.attackers.size))[0] || null;
    return {
      factions: facs, topRecent, byCode,
      attackers: Array.from(byAtk.values()).sort(sortFn),
      victims: Array.from(byVic.values()).sort(sortFn),
      hidden, wins, recent, recentAtk: recentAtk.size, total: attacks.length, ts: nowSec(),
    };
  }

  // ---- state -------------------------------------------------------------
  let winMode = 'chain', view = 'attackers';
  let chain = null;            // { current, max, deadline (ms), start (sec) } while a chain is running, else null
  let chainLoaded = false;
  let data = null, dataMode = null;
  let problem = null;          // { code, message } from the last failed call
  let busyChain = false, busyAtk = false;
  let lastChain = 0, lastAtk = 0;

  const needsKey = () => !getKey() || (problem && (problem.code === 2 || problem.code === 16));

  function windowFrom() {
    if (winMode === 'chain') return chain && chain.start ? chain.start : nowSec() - FALLBACK_WINDOW_SEC;
    return nowSec() - winMode;
  }

  async function fetchChain() {
    if (busyChain || !getKey() || needsKey()) return;
    busyChain = true; lastChain = Date.now();
    try {
      const j = await api('faction/chain', { timestamp: nowSec() });
      const c = (j && (j.chain || j)) || {};
      diag.chain = JSON.stringify(c).slice(0, 200);
      let left = +c.timeout || 0;
      if (!left && c.end) left = (+c.end) - nowSec();
      chain = (left > 0 && +c.current > 0)
        ? { current: +c.current, max: +c.max || 0, deadline: Date.now() + left * 1000, start: +c.start || 0 }
        : null;
      chainLoaded = true;
      if (problem && problem.code !== 2 && problem.code !== 16) problem = null;
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busyChain = false;
    updateStrip();
  }

  async function fetchAttacks(force) {
    if (busyAtk || !getKey() || needsKey()) return;
    if (!force && Date.now() - lastAtk < 3000) return;
    busyAtk = true; lastAtk = Date.now();
    if (isOpen()) render();
    try {
      data = summarise(await loadAttacks(windowFrom()));
      dataMode = winMode;
      if (problem && problem.code !== 2 && problem.code !== 16) problem = null;
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busyAtk = false;
    updateStrip();
    render();
  }

  // ---- overlay -----------------------------------------------------------
  const overlay = el('div', 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.6);overflow:auto;-webkit-overflow-scrolling:touch;');
  const sheet = el('div', 'margin:40px auto;padding:10px 12px;background:#1a1a1a;color:#ccc;width:92%;max-width:480px;box-sizing:border-box;border:1px solid #777;border-radius:8px;font:13px sans-serif;line-height:1.5;');
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
  const isOpen = () => overlay.style.display === 'block';
  function closePanel() { overlay.style.display = 'none'; }
  function openPanel() {
    (document.body || document.documentElement).appendChild(overlay);
    overlay.style.display = 'block';
    render();
    if (getKey() && !needsKey()) { fetchChain(); fetchAttacks(true); }
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
    fetchChain();
    fetchAttacks(true);
    render();
  }
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });

  function setupBlock(msg) {
    const box = el('div', 'text-align:center;padding:6px 0;');
    box.appendChild(el('div', '', msg));
    box.appendChild(link(KEY_URL, '1. Create the key on Torn (settings pre-filled)',
      'display:inline-block;margin:8px 0;padding:4px 12px;background:#2d5a2d;color:#fff;border:1px solid #9d9;border-radius:12px;text-decoration:none;font:12px sans-serif;'));
    box.appendChild(el('div', 'font-size:11px;color:#aaa;', 'The key must belong to someone with faction API access (faction > chain and attacks). Press Create, copy the key, come back and paste it.'));
    box.appendChild(keyInput);
    box.appendChild(btn('Save key', submitKey));
    return box;
  }

  // ---- copy --------------------------------------------------------------
  const winLabel = () => (WINDOWS.find((w) => w[0] === winMode) || ['', ''])[1];
  function listText() {
    const head = 'Faction attackers (' + (winMode === 'chain' ? 'since chain start' : 'last ' + winLabel()) + ')';
    if (view === 'victims') {
      return [head + ' - by faction mate'].concat(data.victims.map((v) => v.name + ' [' + v.id + '] - hit ' + v.count + 'x (' + v.wins + ' landed)')).join('\n');
    }
    if (view === 'factions') {
      return [head + ' - by attacking faction'].concat(data.factions.map((f) =>
        f.name + (f.id ? ' [' + f.id + ']' : '') + ' - ' + f.count + ' hit' + (f.count === 1 ? '' : 's') + ' by ' + f.people + ' player' + (f.people === 1 ? '' : 's') +
        ' (' + Array.from(f.attackers.values()).join(', ') + ')' + (f.id ? '\n' + factionUrl(f.id) : ''))).join('\n\n');
    }
    const blocks = data.attackers.map((e) =>
      e.name + ' [' + e.id + '] - ' + e.count + 'x on ' + Array.from(e.victims.values()).join(', ') + '\nLvl ' + e.level +
      (e.faction ? ' · ' + e.faction : '') + ' · last: ' + (e.lastResult || '?') + ' ' + ago(e.last) + '\n' + profileUrl(e.id));
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
    if (!data) return;
    const text = listText();
    try { await navigator.clipboard.writeText(text); flash(b, '✓'); return; } catch (e) {}
    try {
      const ta = el('textarea', 'position:fixed;top:0;left:0;opacity:0;');
      ta.value = text;
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) { flash(b, '✓'); return; }
    } catch (e) {}
    const ta = el('textarea', 'display:block;width:100%;height:120px;margin-top:8px;background:#111;color:#eee;border:1px solid #777;border-radius:6px;font:11px monospace;box-sizing:border-box;');
    ta.value = text; ta.readOnly = true;
    sheet.appendChild(ta); ta.focus(); ta.select();
  }

  // ---- render ------------------------------------------------------------
  function render() {
    if (!isOpen()) return;
    sheet.textContent = '';
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
    head.appendChild(el('b', 'font-size:14px;color:#fff;', '🛡 Faction attackers'));
    const x = el('span', 'padding:0 6px;font-size:20px;cursor:pointer;color:#aaa;', '×');
    x.addEventListener('click', closePanel);
    head.appendChild(x);
    sheet.appendChild(head);

    if (!getKey()) { sheet.appendChild(setupBlock('This needs an API key with faction access.')); return; }
    if (problem && problem.code === 2) { sheet.appendChild(setupBlock('Torn didn\'t accept the key. Make a new one:')); return; }
    if (problem && problem.code === 16) { sheet.appendChild(setupBlock('This key can\'t read faction chain/attacks (needs faction API access). Make a key of its own:')); return; }

    // chain status line
    const left = chain ? Math.max(0, Math.ceil((chain.deadline - Date.now()) / 1000)) : 0;
    sheet.appendChild(el('div', 'margin-bottom:6px;color:' + (chain ? (left < 60 ? '#ff5b5b' : '#9d9') : '#888') + ';font-weight:bold;',
      chain ? 'Chain ' + chain.current + (chain.max ? '/' + chain.max : '') + ' · ' + mmss(left) + ' left' : (chainLoaded ? 'No live chain' : 'Checking chain…')));

    // controls: window and view
    const ctl = el('div', 'display:flex;flex-wrap:wrap;gap:4px 0;align-items:center;margin-bottom:8px;');
    WINDOWS.forEach((w) => ctl.appendChild(btn(w[1], () => { winMode = w[0]; data = null; render(); fetchAttacks(true); }, w[0] === winMode)));
    ctl.appendChild(el('span', 'width:10px;'));
    ctl.appendChild(btn('By attacker', () => { view = 'attackers'; render(); }, view === 'attackers'));
    ctl.appendChild(btn('By faction', () => { view = 'factions'; render(); }, view === 'factions'));
    ctl.appendChild(btn('By mate', () => { view = 'victims'; render(); }, view === 'victims'));
    sheet.appendChild(ctl);

    if (problem && problem.code === 5) sheet.appendChild(el('div', 'color:#fc6;', 'Rate limited - retrying shortly.'));
    else if (problem) sheet.appendChild(el('div', 'color:#f88;', 'API error: ' + problem.message + (problem.code != null ? ' (code ' + problem.code + ')' : '')));

    if (!data || dataMode !== winMode) { sheet.appendChild(el('div', '', busyAtk ? 'Loading…' : 'No data yet.')); appendDiag(); return; }

    sheet.appendChild(el('div', 'color:#aaa;margin-bottom:6px;',
      data.total + ' attacks on your faction · ' + data.wins + ' landed · ' + data.attackers.length + ' known attackers' +
      (data.recent ? ' · ' + data.recent + ' in the last ' + Math.round(RECENT_SEC / 60) + 'm' : '')));
    const grouped = data.factions.filter((f) => f.id && f.people >= 2);
    if (grouped.length) {
      sheet.appendChild(el('div', 'color:#fc6;margin-bottom:6px;', '⚠ Several from one faction: ' +
        grouped.slice(0, 3).map((f) => f.name + ' (' + f.people + ' players, ' + f.count + ' hits)').join(', ')));
    }

    if (view === 'factions') {
      if (!data.factions.length) sheet.appendChild(el('div', '', data.total ? 'Every attack in this window was anonymous.' : 'No attacks on your faction in this window.'));
      data.factions.slice(0, MAX_LISTED).forEach((f, i) => {
        const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
        if (f.id) row.appendChild(link(factionUrl(f.id), f.name, 'color:#7cf;'));
        else row.appendChild(el('span', 'color:#bbb;', f.name));
        row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  ' + f.count + ' hit' + (f.count === 1 ? '' : 's') + (f.id && f.people >= 2 ? ' · ' + f.people + ' players' : '')));
        row.appendChild(el('div', 'color:#bbb;', f.wins + ' landed · last ' + ago(f.last)));
        const names = el('div', 'color:#999;font-size:12px;', 'By: ');
        Array.from(f.attackers.entries()).forEach(([id, nm], k) => {
          if (k) names.appendChild(document.createTextNode(', '));
          names.appendChild(link(profileUrl(id), nm, 'color:#7cf;'));
        });
        row.appendChild(names);
        row.appendChild(el('div', 'color:#999;font-size:12px;', 'Hit: ' + Array.from(f.victims.values()).join(', ')));
        sheet.appendChild(row);
      });
    } else if (view === 'victims') {
      if (!data.victims.length) sheet.appendChild(el('div', '', 'No attacks on your faction in this window.'));
      data.victims.slice(0, MAX_LISTED).forEach((v, i) => {
        const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
        row.appendChild(link(profileUrl(v.id), v.name + ' [' + v.id + ']', 'color:#7cf;'));
        row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  ×' + v.count));
        row.appendChild(el('div', 'color:#bbb;', v.wins + ' hit(s) landed · last ' + ago(v.last)));
        sheet.appendChild(row);
      });
    } else {
      if (!data.attackers.length) sheet.appendChild(el('div', '', data.total ? 'Every attack in this window was anonymous.' : 'No attacks on your faction in this window.'));
      data.attackers.slice(0, MAX_LISTED).forEach((e, i) => {
        const row = el('div', i ? 'margin-top:6px;padding-top:6px;border-top:1px solid #444;' : '');
        row.appendChild(link(profileUrl(e.id), e.name + ' [' + e.id + ']', 'color:#7cf;'));
        if (e.count > 1) row.appendChild(el('span', 'color:#fc6;font-weight:bold;', '  🔁 ×' + e.count));
        const info = el('div', 'color:#bbb;', 'Lvl ' + e.level + ' · ');
        const fac = data.factions.find((f) => f.id && f.id === e.factionId);
        if (e.faction && fac) {
          info.appendChild(link(factionUrl(fac.id), e.faction, fac.people >= 2 ? 'color:#fc6;font-weight:bold;' : 'color:#bbb;'));
          if (fac.people >= 2) info.appendChild(el('span', 'color:#fc6;', ' (' + fac.people + ' of them)'));
        } else info.appendChild(document.createTextNode(e.faction || 'no faction'));
        info.appendChild(document.createTextNode(' · last: ' + (e.lastResult || '?') + ' ' + ago(e.last)));
        row.appendChild(info);
        row.appendChild(el('div', 'color:#999;font-size:12px;', 'Hit: ' + Array.from(e.victims.values()).join(', ')));
        sheet.appendChild(row);
      });
      if (data.attackers.length > MAX_LISTED) sheet.appendChild(el('div', 'margin-top:6px;color:#888;', '…and ' + (data.attackers.length - MAX_LISTED) + ' more'));
    }

    const foot = el('div', 'margin-top:10px;padding-top:6px;border-top:1px solid #444;font-size:11px;color:#888;display:flex;justify-content:space-between;align-items:center;');
    foot.appendChild(el('span', 'flex:1;min-width:0;', 'Updated ' + ago(data.ts) + ' · refreshes itself' + (data.hidden ? ' · ' + data.hidden + ' anonymous not shown' : '')));
    const acts = el('span', 'flex:none;white-space:nowrap;margin-left:8px;');
    acts.appendChild(btn('📋', copyList));
    acts.appendChild(btn(busyAtk ? '…' : '🔄', () => fetchAttacks(true)));
    foot.appendChild(acts);
    sheet.appendChild(foot);
    appendDiag();
  }
  function appendDiag() {
    const d = el('div', 'margin-top:6px;font-size:10px;color:#777;word-break:break-all;');
    d.textContent = 'Debug \u00b7 chain: ' + (diag.chain || 'n/a') + ' \u00b7 attacks: ' + (diag.atk || 'n/a') + (diag.log ? ' \u00b7 log: ' + diag.log : '');
    sheet.appendChild(d);
  }

  // ---- live strip --------------------------------------------------------
  // Shows on the faction page and the targets list. Visible only while a chain is live (or when a key is needed).
  const onWatchedPage = () =>
    /\/factions\.php/i.test(location.pathname) ||
    (/page\.php/i.test(location.pathname) && /[?&]sid=list/.test(location.search) && /[?&]type=targets/.test(location.search));
  const strip = el('div', 'display:none;position:fixed;left:10px;bottom:56px;z-index:2147483646;max-width:92vw;padding:6px 12px;' +
    'border-radius:14px;background:#1a1a1a;border:1px solid #555;font:bold 13px sans-serif;color:#fff;cursor:pointer;');
  strip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); });

  function updateStrip() {
    if (!onWatchedPage()) { if (strip.parentNode) strip.remove(); return; }
    const host = document.body || document.documentElement;
    if (host && strip.parentNode !== host) host.appendChild(strip);
    let text = '', border = '#555', color = '#fff';
    if (needsKey()) {
      text = '🛡 Attackers: key needed (tap)'; color = '#fc6';
    } else if (problem && problem.code !== 5) {
      text = '🛡 Attackers failed: ' + (problem.message || 'error') + (problem.code != null ? ' (' + problem.code + ')' : ''); color = '#f88'; border = '#f88';
    } else if (chain && data) {
      // Only attack info here; Torn already shows the chain count and timer.
      if (data.recent) {
        text = '🛡 ' + data.recent + ' hit' + (data.recent === 1 ? '' : 's') + ' on mates (' + Math.round(RECENT_SEC / 60) + 'm)';
        const tf = data.topRecent;
        if (tf && (tf.count >= 2 || tf.attackers.size >= 2)) text += ' · ' + tf.count + ' from ' + tf.name;
        border = '#f88';
      }
    }
    if (diag.logSummary) text = (text || '🛡') + ' · ' + diag.logSummary;
    if (!text) { text = '🛡'; color = '#888'; }
    if (strip.textContent !== text) strip.textContent = text;
    strip.style.color = color;
    strip.style.borderColor = border;
    strip.style.display = 'block';
  }

  // ---- annotate Torn's own "Recent attacks" rows -------------------------
  // Each row has a View link to the attack log whose ID is the attack code, which is how a row is matched to the API data.
  function annotateRows() {
    if (!data || !data.byCode || !/\/factions\.php/i.test(location.pathname)) return;
    const links = document.querySelectorAll('a[href*="attackLog"], a[href*="attacklog"]');
    links.forEach((a) => {
      const m = /[?&]ID=([^&#]+)/i.exec(a.getAttribute('href') || '');
      if (!m) return;
      const info = data.byCode.get(m[1]);
      let tag = a.parentNode && a.parentNode.querySelector && a.parentNode.querySelector('[data-fa-tag]');
      if (!info) { if (tag) tag.remove(); return; }
      const fac = info.fid ? data.factions.find((f) => f.id === info.fid) : null;
      const shared = !!(fac && fac.people >= 2);
      const text = info.faction ? '\ud83d\udee1 ' + info.faction + (shared ? ' \u00d7' + fac.people : '') : (info.hidden ? '' : '\ud83d\udee1 no faction');
      if (!text) { if (tag) tag.remove(); return; }
      if (!tag) {
        tag = el('span', '', '');
        tag.setAttribute('data-fa-tag', '1');
        a.parentNode.insertBefore(tag, a);
      }
      tag.style.cssText = 'margin-right:8px;font:bold 12px sans-serif;color:' + (shared ? '#fc6' : '#9cf') + ';';
      if (tag.textContent !== text) tag.textContent = text;
    });
  }

  // ---- attack-log test ---------------------------------------------------
  // Looks up a few of the page's own attacks by their log code (torn/attacklog), which may work without faction API access,
  // and reports what came back so we can tell whether it names the attacker's faction. Runs on the faction page only.
  const logTested = new Set();
  let logBusy = false;
  const LOG_MAX = 3;
  function pageAttackCodes() {
    const anon = [], named = [];
    document.querySelectorAll('a[href*="attackLog"], a[href*="attacklog"]').forEach((a) => {
      const m = /[?&]ID=([^&#]+)/i.exec(a.getAttribute('href') || '');
      if (!m || logTested.has(m[1]) || anon.includes(m[1]) || named.includes(m[1])) return;
      const row = a.closest('li') || (a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.parentElement);
      ((row && /Someone/.test(row.textContent || '')) ? anon : named).push(m[1]);
    });
    return anon.slice(0, 2).concat(named.slice(0, 1)).concat(anon.slice(2), named.slice(1));
  }
  async function testAttackLogs() {
    if (logBusy || logTested.size >= LOG_MAX || !getKey() || !/\/factions\.php/i.test(location.pathname)) return;
    const codes = pageAttackCodes();
    if (!codes.length) return;
    logBusy = true;
    const code = codes[0];
    logTested.add(code);
    try {
      const j = await api('torn/attacklog', { log: code, timestamp: nowSec() });
      const raw = JSON.stringify(j);
      const hasFaction = /faction/i.test(raw);
      diag.log = (diag.log ? diag.log + ' || ' : '') + code.slice(0, 6) + ': ' + raw.slice(0, 450);
      diag.logSummary = 'attack-log test: ' + (hasFaction ? 'faction info present' : 'no faction info');
    } catch (e) {
      diag.log = (diag.log ? diag.log + ' || ' : '') + code.slice(0, 6) + ': ERROR ' + e.message + (e.code != null ? ' (' + e.code + ')' : '');
      diag.logSummary = 'attack-log test: error ' + e.message + (e.code != null ? ' (' + e.code + ')' : '');
    }
    logBusy = false;
    updateStrip();
    render();
  }

  // ---- loop --------------------------------------------------------------
  function tick() {
    updateStrip();
    annotateRows();
    testAttackLogs();
    if (isOpen() && chain) render(); // keep the panel's chain timer ticking
    if (document.visibilityState === 'hidden' || !onWatchedPage() || !getKey() || needsKey()) return;
    if (Date.now() - lastChain >= CHAIN_POLL_MS) fetchChain();
    // Attacks are only read while a chain is live or the list is open, and not more often than ATTACK_POLL_MS.
    if ((chain || isOpen()) && Date.now() - lastAtk >= ATTACK_POLL_MS) fetchAttacks(false);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { lastChain = 0; lastAtk = 0; tick(); }
  });
  updateStrip();
  tick();
  setInterval(tick, 1000);
})();
