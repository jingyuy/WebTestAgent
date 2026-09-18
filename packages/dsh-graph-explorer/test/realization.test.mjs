// Phase 1's gate: a behaviour is performed, not just named.
//
// A capability's `composed_of` says which behaviours a composite contains, which is a fact about
// capabilities and leaves a generator exactly where it started — it still needs to know what each
// contained behaviour *is*, and the answer is not in the name. `capability.schema.json` already
// declares where it does live — `steps[]`, "how to realise the capability in the UI. Ordered,
// deterministic" — so this suite drives a real walk through the tools and asserts the whole path:
// the argument, the record in `capabilities.jsonl`, the fold into the committed `steps[]`, and the
// keys that must NOT arrive there.
//
// The refusals matter as much as the fold, and one of them is the reason this suite exists at all:
// a step's `element` is an element ID while the transition's `target` is a bare semantic_purpose. A
// model that writes the same string in both places gets a graph that looks right, a step whose
// element resolves to nothing, and a generated test that cannot find the field.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';
import { ELEMENT_ID_PATTERN, STEP_ACTIONS, normalizeAffordance, normalizeRealizationStep } from '../lib/schema.js';
import { loadAjv } from './ajv.mjs';

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
// The same seam `tools.test.mjs` drives, with two differences that matter. The application is
// DECLARED, because a run with no `application.actors` cannot commit and this suite has to reach a
// written `graph.json`; and the walk is longer, because a realisation is only interesting when one
// behaviour is performed by more than one step.
const cwd = mkdtempSync(join(tmpdir(), 'gx-realization-'));
const tools = new Map();
const handlers = new Map();
let queue = [];

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-realization' } } },
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
        if (expression !== CAPTURE_EXPRESSION) throw new Error('realization.test: an unexpected browser_eval was dispatched');
        const value = queue.length > 1 ? queue.shift() : queue[0];
        return { isError: false, value };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section: () => {} },
};
apply(ctx, Config({
  application: {
    id: 'app_shop',
    name: 'Shop',
    // Two roles, one of them with no prose at all: the registry is a vocabulary, and a role with
    // nothing said about it is still declared.
    actors: [{ id: 'anonymous', description: 'A visitor who has not signed in.' }, { id: 'authenticated' }],
  },
}));

const capture = (over = {}) => ({ url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {}, scroll: {}, network: [], console: [], page_errors: [], ...over });
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);

