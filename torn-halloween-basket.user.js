// ==UserScript==
// @name         Torn Halloween Basket
// @namespace    torn-halloween-basket
// @version      2.0
// @description  During the Halloween season, shows an informational banner at the very top of every Torn page: a link to your basket, its level (tier name and number) and how many treats it holds. Torn only shows the treat count inside the basket on the Items page, so the numbers are read there and remembered; tap the banner to open the basket and refresh them. No API key needed.
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes

  // ---- settings ----------------------------------------------------------
  // The entry only appears during the Halloween season (Torn City Time, which is UTC):
  // from SEASON_START to SEASON_END, as [month, day] with January = 1.
  const SEASON_START = [10, 1];    // October 1
  const SEASON_END = [11, 3];      // November 3
  const ITEMS_URL = 'https://www.torn.com/item.php#special-items';
  const FLAG = 'hb_open_basket';
  const BASKET_RE = /^Halloween Basket/i;   // matches every basket tier (Spooky ... Apocalyptic)
  const WAIT_MS = 15000;           // how long to wait for the item list to load
  const ENTRY_LABEL = 'Halloween Basket';
  const SNAP_SLOT = 'hb_snapshot';   // last level / treat count read from the basket
  const TIERS = ['Spooky', 'Creepy', 'Freaky', 'Frightful', 'Haunting', 'Shocking', 'Terrifying', 'Horrifying', 'Petrifying', 'Nightmarish', 'Apocalyptic'];

  function inSeason() {
    const d = new Date();
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    return md >= SEASON_START[0] * 100 + SEASON_START[1] && md <= SEASON_END[0] * 100 + SEASON_END[1];
  }
  if (!inSeason()) return;

  const onItems = /\/item\.php/i.test(location.pathname);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- message (when the basket can't be found) ----------------------------
  const toast = document.createElement('div');
  toast.style.cssText =
    'display:none;position:fixed;left:8px;right:8px;top:70px;z-index:2147483647;padding:10px 34px 10px 12px;' +
    'background:#2b1a00;color:#ffd9a0;border:1px solid #f80;border-radius:8px;font:13px sans-serif;line-height:1.5;text-align:center;';
  const toastText = document.createElement('span');
  const toastClose = document.createElement('span');
  toastClose.textContent = '×';
  toastClose.style.cssText = 'position:absolute;right:0;top:0;padding:4px 12px;font-size:22px;cursor:pointer;';
  toastClose.addEventListener('click', () => { toast.style.display = 'none'; });
  toast.appendChild(toastText);
  toast.appendChild(toastClose);
  function showToast(text, linkHref, linkText) {
    toastText.textContent = text + ' ';
    if (linkHref) {
      const a = document.createElement('a');
      a.href = linkHref;
      a.textContent = linkText;
      a.style.cssText = 'color:#fff;text-decoration:underline;white-space:nowrap;';
      toastText.appendChild(a);
    }
    (document.body || document.documentElement).appendChild(toast);
    toast.style.display = 'block';
  }

  // The Sweet Shop link from Torn's own menu, so the message can point to it without guessing an address.
  function sweetShopHref() {
    const span = Array.prototype.slice.call(document.querySelectorAll('[class*="linkName"]')).find((x) => x.textContent.trim() === 'Sweet Shop');
    const a = span && span.closest('a');
    return a ? a.href : '';
  }

  // ---- find and open the basket on the Items page --------------------------
  const BASKET_ANY = /halloween\s+basket/i;
  function isShown(el) { return !!(el && (el.offsetParent !== null || el.getClientRects().length)); }
  function allRows() {
    return Array.prototype.slice.call(document.querySelectorAll('li[data-sort], li[data-item], ul.items-cont > li, [class*="items-cont"] li'));
  }
  function findBasket() {
    const rows = allRows();
    // 1) exact data attribute, 2) any row mentioning the basket by name (attribute, label or text)
    let hit = rows.find((l) => BASKET_RE.test(l.getAttribute('data-sort') || '') && isShown(l));
    if (!hit) {
      hit = rows.find((l) => {
        if (!isShown(l)) return false;
        const t = (l.getAttribute('data-sort') || '') + ' ' + (l.getAttribute('aria-label') || '') + ' ' +
          ((l.querySelector('[aria-label]') || {}).getAttribute ? l.querySelector('[aria-label]').getAttribute('aria-label') : '') + ' ' +
          (l.querySelector('img') ? l.querySelector('img').getAttribute('alt') || '' : '') + ' ' + (l.textContent || '').slice(0, 200);
        return BASKET_ANY.test(t);
      });
    }
    return hit;
  }
  let opening = false;
  async function openBasket() {
    if (opening) return;
    opening = true;
    let li = null;
    const t0 = Date.now();
    while (!li && Date.now() - t0 < WAIT_MS) {
      li = findBasket();
      if (!li) await sleep(250);
    }
    // Not found: only say so once the item list has really loaded, and re-check once more first.
    if (!li) {
      await sleep(1500);
      li = findBasket();
    }
    if (!li) {
      if (allRows().length > 3 && !BASKET_ANY.test((document.body && document.body.textContent) || '')) {
        showToast('No Halloween Basket found in your items.', sweetShopHref(), sweetShopHref() ? 'Get one at the Sweet Shop' : '');
      }
      opening = false;
      return;
    }
    toast.style.display = 'none';
    li.scrollIntoView({ block: 'center' });
    li.style.outline = '2px solid #f80';
    // Open the item's options (where "Use" lives) unless they're already open. Nothing is used for you.
    if (!/\bopened\b/.test(li.className)) {
      const opt = li.querySelector('.item-options, [class*="item-options"], [class*="itemOptions"]');
      if (opt) opt.click();
    }
    opening = false;
  }

  // ---- reading the basket --------------------------------------------------
  // Level comes from the basket's name ("Halloween Basket : Freaky" -> Freaky, level 3). The treat count is
  // shown inside the basket's own panel, so it is read from the opened row, falling back to the open panel.
  const TIER_RE = new RegExp('\\b(' + TIERS.join('|') + ')\\b', 'i');
  const TREAT_RES = [/(\d[\d,]*)\s+treats?\b/i, /\btreats?\b\s*[:\-–x×]?\s*(\d[\d,]*)/i];
  function readSnapshot() {
    try { const o = JSON.parse(localStorage.getItem(SNAP_SLOT) || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; }
  }
  function saveSnapshot(o) { try { localStorage.setItem(SNAP_SLOT, JSON.stringify(o)); } catch (e) {} }
  function findTreats(text) {
    for (let i = 0; i < TREAT_RES.length; i++) {
      const m = TREAT_RES[i].exec(text);
      if (m) return +m[1].replace(/,/g, '');
    }
    return null;
  }
  function scanBasket() {
    const li = findBasket();
    if (!li) return;
    const name = (li.getAttribute('data-sort') || '') + ' ' + (li.querySelector('img') ? li.querySelector('img').getAttribute('alt') || '' : '') + ' ' + (li.textContent || '').slice(0, 300);
    const tm = TIER_RE.exec(name);
    const snap = readSnapshot() || {};
    let changed = false;
    if (tm) {
      const tier = TIERS.findIndex((t) => t.toLowerCase() === tm[1].toLowerCase()) + 1;
      if (snap.tier !== tier) { snap.tier = tier; changed = true; }
    }
    // Treat count: the row itself, its info panel, then (only while the basket is open) the whole page.
    const panel = li.querySelector('.show-item-info, [class*="show-item-info"], [class*="item-info"]');
    let treats = findTreats((li.textContent || '') + ' ' + (panel ? panel.textContent || '' : ''));
    if (treats === null && /\bopened\b/.test(li.className)) treats = findTreats((document.body && document.body.textContent) || '');
    if (treats !== null && snap.treats !== treats) { snap.treats = treats; changed = true; }
    if (changed || !snap.ts) { snap.ts = Math.floor(Date.now() / 1000); saveSnapshot(snap); render(); }
    else if (tm || treats !== null) { snap.ts = Math.floor(Date.now() / 1000); saveSnapshot(snap); }
  }

  // ---- banner at the very top ------------------------------------------------
  const banner = document.createElement('a');
  banner.href = ITEMS_URL;
  banner.setAttribute('data-halloween-basket-banner', '1');
  banner.style.cssText =
    'display:block;box-sizing:border-box;margin:4px auto;padding:6px 12px;max-width:92%;background:#2b1a00;color:#ffd9a0;' +
    'border:1px solid #f80;border-radius:14px;font:bold 13px sans-serif;text-align:center;text-decoration:none;cursor:pointer;';
  banner.addEventListener('click', (e) => {
    e.preventDefault();
    if (onItems) {
      try { location.hash = '#special-items'; } catch (x) {}
      openBasket();
    } else {
      try { sessionStorage.setItem(FLAG, '1'); } catch (x) {}
      location.href = ITEMS_URL;
    }
  });
  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function render() {
    const snap = readSnapshot();
    const parts = ['🎃 ' + ENTRY_LABEL];
    if (snap && snap.tier) parts.push('Level ' + snap.tier + ' (' + TIERS[snap.tier - 1] + ')');
    if (snap && typeof snap.treats === 'number') parts.push(snap.treats.toLocaleString() + ' treat' + (snap.treats === 1 ? '' : 's'));
    let text = parts.join(' · ');
    if (!snap || (!snap.tier && typeof snap.treats !== 'number')) text += ' · tap to open it and read your level and treats';
    else {
      if (typeof snap.treats !== 'number') text += ' · treats: tap to read';
      if (snap.ts) text += ' · ' + ago(snap.ts);
    }
    if (banner.textContent !== text) banner.textContent = text;
  }
  function ensureBanner() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (banner.parentNode !== host || host.firstChild !== banner) host.insertBefore(banner, host.firstChild);
    render();
  }
  ensureBanner();
  document.addEventListener('DOMContentLoaded', ensureBanner);
  window.addEventListener('load', ensureBanner);
  setInterval(ensureBanner, 2000);
  // On the Items page, keep reading the basket as it loads and as it opens.
  if (onItems) setInterval(scanBasket, 1500);

  // Arrived from another page via the banner: open the basket now.
  let flagged = false;
  try { flagged = onItems && sessionStorage.getItem(FLAG) === '1'; sessionStorage.removeItem(FLAG); } catch (e) { flagged = false; }
  if (flagged) openBasket();
})();
