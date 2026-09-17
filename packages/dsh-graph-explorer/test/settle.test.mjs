/**
 * The reading taken after an action, on an app that renders late.
 *
 * Everything else in this package assumes one thing: that the capture attached to a
 * step describes the page as the action left it. On a client-rendered app that is not
 * free. `browser_click` resolves as soon as the click is dispatched, the collector
 * reads the page a few milliseconds later, and the frame the click started has not
 * arrived yet — so the step is recorded as "nothing changed" and the reading that
 * belongs to the NEXT screen is bound to THIS action. Every endpoint after it is then
 * shifted by one, and the evidence looks perfect while it happens: the capture is a
 * faithful photograph of a page that was about to change.
 *
 * So this suite is the one test that says whether the architecture handles it:
 *
 *   click Login → the SPA waits 150ms → renders the dashboard
 *   → the observation bound to the Login action must BE the dashboard.
 *
 * The page here is a real timer and a real promise: the expression under test is the
 * one that ships, compiled the way `browser_eval` compiles it, against a fake page
 * that answers the questions the collector asks. What is faked is the DOM, not the
 * ordering, which is the whole subject.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../lib/index.js';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION, SETTLE_IDLE_MS, SETTLE_QUIET_MS } from '../lib/capture.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};

// --- a page, faked down to what the collector touches ----------------------
/** An element, as far as `roleOf`/`nameOf`/`selectorOf`/`describe` ask. */
const element = (tag, text, attributes = {}) => ({
  tagName: tag.toUpperCase(),
  textContent: text,
  labels: [],
  disabled: false,
  required: false,
  getClientRects: () => [{}],
  getAttribute: (name) => (name in attributes ? attributes[name] : null),
  hasAttribute: (name) => name in attributes,
});

/** The two screens of the app under test. */
const signIn = () => [element('button', 'Login', { id: 'login' })];
const dashboard = () => [
  element('a', 'Projects', { href: '/projects' }),
  element('button', 'Settings', { id: 'settings' }),
  element('button', 'Log out', { id: 'logout' }),
];

const NAMES = (interactive) => (interactive ?? []).map((item) => item.role + ':' + item.name);

/** The hooks patch `XMLHttpRequest.prototype`, so the fake has to be a real class. */
class FakeXHR {
  open() {}
  send() {}
  addEventListener() {}
}

/**
 * A page with a clock, a title, and a set of observers — the three things the settle
 * loop uses. Not a DOM: the collector asks a fixed list of questions and this answers
 * those, which is what makes the ordering testable without a browser.
 */
function makePage() {
  const observers = [];
  const page = {
    url: 'http://x/',
    title: 'Sign in',
    controls: signIn(),
    /** Every dispatch the machinery made, in order: 'settle' and 'capture'. */
    order: [],
    /** Every reading, stamped with the title it saw. */
    readings: [],
    /** The fetches the page itself started, each settled by the test. */
    requests: [],
    timer: null,
  };

  const gx = { network: [], console: [], errors: [], hooks_installed_at: 'document_start' };

  page.window = {
    __gx: gx,
    scrollY: 0,
    addEventListener() {},
  };
  page.location = { href: page.url };
  page.localStorage = { length: 0, key: () => null, getItem: () => null };
  page.console = { warn() {}, error() {} };
  page.document = {
    readyState: 'complete',
    get title() { return page.title; },
    documentElement: { scrollHeight: 900 },
    forms: [],
    getElementById: () => null,
    querySelectorAll: (selector) => (selector.indexOf('a[href],button') === 0 ? page.controls : []),
  };
  page.observer = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.watching = true; }
    disconnect() { this.watching = false; }
  };

  /**
   * What the app does when it renders: swap the screen, then tell the DOM it moved.
   * A real MutationObserver callback is a microtask; calling it here keeps the test
   * on the strict side of that.
   */
  page.render = (title, controls) => {
    page.title = title;
    page.controls = controls;
    for (const observer of observers) if (observer.watching) observer.callback([{}]);
  };

  /** The click the app responds to, and the render it schedules 150ms later. */
  page.clickLogin = ({ renderMs = 150, requestMs = 0 } = {}) => {
    if (requestMs) {
      page.requests.push(requestMs);
      page.window.fetch('/api/session').catch(() => {});
    }
    page.timer = setTimeout(() => page.render('Dashboard', dashboard()), renderMs);
    return page;
  };

  page.settleWith = () => new Function(
    'window', 'document', 'MutationObserver',
    '"use strict"; return (' + SETTLE_EXPRESSION + ')',
  )(page.window, page.document, page.observer);

  page.read = () => new Function(
    'window', 'document', 'location', 'localStorage', 'XMLHttpRequest', 'console',
    '"use strict"; return (' + CAPTURE_EXPRESSION + ')',
  )(page.window, page.document, page.location, page.localStorage, FakeXHR, page.console);

  return page;
}

// --- fake harness ---------------------------------------------------------
const cwd = mkdtempSync(join(tmpdir(), 'gx-settle-'));
const tools = new Map();
const handlers = new Map();
const page = makePage();

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-settle' } } },
};

const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    async execute(call) {
      if (call.name !== 'browser_eval') return { isError: false, value: null };
      const expr = call.arguments?.expression;
      // The two expressions the collector dispatches, run against the fake page. The
      // settle is asked for first and is what makes the ordering the subject here.
      if (expr === SETTLE_EXPRESSION) {
        page.order.push('settle');
        return { isError: false, value: await page.settleWith() };
      }
      if (expr === CAPTURE_EXPRESSION) {
        page.order.push('capture');
        const value = page.read();
        page.readings.push({ title: value.title, controls: NAMES(value.interactive) });
        return { isError: false, value };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section() {} },
};
apply(ctx, Config({}));

