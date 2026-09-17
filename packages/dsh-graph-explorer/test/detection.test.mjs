/**
 * The claims a reading carries, checked while the page that would bear them out is still open.
 *
 * Every case here is a finding from a real exploration of the demo app — the walk that signed in
 * with `test@example.com`, recorded nine findings, and produced a graph whose login steps assert
 * less than the model thought it had written. The shape they all share is the important thing:
 *
 *   the tool accepted a claim, wrote it to the log, and the *commit* refused or dropped it
 *   minutes later, when the page it described was gone and the correction had nowhere to land.
 *
 * The commit was never wrong about any of them; it simply ran too late to be useful. So each
 * case below is the same question asked twice — once by the commit, which is where the rule
 * lives, and once by the recording tool, which is where the model still is. What is asserted is
 * the second answer: a refusal that names the thing to fix, or a note that goes into the digest
 * beside the reading it is about.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};
const refuses = async (label, fn, expectedFragment) => {
  try { await fn(); fails++; console.log('FAIL', label, '(no error thrown)'); }
  catch (error) {
    const ok = String(error.message).includes(expectedFragment);
    if (!ok) { fails++; console.log('FAIL', label, '\n  message ', error.message, '\n  expected to contain', expectedFragment); }
    else console.log('ok  ', label);
  }
};

// --- fake harness ---------------------------------------------------------
// The application is declared, unlike `tools.test.mjs`, because this suite ends in a graph that
// is supposed to commit: the point of the last block is that the committed state carries the
// detection the model wrote, and a blocked commit writes no graph to look at.
const cwd = mkdtempSync(join(tmpdir(), 'gx-detection-'));
const tools = new Map();
const handlers = new Map();
let queue = [];

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-detection' } } },
};

const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    execute: async (call) => {
      if (call.name === 'browser_eval') {
        const expression = call.arguments?.expression;
        if (expression === SETTLE_EXPRESSION) {
          return { isError: false, value: { waited_ms: 0, quiet_ms: 250, idle_ms: 1000, budget_ms: 3000, changes: 0, in_flight: 0, timed_out: false, watched: true } };
        }
        if (expression !== CAPTURE_EXPRESSION) {
          throw new Error('detection.test: an unexpected browser_eval was dispatched by the collector');
        }
        return { isError: false, value: queue.length > 1 ? queue.shift() : queue[0] };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section: () => {} },
};
apply(ctx, Config({ application: { id: 'app_acme', name: 'Acme' } }));

const capture = (over = {}) => ({
  url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {},
  scroll: {}, network: [], console: [], page_errors: [], ...over,
});
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);
const log = (file) => readFileSync(join(cwd, 'graph-run', file), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

// --- the pages ------------------------------------------------------------
// The login screen as the collector captures it: identity is role + name, and the value inside a
// field is the field's state, not its name. The password is `[set]` the moment anything is typed
// into it, because that is what `capture.js` records — the graph is a durable artefact and a
// credential in it outlives the run.
const signIn = (email, password) => capture({
  url: 'http://x/login',
  title: 'Sign in',
  interactive: [
    { role: 'textbox', name: 'Email', selector: '#email', value: email },
    { role: 'textbox', name: 'Password', selector: '#password', value: password },
    { role: 'button', name: 'Sign in', selector: '#signin' },
  ],
});

const LOGIN_ELEMENTS = [
  { semantic_purpose: 'email_input', role: 'textbox', name: 'Email', locator: '#email' },
  { semantic_purpose: 'password_input', role: 'textbox', name: 'Password', locator: '#password' },
  { semantic_purpose: 'sign_in_button', role: 'button', name: 'Sign in', locator: '#signin' },
];

// --- step 1: the entry screen --------------------------------------------
queue = [capture({ url: 'http://x/', title: 'Home' }), signIn('', ''), signIn('test@example.com', ''), signIn('test@example.com', '[set]')];
await act('browser_open');
await observe({ page_type: 'home', detection: [{ type: 'url' }] });

await act('browser_click', { selector: '#login_link' });

// --- the entry form: what the commit would have dropped ------------------
// The live run wrote `{"type":"element_state","target":"sign_in_button","state":"visible"}`. The
// condition is real, the element is real, and the key is not one any reader of an assertion
// looks at: `normalizeAssertion` takes the operator from `operator` and the value from
// `value`/`expected`, so `state` was read by nothing and the entry was dropped at commit —
// `detection_dropped`, twice, with the page that could have said otherwise long gone.
await refuses('a detection whose condition is in a key nothing reads is refused where the page still is',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }, { type: 'element_state', target: 'sign_in_button', state: 'visible' }], elements: LOGIN_ELEMENTS }),
  'operator');
check('and the refusal says what the entry meant and what to write instead',
  await (async () => {
    try { await observe({ page_type: 'login', detection: [{ type: 'element_state', target: 'sign_in_button', state: 'visible' }], elements: LOGIN_ELEMENTS }); return null; }
    catch (error) { return error.message; }
  })().then((message) => message.includes('sign_in_button') && message.includes('"operator":"visible"')), true);

await refuses('a detection on an element no state declared is refused, naming the ones that are',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }, { type: 'element_state', target: 'login_form', operator: 'exists' }], elements: LOGIN_ELEMENTS }),
  'email_input');

check('a refused reading erases nothing, because it recorded nothing',
  log('states.jsonl').length, 1);

// --- the entry form: the forms that do survive ---------------------------
// Both spellings of a target are the model's, and both are real: the tool's own "a state with no
// detection cannot be asserted" message invites the object form, while `normalizeAssertion`
// resolved only the bare string — so an entry the model was *told* to write was dropped at
// commit with nothing to say it had been. One resolver, shared by the tool and the commit, is
// the fix; the committed graph at the end of this suite is where it is checked.
const entry = await observe({
  page_type: 'login',
  detection: [
    { type: 'url' },
    { type: 'element_state', target: { semantic_purpose: 'sign_in_button' }, operator: 'exists' },
    { type: 'element_state', target: 'email_input', operator: 'visible' },
  ],
  elements: LOGIN_ELEMENTS,
});
check('the object form the protocol invites is accepted, and the string form beside it',
  [entry.graph.state.state_id, entry.graph.state.new], ['state_login', true]);
check('and the reading raises nothing about its own claims', entry.reading_notes, []);

const entryStep = await transition({
  capability: 'go_to_login',
  capability_kind: 'navigation',
  effects: [{ type: 'navigation', to: 'state_login', observed: true }],
});
check('the step is recorded with no chain break', [entryStep.chain_break, entryStep.disagreements], [null, []]);

// --- step 2: fill the email field ---------------------------------------
await act('browser_type', { selector: '#email', text: 'test@example.com' });

// `filled` for a field the capture records as `test@example.com`: a summary rather than a
// mistake, so it is reported and not refused — the same conclusion the commit reaches, where the
// entry is carried as written with an `info` finding. The identity is the other matter: this
// reading differs from the previous one only in what the field holds, so minting a state for it
// reports the app as being in a state it is not in.
const typed = await observe({
  page_type: 'login',
  dimensions: { email: 'filled' },
  detection: [{ type: 'url' }, { type: 'element_value', target: 'email_input', value: 'filled' }],
  elements: LOGIN_ELEMENTS,
});
check('a value the capture contradicts is reported, under the code the commit uses',
  typed.reading_notes.map((note) => note.kind), ['detection_value_not_in_evidence', 'identity_read_from_element_state']);
check('and the report quotes both the claim and the reading',
  [typed.reading_notes[0].detail.includes('"filled"'), typed.reading_notes[0].detail.includes('"test@example.com"')], [true, true]);
check('the diff the note is about is the fields and nothing else',
  Object.keys(typed.changed_since_previous_observation), ['changed']);
check('and the identity note says which state the reading should have been read as',
  typed.reading_notes[1].detail.includes('state_login'), true);

// The live run's second finding, from the other side: `{"type":"value_changed","target":
// "login.email"}`. `login.email` reads like a field of the login capability and is not an
// element — a path-shaped target for an element-shaped effect. The commit drops the whole
// effect (`element_target_does_not_resolve`), so a form-fill step arrives in the graph as a step
// that changed nothing. Refused here instead, while the model can still see what it wrote on the
// state it wrote it on.
await refuses('an element-shaped effect naming a path is refused, because the commit would drop it',
  () => transition({ capability: 'fill_login_password', effects: [{ type: 'value_changed', target: 'login.email', to: 'test@example.com' }] }),
  'semantic_purpose');
check('and the refusal quotes the elements the run has declared',
  await (async () => {
    try { await transition({ capability: 'fill_login_password', effects: [{ type: 'value_changed', target: 'login.email', to: 'x' }] }); return null; }
    catch (error) { return error.message; }
  })().then((message) => message.includes('email_input') && message.includes('value_changed')), true);

// The live run's last finding, and the one the commit never saw because it never looked: a
// capability signature the schema refuses — `{password: {type: "string", required: true,
// sensitive: true}}`. `argumentValueSpec` sets `additionalProperties: false`, so the document
// was INVALID while `graph_commit` reported `ok: true`. Nothing between the call and the
// committed file ever re-read the value, so this is the only place it can be caught.
await refuses('a capability signature the schema would refuse is refused before the capability is written',
  () => transition({ capability: 'fill_login_email', capability_input: { password: { type: 'string', required: true, sensitive: true } } }),
  'sensitive');

const typedStep = await transition({
  capability: 'fill_login_email',
  capability_input: { email: { type: 'string', required: true } },
  effects: [{ type: 'value_changed', target: 'email_input', to: 'test@example.com' }],
});
check('a corrected signature is written as the capability\'s first sighting',
  log('capabilities.jsonl').find((record) => record.name === 'fill_login_email').input,
  { email: { type: 'string', required: true } });
check('and nothing of the refused one survives anywhere in the log',
  readFileSync(join(cwd, 'graph-run', 'capabilities.jsonl'), 'utf8').includes('sensitive'), false);

// --- step 3: fill the password field ------------------------------------
await act('browser_type', { selector: '#password', text: 'password123' });

// The worst of the three, because the finding it produces looks like a passing graph: a
// detection asserting a literal against a field the collector masks as `[set]` can never hold,
// in this reading or any other. Refused rather than reported — a summary (`filled`) is
// judgement, and this is not.
await refuses('a literal written against a masked field is refused, not reported',
  () => observe({ page_type: 'login', dimensions: { email: 'filled' }, detection: [{ type: 'url' }, { type: 'element_value', target: 'password_input', value: 'password123' }], elements: LOGIN_ELEMENTS }),
  '"operator":"exists"');
check('and the refusal says where the "[set]" comes from rather than quoting the secret',
  await (async () => {
    try { await observe({ page_type: 'login', dimensions: { email: 'filled' }, detection: [{ type: 'element_value', target: 'password_input', value: 'password123' }], elements: LOGIN_ELEMENTS }); return null; }
    catch (error) { return error.message; }
  })().then((message) => [message.includes('[set]'), message.includes('password123')]), [true, false]);

const filled = await observe({
  page_type: 'login',
  dimensions: { email: 'filled' },
  detection: [{ type: 'url' }, { type: 'element_value', target: 'password_input', operator: 'exists' }],
  elements: LOGIN_ELEMENTS,
});
check('the assertable version of that claim is accepted, and reuses the state',
  [filled.graph.state.state_id, filled.graph.state.new], [typed.graph.state.state_id, false]);
check('a reused state mints nothing, so it has no identity to caution about', filled.reading_notes, []);

// `[set]` is the capture's own word for it, which is how the step can say the field changed
// without the graph carrying the credential that changed it.
const passwordStep = await transition({
  capability: 'fill_login_password',
  effects: [{ type: 'value_changed', target: 'password_input', to: '[set]' }],
});
check('the password step records its effect on the field, not on a path', passwordStep.chain_break, null);

// --- step 4: the click that moved the screen, and the reading that missed it ---
// This is the failure the live sign-in run actually produced, and it is the one that cost it the
// whole graph. The click authenticated the session; the model read the dashboard and named the
// state it had been standing on a moment earlier, with the login form's own detection on it.
// `graph_observe` accepted that — which state a page is, is the model's judgement, and a reading
// is allowed to be wrong — and the reading was bound to a capture of the *dashboard*. From then
// on the login state had a reading that refuted its own detection, so the commit dropped the
// detection and refused the document with `state_without_detection`: a walk that drove the
// application correctly, and a run with nothing to show for it.
//
// The claim is what makes this different from a wrong identity: a detection is checked against
// every reading bound to its state, and the capture that refutes it is already written, so the
// claim can never become true. Refusing it is not a judgement about the identity — it is the
// observation that this reading and that claim cannot both be evidence for one state.
const dashboard = () => capture({
  // The same route the form was on: the demo app is a single page, and the sign-in click replaces
  // the screen without navigating. Nothing about this case turns on the URL.
  url: 'http://x/login',
  title: 'Projects',
  interactive: [
    { role: 'button', name: 'Projects', selector: '#nav-projects' },
    { role: 'button', name: 'Settings', selector: '#nav-settings' },
    { role: 'button', name: 'Log out', selector: '#logout' },
  ],
  storage: { 'acme-demo-state': '{"user":"test@example.com"}' },
});

const DASHBOARD_ELEMENTS = [
  { semantic_purpose: 'logout_button', role: 'button', name: 'Log out', locator: '#logout' },
];

// The last entry of the queue is the page the collector is standing on, so moving to the
// dashboard is a replacement rather than an append: the fake serves `queue.shift()` while more
// than one capture is queued, and `queue[0]` once one is left.
queue = [dashboard()];
await act('browser_click', { selector: '#signin' });

await refuses('a reading named after the page the action was taken on is refused when the action moved the page',
  () => observe({
    page_type: 'login',
    detection: [{ type: 'url' }, { type: 'element_state', target: 'sign_in_button', operator: 'exists' }],
    elements: LOGIN_ELEMENTS,
  }),
  'detection_refuted_by_evidence');
check('and the refusal shows the page the reading is really on',
  await (async () => {
    try {
      await observe({ page_type: 'login', detection: [{ type: 'element_state', target: 'sign_in_button', operator: 'exists' }], elements: LOGIN_ELEMENTS });
      return null;
    } catch (error) { return error.message; }
  })().then((message) => [message.includes('"sign_in_button"'), message.includes('button:Log out')]), [true, true]);
check('and the refusal erases nothing, because it recorded nothing', log('states.jsonl').length, 4);

const signedIn = await observe({
  page_type: 'dashboard',
  variant: 'authenticated',
  detection: [{ type: 'element_state', target: 'logout_button', operator: 'visible' }],
  elements: DASHBOARD_ELEMENTS,
});
check('the same page read as itself is accepted, and is a state of its own',
  [signedIn.graph.state.state_id, signedIn.graph.state.new, signedIn.reading_notes],
  ['state_dashboard_authenticated', true, []]);

// The same rule in the other direction: `absence` wants the element gone, so a capture that has
// it refutes the claim just as flatly.
await refuses('an absence claim the capture contradicts is refused too',
  () => observe({ page_type: 'dashboard', variant: 'authenticated', detection: [{ type: 'absence', target: 'logout_button' }], elements: DASHBOARD_ELEMENTS }),
  'is gone');

// And the third case: a declaration that says nothing about how to find the element. The commit's
// own predicate answers `false` for every such claim — there is no role and name to match on and
// no locator — so a detection on it arrives refuted, the entry is dropped, and a state whose only
// detection that was is refused. Uncheckable and false look the same to the graph, so the tool
// says which one it is.
await refuses('a claim on an element the declaration never located is refused as uncheckable',
  () => observe({
    page_type: 'dashboard',
    variant: 'authenticated',
    detection: [{ type: 'element_state', target: 'project_card', operator: 'exists' }],
    elements: [...DASHBOARD_ELEMENTS, { semantic_purpose: 'project_card' }],
  }),
  'how to find it');

const signedInStep = await transition({
  capability: 'login',
  capability_kind: 'interaction',
  effects: [{ type: 'element_created', target: 'logout_button' }],
});
check('and the step over it is an edge into the state the action produced',
  [signedInStep.chain_break, signedInStep.disagreements], [null, []]);

// --- the whole run, committed --------------------------------------------
// The point of all of it: a graph in which nothing the model wrote was quietly dropped, and a
// state that carries the detection it was recorded with — including the entry written in the
// object form, which the commit resolved because it and the tool now share one resolver.
const verdict = await commit({});
check('the run commits', [verdict.committed, verdict.blocked_by], [true, []]);
check('no detection was dropped at commit — the finding that started this',
  verdict.warnings.detail.filter((finding) => finding.code === 'detection_dropped'), []);
check('no effect was dropped at commit, either',
  verdict.warnings.detail.filter((finding) => finding.code === 'effects_dropped'), []);
check('and no detection in the committed graph is refuted by its own evidence — the finding that cost the live run its graph',
  verdict.warnings.detail.filter((finding) => finding.code === 'detection_refuted_by_evidence'), []);
check('the value the capture contradicts is carried, and reported as a note',
  [...new Set(verdict.warnings.detail.filter((finding) => finding.code === 'detection_value_not_in_evidence').map((finding) => finding.severity))], ['info']);
check('the identity minted from a form\'s progress is reported, as a warning',
  [...new Set(verdict.warnings.detail.filter((finding) => finding.code === 'identity_read_from_element_state').map((finding) => finding.severity))], ['warning']);
check('and nothing about this run is an error', verdict.warnings.errors, 0);

const graph = JSON.parse(readFileSync(join(cwd, 'graph-run', 'graph.json'), 'utf8'));
const byId = new Map(graph.states.map((state) => [state.id, state]));
const detectionOf = (id) => (byId.get(id)?.detection ?? []).map((entry) => entry.element ?? entry.expected);
check('the login state carries both forms of the element claim, as element ids',
  detectionOf('state_login'), ['/login', 'element_sign_in_button', 'element_email_input']);
check('the state minted out of the form\'s progress carries the value as written',
  (byId.get(typed.graph.state.state_id)?.detection ?? []).filter((entry) => entry.element === 'element_email_input'),
  [{ type: 'element_value', element: 'element_email_input', operator: 'equals', expected: 'filled' }]);
check('every state in the graph can be asserted',
  graph.states.filter((state) => (state.detection ?? []).length === 0).map((state) => state.id), []);
check('the capability that was refused once is in the vocabulary with the signature it was given',
  graph.capabilities.find((item) => item.id === 'cap_fill_login_email')?.input, { email: { type: 'string', required: true } });
check('and the fill steps are edges with their effects intact',
  graph.transitions.map((edge) => [edge.action.capability, (edge.effects ?? []).map((effect) => effect.type)]),
  [['cap_go_to_login', ['navigation']], ['cap_fill_login_email', ['value_changed']], ['cap_fill_login_password', ['value_changed']], ['cap_login', ['element_created']]]);
check('and the page the mislabelled reading was on is in the graph as the state it is',
  [...byId.keys()].sort(),
  ['state_dashboard_authenticated', 'state_home', 'state_login', 'state_login_email_filled']);
check('and the login state still asserts the form it was read as, refuted by nothing',
  detectionOf('state_login').includes('element_sign_in_button'), true);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
