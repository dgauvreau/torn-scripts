// ==UserScript==
// @name         Torn Find Target (loader)
// @namespace    torn-hospital-targets-loader
// @version      1.1
// @description  Paste this into Torn PDA once. It fetches the latest Torn Find Target script from GitHub on every page load, so updates never need re-pasting.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_URL = 'https://raw.githubusercontent.com/dgauvreau/torn-scripts/main/torn-hospital-finder.user.js';
  const CACHE_SLOT = 'ht_loader_cache'; // last good copy, used if GitHub can't be reached

  // Torn PDA replaces this placeholder with your API key in THIS script only, so hand it to the
  // real script through localStorage (that script reads 'ht_api_key' when it has no key of its own).
  const PDA_KEY = '###PDA-APIKEY###';
  if (PDA_KEY && !PDA_KEY.startsWith('###')) {
    try { localStorage.setItem('ht_api_key', PDA_KEY); } catch (e) {}
  }

  function note(msg) {
    try {
      const d = document.createElement('div');
      d.textContent = 'Find Target loader: ' + msg;
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:4px 8px;' +
        'background:#7a1f1f;color:#fff;font:11px sans-serif;text-align:center;';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => d.remove(), 8000);
    } catch (e) {}
  }

  function run(code) {
    try {
      (0, eval)(code); // indirect eval: runs in the page's global scope
      return true;
    } catch (e1) {
      try {
        const s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        return true;
      } catch (e2) {
        note("couldn't run the script (" + (e1 && e1.message) + ')');
        return false;
      }
    }
  }

  // Torn's CSP blocks fetch() to GitHub from the page, so use the app's own HTTP bridge instead:
  // Torn PDA -> PDA_httpGet, Tampermonkey -> GM_xmlhttpRequest, last resort -> plain fetch.
  function getText(url) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof PDA_httpGet === 'function') {
          PDA_httpGet(url).then((r) => {
            const t = r && (r.responseText != null ? r.responseText : r);
            if (r && r.status && r.status >= 400) reject(new Error('HTTP ' + r.status));
            else resolve(String(t));
          }, reject);
          return;
        }
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET', url,
            onload: (r) => (r.status >= 400 ? reject(new Error('HTTP ' + r.status)) : resolve(r.responseText)),
            onerror: () => reject(new Error('network error')),
          });
          return;
        }
      } catch (e) { /* fall through to fetch */ }
      fetch(url, { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(resolve, reject);
    });
  }

  getText(SCRIPT_URL + '?t=' + Date.now())
    .then((code) => {
      if (!/==UserScript==/.test(code)) throw new Error('unexpected file');
      if (run(code)) {
        try { localStorage.setItem(CACHE_SLOT, code); } catch (e) {}
      }
    })
    .catch((err) => {
      let cached = null;
      try { cached = localStorage.getItem(CACHE_SLOT); } catch (e) {}
      if (cached) {
        note('offline (' + err.message + '), using the last saved copy');
        run(cached);
      } else {
        note("couldn't load the script (" + err.message + ')');
      }
    });
})();
