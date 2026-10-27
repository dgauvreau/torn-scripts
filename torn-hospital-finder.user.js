// ==UserScript==
// @name         Torn Find Target
// @namespace    torn-hospital-targets
// @version      6.18
// @description  "Find target" button at the top of the hospital page. Scans the end of the hospital list for people at or below your level with no faction and almost out of hospital, and shows profile details (via the official Torn API).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LEVEL_BUFFER = 0;   // allow targets this many levels above you (0 = your level or lower)
  const LEVEL_RANGE_PCT = 0.10; // the slider goes this far above your own level (10%, at least 1 level)
  const USE_LEVEL_LIMIT = true;     // only people at or below your level (+ LEVEL_BUFFER)
  const USE_FACTION_FILTER = true;  // skip people in a faction
  const MAX_SECONDS = 600;  // skip anyone with more than this left in hospital (checked on the page AND against the API)
  const MAX_LOOKUPS = 10;   // only look up details for this many of the most promising people
  const MIN_INACTIVE_DAYS = 7; // (unused for now)
  const FLAG = 'ht_find_target';
  const HOSPITAL_URL = 'https://www.torn.com/hospitalview.php';
  const onHospital = location.pathname.includes('hospitalview.php');

  // ---- API key -----------------------------------------------------------
  // Torn PDA replaces the placeholder below with your own key.
  // On other setups the script asks once and stores it in localStorage.
  let API_KEY = '###PDA-APIKEY###';
  if (!API_KEY || API_KEY.startsWith('###')) {
    try { API_KEY = localStorage.getItem('ht_api_key') || ''; } catch (e) { API_KEY = ''; }
  }
  function ensureKey() {
    if (API_KEY) return true;
    const k = prompt('Torn API key (a limited-access key is fine):');
    if (k) {
      API_KEY = k.trim();
      try { localStorage.setItem('ht_api_key', API_KEY); } catch (e) {}
      return true;
    }
    return false;
  }

  // ---- UI ----------------------------------------------------------------
  // The click logic lives on `btn`, which is never shown on the page.
  // The visible "Find target" button (inlineBtn) triggers it. It only exists on the
  // hospital page, in its own row at the very top, so it can't land in other scripts' output.
  const btn = document.createElement('button');

  const inlineBtn = document.createElement('button');
  inlineBtn.textContent = 'Find target';
  inlineBtn.style.cssText =
    'display:block;margin:4px auto;padding:6px 14px;background:#333;color:#ddd;' +
    'border:1px solid #777;border-radius:14px;font:13px sans-serif;cursor:pointer;';
  inlineBtn.addEventListener('click', (e) => { e.stopPropagation(); btn.click(); });

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:98px;right:6px;z-index:2147483647;' +
    'width:70vw;max-width:260px;display:none;max-height:45vh;overflow:auto;' +
    'background:#1a1a1a;color:#ccc;font:11px sans-serif;padding:6px;opacity:.92;' +
    'border:1px solid #444;border-radius:6px;';

  function ensureUI() {
    if (!onHospital) return; // nothing is added on any other page
    const host = document.body || document.documentElement;
    if (!host) return;
    if (!host.contains(panel)) host.appendChild(panel);
    // Keep the button as the first thing on the page, and put it back if Torn re-renders.
    if (inlineBtn.parentNode !== host || host.firstChild !== inlineBtn) host.insertBefore(inlineBtn, host.firstChild);
  }
  ensureUI();
  document.addEventListener('DOMContentLoaded', ensureUI);
  window.addEventListener('load', ensureUI);
  setInterval(ensureUI, 2000);

  // ---- parsing helpers ---------------------------------------------------
  function parseSeconds(text) {
    if (!text) return null;
    const t = text.trim();
    let m = t.match(/(\d+):(\d+):(\d+)/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    m = t.match(/(\d+):(\d+)/);
    if (m) return +m[1] * 60 + +m[2];
    const d = t.match(/(\d+)\s*d/i), h = t.match(/(\d+)\s*h/i), mi = t.match(/(\d+)\s*m/i), s = t.match(/(\d+)\s*s/i);
    if (d || h || mi || s) return (d ? +d[1] * 86400 : 0) + (h ? +h[1] * 3600 : 0) + (mi ? +mi[1] * 60 : 0) + (s ? +s[1] : 0);
    return null;
  }

  function rowSeconds(row) {
    const el = row.querySelector('.time, [class*="time"], [class*="timer"]');
    let s = el ? parseSeconds(el.textContent) : null;
    if (s === null) {
      const m = row.textContent.match(/\d+\s*d(?:ays?)?\b(?:\s*\d+\s*h)?(?:\s*\d+\s*m)?|\d+:\d+(:\d+)?|\d+\s*h(?:\s*\d+\s*m)?(?:\s*\d+\s*s)?|\d+\s*m(?:\s*\d+\s*s)?|\d+\s*s/i);
      s = m ? parseSeconds(m[0]) : null;
    }
    return s;
  }

  function fmtLeft(s) {
    s = Math.round(s);
    if (s <= 0) return 'out now';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }

  const inFaction = (row) => !!row.querySelector('a[href*="factions.php"]');

  // ---- profile lookups (official API) ------------------------------------
  const cache = {};     // id -> profile object | 'loading' | 'error'

  function detailLine(p) {
    if (p === 'loading') return 'loading details…';
    if (!p || p === 'error') return 'details unavailable (check API key)';
    const parts = [];
    parts.push('Lvl ' + p.level);
    parts.push('age ' + p.age + 'd');
    if (p.life) parts.push('life ' + p.life.maximum);
    if (p.last_action && p.last_action.relative) parts.push('seen ' + p.last_action.relative);
    if (p.revivable === 0) parts.push('not revivable');
    return parts.join(' · ');
  }

  // Seconds left on the player's current status (hospital etc.), straight from the API.
  function apiLeft(p) {
    if (!p || typeof p !== 'object' || !p.status || !p.status.until) return null;
    return p.status.until - Date.now() / 1000;
  }

  // ---- your own level (fetched once via the API) -------------------------
  let myLevel = null;
  let myLevelLoading = false;
  async function loadMyLevel() {
    if (myLevel !== null || myLevelLoading || !API_KEY) return;
    myLevelLoading = true;
    try {
      const r = await fetch('https://api.torn.com/user/?selections=profile&key=' + API_KEY);
      const j = await r.json();
      if (!j.error && typeof j.level === 'number') myLevel = j.level;
    } catch (e) {}
    myLevelLoading = false;
  }

  // ---- scan (one-shot: results stay put until you rescan or close) --------
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let scanning = false;
  let candidateCount = 0;    // matches on the page before the shortlist was cut
  let shortestOnPage = null; // smallest time seen on the page being scanned
  let longestOnPage = null;  // largest time seen on the page being scanned
  let tooLong = 0;           // rows skipped for having more than MAX_SECONDS left

  // Rows of the hospital list. Falls back to any list item holding a profile
  // link if Torn's class names differ from what we expect.
  function getRows() {
    let rows = [...document.querySelectorAll('.user-info-list-wrap li')];
    if (rows.length) return rows;
    const set = new Set();
    document.querySelectorAll('a[href*="profiles.php?XID="]').forEach((a) => {
      const li = a.closest('li');
      if (li) set.add(li);
    });
    return [...set];
  }

  // Which page we are on and the highest page number the pager shows.
  function pageInfo() {
    const links = [...document.querySelectorAll('[class*="pagination"] a, [class*="pager"] a')];
    let cur = null, max = null;
    links.forEach((a) => {
      const t = a.textContent.trim();
      if (!/^\d+$/.test(t)) return;
      const n = +t;
      if (max === null || n > max) max = n;
      const cls = (a.className || '') + ' ' + ((a.parentElement && a.parentElement.className) || '');
      if (/active|current|selected/i.test(cls)) cur = n;
    });
    return { cur, max };
  }
  let diag = '';
  let pageNote = '';
  let lastTargets = [];
  const collectTargets = () => lastTargets;

  function collect() {
    const rows = getRows();
    let withTime = 0;
    const targets = [];
    shortestOnPage = null;
    longestOnPage = null;
    tooLong = 0;
    rows.forEach((row) => {
      const link = row.querySelector('a[href*="profiles.php?XID="]');
      if (!link) return;
      const secs = rowSeconds(row);
      if (secs !== null) withTime++;
      if (secs !== null && (shortestOnPage === null || secs < shortestOnPage)) shortestOnPage = secs;
      if (secs !== null && (longestOnPage === null || secs > longestOnPage)) longestOnPage = secs;
      if (secs !== null && secs > MAX_SECONDS) tooLong++;
      const ok = secs !== null && secs <= MAX_SECONDS && (!USE_FACTION_FILTER || !inFaction(row));
      row.style.outline = ok ? '1px solid rgba(80,180,80,.5)' : '';
      if (ok) {
        const id = link.href.match(/XID=(\d+)/)[1];
        const lm = row.textContent.match(/Level:?\s*(\d+)/i);
        const rm = row.textContent.match(/Reason:?\s*(.+)/i);
        targets.push({ id, name: link.textContent.trim() || id, secs, lvl: lm ? +lm[1] : null, reason: rm ? rm[1].trim().slice(0, 60) : '' });
      }
    });
    const pg = pageInfo();
    pageNote = pg.cur === null ? 'page ?' : 'page ' + pg.cur;
    const pagerNote = pg.max !== null ? ' (pager shows up to ' + pg.max + ')' : '';
    lastTargets = targets;
    diag = pageNote + pagerNote + ' · rows: ' + rows.length + ' · readable time: ' + withTime +
      (withTime ? ' · times ' + fmtLeft(shortestOnPage) + ' to ' + fmtLeft(longestOnPage) : '') +
      ' · over ' + Math.round(MAX_SECONDS / 60) + 'm: ' + tooLong +
      (USE_FACTION_FILTER ? ' · kept (no faction): ' : ' · kept: ') + targets.length;
    return targets;
  }

  // Highest level shown: the slider value (remembered), default = your level; the slider's
  // upper end always follows your level (your level + LEVEL_RANGE).
  function sliderMax() { return myLevel === null ? null : myLevel + Math.max(1, Math.ceil(myLevel * LEVEL_RANGE_PCT)); }
  function limitLevel() {
    if (myLevel === null) return null;
    let v = NaN;
    try { v = parseInt(localStorage.getItem('ht_max_level'), 10); } catch (e) {}
    if (isNaN(v)) v = myLevel + LEVEL_BUFFER;
    return Math.max(1, Math.min(sliderMax(), v));
  }

  // Lowest level shown: its own slider (remembered), default 1, never above the max.
  function minLevel() {
    if (myLevel === null) return 1;
    let v = NaN;
    try { v = parseInt(localStorage.getItem('ht_min_level'), 10); } catch (e) {}
    if (isNaN(v)) v = 1;
    return Math.max(1, Math.min(limitLevel(), v));
  }

  // True if the API details say this person should be dropped.
  function excluded(p) {
    if (!p || typeof p !== 'object') return false; // details unavailable: keep
    if (USE_FACTION_FILTER && p.faction && p.faction.faction_id) return true;
    if (USE_LEVEL_LIMIT && myLevel !== null && (p.level > limitLevel() || p.level < minLevel())) return true;
    const left = apiLeft(p);
    if (left !== null && left > MAX_SECONDS) return true; // the API says they are in much longer than the page claimed
    return false;
  }

  const inflight = {}; // id -> promise, so the same person is never looked up twice at once
  function fetchProfile(id) {
    const c = cache[id];
    if (c && c !== 'loading' && c !== 'error') return Promise.resolve();
    if (inflight[id]) return inflight[id];
    cache[id] = 'loading';
    inflight[id] = (async () => {
      try {
        const r = await fetch('https://api.torn.com/user/' + id + '?selections=profile&key=' + API_KEY);
        const j = await r.json();
        cache[id] = j.error ? 'error' : j;
      } catch (e) {
        cache[id] = 'error';
      }
      delete inflight[id];
    })();
    return inflight[id];
  }

  function smallBtn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'margin-left:6px;padding:2px 8px;background:#333;color:#ddd;border:1px solid #777;' +
      'border-radius:10px;font:11px sans-serif;cursor:pointer;';
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function closePanel() {
    panel.style.display = 'none';
    getRows().forEach((r) => { r.style.outline = ''; });
  }

  function rescan() {
    // Reload the hospital list so the rows (and times) are fresh, then scan again.
    sessionStorage.setItem(FLAG, '1');
    location.href = HOSPITAL_URL;
  }

  const boxes = {};
  let countEl = null;
  let dgEl = null;
  let diagOpen = false;
  function diagText() {
    if (diagOpen) return diag + ' · my level: ' + (myLevel === null ? 'unknown' : myLevel) + ' (tap to hide)';
    return pageNote + ' · ' + kept.size + ' found · tap for details';
  }
  // True while the page still doesn't look like the end of the hospital list
  // (pager not on the last page yet, no rows yet, or only long-time rows showing).
  function looksLoading() {
    const pg = pageInfo();
    if (pg.cur !== null && pg.max !== null && pg.cur < pg.max) return true;
    if (shortestOnPage === null) return Date.now() - liveStart < 15000;
    if (shortestOnPage > MAX_SECONDS) return true;
    return false;
  }

  function updateCount() {
    if (!countEl) return;
    const n = Object.keys(boxes).filter((k) => boxes[k].parentNode).length;
    countEl.textContent = (n === 0 && looksLoading()) ? 'Loading…'
      : 'Targets: ' + n + (candidateCount > MAX_LOOKUPS ? ' (top ' + MAX_LOOKUPS + ' of ' + candidateCount + ')' : '');
  }

  // Once a target's API details are in, drop them if they don't qualify
  // (faction, above your level, or much longer in hospital than the page said),
  // otherwise fill in their current life and the no-faction confirmation.
  function fillBox(t) {
    const box = boxes[t.id];
    if (!box || !box.parentNode) return;
    const p = cache[t.id];
    if (excluded(p)) { box.remove(); updateCount(); return; }
    const ok = p && typeof p === 'object';
    if (box.lvlEl && t.lvl === null && ok && typeof p.level === 'number') box.lvlEl.textContent = p.level;
    if (box.lifeEl) {
      box.lifeEl.textContent = ok && p.life && p.life.current != null ? Number(p.life.current).toLocaleString() : (p === 'error' || ok ? '?' : '…');
    }
    if (box.facEl) {
      if (ok && p.faction && +p.faction.faction_id === 0) { box.facEl.textContent = '✓ None'; box.facEl.style.color = '#7c7'; }
      else if (p === 'error' || (ok && !p.faction)) { box.facEl.textContent = '?'; box.facEl.style.color = '#fc6'; }
    }
  }

  // Show the list straight away from what the hospital page already tells us;
  // API details fill in underneath as each lookup finishes.
  function render(targets, when) {
    panel.style.display = 'block';
    panel.textContent = '';
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = p2(when.getHours()) + ':' + p2(when.getMinutes()) + ':' + p2(when.getSeconds());

    const head = document.createElement('div');
    countEl = document.createElement('b');
    head.appendChild(countEl);
    head.appendChild(smallBtn('Rescan', rescan));
    head.appendChild(smallBtn('Close', closePanel));
    panel.appendChild(head);

    if (USE_LEVEL_LIMIT && myLevel !== null) {
      const mkSlider = (word, key, get, lo, hi) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;color:#aaa;';
        const lab = document.createElement('span');
        lab.style.cssText = 'min-width:84px;';
        const sl = document.createElement('input');
        sl.type = 'range'; sl.min = lo(); sl.max = hi(); sl.value = get();
        sl.style.cssText = 'flex:1;min-width:0;';
        const setLab = () => { lab.textContent = word + ' level ' + sl.value + (+sl.value === myLevel ? ' (you)' : ''); };
        setLab();
        sl.addEventListener('input', setLab);
        sl.addEventListener('change', () => {
          try { localStorage.setItem(key, sl.value); } catch (e) {}
          lastSig = null; tick();
        });
        row.appendChild(lab); row.appendChild(sl);
        panel.appendChild(row);
      };
      mkSlider('Min', 'ht_min_level', minLevel, () => 1, () => sliderMax());
      mkSlider('Max', 'ht_max_level', limitLevel, () => 1, () => sliderMax());
    }

    const dg = document.createElement('div');
    dg.style.cssText = 'color:#777;margin-top:2px;cursor:pointer;';
    dg.textContent = diagText();
    dg.addEventListener('click', (e) => { e.stopPropagation(); diagOpen = !diagOpen; dg.textContent = diagText(); });
    panel.appendChild(dg);
    dgEl = dg;

    Object.keys(boxes).forEach((k) => delete boxes[k]);
    if (!targets.length) {
      const none = document.createElement('div');
      none.style.cssText = 'margin-top:6px;';
      if (looksLoading()) none.innerHTML = '<i>Loading…</i>';
      else none.innerHTML = '<i>None found</i>' + (shortestOnPage === null ? ' - the page shows no rows' : ' - shortest time on this page: ' + fmtLeft(shortestOnPage));
      panel.appendChild(none);
      updateCount();
      return;
    }

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;margin-top:6px;';
    const hdr = document.createElement('tr');
    const th = (txt, al) => '<th style="text-align:' + al + ';color:#888;font-weight:normal;padding:2px 4px;">' + txt + '</th>';
    hdr.innerHTML = th('Name', 'left') + th('Lvl', 'right') + th('Health', 'right') + th('Faction', 'center');
    table.appendChild(hdr);

    targets.forEach((t) => {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-top:1px solid #444;';

      const tdName = document.createElement('td');
      tdName.style.cssText = 'padding:5px 4px;';
      const a = document.createElement('a');
      a.href = 'https://www.torn.com/profiles.php?XID=' + t.id;
      a.target = '_blank';
      a.style.color = '#7cf';
      a.textContent = t.name;
      tdName.appendChild(a);

      const tdLvl = document.createElement('td');
      tdLvl.style.cssText = 'padding:5px 4px;text-align:right;color:#ddd;';
      tdLvl.textContent = t.lvl !== null ? t.lvl : '?';

      const tdLife = document.createElement('td');
      tdLife.style.cssText = 'padding:5px 4px;text-align:right;color:#ddd;';
      tdLife.textContent = API_KEY ? '…' : '–';

      const tdFac = document.createElement('td');
      tdFac.style.cssText = 'padding:5px 4px;text-align:center;color:#999;white-space:nowrap;';
      tdFac.textContent = API_KEY ? '…' : '–';

      tr.appendChild(tdName);
      tr.appendChild(tdLvl);
      tr.appendChild(tdLife);
      tr.appendChild(tdFac);
      tr.lvlEl = tdLvl;
      tr.lifeEl = tdLife;
      tr.facEl = tdFac;
      boxes[t.id] = tr;
      table.appendChild(tr);
    });
    panel.appendChild(table);
    updateCount();
  }

  // ---- live scan ---------------------------------------------------------
  // Re-reads the page every second (like the older versions did), so it doesn't matter
  // exactly when Torn finishes swapping to the last page: stale rows (days left) are
  // dropped by the time cap and the list fills in as soon as the real last page appears.
  // The list on screen is only rebuilt when the set of targets changes.
  let liveTimer = null, lastSig = null, liveStart = 0, jumpRetries = 0;
  // Everyone found on the last page, kept even if Torn later drops their row from the page
  // (or swaps the page). Only the API check (faction / level / long timer) removes anyone.
  const kept = new Map(); // id -> target

  function tick() {
    if (panel.style.display === 'none') { clearInterval(liveTimer); liveTimer = null; return; }

    // If the pager still isn't on the last page after a few seconds, click the last-page link again.
    const pg = pageInfo();
    if (pg.cur !== null && pg.max !== null && pg.cur < pg.max && jumpRetries < 3 && Date.now() - liveStart > 5000 * (jumpRetries + 1)) {
      jumpRetries++;
      const l = findLastPageLink();
      if (l) l.click();
    }

    collect(); // refreshes the page diagnostics and highlights
    const onPage = collectTargets();
    onPage.forEach((t) => { if (!kept.has(t.id)) kept.set(t.id, t); });
    let found = [...kept.values()].filter((t) => !excluded(cache[t.id]));
    if (USE_LEVEL_LIMIT && myLevel !== null) found = found.filter((t) => t.lvl === null || (t.lvl <= limitLevel() && t.lvl >= minLevel()));
    candidateCount = found.length;
    diag += ' · saved: ' + kept.size + (USE_LEVEL_LIMIT ? ' · levels ' + minLevel() + '–' + limitLevel() + ': ' + found.length : '');
    // Lowest level first when the level limit is on, otherwise soonest out first.
    found.sort((a, b) => {
      if (!USE_LEVEL_LIMIT) return a.secs - b.secs;
      if ((a.lvl === null) !== (b.lvl === null)) return a.lvl === null ? 1 : -1;
      if (a.lvl !== b.lvl) return a.lvl - b.lvl;
      return a.secs - b.secs;
    });
    found = found.slice(0, MAX_LOOKUPS);

    const sig = minLevel() + '-' + limitLevel() + ':' + found.map((t) => t.id).join(',') + (found.length ? '' : (looksLoading() ? '|loading' : '|none'));
    if (sig !== lastSig) {
      lastSig = sig;
      render(found, new Date());
      if (API_KEY) {
        // Each box fills in as its lookup finishes (people already looked up fill in at once).
        found.forEach((t, i) => {
          setTimeout(async () => { await fetchProfile(t.id); fillBox(t); }, i * 150);
        });
      }
    } else {
      if (dgEl) dgEl.textContent = diagText();
    }
  }

  function startLive() {
    ensureKey();
    panel.style.display = 'block';
    panel.textContent = 'Scanning…';
    lastSig = null;
    kept.clear();
    jumpRetries = 0;
    liveStart = Date.now();
    clearInterval(liveTimer);
    loadMyLevel(); // not awaited: the list shows right away and re-filters once your level is known
    tick();
    liveTimer = setInterval(tick, 1000);
  }

  // ---- last-page jump ----------------------------------------------------
  function findLastPageLink() {
    const links = [...document.querySelectorAll('[class*="pagination"] a, [class*="pager"] a')];
    const byLabel = links.find((a) => /last|»|>>/i.test((a.title || '') + (a.textContent || '') + (a.className || '')));
    if (byLabel) return byLabel;
    const nums = links.filter((a) => /^\d+$/.test(a.textContent.trim()));
    nums.sort((a, b) => +b.textContent - +a.textContent);
    return nums[0] || null;
  }

  // A short fingerprint of the list as shown, so we can tell when it changes.
  function listSignature() {
    const rows = getRows();
    if (!rows.length) return '';
    const a = rows[0].querySelector('a[href*="profiles.php?XID="]');
    const b = rows[rows.length - 1].querySelector('a[href*="profiles.php?XID="]');
    return rows.length + '|' + (a ? a.href : '') + '|' + (b ? b.href : '');
  }

  async function waitFor(cond, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await sleep(250);
    }
    return false;
  }

  // Click the last page (the list is sorted longest-first, so the end holds the shortest
  // times) and start the live scan straight away - no waiting for the page to settle.
  async function jumpAndScan() {
    panel.style.display = 'block';
    panel.textContent = 'Opening the last page of the hospital list…';
    await waitFor(() => getRows().length > 0, 10000);
    const pg = pageInfo();
    const onLast = pg.cur !== null && pg.max !== null && pg.cur >= pg.max;
    const last = findLastPageLink();
    if (last && !onLast && !/active|current|selected/i.test(last.className)) {
      // If the last-page link makes Torn reload the whole page, this flag makes the new page scan too
      // (the way the earliest versions did). It is cleared a few seconds later if no reload happens.
      sessionStorage.setItem(FLAG, '1');
      last.click();
      setTimeout(() => sessionStorage.removeItem(FLAG), 8000);
    }
    startLive();
  }

  btn.addEventListener('click', () => {
    if (!onHospital) {
      sessionStorage.setItem(FLAG, '1');
      location.href = HOSPITAL_URL;
      return;
    }
    jumpAndScan();
  });

  if (onHospital && sessionStorage.getItem(FLAG)) {
    sessionStorage.removeItem(FLAG);
    jumpAndScan();
  }
})();
