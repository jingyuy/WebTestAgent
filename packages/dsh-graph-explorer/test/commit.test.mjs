/**
 * The reconciliation rules, driven against fixture logs.
 *
 * This is the suite that matters most, because `graph_commit` is where the run stops being
 * a record of what happened and becomes a claim about what the application does. Two kinds
 * of test here, and the split is deliberate:
 *
 *   fixture   a whole run, built with the real store, walked through `commitRun` — dedup,
 *             grouping, supersede, reference resolution, and the files that land on disk.
 *   rule      one rule at a time, through the pure `reconcile`, with the smallest input that
 *             can exercise it. The real fixture cannot show a case it does not contain, and
 *             a rule that only fails on a run nobody has made yet is a rule nobody has run.
 *
 * No browser, no `dsh`: a capture is an object and a run directory is a temp dir.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitRun, reconcile, readRun } from '../lib/commit.js';
import { createRun } from '../lib/session.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label, '=', JSON.stringify(actual));
};
const refuses = (label, fn, expectedFragment) => {
  try { fn(); fails++; console.log('FAIL', label, '(no error thrown)'); }
  catch (error) {
    const ok = String(error.message).includes(expectedFragment);
    if (!ok) { fails++; console.log('FAIL', label, '\n  message ', error.message, '\n  expected to contain', expectedFragment); }
    else console.log('ok  ', label);
  }
};
/** A finding with this code, or undefined. Severity and detail are asserted separately. */
const finding = (report, code, scope = null) => report.findings
  .find((item) => item.code === code && (scope === null || item.scope === scope));
const codes = (findings) => [...new Set(findings.map((item) => item.code))].sort();

// ---------------------------------------------------------------------------
// The fixture: a small app with a login, a dashboard, and a walk that was wrong
// ---------------------------------------------------------------------------
// Three states, six readings, four transition candidates — including one edge walked
// twice, once with the recorder's objection and once cleanly. That last pair is the case
// the real run does not contain and the reason this fixture exists.
const capture = ({ url, title, interactive }) => ({
  url, title, headings: [], interactive, forms: [], values: {}, storage: {},
  status: [], network: [], console: [], page_errors: [], scroll: {},
});

const LOGIN_CONTROLS = [
  { role: 'textbox', name: 'Email', selector: '#email' },
  { role: 'textbox', name: 'Password', selector: '#password' },
  { role: 'button', name: 'Sign in', selector: '#submit' },
];
// The remembered-me variant is a different screen (one more control) at the same route, which
// is exactly what `dimensions` is for.
const LOGIN_REMEMBERED_CONTROLS = [
  ...LOGIN_CONTROLS,
  { role: 'checkbox', name: 'Remember me', selector: '#remember' },
];
const DASHBOARD_CONTROLS = [
  { role: 'button', name: 'Log out', testid: 'logout' },
  { role: 'link', name: 'Projects', selector: '#nav-projects' },
];

const buildFixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gx-commit-'));
  const run = createRun({
    cwd,
    provenance: {
      startUrl: 'http://127.0.0.1:4173/login',
      instruction: 'Log in and check the dashboard.',
      application: { id: 'app_synth', name: 'Synth', version: 'git:abc1234' },
      plugin: { name: '@webtestagent/dsh-graph-explorer', version: '0.0.0-test' },
      model: 'test-model',
      provider: 'test-provider',
    },
  });

  const observe = (url, title, interactive) => run.addObservation({
    tool: 'browser_navigate', toolArgs: { url }, phase: 'after',
    capture: capture({ url, title, interactive }),
  }).id;

  // Two readings of the login page, three of the dashboard, one of the variant.
  const obsLogin = observe('http://127.0.0.1:4173/login', 'Sign in', LOGIN_CONTROLS);
  const obsDashboard = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS);
  const obsLoginAgain = observe('http://127.0.0.1:4173/login', 'Sign in', LOGIN_CONTROLS);
  const obsDashboardAgain = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS);
  const obsDashboardThird = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS);
  const obsRemembered = observe('http://127.0.0.1:4173/login', 'Sign in', LOGIN_REMEMBERED_CONTROLS);

  const LOGIN_ELEMENTS = [
    { semantic_purpose: 'email_field', role: 'textbox', name: 'Email', locator: '#email' },
    { semantic_purpose: 'password_field', role: 'textbox', name: 'Password', locator: '#password' },
    { semantic_purpose: 'submit_login', role: 'button', name: 'Sign in', locator: 'role=button[name="Sign in"]' },
  ];

  run.addState({
    observationId: obsLogin, page_type: 'login', summary: 'The sign-in form.',
    elements: LOGIN_ELEMENTS,
    detection: [{ type: 'url' }, { type: 'element_state', target: 'email_field', operator: 'visible' }],
  });
  run.addState({
    observationId: obsLoginAgain, page_type: 'login', summary: 'The sign-in form.',
    elements: LOGIN_ELEMENTS,
    detection: [{ type: 'url' }, { type: 'element_state', target: 'email_field', operator: 'visible' }],
  });
  run.addState({
    observationId: obsRemembered, page_type: 'login', dimensions: { remember_me: 'yes' },
    summary: 'The sign-in form with "remember me" remembered.',
    // Re-declares two elements the anonymous state already owns: element ids are unique across
    // all states (§14.1), so this is a *sighting* of the declaration, not a second copy of it.
    elements: [
      { semantic_purpose: 'email_field', role: 'textbox', name: 'Email', locator: '#email' },
      { semantic_purpose: 'password_field', role: 'textbox', name: 'Password', locator: '#password' },
      { semantic_purpose: 'remember_me', role: 'checkbox', name: 'Remember me', locator: '#remember' },
    ],
    detection: [{ type: 'element_state', target: 'remember_me', operator: 'visible' }],
  });
  run.addState({
    observationId: obsDashboard, page_type: 'dashboard', variant: 'authenticated',
    summary: 'The dashboard, signed in.',
    elements: [
      { semantic_purpose: 'logout', role: 'button', name: 'Log out', locator: '[data-testid="logout"]' },
      { semantic_purpose: 'projects_link', role: 'link', name: 'Projects', locator: '#nav-projects' },
    ],
    detection: [{ type: 'url' }, { type: 'absence', target: 'submit_login' }],
  });
  for (const observationId of [obsDashboardAgain, obsDashboardThird]) {
    run.addState({
      observationId, page_type: 'dashboard', variant: 'authenticated',
      summary: 'The dashboard, signed in.',
      elements: [
        { semantic_purpose: 'logout', role: 'button', name: 'Log out', locator: '[data-testid="logout"]' },
        { semantic_purpose: 'projects_link', role: 'link', name: 'Projects', locator: '#nav-projects' },
      ],
      detection: [{ type: 'url' }, { type: 'absence', target: 'submit_login' }],
    });
  }

  run.addCapability({ name: 'login', kind: 'setup' });
  run.addCapability({ name: 'logout', kind: 'interaction' });

  const walk = (from, to, capabilityId, capabilityName, before, after, extra = {}) => run.recordTransition({
    from_state: from, to_state: to, capability_id: capabilityId, capability_name: capabilityName,
    before_observation: before, after_observation: after,
    observed_change: { url: ['http://127.0.0.1:4173/login', 'http://127.0.0.1:4173/dashboard'] },
    ...extra,
  });

  const LOGIN_STATE = 'state_login';
  const DASHBOARD_STATE = 'state_dashboard_authenticated';

  // The edge that works. Its effects and assertions are written the way a model writes them:
  // a semantic purpose for the element, a role word for the state, an api id nothing declares.
  walk(LOGIN_STATE, DASHBOARD_STATE, 'cap_login', 'login', obsLogin, obsDashboard, {
    effects: [
      { type: 'navigation', to: '/dashboard' },
      { type: 'element_created', target: 'logout' },
      { type: 'value_changed', target: 'nonexistent_thing', to: 'x' },
    ],
    assertions: [
      { type: 'element_state', target: 'logout', operator: 'visible', expected: true },
      { type: 'state', target: 'auth', expected: 'signed_in' },
    ],
    apis: ['api_login'],
  });
  // The same self-loop twice: first while the recorder objected, then walked cleanly. One edge,
  // two candidates — and the objection must not survive into the graph.
  walk(DASHBOARD_STATE, DASHBOARD_STATE, 'cap_login', 'login', obsDashboard, obsDashboardAgain, {
    notes: [{ kind: 'self_loop_but_controls_changed', detail: 'the two readings share no controls' }],
  });
  walk(DASHBOARD_STATE, DASHBOARD_STATE, 'cap_login', 'login', obsDashboardAgain, obsDashboardThird);
  // A refusal with no clean re-walk: this one stays refused, and the document still commits.
  walk(DASHBOARD_STATE, LOGIN_STATE, 'cap_logout', 'logout', obsDashboardThird, obsLoginAgain, {
    notes: [{ kind: 'self_loop_but_controls_changed', detail: 'the two readings share no controls' }],
  });

  return { dir: run.dir, cwd };
};