const logPath = (name) => join(cwd, 'graph-run', name);
const logLines = (name) => (existsSync(logPath(name))
  ? readFileSync(logPath(name), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  : []);

// --- the vocabulary itself ------------------------------------------------
// The two refusals here are the ones the tool's argument schema pre-empts, so they can only be
// reached by calling the normaliser directly. Worth pinning anyway: it is the function the
// vocabulary is declared in, and a future caller that is not the tool would otherwise be the first
// to find out that a list of steps was accepted as one.
check('the step vocabulary is the schema\'s own verbs',
  [STEP_ACTIONS.size, STEP_ACTIONS.has('fill'), STEP_ACTIONS.has('dblclick'), STEP_ACTIONS.has('teleport')],
  [19, true, true, false]);
check('and an element id is the prefixed form',
  [ELEMENT_ID_PATTERN.test('element_email_input'), ELEMENT_ID_PATTERN.test('email_input'), ELEMENT_ID_PATTERN.test('element_login.email')],
  [true, false, true]);
try { normalizeRealizationStep('click the link'); fails++; console.log('FAIL a step that is not a mapping (no error thrown)'); }
catch (error) { check('a step that is not a mapping is refused as a behaviour in disguise', error.message.includes('must be a single step'), true); }
try { normalizeRealizationStep([{ action: 'click' }]); fails++; console.log('FAIL a list of steps (no error thrown)'); }
catch (error) { check('and a list of steps is refused as a behaviour in disguise', error.message.includes('already names'), true); }
check('the normaliser keeps the schema\'s key order and drops nothing it was given',
  Object.keys(normalizeRealizationStep({ description: 'd', timeout_ms: 500, optional: false, effects: [], arguments: {}, value: 'v', element: 'element_e', purpose: 'p', action: 'fill' })),
  ['action', 'element', 'value', 'purpose', 'arguments', 'effects', 'optional', 'timeout_ms', 'description']);

// --- the walk: one behaviour performed by two steps ------------------------
queue = [
  capture({ url: 'http://x/', title: 'Home' }),
  capture({ url: 'http://x/login', title: 'Sign in' }),
  capture({ url: 'http://x/dashboard', title: 'Dashboard' }),
];
await act('browser_open');
await observe({
  page_type: 'home',
  variant: 'anonymous',
  detection: [{ type: 'url' }],
  elements: [{ semantic_purpose: 'login_link', role: 'link', name: 'Sign in' }],
});
await act('browser_click', { selector: '#login' });
const loginReading = await observe({
  page_type: 'login',
  detection: [{ type: 'url' }],
  elements: [
    { semantic_purpose: 'email_input', role: 'textbox', name: 'Email' },
    { semantic_purpose: 'submit_button', role: 'button', name: 'Sign in' },
    // Declared because it is what the affordance below is about: an affordance is a claim about a
    // control, and a control the reading does not declare is one the run has no id for.
    { semantic_purpose: 'forgot_password_link', role: 'link', name: 'Forgot password?' },
  ],
  // The claim the graph cannot hold and cannot derive: this surface offers a way out of the state
  // the walk is in, and this walk is not taking it. D6 in one line.
  affordances: [{ element: 'element_forgot_password_link', expected_behavior: 'reset_password' }],
});

// --- refusals, all of them before the first write -------------------------
// A step of nothing is not a step: `realization` without a behaviour has no answer to "a step of
// what", and the behaviour it is supposed to sit beside does not exist.
const beat = { capability: 'warm_cache', capability_behaviour: 'warm_cache_flow' };
await refuses('a realisation with no behaviour to belong to',
  () => transition({ capability: 'warm_cache', realization: { action: 'click', element: 'element_login_link' } }),
  'realization was given without capability_behaviour');
await refuses('a realisation with no verb at all',
  () => transition({ ...beat, realization: { element: 'element_login_link' } }),
  'is not a browser action');
await refuses('a realisation with a verb the schema does not have',
  () => transition({ ...beat, realization: { action: 'teleport', element: 'element_login_link' } }),
  'is not a browser action');
await refuses('a realisation with a key the schemas do not declare',
  () => transition({ ...beat, realization: { action: 'click', element: 'element_login_link', selector: '#login' } }),
  'has no key');
await refuses('a realisation whose value is not a string',
  () => transition({ ...beat, realization: { action: 'fill', element: 'element_login_link', value: 42 } }),
  'must be a string');
await refuses('a realisation whose timeout is not whole milliseconds',
  () => transition({ ...beat, realization: { action: 'click', element: 'element_login_link', timeout_ms: -1 } }),
  'whole number of milliseconds');
// The near miss, and the one this suite exists for: `login_link` is exactly what `target` wants and
// exactly what a step must not be.
await refuses('a step whose element is written as a bare purpose',
  () => transition({ ...beat, realization: { action: 'click', element: 'login_link' } }),
  'The one argument here that wants the bare purpose is an element-shaped effect');
await refuses('a step naming an element nothing declared',
  () => transition({ ...beat, realization: { action: 'click', element: 'element_checkout_button' } }),
  'is not the id of any element this run has declared');
// A step's `element` and a transition's `target` are one element id in two places — the control the
// capability was applied to — so a call that gives both has to give the same one. Two controls in
// one call is one of them mistyped, and the repair is to drop `target`: the step already names it.
await refuses('an edge whose target and whose step name different controls',
  () => transition({ ...beat, target: 'element_submit_button', realization: { action: 'fill', element: 'element_email_input' } }),
  'are two different controls');
await refuses('a step effect of a type the schema does not have',
  () => transition({ ...beat, realization: { action: 'click', element: 'element_login_link', effects: [{ type: 'shimmer', to: 'x' }] } }),
  'is not one of');
await refuses('a step effect naming an element nothing declared',
  () => transition({ ...beat, realization: { action: 'click', element: 'element_login_link', effects: [{ type: 'value_changed', target: 'element_nope', to: 'x' }] } }),
  'not the semantic_purpose of any element this run has declared');
// Every refusal above says "nothing was recorded", and this is the check that keeps the sentence
// true: the checks run before the first write, so a refused step has not claimed a capability name
// and has not been appended to the walk.
check('every refusal above wrote nothing at all',
  [logLines('capabilities.jsonl').length, logLines('transitions.jsonl').length], [0, 0]);

// --- affordances: the reading, the log, and the refusals ------------------
// An affordance is the one claim in the vocabulary that is about an absence, and the reading is the
// only moment it can be made — so this is where it is checked, refused and recorded. The refusal
// that matters is P13's: the claim names a control, and a control this surface did not declare is a
// claim about a different page.
check('the affordance is reported back in the reading that made it',
  [loginReading.graph.state.affordances, loginReading.graph.affordances_recorded],
  [['element_forgot_password_link'], 1]);
const stateLog = logLines('states.jsonl');
check('and it goes into the log on the reading, not as a record of its own',
  [stateLog.filter((record) => record.kind === 'state').length, stateLog.at(-1).affordances],
  [2, [{ element: 'element_forgot_password_link', expected_behavior: 'reset_password' }]]);
check('a reading that declared none carries no affordances key at all',
  ['affordances' in stateLog[0], stateLog[0].elements.map((element) => element.semantic_purpose)],
  [false, ['login_link']]);

// Every one of these is the same shape of mistake — a claim about a control nothing can resolve —
// and all of them are refused while the login page is still on screen. `writesNothing` below is
// what keeps the "nothing was recorded" in each message true.
//
// Two are missing from the list and are checked against the normaliser instead, because the tool's
// own argument schema refuses them first and with the schema's own words: `affordances` is typed
// `array` and its items `object`, so "not a list" and "not a mapping" never reach the handler. Worth
// pinning anyway, for the reason the step vocabulary's two are: the normaliser is the function the
// vocabulary is declared in, and a caller that is not this tool would otherwise be the first to find
// out that a single affordance was accepted as a list of one.
try { normalizeAffordance([{ element: 'element_submit_button', expected_behavior: 'submit' }]); fails++; console.log('FAIL a list where one affordance belongs (no error thrown)'); }
catch (error) { check('a list of affordances is refused as a list', error.message.includes('must be a mapping'), true); }
try { normalizeAffordance('element_submit_button'); fails++; console.log('FAIL an affordance that is not a mapping (no error thrown)'); }
catch (error) { check('and an affordance that is a string is not one either', error.message.includes('must be a mapping'), true); }

await refuses('an affordance with no page_type to belong to',
  () => observe({ affordances: [{ element: 'element_submit_button', expected_behavior: 'submit' }] }),
  'affordances were given without page_type');
await refuses('an affordances list that is not a list',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: { element: 'element_submit_button', expected_behavior: 'submit' } }),
  'invalid arguments');
