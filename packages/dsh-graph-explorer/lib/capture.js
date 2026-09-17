/**
 * The in-page evidence collector.
 *
 * `dsh-browser`'s `browser_eval` compiles its argument as
 * `Function('"use strict"; return (' + expression + ')')()`, so this must be ONE
 * expression — hence the IIFE. That also means the source travels to the page as
 * a string we control, so the tsx/esbuild `__name` trap (which corrupts
 * `page.evaluate(fn)` bodies) cannot apply here.
 *
 * The hook half is not written here. It is read from `page-hooks.js` and embedded
 * verbatim, because the same bytes are installed at document start by the local
 * dsh-browser patch (`scripts/patch-dsh-browser.mjs`). The hooks written twice
 * would be two collectors that agree until the day they do not, and the
 * disagreement would show up as evidence nobody could reproduce.
 *
 * Three jobs, two round trips, in this order:
 *   0. `SETTLE_EXPRESSION` — wait for the page to stop moving (its own round trip)
 *   1. install the network/console hooks if this document does not have them yet
 *   2. drain them and snapshot the semantic surface of the page
 *
 * Job 0 is the answer to a race that the snapshot alone cannot fix: a reading taken
 * immediately after an action describes the page the action started FROM on any app
 * that renders a frame (or 150ms) later. See `SETTLE_EXPRESSION` for why it is a
 * separate round trip and why it is a quiet window rather than a fixed sleep.
 *
 * Which of the two installers got there first — and whether it was in time — is
 * reported as `hooks_installed_at`. A document whose hooks arrived at document
 * start has been watched from its first byte; one that only gets them from this
 * eval had already run its own scripts, so an empty `network` there means "we
 * looked too late", not "nothing happened".
 *
 * Deliberately free of `${...}` of its own: this is a template literal, and every
 * value is built with concatenation so the emitted source survives intact. The
 * embedded file is the one thing spliced into it, so page-hooks.js is checked for
 * the characters that would end the literal early.
 */
import { readFileSync } from 'node:fs';

/**
 * The page hooks, verbatim — the same bytes the patched browser installs at page
 * creation. Exported so the tests and the patch script can compare against what
 * the browser actually gets, instead of against a retyped copy of it.
 */
export const PAGE_HOOKS_SOURCE = readFileSync(new URL('./page-hooks.js', import.meta.url), 'utf8');

