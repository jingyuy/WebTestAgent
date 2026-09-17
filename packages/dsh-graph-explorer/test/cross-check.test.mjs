import { crossCheckEffects, diffCaptures } from '../lib/index.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label, '=', JSON.stringify(actual));
};

const cap = (over = {}) => ({ url: 'http://x/a', title: 'A', headings: [], interactive: [], status: [], network: [], scroll: {}, storage: {}, console: [], page_errors: [], ...over });

// --- diffCaptures ---------------------------------------------------------
const d = diffCaptures(cap(), cap({ url: 'http://x/b', title: 'B', status: [{ text: 'Saved', severity: 'success' }], interactive: [{ role: 'button', name: 'Save' }], network: [{ method: 'POST', url: '/api/x', failed: true }], page_errors: ['boom'] }));
check('diff: url pair', d.url, ['http://x/a', 'http://x/b']);
check('diff: title pair', d.title, ['A', 'B']);
check('diff: appeared', d.appeared, ['button:Save']);
check('diff: disappeared key is absent, not empty', 'disappeared' in d, false);
check('diff: status texts', d.status, ['Saved']);
check('diff: requests', d.requests.length, 1);
check('diff: page errors', d.page_errors, ['boom']);
check('truly identical captures diff to null', diffCaptures(cap(), cap()), null);
check('diff omits keys that did not change, and names elements as role:name', diffCaptures(cap(), cap({ interactive: [{ role: 'button', name: 'Save' }] })), { appeared: ['button:Save'] });
check('diff spots a disappearance', diffCaptures(cap({ interactive: [{ role: 'link', name: 'Old' }] }), cap()), { disappeared: ['link:Old'] });
check('diff returns null when a capture is missing', [diffCaptures(null, cap()), diffCaptures(cap(), undefined)], [null, null]);

// An input's value is page state, and filling one in is the entire content of a form
// step. Until the diff looked at it, every such step reported "nothing changed".
const field = (over = {}) => ({ role: 'textbox', name: 'Email', value: '', ...over });
check('diff sees a value appearing', diffCaptures(cap({ interactive: [field()] }), cap({ interactive: [field({ value: 'test@example.com' })] })), { changed: ['textbox:Email: value="" → value="test@example.com"'] });
check('diff sees a value being replaced', diffCaptures(cap({ interactive: [field({ value: 'old' })] }), cap({ interactive: [field({ value: 'new' })] })), { changed: ['textbox:Email: value="old" → value="new"'] });
check('diff sees a masked password being set', diffCaptures(cap({ interactive: [field({ name: 'Password' })] }), cap({ interactive: [field({ name: 'Password', value: '[set]' })] })), { changed: ['textbox:Password: value="" → value="[set]"'] });
check('diff sees a checkbox toggle', diffCaptures(cap({ interactive: [{ role: 'checkbox', name: 'Remember me', checked: false }] }), cap({ interactive: [{ role: 'checkbox', name: 'Remember me', checked: true }] })), { changed: ['checkbox:Remember me: checked=false → checked=true'] });
check('diff sees an element becoming disabled', diffCaptures(cap({ interactive: [{ role: 'button', name: 'Save' }] }), cap({ interactive: [{ role: 'button', name: 'Save', disabled: true }] })), { changed: ['button:Save: (none) → disabled'] });
check('unchanged values are not reported as a change', diffCaptures(cap({ interactive: [field({ value: 'same' })] }), cap({ interactive: [field({ value: 'same' })] })), null);
check('a value change makes a step no longer "nothing changed"', diffCaptures(cap({ interactive: [field()] }), cap({ interactive: [field({ value: 'x' })] })) !== null, true);

const stored = diffCaptures(cap({ storage: { keep: '1', drop: '2', edit: 'old' } }), cap({ storage: { keep: '1', edit: 'new', added: '3' } }));
check('diff sees storage writes, edits and removals', stored.storage, { edit: 'new', added: '3', drop: null });
check('storage changes are reported with nothing else', stored, { storage: { edit: 'new', added: '3', drop: null } });

// --- errors ---------------------------------------------------------------
const e1 = crossCheckEffects({ effects: [{ type: 'state_entered', to: 'state_x' }], before: cap(), after: cap(), toState: 'state_y', observedChange: { url: null } });
check('state_entered mismatch is an error', [e1.errors.length, e1.warnings], [1, []]);
const e2 = crossCheckEffects({ effects: [{ type: 'state_entered', to: 'state_y' }], before: cap(), after: cap(), toState: 'state_y', observedChange: { url: null } });
check('state_entered agreement is clean', e2.errors, []);
const e3 = crossCheckEffects({ effects: [{ type: 'state_entered', to: 'state_y' }], before: cap({ url: 'http://x/b' }), after: cap({ url: 'http://x/b' }), toState: 'state_y', observedChange: { url: null } });
check('a real navigation with a matching state_entered draws no warning', e3.warnings, []);