await refuses('an affordance with the key that looks right and is not',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ element: 'element_submit_button', expected_behavior: 'submit', confidence: 0.9 }] }),
  'has no key "confidence"');
await refuses('an affordance with no element to be offered by',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ expected_behavior: 'submit' }] }),
  'has no `element`');
await refuses('an affordance with no expected_behavior',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ element: 'element_submit_button' }] }),
  'has no expected_behavior');
// The near miss, and the one a model will write: the element ID is the prefixed form, exactly as it
// is in a step, and the bare purpose is the thing `target` wants.
await refuses('an affordance naming a bare semantic purpose',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ element: 'submit_button', expected_behavior: 'submit' }] }),
  'which is not an element id');
await refuses('an affordance naming an element this reading does not declare',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ element: 'element_checkout_button', expected_behavior: 'checkout' }] }),
  'own elements do not declare');
// The other way the same mistake happens, and it is told apart because the repair is not the same:
// `login_link` is real, and it belongs to `home`. The claim is about the wrong surface.
await refuses('an affordance naming an element another state declares',
  () => observe({ page_type: 'login', detection: [{ type: 'url' }], affordances: [{ element: 'element_login_link', expected_behavior: 'sign_in' }] }),
  'is declared on another state');
check('every affordance refusal above wrote nothing at all, on a page that had nothing wrong with it',
  logLines('states.jsonl').length, stateLog.length);

