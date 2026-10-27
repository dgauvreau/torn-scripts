// ==UserScript==
// @name         Torn Halloween Basket
// @namespace    torn-halloween-basket
// @version      1.1
// @description  During the Halloween season, adds a pumpkin icon to Torn's top icon row. Tap it to jump to your basket on the Items page: it scrolls to the basket, highlights it and opens its options so "Use" is one tap away. No API key needed.
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
  const WAIT_MS = 10000;           // how long to wait for the item list to load
  const ENTRY_LABEL = 'Halloween Basket';

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
  function findBasket() {
    return Array.prototype.slice.call(document.querySelectorAll('li[data-sort]')).find(
      (l) => BASKET_RE.test(l.getAttribute('data-sort') || '') && l.offsetParent !== null
    );
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
    if (!li) {
      showToast('No Halloween Basket found in your items.', sweetShopHref(), sweetShopHref() ? 'Get one at the Sweet Shop' : '');
      opening = false;
      return;
    }
    li.scrollIntoView({ block: 'center' });
    li.style.outline = '2px solid #f80';
    // Open the item's options (where "Use" lives) unless they're already open. Nothing is used for you.
    if (!/\bopened\b/.test(li.className)) {
      const opt = li.querySelector('.item-options');
      if (opt) opt.click();
    }
    opening = false;
  }

  // ---- header icon -------------------------------------------------------
  // A pumpkin in Torn's top icon row. On a phone it sits in the header row between the menu button and the
  // search icon; on a wide screen it sits just past the avatar at the end of the toolbar.
  const icon = document.createElement('a');
  icon.href = ITEMS_URL;
  icon.title = ENTRY_LABEL;
  icon.setAttribute('aria-label', ENTRY_LABEL);
  icon.textContent = '\ud83c\udf83';
  const ICON_TOP_PX = 2;         // distance below the top of the header (phone layout)
  const ICON_CENTER_PCT = 34.5;  // horizontal centre, as a % of screen width (phone layout)
  const DESKTOP_GAP_PX = 38;     // distance past the avatar (wide layout), leaving room for other header icons
  const ICON_BASE =
    'z-index:2147483646;margin:0;padding:0;width:30px;height:30px;display:flex;align-items:center;' +
    'justify-content:center;background:transparent;border:0;font-size:20px;line-height:1;cursor:pointer;text-decoration:none;';
  function isFixed(el) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (getComputedStyle(e).position === 'fixed') return true;
    }
    return false;
  }
  // Banners other scripts add can push the header down, so measure where it actually is.
  function phoneStyle() {
    const h = document.querySelector('#header-root') || document.querySelector('.header-wrapper-top');
    let top = ICON_TOP_PX, pos = 'absolute';
    if (h) {
      const r = h.getBoundingClientRect();
      const fixed = isFixed(h);
      pos = fixed ? 'fixed' : 'absolute';
      top = Math.round(r.top + (fixed ? 0 : window.scrollY)) + ICON_TOP_PX;
    }
    return 'position:' + pos + ';top:' + top + 'px;left:calc(' + ICON_CENTER_PCT + '% - 15px);' + ICON_BASE;
  }
  function iconStyle() {
    const av = document.querySelector('ul.toolbar li.avatar');
    if (!av) return phoneStyle();
    const r = av.getBoundingClientRect();
    if (!r.width || r.right + DESKTOP_GAP_PX + 30 > window.innerWidth - 4) return phoneStyle();
    const fixed = isFixed(av);
    const top = Math.round(r.top + (r.height - 30) / 2) + (fixed ? 0 : window.scrollY);
    const left = Math.round(r.right + DESKTOP_GAP_PX) + (fixed ? 0 : window.scrollX);
    return 'position:' + (fixed ? 'fixed' : 'absolute') + ';top:' + top + 'px;left:' + left + 'px;' + ICON_BASE;
  }
  function ensureIcon() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (icon.parentNode !== host) host.appendChild(icon);
    const st = iconStyle();
    if (icon.dataset.st !== st) { icon.style.cssText = st; icon.dataset.st = st; }
  }
  icon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onItems) {
      try { location.hash = '#special-items'; } catch (x) {}
      openBasket();
    } else {
      try { sessionStorage.setItem(FLAG, '1'); } catch (x) {}
      location.href = ITEMS_URL;
    }
  });
  ensureIcon();
  document.addEventListener('DOMContentLoaded', ensureIcon);
  window.addEventListener('load', ensureIcon);
  window.addEventListener('resize', ensureIcon);
  setInterval(ensureIcon, 2000);

  // Arrived from another page via the icon: open the basket now.
  let flagged = false;
  try { flagged = onItems && sessionStorage.getItem(FLAG) === '1'; sessionStorage.removeItem(FLAG); } catch (e) { flagged = false; }
  if (flagged) openBasket();
})();
