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
 * Two jobs, one round trip, in this order:
 *   1. install the network/console hooks if this document does not have them yet
 *   2. drain them and snapshot the semantic surface of the page
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
