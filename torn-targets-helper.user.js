// ==UserScript==
// @name         Torn Targets Helper
// @namespace    torn-targets-helper
// @version      1.1
// @description  Target icon in the header that opens your targets list, plus a live chain countdown shown on the targets list page (via the official Torn API).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- API key -----------------------------------------------------------
  // Torn PDA replaces the placeholder below with your own key.
  // On other setups the key saved by the Find Target loader (localStorage) is used.
  let API_KEY = '###PDA-APIKEY###';
  if (!API_KEY || API_KEY.startsWith('###')) {
    try { API_KEY = localStorage.getItem('ht_api_key') || ''; } catch (e) { API_KEY = ''; }
  }

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
  // Shows how long your chain has left while you pick targets. On the phone layout Torn only shows the
  // chain time in a tap-tooltip, so the time comes from the API (user bars, chain part): one lookup every
  // CHAIN_POLL_MS, with the countdown ticking locally in between.
  const CHAIN_WARN_SECONDS = 60; // the timer turns red below this
  const CHAIN_POLL_MS = 6000;    // how often the API is asked
  const CHAIN_TOUCH_MS = 4000;   // a tap refreshes right away if the last lookup is older than this
  let chainDeadline = null;      // when the chain runs out (ms since 1970); null = no running chain
  let chainValue = '';           // e.g. "159/250"
  let chainState = 'loading';    // loading | ok | error
  let chainLastFetch = 0, chainFetching = false;
  const chainBox = document.createElement('div');
  chainBox.setAttribute('data-chain-timer', '1');
  chainBox.style.cssText =
    'position:fixed;bottom:14px;left:10px;z-index:2147483646;padding:6px 12px;' +
    'border-radius:14px;background:#1a1a1a;border:1px solid #555;font:bold 14px sans-serif;color:#fff;' +
    'white-space:nowrap;pointer-events:none;';
  function onTargetsPage() {
    return location.pathname.includes('page.php') && /[?&]sid=list/.test(location.search) && /[?&]type=targets/.test(location.search);
  }
  async function fetchChain() {
    if (chainFetching || !API_KEY) return;
    chainFetching = true;
    chainLastFetch = Date.now();
    try {
      // The API serves identical requests from a 30 second cache, so a changing `timestamp` makes each lookup fresh.
      const r = await fetch('https://api.torn.com/user/?selections=bars&key=' + API_KEY + '&timestamp=' + Math.floor(Date.now() / 1000));
      const j = await r.json();
      const c = j && !j.error && (j.chain || (j.bars && j.bars.chain));
      if (!c) {
        chainState = 'error';
      } else {
        let left = +c.timeout || 0;
        if (!left && c.end) left = (+c.end) - Date.now() / 1000;
        chainDeadline = left > 0 ? Date.now() + left * 1000 : null;
        chainValue = chainDeadline && +c.current > 0 ? c.current + (+c.max > 0 ? '/' + c.max : '') : '';
        chainState = 'ok';
      }
    } catch (e) {
      chainState = 'error';
    }
    chainFetching = false;
  }
  function ensureChain() {
    if (!onTargetsPage()) { if (chainBox.parentNode) chainBox.remove(); return; }
    const host = document.body || document.documentElement;
    if (!host) return;
    if (chainBox.parentNode !== host) host.appendChild(chainBox);
    if (API_KEY && !chainFetching && Date.now() - chainLastFetch >= CHAIN_POLL_MS) fetchChain();
    const left = chainDeadline === null ? 0 : Math.ceil((chainDeadline - Date.now()) / 1000);
    let text, color = '#fff';
    if (!API_KEY) { text = 'Chain: no API key'; color = '#fc6'; }
    else if (left > 0) {
      const p2 = (n) => String(n).padStart(2, '0');
      text = 'Chain ' + (chainValue ? chainValue + ' · ' : '') + Math.floor(left / 60) + ':' + p2(left % 60);
      if (left < CHAIN_WARN_SECONDS) color = '#ff5b5b';
    }
    else if (chainState === 'loading') { text = 'Chain: …'; color = '#999'; }
    else if (chainState === 'error') { text = 'Chain: API error'; color = '#fc6'; }
    else { text = 'Chain: none'; color = '#999'; }
    if (chainBox.textContent !== text) chainBox.textContent = text;
    chainBox.style.color = color;
  }
  ensureChain();
  document.addEventListener('DOMContentLoaded', ensureChain);
  window.addEventListener('load', ensureChain);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { chainLastFetch = 0; ensureChain(); } });
  // Looking at the page again is when an out-of-date timer matters (e.g. someone just extended the chain), so a
  // tap or scroll asks for fresh data on the next tick.
  document.addEventListener('touchstart', () => { if (Date.now() - chainLastFetch > CHAIN_TOUCH_MS) chainLastFetch = 0; }, { passive: true });
  setInterval(ensureChain, 1000);
})();
