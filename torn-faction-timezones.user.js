// ==UserScript==
// @name         Torn Faction Time Zones
// @namespace    torn-faction-timezones
// @version      2.8
// @description  On the forums, adds a "Time Zones" button. It reads your faction's time zone thread through the official API (forum > posts, any key works), works out each poster's time zone from what they wrote, and draws a map: members per UTC offset with day/night shading, a 24-hour TCT coverage strip (how many are awake each hour), and the member list grouped by zone. Tap a name's pencil to fix a zone by hand.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

;(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes
  if (!/\/forums\.php/i.test(location.pathname)) return;

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

  // The thread's own format: "When 00:00 happens in Torn it is 5pm/17:00 for me" (the local time at Torn midnight).
  // That time IS the offset from UTC (17:00 -> UTC-7). With "summer ... winter" answers, the one that applies now is used.
  function parseClock(text) {
    const lead = /\b(?:torn|tct)\b[^.\n]{0,40}?(?:\b(?:it is|it's|its|is)|=|[a-z]:)\s*(?=\d)|\b(?:midnight|00(?::00)?(?![\d:])|24:00(?!\d)|12\s*am)\b[^.\n]{0,40}?(?:\b(?:it is|it's|its|is|i am|i'm|am)|=)\s*(?=\d)/i.exec(text);
    let start = -1;
    if (lead) start = lead.index + lead[0].length;
    else {
      // looser: a mention of Torn time / midnight, then a clock time shortly after it
      const loose = /\b(?:torn|tct|midnight|reset)\b|(?:^|[^\d:])(?:00(?::00)?|24:00)(?![\d:])/i.exec(text);
      if (loose) {
        const after = text.slice(loose.index + loose[0].length, loose.index + loose[0].length + 90);
        const after2 = after.replace(/(^|[^\d:\/])(?:00:00|24:00|0:00|00)(?![\d:])/g, (mm, g1) => g1 + ' '.repeat(mm.length - g1.length));
        const t = /(?:^|[^\d:\/])(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d{2}|\d{1,2}\s*(?:h|hrs?|hours?|o'?clock))(?![\d\/:])/i.exec(after2);
        if (t) start = loose.index + loose[0].length + (after.indexOf(t[1], Math.max(0, t.index - 1)) >= 0 ? after.indexOf(t[1], Math.max(0, t.index - 1)) : t.index);
      }
    }
    if (start < 0) return null;
    const rest = text.slice(start, start + 220);
    const tre = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s*h(?:rs?|ours?)?\b)?/gi;
    const times = [];
    let x;
    while ((x = tre.exec(rest)) && times.length < 6) {
      let h = +x[1]; const mi = +(x[2] || 0); const ap = (x[3] || '').toLowerCase().replace(/\./g, '');
      if (h > 24 || mi > 59) continue;
      if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
      times.push({ idx: x.index, end: x.index + x[0].length, mins: h * 60 + mi });
    }
    if (!times.length) return null;
    const seasons = [];
    const sre = /\b(summer|winter|dst|daylight|standard)\b/gi;
    while ((x = sre.exec(rest))) seasons.push({ idx: x.index, summer: /summer|dst|daylight/i.test(x[1]) });
    let pick = times[0];
    if (seasons.length > 1) {
      const seasonOf = (t) => { const sx = seasons.find((q) => q.idx >= t.end && q.idx - t.end < 45); return sx ? sx.summer : null; };
      const sumT = times.find((t) => seasonOf(t) === true), winT = times.find((t) => seasonOf(t) === false);
      if (sumT && winT) {
        const so = sumT.mins > 14 * 60 ? sumT.mins - 1440 : sumT.mins;   // the summer offset, in minutes
        const d = new Date(), y = d.getUTCFullYear(), nowMs = d.getTime();
        const sunday = (yy, mo, n) => { const f = new Date(Date.UTC(yy, mo, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + (n - 1) * 7; };   // n-th Sunday of month
        const lastSunday = (yy, mo) => { const last = new Date(Date.UTC(yy, mo + 1, 0)); return last.getUTCDate() - last.getUTCDay(); };
        let summerNow;
        if (so <= -180 && so >= -600) summerNow = nowMs >= Date.UTC(y, 2, sunday(y, 2, 2), 10) && nowMs < Date.UTC(y, 10, sunday(y, 10, 1), 6);   // US/Canada
        else if (so >= 0 && so <= 180) summerNow = nowMs >= Date.UTC(y, 2, lastSunday(y, 2), 1) && nowMs < Date.UTC(y, 9, lastSunday(y, 9), 1); // Europe
        else if (so >= 480 && so <= 780) { const mo = d.getUTCMonth(); summerNow = mo >= 9 || mo <= 2; }                                      // Australia / NZ
        else { const mo = d.getUTCMonth(); summerNow = mo >= 3 && mo <= 9; }
        pick = summerNow ? sumT : winT;
      }
    }
    let off = pick.mins === 1440 ? 0 : pick.mins;
    if (off > 14 * 60) off -= 1440;
    const sign = off < 0 ? '-' : '+', a = Math.abs(off);
    return { fixed: off, label: 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''), snippet: text.slice(Math.max(0, start - 45), start + 60).replace(/\s+/g, ' ').trim() };
  }

  // Last resort: "it's 2pm for me" with no mention of Torn at all means the same thing (the local time when Torn is at 00:00).
  function weakClock(text) {
    const m = /\b(?:it(?:'s| is)|its)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\s+(?:for me|here|my time|local)/i.exec(text);
    if (!m) return null;
    let h = +(m[1] || m[4]); const mi = +(m[2] || m[5] || 0); const ap = (m[3] || m[6]).toLowerCase().replace(/\./g, '');
    if (h > 12 || h < 1 || mi > 59) return null;
    if (ap === 'pm' && h < 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
    let off = h * 60 + mi;
    if (off > 14 * 60) off -= 1440;
    const sign = off < 0 ? '-' : '+', a = Math.abs(off);
    return { fixed: off, label: 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''), snippet: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() };
  }

  // Best reading of a piece of text: the first time zone it mentions (earliest wins).
  function parseZone(text) {
    if (!text) return null;
    const clock = parseClock(text);
    if (clock) return clock;
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
    if (!hits.length) return weakClock(text);
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
  let panelOpen = false;
  let problem = null;   // { code, message }
  let busy = false, progressN = 0;
  let overrides = {};
  try { overrides = JSON.parse(readSlot(OVERRIDE_SLOT) || '{}') || {}; } catch (e) { overrides = {}; }
  try { const c = JSON.parse(readSlot(CACHE_SLOT) || 'null'); if (c && c.members) data = c; } catch (e) { data = null; }
  let tid = readSlot(THREAD_SLOT);

  // Faction forum threads are not served by the API (it answers "Incorrect ID"), so read the posts shown on the page instead.
  // Each page you open adds its posters to what is already known for this thread.
  function scrapePage(base) {
    const members = (base && base.members) || {};
    const units = [];   // { id, name, box }
    const XID = 'a[href*="profiles.php?XID="]';
    const idOf = (a) => { const m = /XID=(\d+)/.exec(a.getAttribute('href') || ''); return m ? m[1] : ''; };
    // Method 1: every post carries a "Posted on ..." / "Thread created on ..." line. Find those, take the post block around each.
    const MARK = /(?:Posted on|Thread created on)\s+\d/g;
    const allLinks = Array.prototype.slice.call(document.querySelectorAll(XID));
    const walker = document.createTreeWalker(document.body, 4, null);
    let node;
    while ((node = walker.nextNode())) {
      if (!/^\s*(?:Posted on|Thread created on)\s+\d/.test(node.nodeValue || '')) continue;
      let box = node.parentElement;
      while (box.parentElement && box.parentElement !== document.body) {
        const up = box.parentElement;
        const marks = (up.textContent || '').match(MARK);
        if (marks && marks.length > 1) break;
        box = up;
      }
      let link = box.querySelector(XID);
      if (!link) {
        for (let i = allLinks.length - 1; i >= 0; i--) {
          if (allLinks[i].compareDocumentPosition(node) & 4) { link = allLinks[i]; break; } // link comes before the marker
        }
      }
      if (link && idOf(link)) units.push({ id: idOf(link), name: ((/^\s*view profile\s*$/i.test(link.textContent || '') ? '' : (link.textContent || '')).trim()) || ((link.querySelector('img') || {}).alt || link.getAttribute('title') || '').trim() || '', box: box, link: link });
    }
    // Method 2 (only if method 1 found nothing): climb from each poster link.
    if (!units.length) {
      allLinks.forEach((a) => {
        const id = idOf(a);
        if (!id) return;
        let box = a.parentElement, best = null;
        for (let i = 0; i < 8 && box && box !== document.body; i++) {
          const ids = {};
          Array.prototype.forEach.call(box.querySelectorAll(XID), (x) => { ids[idOf(x)] = 1; });
          if (Object.keys(ids).length > 1) break;
          if ((box.textContent || '').trim().length > 80) best = box;
          box = box.parentElement;
        }
        if (best && !units.some((u) => u.box === best)) units.push({ id: id, name: (a.textContent || '').trim(), box: best });
      });
    }
    let found = 0;
    units.forEach((u) => {
      const clone = u.box.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('blockquote, [class*="quote"], [class*="Quote"], script, style'), (n) => n.remove());
      const text = (clone.textContent || '').replace(/ /g, ' ');
      const full = (u.box.textContent || '').replace(/ /g, ' ');
      let nm = u.name;
      const generic = (t) => !t || /^\s*view profile\s*$/i.test(t);
      if (generic(nm)) {
        Array.prototype.some.call(u.box.querySelectorAll(XID), (x) => { if (idOf(x) === u.id && !generic(x.textContent.trim())) { nm = x.textContent.trim(); return true; } return false; });
      }
      if (generic(nm)) { const im = u.box.querySelector('img[alt]:not([alt=""])'); if (im && !generic(im.alt)) nm = im.alt.trim(); }
      const e = members[u.id] || (members[u.id] = { id: u.id, name: nm || u.id, zone: null, posts: 0 });
      if (!generic(nm) && (generic(e.name) || e.name === u.id)) e.name = nm;
      e.posts++; found++;
      const z = parseZone(text) || parseZone(full);
      if (z) e.zone = z;
      else e.sample = full.replace(/\s+/g, ' ').trim().slice(0, 90);
    });
    return { tid: tid, ts: Math.floor(Date.now() / 1000), postCount: (base ? base.postCount || 0 : 0) + found, capped: false, scraped: true, members: members };
  }


  async function refresh() {
    if (busy) return;
    if (!getKey() && !askKey()) { problem = { code: 'nokey' }; render(); return; }
    if (!tid) { problem = { code: 'nothread' }; render(); return; }
    busy = true; progressN = 0; problem = null; render();
    try {
      data = await loadThread(tid, (n) => { progressN = n; render(); });
      writeSlot(CACHE_SLOT, JSON.stringify(data));
    } catch (err) {
      if (err.code === 6) {
        try {
          const base = data && data.tid === tid && data.scraped ? data : null;
          data = scrapePage(base);
          if (!data.postCount) { data = null; problem = { code: 'noposts' }; }
          else writeSlot(CACHE_SLOT, JSON.stringify(data));
        } catch (e2) { problem = { code: 'scrape', message: String(e2 && e2.message || e2) }; }
      } else problem = { code: err.code, message: err.message };
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

  // ---- world map -----------------------------------------------------------
  const LAND = [
    [[-168,66],[-140,70],[-95,72],[-80,63],[-62,58],[-55,50],[-67,44],[-76,35],[-81,25],[-97,26],[-105,20],[-95,16],[-83,9],[-80,8],[-87,14],[-105,22],[-115,30],[-124,40],[-125,49],[-135,58],[-150,60],[-165,60]],
    [[-55,60],[-45,60],[-20,70],[-20,82],[-60,82],[-72,76]],
    [[-80,8],[-60,10],[-50,0],[-35,-5],[-40,-22],[-58,-38],[-68,-55],[-74,-50],[-72,-30],[-80,-5]],
    [[-10,36],[-9,43],[0,50],[5,58],[10,64],[25,71],[40,68],[40,45],[28,41],[20,38],[12,38],[3,43]],
    [[-17,21],[-10,35],[10,37],[32,31],[43,12],[51,11],[40,-15],[33,-27],[20,-35],[12,-17],[9,4],[-8,4],[-17,14]],
    [[28,41],[40,45],[40,68],[70,73],[110,77],[170,70],[180,65],[160,55],[140,45],[130,35],[122,30],[120,22],[108,10],[100,3],[98,15],[90,22],[80,8],[72,20],[58,24],[50,28],[44,12],[35,30],[28,36]],
    [[114,-22],[130,-12],[142,-11],[153,-27],[146,-39],[135,-35],[115,-34]],
    [[-6,50],[1,51],[-2,58],[-6,57]]
  ];
  // A typical inhabited latitude for a longitude, so the bubble sits on land.
  function landLat(lon) {
    if (lon < -30) return lon < -100 ? 40 : (lon < -65 ? 35 : -15);
    if (lon < 40) return lon < 20 ? 48 : 20;
    if (lon < 90) return 30;
    if (lon < 135) return 30;
    if (lon < 160) return -28;
    return -38;
  }
  function worldMap(known) {
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (t, a) => { const n = document.createElementNS(NS, t); Object.keys(a || {}).forEach((k) => n.setAttribute(k, a[k])); return n; };
    const groups = {};
    known.forEach((m) => { (groups[m.off] = groups[m.off] || []).push(m); });
    const offs = Object.keys(groups).map(Number).sort((x, y) => x - y);
    const n = Math.max(1, offs.length), colW = 360 / n;
    const fs = Math.max(3.6, Math.min(6.6, colW / 6.4));          // name size shrinks when there are many zones
    const maxChars = Math.max(4, Math.floor(colW / (fs * 0.62)));
    const rowH = fs + 2.6;
    let most = 1; offs.forEach((o) => { most = Math.max(most, groups[o].length); });
    const H = 198 + most * rowH + 4;
    const svg = mk('svg', { viewBox: '0 0 360 ' + H, width: '100%' });
    svg.style.cssText = 'display:block;width:100%;height:auto;background:#10202e;border-radius:6px;margin:6px 0;';
    for (let o = -12; o <= 14; o++) svg.appendChild(mk('line', { x1: o * 15 + 180, y1: 0, x2: o * 15 + 180, y2: 180, stroke: '#2a3f52', 'stroke-width': 0.4 }));
    LAND.forEach((poly) => svg.appendChild(mk('polygon', { points: poly.map((q) => (q[0] + 180) + ',' + (90 - q[1])).join(' '), fill: '#2e4a3a', stroke: '#4a6b57', 'stroke-width': 0.5 })));
    offs.forEach((off, i) => {
      const lon = Math.max(-180, Math.min(180, off / 60 * 15));
      const x = lon + 180, y = 90 - landLat(lon), cx = colW * i + colW / 2;
      svg.appendChild(mk('line', { x1: x, y1: y, x2: cx, y2: 187, stroke: '#f5b942', 'stroke-width': 0.5, 'stroke-opacity': 0.7 }));
      svg.appendChild(mk('circle', { cx: x, cy: y, r: 2.6, fill: '#f5b942', stroke: '#fff', 'stroke-width': 0.6 }));
      const t0 = mk('text', { x: cx, y: 186, 'text-anchor': 'middle', 'font-size': Math.min(6, fs), fill: '#7a9bb5' });
      t0.textContent = 'UTC' + (off > 0 ? '+' : off < 0 ? '−' : '') + (Math.abs(off) % 60 ? (off / 60).toFixed(1) : Math.abs(off) / 60);
      svg.appendChild(t0);
      groups[off].slice().sort((p, q) => (p.name.toLowerCase() < q.name.toLowerCase() ? -1 : 1)).forEach((m, j) => {
        const t = mk('text', { x: cx, y: 198 + j * rowH, 'text-anchor': 'middle', 'font-size': fs, 'font-weight': 'bold', fill: '#ffe9b0' });
        t.textContent = m.name.length > maxChars ? m.name.slice(0, maxChars - 1) + '…' : m.name;
        svg.appendChild(t);
      });
    });
    return svg;
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
    if (problem && (problem.code === 'noposts' || problem.code === 'scrape')) { sheet.appendChild(el('div', 'color:#f88;', problem.code === 'noposts' ? 'No posts found on this page. Scroll to the posts, then tap Time Zones again.' : 'Could not read the page: ' + problem.message)); return; }
    if (problem && problem.code === 6) {
      let h = '';
      try { h = (location.hash || location.search || '').slice(0, 120); } catch (e) { h = ''; }
      sheet.appendChild(setupBlock('Torn says thread number "' + tid + '" isn\u2019t valid. Page address part: ' + (h || '(none)'), 'Enter the thread number', pickThread));
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
    const panel = document.createElement('details');
    panel.style.cssText = 'margin-top:8px;';
    if (panelOpen) panel.open = true;
    panel.addEventListener('toggle', () => { panelOpen = panel.open; });
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;color:#9cf;font-weight:bold;padding:6px 0;';
    sum.textContent = 'Members and the posts behind them (' + all.length + (unknown.length ? ', ' + unknown.length + ' with no zone' : '') + ')';
    panel.appendChild(sum);

    if (known.length) {
      sheet.appendChild(el('div', 'color:#fff;', known.length + ' members placed on the map'));
      sheet.appendChild(worldMap(known));

      // grouped list, west to east
      const groups = {};
      known.forEach((m) => { (groups[m.off] = groups[m.off] || []).push(m); });
      Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((off, i) => {
        const g = groups[off];
        const row = el('div', 'margin-top:6px;padding-top:6px;border-top:1px solid #444;');
        const labs = {};
        g.forEach((m) => { labs[m.zone.label] = 1; });
        row.appendChild(el('div', 'color:#fff;font-weight:bold;', offLabel(off) + ' \u00b7 ' + g.length + ' (' + Object.keys(labs).slice(0, 3).join(', ') + ')'));
        const names = el('div');
        g.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1).forEach((m) => names.appendChild(nameChip(m, now)));
        row.appendChild(names);
        g.forEach((m) => { if (m.zone && m.zone.snippet && !m.fromEdit) row.appendChild(el('div', 'font-size:10px;color:#888;margin-top:2px;', m.name + ': \u201c' + m.zone.snippet + '\u201d \u2192 ' + m.zone.label)); });
        panel.appendChild(row);
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
      unknown.filter((m) => m.sample).slice(0, 6).forEach((m) => row.appendChild(el('div', 'font-size:10px;color:#888;margin-top:2px;', 'saw: ' + m.name + ' \u2013 ' + m.sample)));
      panel.appendChild(row);
    }

    if (panel.children.length > 1) sheet.appendChild(panel);
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
  const open = el('button', 'position:fixed;right:10px;bottom:70px;z-index:2147483646;padding:6px 12px;background:#2a2a2a;color:#ddd;border:1px solid #9d9;border-radius:14px;font:bold 12px sans-serif;cursor:pointer;', '\ud83c\udf0d Time Zones');
  open.type = 'button';
  open.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMap(); });
  function ensureButton() {
    const host = document.body || document.documentElement;
    if (host && open.parentNode !== host) host.appendChild(open);
  }
  ensureButton();
  document.addEventListener('DOMContentLoaded', ensureButton);
  window.addEventListener('load', ensureButton);
  setInterval(ensureButton, 2000);
  setInterval(() => { if (overlay.style.display === 'block' && !busy) render(); }, 30000);
})();