const { dir: FIXTURE } = buildFixture();
const committed = commitRun({ dir: FIXTURE, command: 'test' });
const report = committed.report;
const graph = committed.graph;

// --- states: every reading is evidence, one identity is one state -----------
check('six readings collapse to three states', [report.states.candidates, report.states.committed, report.states.deduplicated], [6, 3, 3]);
check('every state has at least one reading', report.states.readings, 3);
check('the variant is its own state, not a repeat', graph.states.map((state) => state.id).sort(),
  ['state_dashboard_authenticated', 'state_login', 'state_login_remember_me_yes']);

// --- capabilities: dedup by name, and the kind from the first sighting ------
check('two capabilities, minted once each', [report.capabilities.candidates, report.capabilities.committed], [2, 2]);
check('vocabulary is not duplicated by a second use', graph.capabilities.map((capability) => capability.id).sort(), ['cap_login', 'cap_logout']);

// --- transitions: one edge per transition_id, best candidate wins -----------
check('four candidates are three edges', [report.transitions.candidates, report.transitions.distinct], [4, 3]);
check('one refused, one superseded, two committed', report.transitions,
  { candidates: 4, distinct: 3, committed: 2, rejected: 1, superseded: 1 });
check('the graph carries exactly the committed edges', graph.transitions.map((edge) => edge.id).sort(),
  ['transition_login', 'transition_login_dashboard_authenticated']);

const superseded = report.decisions.filter((item) => item.decision === 'superseded');
check('the objection was superseded, not committed', superseded.map((item) => item.transition_id), ['transition_login_dashboard_authenticated']);
check('supersede reason explains itself', superseded[0].reason.includes('without the recorder'), true);
check('the superseded candidate is named by its own timestamp', typeof superseded[0].candidate_recorded_at, 'string');
check('the winning decision is the clean walk', report.decisions
  .filter((item) => item.transition_id === 'transition_login_dashboard_authenticated' && item.decision === 'committed')
  .map((item) => item.candidates), [2]);

// --- a refusal is a decision about a candidate, not about the document ------
check('the document still commits', report.ok, true);
check('the refusal is in the evidence, not in the gate', report.blocking, []);
check('the refused edge is reported as an error finding', finding(report, 'self_loop_but_controls_changed')?.severity, 'error');
check('the refused edge is kept in the report', report.decisions
  .filter((item) => item.decision === 'rejected').map((item) => item.transition_id), ['transition_logout']);
check('nothing is dropped from the log', readFileSync(join(FIXTURE, 'transitions.jsonl'), 'utf8').trim().split('\n').length, 4);
check('the graph says an edge was refused', graph.warnings.some((line) => line.includes('transition_logout was refused')), true);
check('the report explains its own two verdicts', report.notes.length, 4);

// --- references: the model's shorthand arrives as ids or not at all ---------
const loginEdge = graph.transitions.find((edge) => edge.id === 'transition_login');
check('a semantic purpose becomes the element id', loginEdge.assertions, [
  { type: 'element_state', element: 'element_logout', operator: 'equals', expected: 'visible' },
]);
check('an unresolvable state assertion is dropped, and said so', finding(report, 'assertions_dropped')?.detail.includes('state_assertion_names_no_state'), true);
check('the effect target resolved to the element', finding(report, 'effect_targets_resolved')?.detail.includes('logout → element_logout'), true);
check('an effect whose target resolves to nothing is dropped', finding(report, 'effects_dropped')?.detail.includes('element_target_does_not_resolve'), true);
check('an api nothing declares is dropped from the edge', loginEdge.apis ?? [], []);
check('and the dropped api is reported', finding(report, 'api_references_dropped')?.detail.includes('api_login'), true);
check('the element-created effect is carried by id', loginEdge.effects.find((effect) => effect.type === 'element_created').target, 'element_logout');