// --- the two steps --------------------------------------------------------
const first = await transition({
  capability: 'fill_login_email',
  capability_behaviour: 'login',
  // `target` is deliberately NOT passed. It takes the element ID, exactly as a step's `element`
  // does, and the two name one control: passing both is the same string twice, and the step is
  // where this walk states which control the verb acted on. The two checks below say what the edge
  // is recorded with instead.
  realization: {
    action: 'fill',
    element: 'element_email_input',
    value: '{{email}}',
    purpose: 'enter_credentials',
    // The step-scoped effect, which is what lets a multi-step behaviour say which step did the work
    // without re-reading the observations.
    effects: [{ type: 'value_changed', target: 'email_input', to: 'typed' }],
  },
});
check('the step is named after its capability and attached to its behaviour in one call',
  [first.capability.name, first.behaviour.name, first.behaviour.kind, first.behaviour.composed_of],
  ['fill_login_email', 'login', 'composite', ['cap_fill_login_email']]);
check('and the realisation is reported back with the position it was recorded at',
  [first.realization.behaviour.name, first.realization.repeated, first.realization.step.action, first.realization.step.element, first.realization.position],
  ['login', false, 'fill', 'element_email_input', 0]);
// `purpose` and `effects` are the behaviour model's, and neither reaches `graph.json`. Reported
// here so a model can see, in the same answer, that what it said was kept.
check('the realisation that comes back is the whole record, prose and step effects included',
  [first.realization.step.purpose, first.realization.step.effects.map((effect) => effect.type), first.realization.step.value],
  ['enter_credentials', ['value_changed'], '{{email}}']);
// The edge's target, which this call did not pass and the walk still stated. This is the field two
// consumers read and no other: the generator, which needs the control to write an action, and the
// application model's `carriedAsStep`. A live walk that named the control on every step and no
// `target` at all recorded three transitions acting on nothing (`action.target: null` on all three
// of the 0.1.26 sign-in walk), and the generator reported `step_targets_no_element` for every step
// and wrote a spec that could not perform the sign-in it was generated from.
check('the edge is recorded acting on the control the step names, without being told twice',
  [first.transition.target, typeof first.transition.target_note], ['element_email_input', 'string']);
check('and the note says where the id came from rather than leaving the reader to guess',
  first.transition.target_note.includes('taken from realization.element'), true);

await act('browser_click', { selector: '#submit' });
await observe({ page_type: 'dashboard', variant: 'authenticated', detection: [{ type: 'url' }] });
const dashboardStateId = logLines('states.jsonl').at(-1).state_id;
const second = await transition({
  capability: 'submit_login',
  capability_behaviour: 'login',
  target: 'element_submit_button',
  realization: {
    action: 'click',
    element: 'element_submit_button',
    purpose: 'submit',
    // The `to` is the state the run just read, and the tool cross-checks it against `to_state` —
    // which is why this is read from the log rather than guessed.
    effects: [{ type: 'state_entered', to: dashboardStateId }],
  },
});
check('the second step joins the same behaviour and appends to the same composition',
  [second.behaviour.new, second.behaviour.composed_of_added, second.behaviour.composed_of],
  [false, ['cap_submit_login'], ['cap_fill_login_email', 'cap_submit_login']]);
check('and it is a step of the behaviour, not of the capability it names',
  [second.realization.behaviour.capability_id, second.realization.behaviour.name], ['cap_login', 'login']);
check('the position is the walk position, so the two steps are ordered by the walk',
  [first.realization.position, second.realization.position], [0, 1]);
// The other half of the rule: a call that states the control itself is not corrected and not
// commented on, because nothing was supplied that the model did not give.
check('a call that states the control itself produces no note about it',
  [second.transition.target, second.transition.target_note], ['element_submit_button', null]);

// --- the log --------------------------------------------------------------
const capabilityLog = logLines('capabilities.jsonl');
const steps = capabilityLog.filter((record) => record.kind === 'realization_step');
check('two realisation records sit in capabilities.jsonl, beside the vocabulary they belong to',
  steps.length, 2);
