// ==UserScript==
// @name         Torn Faction Time Zones
// @namespace    torn-faction-timezones
// @version      1.5
// @description  On the forums, adds a "Time Zones" button. It reads your faction's time zone thread through the official API (forum > posts, any key works), works out each poster's time zone from what they wrote, and draws a map: members per UTC offset with day/night shading, a 24-hour TCT coverage strip (how many are awake each hour), and the member list grouped by zone. Tap a name's pencil to fix a zone by hand.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const TZ_VERSION = '1.5';
  // Safety net: if anything goes wrong while the script starts, say so on screen instead of failing silently.
  function tzNote(text, bad) {
    try {
      const d = document.createElement('div');
      d.textContent = text;
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:4px 8px;font:11px sans-serif;text-align:center;color:#fff;pointer-events:none;background:' + (bad ? '#7a1f1f' : '#1f5f2f') + ';';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => d.remove(), bad ? 20000 : 6000);
    } catch (e) {}
  }
  try {
  (function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes
  // Not gated on the address at load time: Torn can reach the forums without a full page load, so the
  // button checks the address on every tick instead (see ensureButton).
  const onForums = () => /\/forums\.php/i.test(location.pathname);
  tzNote('Time Zones ' + TZ_VERSION + ' running on ' + location.pathname + (location.hash ? ' (+hash)' : ''), false);

  // ---- settings ----------------------------------------------------------
  const MAX_PAGES = 60;            // most API pages read per refresh
  const PAGE_GAP_MS = 400;         // pause between pages (the API allows 100 calls a minute)
  const CACHE_MAX_AGE_S = 600;     // reopen the map from the saved copy if it is younger than this
  const AWAKE_FROM = 8;            // a member counts as awake from this local hour...
  const AWAKE_TO = 23;             // ...until this local hour
  const THREAD_SLOT = 'tz_thread';
  const CACHE_SLOT = 'tz_cache';
  const OVERRIDE_SLOT = 'tz_over';
  const OWN_SLOT = 'tz_key';

  // ---- API key -----------------------------------------------------------
  // Any key works (forum posts are public). Uses a key saved here, else the Torn PDA key. It never reads
  // another script's saved key.
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = (PDA_KEY && !PDA_KEY.startsWith('###')) ? PDA_KEY : '';
  const readSlot = (s) => { try { return localStorage.getItem(s) || ''; } catch (e) { return ''; } };
  const writeSlot = (s, v) => { try { localStorage.setItem(s, v); } catch (e) {} };
  let ownKey = readSlot(OWN_SLOT);
  const getKey = () => ownKey || pdaKey;
  function askKey() {
    const k = prompt('Torn API key for the time zone map (any key works):');
    if (k && k.trim()) { ownKey = k.trim(); writeSlot(OWN_SLOT, ownKey); return true; }
    return false;
  }

  // ---- time zone reading -------------------------------------------------
  //<parser>
  // Each rule: [pattern, IANA zone or fixed minutes from UTC, label]. Zones given as IANA names follow daylight
  // saving automatically, so "EST" written in July still lands on today's New York offset.
  const ABBR = [
    [/\b(?:ET|EST|EDT)\b/, 'America/New_York', 'Eastern'],
    [/\b(?:CT|CST|CDT)\b/, 'America/Chicago', 'Central'],
    [/\b(?:MT|MST|MDT)\b/, 'America/Denver', 'Mountain'],
    [/\b(?:PT|PST|PDT)\b/, 'America/Los_Angeles', 'Pacific'],
    [/\b(?:AKST|AKDT)\b/, 'America/Anchorage', 'Alaska'],
    [/\bHST\b/, 'Pacific/Honolulu', 'Hawaii'],
    [/\b(?:AST|ADT)\b/, 'America/Halifax', 'Atlantic'],
    [/\bNST\b/, 'America/St_Johns', 'Newfoundland'],
    [/\bBST\b/, 'Europe/London', 'UK'],
    [/\b(?:CET|CEST)\b/, 'Europe/Paris', 'Central Europe'],
    [/\b(?:EET|EEST)\b/, 'Europe/Athens', 'Eastern Europe'],
    [/\b(?:WET|WEST)\b/, 'Europe/Lisbon', 'Western Europe'],
    [/\bMSK\b/, 'Europe/Moscow', 'Moscow'],
    [/\b(?:AEST|AEDT)\b/, 'Australia/Sydney', 'Eastern Australia'],
    [/\b(?:ACST|ACDT)\b/, 'Australia/Adelaide', 'Central Australia'],
    [/\bAWST\b/, 'Australia/Perth', 'Western Australia'],
    [/\b(?:NZST|NZDT)\b/, 'Pacific/Auckland', 'New Zealand'],
    [/\bIST\b/, 330, 'India'],
    [/\b(?:JST|KST)\b/, 540, 'Japan/Korea'],
    [/\b(?:HKT|SGT|PHT)\b/, 480, 'Hong Kong/Singapore'],
    [/\bPKT\b/, 300, 'Pakistan'],
    [/\b(?:WIB|ICT)\b/, 420, 'Indochina'],
    [/\bSAST\b/, 120, 'South Africa'],
    [/\bWAT\b/, 60, 'West Africa'],
    [/\bCAT\b/, 120, 'Central Africa'],
    [/\bEAT\b/, 180, 'East Africa'],
    [/\b(?:UTC|GMT|TCT)\b/, 0, 'UTC'],
  ];
  // Words and places (matched without caring about capitals).
  const PLACES = [
    [/\b(?:eastern|new york|nyc|florida|boston|miami|atlanta|toronto|montreal|ontario|quebec|new jersey|ohio|michigan|virginia|carolina|pennsylvania|maryland)\b/i, 'America/New_York'],
    [/\b(?:central time|chicago|texas|houston|dallas|illinois|wisconsin|minnesota|missouri|tennessee|louisiana|oklahoma|winnipeg|mexico city)\b/i, 'America/Chicago'],
    [/\b(?:mountain time|denver|colorado|utah|calgary|edmonton|alberta)\b/i, 'America/Denver'],
    [/\b(?:arizona|phoenix)\b/i, 'America/Phoenix'],
    [/\b(?:pacific time|california|los angeles|seattle|portland|oregon|washington state|vancouver|san francisco|las vegas)\b/i, 'America/Los_Angeles'],
    [/\b(?:sao paulo|brazil|brasil|rio)\b/i, 'America/Sao_Paulo'],
    [/\b(?:buenos aires|argentina)\b/i, 'America/Argentina/Buenos_Aires'],
    [/\b(?:london|england|scotland|wales|britain|great britain|manchester)\b|\bUK\b/i, 'Europe/London'],
    [/\b(?:ireland|dublin)\b/i, 'Europe/Dublin'],
    [/\b(?:portugal|lisbon)\b/i, 'Europe/Lisbon'],
    [/\b(?:paris|france|germany|berlin|spain|madrid|italy|rome|amsterdam|netherlands|holland|belgium|brussels|sweden|stockholm|norway|oslo|denmark|copenhagen|poland|warsaw|vienna|austria|switzerland|zurich|prague|budapest|croatia|serbia)\b/i, 'Europe/Paris'],
    [/\b(?:athens|greece|helsinki|finland|kyiv|kiev|ukraine|romania|bucharest|bulgaria|sofia|lithuania|latvia|estonia|israel|tel aviv|cairo|egypt)\b/i, 'Europe/Athens'],
    [/\b(?:istanbul|turkey|saudi|riyadh|nairobi|kenya|qatar|kuwait|iraq|baghdad)\b/i, 'Europe/Istanbul'],
    [/\b(?:moscow|russia)\b/i, 'Europe/Moscow'],
    [/\b(?:dubai|uae|emirates|abu dhabi|oman)\b/i, 'Asia/Dubai'],
    [/\b(?:india|mumbai|delhi|bangalore|chennai|kolkata|sri lanka)\b/i, 'Asia/Kolkata'],
    [/\b(?:pakistan|karachi|lahore)\b/i, 'Asia/Karachi'],
    [/\b(?:bangladesh|dhaka)\b/i, 'Asia/Dhaka'],
    [/\b(?:bangkok|thailand|vietnam|hanoi|saigon|jakarta|indonesia)\b/i, 'Asia/Bangkok'],
    [/\b(?:singapore|malaysia|kuala lumpur|hong kong|china|beijing|shanghai|taiwan|taipei|manila|philippines)\b/i, 'Asia/Singapore'],
    [/\b(?:tokyo|japan|osaka|seoul|korea)\b/i, 'Asia/Tokyo'],
    [/\b(?:sydney|melbourne|canberra|brisbane|australia)\b/i, 'Australia/Sydney'],
    [/\b(?:adelaide)\b/i, 'Australia/Adelaide'],
    [/\b(?:perth)\b/i, 'Australia/Perth'],
    [/\b(?:new zealand|auckland|wellington|nz)\b/i, 'Pacific/Auckland'],
    [/\b(?:south africa|johannesburg|cape town|lagos|nigeria|ghana|accra)\b/i, 'Africa/Johannesburg'],
  ];
  const OFFSET_RE = /\b(?:UTC|GMT|TCT)\s*([+\-\u2212])\s*(\d{1,2})(?::?(\d{2}))?(?!\d)/i;

  // Best reading of a piece of text: the first time zone it mentions (earliest wins).
  function parseZone(text) {
    if (!text) return null;
    const hits = [];
    const m = OFFSET_RE.exec(text);
    if (m) {
      const mins = (+m[2]) * 60 + (+(m[3] || 0));
      const sign = m[1] === '+' ? 1 : -1;
      if (mins <= 14 * 60) hits.push({ idx: m.index, fixed: sign * mins, label: m[0].replace(/\s+/g, '').toUpperCase() });
    }
    ABBR.forEach((r) => {
      const x = r[0].exec(text);
      if (x && !(m && x.index >= m.index && x.index < m.index + m[0].length)) {
        hits.push(typeof r[1] === 'number' ? { idx: x.index, fixed: r[1], label: x[0] } : { idx: x.index, tz: r[1], label: x[0] });
      }
    });
    PLACES.forEach((r) => {
      const x = r[0].exec(text);
      if (x) hits.push({ idx: x.index, tz: r[1], label: x[0] });
    });
    if (!hits.length) return null;
    hits.sort((a, b) => a.idx - b.idx);
    const h = hits[0];
    const out = { label: h.label, snippet: text.slice(Math.max(0, h.idx - 30), h.idx + 45).replace(/\s+/g, ' ').trim() };
    if (h.tz) out.tz = h.tz; else out.fixed = h.fixed;
    return out;
  }

  const offsetCache = {};
  // Minutes ahead of UTC for an IANA zone right now (follows daylight saving).
  function tzOffset(tz, now) {
    const key = tz + '|' + Math.floor(now / 3600000);
    if (offsetCache[key] !== undefined) return offsetCache[key];
    let v = 0;
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      const p = {};
      f.formatToParts(new Date(now)).forEach((x) => { p[x.type] = x.value; });
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
      v = Math.round((asUtc - Math.floor(now / 1000) * 1000) / 60000);
    } catch (e) { v = 0; }
    offsetCache[key] = v;
    return v;
  }
  const zoneOffset = (z, now) => (z.tz ? tzOffset(z.tz, now) : z.fixed);

  // Text of a post without quoted replies (so quoting someone else's zone doesn't count).
  function cleanText(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      doc.querySelectorAll('blockquote, [class*="quote"], br').forEach((n) => {
        if (n.tagName === 'BR') n.replaceWith(' '); else n.remove();
      });
      return (doc.body.textContent || '').replace(/\u00a0/g, ' ');
    } catch (e) { return String(html || '').replace(/<[^>]*>/g, ' '); }
  }
  //</parser>

  // ---- API ---------------------------------------------------------------
  async function api(path, params) {
    const q = new URLSearchParams(Object.assign({}, params, { key: getKey(), comment: 'TornFactionTimeZones' }));
    const r = await fetch('https://api.torn.com/v2/' + path + '?' + q.toString());
    const j = await r.json();
    if (j && j.error) { const err = new Error(j.error.error || 'API error'); err.code = j.error.code; throw err; }
    return j;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function threadFromText(t) {
    const m = /[?&#]t=(\d+)/.exec(t) || /^\s*(\d{4,})\s*$/.exec(t);
    return m ? m[1] : '';
  }
  function threadIdHere() { return threadFromText(location.href); }

  // Read the whole thread (oldest first) and work out one entry per poster.
  async function loadThread(tid, progress) {
    const seen = new Map();
    let offset = 0, capped = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await api('forum/' + tid + '/posts', { offset: offset, striptags: 'false', timestamp: Math.floor(Date.now() / 1000) });
      const rows = Array.isArray(j.posts) ? j.posts : [];
      if (!rows.length) break;
      let added = 0;
      rows.forEach((p) => { const k = String(p.id); if (!seen.has(k)) { seen.set(k, p); added++; } });
      progress(seen.size);
      if (!added) break;
      offset += rows.length;
      if (page === MAX_PAGES - 1) capped = true;
      await sleep(PAGE_GAP_MS);
    }
    const posts = Array.from(seen.values()).sort((a, b) => (+a.created_time || 0) - (+b.created_time || 0));
    const members = {};
    posts.forEach((p) => {
      const a = p.author;
      if (!a || !a.id) return;
      const id = String(a.id);
      const e = members[id] || (members[id] = { id: id, name: a.username || id, zone: null, posts: 0 });
      e.name = a.username || e.name;
      e.posts++;
      const z = parseZone(cleanText(p.content));
      if (z) e.zone = z; // a later post with a zone replaces an earlier one
    });
    return { tid: tid, ts: Math.floor(Date.now() / 1000), postCount: posts.length, capped: capped, members: members };
  }

  // ---- state -------------------------------------------------------------
  let data = null;      // { tid, ts, postCount, capped, members }
  let problem = null;   // { code, message }
  let busy = false, progressN = 0;
  let overrides = {};
  try { overrides = JSON.parse(readSlot(OVERRIDE_SLOT) || '{}') || {}; } catch (e) { overrides = {}; }
  try { const c = JSON.parse(readSlot(CACHE_SLOT) || 'null'); if (c && c.members) data = c; } catch (e) { data = null; }
  let tid = readSlot(THREAD_SLOT);

  async function refresh() {
    if (busy) return;
    if (!getKey() && !askKey()) { problem = { code: 'nokey' }; render(); return; }
    if (!tid) { problem = { code: 'nothread' }; render(); return; }
    busy = true; progressN = 0; problem = null; render();
    try {
      data = await loadThread(tid, (n) => { progressN = n; render(); });
      writeSlot(CACHE_SLOT, JSON.stringify(data));
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busy = false;
    render();
  }

  // ---- overlay -----------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.6);overflow:auto;-webkit-overflow-scrolling:touch;';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'margin:40px auto;padding:10px 12px;background:#1a1a1a;color:#ccc;width:94%;max-width:520px;box-sizing:border-box;border:1px solid #777;border-radius:8px;font:13px sans-serif;line-height:1.5;';
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMap(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMap(); });

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, onclick, title) {
    const b = el('button', 'margin:0 0 0 6px;padding:3px 10px;background:#333;color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;', text);
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', (e) => { e.stopPropagation(); onclick(b); });
    return b;
  }
  const p2 = (n) => String(n).padStart(2, '0');
  function offLabel(min) {
    const s = min < 0 ? '\u2212' : '+';
    const a = Math.abs(min);
    return 'UTC' + s + Math.floor(a / 60) + (a % 60 ? ':' + p2(a % 60) : '');
  }
  function clockAt(now, min) {
    const d = new Date(now + min * 60000);
    const h = d.getUTCHours();
    return (h % 12 || 12) + ':' + p2(d.getUTCMinutes()) + (h < 12 ? ' am' : ' pm');
  }
  const localHourFrac = (now, min) => (((Math.floor(now / 60000) + min) % 1440) + 1440) % 1440 / 60;
  const isAwake = (hf) => hf >= AWAKE_FROM && hf < AWAKE_TO;

  function editZone(m) {
    const t = prompt('Time zone for ' + m.name + ' (for example UTC+2, EST, London). Leave empty to clear:', '');
    if (t === null) return;
    if (!t.trim()) { delete overrides[m.id]; } else {
      if (!parseZone(t)) { alert("Couldn't read a time zone from that. Try UTC+2, EST, or a city."); return; }
      overrides[m.id] = t.trim();
    }
    writeSlot(OVERRIDE_SLOT, JSON.stringify(overrides));
    render();
  }

  function nameChip(m, now) {
    const w = el('span', 'display:inline-block;margin:2px 8px 2px 0;white-space:nowrap;');
    const a = el('a', 'color:#7cf;text-decoration:none;', m.name);
    a.href = 'https://www.torn.com/profiles.php?XID=' + m.id; a.target = '_blank';
    const pen = el('span', 'cursor:pointer;color:#888;padding:0 3px;', '\u270e');
    pen.title = 'Set time zone by hand';
    pen.addEventListener('click', (e) => { e.stopPropagation(); editZone(m); });
    w.appendChild(a); w.appendChild(pen);
    if (m.fromEdit) w.appendChild(el('span', 'color:#fc6;font-size:10px;', '\u2605'));
    return w;
  }

  // Final zone for each member (a hand-set zone beats the thread).
  function resolved(now) {
    const out = [];
    Object.keys(data.members).forEach((id) => {
      const m = Object.assign({}, data.members[id]);
      if (overrides[id]) { const z = parseZone(overrides[id]); if (z) { m.zone = z; m.fromEdit = true; } }
      m.off = m.zone ? zoneOffset(m.zone, now) : null;
      out.push(m);
    });
    return out;
  }

  // Strip 1: one column per UTC hour, bar height = members, dark column = night there right now.
  function bandStrip(known, now) {
    const counts = {};
    known.forEach((m) => { const k = Math.round(m.off / 60); counts[k] = (counts[k] || 0) + 1; });
    const max = Math.max.apply(null, Object.keys(counts).map((k) => counts[k]).concat([1]));
    const wrap = el('div', 'display:flex;align-items:flex-end;height:96px;border:1px solid #444;border-radius:6px;overflow:hidden;background:#111;');
    for (let h = -12; h <= 14; h++) {
      const c = counts[h] || 0;
      const awake = isAwake(localHourFrac(now, h * 60));
      const col = el('div', 'flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;background:' + (awake ? 'rgba(255,214,102,.10)' : 'rgba(40,60,110,.35)') + ';border-left:1px solid rgba(255,255,255,.05);');
      if (c) {
        col.appendChild(el('div', 'font-size:10px;color:#fff;', String(c)));
        col.appendChild(el('div', 'width:80%;background:' + (awake ? '#e0b030' : '#4d79c7') + ';height:' + Math.max(4, Math.round(60 * c / max)) + 'px;border-radius:2px 2px 0 0;'));
      }
      col.title = offLabel(h * 60) + ' \u00b7 ' + clockAt(now, h * 60) + ' \u00b7 ' + c + ' member' + (c === 1 ? '' : 's');
      wrap.appendChild(col);
    }
    const labels = el('div', 'display:flex;font-size:9px;color:#888;margin-top:2px;');
    for (let h = -12; h <= 14; h++) labels.appendChild(el('div', 'flex:1;min-width:0;text-align:center;', h % 3 === 0 ? (h > 0 ? '+' + h : h < 0 ? '\u2212' + Math.abs(h) : '0') : ''));
    const box = el('div', 'margin:8px 0;');
    box.appendChild(wrap); box.appendChild(labels);
    return box;
  }

  // Strip 2: for each hour of the TCT day, how many members are awake.
  function coverageStrip(known, now) {
    const per = [];
    for (let h = 0; h < 24; h++) per.push(known.filter((m) => isAwake((((h * 60 + m.off) % 1440) + 1440) % 1440 / 60)).length);
    const max = Math.max.apply(null, per.concat([1]));
    const nowH = new Date(now).getUTCHours();
    const wrap = el('div', 'display:flex;align-items:flex-end;height:70px;border:1px solid #444;border-radius:6px;overflow:hidden;background:#111;');
    per.forEach((c, h) => {
      const col = el('div', 'flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;' + (h === nowH ? 'background:rgba(153,221,153,.18);' : ''));
      col.appendChild(el('div', 'font-size:9px;color:#ddd;', String(c)));
      col.appendChild(el('div', 'width:75%;background:' + (c === Math.min.apply(null, per) ? '#c0504d' : '#6aa86a') + ';height:' + Math.max(2, Math.round(42 * c / max)) + 'px;border-radius:2px 2px 0 0;'));
      col.title = p2(h) + ':00 TCT \u00b7 ' + c + ' awake';
      wrap.appendChild(col);
    });
    const labels = el('div', 'display:flex;font-size:9px;color:#888;margin-top:2px;');
    for (let h = 0; h < 24; h++) labels.appendChild(el('div', 'flex:1;min-width:0;text-align:center;', h % 3 === 0 ? p2(h) : ''));
    const box = el('div', 'margin:8px 0;');
    box.appendChild(wrap); box.appendChild(labels);
    return { box: box, per: per };
  }

  function setupBlock(msg, actionText, action) {
    const box = el('div', 'text-align:center;padding:8px 0;');
    box.appendChild(el('div', '', msg));
    box.appendChild(btn(actionText, action));
    return box;
  }
  function pickThread() {
    const here = threadIdHere();
    const t = prompt('Paste the link (or number) of your faction time zone thread:', here || tid || '');
    if (t === null) return;
    const id = threadFromText(t);
    if (!id) { alert("Couldn't find a thread number in that. The link should contain t=1234567."); return; }
    tid = id; writeSlot(THREAD_SLOT, tid);
    data = null; problem = null;
    refresh();
  }

  function render() {
    if (overlay.style.display !== 'block') return;
    sheet.textContent = '';
    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;');
    head.appendChild(el('b', 'font-size:14px;color:#fff;', '\ud83c\udf0d Faction time zones'));
    const x = el('span', 'padding:0 6px;font-size:20px;cursor:pointer;color:#aaa;', '\u00d7');
    x.addEventListener('click', closeMap);
    head.appendChild(x);
    sheet.appendChild(head);

    if (problem && problem.code === 'nothread') { sheet.appendChild(setupBlock('Which thread holds everyone\u2019s time zone?', 'Pick the thread', pickThread)); return; }
    if (problem && problem.code === 'nokey') { sheet.appendChild(setupBlock('This map needs an API key (any key works).', 'Enter key', () => { if (askKey()) { problem = null; refresh(); } })); return; }
    if (problem && problem.code === 6) {
      let h = '';
      try { h = (location.hash || location.search || '').slice(0, 120); } catch (e) { h = ''; }
      sheet.appendChild(setupBlock('Torn says thread number "' + tid + '" isn’t valid. Page address part: ' + (h || '(none)'), 'Enter the thread number', pickThread));
      return;
    }
    if (problem && problem.code === 2) { sheet.appendChild(setupBlock('Torn didn\u2019t accept the key.', 'Enter a new key', () => { if (askKey()) { problem = null; refresh(); } })); return; }
    if (problem) sheet.appendChild(el('div', 'color:' + (problem.code === 5 ? '#fc6' : '#f88') + ';', problem.code === 5 ? 'Rate limited - try again in a minute.' : 'API error: ' + problem.message + (problem.code != null ? ' (code ' + problem.code + ')' : '')));

    if (busy) sheet.appendChild(el('div', 'color:#9d9;', 'Reading the thread\u2026 ' + progressN + ' posts so far'));
    if (!data) { if (!busy && !problem) sheet.appendChild(el('div', '', 'No data yet.')); return; }

    const now = Date.now();
    const all = resolved(now);
    const known = all.filter((m) => m.off !== null);
    const unknown = all.filter((m) => m.off === null).sort((a, b) => b.posts - a.posts);

    if (known.length) {
      const awake = known.filter((m) => isAwake(localHourFrac(now, m.off))).length;
      sheet.appendChild(el('div', 'color:#fff;', awake + ' of ' + known.length + ' members are probably awake right now (' + AWAKE_FROM + ':00\u2013' + AWAKE_TO + ':00 their time)'));
      sheet.appendChild(el('div', 'margin-top:6px;font-size:11px;color:#aaa;', 'Map: members by UTC offset (gold = daytime there now, blue = night)'));
      sheet.appendChild(bandStrip(known, now));
      const cov = coverageStrip(known, now);
      const quiet = []; const lo = Math.min.apply(null, cov.per);
      cov.per.forEach((c, h) => { if (c === lo) quiet.push(p2(h)); });
      sheet.appendChild(el('div', 'font-size:11px;color:#aaa;', 'Members awake per TCT hour (green outline = now)' + (quiet.length ? ' \u00b7 thinnest at ' + quiet.join(', ') + ' TCT (' + lo + ' awake)' : '')));
      sheet.appendChild(cov.box);

      // grouped list, west to east
      const groups = {};
      known.forEach((m) => { (groups[m.off] = groups[m.off] || []).push(m); });
      Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((off, i) => {
        const g = groups[off];
        const row = el('div', 'margin-top:6px;padding-top:6px;border-top:1px solid #444;');
        const labs = {};
        g.forEach((m) => { labs[m.zone.label] = 1; });
        row.appendChild(el('div', 'color:#fff;font-weight:bold;', offLabel(off) + ' \u00b7 now ' + clockAt(now, off) + ' \u00b7 ' + g.length + ' (' + Object.keys(labs).slice(0, 3).join(', ') + ')'));
        const names = el('div');
        g.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1).forEach((m) => names.appendChild(nameChip(m, now)));
        row.appendChild(names);
        sheet.appendChild(row);
      });
    } else {
      sheet.appendChild(el('div', 'margin:8px 0;', 'No time zones could be read from this thread yet.'));
    }

    if (unknown.length) {
      const row = el('div', 'margin-top:8px;padding-top:6px;border-top:1px solid #444;');
      row.appendChild(el('div', 'color:#fc6;font-weight:bold;', 'No time zone found (' + unknown.length + ') - tap \u270e to set one'));
      const names = el('div');
      unknown.forEach((m) => names.appendChild(nameChip(m, now)));
      row.appendChild(names);
      sheet.appendChild(row);
    }

    const foot = el('div', 'margin-top:10px;padding-top:6px;border-top:1px solid #444;font-size:11px;color:#888;display:flex;justify-content:space-between;align-items:center;');
    const mins = Math.max(0, Math.round((now / 1000 - data.ts) / 60));
    foot.appendChild(el('span', 'flex:1;min-width:0;', data.postCount + ' posts, thread ' + data.tid + ' \u00b7 read ' + (mins < 1 ? 'just now' : mins + 'm ago') + (data.capped ? ' \u00b7 thread longer than the page limit, newest posts not read' : '') + ' \u00b7 \u2605 = set by hand'));
    const acts = el('span', 'flex:none;white-space:nowrap;margin-left:8px;');
    acts.appendChild(btn('\ud83d\udd17', pickThread, 'Change thread'));
    acts.appendChild(btn(busy ? '\u2026' : '\ud83d\udd04', () => refresh(), 'Refresh'));
    foot.appendChild(acts);
    sheet.appendChild(foot);
  }

  function openMap() {
    // On a thread page, that thread is the one to read (and gets remembered).
    const here = threadIdHere();
    if (here && here !== tid) { tid = here; writeSlot(THREAD_SLOT, tid); if (data && data.tid !== tid) data = null; }
    (document.body || document.documentElement).appendChild(overlay);
    overlay.style.display = 'block';
    render();
    const fresh = data && data.tid === tid && Date.now() / 1000 - data.ts < CACHE_MAX_AGE_S;
    if (!fresh) refresh();
  }
  function closeMap() { overlay.style.display = 'none'; }

  // ---- button ------------------------------------------------------------
  // The button sits in the middle of the "Forums" title bar at the top of the page (found by its class, or
  // failing that by the heading whose text is just "Forums"). If no title bar can be found it floats at the
  // bottom right instead, so it is never missing.
  const BTN_BASE = 'box-sizing:border-box;padding:6px 14px;font:inherit;font-size:13px;font-weight:bold;color:#ddd;background:linear-gradient(rgba(255,255,255,.16),rgba(128,128,128,.22));border:1px solid rgba(128,128,128,.7);border-radius:7px;box-shadow:0 2px 4px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.2);cursor:pointer;white-space:nowrap;z-index:5;';
  const open = el('button', '', '\ud83c\udf0d Time Zones');
  open.type = 'button';
  open.setAttribute('data-tz-btn', '1');
  open.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMap(); });
  function findTitleBar() {
    const direct = document.querySelector('.content-title, [class*="content-title"]');
    if (direct) return direct;
    const root = document.querySelector('#mainContainer') || document.body;
    const heads = root.querySelectorAll('h1,h2,h3,h4,h5,[class*="title"],[class*="Title"]');
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (h.children.length > 3 || !/^\s*Forums\s*$/i.test(h.textContent)) continue;
      const bar = h.closest('.content-title') || h.parentElement;
      if (!bar) continue;
      const r = bar.getBoundingClientRect();
      if (r.height >= 24 && r.height <= 140) return bar;
    }
    return null;
  }
  function ensureButton() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (!onForums()) { if (open.parentNode) open.remove(); if (overlay.style.display === 'block') closeMap(); return; }
    const bar = findTitleBar();
    if (bar) {
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      const css = BTN_BASE + 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);';
      if (open.dataset.css !== css) { open.style.cssText = css; open.dataset.css = css; }
      if (open.parentNode !== bar) bar.appendChild(open);
    } else {
      const css = BTN_BASE + 'position:fixed;right:10px;bottom:70px;z-index:2147483646;';
      if (open.dataset.css !== css) { open.style.cssText = css; open.dataset.css = css; }
      if (open.parentNode !== host) host.appendChild(open);
    }
  }
  ensureButton();
  document.addEventListener('DOMContentLoaded', ensureButton);
  window.addEventListener('load', ensureButton);
  setInterval(ensureButton, 1000);
  setInterval(() => { if (overlay.style.display === 'block' && !busy) render(); }, 30000);
  // One-off report a moment after start, so a missing button can be diagnosed from a screenshot.
  setTimeout(() => { tzNote('Time Zones ' + TZ_VERSION + ': forums page ' + (onForums() ? 'yes' : 'no') + ' \u00b7 title bar ' + (findTitleBar() ? 'found' : 'not found') + ' \u00b7 button ' + (open.isConnected ? 'on page' : 'missing'), !open.isConnected && onForums()); }, 2500);
  })();
  } catch (err) { tzNote('Time Zones ' + TZ_VERSION + ' error: ' + (err && err.message), true); }
})();