// --- elements: declared once, sighted from several states ------------------
check('six elements, two declared by more than one state, none conflicting', report.elements, { declared: 6, conflicts: 0, shared: 2 });
check('a shared element is declared once', graph.states
  .flatMap((state) => state.elements ?? []).filter((element) => element.id === 'element_email_field').length, 1);
const owner = graph.states.find((state) => (state.elements ?? []).some((element) => element.id === 'element_email_field'));
check('the first state to see it owns the declaration', owner.id, 'state_login');
check('the owning declaration lists the other state', owner.elements
  .find((element) => element.id === 'element_email_field').metadata.extra.also_declared_in,
['state_login_remember_me_yes']);
check('the state that only sighted it says so', finding(report, 'element_declared_in_several_states')?.severity, 'info');
check('the state that saw it elsewhere records that', graph.states
  .find((state) => state.id === 'state_login_remember_me_yes').metadata.extra.elements_declared_elsewhere,
{ email_field: 'state_login', password_field: 'state_login' });

// --- evidence: every reading is carried, and points back at what it is for --
check('all six readings are in the graph', [report.observations.records, report.observations.carried], [6, 6]);
check('an observation names the state it was read as', graph.observations
  .find((observation) => observation.id === 'obs_0003').state, 'state_login');
check('an observation names the edge its reading produced', graph.observations
  .find((observation) => observation.id === 'obs_0002').transition, 'transition_login');
check('edge evidence keeps its roles', loginEdge.evidence.map((ref) => ref.role), ['identity', 'action', 'effect']);
check('a state carries its detection', graph.states.find((state) => state.id === 'state_login').detection, [
  { type: 'url', operator: 'matches', expected: '/login', description: 'observed at /login' },
  { type: 'element_state', element: 'element_email_field', operator: 'equals', expected: 'visible' },
]);
check('a bare url detection is pinned to the route it was read at, and said so', finding(report, 'detection_url_pinned_to_route', 'state_login')?.detail.includes('/login'), true);

// --- invariants -------------------------------------------------------------
const invariants = Object.fromEntries(report.invariants.map((result) => [result.code, result]));
check('ids are unique across states', [invariants.unique_ids.ok, invariants.unique_ids.detail.includes('element ids')], [true, true]);
check('no dangling references', invariants.no_dangling_references.ok, true);
check('every element reference resolves', invariants.elements_reachable.ok, true);
check('detection survives reconciliation', invariants.detection_complete.ok, true);
check('evidence integrity holds', invariants.evidence_integrity.ok, true);
check('a version was recorded, so the check is real', [invariants.version_coherence.severity, invariants.version_coherence.ok], ['error', true]);
check('a partial walk is a warning, not a failure', [invariants.reachability.ok, invariants.reachability.severity], [false, 'warning']);
check('the rule set is the documented one', Object.keys(invariants).sort(), [
  'confidence_floor', 'detection_complete', 'elements_reachable', 'evidence_integrity', 'feature_closure',
  'journey_is_a_walk', 'no_dangling_references', 'reachability', 'short_form_hygiene', 'state_identity_unique',
  'unique_ids', 'version_coherence',
]);

// --- what lands on disk -----------------------------------------------------
check('the report is written', existsSync(join(FIXTURE, 'commit_report.json')), true);
check('the graph is written', existsSync(join(FIXTURE, 'graph.json')), true);
check('the run directory reports what it read', committed.report.run_dir, FIXTURE);
check('the graph says it is derived and rebuildable', graph.generator.notes.includes('can be rebuilt'), true);
check('the declared application is the identity', [graph.application.id, graph.application.name], ['app_synth', 'Synth']);
check('the recorded build is carried into the graph', graph.application.version, 'git:abc1234');
check('the start URL becomes the base_url, not the id', graph.application.base_url, 'http://127.0.0.1:4173/login');
check('what was never walked is admitted', graph.coverage.unmodelled_routes, []);

