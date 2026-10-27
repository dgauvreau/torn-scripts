// ==UserScript==
// @name         Torn Find Target
// @namespace    torn-hospital-targets
// @version      6.27
// @description  Target icon in the header linking to your targets list (with the live chain countdown shown on that page), plus a "Find Target" entry in the navigation menu. Scans the end of the hospital list for people at or below your level with no faction and almost out of hospital, and shows profile details (via the official Torn API).
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
  // The "Find Target" entry in Torn's navigation menu (added below) triggers it.
  const btn = document.createElement('button');

  const panel = document.createElement('div');
  panel.style.cssText =
    'display:none;position:relative;box-sizing:border-box;width:100%;margin:6px 0;' +
    'background:#1a1a1a;color:#ccc;font:12px sans-serif;padding:8px;' +
    'border:1px solid #444;border-radius:6px;';

  let scanning = false;
  function showIdle() {
    panel.textContent = '';
    panel.style.display = 'block';
    const head = document.createElement('div');
    const t = document.createElement('b');
    t.textContent = '\ud83c\udfaf Find Target';
    head.appendChild(t);
    head.appendChild(smallBtn('Scan', () => btn.click()));
    panel.appendChild(head);
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
      else { parent = document.querySelector('#mainContainer, .content-wrapper'); }
    }
    if (!parent) return;
    if (panel.parentNode !== parent || (before && panel.nextSibling !== before)) parent.insertBefore(panel, before);
    if (!scanning && panel.style.display === 'none') showIdle();
  }
  ensureUI();
  document.addEventListener('DOMContentLoaded', ensureUI);
  window.addEventListener('load', ensureUI);
  setInterval(ensureUI, 2000);

  // ---- navigation menu entry (every page) ------------------------------------
  // Torn's menu is a list of rows, each an <a> holding an icon and a label (class names carry a
  // random suffix, so match on the stable prefixes). We copy an ordinary row, e.g. "Home", relabel
  // it, and put it right after the "Items" entry of the same list, so it picks up the menu's own look on phone and desktop.
  const ENTRY_ATTR = 'data-find-target-entry';
  const ENTRY_LABEL = 'Find Target';
  function findMenu() {
    const names = ['Home', 'Items', 'City', 'Gym', 'Crimes'];
    const spans = Array.prototype.slice.call(document.querySelectorAll('[class*="linkName"]'));
    for (let i = 0; i < names.length; i++) {
      const span = spans.find((x) => x.textContent.trim() === names[i]);
      const a = span && span.closest('a');
      if (!a || !a.parentElement || !a.parentElement.parentElement || !a.parentElement.parentElement.parentElement) continue;
      const row = a.parentElement;               // the row holding the <a>
      const area = row.parentElement;            // one menu item
      const container = area.parentElement;      // the whole list
      if (area.querySelectorAll('a').length !== 1) continue; // want a plain entry, not an expandable group
      // Where our entry goes: right after the "Items" entry (falls back to the end of the list).
      const itemsSpan = spans.find((x) => x.textContent.trim() === 'Items');
      const itemsRow = itemsSpan && itemsSpan.closest('a') && itemsSpan.closest('a').parentElement;
      const itemsArea = itemsRow && itemsRow.parentElement;
      const anchor = itemsArea && itemsArea.parentElement === container ? itemsArea : null;
      return { anchor, area, container };
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
    if (iconBox) {
      iconBox.textContent = '';
      const ic = document.createElement('span');
      ic.style.cssText = 'font-size:13px;line-height:14px;display:inline-block;';
      ic.textContent = '\ud83c\udfaf';
      iconBox.appendChild(ic);
    }
    clone.querySelector('[class*="linkName"]').textContent = ENTRY_LABEL;
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); btn.click(); }, true);
    if (m.anchor) m.container.insertBefore(clone, m.anchor.nextSibling); // right after Items
    else m.container.appendChild(clone);
  }
  // The menu is rebuilt by Torn at times (page changes, opening the hamburger), so keep checking.
  ensureEntry();
  document.addEventListener('DOMContentLoaded', ensureEntry);
  window.addEventListener('load', ensureEntry);
  setInterval(ensureEntry, 1500);

  // ---- targets-list shortcut (global header, every page) -------------------
  // A small target icon in the header row that opens your Torn targets list.
  const TARGETS_URL = 'https://www.torn.com/page.php?sid=list&type=targets';
  const linkIcon = document.createElement('a');
  linkIcon.href = TARGETS_URL;
  linkIcon.title = 'My targets';
  linkIcon.setAttribute('aria-label', 'My targets');
  linkIcon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'style="pointer-events:none;display:block"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/>' +
    '<circle cx="12" cy="12" r="1"/></svg>';

  // Phone layout: sits in the header row just left of the magnifying glass.
  const LINK_TOP_PX = 2;        // distance from the top of the page
  const LINK_CENTER_PCT = 44;   // horizontal centre, as a % of screen width
  const LINK_BASE =
    'z-index:2147483646;margin:0;padding:0;width:30px;height:30px;display:flex;align-items:center;' +
    'justify-content:center;background:transparent;border:0;color:#aeaeae;cursor:pointer;text-decoration:none;';
  // The header can be pushed down by banners other scripts add at the top of the page (shop counter,
  // retribution list), so measure where it actually is instead of assuming it starts at the top.
  function phoneStyle() {
    const h = document.querySelector('#header-root') || document.querySelector('.header-wrapper-top');
    let top = LINK_TOP_PX, pos = 'absolute';
    if (h) {
      const r = h.getBoundingClientRect();
      let fixed = false;
      for (let e = h; e && e !== document.documentElement; e = e.parentElement) {
        if (getComputedStyle(e).position === 'fixed') { fixed = true; break; }
      }
      pos = fixed ? 'fixed' : 'absolute';
      top = Math.round(r.top + (fixed ? 0 : window.scrollY)) + LINK_TOP_PX;
    }
    return 'position:' + pos + ';top:' + top + 'px;left:calc(' + LINK_CENTER_PCT + '% - 15px);' + LINK_BASE;
  }

  // Desktop layout: just right of the avatar at the end of the header toolbar.
  function linkStyle() {
    const av = document.querySelector('ul.toolbar li.avatar');
    if (!av) return phoneStyle();
    const r = av.getBoundingClientRect();
    if (!r.width || r.right + 4 + 30 > window.innerWidth - 4) return phoneStyle();
    let fixed = false;
    for (let e = av; e && e !== document.documentElement; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') { fixed = true; break; }
    }
    const top = Math.round(r.top + (r.height - 30) / 2) + (fixed ? 0 : window.scrollY);
    const left = Math.round(r.right + 4) + (fixed ? 0 : window.scrollX);
    return 'position:' + (fixed ? 'fixed' : 'absolute') + ';top:' + top + 'px;left:' + left + 'px;' + LINK_BASE;
  }

  function ensureLink() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (linkIcon.parentNode !== host) host.appendChild(linkIcon);
    const st = linkStyle();
    if (linkIcon.dataset.st !== st) { linkIcon.style.cssText = st; linkIcon.dataset.st = st; }
  }
  ensureLink();
  document.addEventListener('DOMContentLoaded', ensureLink);
  window.addEventListener('load', ensureLink);
  window.addEventListener('resize', ensureLink);
  setInterval(ensureLink, 2000);

  // ---- chain timer on the targets page -------------------------------------
  // Copies the countdown from Torn's own sidebar chain bar onto the targets list page, so you can see
  // how long the chain has left while picking targets. Reads the page only: no API calls.
  const CHAIN_WARN_SECONDS = 60; // the timer turns red below this
  const chainBox = document.createElement('div');
  chainBox.setAttribute('data-chain-timer', '1');
  chainBox.style.cssText =
    'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:2147483646;padding:6px 12px;' +
    'border-radius:14px;background:#1a1a1a;border:1px solid #555;font:bold 14px sans-serif;color:#fff;' +
    'white-space:nowrap;pointer-events:none;';
  function onTargetsPage() {
    return location.pathname.includes('page.php') && /[?&]sid=list/.test(location.search) && /[?&]type=targets/.test(location.search);
  }
  // { secs, value } from the sidebar chain bar, or null when there is no running chain.
  function readChain() {
    const bar = document.querySelector('[class*="chain-bar"]');
    if (!bar) return null;
    const tEl = bar.querySelector('[class*="bar-timeleft"]');
    const tm = ((tEl ? tEl.textContent : bar.textContent) || '').match(/\d+:\d+(?::\d+)?/);
    const secs = tm ? parseSeconds(tm[0]) : null;
    if (secs === null || secs <= 0) return null;
    const vEl = bar.querySelector('[class*="bar-value"]');
    const vm = ((vEl ? vEl.textContent : bar.textContent) || '').match(/\d+\s*\/\s*\d+/);
    return { secs, value: vm ? vm[0].replace(/\s+/g, '') : '' };
  }
  function ensureChain() {
    if (!onTargetsPage()) { if (chainBox.parentNode) chainBox.remove(); return; }
    const host = document.body || document.documentElement;
    if (!host) return;
    if (chainBox.parentNode !== host) host.appendChild(chainBox);
    const c = readChain();
    if (!c) { chainBox.textContent = 'Chain: none'; chainBox.style.color = '#999'; return; }
    const p2 = (n) => String(n).padStart(2, '0');
    chainBox.textContent = 'Chain ' + (c.value ? c.value + ' · ' : '') + Math.floor(c.secs / 60) + ':' + p2(c.secs % 60);
    chainBox.style.color = c.secs < CHAIN_WARN_SECONDS ? '#ff5b5b' : '#fff';
  }
  ensureChain();
  document.addEventListener('DOMContentLoaded', ensureChain);
  window.addEventListener('load', ensureChain);
  setInterval(ensureChain, 1000);

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
    scanning = false;
    clearInterval(liveTimer); liveTimer = null;
    getRows().forEach((r) => { r.style.outline = ''; });
    showIdle();
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
    head.appendChild(smallBtn('Stop', closePanel));
    panel.appendChild(head);

    if (USE_LEVEL_LIMIT && myLevel !== null) {
      // One slider with two handles: left = lowest level, right = highest level.
      const lo = 1, hi = sliderMax();
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:4px;color:#aaa;';
      const lab = document.createElement('div');
      const box = document.createElement('div');
      box.style.cssText = 'position:relative;height:22px;margin:2px 6px 0;';
      const track = document.createElement('div');
      track.style.cssText = 'position:absolute;left:0;right:0;top:9px;height:4px;background:#444;border-radius:2px;';
      const fill = document.createElement('div');
      fill.style.cssText = 'position:absolute;top:9px;height:4px;background:#7cf;border-radius:2px;';
      const sty = document.createElement('style');
      sty.textContent =
        '.ht-r{-webkit-appearance:none;appearance:none;background:transparent;position:absolute;left:0;top:0;width:100%;height:22px;margin:0;pointer-events:none;}' +
        '.ht-r::-webkit-slider-runnable-track{background:transparent;}.ht-r::-moz-range-track{background:transparent;}' +
        '.ht-r::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:16px;height:16px;border-radius:50%;background:#bbb;border:1px solid #666;}' +
        '.ht-r::-moz-range-thumb{pointer-events:auto;width:14px;height:14px;border-radius:50%;background:#bbb;border:1px solid #666;}';
      const mk = (val) => {
        const el = document.createElement('input');
        el.type = 'range'; el.className = 'ht-r'; el.min = lo; el.max = hi; el.step = 1; el.value = val;
        return el;
      };
      const sMin = mk(minLevel()), sMax = mk(limitLevel());
      const upd = () => {
        const a2 = +sMin.value, b2 = +sMax.value;
        const span = Math.max(1, hi - lo);
        fill.style.left = ((a2 - lo) / span * 100) + '%';
        fill.style.width = ((b2 - a2) / span * 100) + '%';
        lab.textContent = 'Level ' + a2 + ' to ' + b2 + ' (you: ' + myLevel + ')';
      };
      const keep = (changed) => {
        if (+sMin.value > +sMax.value) { if (changed === sMin) sMin.value = sMax.value; else sMax.value = sMin.value; }
        upd();
      };
      sMin.addEventListener('input', () => keep(sMin));
      sMax.addEventListener('input', () => keep(sMax));
      const commit = () => {
        try { localStorage.setItem('ht_min_level', sMin.value); localStorage.setItem('ht_max_level', sMax.value); } catch (e) {}
        lastSig = null; tick();
      };
      sMin.addEventListener('change', commit);
      sMax.addEventListener('change', commit);
      upd();
      box.appendChild(track); box.appendChild(fill); box.appendChild(sMin); box.appendChild(sMax);
      wrap.appendChild(sty); wrap.appendChild(lab); wrap.appendChild(box);
      panel.appendChild(wrap);
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
    hdr.innerHTML = th('Name', 'left') + th('Lvl', 'right') + th('Health', 'right') + th('Faction', 'center') + th('', 'center');
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

      const tdAtk = document.createElement('td');
      tdAtk.style.cssText = 'padding:5px 4px;text-align:center;white-space:nowrap;';
      const atk = document.createElement('a');
      atk.href = 'https://www.torn.com/loader.php?sid=attack&user2ID=' + t.id;
      atk.target = '_blank';
      atk.textContent = '⚔ ATTACK';
      atk.style.cssText =
        'padding:1px 6px;background:#7a1f1f;color:#fff;border:1px solid #b44;' +
        'border-radius:3px;font-weight:bold;font-size:10px;text-decoration:none;';
      tdAtk.appendChild(atk);

      tr.appendChild(tdName);
      tr.appendChild(tdLvl);
      tr.appendChild(tdLife);
      tr.appendChild(tdFac);
      tr.appendChild(tdAtk);
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
    if (!scanning) { clearInterval(liveTimer); liveTimer = null; return; }

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
    scanning = true;
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
