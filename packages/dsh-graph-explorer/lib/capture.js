/**
 * The in-page evidence collector.
 *
 * `dsh-browser`'s `browser_eval` compiles its argument as
 * `Function('"use strict"; return (' + expression + ')')()`, so this must be ONE
 * expression — hence the IIFE. That also means the source travels to the page as
 * a string we control, so the tsx/esbuild `__name` trap (which corrupts
 * `page.evaluate(fn)` bodies) cannot apply here.
 *
 * Deliberately free of `${...}`: this is a template literal, and every value is
 * built with concatenation so the emitted source survives intact.
 *
 * Two jobs, one round trip:
 *   1. install the network/console hooks if this document does not have them yet
 *   2. drain them and snapshot the semantic surface of the page
 *
 * The hooks are document-scoped, so a full navigation discards them and they are
 * re-installed by the next capture. That means the initial document loads of a
 * navigation are NOT observed. Action-triggered XHR/fetch on the same document
 * are, which is the case `transition.effects[].request` needs. Closing the gap
 * requires Playwright's `addInitScript`, i.e. a `dsh-browser` source patch.
 */
export const CAPTURE_EXPRESSION = `(() => {
  var MAX_ITEMS = 60;
  var gx = window.__gx || (window.__gx = { network: [], console: [], errors: [], hooked: false });

  if (!gx.hooked) {
    gx.hooked = true;
    gx.network = gx.network || [];
    gx.console = gx.console || [];
    gx.errors = gx.errors || [];

    var record = function (entry) {
      gx.network.push(entry);
      if (gx.network.length > 200) gx.network.shift();
    };

    var originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        var args = arguments;
        var input = args[0];
        var init = args[1] || {};
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        var started = Date.now();
        return originalFetch.apply(this, args).then(function (response) {
          record({ method: method, url: url, status: response.status, duration_ms: Date.now() - started });
          return response;
        }, function (error) {
          record({ method: method, url: url, failed: true, failure_reason: String(error), duration_ms: Date.now() - started });
          throw error;
        });
      };
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__gx = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      var meta = self.__gx || (self.__gx = { method: 'GET', url: '' });
      var started = Date.now();
      self.addEventListener('loadend', function () {
        record({ method: meta.method, url: meta.url, status: self.status, duration_ms: Date.now() - started });
      });
      return originalSend.apply(this, arguments);
    };

    var stringify = function (value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (error) { return String(value); }
    };
    ['warn', 'error'].forEach(function (level) {
      var original = console[level];
      console[level] = function () {
        gx.console.push({
          level: level,
          text: Array.prototype.map.call(arguments, stringify).join(' '),
        });
        if (gx.console.length > 100) gx.console.shift();
        return original.apply(console, arguments);
      };
    });
    window.addEventListener('error', function (event) {
      gx.errors.push(String((event && event.message) || (event && event.error) || event));
    });
    window.addEventListener('unhandledrejection', function (event) {
      gx.errors.push(String((event && event.reason) || event));
    });
  }

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
    network: drain(gx.network),
    console: drain(gx.console),
    page_errors: drain(gx.errors),
  };
})()`;