// ---------------------------------------------------------------------------
// Rules, one at a time, through `reconcile`
// ---------------------------------------------------------------------------
// The fixture above cannot show a case it does not contain. These are the smallest inputs
// that can make each rule fire, so the rule is exercised rather than assumed.
const RULES = {
  application: { id: 'app_x', name: 'X' },
};
const OBS = (id, url) => ({ id, recorded_at: '2026-01-01T00:00:00.000Z', tool: 'browser_navigate', phase: 'after', capture: { url, interactive: [] } });
const STATE = (over = {}) => ({
  kind: 'state', id: 'state_a', state_id: 'state_a', observation_id: 'obs_0001',
  identity: { page_type: 'home' }, identity_key: '["home","",[]]',
  first_seen_at: '2026-01-01T00:00:00.000Z', elements: [], detection: [{ type: 'url' }], status: 'observed', ...over,
});
const EDGE = (over = {}) => ({
  kind: 'transition', id: 'transition_go', transition_id: 'transition_go',
  recorded_at: '2026-01-01T00:00:01.000Z', from_state: 'state_a', to_state: 'state_a',
  action: { capability: 'cap_go' }, notes: [], effects: [], apis: [], assertions: [],
  evidence: [{ observation: 'obs_0001', role: 'identity' }], ...over,
});
const CAP = { kind: 'capability', id: 'cap_go', capability_id: 'cap_go', name: 'go' };
const rule = (input) => reconcile({
  run: { application: RULES.application, plugin: { name: 'p', version: '0' } },
  observations: [OBS('obs_0001', 'http://x/home')],
  states: [STATE()],
  capabilities: [CAP],
  transitions: [],
  ...input,
});

// A state that claims the page is not what the capture shows. This is the one place the graph
// can be checked against the evidence instead of against another claim, and the claim loses:
// a detection that is false at the state's own reading fails a test the moment it is generated.
const refuted = rule({
  states: [STATE({
    elements: [{ semantic_purpose: 'submit', role: 'button', name: 'Sign in', locator: '#submit' }],
    detection: [{ type: 'element_state', target: 'submit', operator: 'visible' }, { type: 'url' }],
  })],
});
check('a claim the capture contradicts is refused', finding(refuted.report, 'detection_refuted_by_evidence')?.severity, 'error');
check('and is not carried into the graph', refuted.graph.states[0].detection.map((entry) => entry.type), ['url']);
check('the refusal is attributed to the state', finding(refuted.report, 'detection_refuted_by_evidence')?.scope, 'state_a');
check('the document still commits', refuted.report.ok, true);

// The same claim, with the capture agreeing, is carried — otherwise the check above proves nothing.
const confirmed = rule({
  observations: [{ id: 'obs_0001', recorded_at: 'x', tool: 't', phase: 'after', capture: { url: 'http://x/home', interactive: [{ role: 'button', name: 'Sign in', selector: '#submit' }] } }],
  states: [STATE({
    elements: [{ semantic_purpose: 'submit', role: 'button', name: 'Sign in', locator: '#submit' }],
    detection: [{ type: 'element_state', target: 'submit', operator: 'visible' }],
  })],
});
check('a claim the capture confirms is carried', confirmed.graph.states[0].detection, [
  { type: 'element_state', element: 'element_submit', operator: 'equals', expected: 'visible' },
]);
check('no refutation finding when the evidence agrees', finding(confirmed.report, 'detection_refuted_by_evidence'), undefined);

// A state with no usable detection cannot be asserted into, so the graph refuses the document.
const undetectable = rule({
  states: [STATE({ detection: [{ type: 'element_state', target: 'nothing_declares_this' }] })],
});
check('a state with no detection left is a gate', undetectable.report.gates.map((gate) => gate.code), ['state_without_detection']);
check('a gate blocks the document', [undetectable.report.ok, undetectable.graph], [false, null]);
check('and the gate is not a finding about a candidate', undetectable.report.findings.filter((item) => item.severity === 'error').length, 0);

