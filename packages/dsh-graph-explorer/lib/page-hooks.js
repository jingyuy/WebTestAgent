/**
 * The page hooks: the network, console and page-error collector that runs inside
 * the document.
 *
 * A plain page script, not a module, because it is installed two ways and both
 * have to collect the same evidence:
 *
 *   1. At document start, by the local dsh-browser patch. The patch script copies
 *      this file into the profile and the patched browser installs it on every new
 *      page with addInitScript, which is the only way to see the requests that
 *      LOAD a document: anything installed by browser_eval arrives after the
 *      document it would be watching has already run.
 *   2. From browser_eval, embedded in CAPTURE_EXPRESSION (lib/capture.js). That is
 *      the fallback for a document the patch did not reach, and the re-installer
 *      after a navigation that discarded a page's hooks.
 *
 * One source, two installers, so they cannot drift into two slightly different
 * hook sets. capture.js reads these exact bytes; scripts/patch-dsh-browser.mjs
 * copies these exact bytes, and its --verify compares the copy it made.
 *
 * Three constraints, all of them because of how it is embedded:
 *   - No import, export or require, and no top-level return: it is evaluated as a
 *     page script.
 *   - NO BACKTICKS AND NO DOLLAR-BRACE ANYWHERE IN THIS FILE, comments included.
 *     It is interpolated into a template literal, where a single backtick in a
 *     sentence would end the capture expression early and a dollar-brace would be
 *     evaluated as an interpolation. test/page-hooks.test.mjs enforces this.
 *   - Wrapped in its own IIFE, so embedding it cannot collide with the names
 *     around it and installing it twice is harmless.
 */
(function () {
  var gx = window.__gx || (window.__gx = { network: [], console: [], errors: [], hooked: false });
  if (gx.hooked) return;

  gx.hooked = true;
  gx.network = gx.network || [];
  gx.console = gx.console || [];
  gx.errors = gx.errors || [];

  // WHEN these hooks were installed, relative to the document that now holds them.
  // "document_start" means they were in place before any of the page's own scripts
  // ran, so the lists below are the whole document's story. "after_load" means the
  // document had already started running when they arrived, so whatever it did
  // first is gone. An empty request list is a fact — "this document made no
  // requests" — only in the first case; in the second it means "we looked too
  // late", and without this marker the two are indistinguishable. That is how a
  // request that happened gets read as a request that did not.
  gx.hooks_installed_at = document.readyState === 'loading' ? 'document_start' : 'after_load';

  // Entries are appended when a request STARTS, not when it finishes. Loading a
  // document is what forces the distinction: the request that loads a page's own
  // state is usually still in flight when the navigation settles, so recording
  // only on completion would push it into the NEXT capture, where it would be read
  // as an effect of whatever action was taken next. status and duration_ms are
  // filled in if the response arrives before the drain; an entry that still has
  // neither was in flight when we looked.
  var record = function (entry) {
    gx.network.push(entry);
    if (gx.network.length > 200) gx.network.shift();
    return entry;
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
      var entry = record({ method: method, url: url });
      return originalFetch.apply(this, args).then(function (response) {
        entry.status = response.status;
        entry.duration_ms = Date.now() - started;
        return response;
      }, function (error) {
        entry.failed = true;
        entry.failure_reason = String(error);
        entry.duration_ms = Date.now() - started;
        throw error;
      });
    };
  }

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gx_request = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var meta = self.__gx_request || (self.__gx_request = { method: 'GET', url: '' });
    var started = Date.now();
    var entry = record({ method: meta.method, url: meta.url });
    self.addEventListener('loadend', function () {
      entry.status = self.status;
      entry.duration_ms = Date.now() - started;
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
})();
