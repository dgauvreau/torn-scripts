// ==UserScript==
// @name         Torn Halloween Basket
// @namespace    torn-halloween-basket
// @version      1.0
// @description  During the Halloween season, adds a "Halloween Basket" entry to Torn's navigation menu (right after Items). Tap it to jump to your basket on the Items page: it scrolls to the basket, highlights it and opens its options so "Use" is one tap away. No API key needed.
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

  // ---- menu entry --------------------------------------------------------
  // Torn's menu is a list of rows, each an <a> holding an icon and a label (class names carry a
  // random suffix, so match on the stable prefixes). We copy an ordinary row, e.g. "Home", relabel
  // it, and put it right after the "Items" entry of the same list, so it picks up the menu's own look
  // on phone and desktop.
  const ENTRY_ATTR = 'data-halloween-basket-entry';
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
    a.setAttribute('href', ITEMS_URL);
    a.removeAttribute('target');
    a.removeAttribute('aria-current');
    const iconBox = clone.querySelector('[class*="defaultIcon"]') || clone.querySelector('[class*="svgIconWrap"]');
    if (iconBox) {
      iconBox.textContent = '';
      const ic = document.createElement('span');
      ic.style.cssText = 'font-size:13px;line-height:14px;display:inline-block;';
      ic.textContent = '🎃';
      iconBox.appendChild(ic);
    }
    clone.querySelector('[class*="linkName"]').textContent = ENTRY_LABEL;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (onItems) {
        try { location.hash = '#special-items'; } catch (x) {}
        openBasket();
      } else {
        try { sessionStorage.setItem(FLAG, '1'); } catch (x) {}
        location.href = ITEMS_URL;
      }
    }, true);
    if (m.anchor) m.container.insertBefore(clone, m.anchor.nextSibling); // right after Items
    else m.container.appendChild(clone);
  }
  // The menu is rebuilt by Torn at times (page changes, opening the hamburger), so keep checking.
  ensureEntry();
  document.addEventListener('DOMContentLoaded', ensureEntry);
  window.addEventListener('load', ensureEntry);
  setInterval(ensureEntry, 1500);

  // Arrived from another page via the menu entry: open the basket now.
  let flagged = false;
  try { flagged = onItems && sessionStorage.getItem(FLAG) === '1'; sessionStorage.removeItem(FLAG); } catch (e) { flagged = false; }
  if (flagged) openBasket();
})();