check('and each names the behaviour, the edge it is made of, and where in the walk it stands',
  steps.map((record) => [record.capability_id, record.transition_id, record.walk_index, record.action, record.element]),
  [['cap_login', 'transition_fill_login_email', 0, 'fill', 'element_email_input'],
    ['cap_login', 'transition_submit_login', 1, 'click', 'element_submit_button']]);
check('the whole record is kept, including the two keys the graph has no room for',
  [steps[0].purpose, steps[0].effects.map((effect) => effect.type), steps[1].purpose],
  ['enter_credentials', ['value_changed'], 'submit']);
// Three capabilities exist and the log holds six records: the three extra are the composition and
// the two steps. A record kind that leaked into the projection would show up here as a fourth
// capability.
check('the log holds one canonical record per capability, plus the composition and the two steps',
  [capabilityLog.length, capabilityLog.filter((record) => record.kind === 'capability').length,
    capabilityLog.filter((record) => record.kind === 'capability_composition').length], [6, 3, 1]);

// --- the commit and the fold ---------------------------------------------
const verdict = await commit({});
check('the run commits', [verdict.committed, verdict.graph_path !== null], [true, true]);
check('and the report counts the realisation apart from the vocabulary',
  [verdict.counts.capabilities, verdict.counts.realization], [3, { recorded: 2, projected: 2 }]);
// The resolution is a fact about the run that the document cannot hold by itself: the target is in
// the graph, and where its id came from is in the report. `info`, because nothing was inferred —
// the step's element and a transition's target are the same element id.
const resolutionNotes = verdict.warnings.detail.filter((finding) => finding.code === 'target_from_realization');
check('the report says the control was taken from the step, at info, once, for the one call that did not state it',
  resolutionNotes.map((finding) => [finding.severity, finding.basis]), [['info', 'recorder_note']]);
// The affordance is a claim `graph.json` has no room for, and the count is how its absence from the
// document is a stated fact rather than a silent drop. `retired` is the clause that keeps the claim
// falsifiable: it says nobody performed this, so the walk is what settles it.
check('the report counts the affordance the log holds and the document cannot carry',
  verdict.counts.states.affordances, { recorded: 1, surfaces: 1, retired: 0 });

const written = JSON.parse(readFileSync(logPath('graph.json'), 'utf8'));
const byId = Object.fromEntries(written.capabilities.map((capability) => [capability.id, capability]));
check('login is committed as a composite of the two steps',
  [byId.cap_login.kind, byId.cap_login.composed_of], ['composite', ['cap_fill_login_email', 'cap_submit_login']]);
// The fold itself: `capability.schema.json#/$defs/capabilityStep`, in the order the walk performed
// them. This is the Phase 1 gate — `steps[]` is what a generator expands a behaviour with, and
// without it the graph is a vocabulary with no verbs.
check('and carries the realisation as the schema\'s own steps[], in the order they were performed',
  byId.cap_login.steps,
  [
    { action: 'fill', element: 'element_email_input', value: '{{email}}' },
    { action: 'click', element: 'element_submit_button' },
  ]);
// `capabilityStep` sets `additionalProperties: false`. Both dropped keys are the behaviour model's
// and both stay in the log: dropping them here is the projection, not a loss.
check('the step has no `purpose` and no `effects`, because the graph\'s step has no room for them',
  byId.cap_login.steps.map((step) => [step.purpose ?? null, step.effects ?? null]), [[null, null], [null, null]]);
check('a bare capability has no steps key at all, rather than an empty one',
  [byId.cap_fill_login_email.steps ?? null, byId.cap_submit_login.steps ?? null], [null, null]);
check('and a realisation is not committed as a capability',
  written.capabilities.map((capability) => capability.id), ['cap_fill_login_email', 'cap_login', 'cap_submit_login']);
// Both edges, one told and one not, in the document a generator reads: the field is the same either
// way, which is the point — `graph_test` reads the committed graph and nothing else, so a control
// that lived only in the capability log is a control no generated test can press.
const targetById = Object.fromEntries(written.transitions.map((transition) => [transition.id, transition.action.target]));
check('and every committed edge names the control it acted on, whether or not the call did',
  [targetById.transition_fill_login_email, targetById.transition_submit_login],
  ['element_email_input', 'element_submit_button']);