export const CAPTURE_EXPRESSION = `(() => {
  var MAX_ITEMS = 60;

  ${PAGE_HOOKS_SOURCE}

  var gx = window.__gx || (window.__gx = { network: [], console: [], errors: [] });

  var clean = function (value) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  };
  var clip = function (value, max) {
    var text = String(value == null ? '' : value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  };
  var visible = function (el) {
    return el.getClientRects().length > 0;
  };

  var roleOf = function (el) {
    var explicit = el.getAttribute('role');
    if (explicit) return clean(explicit);
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    return 'generic';
  };

  var nameOf = function (el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var joined = labelledBy.split(/\\s+/).map(function (id) {
        var node = document.getElementById(id);
        return node ? node.textContent : '';
      }).join(' ');
      if (clean(joined)) return clean(joined);
    }
    if (el.labels && el.labels.length) {
      var fromLabels = Array.prototype.map.call(el.labels, function (label) { return label.textContent; }).join(' ');
      if (clean(fromLabels)) return clean(fromLabels);
    }
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return clean(el.value);
    var alt = el.getAttribute('alt');
    if (alt) return clean(alt);
    var title = el.getAttribute('title');
    if (title) return clean(title);
    return clean(el.textContent);
  };

  var selectorOf = function (el) {
    var testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    if (el.id) return '#' + el.id;
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var type = el.getAttribute('type');
    if (type) return el.tagName.toLowerCase() + '[type="' + type + '"]';
    return el.tagName.toLowerCase();
  };

  var describe = function (el) {
    var entry = {
      role: roleOf(el),
      name: clip(nameOf(el), 120),
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      visible: visible(el),
      disabled: el.disabled === true,
    };
    var testid = el.getAttribute('data-testid');
    if (testid) entry.testid = testid;
    var type = el.getAttribute('type');
    if (type) entry.type = type;
    var placeholder = el.getAttribute('placeholder');
    if (placeholder) entry.placeholder = clean(placeholder);
    if (el.required === true) entry.required = true;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      entry.value = el.type === 'password' ? (el.value ? '[set]' : '') : clip(el.value, 120);
    } else if (el.tagName === 'SELECT') {
      entry.value = clip(el.value, 120);
      entry.options = Array.prototype.map.call(el.options, function (option) {
        return { value: option.value, label: clip(option.textContent, 60), selected: option.selected };
      }).slice(0, 20);
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      entry.checked = el.checked === true;
    }
    if (el.getAttribute('href')) entry.href = clip(el.getAttribute('href'), 200);
    return entry;
  };

  var interactiveSelector = 'a[href],button,input,select,textarea,[role],[contenteditable="true"],[data-testid]';
  var interactive = [];
  var seen = {};
  Array.prototype.forEach.call(document.querySelectorAll(interactiveSelector), function (el) {
    if (!visible(el)) return;
    var key = selectorOf(el) + '|' + roleOf(el) + '|' + nameOf(el);
    if (seen[key]) return;
    seen[key] = true;
    if (interactive.length < MAX_ITEMS) interactive.push(describe(el));
  });

  var headings = Array.prototype.map.call(document.querySelectorAll('h1,h2,h3'), function (el) {
    return { level: Number(el.tagName.slice(1)), text: clip(clean(el.textContent), 120) };
  });

  var statusSelector = '[role="status"],[role="alert"],[aria-live],[class*="error"],[class*="success"],[class*="alert"]';
  var statusSeen = {};
  var status = [];
  Array.prototype.forEach.call(document.querySelectorAll(statusSelector), function (el) {
    if (!visible(el)) return;
    var text = clip(clean(el.textContent), 200);
    if (!text || statusSeen[text]) return;
    statusSeen[text] = true;
    if (status.length < 10) status.push({ role: roleOf(el), text: text });
  });

  var storage = {};
  try {
    for (var i = 0; i < localStorage.length && i < 20; i++) {
      var storageKey = localStorage.key(i);
      storage[storageKey] = clip(localStorage.getItem(storageKey), 200);
    }
  } catch (error) { /* storage can be blocked; absence is not a failure */ }

  var forms = Array.prototype.map.call(document.forms, function (form) {
    return {
      selector: form.getAttribute('data-testid') ? '[data-testid="' + form.getAttribute('data-testid') + '"]' : (form.id ? '#' + form.id : 'form'),
      action: clip(form.getAttribute('action'), 200),
      method: (form.getAttribute('method') || 'get').toUpperCase(),
      fields: Array.prototype.map.call(form.elements, function (el) {
        return el.name || el.id || el.type;
      }).filter(Boolean).slice(0, 30),
    };
  });

  var drain = function (list) { return list.splice(0, list.length); };

  return {
    url: location.href,
    title: document.title,
    headings: headings,
    interactive: interactive,
    forms: forms,
    status: status,
    storage: storage,
    scroll: { y: Math.round(window.scrollY), height: document.documentElement.scrollHeight },
    hooks_installed_at: gx.hooks_installed_at || null,
    network: drain(gx.network),
    console: drain(gx.console),
    page_errors: drain(gx.errors),
  };
})()`;

/**
 * How long the page has to hold still before the reading is taken, and how long we
 * are willing to hold the reading back waiting for that.
 *
 * `QUIET` is the number the frame after an action usually arrives inside: a state
 * update renders within a frame, a debounce or a `setTimeout` render lands inside a
 * couple of hundred ms. Once the page has been seen to move, waiting this long after
 * the last twitch is enough, and the reading costs the render plus this.
 *
 * `IDLE` covers the case the quiet window alone cannot: the page has not moved at
 * all yet. That is exactly the answer a race produces falsely — "nothing changed" —
 * so it is the claim worth being slow about, and an apparent no-op is watched for a
 * full second before it is called one. A step that does move never pays this.
 *
 * `BUDGET` is where a reading stops being worth the wait. The only way to reach it is
 * a page that keeps moving (or keeps a request open): continuous activity resets the
 * quiet clock, so the loop gives up at the budget and says so with `timed_out`.
 *
 * All three are reported with every capture, so a reading never has to be trusted on
 * the strength of a hidden constant.
 */
