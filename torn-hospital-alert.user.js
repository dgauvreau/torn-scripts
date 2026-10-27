// ==UserScript==
// @name         Torn Hospital Alert
// @namespace    torn-hospital-alert
// @version      1.0
// @description  Warns you when your hospital release is close, so you can heal out (medical items) before the timer runs out and you're released into easy-target territory. Amber warning first, then a red flashing bar with vibration. Uses the official API (user > profile, any key works).
// @match        https://www.torn.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return; // not inside iframes

  // ---- settings ----------------------------------------------------------
  const WARN_SEC = 600;            // amber warning when this many seconds (or fewer) are left
  const URGENT_SEC = 120;          // red flashing bar when this many seconds (or fewer) are left
  const SLOW_POLL_MS = 60000;      // how often to check your status normally
  const FAST_POLL_MS = 15000;      // how often once release is within FAST_WITHIN_SEC
  const FAST_WITHIN_SEC = 1200;
  const ITEMS_URL = 'https://www.torn.com/item.php';   // where to go to use medical items

  // ---- API key -----------------------------------------------------------
  // Any key works (this only reads your own status). Uses a key saved here, else the Torn PDA key
  // (placeholder below), else the one the Find Target loader stored ('ht_api_key').
  const OWN_SLOT = 'hr_key';
  const SHARED_SLOT = 'ht_api_key';
  // Opens Torn's "add new key" form with user > profile pre-filled.
  const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=profile&title=HospitalKey';
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = (PDA_KEY && !PDA_KEY.startsWith('###')) ? PDA_KEY : '';
  function readSlot(slot) { try { return localStorage.getItem(slot) || ''; } catch (e) { return ''; } }
  let ownKey = readSlot(OWN_SLOT);
  const getKey = () => ownKey || pdaKey || readSlot(SHARED_SLOT);

  // ---- state -------------------------------------------------------------
  const nowSec = () => Math.floor(Date.now() / 1000);
  let until = 0;          // unix time you leave hospital (0 = not in hospital)
  let lastFetch = 0;      // ms
  let busy = false;
  let problem = null;     // { code, message } from the last failed check
  const dismissed = { warn: false, urgent: false };
  const notified = { warn: false, urgent: false };

  async function checkStatus() {
    if (busy) return;
    if (!getKey()) { problem = { code: 'nokey' }; render(); return; }
    busy = true; lastFetch = Date.now();
    try {
      const q = new URLSearchParams({ key: getKey(), comment: 'TornHospitalAlert', striptags: 'true' });
      const r = await fetch('https://api.torn.com/v2/user/profile?' + q.toString());
      const j = await r.json();
      if (j && j.error) { const err = new Error(j.error.error || 'API error'); err.code = j.error.code; throw err; }
      const st = j && j.profile && j.profile.status;
      until = (st && st.state === 'Hospital' && +st.until > nowSec()) ? +st.until : 0;
      problem = null;
    } catch (err) {
      problem = { code: err.code, message: err.message };
    }
    busy = false;
    render();
  }

  // ---- UI ----------------------------------------------------------------
  const bar = document.createElement('div');
  bar.style.cssText =
    'display:none;position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 36px 8px 10px;' +
    'font:bold 15px sans-serif;text-align:center;color:#fff;box-sizing:border-box;';
  const msg = document.createElement('span');
  const go = document.createElement('a');
  go.href = ITEMS_URL;
  go.textContent = 'Heal now →';
  go.style.cssText = 'margin-left:10px;padding:2px 10px;background:#fff;color:#000;border-radius:12px;text-decoration:none;font-size:13px;white-space:nowrap;';
  const close = document.createElement('span');
  close.textContent = '×';
  close.style.cssText = 'position:absolute;right:0;top:0;padding:6px 12px;font-size:22px;cursor:pointer;';
  bar.appendChild(msg);
  bar.appendChild(go);
  bar.appendChild(close);
  let level = '';
  close.addEventListener('click', (e) => { e.stopPropagation(); if (level) dismissed[level] = true; render(); });

  // A small panel that only shows when there's no usable API key.
  const setup = document.createElement('div');
  setup.style.cssText =
    'display:none;position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:8px 12px;background:#1a1a1a;color:#ddd;' +
    'border-bottom:1px solid #9d9;font:12px sans-serif;line-height:1.6;text-align:center;';
  const setupMsg = document.createElement('div');
  const setupLink = document.createElement('a');
  setupLink.href = KEY_URL;
  setupLink.textContent = '1. Create a key on Torn (pre-filled)';
  setupLink.style.cssText = 'display:inline-block;margin:4px 0;padding:3px 12px;background:#2d5a2d;color:#fff;border:1px solid #9d9;border-radius:12px;text-decoration:none;';
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = '2. Paste your key here';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('autocapitalize', 'off');
  keyInput.setAttribute('autocorrect', 'off');
  keyInput.spellcheck = false;
  keyInput.style.cssText = 'display:block;margin:4px auto;width:80%;max-width:320px;padding:4px 8px;background:#111;color:#eee;border:1px solid #777;border-radius:6px;font:12px monospace;box-sizing:border-box;';
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save key';
  saveBtn.style.cssText = 'padding:3px 14px;background:#333;color:#ddd;border:1px solid #9d9;border-radius:10px;font:12px sans-serif;';
  setup.appendChild(setupMsg);
  setup.appendChild(setupLink);
  setup.appendChild(keyInput);
  setup.appendChild(saveBtn);
  function submitKey() {
    const k = keyInput.value.trim();
    if (!k) return;
    ownKey = k;
    try { localStorage.setItem(OWN_SLOT, ownKey); } catch (e) {}
    keyInput.value = '';
    problem = null;
    setup.style.display = 'none';
    checkStatus();
  }
  saveBtn.addEventListener('click', submitKey);
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });

  function ensureUI() {
    const host = document.body || document.documentElement;
    if (!host) return;
    if (bar.parentNode !== host) host.appendChild(bar);
    if (setup.parentNode !== host) host.appendChild(setup);
  }

  function mmss(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function alertUser(lvl, text) {
    if (notified[lvl]) return;
    notified[lvl] = true;
    try { if (navigator.vibrate) navigator.vibrate(lvl === 'urgent' ? [400, 150, 400, 150, 400] : [300]); } catch (e) {}
    try { if (window.Notification && Notification.permission === 'granted') new Notification('Torn hospital', { body: text }); } catch (e) {}
  }

  function render() {
    ensureUI();
    // key problems
    const needKey = problem && (problem.code === 'nokey' || problem.code === 2);
    if (needKey) {
      setupMsg.textContent = problem.code === 2
        ? 'Hospital Alert: Torn didn\'t accept the key. Make a new one:'
        : 'Hospital Alert needs an API key (any key works, it only reads your own status).';
      setup.style.display = 'block';
    } else {
      setup.style.display = 'none';
    }

    const left = until ? until - nowSec() : 0;
    level = '';
    if (left > 0 && left <= URGENT_SEC) level = 'urgent';
    else if (left > 0 && left <= WARN_SEC) level = 'warn';

    // Left the window (healed, or hospital time grew): re-arm the alerts.
    if (left <= 0 || left > WARN_SEC + 60) { notified.warn = false; notified.urgent = false; dismissed.warn = false; dismissed.urgent = false; }
    if (left > URGENT_SEC + 30) { notified.urgent = false; dismissed.urgent = false; }

    if (!level || dismissed[level]) { bar.style.display = 'none'; bar.style.animation = ''; return; }

    const text = (level === 'urgent' ? '🚨 Hospital release in ' : '🏥 Hospital release in ') + mmss(left) + (level === 'urgent' ? ' – heal out NOW' : ' – heal out before you\'re released');
    msg.textContent = text;
    bar.style.background = level === 'urgent' ? '#b3261e' : '#c27a00';
    bar.style.display = 'block';
    bar.style.opacity = level === 'urgent' && (nowSec() % 2) ? '0.75' : '1';
    alertUser(level, text);
  }

  // ---- loop --------------------------------------------------------------
  function tick() {
    const left = until ? until - nowSec() : 0;
    const interval = (until && left <= FAST_WITHIN_SEC) ? FAST_POLL_MS : SLOW_POLL_MS;
    const hidden = document.visibilityState === 'hidden';
    if (!hidden && getKey() && Date.now() - lastFetch >= interval) checkStatus();
    // Reached the end of the timer: confirm with the API so the bar clears (or catches an extension).
    else if (!hidden && until && left <= 0 && Date.now() - lastFetch >= 5000) checkStatus();
    render();
  }

  ensureUI();
  document.addEventListener('DOMContentLoaded', ensureUI);
  window.addEventListener('load', ensureUI);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { lastFetch = 0; tick(); } });
  // After any tap (e.g. using a medical item), re-check shortly: the timer changes right away.
  document.addEventListener('click', () => {
    if (!until) return;
    setTimeout(() => { lastFetch = 0; checkStatus(); }, 2500);
  }, true);
  checkStatus();
  setInterval(tick, 1000);
})();
