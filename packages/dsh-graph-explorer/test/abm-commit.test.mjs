// Phase 2's gate: one commit, two documents, and the two readings have to agree about the run.
//
// The pivot's fourth decision (D1) is that `graph.json` and `application-model.json` are two
// *readings* of one run rather than a derivation of one from the other, and every consequence of
// that decision is a thing this suite has to be able to falsify:
//
//   * the fallback document may not get worse — `graph.json` is what 0.1.22 wrote and what every
//     existing consumer reads, so the model arriving may not take a key away from it, and its
//     validation is now a *gate* rather than a hope (README gap 8);
//   * the model may not be written when it is wrong — a document nothing downstream reads cannot be
//     wrong in a way that matters (D10), so the profile is checked *before* the write and its
//     errors withhold the file rather than annotating it;
//   * the floor 0.1.22 carried has to still be carried by both — the pivot is a re-reading, not an
//     amnesia, and `login` is still the composite with its steps in walk order;
//   * and the gate and the diagnostic may not drift — `invariantsOf()`'s model rules and Phase 0b's
//     `profileFindings()` are one definition with two readers, and this suite proves it by asking
//     both the same question and comparing the answers, not by reading the source and agreeing
//     with it.
//
// It drives the same seam `realization.test.mjs` drives, for the same reason: the walk has to be
// real for the two documents to be about something.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';
import { candidatesFromRun, modelFromCandidates, profileFindings, profileInvariants } from '../lib/abm.js';
import { loadSchemas, validateDocument } from '../lib/validate.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// --- the harness: one walk, declared application ---------------------------
// Identical in shape to `realization.test.mjs`'s, and for the same reason: an application has to be
// declared or the commit is refused before there is a document to read, and the walk has to be
// longer than one step or there is no composite to re-read as a behaviour.
const cwd = mkdtempSync(join(tmpdir(), 'gx-abm-commit-'));
const tools = new Map();
const handlers = new Map();
let queue = [];

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-abm-commit' } } },
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
        if (expression !== CAPTURE_EXPRESSION) throw new Error('abm-commit.test: an unexpected browser_eval was dispatched');
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
  application: { id: 'app_shop', name: 'Shop', actors: [{ id: 'anonymous' }, { id: 'authenticated' }] },
}));

const capture = (over = {}) => ({ url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {}, scroll: {}, network: [], console: [], page_errors: [], ...over });
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);

