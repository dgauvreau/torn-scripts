// ==UserScript==
// @name         Torn Find Target
// @namespace    torn-hospital-targets
// @version      6.51
// @description  A Find Targets button on the hospital page scans the end of the hospital list for people at or below your level with no faction and almost out of hospital, and shows profile details (via the official Torn API). If fewer than 10 people match, it keeps jumping back through earlier hospital pages, going further each time.
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
  const MIN_RESULTS = 10;   // if fewer people than this match on the last hospital page, step back through earlier pages
  const MAX_JUMPS = 8;      // ...but never open more than this many extra pages (each jump goes twice as far back as the last)
  const MIN_INACTIVE_DAYS = 7; // (unused for now)
  const FLAG = 'ht_find_target';
  const WALK_KEY = 'ht_walk'; // carries the search across a page reload when Torn reloads the page as we step back
  const HOSPITAL_URL = 'https://www.torn.com/hospitalview.php';
  const onHospital = location.pathname.includes('hospitalview.php');
  const VERSION = '6.51';

  // ---- error notice -----------------------------------------------------------
  // Created first, before anything else can fail. It stays hidden unless the script breaks; then a red notice with
  // the error text shows on the hospital page (tap it to dismiss).
  const badge = document.createElement('div');
  badge.setAttribute('data-find-target-badge', '1');
  badge.style.cssText = 'display:none;box-sizing:border-box;width:100%;margin:6px 0;padding:8px;background:#3a1f1f;color:#f99;' +
    'border:1px solid #a44;border-radius:5px;font:12px sans-serif;cursor:pointer;';
  let lastError = '';
  function badgeOk() { lastError = ''; badge.style.display = 'none'; }
  function reportError(msg) {
    lastError = String(msg || 'unknown error').slice(0, 200);
    badge.textContent = 'Find Targets ' + VERSION + ' \u26a0 ' + lastError + ' (tap to dismiss)';
    badge.style.display = 'block';
    ensureBadge();
  }
  badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); badgeOk(); });
  function ensureBadge() {
    if (!onHospital || !lastError || !document.body) return;
    const list = document.querySelector('.user-info-list-wrap');
    const host = list && list.parentNode ? list.parentNode : (document.querySelector('#mainContainer, .content-wrapper') || document.body);
    if (badge.parentNode !== host) host.insertBefore(badge, list && list.parentNode === host ? list : host.firstChild);
  }
  // Only errors thrown by this script's own code are shown. Anything running from our timers, clicks or scans is
  // wrapped so a failure lands here; nothing is picked up from the rest of the page (Torn's own scripts and the
  // browser raise their own, unrelated errors all the time).
  const safe = (fn) => function () {
    try {
      const r = fn.apply(this, arguments);
      if (r && typeof r.catch === 'function') r.catch((e) => reportError(e && e.message));
      return r;
    } catch (e) { reportError(e && e.message); }
  };
  const setTimeout = (f, t) => window.setTimeout(typeof f === 'function' ? safe(f) : f, t);
  const setInterval = (f, t) => window.setInterval(typeof f === 'function' ? safe(f) : f, t);
  setInterval(ensureBadge, 1000);

  try {

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
  // The Scan button in the panel on the hospital page triggers it.
  const btn = document.createElement('button');

  const panel = document.createElement('div');
  panel.style.cssText =
    'display:none;position:relative;box-sizing:border-box;width:100%;margin:6px 0;' +
    'background:rgba(128,128,128,.12);color:inherit;font-size:14px;padding:10px;' +
    'border:1px solid rgba(128,128,128,.35);border-radius:5px;';

  let scanning = false;
  function showIdle() {
    panel.textContent = '';
    panel.style.display = 'block';
    // one plain button: the panel itself is just the button until a scan is running
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Find Targets';
    b.style.cssText = 'display:block;width:100%;padding:6px 0;background:transparent;color:inherit;border:0;' +
      'font:inherit;font-weight:bold;font-size:14px;cursor:pointer;';
    b.addEventListener('click', safe((e) => { e.preventDefault(); btn.click(); }));
    panel.appendChild(b);
  }
  function ensureUI() {
    if (!onHospital) return; // the results panel only exists on the hospital page
    // The panel sits inline, in the page itself, right above the hospital list.
    const list = document.querySelector('.user-info-list-wrap');
    let parent = null, before = null;
    if (list && list.parentNode) { parent = list.parentNode; before = list; }
    else {
      const title = document.querySelector('.content-title, [class*="content-title"]');
      if (title && title.parentNode) { parent = title.parentNode; before = title.nextSibling; }
      else { parent = document.querySelector('#mainContainer, .content-wrapper') || document.body; }
    }
    if (!parent) return;
    if (panel.parentNode !== parent || (before && panel.nextSibling !== before)) parent.insertBefore(panel, before);
    if (!scanning && panel.style.display === 'none') showIdle();
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
  // State of the search across hospital pages: null when not scanning.
  let walk = null;

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
      'margin:0 8px 0 0;padding:6px 14px;background:rgba(128,128,128,.18);color:inherit;border:1px solid rgba(128,128,128,.5);' +
      'border-radius:6px;font:inherit;font-size:13px;font-weight:bold;cursor:pointer;';
    b.addEventListener('click', safe((e) => { e.stopPropagation(); fn(); }));
    return b;
  }

  function closePanel() {
    scanning = false;
    walk = null;
    clearInterval(liveTimer); liveTimer = null;
    getRows().forEach((r) => { r.style.outline = ''; });
    showIdle();
  }

  function rescan() {
    // Reload the hospital list so the rows (and times) are fresh, then scan again.
    try { sessionStorage.removeItem(WALK_KEY); } catch (e) {}
    sessionStorage.setItem(FLAG, '1');
    panel.textContent = 'Rescanning\u2026';
    // Loading the exact same address can be ignored by the app, so add a changing parameter to force a real reload.
    location.href = HOSPITAL_URL + '?rescan=' + Date.now();
  }

  const boxes = {};
  let countEl = null;
  let statusEl = null;
  let dgEl = null;
  let diagOpen = false;
  function diagText() {
    if (diagOpen) return diag + ' · my level: ' + (myLevel === null ? 'unknown' : myLevel) + ' (tap to hide)';
    return pageNote + ' · ' + kept.size + ' found · v' + VERSION + ' · tap for details';
  }
  // True while the page still doesn't look like the end of the hospital list
  // (pager not on the last page yet, no rows yet, or only long-time rows showing).
  function looksLoading() {
    const pg = pageInfo();
    if (walk && walk.moving) return true; // opening an earlier page
    // Once the last page has been reached, being on an earlier page is on purpose, not "still loading".
    if (pg.cur !== null && pg.max !== null && pg.cur < pg.max && !(walk && walk.reachedLast)) return true;
    if (shortestOnPage === null) return Date.now() - liveStart < 15000;
    if (shortestOnPage > MAX_SECONDS) return !(walk && walk.reachedLast && walk.stable >= 2);
    return false;
  }

  // A plain-words progress line: what the scan is doing right now, or why it finished.
  let dots = 0;
  function statusText() {
    if (!walk) return '';
    const pg = pageInfo();
    const pagesTxt = (walk.back + 1) + (walk.back === 0 ? ' page' : ' pages') + ' searched';
    if (walk.stuck) return 'Stopped: couldn\u2019t open an earlier page \u00b7 ' + pagesTxt;
    const finished = !walk.moving && walk.why;
    if (finished) return 'Finished: ' + walk.why + ' \u00b7 ' + pagesTxt;
    dots = (dots + 1) % 4;
    const dd = '...'.slice(0, dots);
    if (walk.moving) return 'Still searching, opening ' + (walk.expect ? 'page ' + walk.expect : 'an earlier page') + dd + ' \u00b7 ' + pagesTxt;
    if (!walk.reachedLast) return 'Opening the last page' + dd;
    return 'Still searching, checking ' + (pg.cur !== null ? 'page ' + pg.cur : 'this page') + dd + ' \u00b7 ' + pagesTxt;
  }

  function updateCount() {
    if (statusEl) statusEl.textContent = statusText();
    if (!countEl) return;
    const n = Object.keys(boxes).filter((k) => boxes[k].parentNode).length;
    countEl.textContent = (n === 0 && looksLoading()) ? 'Loading\u2026'
      : (candidateCount < MIN_RESULTS) ? 'Found ' + n + ' of ' + MIN_RESULTS + ' targets'
      : (candidateCount > n ? 'Found ' + n + ' of ' + candidateCount + ' targets' : 'Found ' + n + ' targets');
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
    countEl.style.cssText = 'display:block;font-size:15px;margin-bottom:8px;';
    head.appendChild(countEl);
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'opacity:.85;font-size:13px;margin:-4px 0 8px;';
    head.appendChild(statusEl);
    head.appendChild(smallBtn('Rescan', rescan));
    head.appendChild(smallBtn('Stop', closePanel));
    panel.appendChild(head);

    if (USE_LEVEL_LIMIT && myLevel !== null) {
      // Level range with tap buttons (a slider clashes with PDA's swipe-in drawer on the left edge of the screen).
      const lo = 1, hi = sliderMax();
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:10px;';
      const lab = document.createElement('div');
      lab.style.cssText = 'opacity:.8;margin-bottom:6px;';
      lab.textContent = 'Level range (you: ' + myLevel + ')';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;';
      let curMin = minLevel(), curMax = limitLevel();
      let commitTimer = null;
      const commit = () => {
        clearTimeout(commitTimer);
        commitTimer = setTimeout(() => {
          try { localStorage.setItem('ht_min_level', curMin); localStorage.setItem('ht_max_level', curMax); } catch (e) {}
          lastSig = null; tick();
        }, 500);
      };
      const stepper = (name, get, set) => {
        const g = document.createElement('div');
        g.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const nm = document.createElement('span');
        nm.textContent = name;
        nm.style.cssText = 'opacity:.8;';
        const val = document.createElement('b');
        val.style.cssText = 'min-width:2.2em;text-align:center;font-size:16px;';
        const mkb = (txt, d) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = txt;
          b.style.cssText = 'width:38px;height:34px;padding:0;background:rgba(128,128,128,.18);color:inherit;' +
            'border:1px solid rgba(128,128,128,.5);border-radius:6px;font:inherit;font-size:18px;font-weight:bold;cursor:pointer;';
          b.addEventListener('click', safe((e) => { e.preventDefault(); e.stopPropagation(); set(get() + d); refresh(); commit(); }));
          return b;
        };
        g.appendChild(nm); g.appendChild(mkb('\u2212', -1)); g.appendChild(val); g.appendChild(mkb('+', 1));
        g.val = val;
        return g;
      };
      const gMin = stepper('From', () => curMin, (v) => { curMin = Math.max(lo, Math.min(v, curMax)); });
      const gMax = stepper('To', () => curMax, (v) => { curMax = Math.min(hi, Math.max(v, curMin)); });
      const refresh = () => { gMin.val.textContent = curMin; gMax.val.textContent = curMax; };
      refresh();
      row.appendChild(gMin); row.appendChild(gMax);
      wrap.appendChild(lab); wrap.appendChild(row);
      panel.appendChild(wrap);
    }

    const dg = document.createElement('div');
    dg.style.cssText = 'opacity:.6;margin-top:10px;font-size:12px;cursor:pointer;';
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

    // One card per target: the name (big, tap anywhere on the left to open the profile) with the details under
    // it, and a small Attack button on the right.
    const list = document.createElement('div');
    list.style.cssText = 'margin-top:10px;';
    targets.forEach((t) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid rgba(128,128,128,.4);';

      const prof = document.createElement('a');
      prof.href = 'https://www.torn.com/profiles.php?XID=' + t.id;
      prof.target = '_blank';
      prof.style.cssText = 'flex:1;min-width:0;color:inherit;text-decoration:none;display:block;';
      const nm = document.createElement('div');
      nm.textContent = t.name;
      nm.style.cssText = 'font-size:17px;font-weight:bold;text-decoration:underline;word-break:break-word;';
      const info = document.createElement('div');
      info.style.cssText = 'margin-top:3px;opacity:.85;font-size:13px;';
      const lvlEl = document.createElement('span');
      lvlEl.textContent = t.lvl !== null ? t.lvl : '?';
      const lifeEl = document.createElement('span');
      lifeEl.textContent = API_KEY ? '\u2026' : '\u2013';
      const facEl = document.createElement('span');
      facEl.textContent = API_KEY ? '\u2026' : '\u2013';
      const dot = () => { const d = document.createElement('span'); d.textContent = '  \u00b7  '; d.style.cssText = 'opacity:.5;'; return d; };
      const txt = (x) => document.createTextNode(x);
      info.appendChild(txt('Lvl ')); info.appendChild(lvlEl);
      info.appendChild(dot());
      info.appendChild(txt('Health ')); info.appendChild(lifeEl);
      info.appendChild(dot());
      info.appendChild(facEl);
      prof.appendChild(nm); prof.appendChild(info);

      const atk = document.createElement('a');
      atk.href = 'https://www.torn.com/loader.php?sid=attack&user2ID=' + t.id;
      atk.target = '_blank';
      atk.textContent = 'Attack';
      atk.style.cssText =
        'flex:none;padding:6px 12px;color:inherit;border:1px solid rgba(128,128,128,.6);' +
        'border-radius:5px;font-size:12px;text-decoration:none;opacity:.85;';

      row.appendChild(prof);
      row.appendChild(atk);
      row.lvlEl = lvlEl;
      row.lifeEl = lifeEl;
      row.facEl = facEl;
      boxes[t.id] = row;
      list.appendChild(row);
    });
    panel.appendChild(list);
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

  // ---- jumping back through earlier hospital pages -------------------------------
  // The scan starts on the last hospital page (shortest times). If fewer than MIN_RESULTS people match
  // there, it jumps to an earlier page and adds what it finds there, and keeps going until it has enough.
  // Each jump is twice as long as the one before (1 page back, then 2, then 4, 8 ...), so it reaches the
  // pages with more people quickly, at the cost of skipping some pages in between (so some matches will be
  // released a bit later). If a jump lands on a page where everyone is over the time limit, it comes back
  // about halfway (and halves again) to cover the pages it skipped. It stops at enough matches, page 1,
  // when there are no pages left in between, or after MAX_JUMPS extra pages.
  function numberLinks() {
    return [...document.querySelectorAll('[class*="pagination"] a, [class*="pager"] a')]
      .filter((a) => /^\d+$/.test(a.textContent.trim()))
      .map((a) => ({ a, n: +a.textContent.trim() }));
  }
  function arrowLink() {
    const links = [...document.querySelectorAll('[class*="pagination"] a, [class*="pager"] a')];
    return links.find((a) => {
      const label = (a.title || '') + ' ' + (a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '') + ' ' + (a.className || '');
      return /prev|‹|<|←/i.test(label) && !/disabled|inactive/i.test(label);
    }) || null;
  }
  // The pager link that gets closest to `target` while staying strictly between `low` and `high` (the pager may
  // only show some page numbers). With allowArrow, falls back to the "previous" arrow (one page back).
  function pickJump(pg, target, low, high, allowArrow) {
    const best = numberLinks()
      .filter((x) => x.n > low && x.n < high && x.n !== pg.cur)
      .sort((x, y) => (Math.abs(x.n - target) - Math.abs(y.n - target)) || (y.n - x.n))[0];
    if (best) return { link: best.a, expect: best.n };
    if (allowArrow) {
      const arrow = arrowLink();
      if (arrow) return { link: arrow, expect: pg.cur !== null ? pg.cur - 1 : null };
    }
    return null;
  }
  // If Torn reloads the whole page when we click a page link, everything found so far is carried over
  // in sessionStorage so the search carries on (instead of starting again and looping).
  let walkSaveTimer = null;
  function saveWalkState() {
    try {
      sessionStorage.setItem(WALK_KEY, JSON.stringify({ t: Date.now(), back: walk.back + 1, lo: walk.lo, hi: walk.hi, step: walk.step, kept: [...kept.values()] }));
      clearTimeout(walkSaveTimer);
      walkSaveTimer = setTimeout(() => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) {} }, 10000);
    } catch (e) {}
  }
  function takeWalkState() {
    try {
      const raw = sessionStorage.getItem(WALK_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(WALK_KEY);
      const o = JSON.parse(raw);
      if (o && Date.now() - o.t < 20000 && Array.isArray(o.kept)) return o;
    } catch (e) {}
    return null;
  }
  function walkNote() {
    if (!walk) return '';
    if (walk.stuck) return ' · couldn’t open an earlier page';
    if (walk.moving) return ' · opening an earlier page…';
    return walk.back > 0 ? ' · searched ' + (walk.back + 1) + ' pages' : '';
  }
  function walkDiag() {
    if (!walk) return '';
    return ' · pages searched: ' + (walk.back + 1) + (walk.reachedLast ? '' : ' (finding the last page)') +
      (walk.hi !== null ? ' · earliest good page: ' + walk.hi : '') + (walk.lo > 0 ? ' · over the limit from page ' + walk.lo : '') +
      (walk.why ? ' · stopped: ' + walk.why : '') + (walk.stuck ? ' · stuck' : '');
  }
  function stepWalk(pg, sigNow) {
    if (!walk || !walk.reachedLast || walk.stuck) return;
    if (walk.moving) {
      // Waiting for the earlier page to show: the list changes and the pager moves to the page we asked for.
      const changed = !!sigNow && sigNow !== walk.sigBefore;
      const landed = walk.expect === null || pg.cur === null || pg.cur === walk.expect;
      if (changed && landed) { walk.moving = false; walk.back++; walk.stable = 0; walk.lastSig = sigNow; return; }
      if (Date.now() - walk.clickedAt > 8000) {
        let l = walk.clicks < 3 ? walk.lastLink : null;
        if (l && !l.isConnected) {
          // Torn redrew the pager without changing the list: find the same jump again.
          const again = walk.mode === 'refine' ? pickJump(pg, walk.target, walk.lo, walk.hi, false)
            : (walk.target !== null ? pickJump(pg, walk.target, 0, pg.cur !== null ? pg.cur : Infinity, true) : null);
          l = again ? again.link : null;
        }
        if (!l) { walk.stuck = true; walk.moving = false; return; }
        walk.clicks++; walk.clickedAt = Date.now(); walk.lastLink = l;
        saveWalkState();
        l.click();
      }
      return;
    }
    // The pager can still show a last page that has almost nothing left on it (people keep leaving hospital, so the
    // list shrinks): no rows at all, or only rows whose time can't be read. After a few seconds of that, step back one page.
    if (getRows().length === 0 || shortestOnPage === null) {
      walk.empty = (walk.empty || 0) + 1;
      if (walk.empty >= 4 && walk.back < MAX_JUMPS) {
        const cur = pg.cur;
        const pick = pickJump(pg, cur !== null ? cur - 1 : null, 0, cur !== null ? cur : Infinity, true);
        if (pick) {
          walk.empty = 0;
          walk.why = '';
          walk.moving = true; walk.sigBefore = sigNow; walk.expect = pick.expect; walk.target = null; walk.mode = 'gallop';
          walk.lastLink = pick.link; walk.clicks = 1; walk.clickedAt = Date.now();
          saveWalkState();
          pick.link.click();
        }
      }
      return;
    }
    walk.empty = 0;
    if (walk.stable < 2) return; // wait until the page has finished loading
    walk.why = '';
    if (candidateCount >= MIN_RESULTS) { walk.why = MIN_RESULTS + ' matches found'; return; }
    if (shortestOnPage === null) return;
    const here = pg.cur;
    const good = shortestOnPage <= MAX_SECONDS; // does this page hold anyone within the time limit?
    if (here !== null) {
      // walk.hi = earliest page known to be good; walk.lo = latest page known to be over the limit.
      if (good) walk.hi = walk.hi === null ? here : Math.min(walk.hi, here);
      else walk.lo = Math.max(walk.lo, here);
    }
    const overMsg = 'earlier pages are all over ' + Math.round(MAX_SECONDS / 60) + ' min';
    if (!good && (here === null || walk.hi === null)) { walk.why = overMsg; return; }
    if (walk.back >= MAX_JUMPS) { walk.why = 'page limit (' + MAX_JUMPS + ' extra pages)'; return; }

    let pick = null, target = null, mode = 'gallop';
    if (here !== null && walk.lo > 0) {
      // A jump overshot into pages that are all over the limit: look in between, about halfway.
      mode = 'refine';
      const gap = walk.hi - walk.lo;
      if (gap <= 1) { walk.why = overMsg; return; }
      target = walk.lo + Math.ceil(gap / 2);
      pick = pickJump(pg, target, walk.lo, walk.hi, false);
      if (!pick) { walk.why = 'no link to the pages in between'; return; }
    } else {
      if (here !== null && here <= 1) { walk.why = 'reached the first page'; return; }
      if (here !== null) {
        target = Math.max(1, here - walk.step);
        pick = pickJump(pg, target, 0, here, true);
      } else {
        const arrow = arrowLink();
        pick = arrow ? { link: arrow, expect: null } : null;
      }
      if (!pick) { walk.why = 'no earlier page link'; return; }
      walk.step *= 2; // the next jump goes twice as far
    }
    walk.moving = true;
    walk.sigBefore = sigNow;
    walk.expect = pick.expect;
    walk.target = target;
    walk.mode = mode;
    walk.lastLink = pick.link;
    walk.clicks = 1;
    walk.clickedAt = Date.now();
    saveWalkState();
    pick.link.click();
  }

  function tick() {
    if (!scanning) { clearInterval(liveTimer); liveTimer = null; return; }
    if (!walk) return;

    // If the pager still isn't on the last page after a few seconds, click the last-page link again.
    const pg = pageInfo();
    if (!walk.reachedLast && pg.cur !== null && pg.max !== null && pg.cur < pg.max && jumpRetries < 3 && Date.now() - liveStart > 5000 * (jumpRetries + 1)) {
      jumpRetries++;
      const l = findLastPageLink();
      if (l) l.click();
    }

    collect(); // refreshes the page diagnostics and highlights

    // Has the list stopped changing (page fully loaded), and are we on the last page yet?
    const sigNow = listSignature();
    if (sigNow && sigNow === walk.lastSig) walk.stable++; else { walk.stable = 0; walk.lastSig = sigNow; }
    if (!walk.reachedLast) {
      if (pg.cur !== null && pg.max !== null) walk.reachedLast = pg.cur >= pg.max;
      else if (shortestOnPage !== null && (shortestOnPage <= MAX_SECONDS || (pg.max === null && Date.now() - liveStart > 6000))) walk.reachedLast = true;
    }

    const onPage = collectTargets();
    onPage.forEach((t) => { if (!kept.has(t.id)) kept.set(t.id, t); });
    let found = [...kept.values()].filter((t) => !excluded(cache[t.id]));
    if (USE_LEVEL_LIMIT && myLevel !== null) found = found.filter((t) => t.lvl === null || (t.lvl <= limitLevel() && t.lvl >= minLevel()));
    candidateCount = found.length;
    diag += ' · saved: ' + kept.size + (USE_LEVEL_LIMIT ? ' · levels ' + minLevel() + '–' + limitLevel() + ': ' + found.length : '');
    stepWalk(pg, sigNow); // may open the previous page if there are still too few matches
    diag += walkDiag();
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
      updateCount();
    }
  }

  function startLive(resume) {
    scanning = true;
    ensureKey();
    panel.style.display = 'block';
    panel.textContent = 'Scanning…';
    lastSig = null;
    kept.clear();
    jumpRetries = 0;
    if (!resume) { try { sessionStorage.removeItem(WALK_KEY); } catch (e) {} } // a fresh search never inherits an old one
    walk = { reachedLast: false, back: 0, moving: false, stuck: false, stable: 0, lastSig: '', sigBefore: '', expect: null, clicks: 0, clickedAt: 0, why: '', lo: 0, hi: null, step: 1, target: null, mode: '', lastLink: null };
    if (resume) {
      // Torn reloaded the page when we stepped back: carry on with everything found so far.
      resume.kept.forEach((t) => kept.set(t.id, t));
      walk.back = resume.back;
      walk.lo = resume.lo || 0;
      walk.hi = typeof resume.hi === 'number' ? resume.hi : null;
      walk.step = resume.step || 1;
      walk.reachedLast = true;
    }
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
    scanning = true;
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

  btn.addEventListener('click', safe(() => {
    if (!onHospital) {
      sessionStorage.setItem(FLAG, '1');
      location.href = HOSPITAL_URL;
      return;
    }
    return jumpAndScan();
  }));

  // Arriving from the Find Target / Rescan button (flag set) always starts a fresh search; arriving without it
  // right after stepping back a page means Torn reloaded the page, so carry on where we were.
  try {
    const freshStart = onHospital && !!sessionStorage.getItem(FLAG);
    const resumed = onHospital && !freshStart ? takeWalkState() : null;
    if (resumed) {
      startLive(resumed);
    } else if (freshStart) {
      sessionStorage.removeItem(FLAG);
      jumpAndScan().catch((e) => reportError(e && e.message));
    }
  } catch (err) { reportError(err && err.message); }

  } catch (err) { reportError(err && err.message); }
})();