check('nothing named after the record kind reached the graph', JSON.stringify(written).includes('realization_step'), false);
// The other claim the log holds and the document cannot carry, asserted the blunt way: the string
// does not occur anywhere in `graph.json`. 0.1's `state.schema.json` is `additionalProperties:
// false`, so the claim has to be counted in the report or it is a silent drop.
check('and the affordance is not in the document, which is why the report counts it',
  JSON.stringify(written).includes('affordances'), false);
// The application is where the actor vocabulary lives, and the commit is what reads it.
check('the declared actors are carried, and the walk\'s variant is not mistaken for a role',
  written.application.actors, [{ id: 'anonymous', description: 'A visitor who has not signed in.' }, { id: 'authenticated' }]);

// --- the document is one the schema accepts ------------------------------
// The fold is a claim about `capability.schema.json`, so the strongest available check is the schema
// itself. ajv is not a dependency and `npm test` has to pass in a fresh clone, so this is the
// suite's one conditional: every check above stands on its own without it.
const ajvModules = await loadAjv();
if (!ajvModules) {
  console.log('SKIP  ajv is not resolvable from here, so the committed graph was not validated (the steps[] checks above still ran)');
} else {
  const { Ajv2020, addFormats } = ajvModules;
  const schemaDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'schemas', '0.1');
  const schemas = readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json'))
    .map((name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8')));
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false, schemas });
  addFormats(ajv, { mode: 'full' });
  const validate = ajv.getSchema('https://integration-test-generator.local/schemas/0.1/graph.schema.json');
  const ok = validate(written);
  if (!ok) console.log('     ', ajv.errorsText(validate.errors));
  check('the committed graph validates against the vendored 0.1 schema', ok, true);
}

// --- a tampered log is judged, not trusted -------------------------------
// The tool refuses an unknown verb at the call, so the only way to reach the projection's own guard
// is a file this tool did not write. That is the commit's stated posture — it reads the logs, judges
// them, and writes a verdict beside them — and it is what makes `steps[]` a projection rather than a
// copy of whatever is on disk.
appendFileSync(logPath('capabilities.jsonl'), [
  JSON.stringify({ kind: 'realization_step', capability_id: 'cap_login', transition_id: 'transition_tampered', walk_index: 8, action: 'teleport', element: 'element_email_input', first_seen_at: 'x' }),
  JSON.stringify({ kind: 'realization_step', capability_id: 'cap_nope', transition_id: 'transition_orphan', walk_index: 9, action: 'click', element: 'element_email_input', first_seen_at: 'x' }),
  '',
].join('\n'));
const judged = await commit({ force: true });
const codes = judged.warnings.detail.map((finding) => finding.code);
check('a step that is not a step is reported rather than written into the graph',
  codes.includes('realization_step_not_a_step'), true);
check('and a step of a behaviour that does not exist is reported rather than silently dropped',
  codes.includes('realization_does_not_resolve'), true);
const again = JSON.parse(readFileSync(logPath('graph.json'), 'utf8'));
const againLogin = again.capabilities.find((capability) => capability.id === 'cap_login');
check('so the committed behaviour still describes exactly the two steps the walk performed',
  [againLogin.steps.length, againLogin.steps[0].action], [2, 'fill']);
check('and the count where recorded and projected differ is the one that says what happened',
  judged.counts.realization, { recorded: 4, projected: 2 });
check('with the dropped step\'s own account of itself in the graph\'s metadata, not lost',
  againLogin.metadata.extra.realization_dropped, [{ action: 'teleport', transition_id: 'transition_tampered' }]);
// Tampering with the capability log does not touch the reading, and the count is read off the
// readings: a commit that could lose an affordance by losing something else would be reporting a
// fact about the wrong file.
check('and the affordance the readings claimed is still counted, from the log that holds it',
  judged.counts.states.affordances.recorded, 1);

rmSync(cwd, { recursive: true, force: true });

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nall realization checks passed');