const logPath = (name) => join(cwd, 'graph-run', name);
const readDoc = (name) => (existsSync(logPath(name)) ? JSON.parse(readFileSync(logPath(name), 'utf8')) : null);
const logLines = (name) => (existsSync(logPath(name))
  ? readFileSync(logPath(name), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  : []);

// --- the walk --------------------------------------------------------------
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
await observe({
  page_type: 'login',
  detection: [{ type: 'url' }],
  elements: [
    { semantic_purpose: 'email_input', role: 'textbox', name: 'Email' },
    { semantic_purpose: 'submit_button', role: 'button', name: 'Sign in' },
  ],
});
// The state the first call landed in. The walk's own chain says that call was performed from
// `state_home_anonymous` (the click that navigated was never recorded as a transition, so the chain
// still begins at the entry state), which makes `state_login` a state the collapsed edge does not
// name — the reading the move took in the middle of itself, and the step's own effect is where the
// document accounts for it (`P12`, `collapsed_past_a_state`). Read from the log rather than guessed,
// because the tool is what decides which state a call landed in.
const loginStateId = logLines('states.jsonl').filter((record) => record.kind === 'state').at(-1).state_id;
// The behaviour is named for what the user wants (`login`), and the two calls are named for what
// they did (`fill_login_email`, `submit_login`): P1 is exactly this distinction, and a behaviour
// named after the call is the defect the pivot exists for. `capability_input` is declared in the
// same call, because a step binding `{{email}}` is P5 unless the behaviour it is a step of declares
// the parameter.
const fill = await transition({
  capability: 'fill_login_email',
  capability_behaviour: 'login',
  capability_kind: 'composite',
  capability_input: { email: { type: 'string', required: true } },
  target: 'element_email_input',
  feature: 'authentication',
  description: 'Fill in the sign-in form',
  arguments: { email: 'test@example.com' },
  // The same effect list in both places, which is what the tool's own description of `realization`
  // says it is: the edge carries it because that is where 0.1 puts what a call did, and the step
  // carries it because a step is the behaviour's account of itself. One effect is a state and the
  // other an element, because both shapes are shapes the fallback document wrote before the pivot —
  // and the state is the one the collapse hid, which is why the step has to say it: a behaviour that
  // spends two calls to reach a state has to be able to be asked for at the state it starts from.
  effects: [{ type: 'state_entered', to: loginStateId, observed: true }, { type: 'value_changed', target: 'email_input', to: 'test@example.com' }],
  realization: {
    action: 'fill',
    element: 'element_email_input',
    value: '{{email}}',
    purpose: 'enter_credentials',
    effects: [{ type: 'state_entered', to: loginStateId, observed: true }, { type: 'value_changed', target: 'email_input', to: 'test@example.com' }],
  },
});
check('the tool took the arrival the collapse needs a step to record, on the edge and on the step',
  [fill.claimed_effects, fill.realization.step.effects.length, fill.feature],
  [2, 2, 'authentication']);
await act('browser_click', { selector: '#submit' });
await observe({ page_type: 'dashboard', variant: 'authenticated', detection: [{ type: 'url' }] });
const dashboardStateId = logLines('states.jsonl').filter((record) => record.kind === 'state').at(-1).state_id;
const submit = await transition({
  capability: 'submit_login',
  capability_behaviour: 'login',
  target: 'element_submit_button',
  feature: 'authentication',
  description: 'Submit the sign-in form',
  effects: [{ type: 'state_entered', to: dashboardStateId, observed: true }],
  realization: {
    action: 'click',
    element: 'element_submit_button',
    purpose: 'submit',
    effects: [{ type: 'state_entered', to: dashboardStateId, observed: true }],
  },
});
check('and the last call of the behaviour is the one the edge is known by',
  [submit.claimed_effects, submit.graph.transitions_recorded], [1, 2]);

// --- the commit -----------------------------------------------------------
const verdict = await commit({});
// The report is not part of the tool's declared answer (it is written beside the run), so the
// suite reads the file the commit wrote — which is also the only way to check that what a later
// reader will see is what this run decided.
const committed = JSON.parse(readFileSync(logPath('commit_report.json'), 'utf8'));
if (!verdict.model_path) {
  console.log('     ', JSON.stringify({ documents: committed.documents?.model, findings: committed.profile?.findings }, null, 2));
}

// --- clause 1: the fallback document is intact, and it validates ----------
const graph = readDoc('graph.json');
check('the run commits and the graph is written where it always was',
  [verdict.committed, verdict.graph_path !== null, graph !== null], [true, true, true]);

const schemaRoots = { '0.1': loadSchemas(join(root, 'schemas', '0.1')), abm: loadSchemas(join(root, 'schemas', 'abm', '0.2')) };
const graphValidation = validateDocument(graph, schemaRoots['0.1'], 'graph.schema.json', { name: 'graph.json' });
if (!graphValidation.valid) console.log('     ', JSON.stringify(graphValidation.errors, null, 2));
check('and it validates against the vendored 0.1 schema, before it was written as well as after',
  [graphValidation.valid, committed.documents.graph.valid, committed.documents.graph.written],
  [true, true, true]);
// `unchecked` is the honest half of a hand-rolled walker: a keyword it does not apply is a check
// that did not run, and a schema set that has grown one would otherwise pass by being ignored.
check('with nothing in the schema left unchecked', graphValidation.unchecked, []);

// The key paths, against the last 0.1.22 document this repository has: a commit of a real walk,
// kept in `docs/experiments/abm-01/`. The comparison is per collection and over the paths *every*
// record of that collection carries — a path only some records of a kind carry is a fact about that
// run's content (a state that happened to have a `variant`, a capability that happened to have
// `steps[]`), and asserting on those would be asserting that two different applications walk the
// same way. A path every record carried in 0.1.22 and no record carries now is a shape regression,
// and that is what clause 1 means by "no key 0.1.22 carries goes missing".
const keyPaths = (value, prefix, out = new Set()) => {
  if (prefix) out.add(prefix);
  if (Array.isArray(value)) {
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    // `metadata` is the one place Phase 1 deliberately adds keys (the claim level, the producer, the
    // record a step was folded from), and its sub-keys are a fact about the producer rather than
    // about the shape. Everything else is compared to the leaf.
    if (key === 'metadata') out.add(`${prefix}.metadata`);
    else keyPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
};
const alwaysWritten = (document) => {
  const union = new Set();
  for (const [key, value] of Object.entries(document)) {
    if (!Array.isArray(value) || !value.length || value.some((item) => item === null || typeof item !== 'object')) {
      keyPaths(value, key, union);
      continue;
    }
    // A collection of records is compared path by path, over the paths *some* record of that kind
    // carries. Two different walks are two different runs, so a key only one of them happened to
    // populate (`variant` on a state that had one, `effects` on an edge that had one) is a fact
    // about the run and not about the document's shape.
    for (const item of value) keyPaths(item, key, union);
  }
  return union;
};
const baseline = JSON.parse(readFileSync(join(root, '..', '..', 'docs', 'experiments', 'abm-01', 'committed-graph.json'), 'utf8'));
const baselineAlways = alwaysWritten(baseline);
const oursAlways = alwaysWritten(graph);
const missing = [...baselineAlways].filter((path) => !oursAlways.has(path)).sort();
const added = [...oursAlways].filter((path) => !baselineAlways.has(path)).sort();
// Printed rather than asserted: what a walk adds is content, and a reader of a failure wants to see
// both halves of the diff rather than only the half that failed.
if (added.length) console.log('     ', `${added.length} key path(s) this walk has and the 0.1.22 walk did not:`, added.slice(0, 12).join(', '));

// The 0.1.22 walk and this one are two different walks, so the two documents cannot be compared key
// for key: a key is missing from this one exactly when this run recorded nothing for it, and the
// comparison worth making is that *nothing else* is missing. So every path that is missing has to
// be on this list, with the reason it is missing written beside it — a filter would be a rule, and
// a rule about this comparison is exactly what would let a projection defect through.
const NOT_RECORDED = new Map([
  ['application.base_url', 'this run declared no base url, and the commit writes what was declared'],
  ['capabilities.description', 'no capability description was given, and nothing derives one'],
  ['capabilities.input.password', 'this walk declared one input parameter (email), and the graph carries what the behaviour declares'],
  ['journeys.goal', 'no step named a journey, so the walk\'s journey is derived and says `goal_stated: false` instead of inventing a goal'],
  ['states.description', 'no reading described its surface'],
  ['states.detection[].element', 'every detection this run recorded was by url'],
  ['states.detection[].target', 'every detection this run recorded was by url'],
  ['states.elements[].locator', 'the readings named controls by purpose rather than by selector, and a locator is never invented'],
  ['states.identity.dimensions', 'the readings recorded no state variables, so nothing distinguished the states but their type'],
  ['transitions.action.arguments.password', 'this walk made its calls without a password'],
]);
const unexplained = missing.filter((path) => ![...NOT_RECORDED.keys()]
  .some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
check('no key path went missing that this walk did not record', unexplained, []);
check('and the paths that are missing are the ones the list explains',
  missing.filter((path) => [...NOT_RECORDED.keys()].some((prefix) => path === prefix || path.startsWith(`${prefix}.`))).length,
  missing.length);
check('and the collections 0.1.22 wrote are all still there',
  Object.keys(baseline).filter((key) => !(key in graph)), []);

// --- clause 2: the model is written, and it validates ---------------------
const model = readDoc('application-model.json');
check('the model is written beside the graph, and the tool says which file it wrote',
  [model !== null, verdict.model_path, model === null ? null : verdict.model_path.endsWith('application-model.json')],
  [true, join(cwd, 'graph-run', 'application-model.json'), true]);
const modelValidation = validateDocument(model, schemaRoots.abm, 'application-model.schema.json', { name: 'application-model.json' });
if (!modelValidation.valid) console.log('     ', JSON.stringify(modelValidation.errors, null, 2));
check('and it validates against the abm/0.2 schemas',
  [modelValidation.valid, committed.documents.model.valid, committed.documents.model.written, modelValidation.unchecked],
  [true, true, true, []]);
check('the document says what read it and what it was read from',
  [model.schema_version, model.generator.name, model.generator.command],
  ['0.2', 'dsh-graph-explorer', 'abm_projection']);

// --- clause 3: the floor --------------------------------------------------
// What the graph carried in 0.1.22, still carried: the walk, the vocabulary, and the composite with
// its steps in the order a test would perform them. The counts are pinned because a projection that
// silently drops a record is exactly what this clause is for, and the step count is pinned per
// capability because "two steps" is the fact the fold was introduced to make true.
check('the graph still carries the walk it always carried',
  [graph.states.length, graph.transitions.length, graph.capabilities.map((capability) => capability.id)],
  [3, 2, ['cap_fill_login_email', 'cap_login', 'cap_submit_login']]);
const graphLogin = graph.capabilities.find((capability) => capability.id === 'cap_login');
check('and login is still the composite, with its steps in walk order',
  [graphLogin.kind, graphLogin.composed_of, graphLogin.steps],
  ['composite', ['cap_fill_login_email', 'cap_submit_login'],
    [{ action: 'fill', element: 'element_email_input', value: '{{email}}' }, { action: 'click', element: 'element_submit_button' }]]);

// The ABM's version of the same fact, and the half that is new: `realization[]` is how the behaviour
// is performed, and the calls that performed it are no longer offered as behaviours of their own.
const modelLogin = model.behaviors.find((behavior) => behavior.name === 'login');
// P0-1b: and it is no longer called a composite. The walk asked for `login` as a composite of three
// capabilities, which is the pre-pivot spelling of the same three calls the model now carries as
// `realization[]` — and `kind: "composite"` means, in the schema's own words, "the behaviour is
// defined only by composed_of", which is false of this behaviour: its `composed_of` is empty and its
// steps are what defines it. The word is dropped with the composition (D14), and the document states
// no kind of its own, which is where the schema's default applies.
check('the model re-reads login as one behaviour, named for the goal, and offers no call as a behaviour',
  [model.behaviors.map((behavior) => behavior.name), modelLogin.composed_of, 'kind' in modelLogin],
  [['login'], [], false]);
check('with the two steps the walk performed, in the order it performed them',
  modelLogin.realization.map((step) => [step.action, step.element, step.purpose ?? null]),
  [['fill', 'element_email_input', 'enter_credentials'], ['click', 'element_submit_button', 'submit']]);
check('and the parameter the step binds is declared by the behaviour that performs it',
  Object.keys(modelLogin.input ?? {}), ['email']);
// The effects are the step's own account of what its call did, copied from the recorded step — and
// the recorded step names an element-shaped effect's target by `semantic_purpose` (`email_input`),
// which is what the tool's description of `effects` says a caller writes. The document names it by
// id, because every other reference the model makes is an id: a step whose `element` is an id while
// its effect names the same control by purpose is a document with two vocabularies in it, and P4
// refuses the second one. The arrival names a state, which is what `state_entered` is for.
check('and the step\'s effects name a control by id and an arrival by state',
  modelLogin.realization[0].effects.map((effect) => [effect.type, effect.target ?? null, effect.to ?? null]),
  [['state_entered', null, loginStateId], ['value_changed', 'element_email_input', 'test@example.com']]);
// The state the walk stayed on is a surface, and the states the walk passed through are the walk's
// own shape: D5 collapses *calls*, never a state the walk did not stay in.
check('the model carries the surfaces the walk read, and the behaviour is offered from the first',
  [model.states.map((state) => state.identity.page_type), model.states[0].behaviors],
  [['home', 'login', 'dashboard'], ['behavior_login']]);
// D5/D12: the two calls the walk made are one move, because both were made by one behaviour — and the
// edge starts where the invocation started, not where its last call started, or the state the walk
// was standing in when it was asked for `login` would be a state no edge leads to.
check('the two calls are projected as the one move the behaviour performed, and it names the calls it absorbed',
  model.transitions.map((transition) => [transition.from_state, transition.to_state, transition.behavior,
    transition.metadata.extra.collapsed.calls, transition.metadata.extra.collapsed.passed_through]),
  [['state_home_anonymous', 'state_dashboard_authenticated', 'behavior_login',
    ['transition_fill_login_email', 'transition_submit_login'], ['state_login']]]);
// P0-1, on the walk the tool actually took. The edge's `behavior` is `behavior_login` and its
// `realization[]` is the two calls above, so an edge still named and described after the call that
// ended it — `Submit the sign-in form`, the second of the two — is a document whose own two fields
// disagree. The fix is one line of reasoning: the edge is the move, so its prose is the move's, and
// the sentence the surviving call was recorded with is kept where the edge's prose came from rather
// than thrown away.
check('and the edge is named and described as the move, with the call\'s own sentence kept under the collapse',
  [model.transitions[0].name, model.transitions[0].description,
    model.transitions[0].metadata.extra.collapsed.last_call],
  ['login',
    'login performed as one move from state_home_anonymous to state_dashboard_authenticated — 2 recorded call(s): fill_login_email, submit_login. The calls are this behaviour\'s realization[]; the edge is the move they add up to.',
    { id: 'transition_submit_login', description: 'Submit the sign-in form' }]);
// D4: no step claimed a journey name, so the walk's own path is the journey — and P12c has
// something to check either way, which is the only reason the fallback exists.
check('no step named a journey, so the walk is one, and it says it is not a stated goal',
  [model.journeys.length, model.journeys[0].name.startsWith('Derived walk'), model.journeys[0].goal_stated,
    'criticality' in model.journeys[0]],
  [1, true, false, false]);
// The walk made two calls and the behaviour is one edge, and the two calls were one invocation of
// it — so the journey has one turn, naming that one edge. This assertion used to read
// `[['transition_submit_login', true], ['transition_submit_login', true]]`, on the reasoning that
// "the count is the walk's and the edge is the model's". The count was the *calls*', not the walk's:
// a turn of a journey is a move, a move is an invocation, and this walk invoked `login` once. Two
// turns naming one edge is a document that tells a reader the behaviour was performed twice, one
// line above an edge whose `collapsed.invocations` says once. The calls are not lost — they are the
// behaviour's `realization[]`, which is where a reader goes to check them.
check('and it is one turn naming an edge the model has, because the two calls were one invocation',
  model.journeys[0].steps.map((step) => [step.transition, model.transitions.some((transition) => transition.id === step.transition)]),
  [['transition_submit_login', true]]);
// P0-3: that one turn is a turn of a walk, and this is the chain the review asked to be consistent —
// journey step → transition → behaviour → realization. The journey says it starts at
// `state_home_anonymous` and the edge it names starts there; the edge names `login`; `login` is the
// behaviour whose `realization[]` is the two calls the walk made; and the behaviour declares the
// `email` its realization fills, while the turn binds nothing — the walk's *value* lives on the step
// the generator reads it from, so a turn that repeated it would be the second place to say it that
// `journeyStep` refuses to be. Asserted on the recorded walk rather than on a written fixture,
// because the projection is the half that has to keep it true — and the profile check below is why
// it cannot quietly stop being true: the two walk rules and the binding rule are all `error`s, so a
// journey that does not hold together withholds the model instead of annotating it.
const openingTurn = model.journeys[0].steps[0];
const openingEdge = model.transitions.find((transition) => transition.id === openingTurn.transition);
const openingBehavior = model.behaviors.find((behavior) => behavior.id === openingEdge.behavior);
check('and the turn can be followed all the way down: journey → edge → behaviour → realization',
  [model.journeys[0].start_state, openingEdge.from_state, openingBehavior.id,
    openingBehavior.realization.length, openingTurn.arguments ?? null, openingBehavior.input],
  ['state_home_anonymous', 'state_home_anonymous', 'behavior_login', 2, null, { email: { type: 'string', required: true } }]);

// The model re-read from the run, which clause 4 also needs: the same candidates the projection
// took, so the fallback below and the drift test above are both about the document that was written.
const reRead = candidatesFromRun(join(cwd, 'graph-run'));
// D4's fallback cannot be reached through the commit: the commit always reassembles a journey for
// the walk it recorded, so a journeyless document never arrives that way — it arrives from a caller
// who hands the projection a document of its own, which is what the baseline profiler does. The rule
// is exercised here rather than through the tool because this is the only shape in which it happens,
// and the rule is real: P12's `no_journey` is an *error*, so without the fallback a run that claimed
// no goal would be refused by a fact about the run rather than by anything wrong with the model — and
// the way to make that go away would be to record a goal, not to fix the projection.
const journeyless = modelFromCandidates({ ...reRead, journeys: [] });
// Read through a null-guard: the whole point of the check is that a document with edges comes back
// with a journey, so a suite that threw on the missing one would fail without saying which clause of
// the rule went.
const derivedJourney = journeyless.journeys[0] ?? null;
check('a document with edges and no journey projects as the walk it was, so P12 has one to check',
  [journeyless.journeys.length, derivedJourney?.goal_stated ?? null, derivedJourney?.start_state ?? null,
    (derivedJourney?.steps ?? []).map((step) => step.transition)],
  // One step: the fallback is built from the edges the projection has, and the walk's two calls were
  // one invocation of one move, so it names that move once. That is the same fact at the granularity
  // the model kept (D5/D12).
  [1, false, 'state_home_anonymous', ['transition_submit_login']]);

// P1, on the recorded run rather than on a fixture, because the set of values a walk supplied is
// read from the walk: the email this run typed is on the edge's `arguments` (the call's own field to
// value map, which is where the commit records it), and a goal handed to the projection that quotes
// it is a goal that repeats test data. A goal has to come from the record to be judged, so the
// journey candidate is the projected walk's own with a stated goal put on it — everything else,
// including the supplied set, is the run's.
const quoting = modelFromCandidates({
  ...reRead,
  journeys: [{
    ...(reRead.journeys[0] ?? {}),
    goal: 'Sign in as test@example.com.',
    metadata: {
      ...(reRead.journeys[0]?.metadata ?? {}),
      extra: { ...(reRead.journeys[0]?.metadata?.extra ?? {}), goal_stated: true },
    },
  }],
});
check('a goal that quotes a value the recorded run typed is withheld, by the run\'s own supplied set',
  [quoting.journeys.length, quoting.journeys[0]?.goal?.startsWith('Derived goal:') ?? null,
    quoting.journeys[0]?.goal?.includes('test@example.com') ?? null,
    quoting.journeys[0]?.goal_stated ?? null,
    quoting.journeys[0]?.metadata?.extra?.goal_source?.startsWith('withheld:') ?? null],
  [1, true, false, false, true]);
// The control for the rule being evidence and not a word: the same document, the same walk, and a
// goal that repeats nothing it typed is the actor's sentence and is carried as one.
check('while a goal in that same document that quotes nothing the walk typed is carried as stated',
  modelFromCandidates({
    ...reRead,
    journeys: [{
      ...(reRead.journeys[0] ?? {}),
      goal: 'Reach the dashboard the signed-in user sees.',
      metadata: {
        ...(reRead.journeys[0]?.metadata ?? {}),
        extra: { ...(reRead.journeys[0]?.metadata?.extra ?? {}), goal_stated: true },
      },
    }],
  }).journeys[0]?.goal ?? null,
  'Reach the dashboard the signed-in user sees.');

// --- clause 4: nothing either document says is in error, and the two readers agree ---------
const graphInvariants = committed.invariants.filter((result) => result.document === 'graph');
const modelInvariants = committed.invariants.filter((result) => result.document === 'model');
// Claiming one feature covers every object its walk touched, so the rule that was reporting an
// uncovered walk is satisfied rather than merely not blocking — and `blocking` is still empty.
check('the graph\'s rules are all satisfied, and they still are what blocks the commit',
  [graphInvariants.length, graphInvariants.filter((result) => !result.ok).map((result) => result.code), committed.blocking],
  [13, [], []]);
const profileErrors = committed.profile.findings.filter((finding) => finding.severity === 'error');
if (profileErrors.length) console.log('     ', JSON.stringify(profileErrors, null, 2));
check('the profile finds nothing in error, so the model was written rather than annotated',
  [profileErrors.length, committed.profile.errors, committed.documents.model.blockers],
  [0, 0, []]);
// A rule the model adds may never take the fallback document away: `blocking` is about `graph.json`
// and says so, and the two documents are two readings of one run (D1).
check('and no model rule is a blocker of the graph',
  [graphInvariants.length + modelInvariants.length, committed.invariants.filter((result) => /^P\d+$/.test(result.code)).length],
  [28, 15]);

// --- clause 4b: every reference says what it is evidence for ----------------------------------
// §P1's evidence granularity, asserted on the document that was written rather than on a hand-built
// fixture. The references were always attached to the right claims; what was missing was the words —
// and what the review found was one journey carrying nine references and nine identical notes, with
// nothing saying which step any of them documented. `commit.js` writes them: the session's own note
// kept on the capability, the store's own word for a state, the storage key on a persistence effect,
// and the step on each of a journey's references.
const references = [
  ...model.behaviors.flatMap((behavior) => (behavior.evidence ?? []).map((ref) => ['behaviors', behavior.id, ref])),
  ...model.transitions.flatMap((transition) => (transition.evidence ?? []).map((ref) => ['transitions', transition.id, ref])),
  ...model.journeys.flatMap((journey) => (journey.evidence ?? []).map((ref) => ['journeys', journey.id, ref])),
  ...model.states.flatMap((state) => (state.evidence ?? []).map((ref) => ['states', state.id, ref])),
  ...model.state_variables.flatMap((variable) => (variable.evidence ?? []).map((ref) => ['state_variables', variable.name, ref])),
];
check('every reference in the written model names a kind of reading, and says what it is evidence for',
  references.filter(([, , ref]) => !ref?.role || typeof ref.note !== 'string' || !ref.note.trim()),
  []);
check('and a journey\'s references say which step of the walk each reading documents',
  [model.journeys.length,
    model.journeys.every((journey) => (journey.evidence ?? []).length >= 3
      && journey.evidence.every((ref) => /read for step \d+ of this journey \(transition_[a-z_]+, cap_[a-z_]+\)/.test(String(ref.note))))],
  [1, true]);

// The drift test, and the reason this suite exists rather than a unit test of either half: the
// commit's model rules are read from a document it assembled in memory, and this reads the document
// that was *written* and asks the second implementation the same question. Same findings, same
// order, same detail — an identity, not a resemblance. If the gate and the diagnostic could drift,
// this is where it would show.
const reprojected = modelFromCandidates(reRead);
const driftFindings = profileFindings(reprojected, { candidates: { transitions: reRead.transitions, capabilities: reRead.capabilities } });
check('re-reading the written model reproduces the profile the commit reported',
  driftFindings, committed.profile.findings);
check('and the commit\'s own gate on those findings is the shared bridge, not a second opinion',
  profileInvariants(driftFindings), modelInvariants);
// Which is only worth asserting if the bridge is answering rather than agreeing by accident: a
// single error-severity finding has to move `ok`, in the same place, for the rule that reported it.
check('every model rule\'s ok is exactly "no error finding of that rule"',
  modelInvariants.map((result) => [result.code, result.ok,
    !committed.profile.findings.some((finding) => finding.rule === result.code && finding.severity === 'error')]),
  modelInvariants.map((result) => [result.code, result.ok, result.ok]));
check('and each rule says how many findings it is about, and which rule they were',
  modelInvariants.map((result) => [result.code, result.findings]),
  modelInvariants.map((result) => [result.code, committed.profile.findings.filter((finding) => finding.rule === result.code).length]));

// --- clause 5: the collapse rule refuses a hidden state, and not an endpoint ------------------
// The walk above covers one shape of this rule and not the other. Its collapse hides a state that is
// neither endpoint — `state_login`, which a step of the behaviour accounts for — and that is the
// shape the rule is for. The other shape is the one it used to refuse wrongly: a call that stays
// where the walk already stood puts that state in `passed_through`, and that state is then the
// surviving edge's own `from_state`. The live sign-in walk of 2026-09-18 is exactly that — the demo
// app's form is on the page the walk begins on, so both fills are self-loops and the collapsed edge
// goes `state_home_anonymous → state_home_authenticated`, passing through the state it starts from —
// and the model was withheld for it, with a demand that no honest step can meet: the walk never
// entered that state, it was already in it. Here the shape is built by hand, because a walk cannot
// be asked to produce a middle state it never read.
const collapseModel = (passed, entered) => ({
  schema_version: 'abm/0.2',
  application: { name: 'x', actors: [{ id: 'actor_user', name: 'user' }] },
  states: ['a', 'b', 'c'].map((name) => ({ id: `state_${name}`, identity: { page_type: name, dimensions: {} }, behaviors: ['behavior_go'] })),
  behaviors: [{
    id: 'behavior_go', name: 'go', kind: 'interaction', actors: ['actor_user'], states: ['state_a', 'state_c'],
    realization: [{
      action: 'click', element: 'element_x', purpose: 'go',
      effects: entered ? [{ type: 'state_entered', to: 'state_b' }] : [],
    }],
  }],
  transitions: [{
    id: 'transition_go', from_state: 'state_a', to_state: 'state_c', behavior: 'behavior_go',
    action: { capability: 'cap_go', target: 'element_x' }, effects: [], evidence: [],
    metadata: { extra: { collapsed: { passed_through: passed, calls: ['transition_one', 'transition_two'] } } },
  }],
  journeys: [{ id: 'journey_go', name: 'go somewhere', steps: [{ transition: 'transition_go' }] }],
});
const collapsedStates = (passed, entered) => profileFindings(collapseModel(passed, entered))
  .filter((finding) => finding.code === 'collapsed_past_a_state')
  .map((finding) => finding.detail);
check('a state the collapse passed through that the edge does not name, and no step explains, is refused',
  collapsedStates(['state_b'], false).map((detail) => detail.includes('went through state_b')), [true]);
check('the same state is explained rather than refused when a step says the behaviour arrived there',
  collapsedStates(['state_b'], true), []);
check('and a state the edge itself names is not refused, however the walk got there',
  collapsedStates(['state_a', 'state_c'], false), []);

rmSync(cwd, { recursive: true, force: true });

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nall abm commit checks passed');