export const SETTLE_QUIET_MS = 250;
export const SETTLE_IDLE_MS = 1000;
export const SETTLE_BUDGET_MS = 3000;
/** How often the page re-checks whether it has gone quiet. Not a fixed sleep: see below. */
export const SETTLE_POLL_MS = 25;

/**
 * Wait for the page to stop moving. Returns a promise, because the page must be the
 * one holding the clock — a wait driven from outside would be a second thing to keep
 * in sync with the page, and would cost a round trip per poll.
 *
 * Why this exists, in one line: `capture(before) → action → capture(after)` is only
 * an account of the action if the page is still when the second capture runs. A
 * click that renders 150ms later is read as "nothing changed", the step is recorded
 * as a self-loop, and the reading that describes the destination belongs to an
 * action that has not happened yet — every endpoint after it is shifted by one. The
 * failure is invisible in the evidence: the capture is a faithful photograph of a
 * page that was about to change.
 *
 * Work the page has announced is waited for as well: an open `fetch`/XHR is a change
 * that has not arrived yet, and the hooks see it start.
 *
 * What it cannot do is see the future. A `setTimeout(render, 5000)` announces itself
 * to nothing and no wait can cover it — `changes`, `in_flight` and `timed_out` in the
 * answer are what tell a caller which of these it got, and the collector records them
 * next to the capture rather than deciding for the model that the reading was fine.
 * Measured against a real browser: a render 150ms after the click is read correctly
 * (≈400ms), one at 900ms is read correctly (≈1150ms), one at 2000ms is not — that
 * reading is taken at the idle window and reports `changes: 0`, which is the honest
 * account of a page that had announced nothing.
 *
 * Never throws on its own account: if the document has no `MutationObserver` the
 * wait degrades to the quiet period alone and says so in `watched`.
 */
export const SETTLE_EXPRESSION = `(async () => {
  var QUIET_MS = ${SETTLE_QUIET_MS};
  var IDLE_MS = ${SETTLE_IDLE_MS};
  var BUDGET_MS = ${SETTLE_BUDGET_MS};
  var POLL_MS = ${SETTLE_POLL_MS};
  var startedAt = Date.now();
  var lastChangeAt = startedAt;
  var changes = 0;
  var watched = false;
  var inFlight = 0;
  var busy = false;
  var observer = null;

  var gx = window.__gx || {};

  // A request that has started and not finished is a change that has not arrived
  // yet, so it holds the reading back exactly like an observed mutation would. The
  // hooks record on START for this reason; a capture taken now would report an app
  // mid-update as an app that did nothing.
  var openRequests = function () {
    var list = gx.network || [];
    var open = 0;
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (entry && entry.status == null && entry.failed !== true) open++;
    }
    return open;
  };

  // Everything the capture below reads: child nodes, text and attributes. A page
  // that re-renders identical values still counts as moving — telling a no-op
  // re-render from a real one means diffing the surface, which is the capture's job
  // and not something to do twice per step.
  if (typeof MutationObserver === 'function' && document.documentElement) {
    try {
      observer = new MutationObserver(function (records) {
        changes += records.length;
        busy = true;
        lastChangeAt = Date.now();
      });
      observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
      watched = true;
    } catch (error) {
      observer = null;
    }
  }

  var timedOut = false;
  while (true) {
    inFlight = openRequests();
    if (inFlight > 0) {
      busy = true;
      lastChangeAt = Date.now();
    }
    if (Date.now() - startedAt >= BUDGET_MS) { timedOut = true; break; }
    // An action that appears to have changed nothing is the answer under suspicion,
    // so it gets the long window; one that moved gets the short one after it stops.
    if (Date.now() - lastChangeAt >= (busy ? QUIET_MS : IDLE_MS)) break;
    await new Promise(function (resolve) { setTimeout(resolve, POLL_MS); });
  }

  if (observer) observer.disconnect();

  var waited = Date.now() - startedAt;
  return {
    waited_ms: waited,
    quiet_ms: QUIET_MS,
    idle_ms: IDLE_MS,
    budget_ms: BUDGET_MS,
    changes: changes,
    in_flight: inFlight,
    timed_out: timedOut,
    watched: watched,
  };
})()`;
