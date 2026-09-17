/**
 * The page hooks, and the capture that embeds them.
 *
 * This is the half of the collector that decides whether a request is seen at all,
 * so it is worth exercising without a browser: the hooks are plain page JavaScript
 * whose only DOM dependency is `document.readyState`, and the capture expression
 * asks a fixed list of questions, which a fake page can answer.
 *
 * What it cannot check is that a real browser runs the hooks before the page's own
 * scripts — that is `addInitScript`'s contract. `scripts/patch-dsh-browser.mjs
 * --verify` proves that against a real browser, on a page the patch created beside
 * one it did not.
 */
import { CAPTURE_EXPRESSION, PAGE_HOOKS_SOURCE } from '../lib/capture.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};

/** Let the hooks' own promise callbacks run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A page, faked down to what the hooks and the capture touch.
 *
 * Not a DOM: the capture asks for a known list of things and this answers exactly
 * those. A real one would prove nothing extra — what is under test is which requests
 * the hooks record and when, not whether `querySelectorAll` works.
 */
function pageEnv(options = {}) {
  const listeners = {};
  const consoleCalls = [];
  const served = [];   // fetch() calls, each settled by the test
  const xhrs = [];

  const window = {
    __gx: undefined,
    scrollY: 0,
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    fetch(input, init) {
      const call = { input, init, method: init?.method ?? 'GET' };
      call.response = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
      served.push(call);
      return call.response;
    },
  };

  const document = {
    readyState: options.readyState ?? 'loading',
    title: 'Entry',
    documentElement: { scrollHeight: 900 },
    forms: [],
    querySelectorAll: () => [],
    getElementById: () => null,
  };

  const console_ = {
    warn: (...args) => consoleCalls.push(['warn', args]),
    error: (...args) => consoleCalls.push(['error', args]),
  };

  class XMLHttpRequest {
    constructor() {
      this.status = 0;
      this.listeners = {};
      xhrs.push(this);
    }
    open(method, url) { this.opened = { method, url }; }
    send() { this.sent = true; }
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    }
    fire(type) { (this.listeners[type] || []).forEach((handler) => handler({})); }
  }

  const env = {
    window, document, console: console_, XMLHttpRequest, xhrs, served, consoleCalls,
    location: { href: 'http://x/' },
    localStorage: { length: 0, key: () => null, getItem: () => null },

    /** Install the hooks the way addInitScript does: once, at a known readyState. */
    install() {
      new Function('window', 'document', 'XMLHttpRequest', 'console', PAGE_HOOKS_SOURCE)(
        window, document, XMLHttpRequest, console_,
      );
      return env;
    },

    /** Run the real capture expression, compiled the way dsh-browser compiles it. */
    capture() {
      return new Function(
        'window', 'document', 'location', 'localStorage', 'XMLHttpRequest', 'console',
        '"use strict"; return (' + CAPTURE_EXPRESSION + ')',
      )(window, document, env.location, env.localStorage, XMLHttpRequest, console_);
    },

    settle(status, index = 0) { served[index].resolve({ status }); return env; },
    fail(error, index = 0) { served[index].reject(error); return env; },

    firing(type, event) {
      (listeners[type] || []).forEach((handler) => handler(event));
      return env;
    },
  };

  return env;
}

/** The fields worth comparing: `duration_ms` is a measurement, not a fixture. */
const wire = (capture) => (capture.network ?? []).map((entry) => ({
  method: entry.method,
  url: entry.url,
  status: entry.status ?? null,
  failed: entry.failed ?? false,
}));

// --- the file has to survive being embedded ---------------------------------
// page-hooks.js is spliced into a template literal in capture.js. One backtick in a
// comment would end the capture expression early, and one dollar-brace would be
// evaluated as an interpolation. Both would fail at import time, far from the
// sentence that caused them, so they are asserted here next to the reason.
check('the hooks contain no backtick', PAGE_HOOKS_SOURCE.includes('`'), false);
check('the hooks contain no template interpolation', PAGE_HOOKS_SOURCE.includes('${'), false);
check('the hooks import nothing', /^[ \t]*(import|export)\b/m.test(PAGE_HOOKS_SOURCE), false);
// One IIFE and nothing after it: the bytes are spliced into the middle of another
// function body, where a second top-level statement would be a second thing to read.
check(
  'the hooks are one self-contained IIFE',
  [
    PAGE_HOOKS_SOURCE.split('(function () {').length - 1,
    PAGE_HOOKS_SOURCE.trim().endsWith('})();'),
  ],
  [1, true],
);