// --- warnings -------------------------------------------------------------
const w = (effects, before, after, toState = 'state_y') => crossCheckEffects({ effects, before, after, toState, observedChange: { something: true } }).warnings.map((x) => x.kind);
check('claimed navigation, URL unchanged', w([{ type: 'navigation', to: 'state_y', observed: true }]), ['claimed_navigation_not_observed']);
check('claimed navigation, unmarked as observed, is left alone', w([{ type: 'navigation', to: 'state_y' }]), []);
check('claimed navigation, URL did change', w([{ type: 'navigation', to: 'state_y', observed: true }], cap(), cap({ url: 'http://x/c' })), []);
check('claimed message nobody saw', w([{ type: 'message', message: 'Wrong password' }]), ['claimed_message_not_seen']);
check('claimed message the app really said', w([{ type: 'message', message: 'Wrong password' }], cap(), cap({ status: [{ text: 'Wrong password' }] })), []);
check('claimed message said in the BEFORE capture still counts', w([{ type: 'message', message: 'Wrong password' }], cap({ status: [{ text: 'Wrong password' }] }), cap()), []);
check('claimed request, none seen', w([{ type: 'request', api: 'api_x' }]), ['claimed_request_not_observed']);
check('claimed request, one seen', w([{ type: 'request', api: 'api_x' }], cap(), cap({ network: [{ method: 'GET', url: '/api/x' }] })), []);
check('unclaimed URL change', w([], cap(), cap({ url: 'http://x/c' })), ['unclaimed_url_change']);
check('unclaimed URL change plus state_entered is still unclaimed navigation', w([{ type: 'state_entered', to: 'state_y' }], cap(), cap({ url: 'http://x/c' })), ['unclaimed_url_change']);
check('a change the machinery saw suppresses the nothing-changed warning', w([], cap(), cap()), []);
check('null observedChange is reported as nothing changed', crossCheckEffects({ effects: [], before: cap(), after: cap(), toState: 'state_y', observedChange: null }).warnings.map((x) => x.kind), ['no_observed_change']);
check('a self-loop with a real change is not reported as nothing changed', w([], cap(), cap({ title: 'B' })), []);
check('several disagreements all surface, in effect order', w([{ type: 'navigation', to: 'state_y', observed: true }, { type: 'message', message: 'nope' }, { type: 'request', api: 'api_x' }]), ['claimed_navigation_not_observed', 'claimed_message_not_seen', 'claimed_request_not_observed']);
check('malformed effects are skipped, not fatal', crossCheckEffects({ effects: [null, 'x', 42], before: null, after: null, toState: 'state_y', observedChange: { x: 1 } }), { errors: [], warnings: [] });
check('missing captures do not throw', crossCheckEffects({ effects: [{ type: 'navigation', to: 's', observed: true }], before: undefined, after: undefined, toState: 's', observedChange: { x: 1 } }).warnings.map((x) => x.kind), ['claimed_navigation_not_observed']);

// --- self-loops whose two readings are not the same state ---------------------------
// A state id is bound to the reading made in it, so a self-loop has to look like one state
// twice. Swapping the entire interactive surface for the same id means a reading landed on
// the wrong moment, which shifts every endpoint after it.
const loop = (observedChange, from = 'state_x', to = 'state_x') => crossCheckEffects({
  effects: [], before: cap(), after: cap(), fromState: from, toState: to, observedChange,
}).warnings.map((x) => x.kind);
check('a self-loop whose controls were replaced is reported', loop({ appeared: ['button:Projects', 'button:Log out'], disappeared: ['button:Sign in', 'textbox:Email'] }), ['self_loop_but_controls_changed']);
check('the warning names the controls it compared', crossCheckEffects({
  effects: [], before: cap(), after: cap(), fromState: 's', toState: 's',
  observedChange: { appeared: ['button:Projects'], disappeared: ['button:Sign in'] },
}).warnings[0].detail.includes('button:Sign in'), true);
check('a self-loop that only gained list text is left alone', loop({ appeared: ['generic:New Project', 'generic:New Projectowner'] }), []);
check('controls on one side only is left alone', loop({ appeared: ['button:Projects', 'generic:x'] }), []);
check('the same diff between two different states is left alone', loop({ appeared: ['button:Save'], disappeared: ['button:Add project'] }, 'state_a', 'state_b'), []);
check('a self-loop with no diff reports only the missing change', loop(null), ['no_observed_change']);

// --- what the nothing-changed note is allowed to claim ----------------------
// The note is read by the model at the moment it decides whether its step was real, so
// it is the one piece of prose here worth pinning down. A hedge where a finding is
// available costs a re-read; a finding where the evidence only supports a hedge invents
// one, and a self-loop and a missed render call for opposite responses.
const note = (settle) => crossCheckEffects({
  effects: [], before: cap(), after: cap(), toState: 'state_y', observedChange: null, settle,
}).warnings.find((warning) => warning.kind === 'no_observed_change').detail;
const settled = { waited_ms: 400, quiet_ms: 250, idle_ms: 1000, budget_ms: 3000, changes: 1, in_flight: 0, timed_out: false, watched: true };

check('an unsettled reading keeps the hedge, because for it the hedge is true',
  note(undefined).includes("raced the page's own update"), true);
check('a settled reading reports the finding instead', note(settled).includes('not a race'), true);
check('and stops offering the race as an option', note(settled).includes('raced the page'), false);
check('a page that never stopped moving is not handed over as a finding',
  note({ ...settled, changes: 12, timed_out: true }).includes('still moving'), true);
check('a page that never moved says how long it was watched',
  note({ ...settled, changes: 0 }).includes('nothing moved in it at all'), true);
check('a page that could not be watched does not claim to have been',
  note({ ...settled, watched: false }).includes('MutationObserver'), true);
check('a settle that failed is named in the note',
  note({ error: 'Execution context was destroyed' }).includes('Execution context was destroyed'), true);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
