import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';
import { losslessPaths } from './lossless.mjs';

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
const cwd = mkdtempSync(join(tmpdir(), 'gx-tools-'));
const tools = new Map();
const handlers = new Map();
const sections = [];
const logs = [];
let queue = [];           // capture values served to browser_eval, in order

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-test' } } },
};

const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    execute: async (call) => {
      if (call.name === 'browser_eval') {
        // The recorder dispatches two evaluations around every action: the settle that
        // waits for the page to stop moving, and the reading itself. Only the reading is
        // served a queued capture — the queue is this test's script of what the page
        // looks like, and the settle is not asking about the page, only about its clock.
        const expression = call.arguments?.expression;
        if (expression === SETTLE_EXPRESSION) {
          return { isError: false, value: { waited_ms: 0, quiet_ms: 250, idle_ms: 1000, budget_ms: 3000, changes: 0, in_flight: 0, timed_out: false, watched: true } };
        }
        if (expression !== CAPTURE_EXPRESSION) {
          throw new Error('tools.test: an unexpected browser_eval was dispatched by the collector');
        }
        const value = queue.length > 1 ? queue.shift() : queue[0];
        return { isError: false, value };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section: (section) => sections.push(section) },
};
apply(ctx, Config({ }));

const capture = (over = {}) => ({ url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {}, scroll: {}, network: [], console: [], page_errors: [], ...over });
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);
const generate = (args) => tools.get('graph_test').execute(args, exec);

// The one thing about a walk that no browser can witness: what the run was asked to do. It arrives
// from `agent/pre-step` before the first action, it is written into `run.json` once, and the commit
// quotes it from there — so firing it here is the whole path an instruction travels.
await handlers.get('agent/pre-step')({ messages: [{ content: [{ type: 'text', text: 'Log in and check the dashboard.' }] }] }, async () => ({}));

// --- registration ---------------------------------------------------------
check('all four tools registered', [...tools.keys()].sort(), ['graph_commit', 'graph_observe', 'graph_test', 'graph_transition']);
check('protocol section contributed', sections.map((s) => [s.name, s.order]), [['graph:exploration-protocol', 150]]);
check('protocol teaches the transition tool', sections[0].text.includes('graph_transition'), true);
check('protocol teaches where the run ends', sections[0].text.includes('graph_commit'), true);
// Two runs recorded a transition for their first action and were refused: the procedure said to
// record a transition for every step, and the rule that the first one has no state to move between
// was only in the tool description. A procedure whose first iteration is not the procedure.
check('protocol says the first action is a step, not a transition', sections[0].text.includes('The first action of a run is a step, not a transition'), true);
// And two runs wrote the page_type where a state id was meant, because the paragraph that defines
// `target` as a semantic name left `to` undefined for `state_entered`.
check('protocol says what state_entered\'s `to` is', sections[0].text.includes('**state id**'), true);

// --- refusals before anything has happened --------------------------------
await refuses('observe with no evidence', () => observe({}), 'nothing to interpret');
await refuses('transition with no evidence', () => transition({ capability: 'login' }), 'no transition to record');

// --- step 1: home ---------------------------------------------------------
// The opening capture carries the request the document loaded with, because the
// hooks are in place before the document runs. There is no earlier capture to diff
// it against, so this is the one step where the digest reports it as the entry
// document — the requests that got the run started are evidence in their own right,
// not a difference from something.
queue = [
  capture({
    url: 'http://x/',
    title: 'Home',
    hooks_installed_at: 'document_start',
    network: [{ method: 'GET', url: '/api/session', status: 200 }],
    // The two key names a page carries without showing: a session identifier and a cookie. Names
    // only — a value is a credential, and a credential is not evidence about a screen — but the
    // names are, because two screens of one application rarely share them.
    storage: { theme: 'dark' },
    session_storage_keys: ['step'],
    cookie_names: ['sid'],
  }),
  capture({ url: 'http://x/login', title: 'Sign in' }),
];
await act('browser_open');
await refuses('transition before any state was read', () => transition({ capability: 'go_to_login' }), 'the first browser action establishes the entry state');
await refuses('observe rejects a state with no detection', () => observe({ page_type: 'home' }), 'no detection');
await refuses('observe rejects an unknown detection type', () => observe({ page_type: 'home', detection: [{ type: 'vibes' }] }), 'not one of');
await refuses('observe rejects an element with no semantic_purpose', () => observe({ page_type: 'home', detection: [{ type: 'url' }], elements: [{ role: 'link' }] }), 'semantic_purpose');
const s1 = await observe({ page_type: 'home', variant: 'anonymous', detection: [{ type: 'url' }], elements: [{ semantic_purpose: 'login_link', role: 'link' }] });
check('state recorded', [s1.graph.state.state_id, s1.graph.states_recorded], ['state_home_anonymous', 1]);
check('the instruction the host supplied is in run.json, which is the only place intent was written',
  JSON.parse(readFileSync(join(cwd, 'graph-run', 'run.json'), 'utf8')).instruction, 'Log in and check the dashboard.');