// Two states claiming one identity means the identity is not a discriminator (invariant 4).
const collision = rule({
  states: [STATE(), STATE({ id: 'state_b', state_id: 'state_b' })],
});
check('a duplicated identity is a gate', collision.report.gates.map((gate) => gate.code), ['state_identity_collision']);
check('the gate names both states', collision.report.gates[0].detail.includes('state_a and state_b'), true);

// No application: the one thing the machinery cannot observe, and the commit will not guess it.
const undeclared = rule({ run: { plugin: { name: 'p', version: '0' } } });
check('an undeclared application is a gate', undeclared.report.gates.map((gate) => gate.code), ['application_not_declared']);
check('the gate names the setting to fix', undeclared.report.gates[0].detail.includes('application: {id, name}'), true);

// An edge to a state nobody committed cannot be an edge.
const dangling = rule({ transitions: [EDGE({ to_state: 'state_nowhere' })] });
check('an unknown endpoint refuses the edge', finding(dangling.report, 'unknown_state_endpoint')?.severity, 'error');
check('the refused edge is not in the graph', dangling.graph.transitions, []);
check('but the document commits', dangling.report.ok, true);
check('an unknown capability refuses the edge too', rule({ transitions: [EDGE({ action: { capability: 'cap_nope' } })] })
  .report.findings.some((item) => item.code === 'unknown_capability' && item.severity === 'error'), true);
check('an effect that contradicts the destination refuses the edge', rule({
  transitions: [EDGE({ effects: [{ type: 'state_entered', to: 'state_elsewhere' }] })],
}).report.findings.some((item) => item.code === 'effect_contradicts_destination'), true);

// Nothing read at all is not a small graph, it is a missing one.
const empty = rule({ states: [], observations: [] });
check('a run with no states is refused', empty.report.gates.map((gate) => gate.code), ['nothing_to_commit']);
check('and no document is produced', empty.graph, null);

// ---------------------------------------------------------------------------
// `commitRun` and the filesystem: the report is always written, the graph is not
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'gx-commit-io-'));
const undeclaredRun = createRun({ cwd: scratch, provenance: { startUrl: 'http://x/' } });
undeclaredRun.addObservation({ tool: 'browser_open', phase: 'after', capture: capture({ url: 'http://x/', title: 'X', interactive: [] }) });
undeclaredRun.addState({ observationId: 'obs_0001', page_type: 'home', detection: [{ type: 'url' }] });

const blocked = commitRun({ dir: undeclaredRun.dir, command: 'test' });
check('a blocked commit writes no graph', existsSync(join(undeclaredRun.dir, 'graph.json')), false);
check('a blocked commit still writes the report', existsSync(join(undeclaredRun.dir, 'commit_report.json')), true);
check('the report is the product', [blocked.report.ok, blocked.graph, blocked.graphPath], [false, null, null]);
check('the report names the blocking rule', blocked.report.blocking[0].code, 'application_not_declared');
check('the report is JSON on disk', JSON.parse(readFileSync(join(undeclaredRun.dir, 'commit_report.json'), 'utf8')).ok, false);

const forced = commitRun({ dir: undeclaredRun.dir, command: 'test', force: true });
check('a forced commit writes the assembled document', existsSync(join(undeclaredRun.dir, 'graph.json')), true);
check('forcing does not pretend the report passed', forced.report.ok, false);
check('the forced document still says what is wrong with it', JSON.parse(readFileSync(join(undeclaredRun.dir, 'graph.json'), 'utf8')).warnings
  .some((line) => line.includes('application_not_declared')), true);

const readBack = readRun(undeclaredRun.dir);
check('a run can be read back without the store that wrote it', [readBack.observations.length, readBack.states.length], [1, 1]);
refuses('a directory that is not a run is refused', () => commitRun({ dir: scratch }), 'no run.json');

// A half-written line is evidence that cannot be read, and it is never repaired in place: the
// only copy of what happened is the one on disk.
writeFileSync(join(undeclaredRun.dir, 'states.jsonl'), '{ this is not json\n', 'utf8');
refuses('a malformed log line is refused, not repaired', () => commitRun({ dir: undeclaredRun.dir }), 'never repaired in place');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