// --- the capture is still exactly one expression ----------------------------
check(
  'the capture expression compiles the way browser_eval compiles it',
  typeof new Function('"use strict"; return (' + CAPTURE_EXPRESSION + ')'),
  'function',
);
check('the capture carries this file, not a copy of it', CAPTURE_EXPRESSION.includes(PAGE_HOOKS_SOURCE), true);

// --- when the hooks arrived -------------------------------------------------
check(
  'hooks installed before the document ran say so',
  pageEnv({ readyState: 'loading' }).install().capture().hooks_installed_at,
  'document_start',
);
check(
  'hooks installed after the document had started say so',
  pageEnv({ readyState: 'complete' }).install().capture().hooks_installed_at,
  'after_load',
);
check(
  'a later capture does not rewrite when the hooks arrived',
  (() => {
    const env = pageEnv({ readyState: 'complete' }).install();
    env.capture();
    return env.capture().hooks_installed_at;
  })(),
  'after_load',
);

// --- the request that loads a document --------------------------------------
// The gap: a page's own boot request starts while it is parsing, so a collector
// that arrives afterwards never sees it. Recorded when the request starts, it is
// already in the buffer the first capture drains.
{
  const env = pageEnv({ readyState: 'loading' }).install();
  env.window.fetch('/api/session');   // what the page's own script does, at load
  check('a request that is still in flight is already recorded', wire(env.capture()), [
    { method: 'GET', url: '/api/session', status: null, failed: false },
  ]);
  check('and it is drained, so it is recorded once', wire(env.capture()), []);
}
{
  const env = pageEnv({ readyState: 'loading' }).install();
  env.window.fetch('/api/session', { method: 'post' });
  env.settle(201);
  await tick();
  const capture = env.capture();
  check('the response status is filled in when it arrives', wire(capture), [
    { method: 'POST', url: '/api/session', status: 201, failed: false },
  ]);
  check('and a duration is reported with it', Number.isInteger(capture.network[0].duration_ms), true);
}
{
  const env = pageEnv({ readyState: 'loading' }).install();
  env.window.fetch('/api/session').catch(() => {});
  env.fail(new Error('offline'));
  await tick();
  const capture = env.capture();
  check('a request that never arrived is recorded as failed', wire(capture), [
    { method: 'GET', url: '/api/session', status: null, failed: true },
  ]);
  check('with the reason it failed', capture.network[0].failure_reason, 'Error: offline');
}

// --- XHR, on the same terms -------------------------------------------------
{
  const env = pageEnv().install();
  const xhr = new env.XMLHttpRequest();
  xhr.open('PUT', '/api/cart/1');
  xhr.send();
  check('an XHR is recorded when it is sent', wire(env.capture()), [
    { method: 'PUT', url: '/api/cart/1', status: null, failed: false },
  ]);
}
{
  const env = pageEnv().install();
  const xhr = new env.XMLHttpRequest();
  xhr.open('PUT', '/api/cart/1');
  xhr.send();
  xhr.status = 204;
  xhr.fire('loadend');
  check('and its status when the response lands', wire(env.capture()), [
    { method: 'PUT', url: '/api/cart/1', status: 204, failed: false },
  ]);
}

// --- console and page errors ------------------------------------------------
{
  const env = pageEnv().install();
  env.console.warn('careful', { code: 7 });
  env.console.error('broken');
  env.firing('error', { message: 'boom' });
  env.firing('unhandledrejection', { reason: 'nope' });
  const capture = env.capture();
  check('console warnings are recorded', capture.console, [
    { level: 'warn', text: 'careful {"code":7}' },
    { level: 'error', text: 'broken' },
  ]);
  check('and still reach the real console', env.consoleCalls, [
    ['warn', ['careful', { code: 7 }]],
    ['error', ['broken']],
  ]);
  check('page errors and rejections are recorded', capture.page_errors, ['boom', 'nope']);
}

// --- installing twice -------------------------------------------------------
// The eval installer runs on every capture; the init script runs on every
// navigation. Neither may wrap the other's work.
{
  const env = pageEnv().install();
  const wrapped = env.window.fetch;
  env.install();
  check('a second install leaves the wrapped fetch alone', env.window.fetch === wrapped, true);
  env.window.fetch('/api/once');
  check('so one request is one entry', wire(env.capture()), [
    { method: 'GET', url: '/api/once', status: null, failed: false },
  ]);
}

// --- the state this replaces ------------------------------------------------
// A document that reached `complete` without hooks reports an empty list and says
// why. That is the honest report of a collector that arrived late — and it is the
// difference between "this document made no requests" and "we looked too late".
{
  const env = pageEnv({ readyState: 'complete' }).install();
  const capture = env.capture();
  check('a late collector reports no requests', wire(capture), []);
  check('and says its hooks arrived late', capture.hooks_installed_at, 'after_load');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