// --- how the run began ----------------------------------------------------
check('the first observation reports the entry document', [s1.entry_document.url, s1.entry_document.title], ['http://x/', 'Home']);
check('with the requests it loaded with', s1.entry_document.requests, [{ method: 'GET', url: '/api/session', status: 200 }]);
check('and whether the collector was there in time', [s1.hooks_installed_at, s1.entry_document.hooks_installed_at], ['document_start', 'document_start']);
check('there was no earlier capture, so there is no diff to confuse it with', s1.changed_since_previous_observation, null);
check('the marker is in the evidence, not only in the digest', JSON.parse(
  readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8').trim().split('\n')[0],
).capture.hooks_installed_at, 'document_start');
// The digest has to name the endpoints this reading's own requests went to with the ids the graph
// will mint, because the `apis` argument of `graph_transition` only takes ids — a model that invents
// one gets it dropped as an unresolvable reference and the step reads as having called nothing.
check('the reading offers the ids of the endpoints it called', s1.apis,
  [{ id: 'api_get_api_session', method: 'GET', path: '/api/session', status: 200 }]);
check('the id is the method and the path, which is what the commit will derive',
  JSON.parse(readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8').trim().split('\n')[0])
    .capture.network[0].url, '/api/session');
// The digest is what the model gets to choose a state identity against, so the two thirds of the
// fingerprint that are neither the route nor the controls have to be in it, under the same names
// the graph will write. Without them, `identity.dimensions` can only ever mention what is on the
// screen, and a session that changed behind an unchanged screen reads as the same state.
check('the digest offers the key names the page carries, because they are part of what tells two screens apart',
  [s1.session_storage_keys, s1.cookie_names], [['step'], ['sid']]);
// --- step 2: navigate to login --------------------------------------------
await act('browser_click', { selector: '#login' });
await refuses('transition with no destination state read yet', () => transition({ capability: 'go_to_login' }), 'has no destination');
const s2 = await observe({ page_type: 'login', detection: [{ type: 'url' }] });
check('second state is a distinct state', [s2.graph.state.state_id, s2.graph.state.new], ['state_login', true]);
check('a later observation carries its own change, not the entry document again', [s2.entry_document, s2.changed_since_previous_observation.url], [null, ['http://x/', 'http://x/login']]);
check('and a reading that called nothing offers no endpoints', s2.apis, []);

// --- the transition itself ------------------------------------------------
const t1 = await transition({
  capability: 'go_to_login',
  capability_kind: 'navigation',
  effects: [{ type: 'navigation', to: 'state_login', observed: true }, { type: 'message', message: 'Welcome back' }],
  description: 'Open the sign-in page from the home page.',
});
check('derived endpoints', [t1.transition.from_state, t1.transition.to_state], ['state_home_anonymous', 'state_login']);
check('derived evidence pair', t1.transition.derived_from, { before: 'obs_0001', after: 'obs_0002' });
check('transition id minted', [t1.transition.transition_id, t1.transition.new], ['transition_go_to_login', true]);
check('capability minted', [t1.capability.capability_id, t1.capability.kind, t1.capability.new], ['cap_go_to_login', 'navigation', true]);
check('no chain break', t1.chain_break, null);
check('machinery saw the url change', t1.observed_change.url, ['http://x/', 'http://x/login']);
check('claimed message that was never seen is reported', t1.disagreements.map((w) => w.kind), ['claimed_message_not_seen']);
check('a disagreement is recorded, not just returned', JSON.parse(readFileSync(join(cwd, 'graph-run', 'transitions.jsonl'), 'utf8')).notes.map((w) => w.kind), ['claimed_message_not_seen']);

// --- refusals on a real transition ---------------------------------------
await refuses('unknown effect type', () => transition({ capability: 'go_to_login', effects: [{ type: 'teleport', to: 'x' }] }), 'is not one of');
await refuses('effect missing a required field', () => transition({ capability: 'go_to_login', effects: [{ type: 'value_changed', target: 'element_x' }] }), 'missing to');
await refuses('bad effect severity', () => transition({ capability: 'go_to_login', effects: [{ type: 'message', message: 'x', severity: 'catastrophic' }] }), 'severity');
await refuses('bad list operation', () => transition({ capability: 'go_to_login', effects: [{ type: 'list_changed', target: 'element_x', operation: 'shuffle' }] }), 'operation');
await refuses('bad assertion type', () => transition({ capability: 'go_to_login', assertions: [{ type: 'pretty_sure' }] }), 'assertion type');
await refuses('bad capability name', () => transition({ capability: 'Go To Login' }), 'snake_case');
await refuses('bad capability kind', () => transition({ capability: 'go_to_login', capability_kind: 'vibe' }), 'capability_kind');
await refuses('bad target id', () => transition({ capability: 'go_to_login', target: 'div#login' }), 'element_<semantic_purpose>');
await refuses('bad api id', () => transition({ capability: 'go_to_login', apis: ['/api/login'] }), 'api_<name>');
// A composition is written in names and stored as ids, and every name has to resolve at the moment
// it is written: a reference to a behaviour nothing has recorded is dropped by the commit, which
// would lose the whole point of the declaration.
await refuses('a composition naming a capability no step has named',
  () => transition({ capability: 'go_to_login', capability_composed_of: ['fill_email'] }), 'Record the step as its own transition first');
await refuses('a composition naming the capability being recorded',
  () => transition({ capability: 'go_to_login', capability_composed_of: ['go_to_login'] }), 'A behaviour cannot be built from itself');
await refuses('a composition naming something that is not a capability name',
  () => transition({ capability: 'go_to_login', capability_composed_of: ['Fill Email'] }), 'is not a capability name');
await refuses('effect contradicting the derived destination', () => transition({ capability: 'go_to_login', effects: [{ type: 'state_entered', to: 'state_home_anonymous' }] }), 'cannot end in two places');
// A refusal is only as good as the correction it suggests. `to_state` is derived — the model never
// passes it — so a message that leaves the reader to work out which of the two is wrong sends it
// back to a field it did not choose. Two live runs guessed here: one wrote the page_type, one the
// variant, and neither is a state.
await refuses(
  'the refusal says which side has to change',
  () => transition({ capability: 'go_to_login', effects: [{ type: 'state_entered', to: 'state_home_anonymous' }] }),
  'not the page_type and not the variant',
);
check('a refused transition records nothing', readFileSync(join(cwd, 'graph-run', 'transitions.jsonl'), 'utf8').trim().split('\n').length, 1);
check('a refused transition mints no capability', JSON.parse(readFileSync(join(cwd, 'graph-run', 'capabilities.jsonl'), 'utf8')).name, 'go_to_login');

// --- step 3: back to home, same capability as an edge that exists ---------
queue = [capture({ url: 'http://x/', title: 'Home' }), capture({ url: 'http://x/', title: 'Home' })];
await act('browser_navigate', { url: 'http://x/' });
await observe({ page_type: 'home', variant: 'anonymous', detection: [{ type: 'url' }] });
const t2 = await transition({ capability: 'go_to_login', capability_kind: 'navigation' });
check('reused capability', [t2.capability.capability_id, t2.capability.new], ['cap_go_to_login', false]);
check('same capability arriving elsewhere gets its own edge', [t2.transition.transition_id, t2.transition.new], ['transition_go_to_login_home_anonymous', true]);
check('walk is contiguous', t2.chain_break, null);
const t3 = await transition({ capability: 'go_to_login_page' });
check('vocabulary note names the run-local near-duplicate first', t3.capability.vocabulary_notes.map((n) => n.vocabulary_name), ['go_to_login', 'login']);
check('a name the run had not used before is minted, with the ordinary kind',
  [t3.capability.capability_id, t3.capability.new, t3.capability.kind, t3.graph.capabilities_recorded],
  ['cap_go_to_login_page', true, 'interaction', 2]);

// --- an eval is an action too --------------------------------------------
// `browser_eval` runs arbitrary JavaScript in the page, so it can change the page
// as thoroughly as a click. Left uncaptured, the step becomes a hole in the
// evidence chain and the reading after it describes a page nothing observed.
queue = [capture({ url: 'http://x/', title: 'Home' })];
await act('browser_eval', { expression: 'localStorage.setItem("draft", "1")' });
const observations = readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
check('browser_eval is captured', observations[observations.length - 1].tool, 'browser_eval');
await refuses('a transition cannot skip the eval nobody read', () => transition({ capability: 'save_draft' }), 'has no destination');

// --- summary --------------------------------------------------------------
const report = await transition({});
check('omitting the capability only reports', [report.recorded, report.transition ?? null], [false, null]);
check('the report says where the walk stands', [report.walk.steps_walked, report.walk.transitions_recorded, report.walk.last_step.to_state], [3, 3, 'state_home_anonymous']);
check('the report lists the vocabulary', report.vocabulary, ['go_to_login', 'go_to_login_page']);
check('a partially supplied call is reported as ignored, not recorded', (await transition({ effects: [{ type: 'navigation', to: 'state_home_anonymous' }] })).note.includes('read and ignored: effects'), true);
check('file counts', (() => {
  const lines = (p) => readFileSync(join(cwd, 'graph-run', p), 'utf8').trim().split('\n').length;
  return [lines('observations.jsonl'), lines('states.jsonl'), lines('capabilities.jsonl'), lines('transitions.jsonl')];
})(), [4, 3, 2, 3]);

// --- the commit, through the same seam ------------------------------------
// The walk above is a real run — the store wrote it, not a fixture — so this is the end-to-end
// shape of the tool: it reads what the session recorded and reports a verdict. No application was
// declared in this suite's config, so the verdict is a refusal, and a refusal must arrive as a
// result rather than as an exception: the report is the product, and an agent that treats a
// blocked commit as a crash would lose it.
const verdict = await commit({});
check('the commit reads the run this session wrote', [verdict.counts.states.committed, verdict.counts.transitions.committed, verdict.counts.capabilities], [2, 3, 2]);
// The endpoints the run's own request log shows, with the ids the digest offered — the whole point
// of deriving the id from the method and the path is that these two agree without sharing state.
check('the commit found the endpoint the first reading called',
  [verdict.counts.apis.endpoints, verdict.counts.apis.requests, verdict.counts.apis.by_method], [1, 1, { GET: 1 }]);
check('and says no step referenced it, because no transition named an endpoint',
  verdict.counts.apis.unreferenced, ['api_get_api_session']);
// The instruction is the one piece of intent a browser cannot witness, and it reaches the report
// whether or not it can be attributed to a walk: this run recorded it, and the report quotes it
// verbatim. It is not attributed here, because the log holds two candidates for one step — the
// second of which starts where the first ended rather than where it started — so the walk is read
// as two strands, and an instruction that describes the run is not put on either of them.
check('the report quotes the instruction and says what the walk it read against amounts to',
  [verdict.counts.journeys.assembled, verdict.counts.journeys.walked, verdict.counts.journeys.breaks,
    verdict.counts.journeys.stated_goals, verdict.counts.journeys.instruction],
  [2, 3, 1, 0, 'Log in and check the dashboard.']);
check('and names the states the strands started in', verdict.counts.journeys.entry_states, ['state_home_anonymous', 'state_login']);
check('it knows which application it is about', verdict.application, null);
check('an undeclared application blocks the document', [verdict.committed, verdict.blocked_by.map((blocker) => blocker.code)], [false, ['application_not_declared']]);
check('a blocked commit still writes its report', verdict.report_path.endsWith('commit_report.json'), true);
check('a blocked commit writes no graph', verdict.graph_path, null);
check('the refusal names the setting to fix', verdict.blocked_by[0].detail.includes('application: {id, name}'), true);
check('and says what to do next', verdict.next.includes('No graph was written'), true);
check('the findings are summarised by severity', [verdict.warnings.errors, verdict.warnings.detail.length > 0], [0, true]);
// Two states of one application at two routes: the fingerprint is what says so without asking the
// model, and it is a rule the plugin added (severity `warning`), so a walk that passes it is a walk
// whose states the page itself distinguished — not a walk with nothing to say.
check('no state in this walk was reported as one the evidence cannot tell from another',
  verdict.warnings.detail.filter((item) => item.code === 'state_indistinguishable_from_another').length, 0);
check('and the invariant that asked is on the report, passing, as a warning',
  (() => {
    const asked = verdict.invariants.find((result) => result.code === 'state_indistinguishable_from_another') ?? {};
    return [asked.ok, asked.severity, asked.detail];
  })(),
  [true, 'warning', '2 of 2 state(s) carry a fingerprint from their readings, and no two of them are equal.']);
check('the invariants travelled with it', verdict.invariants.filter((result) => result.severity === 'error' && !result.ok).length, 0);
check('the same run can be named explicitly', (await commit({ run_dir: 'graph-run' })).run_dir, join(cwd, 'graph-run'));
const forced = await commit({ force: true });
check('forcing writes the assembled document', existsSync(join(cwd, 'graph-run', 'graph.json')), true);
// A walk is derived, so the graph is where the instruction has to be visible: on every strand, as
// the run's own words, with `goal_stated` false so a reader knows the goal on this walk was not
// attributed and has to be supplied by hand. Nothing inferred it from the shape of the walk.
const written = JSON.parse(readFileSync(join(cwd, 'graph-run', 'graph.json'), 'utf8'));
check('the graph carries the capabilities this run named, once each, with the kinds it gave them',
  written.capabilities.map((entry) => [entry.id, entry.kind, entry.composed_of ?? null]),
  [['cap_go_to_login', 'navigation', null], ['cap_go_to_login_page', 'interaction', null]]);
check('a walk that could not be attributed is named after its endpoints, and is not given a goal',
  written.journeys.map((journey) => [journey.name.startsWith('Derived walk '), journey.goal ?? null, journey.metadata.extra.goal_stated]),
  [[true, null, false], [true, null, false]]);
check('but the instruction is on both strands anyway, so it can be attributed by hand',
  written.journeys.map((journey) => [journey.metadata.extra.run_instruction, journey.metadata.extra.goal_source.startsWith('withheld:')]),
  [['Log in and check the dashboard.', true], ['Log in and check the dashboard.', true]]);
check('forcing does not make the verdict a pass', forced.committed, false);

// --- the generator, through the same seam ---------------------------------
// The document on disk is the generator's only input, which is what makes a generated spec
// reproducible: the same file gives the same spec, today or a year from now, with no raw evidence
// and no browser. Which document that is, is the subject of the section after this one: the model
// when the run has one, and the graph when it does not. This section is the graph path — read the
// document the commit wrote, turn one journey into code, write it beside it — and the walk above is
// a real run, so the journeys in it are the ones the commit derived rather than ones a fixture
// declared.
//
// Nothing is named first, because a graph the walk produced has more than one journey in it: an
// unasked-for choice between them is the one thing this tool must not make.
const unnamed = await generate({});
check('a graph with more than one journey is not guessed at when none is named',
  [unnamed.ok, unnamed.spec_path, unnamed.candidates.map((candidate) => candidate.id)],
  [false, null, written.journeys.map((journey) => journey.id)]);
const chosen = written.journeys[0].id;
const generated = await generate({ journey: chosen });
check('the generator reads the graph the commit wrote',
  [generated.graph_path, generated.run_dir, generated.journey.id],
  [join(cwd, 'graph-run', 'graph.json'), join(cwd, 'graph-run'), chosen]);
check('and writes the spec beside it, named after the journey rather than the title',
  [generated.spec_path, generated.filename.endsWith('.spec.ts'), generated.spec_path.endsWith(generated.filename)],
  [join(cwd, 'graph-run', 'generated', generated.filename), true, true]);
// The string in the result is the file, byte for byte. A tool that reported one spec and wrote
// another would make the answer useless as evidence about what was generated, so this compares the
// two rather than trusting the path.
check('and the file it wrote is the spec it returned',
  readFileSync(generated.spec_path, 'utf8') === generated.spec, true);
check('the spec imports the runner and opens the route the walk started at',
  [generated.spec.includes('from "@playwright/test"'), generated.spec.includes('await page.goto("/")')],
  [true, true]);
check('every step of the walk is reported, acted on or not, with what decided it',
  generated.steps.every((step) => typeof step.transition === 'string' && step.interaction !== undefined), true);
// This walk recorded no interactive elements at all — its captures have real URLs and an empty
// surface — so no step of it can become an action, and the spec says so instead of pretending
// otherwise. That is the case worth asserting here: a generator that wrote a file and reported
// success for a walk whose every step it dropped would be the failure this rule exists to prevent.
check('a walk whose steps name no element is not reported as a spec that performs them',
  [generated.ok, generated.counts.actions, generated.counts.blocking_gaps === generated.counts.gaps,
    generated.gaps.every((gap) => gap.code === 'step_targets_no_element')],
  [false, 0, true, true]);
check('and the file is written anyway, with the gaps as the record of what it drops',
  [existsSync(generated.spec_path), generated.next.includes('This spec is not ok')], [true, true]);
// A journey the graph does not have is answered with the ones it does, never with a guess: the
// difference between "you named it wrong" and "I found something close enough" is the difference
// between a spec for the journey that was asked for and a spec for another one.
const missed = await generate({ journey: 'add a product to the cart' });
check('a journey the graph does not have is refused, with the ones that exist',
  [missed.ok, missed.spec_path, missed.candidates.length],
  [false, null, written.journeys.length]);
await refuses('and a directory with no committed graph is not silently generated from',
  () => generate({ run_dir: 'no-such-run' }), 'has no graph.json');

// --- the model is what a spec is written from ------------------------------
// Phase 4's seam: which file the tool opens. This run is blocked
// (`application_not_declared`), so the commit wrote no model — which makes it the honest fixture
// for the fallback: a run with a graph and no model generates from the graph, and asking for the
// model names the file that is missing rather than quietly reading the other one.
await refuses('a run whose model was never written is told which file is missing, not quietly given the graph',
  () => generate({ source: 'model' }), 'has no application-model.json');
// Two documents of one walk, in a directory of their own: the same state, the same move, and the one
// difference the pivot is about — the graph's step carries the value as an argument, the model's as
// the value its own realisation recorded. Both are written here because the question is not what a
// walk projects to (that is `abm.test.mjs`) but *which file the tool opens*, and a difference that
// shows up in the generated spec is the only way to tell the two apart from outside.
const bothDir = join(cwd, 'both-run');
mkdirSync(bothDir, { recursive: true });
// The parts both documents agree on: one surface, one control on it, one capability, one move.
const shared = {
  application: { id: 'app_demo', name: 'Demo App', base_url: 'http://127.0.0.1:4173/' },
  states: [{
    id: 'state_login',
    name: 'Login',
    identity: { route: '/' },
    detection: [{ type: 'element_state', element: 'element_email_input', operator: 'equals', expected: 'visible' }],
    elements: [{
      id: 'element_email_input',
      role: 'textbox',
      name: 'Email',
      locator: { strategy: 'css', value: '#email' },
      semantic: { purpose: 'email_input' },
    }],
  }],
};
// A join a reader should note, and this test earned it the hard way: the two documents name the walk
// differently — a graph lists the edges it stepped through (`journeys[].transitions[]`), a model
// lists the *moves* it made (`journeys[].steps[]`) — and the adapter is the one place that
// translation happens. Writing the graph's word into the model's file generates nothing at all.
writeFileSync(join(bothDir, 'graph.json'), JSON.stringify({
  ...shared,
  capabilities: [{ id: 'behavior_fill_login_email', name: 'fill_login_email', kind: 'atomic' }],
  transitions: [{
    id: 'transition_fill_login_email',
    from_state: 'state_login',
    to_state: 'state_login',
    action: {
      capability: 'behavior_fill_login_email',
      target: 'element_email_input',
      arguments: { email: 'typed-per-the-graph' },
    },
    effects: [],
  }],
  journeys: [{ id: 'journey_login', name: 'Sign in', start_state: 'state_login', transitions: ['transition_fill_login_email'] }],
}, null, 2));
// The model's own vocabulary: a move is a `transition` naming a `behavior` and a `target`, and the
// value it typed lives on the behaviour's `realization[]` — not copied onto the edge as an
// `arguments` entry, because a recorded value is not a declaration about the application.
writeFileSync(join(bothDir, 'application-model.json'), JSON.stringify({
  ...shared,
  behaviors: [{
    id: 'behavior_fill_login_email',
    name: 'fill_login_email',
    realization: [{ action: 'fill', element: 'element_email_input', value: 'typed-per-the-model' }],
  }],
  transitions: [{
    id: 'transition_fill_login_email',
    from_state: 'state_login',
    to_state: 'state_login',
    behavior: 'behavior_fill_login_email',
    target: 'element_email_input',
    effects: [],
  }],
  journeys: [{ id: 'journey_login', name: 'Sign in', start_state: 'state_login', steps: [{ transition: 'transition_fill_login_email' }] }],
}, null, 2));
const fromModel = await generate({ run_dir: 'both-run', journey: 'journey_login' });
const fromGraph = await generate({ run_dir: 'both-run', journey: 'journey_login', source: 'graph' });
check('a run with a model beside its graph generates from the model, and says so',
  [fromModel.source, fromModel.document_path, fromModel.graph_path, fromModel.spec.includes('typed-per-the-model')],
  ['model', join(bothDir, 'application-model.json'), join(bothDir, 'graph.json'), true]);
check('and naming the graph is what makes the other reading available, on the same run',
  [fromGraph.source, fromGraph.document_path, fromGraph.spec.includes('typed-per-the-graph'),
    fromGraph.spec.includes('typed-per-the-model')],
  ['graph', join(bothDir, 'graph.json'), true, false]);
check('the walk is the same walk either way, so only the value differs',
  [fromModel.counts.transitions, fromModel.counts.actions, fromGraph.counts.transitions,
    fromModel.spec.split('\n').length === fromGraph.spec.split('\n').length],
  [1, 1, 1, true]);
rmSync(bothDir, { recursive: true, force: true });
// What the captures recorded about each state is a field of the document, beside the identity the
// model wrote: it is the half of a state identity that is not a judgement, so it survives to disk
// where a reader — or the next rule — can compare two states without re-reading the run.
check('every committed state carries the fingerprint its own reading produced',
  written.states.slice().sort((left, right) => (left.id < right.id ? -1 : 1)).map((state) => [state.id, state.metadata.extra.observable]),
  [
    ['state_home_anonymous', { routes: ['/'], surface_size: 0, storage_keys: ['theme'], session_storage_keys: ['step'], cookie_names: ['sid'] }],
    ['state_login', { routes: ['/login'], surface_size: 0 }],
  ]);
check('and the keys are recorded on the entry reading alone, not on every reading',
  (() => {
    const withKeys = written.observations.filter((observation) => observation.metadata.extra.keys_captured);
    return [withKeys.length, written.observations.length, written.observations[0].metadata.extra.keys_captured];
  })(),
  [1, written.observations.length, { localStorage: ['theme'], sessionStorage: ['step'], cookies: ['sid'] }]);
await refuses('a directory that is not a run is refused', () => commit({ run_dir: 'nope' }), 'not an exploration run');

// --- the run directory is deleted mid-run ---------------------------------
// The worst case for a store, and the one a long-lived server invites: the directory
// the agent is still writing into is removed between two of its steps. What must not
// happen is the store failing the browser action it was recording — that action has
// already happened, and reporting it as a failure makes the model retry it against a
// page that has moved on. What must happen is a repaired directory, a log that admits
// what it lost, and a walk that never references evidence nobody can read.
const runDir = join(cwd, 'graph-run');
const manifest = readFileSync(join(runDir, 'run.json'), 'utf8');
queue = [capture({ url: 'http://x/cart', title: 'Cart' })];
const beforeDeletion = await act('browser_click', { selector: '#buy' });
check('the step before the deletion is recorded', beforeDeletion.isError, false);
rmSync(runDir, { recursive: true, force: true });

const across = await act('browser_click', { selector: '#buy' });
check('a browser action is not failed by the store that was recording it', across.isError, false);
check('the run directory is back, with run.json restored verbatim', readFileSync(join(runDir, 'run.json'), 'utf8'), manifest);
check('the id is not recycled: the log starts where the run is, not at obs_0001',
  readFileSync(join(runDir, 'observations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).id), ['obs_0006']);

const repaired = await observe({ page_type: 'cart', detection: [{ type: 'url' }] });
check('a reading after the repair is recorded and minted fresh', [repaired.graph.state.state_id, repaired.graph.state.new], ['state_cart', true]);
check('the digest says the log lost ground', [repaired.graph.directory_recreations, repaired.graph.unwritten_records], [1, 0]);

// The step before the deletion is in the store's memory but not in the log, so a
// transition across that hole would carry a reference the commit cannot resolve — and
// the commit blocks the whole graph for one dangling reference. Refused here instead,
// where the model can do something about it.
await refuses('a transition across the hole is refused, naming the hole',
  () => transition({ capability: 'buy_item' }), 'the run directory had to be recreated');

queue = [capture({ url: 'http://x/thanks', title: 'Thanks' })];
await act('browser_click', { selector: '#buy' });
const resumed = await observe({ page_type: 'order_confirmation', detection: [{ type: 'url' }] });
const after = await transition({ capability: 'buy_item', effects: [{ type: 'navigation', to: 'state_order_confirmation' }] });
check('and the walk picks up again from the last step the log still has',
  [after.transition.from_state, after.transition.to_state, after.chain_break], ['state_cart', 'state_order_confirmation', null]);
check('the recreation is counted once, not once per step after it', [resumed.graph.directory_recreations, after.graph.directory_recreations], [1, 1]);
check('the capability minted after the repair is in the log the commit reads',
  readFileSync(join(runDir, 'capabilities.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).name), ['buy_item']);

// --- walking the same edge twice: the report has to survive its own verdict -
// Repeating a step is ordinary — a model re-checks a flow, a page is reloaded — and it leaves two
// candidates for one transition, the second of which is superseded. That row is a decision with no
// rejection to report, and it is exactly where the tool boundary broke: the projection copies a
// decision's fields straight out, a field that is *absent* rather than null is `undefined`, and the
// harness will not call `undefined` JSON. It does not hand back a report with a hole in it — it
// fails the whole `graph_commit` call, and its error
// — `value is not lossless JSON` — names neither the field nor the reason. The model sees a tool
// that stopped working and has nothing to read. Only a re-walk reaches that row, so the walk is
// repeated here rather than described.
queue = [capture({ url: 'http://x/cart', title: 'Cart' })];
await act('browser_click', { selector: '#back' });
const returned = await observe({ page_type: 'cart', detection: [{ type: 'url' }] });
const back = await transition({ capability: 'return_to_cart', capability_kind: 'navigation' });
check('a second visit to a state is a state, not a new one', [returned.graph.state.state_id, returned.graph.state.new, back.transition.to_state], ['state_cart', false, 'state_cart']);
queue = [capture({ url: 'http://x/thanks', title: 'Thanks' })];
await act('browser_click', { selector: '#buy' });
await observe({ page_type: 'order_confirmation', detection: [{ type: 'url' }] });
const again = await transition({
  capability: 'buy_item',
  // The composition, on a call that arrives after the behaviour was named and after its steps were
  // recorded. The steps have to resolve now, which is why the tool takes names rather than ids.
  capability_composed_of: ['return_to_cart'],
  capability_kind: 'composite',
  effects: [{ type: 'navigation', to: 'state_order_confirmation' }],
});
check('the same edge walked twice is the same transition', [again.transition.transition_id, again.transition.new], ['transition_buy_item', false]);
check('and the tool says it reused the edge rather than minting one', again.transition.note.includes('already recorded'), true);
check('a composition arriving later is merged onto the capability, not written beside it',
  [again.capability.capability_id, again.capability.new, again.capability.kind, again.capability.composed_of_added],
  ['cap_buy_item', false, 'composite', ['cap_return_to_cart']]);
check('and the tool hands the names back beside the ids it stored',
  again.capability.composed_of, [{ capability_id: 'cap_return_to_cart', name: 'return_to_cart' }]);
check('the note says the steps are what the behaviour expands into',
  again.capability.composed_of_note, '1 step(s) recorded as what this behaviour is built from.');
const rewalked = await commit({ force: true });
check('the second walk of one edge is superseded, not duplicated', rewalked.counts.transitions.superseded, 1);
check('and graph_commit still returns JSON', losslessPaths(rewalked), []);
// The composition is a claim about a capability, so the graph is where it has to land: fields on
// the capability it was about — the step it is built from, and the kind the later call carried,
// because the kind is what tells a generator to expand the behaviour rather than treat it as one
// action. It is one entry in `capabilities[]`, not two.
const settled = JSON.parse(readFileSync(rewalked.graph_path, 'utf8'));
check('a composition recorded on a later call lands on the capability, not beside it',
  settled.capabilities.map((entry) => [entry.id, entry.kind, entry.composed_of ?? null]),
  [['cap_buy_item', 'composite', ['cap_return_to_cart']], ['cap_return_to_cart', 'navigation', null]]);
// And the goal, on a walk that is one strand again because the log the recreation kept is the walk
// from the repair onwards: the instruction the host supplied before the first action is now the
// journey's goal, and its first clause is the name — a goal is a sentence and a name is a handle,
// so the two fields say different things rather than one being a copy of the other.
check('the walk that is one strand carries the run\'s instruction as its goal, quoted',
  settled.journeys.map((journey) => [journey.goal, journey.name, journey.metadata.extra.goal_stated, journey.transitions.length]),
  [['Log in and check the dashboard.', 'Log in and check the dashboard', true, 3]]);
// The same two rules at the end of a longer, repaired run: the fingerprint is derived from the
// readings of the second run (the first run's evidence was deleted with its directory, and nothing
// here guesses at what it said), and the pair rule is asked of that document rather than of the
// verdict taken earlier. It is a warning, so it never stands between a model and its graph.
check('the repaired walk\'s states carry the fingerprints their own readings produced',
  Object.fromEntries(settled.states.slice().sort((left, right) => (left.id < right.id ? -1 : 1)).map((state) => [state.id, state.metadata.extra?.observable ?? null])),
  {
    state_cart: { routes: ['/cart'], surface_size: 0 },
    state_order_confirmation: { routes: ['/thanks'], surface_size: 0 },
  });
check('and the pair rule is asked of the re-read document, not of the earlier verdict',
  (() => {
    const asked = rewalked.invariants.find((result) => result.code === 'state_indistinguishable_from_another') ?? {};
    return [asked.ok, asked.severity, asked.detail];
  })(),
  [true, 'warning', '2 of 2 state(s) carry a fingerprint from their readings, and no two of them are equal.']);
check('and no state of this walk is reported as one the evidence cannot tell from another',
  rewalked.warnings.detail.filter((item) => item.code === 'state_indistinguishable_from_another').length, 0);

// --- a variable the walk moved and no state can hold ----------------------
// The digest asks the commit's question at the one moment it can still be answered: the effects
// are the run's own account of what each step changed, and by commit time the page that showed it
// is gone. A step that only a remembered value tells apart is a real difference, and the place to
// hold it is the state's identity — so the digest names the variables the walk moved, which of
// them some state records as a dimension, and which of them nothing records at all.
queue = [capture({ url: 'http://x/cart', title: 'Cart' })];
await act('browser_click', { selector: '#back' });
await observe({ page_type: 'cart', detection: [{ type: 'url' }] });
queue = [capture({ url: 'http://x/cart-with-items', title: 'Cart (1 item)' })];
await act('browser_click', { selector: '#add' });
const withItem = await observe({ page_type: 'cart_with_items', detection: [{ type: 'url' }] });
check('a walk that has moved no variable yet offers no rollup rather than an empty one',
  withItem.graph.state_variables, null);
const added = await transition({
  capability: 'add_to_cart',
  effects: [{ type: 'storage_changed', target: 'cart.count', to: '3' }],
});
check('the step that changes only a remembered value is recorded',
  [added.transition.transition_id, added.transition.new], ['transition_add_to_cart', true]);
queue = [capture({ url: 'http://x/cart-with-items', title: 'Cart (1 item)' })];
await act('browser_click', { selector: '#add' });
const remembered = await observe({ page_type: 'cart_with_items', detection: [{ type: 'url' }] });
// The digest divides the question in two, because the answer differs: a storage key is something
// the application remembers, which no browser can be asked about, so nothing asks for a dimension
// here — while a collection is something the screen shows, and *that* is the dimension the answer
// asks for. Both are reported, so a model can act on the one it can act on.
check('and the digest files a remembered value as persistence rather than as a dimension nobody recorded',
  remembered.graph.state_variables,
  { moved: ['cart.count'], recorded: [], unrecorded: [], persistence: ['cart.count'] });
queue = [capture({ url: 'http://x/cart-with-items', title: 'Cart (1 item)' })];
await act('browser_click', { selector: '#add' });
await observe({ page_type: 'cart_with_items', detection: [{ type: 'url' }] });
await transition({
  capability: 'add_to_cart',
  effects: [{ type: 'list_changed', target: 'cart.items', to: '3' }],
});
queue = [capture({ url: 'http://x/cart-with-items', title: 'Cart (1 item)' })];
await act('browser_click', { selector: '#add' });
const collected = await observe({ page_type: 'cart_with_items', detection: [{ type: 'url' }] });
check('while a collection no state records as a dimension is named, because that one can be checked',
  collected.graph.state_variables,
  { moved: ['cart.count', 'cart.items'], recorded: [], unrecorded: ['cart.items'], persistence: ['cart.count'] });

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