const act = (name, args, action) => handlers.get('tools/execute')(
  { ...exec, name, arguments: args },
  action ?? (async () => ({ isError: false, value: null })),
);
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const observations = () => readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

// --- the structural half --------------------------------------------------
check('the settle is one expression, compiled the way browser_eval compiles it',
  typeof new Function('"use strict"; return (' + SETTLE_EXPRESSION + ')'), 'function');
check('and it hands the page the clock (a promise, not a value)',
  (() => {
    const result = new Function('"use strict"; return (' + SETTLE_EXPRESSION + ')')();
    // No window in this scope, so it rejects immediately: the shape is the point.
    result.catch(() => {});
    return result instanceof Promise;
  })(), true);

// --- step 1: the entry screen ---------------------------------------------
await act('browser_open', { url: 'http://x/' });
const entry = await observe({
  page_type: 'sign_in',
  detection: [{ type: 'element_state', target: { semantic_purpose: 'login_button' }, operator: 'exists' }],
  elements: [{ semantic_purpose: 'login_button', role: 'button', name: 'Login' }],
});
check('the entry reading is the sign-in page', [entry.graph.state.state_id, NAMES(entry.interactive)], ['state_sign_in', ['button:Login']]);

// --- step 2: click Login, and the app renders 150ms later -----------------
// The whole point. The action resolves, the render is still 150ms away, and the
// reading bound to this step has to be the page the action produced.
await act('browser_click', { selector: '#login' }, async () => {
  page.clickLogin({ renderMs: 150 });
  return { isError: false, value: { url: page.url, title: page.title } };
});

const click = observations().find((record) => record.tool === 'browser_click');
check('the page was asked to settle before it was read, once per action',
  page.order, ['settle', 'capture', 'settle', 'capture']);
check('the login step waited for the render instead of reading through it',
  [click.settle?.timed_out, click.settle?.changes > 0], [false, true]);
check('the observation for the Login action is the page the action produced',
  NAMES(click.capture.interactive), ['link:Projects', 'button:Settings', 'button:Log out']);
check('and not the page the action was taken on',
  NAMES(click.capture.interactive).includes('button:Login'), false);
check('the title agrees', click.capture.title, 'Dashboard');

// --- what the model is handed for that step -------------------------------
const digest = await observe({
  page_type: 'dashboard',
  detection: [{ type: 'element_state', target: { semantic_purpose: 'projects_link' }, operator: 'exists' }],
  elements: [{ semantic_purpose: 'projects_link', role: 'link', name: 'Projects' }],
});
check('page_type = dashboard is the step the Login action was captured in',
  [digest.evidence.observation_id, digest.evidence.captured_for], [click.id, 'browser_click']);
check('and the controls the model is handed with it are the dashboard\'s',
  NAMES(digest.interactive), ['link:Projects', 'button:Settings', 'button:Log out']);
const diff = digest.changed_since_previous_observation ?? {};
check('the step is a change of screen, not a self-loop',
  [diff.appeared, diff.disappeared],
  [['link:Projects', 'button:Settings', 'button:Log out'], ['button:Login']]);
check('the digest says how the reading was taken',
  [digest.settle?.timed_out, digest.settle?.quiet_ms, digest.settle?.idle_ms], [false, SETTLE_QUIET_MS, SETTLE_IDLE_MS]);

// --- and the walk is not shifted by one -----------------------------------
const edge = await transition({ capability: 'log_in', capability_kind: 'navigation' });
check('the transition runs sign_in → dashboard, not sign_in → sign_in',
  [edge.transition.from_state, edge.transition.to_state], ['state_sign_in', 'state_dashboard']);
check('over the pair of steps the action really spans',
  edge.transition.derived_from, { before: 'obs_0001', after: 'obs_0002' });
check('with no disagreements to record', edge.disagreements.map((item) => item.kind), []);

// --- a page that does not move at all -------------------------------------
// The honest limit of a quiet window: it cannot wait for a render that has announced
// nothing, and it does not pretend to. What it must not do is hang, or report a page
// it did not see.
{
  const still = makePage();
  const started = Date.now();
  const settle = await still.settleWith();
  const elapsed = Date.now() - started;
  check('a page that never moves is waited for, then read',
    [settle.changes, settle.timed_out, settle.watched], [0, false, true]);
  check('for the idle window, not the budget', elapsed >= SETTLE_IDLE_MS - 30, true);
  check('and the wait is reported rather than hidden', settle.waited_ms >= SETTLE_IDLE_MS - 30, true);
}

// --- a request the page started, which lands and then renders --------------
// The other half of "the page has not finished": work it has ANNOUNCED. An open
// request is a change that has not arrived yet, so the reading waits for it.
{
  const slow = makePage();
  slow.window.fetch = () => new Promise((resolve) => {
    setTimeout(() => { resolve({ status: 200 }); slow.render('Dashboard', dashboard()); }, 300);
  });
  // The hooks are the only thing that can see a request start, so they go in first.
  const beforeRequest = slow.read();
  const started = Date.now();
  slow.clickLogin({ renderMs: 0, requestMs: 300 });
  const settle = await slow.settleWith();
  const capture = slow.read();
  check('a request in flight holds the reading until it lands',
    Date.now() - started >= 500, true);
  check('so the reading is the screen that request rendered',
    [beforeRequest.title, NAMES(capture.interactive)],
    ['Sign in', ['link:Projects', 'button:Settings', 'button:Log out']]);
  check('and the settle counted the page as moving', settle.changes > 0, true);
}

rmSync(cwd, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
