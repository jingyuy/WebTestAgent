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
import { commitRun, assembleJourneys, dimensionNamesOf, goalFromInstruction, invariantsOf, journeyNameFromGoal, observableOf, outranksAsEvidence, reconcile, readRun, sameCollectionName, sameVariableName, stateVariablesOf, unrecordedStateVariables } from '../lib/commit.js';
import { createRun } from '../lib/session.js';
import { losslessPaths } from './lossless.mjs';

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
const capture = ({ url, title, interactive, network = [] }) => ({
  url, title, headings: [], interactive, forms: [], values: {}, storage: {},
  status: [], network, console: [], page_errors: [], scroll: {},
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

// One request, in the shape the page hooks record one: method, url, status, how long it took, and
// nothing else. No body is in the evidence, and that is the whole of what the `apis` section of the
// graph is derived from — a method, a path, and the statuses the readings saw.
const request = (method, url, extra = {}) => ({ method, url, duration_ms: 12, ...extra });
const loginCall = (status) => request('POST', 'http://127.0.0.1:4173/api/login', { status });
const projectsCall = request('GET', 'http://127.0.0.1:4173/api/projects', { status: 200 });

// The application is a parameter so that the actor registry can be exercised with a vocabulary
// declared and without one, from the same walk: the second fixture differs from the first in the
// config alone, which is the point — a declaration adds rows the run could not have derived and
// changes nothing about what the walk recorded.
const buildFixture = (application = { id: 'app_synth', name: 'Synth', version: 'git:abc1234' }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gx-commit-'));
  const run = createRun({
    cwd,
    provenance: {
      startUrl: 'http://127.0.0.1:4173/login',
      instruction: 'Log in and check the dashboard.',
      application,
      plugin: { name: '@webtestagent/dsh-graph-explorer', version: '0.0.0-test' },
      model: 'test-model',
      provider: 'test-provider',
    },
  });

  const observe = (url, title, interactive, network = []) => run.addObservation({
    tool: 'browser_navigate', toolArgs: { url }, phase: 'after',
    capture: capture({ url, title, interactive, network }),
  }).id;

  // Two readings of the login page, three of the dashboard, one of the variant. The network lists
  // are the traffic of the step that produced each reading: the login call answered 200 once and
  // 401 once, and the reading taken after the second self-loop shows the projects call.
  const obsLogin = observe('http://127.0.0.1:4173/login', 'Sign in', LOGIN_CONTROLS);
  const obsDashboard = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS, [loginCall(200)]);
  const obsLoginAgain = observe('http://127.0.0.1:4173/login', 'Sign in', LOGIN_CONTROLS);
  const obsDashboardAgain = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS, [loginCall(401)]);
  const obsDashboardThird = observe('http://127.0.0.1:4173/dashboard', 'Dashboard', DASHBOARD_CONTROLS, [projectsCall]);
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

  const loginCapability = run.addCapability({ name: 'login', kind: 'setup' });
  const logoutCapability = run.addCapability({ name: 'logout', kind: 'interaction' });
  // A behaviour named before its structure was understood, then composed on a later call, once the
  // steps had ids to name — which is the order the tool forces, and the reason a composition is a
  // second record about one capability rather than an edit of the first.
  run.addCapability({ name: 'session', kind: 'setup' });
  run.addCapability({
    name: 'session', kind: 'composite',
    composed_of: [loginCapability.id, logoutCapability.id],
  });

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
  // The clean walk names an endpoint the run observed, but not the one this step's own reading
  // shows — declared on the step, observed in another, which is two claims and two fields.
  walk(DASHBOARD_STATE, DASHBOARD_STATE, 'cap_login', 'login', obsDashboardAgain, obsDashboardThird, {
    apis: ['api_post_api_login'],
  });
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
check('and no state here is a reading of two screens', finding(report, 'state_readings_share_no_surface'), undefined);

// --- the other half of a state identity: what the page showed ---------------
// `identity` is the model's judgement and §14.4 checks those judgements only against each other.
// What the captures recorded is written beside them, because that is the side of the question the
// model cannot see: two states it distinguished, and nothing in the page that did. It is a written
// field of the document, so it is asserted here and the pair rule below reads it.
const loginRecord = graph.states.find((state) => state.id === 'state_login');
const variantRecord = graph.states.find((state) => state.id === 'state_login_remember_me_yes');
check('a state carries the fingerprint its readings produced', loginRecord.metadata.extra.observable, {
  routes: ['/login'],
  surface_size: 3,
  surface: ['button:Sign in', 'textbox:Email', 'textbox:Password'],
});
// The control list is the surface, and the surface is what the identity is *about*: the variant is
// the same route with one more control, which is why it is a state and not a repeat reading.
check('and the variant differs from it in the one place that matters',
  [variantRecord?.metadata.extra.observable?.surface_size ?? null, loginRecord.metadata.extra.observable?.surface_size ?? null],
  [4, 3]);
check('a reading with nothing to record leaves no fingerprint rather than an empty one',
  [observableOf([]), observableOf([{}])], [null, null]);
check('a reading that recorded only a route is still comparable on it',
  observableOf([{ url: 'http://x/nowhere' }]), { routes: ['/nowhere'], surface_size: 0 });

// --- capabilities: dedup by name, and the kind from the first sighting ------
check('three capabilities: two named by a step, one named by hand', [report.capabilities.candidates, report.capabilities.committed], [3, 3]);
check('vocabulary is not duplicated by a second use', graph.capabilities.map((capability) => capability.id).sort(), ['cap_login', 'cap_logout', 'cap_session']);

// --- capabilities: a composition declared after the behaviour was named -----
// The capability and the composition are two records about one behaviour, and the commit is where
// they become one object. The kind in the composition is what makes the object a composite, which
// matters: `kind` is what tells a generator the behaviour expands into steps rather than being one
// action, and a behaviour named before its structure was understood would otherwise never get it.
const session = graph.capabilities.find((capability) => capability.id === 'cap_session');
check('a composition appended after the name is merged, not lost',
  [session.kind, session.composed_of], ['composite', ['cap_login', 'cap_logout']]);
check('and the names are beside the ids, so nothing has to be reverse-slugged',
  session.metadata.extra.composed_of_names, ['login', 'logout']);
check('and the commit says the kind arrived with the composition',
  [session.metadata.extra.kind_recorded_by_a_later_composition, session.metadata.extra.composed_of_dropped], [true, undefined]);
check('a composition is a record about a capability, not a second capability',
  [report.capabilities.candidates, report.capabilities.compositions, report.capabilities.composites], [3, 1, 1]);
check('a composite whose steps all resolve is not reported as a gap',
  finding(report, 'composite_without_composed_of'), undefined);

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
check('and it reasons null, because it was not rejected — it lost', [superseded[0].rejection_reason, superseded[0].rejection_basis], [null, null]);
// One table, one shape. A row that omits a key is a row whose reader has to know which branch
// produced it, and at the tool boundary it is worse than untidy: the projection copies these
// fields straight out, `undefined` is not JSON, and the harness refuses the whole `graph_commit`
// call with an error that names no field. The pair below is the regression that failure wanted.
check('every decision row carries the same keys', report.decisions.map((row) => Object.keys(row).filter((key) => key === 'rejection_reason' || key === 'rejection_basis').sort()),
  report.decisions.map(() => ['rejection_basis', 'rejection_reason']));
check('the report survives a JSON round-trip', losslessPaths(report), []);
check('and so does the document', losslessPaths(graph), []);
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
check('the report explains its own verdicts', report.notes.length, 5);
check('including how a journey came to exist', report.notes.some((note) => note.includes('`journeys[]` is derived, not decided')), true);

// --- references: the model's shorthand arrives as ids or not at all ---------
const loginEdge = graph.transitions.find((edge) => edge.id === 'transition_login');
check('a semantic purpose becomes the element id', loginEdge.assertions, [
  { type: 'element_state', element: 'element_logout', operator: 'equals', expected: 'visible' },
]);
check('an unresolvable state assertion is dropped, and said so', finding(report, 'assertions_dropped')?.detail.includes('state_assertion_names_no_state'), true);
check('the effect target resolved to the element', finding(report, 'effect_targets_resolved')?.detail.includes('logout → element_logout'), true);
check('an effect whose target resolves to nothing is dropped', finding(report, 'effects_dropped')?.detail.includes('element_target_does_not_resolve'), true);
check('an api id no reading observed is dropped from the edge', finding(report, 'api_references_dropped')?.detail.includes('api_login'), true);
check('and the endpoint the reading itself saw is on the edge instead', loginEdge.apis, ['api_post_api_login']);
check('the element-created effect is carried by id', loginEdge.effects.find((effect) => effect.type === 'element_created').target, 'element_logout');

// --- apis: what the page called, read off the network log rather than claimed ------
// An api entity is the one part of this graph the machinery found rather than the model, and the
// only claim in it that is evidence rather than vocabulary. Its id is derived from the method and
// the path and from nothing else, so the digest and the commit mint the same id for the same
// endpoint without sharing any state — which is what lets a step name one and mean something that
// can be checked against the reading.
check('the two endpoints the readings called are entities', report.apis.endpoints, 2);
check('an endpoint is a method and a path, and nothing observed about one call',
  graph.apis.map((api) => [api.id, api.method, api.path]),
  [['api_post_api_login', 'POST', '/api/login'], ['api_get_api_projects', 'GET', '/api/projects']]);
// A status is a fact about a call, and an endpoint is not one call: the same login endpoint
// answered 200 once and 401 once, and both belong to it.
check('an endpoint called twice with different statuses is one entity with both',
  graph.apis[0].response, { status: [200, 401] });
check('and an endpoint called once keeps the single status it answered with', graph.apis[1].response, { status: 200 });
check('the counts are what the readings saw',
  [report.apis.requests, report.apis.by_method, report.apis.statuses, report.apis.failures],
  [3, { POST: 1, GET: 1 }, [200, 401], 0]);
check('the entity says the path is observed rather than a route it was templated into',
  [graph.apis[0].metadata.extra.path_is_observed, graph.apis[0].metadata.extra.observed.readings], [true, 2]);
check('and names the readings behind it, with the api role',
  graph.apis[0].evidence, [{ observation: 'obs_0002', role: 'api' }, { observation: 'obs_0004', role: 'api' }]);
check('the reading that saw a call points back at the entity', graph.observations
  .find((observation) => observation.id === 'obs_0002').network[0].api, 'api_post_api_login');

// The two ways a step can say it called something, kept apart. What the reading shows is evidence;
// what the model says is a claim, and this step's claim is not in this step's own reading.
const loopEdge = graph.transitions.find((edge) => edge.id === 'transition_login_dashboard_authenticated');
check('the edge carries both endpoints: the one claimed and the one observed', loopEdge.apis,
  ['api_post_api_login', 'api_get_api_projects']);
check('and the commit keeps the two sorts of claim apart',
  [loopEdge.metadata.extra.commit.apis_declared, loopEdge.metadata.extra.commit.apis_observed],
  [['api_post_api_login'], ['api_get_api_projects']]);
check('a claim the step\'s own reading does not show is noted, not dropped',
  finding(report, 'api_declared_but_not_observed')?.scope, 'transition_login_dashboard_authenticated');
check('and the note says what would have shown it',
  finding(report, 'api_declared_but_not_observed')?.detail.includes('this step\'s own evidence does not show that call'), true);
check('a state carries the endpoints its readings called', graph.states
  .find((state) => state.id === 'state_dashboard_authenticated').apis, ['api_post_api_login', 'api_get_api_projects']);
check('and a state whose readings called nothing says nothing', 'apis' in graph.states.find((state) => state.id === 'state_login'), false);
check('every endpoint is referenced by an edge, so no call is unattributable to a step',
  [report.apis.referenced_by_transitions, report.apis.unreferenced], [2, []]);
check('one id per endpoint, so nothing had to be renamed', report.apis.id_collisions, []);
check('the graph warns that an endpoint is what was called, not what is offered',
  graph.warnings.some((line) => line.includes('no endpoint appears that the page did not call')), true);

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
check('and no declaration in this run is refuted by the reading it was made in',
  finding(report, 'element_declaration_refuted_by_its_reading'), undefined);

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

// --- journeys: the walk, read back -----------------------------------------
// The fixture's walk is one edge, then the same self-loop twice, then a refusal. So the walk in
// the graph is the first three steps and the refusal is where it stops.
check('one walk, three steps, cut where the refused edge is', report.journeys,
  {
    assembled: 1, walked: 3, unusable_steps: 1, breaks: 1, entry_states: ['state_login'],
    stated_goals: 1, instruction: 'Log in and check the dashboard.',
    // Naming, counted: this fixture's steps claim no `feature` and no `journey_name`, so the goal
    // is the only statement of intent in the whole run and it names the walk.
    named_by_model: 0, names_from_goals: 1, names_derived: 0, name_conflicts: [],
  });
const [journey] = graph.journeys;
check('the journey is named after the walk it is', journey.id, 'journey_login_to_dashboard_authenticated');
// The run's instruction is the only place intent was ever written down, and the run walked exactly
// one strand, so the instruction is a goal for this walk — quoted, never paraphrased, because a
// goal the machinery made up would be the one claim in the graph with no evidence of any kind.
check('the walk carries the run\'s own instruction as its goal, and its first clause as its name',
  [journey.goal, journey.name], ['Log in and check the dashboard.', 'Log in and check the dashboard']);
check('the goal is marked as stated rather than inferred from the walk',
  [journey.metadata.extra.goal_stated, journey.metadata.extra.run_instruction],
  [true, 'Log in and check the dashboard.']);
check('and it says where the goal came from', journey.metadata.extra.goal_source.includes('run.json `instruction`, quoted verbatim'), true);
check('the derived name is kept, so the endpoints of the walk are still readable',
  journey.metadata.extra.name_derived_from.includes('state_login to state_dashboard_authenticated'), true);
check('it starts where the walk started', journey.start_state, 'state_login');
check('a repeated edge is two steps in the walk', journey.transitions,
  ['transition_login', 'transition_login_dashboard_authenticated', 'transition_login_dashboard_authenticated']);
check('the repeat is marked as one', journey.metadata.extra.steps[2].repeat_of_earlier_step, true);
check('distinct edges are counted beside steps', journey.metadata.extra.distinct_transitions, 2);
check('the journey is inferred, not verified', [journey.metadata.status, journey.metadata.producer], ['inferred', 'importer:dsh-graph-explorer']);
check('it is tagged so a reader can find the derived ones', journey.tags, ['derived']);
check('the refused step is not walked into the journey', journey.transitions.includes('transition_logout'), false);
check('a journey carries the readings it was walked from',
  [...new Set(journey.evidence.map((ref) => ref.observation))], ['obs_0001', 'obs_0002', 'obs_0004', 'obs_0005']);
check('the graph says the goal is the run\'s own, and that a priority was not judged',
  graph.warnings.some((line) => line.includes('the run\'s own instruction is carried as their goal')), true);
check('and the coverage note counts the walks', graph.coverage.notes.includes('1 walk(s) reassembled from 3 step(s)'), true);

// --- invariants -------------------------------------------------------------
// `report.invariants` carries both documents' rules in one flat list, and `document` says which
// document each entry is about: `report.ok` is about `graph.json`, so the graph's own set is what
// this suite documents. The model's fifteen rules are pinned separately, below.
const invariants = Object.fromEntries(
  report.invariants.filter((result) => result.document === 'graph').map((result) => [result.code, result]),
);
const modelInvariants = Object.fromEntries(
  report.invariants.filter((result) => result.document === 'model').map((result) => [result.code, result]),
);
check('ids are unique across states', [invariants.unique_ids.ok, invariants.unique_ids.detail.includes('element ids')], [true, true]);
check('no dangling references', invariants.no_dangling_references.ok, true);
check('every element reference resolves', invariants.elements_reachable.ok, true);
check('detection survives reconciliation', invariants.detection_complete.ok, true);
check('evidence integrity holds', invariants.evidence_integrity.ok, true);
check('a version was recorded, so the check is real', [invariants.version_coherence.severity, invariants.version_coherence.ok], ['error', true]);
check('a partial walk is a warning, not a failure', [invariants.reachability.ok, invariants.reachability.severity], [false, 'warning']);
check('the state identity check is asked from the evidence side too',
  [invariants.state_indistinguishable_from_another.ok, invariants.state_indistinguishable_from_another.severity], [true, 'warning']);
check('and it says how many states it could compare',
  invariants.state_indistinguishable_from_another.detail,
  '3 of 3 state(s) carry a fingerprint from their readings, and no two of them are equal.');
check('the walk itself is checked now, and it holds', [invariants.journey_is_a_walk.ok, invariants.journey_is_a_walk.severity], [true, 'error']);
check('and the check says what it checked', invariants.journey_is_a_walk.detail.includes('every step starts where the one before it ended'), true);
check('reachability asks from where the walk began', invariants.reachability.detail.includes('entry state(s), from where the walks began: state_login'), true);
check('and names the state no walk reached', invariants.reachability.detail.includes('not reachable from one of them: state_login_remember_me_yes'), true);
check('a walk stopping somewhere is reported as a sample ending, not as a defect', invariants.reachability.detail.includes('a walk stops at state_dashboard_authenticated'), true);
check('the rule set is the documented one', Object.keys(invariants).sort(), [
  'confidence_floor', 'detection_complete', 'elements_reachable', 'evidence_integrity', 'feature_closure',
  'journey_is_a_walk', 'no_dangling_references', 'reachability', 'short_form_hygiene', 'state_identity_unique',
  'state_indistinguishable_from_another', 'unique_ids', 'version_coherence',
]);
// Phase 2: the application model's seventeen rules are in the same section, with `document: 'model'`,
// so that "is this commit's output sound" is one question about two documents rather than two
// sections a reader has to know to look in. They are *not* part of `blocking` — a rule the model
// adds must never take `graph.json` away from a run that satisfied every rule the graph has (D1).
// P16 is the reference-integrity rule the review asked for by name ("every reference resolves"), so
// it is also the one rule whose *subject* is the document rather than what the document claims.
// P17 is its counterpart for claims rather than ids: a contract may not be stated at a level its own
// evidence does not reach.
check('the model\'s rules are reported beside them, and name the other document', Object.keys(modelInvariants).sort(), [
  'P1', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9',
]);
check('and none of them is a blocker of the graph', report.blocking.some((blocker) => /^P\d+$/.test(blocker.code ?? '')), false);

// --- what lands on disk -----------------------------------------------------
check('the report is written', existsSync(join(FIXTURE, 'commit_report.json')), true);
check('the graph is written', existsSync(join(FIXTURE, 'graph.json')), true);
check('the run directory reports what it read', committed.report.run_dir, FIXTURE);
check('the graph says it is derived and rebuildable', graph.generator.notes.includes('can be rebuilt'), true);
check('the declared application is the identity', [graph.application.id, graph.application.name], ['app_synth', 'Synth']);
check('the recorded build is carried into the graph', graph.application.version, 'git:abc1234');
check('the start URL becomes the base_url, not the id', graph.application.base_url, 'http://127.0.0.1:4173/login');
check('what was never walked is admitted', graph.coverage.unmodelled_routes, []);

// --- actors: the declared vocabulary, and the roles the walk actually used ---
// `application.schema.json` has declared `actors` in both document versions and nothing ever filled
// it in. It could not be derived: a page says which variant a reading was taken as, and nothing
// says which roles the application can be exercised as — least of all which credential a role signs
// in with. So it is declared in config, and what lands in the graph is the union of the declaration
// and the ids the walk actually referenced. The reference runs the other way from the declaration:
// `state.identity.variant` and `journey.actor` name an actor id, so dropping a used-but-undeclared id
// would break a reference rather than report an omission. It is carried and the omission is said out
// loud, which is the difference between a gap the graph admits to and one sealed into it.
check('a role the walk used and nobody declared is carried, so its references resolve',
  graph.application.actors,
  // A bare id, with no description: the graph may not write prose nobody wrote, and the derived
  // wording ("observed as the surface variant …") is the projection's, one layer down.
  [{ id: 'authenticated' }]);
check('and the graph says the declaration was missing rather than implying a role was decided',
  graph.warnings.filter((warning) => warning.startsWith('actors:')).map((warning) => [
    warning.includes('"authenticated"'),
    warning.includes('declared by no'),
    warning.includes('application: { actors: [{ id: ... }] }'),
  ]),
  [[true, true, true]]);

// The same walk, with the vocabulary declared. Nothing else about the fixture changes, so every
// difference between the two graphs is the declaration and its consequences — which is the check
// this section is for: a declaration is not an instruction to the walk, it is the one input the
// evidence cannot supply.
const declaredFixture = buildFixture({
  id: 'app_synth',
  name: 'Synth',
  actors: [
    { id: 'anonymous', description: 'Nobody is signed in.' },
    { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
  ],
});
const declaredCommit = commitRun({ dir: declaredFixture.dir, command: 'test' });
const declaredGraph = declaredCommit.graph;
check('a declared role is carried as declared, description and reference together',
  declaredGraph.application.actors,
  [
    { id: 'anonymous', description: 'Nobody is signed in.' },
    { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
  ]);
check('a declared role the walk never used is kept: the vocabulary outlives the walk',
  declaredGraph.application.actors.some((actor) => actor.id === 'anonymous'), true);
check('and the used one is not added a second time beside the declared one',
  declaredGraph.application.actors.filter((actor) => actor.id === 'authenticated').length, 1);
check('a declaration means there is nothing to warn about',
  declaredGraph.warnings.filter((warning) => warning.startsWith('actors:')), []);
check('the declaration changes the actors and nothing else the walk produced',
  [declaredCommit.report.states.committed, declaredGraph.states.map((state) => state.id).sort(), declaredGraph.transitions.length],
  [report.states.committed, graph.states.map((state) => state.id).sort(), graph.transitions.length]);

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

// Two readings bound to one state whose controls have nothing in common. A detection is checked
// against the capture of the reading that carries it, so a misbinding is caught there only when
// the detection happens to name the surface it contradicts — and a state whose detection is a
// bare route assertion is contradicted by nothing at all. The surfaces are then the only evidence
// there is, and they do not need a claim to be read.
const reading = (id, interactive) => ({
  id, recorded_at: '2026-01-01T00:00:00.000Z', tool: 'browser_click', phase: 'after',
  capture: { url: 'http://x/login', interactive },
});
const FORM_SURFACE = [
  { role: 'textbox', name: 'Email', selector: '#email' },
  { role: 'button', name: 'Sign in', selector: '#signin' },
];
const LIST_SURFACE = [
  { role: 'button', name: 'Projects', selector: '#nav-projects' },
  { role: 'button', name: 'Log out', selector: '#logout' },
];
const twoScreens = rule({
  observations: [reading('obs_0001', FORM_SURFACE), reading('obs_0002', LIST_SURFACE)],
  states: [STATE(), STATE({ kind: 'sighting', observation_id: 'obs_0002', evidence: 'repeat_observation' })],
});
check('two readings of one state that share no control are reported as two screens',
  finding(twoScreens.report, 'state_readings_share_no_surface')?.scope, 'state_a');
check('and it is a warning rather than a gate: both screens are real, it is the identity that is doubtful',
  [finding(twoScreens.report, 'state_readings_share_no_surface')?.severity, twoScreens.report.ok], ['warning', true]);
check('and the report names both readings and the controls that put them apart',
  [
    finding(twoScreens.report, 'state_readings_share_no_surface')?.detail.includes('obs_0002 shows button:Log out'),
    finding(twoScreens.report, 'state_readings_share_no_surface')?.detail.includes('obs_0001 shows button:Sign in'),
  ], [true, true]);

// The blunt end of the rule, which is what keeps it from being noise. Two readings that share a
// single control are one screen as far as the machinery can tell, and it says nothing — the
// fixture's dashboard is exactly this shape, and a threshold that could tell the difference would
// be invented here rather than in the application.
const overlapping = rule({
  observations: [reading('obs_0001', FORM_SURFACE), reading('obs_0002', [...FORM_SURFACE, { role: 'checkbox', name: 'Remember me', selector: '#remember' }])],
  states: [STATE(), STATE({ kind: 'sighting', observation_id: 'obs_0002', evidence: 'repeat_observation' })],
});
check('two readings that share even one control are left alone',
  finding(overlapping.report, 'state_readings_share_no_surface'), undefined);

// A reading that lists no control at all refutes nothing: the honest answer to "is this another
// screen?" is then that there is no evidence either way, and the rule declines rather than guess.
const noControls = rule({
  observations: [reading('obs_0001', FORM_SURFACE), reading('obs_0002', [])],
  states: [STATE(), STATE({ kind: 'sighting', observation_id: 'obs_0002', evidence: 'repeat_observation' })],
});
check('and a reading that lists no control is not evidence of a different screen',
  finding(noControls.report, 'state_readings_share_no_surface'), undefined);

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

// --- capabilities: what a behaviour is built from ------------------------
// `composed_of` is the one field that makes a capability a claim about structure rather than about
// a name, and every way of getting it wrong is a way of handing a generator something it cannot
// expand. Each one is reported, and none of them is carried into the document.
const CAP_B = (over = {}) => ({ kind: 'capability', id: 'cap_b', capability_id: 'cap_b', name: 'b', ...over });

const danglingSteps = rule({ capabilities: [CAP, CAP_B({ composed_of: ['cap_nope'] })] });
check('a step no committed capability has is dropped from the composition',
  danglingSteps.graph.capabilities.find((capability) => capability.id === 'cap_b').composed_of ?? [], []);
check('and the drop is reported as the dangling reference it is',
  finding(danglingSteps.report, 'composed_of_does_not_resolve')?.severity, 'warning');
check('and says which reference could not be named',
  finding(danglingSteps.report, 'composed_of_does_not_resolve')?.detail.includes('cap_nope'), true);
check('nothing dangling survives to the invariant that checks for it',
  Object.fromEntries(danglingSteps.report.invariants.map((result) => [result.code, result.ok])).no_dangling_references, true);

const selfComposed = rule({ capabilities: [CAP_B({ composed_of: ['cap_b'] })] });
check('a behaviour cannot be one of its own steps', finding(selfComposed.report, 'composed_of_names_itself')?.severity, 'warning');
check('and the self-reference is not carried',
  selfComposed.graph.capabilities.find((capability) => capability.id === 'cap_b').composed_of ?? [], []);

// The composition that arrives as its own record, because the behaviour was named first. A
// capability is named on first use and never redefined, so a later `composed_of` is a second claim
// about the same behaviour — and the kind it carries is the claim that makes it a composite.
const lateComposition = rule({
  capabilities: [CAP, CAP_B(), {
    kind: 'capability_composition', capability_id: 'cap_b', name: 'b',
    composed_of: ['cap_go'], capability_kind: 'composite',
  }],
});
const late = lateComposition.graph.capabilities.find((capability) => capability.id === 'cap_b');
check('a composition appended after the name is merged into the one object',
  [late.composed_of, late.metadata.extra.composed_of_names], [['cap_go'], ['go']]);
check('and the kind it carried wins, because `kind` is what tells a generator to expand the steps',
  [late.kind, late.metadata.extra.kind_recorded_by_a_later_composition], ['composite', true]);
check('a composition record is not a second capability', lateComposition.graph.capabilities.map((capability) => capability.id), ['cap_go', 'cap_b']);

const composedButPlain = rule({ capabilities: [CAP, CAP_B({ capability_kind: 'interaction', composed_of: ['cap_go'] })] });
check('a composition on a capability that is not a composite is carried with a warning',
  [composedButPlain.graph.capabilities.find((capability) => capability.id === 'cap_b').composed_of,
    finding(composedButPlain.report, 'composed_of_on_a_non_composite')?.severity], [['cap_go'], 'warning']);

const emptyComposite = rule({ capabilities: [CAP_B({ capability_kind: 'composite' })] });
check('a composite naming no steps is noted, not refused',
  [finding(emptyComposite.report, 'composite_without_composed_of')?.severity, emptyComposite.report.ok], ['info', true]);

// A cycle is the one composition problem a per-capability check cannot see: every step of every
// capability in it resolves. It is reported rather than repaired, because which name in the loop is
// the wrong one is not something the evidence can settle.
const loop = rule({
  capabilities: [
    { ...CAP, composed_of: ['cap_b'] },
    CAP_B({ composed_of: ['cap_c'] }),
    { kind: 'capability', id: 'cap_c', capability_id: 'cap_c', name: 'c', composed_of: ['cap_go'] },
  ],
});
check('capabilities that contain each other in a loop are reported',
  finding(loop.report, 'composed_of_cycle')?.detail.includes('cap_go → cap_b → cap_c → cap_go'), true);
check('and the loop is reported once, not once per capability in it',
  loop.report.findings.filter((item) => item.code === 'composed_of_cycle').length, 1);
check('and it is a warning: the document still commits', [finding(loop.report, 'composed_of_cycle')?.severity, loop.report.ok], ['warning', true]);

// --- apis: entities the machinery found, not vocabulary the model supplied --
// The id is the method and the path, so a step can only name an endpoint by naming the id the
// observation itself produced — which makes the reference checkable instead of decorative.
const UNOBSERVED = 'api_post_api_login';
const called = (over = {}) => ({ method: 'POST', url: 'http://x/api/login', status: 200, duration_ms: 30, ...over });
const apiReading = (network) => ({
  id: 'obs_0002', recorded_at: '2026-01-01T00:00:01.000Z', tool: 'browser_click', phase: 'after',
  capture: { url: 'http://x/home', interactive: [], network },
});
const endpoint = (network, transition = {}) => rule({
  observations: [OBS('obs_0001', 'http://x/home'), apiReading(network)],
  transitions: [EDGE({ before_observation: 'obs_0001', after_observation: 'obs_0002', ...transition })],
});

const withApi = endpoint([called()], { effects: [{ type: 'request', api: UNOBSERVED }] });
check('an endpoint a reading saw becomes an entity, named for its method and path',
  withApi.graph.apis.map((api) => [api.id, api.method, api.path]), [[UNOBSERVED, 'POST', '/api/login']]);
check('and the status it answered with is the one thing the entity adds', withApi.graph.apis[0].response, { status: 200 });
check('the reading is evidence for the endpoint, under the api role',
  withApi.graph.apis[0].evidence, [{ observation: 'obs_0002', role: 'api' }]);
check('a request effect naming that id is carried, because the machinery can check it',
  withApi.graph.transitions[0].effects, [{ type: 'request', api: UNOBSERVED }]);
check('and the step says which endpoint it was observed to call', withApi.graph.transitions[0].apis, [UNOBSERVED]);
check('the entity claims nothing a network log cannot support',
  [withApi.graph.apis[0].metadata.extra.path_is_observed,
    withApi.graph.apis[0].metadata.extra.observed.requests,
    withApi.graph.apis[0].metadata.extra.request_body.startsWith('not recorded')], [true, 1, true]);

const twice = endpoint([called(), called({ status: 401 })]);
check('one endpoint called twice is one entity carrying both statuses',
  [twice.graph.apis.length, twice.graph.apis[0].response.status], [1, [200, 401]]);
check('and the count is of calls, not of readings', twice.graph.apis[0].metadata.extra.observed.requests, 2);

const unobservedApi = endpoint([], { effects: [{ type: 'request', api: UNOBSERVED }] });
check('a request effect naming an endpoint nothing called is dropped, not carried as a string',
  unobservedApi.graph.transitions[0].effects, []);
check('the drop says why, and says which endpoint was claimed',
  [finding(unobservedApi.report, 'effects_dropped')?.detail.includes('api_does_not_resolve'),
    unobservedApi.graph.transitions[0].metadata.extra.commit.dropped.effects.map((entry) => entry.effect.api)],
  [true, [UNOBSERVED]]);
check('and no entity is invented for it', unobservedApi.graph.apis, []);
check('a step whose reading called nothing carries no `apis` at all',
  'apis' in unobservedApi.graph.transitions[0], false);

// Two endpoints whose ids slug to the same string both stay in the graph: dropping one would mean
// the evidence says a call happened and the document says no such endpoint exists.
const collisionApis = endpoint([
  called({ url: 'http://x/a-b' }),
  { method: 'POST', url: 'http://x/a/b', status: 200 },
]);
check('two endpoints that slug to one id are both kept, and the second is renamed',
  collisionApis.graph.apis.map((api) => [api.id, api.path]), [['api_post_a_b', '/a-b'], ['api_post_a_b_2', '/a/b']]);
check('and the rename is reported, because a digest may have shown the unsuffixed id',
  [collisionApis.report.apis.id_collisions.map((entry) => entry.minted),
    collisionApis.graph.warnings.some((line) => line.includes('both read as the id api_post_a_b'))], [['api_post_a_b_2'], true]);
check('and both endpoints still resolve as references',
  collisionApis.report.invariants.find((result) => result.code === 'no_dangling_references').ok, true);

// An endpoint is minted from what a call looked like, so an entry that is not a request produces no
// entity, and a status that is not a number produces no status rather than a made-up one.
const notRequests = endpoint([null, 'http://x/ignored', { method: 'POST' }, { method: 'POST', url: 'http://x/api/login', status: 'ok' }]);
check('an entry that is not a request is not an endpoint',
  notRequests.graph.apis.map((api) => [api.id, api.response ?? null]), [['api_post_api_login', null]]);
check('and no status is claimed for a call that reported none',
  notRequests.graph.apis[0].metadata.extra.observed.statuses, []);

// --- two states the page cannot tell apart ----------------------------------
// §14.4 checks the identities the model wrote against each other, and this pair passes it: the page
// types differ. The only thing left that can ask whether the *page* distinguished them is the
// evidence, which is what `metadata.extra.observable` is for. Both halves are tested here, because
// a rule that fires on every pair of states would be worse than no rule: the smallest pair that
// shows a duplicate and the smallest pair that shows two screens.
const SHOP_CONTROLS = [{ role: 'button', name: 'Pay' }, { role: 'link', name: 'Cart' }];
const atControls = (observation, interactive) => ({ ...observation, capture: { ...observation.capture, interactive } });
const shopState = (id, pageType) => STATE({
  id,
  state_id: id,
  observation_id: id === 'state_a' ? 'obs_0001' : 'obs_0002',
  identity: { page_type: pageType },
  identity_key: JSON.stringify([pageType, '', []]),
  detection: [{ type: 'url' }],
});
const shopRule = (observations) => rule({
  observations,
  states: [shopState('state_a', 'cart'), shopState('state_b', 'checkout')],
  capabilities: [CAP],
  transitions: [],
});

const oneScreenTwoNames = shopRule([
  atControls(OBS('obs_0001', 'http://x/cart'), SHOP_CONTROLS),
  atControls(OBS('obs_0002', 'http://x/cart'), SHOP_CONTROLS),
]);
const duplicates = oneScreenTwoNames.report.findings.filter((item) => item.code === 'state_indistinguishable_from_another');
// Read once and asserted in parts, with the parts defaulted: a rule that stops firing has to fail
// these checks one by one, with the value it produced. Crashing on a missing finding would end the
// suite at the first regression and hide the four checks after it.
const aboutFirst = duplicates[0] ?? {};
check('two states the page shows identically are reported, once for each of them',
  duplicates.map((item) => item.scope).sort(), ['state_a', 'state_b']);
check('and it is a warning about the evidence, not a refusal to commit',
  [aboutFirst.severity, aboutFirst.basis, oneScreenTwoNames.report.ok], ['warning', 'evidence_check', true]);
check('the finding names the state it cannot be told apart from',
  (duplicates.find((item) => item.scope === 'state_a')?.detail ?? '').includes('tells this state apart from state_b'), true);
check('and says what the two have in common, so the reader can check it',
  (aboutFirst.detail ?? '').includes('route(s) /cart, 2 control(s)'), true);
check('and points at the field the difference belongs in',
  (aboutFirst.detail ?? '').includes('identity.dimensions'), true);
check('the fingerprint itself is on both states',
  oneScreenTwoNames.graph.states.map((state) => state.metadata.extra.observable),
  [
    { routes: ['/cart'], surface_size: 2, surface: ['button:Pay', 'link:Cart'] },
    { routes: ['/cart'], surface_size: 2, surface: ['button:Pay', 'link:Cart'] },
  ]);
// The document-level statement of the same fact. It is asked of the graph rather than of the
// candidate records, so a hand-edited or re-read graph gets the same answer as a fresh commit.
const pairInvariant = Object.fromEntries(invariantsOf(oneScreenTwoNames.graph).map((result) => [result.code, result]))
  .state_indistinguishable_from_another ?? {};
check('and the invariant says so about the document', [pairInvariant.ok, pairInvariant.severity], [false, 'warning']);
check('naming both states and the fingerprint they share',
  pairInvariant.detail, 'state_a and state_b share route(s) /cart, 2 control(s)');

// The two names at two addresses are two screens, and the evidence is where that shows: a route is
// part of the fingerprint, so this rule declines rather than calling a real difference a duplicate.
const twoAddresses = shopRule([
  atControls(OBS('obs_0001', 'http://x/cart'), SHOP_CONTROLS),
  atControls(OBS('obs_0002', 'http://x/checkout'), SHOP_CONTROLS),
]);
check('two states the page did distinguish are not reported',
  finding(twoAddresses.report, 'state_indistinguishable_from_another'), undefined);
check('and the rule passes with both fingerprints in it',
  Object.fromEntries(invariantsOf(twoAddresses.graph).map((result) => [result.code, result])).state_indistinguishable_from_another.ok, true);
// The same pair again with the controls differing: the surface is the other half of what a state
// is, and one control either way is the difference between two screens and one.
const oneControlApart = shopRule([
  atControls(OBS('obs_0001', 'http://x/cart'), SHOP_CONTROLS),
  atControls(OBS('obs_0002', 'http://x/cart'), [...SHOP_CONTROLS, { role: 'checkbox', name: 'Gift' }]),
]);
check('a pair that differs in one control is left alone',
  finding(oneControlApart.report, 'state_indistinguishable_from_another'), undefined);
// And a pair whose captures recorded nothing has no fingerprint at all: the rule declines, exactly
// as `surfaceIsDisjoint` does, because a reading that shows nothing refutes nothing. This walk has
// no document for the ordinary reason — a detection nothing could confirm — which is also the proof
// that the pair rule is not what stopped it.
const nothingRecorded = shopRule([OBS('obs_0001'), OBS('obs_0002')]);
check('a pair of states with no fingerprint between them is not called a duplicate',
  [finding(nothingRecorded.report, 'state_indistinguishable_from_another'), nothingRecorded.graph],
  [undefined, null]);
check('and what blocks that walk is its detection, not this rule',
  [nothingRecorded.report.gates.length > 0, nothingRecorded.report.gates.every((gate) => gate.basis !== 'evidence_check' || gate.code !== 'state_indistinguishable_from_another')],
  [true, true]);

// --- who owns an element declaration, when two readings disagree -------------
// One purpose has exactly one declaration, and that declaration carries the element's id, locator
// and role/name into the graph. Which state owns it used to be decided by the order records were
// merged in, so an element declared in a state whose reading never showed it could take the id and
// the locator while the state whose reading *did* show it was recorded as merely seeing it. The
// rule is now the evidence, and the two fixtures below are the two halves of it.
const ELEMENT = (purpose, over = {}) => ({ semantic_purpose: purpose, role: 'button', name: purpose, ...over });
const shows = (observation, element) => ({ ...observation, capture: { ...observation.capture, interactive: [element] } });
// A capture with no `interactive` list at all: the reading happened, and it says nothing about the
// surface. Not the same answer as a capture that was read and did not list the element.
const silent = (observation) => ({ ...observation, capture: { url: observation.capture.url } });
const declares = (id, observationId, pageType) => STATE({
  id,
  state_id: id,
  observation_id: observationId,
  identity: { page_type: pageType },
  identity_key: JSON.stringify([pageType, '', []]),
  elements: [ELEMENT('pay_button')],
  detection: [{ type: 'url' }],
});

const ownerMoved = rule({
  observations: [
    shows(OBS('obs_0001', 'http://x/cart'), ELEMENT('continue_shopping')),
    shows(OBS('obs_0002', 'http://x/checkout'), ELEMENT('pay_button')),
  ],
  states: [declares('state_a', 'obs_0001', 'cart'), declares('state_b', 'obs_0002', 'checkout')],
  transitions: [],
});
// Read through helpers that survive a missing element: a rule that stops working has to fail these
// checks with the value it produced instead of ending the suite at the first one.
const stateIn = (graph, id) => graph.states.find((state) => state.id === id) ?? {};
const elementIn = (graph, id) => (stateIn(graph, id).elements ?? [])[0] ?? {};
const refutedDeclaration = finding(ownerMoved.report, 'element_declaration_refuted_by_its_reading');
check('the state whose reading shows the element owns the declaration, not the state that named it first',
  [(stateIn(ownerMoved.graph, 'state_b').elements ?? []).length, 'elements' in stateIn(ownerMoved.graph, 'state_a')],
  [1, false]);
check('and the declaration is the one whose reading can vouch for it, not merely an id moved',
  [elementIn(ownerMoved.graph, 'state_b').id ?? null, elementIn(ownerMoved.graph, 'state_b').metadata?.extra?.also_declared_in ?? null],
  ['element_pay_button', ['state_a']]);
check('the state that declared it from a reading that does not show it records it as elsewhere',
  stateIn(ownerMoved.graph, 'state_a').metadata?.extra?.elements_declared_elsewhere ?? null,
  { pay_button: 'state_b' });
check('and says so, once, as a note rather than a repair', [refutedDeclaration?.scope, refutedDeclaration?.severity, refutedDeclaration?.basis], ['state_a', 'info', 'evidence_check']);
check('naming the reading it was declared from and the state that kept it',
  [(refutedDeclaration?.detail ?? '').includes('from reading obs_0001'), (refutedDeclaration?.detail ?? '').includes('kept in state_b instead')],
  [true, true]);
check('and the element is declared once, so invariant 1 still holds',
  ownerMoved.graph.states.flatMap((state) => state.elements ?? []).length, 1);
const bothDeclared = finding(ownerMoved.report, 'element_declared_in_several_states');
const declaredDetail = bothDeclared?.detail ?? '';
check('the declaration announced in two states names the one that owns it, not the one that named it first',
  [bothDeclared?.severity,
    declaredDetail.includes('declared by') && declaredDetail.includes('state_a') && declaredDetail.includes('state_b'),
    declaredDetail.includes('once — in state_b, the state whose own reading best supports the declaration')],
  ['info', true, true]);
check('and the element itself carries the other state, so the graph alone says it appears twice',
  elementIn(ownerMoved.graph, 'state_b').metadata?.extra?.also_declared_in ?? null, ['state_a']);

// The other half: when the first state to declare it *can* show it, nothing moves, and the refuted
// declaration is the later one. A rule that reordered ownership on every second declaration would
// be worse than the order it replaced.
const ownerKept = rule({
  observations: [
    shows(OBS('obs_0001', 'http://x/cart'), ELEMENT('pay_button')),
    shows(OBS('obs_0002', 'http://x/checkout'), ELEMENT('continue_shopping')),
  ],
  states: [declares('state_a', 'obs_0001', 'cart'), declares('state_b', 'obs_0002', 'checkout')],
  transitions: [],
});
check('when both readings show it, the state that declared it first keeps it',
  [elementIn(ownerKept.graph, 'state_a').id ?? null,
    stateIn(ownerKept.graph, 'state_b').metadata?.extra?.elements_declared_elsewhere ?? null],
  ['element_pay_button', { pay_button: 'state_a' }]);
check('and the refuted declaration is the later one, which changed nothing about the element',
  finding(ownerKept.report, 'element_declaration_refuted_by_its_reading')?.scope, 'state_b');
check('the element keeps the owner\'s role, name and locator rather than the latest declaration\'s',
  [elementIn(ownerKept.graph, 'state_a').role ?? null, ownerKept.report.elements],
  ['button', { declared: 1, conflicts: 0, shared: 1 }]);

// And a reading that cannot say is not a reading that says no. Here the state whose reading is
// silent declared the element in a repeat reading, while the state whose reading was read and did
// not show it is the canonical record — so any rule that falls back to canonical, or to nothing at
// all, hands the element to the state that has the worse evidence. Only keeping `null` apart from
// `false` keeps it where the evidence is merely absent rather than against.
const ownerKeptBySilence = rule({
  observations: [
    silent(OBS('obs_0001', 'http://x/cart')),
    shows(OBS('obs_0002', 'http://x/checkout'), ELEMENT('continue_shopping')),
  ],
  states: [
    STATE({
      id: 'state_a',
      state_id: 'state_a',
      observation_id: 'obs_0001',
      identity: { page_type: 'cart' },
      identity_key: JSON.stringify(['cart', '', []]),
      detection: [{ type: 'url' }],
    }),
    { id: 'state_a_r2', kind: 'sighting', state_id: 'state_a', elements: [ELEMENT('pay_button')] },
    declares('state_b', 'obs_0002', 'checkout'),
  ],
  transitions: [],
});
check('a reading that recorded no surface does not lose the declaration to a reading that did',
  elementIn(ownerKeptBySilence.graph, 'state_a').id ?? null, 'element_pay_button');
check('and the state whose reading was read and does not show it is the one reported',
  [finding(ownerKeptBySilence.report, 'element_declaration_refuted_by_its_reading')?.scope ?? null,
    stateIn(ownerKeptBySilence.graph, 'state_b').metadata?.extra?.elements_declared_elsewhere ?? null],
  ['state_b', { pay_button: 'state_a' }]);
// The decision itself, at the smallest size it can be tested: the pure comparator, all three
// answers and both tie-breaks.
const rank = (observed, canonical = true) => ({ observed, canonical, purpose: 'pay_button', state_id: 'state_a' });
check('the evidence ranking, one comparison at a time',
  [
    outranksAsEvidence(rank(true), rank(null)), outranksAsEvidence(rank(true), rank(false)),
    outranksAsEvidence(rank(null), rank(false)), outranksAsEvidence(rank(false), rank(true)),
    outranksAsEvidence(rank(null, true), rank(null, false)), outranksAsEvidence(rank(null, false), rank(null, true)),
    outranksAsEvidence(rank(true), rank(true)), outranksAsEvidence(rank(false), rank(false)),
  ],
  [true, true, true, false, true, false, false, false]);

// --- state variables: a difference that is neither a screen nor nothing -----
// What a step changed that the application *remembers* belongs in the state's identity, as a
// dimension, or the graph either loses a real difference or reports one screen per value. Two
// things make that decidable: which effects move a variable at all, and whether any state names
// it. Neither answer is the machinery's to settle — the names are the model's — so both are
// reported and neither refuses.
check('a variable is something the app remembers, not what a form holds',
  [
    stateVariablesOf([
      { type: 'storage_changed', target: 'cart_count' },
      { type: 'list_changed', target: 'cart.items' },
      { type: 'value_changed', target: 'email_input', to: 'a@b.c' },
      { type: 'visibility_changed', target: 'banner', to: 'visible' },
      { type: 'element_created', target: 'row_7' },
      { type: 'message', message: 'Coupon applied.' },
    ]).map((variable) => `${variable.kind}:${variable.name}`),
    // A variable named twice is one variable, and the order is the names' rather than the
    // effects', so the rollup does not depend on which step happened to be recorded first.
    stateVariablesOf([
      { type: 'list_changed', target: 'b.items' },
      { type: 'storage_changed', target: 'a' },
      { type: 'storage_changed', target: 'a' },
    ]).map((variable) => variable.name),
  ],
  [['collection:cart.items', 'storage:cart_count'], ['a', 'b.items']]);
check('a state variable is recognised by its own name or by its last segment, because two authors name it',
  [
    sameVariableName('cart.items', 'cart.items'), sameVariableName('cart.items', 'items'),
    sameVariableName('items', 'cart.items'), sameVariableName('cart', 'cart.items'),
    sameVariableName(null, 'cart'), sameVariableName(undefined, undefined),
  ],
  [true, true, true, false, false, false]);
// The two halves of a variable, and the whole point of the split: a *collection* is a dimension
// candidate — it is something the screen is showing, so a browser can be asked about it — and a
// *storage key* is not. The rule below asks only about the first, which is why the middle case
// answers nothing: `cart.count` written to storage is a fact about what the application remembers,
// and demanding a dimension for it would demand an assertion no browser can evaluate.
check('and a variable no state records is the one worth reporting',
  [
    unrecordedStateVariables(
      [{ type: 'storage_changed', target: 'cart.items' }, { type: 'list_changed', target: 'coupon' }],
      [{ dimensions: { items: 'non_empty', coupon: 'applied' } }],
    ).map((variable) => variable.name),
    unrecordedStateVariables(
      [{ type: 'storage_changed', target: 'cart.count' }],
      [{ dimensions: { cart: 'non_empty' } }, {}],
    ).map((variable) => variable.name),
    unrecordedStateVariables(
      [{ type: 'list_changed', target: 'cart.count' }],
      [{ dimensions: { cart: 'non_empty' } }, {}],
    ).map((variable) => variable.name),
    dimensionNamesOf({ dims: 1 }),
  ],
  [[], [], ['cart.count'], []]);

// The rule itself: a step changed a collection the screen is showing, and the state it arrived in
// says nothing about it.
const movedVariable = rule({
  observations: [OBS('obs_0001', 'http://x/cart'), OBS('obs_0002', 'http://x/cart')],
  states: [
    STATE({ identity: { page_type: 'cart' } }),
    STATE({
      id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002',
      identity: { page_type: 'cart_with_items' }, identity_key: '["cart_with_items","",[]]',
    }),
  ],
  transitions: [EDGE({
    id: 'transition_add', transition_id: 'transition_add', from_state: 'state_a', to_state: 'state_b',
    effects: [{ type: 'list_changed', target: 'cart.items', to: '3' }],
  })],
});
const unrecordedVariable = finding(movedVariable.report, 'state_variable_not_in_state_identity');
check('a step that moved a variable no state records says so, as a note on the step',
  [unrecordedVariable?.scope ?? null, unrecordedVariable?.severity, unrecordedVariable?.basis],
  ['transition_add', 'info', 'evidence_check']);
check('and says which variable, of which kind, and what to do with it',
  [(unrecordedVariable?.detail ?? '').includes('cart.items (collection)'),
    (unrecordedVariable?.detail ?? '').includes('neither state_a nor state_b'),
    (unrecordedVariable?.detail ?? '').includes('identity.dimensions ({items: non_empty})')],
  [true, true, true]);
check('and the dimension it asks for is the countable form, on the element that lists the rows',
  (unrecordedVariable?.detail ?? '').includes('{"type":"value","target":"items","element":"<the element that lists the rows>","operator":"greater_than","expected":0}'), true);
check('the edge carries the rollup, so the graph says what the step could not hold',
  movedVariable.graph.transitions.find((edge) => edge.id === 'transition_add')?.metadata?.extra?.commit?.state_variables ?? null,
  {
    moved: [{ name: 'cart.items', kind: 'collection', role: 'semantic' }],
    recorded: [],
    unrecorded: [{ name: 'cart.items', kind: 'collection', role: 'semantic' }],
    semantic: ['cart.items'],
    persistence: [],
  });

// The other half of the same question, and the one the live run got wrong: a step that wrote to
// the page's own storage changed something the application *remembers*, which is evidence and not
// an observable. It is reported — the walk did something the screen did not show — and it is
// deliberately not offered as a dimension, because a `value` assertion over a storage key is a
// check no browser can evaluate. Demanding one would be asking the model for a test that cannot be
// written, which is a worse failure than saying nothing.
const storageVariable = rule({
  observations: [OBS('obs_0001', 'http://x/login'), OBS('obs_0002', 'http://x/projects')],
  states: [
    STATE({ identity: { page_type: 'login' } }),
    STATE({
      id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002',
      identity: { page_type: 'project_list' }, identity_key: '["project_list","",[]]',
    }),
  ],
  transitions: [EDGE({
    id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
    effects: [{ type: 'storage_changed', target: 'acme-demo-state', to: '[object]' }],
  })],
});
const remembered = finding(storageVariable.report, 'persistence_evidence_recorded');
check('a write to the application\'s own storage is reported as evidence, not as a lost dimension',
  [
    finding(storageVariable.report, 'state_variable_not_in_state_identity') ?? null,
    remembered?.scope ?? null, remembered?.severity, remembered?.basis,
  ],
  [null, 'transition_login', 'info', 'evidence_check']);
check('and the finding says the key, the state it makes durable, and why it is not a dimension',
  [
    (remembered?.detail ?? '').includes('"acme-demo-state"'),
    (remembered?.detail ?? '').includes('state_b is remembered rather than merely displayed'),
    (remembered?.detail ?? '').includes('no browser can be asked what the application remembers'),
  ],
  [true, true, true]);
check('and the rollup files it as persistence rather than as an unrecorded dimension',
  storageVariable.graph.transitions[0]?.metadata?.extra?.commit?.state_variables ?? null,
  {
    moved: [{ name: 'acme-demo-state', kind: 'storage', role: 'persistence' }],
    recorded: [],
    unrecorded: [],
    semantic: [],
    persistence: ['acme-demo-state'],
  });

// §P1's persistence half: the effect is a claim about what the application *remembers*, and the
// reading is what evidences it. Both sides have to agree before the commit says a word — the
// machinery's own account of what changed (`observed_change.storage`, which the store writes) and
// the capture the reading itself holds — and when they do, the edge carries the reading that shows
// the write, naming the key and never the value. The key is what makes the claim checkable; the
// value is what a session remembers, and the live 0b run's key held the address the walk signed in
// with, so a reference that repeated it would put a credential into the semantic document.
const wroteToStorage = rule({
  observations: [
    OBS('obs_0001', 'http://x/login'),
    {
      ...OBS('obs_0002', 'http://x/projects'),
      capture: { url: 'http://x/projects', interactive: [], storage: { 'acme-demo-state': '{"user":"test@example.com"}' } },
    },
  ],
  states: [
    STATE(),
    STATE({
      id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002',
      identity: { page_type: 'project_list' }, identity_key: '["project_list","",[]]',
    }),
  ],
  transitions: [EDGE({
    id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
    before_observation: 'obs_0001', after_observation: 'obs_0002',
    effects: [{ type: 'storage_changed', target: 'localStorage.acme-demo-state', observed: true }],
    observed_change: { appeared: [], disappeared: [], storage: { 'acme-demo-state': '{"user":"test@example.com"}' } },
  })],
});
const persistenceRefs = (wroteToStorage.graph.transitions[0]?.evidence ?? [])
  .filter((ref) => typeof ref?.note === 'string' && ref.note.includes('captured storage holds'));
check('a step that wrote to storage carries the reading that shows it, and the reference names the key',
  persistenceRefs.map((ref) => [ref.observation, ref.role, ref.note.includes('"acme-demo-state"'), ref.note.includes('the reading taken before this step did not hold')]),
  [['obs_0002', 'effect', true, true]]);
check('and it does not repeat the value that was written, which stays in the reading',
  persistenceRefs.map((ref) => ref.note.includes('test@example.com')),
  [false]);

// The vocabulary's half of the same edit. A capability's evidence is the readings its committed
// edges were made from, and the note is the half of a reference that says what the reading is
// evidence *for* — the session writes one per reading, and the graph's `capabilities[].evidence[]`
// is what the model's `behaviors[].evidence[]` is built from when a behaviour has no steps of its
// own. Rebuilt as a bare `{ observation, role }` the vocabulary keeps every attribute of the
// reading except the part a reader can use.
const SESSION_NOTE = 'the surface as it stood when the action was taken (from_state)';
const wording = rule({
  transitions: [EDGE({ evidence: [{ observation: 'obs_0001', role: 'identity', note: SESSION_NOTE }] })],
});
check('a capability\'s evidence keeps the words the reading was recorded with',
  wording.graph.capabilities.map((capability) => (capability.evidence ?? []).map((ref) => ref.note)),
  [[SESSION_NOTE]]);
check('and a reading recorded without them stays without them, because nothing is minted here',
  rule({ transitions: [EDGE()] }).graph.capabilities
    .map((capability) => (capability.evidence ?? []).map((ref) => [ref.observation, ref.role, ref.note ?? null])),
  [[['obs_0001', 'identity', null]]]);

// The other half: named as a dimension *and* pinned by an assertion. Now nothing is reported,
// and that is the whole point — the graph can hold the difference without a second state for it.
const recordedVariable = rule({
  observations: [OBS('obs_0001', 'http://x/cart'), OBS('obs_0002', 'http://x/cart_with_items')],
  states: [
    STATE({ identity: { page_type: 'cart' } }),
    STATE({
      id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002',
      identity: { page_type: 'cart_with_items', dimensions: { items: 'non_empty' } },
      identity_key: '["cart_with_items","",[["items","non_empty"]]]',
      elements: [{ semantic_purpose: 'cart_items', role: 'list', name: 'Items', locator: '[data-testid="cart-items"]' }],
      // The assertion names the dimension *and* the surface a browser reads it on. A `value`
      // assertion that names no element is a check nothing can run, which is the half of the
      // same rule the ABM refuses (P7/`detection_reads_no_surface`) — so this fixture, which is
      // about the dimension being *recorded*, now records it in a form that can be checked.
      detection: [{ type: 'url' }, { type: 'value', target: 'items', element: 'cart_items', operator: 'equals', expected: 'non_empty' }],
    }),
  ],
  transitions: [EDGE({
    id: 'transition_add', transition_id: 'transition_add', from_state: 'state_a', to_state: 'state_b',
    effects: [{ type: 'list_changed', target: 'cart.items', to: '3' }],
  })],
});
check('a variable the state names as a dimension is left alone',
  [finding(recordedVariable.report, 'state_variable_not_in_state_identity'),
    finding(recordedVariable.report, 'state_dimension_not_asserted')],
  [undefined, undefined]);
check('and the rollup says it was recorded rather than lost',
  recordedVariable.graph.transitions[0]?.metadata?.extra?.commit?.state_variables ?? null,
  {
    moved: [{ name: 'cart.items', kind: 'collection', role: 'semantic' }],
    recorded: [{ name: 'cart.items', kind: 'collection', role: 'semantic' }],
    unrecorded: [],
    semantic: ['cart.items'],
    persistence: [],
  });
// The surface is the half that makes the word checkable, and the commit carries it: the walk
// names the element by purpose (that is the element's identity), the commit mints the id, and what
// lands in `detection` names both. Dropping the element here is what made a dimension assertion
// indistinguishable from a claim nothing can evaluate.
check('and the assertion the state wrote keeps the surface it is read on',
  (recordedVariable.graph.states[1]?.detection ?? []).find((entry) => entry.type === 'value') ?? null,
  { type: 'value', element: 'element_cart_items', target: 'items', operator: 'equals', expected: 'non_empty' });
// And the other way: a surface no state declares is refused, loudly, rather than written as a
// value assertion whose only content is the dimension's word.
const unreadableSurface = rule({
  states: [STATE({
    identity: { page_type: 'cart_with_items', dimensions: { items: 'non_empty' } },
    detection: [{ type: 'url' }, { type: 'value', target: 'items', element: 'cart_items', operator: 'equals', expected: 'non_empty' }],
  })],
});
check('a value assertion on an element nothing declares is refused, and the refusal is reported',
  [(unreadableSurface.graph.states[0]?.detection ?? []).some((entry) => entry.type === 'value'),
    (finding(unreadableSurface.report, 'detection_dropped')?.detail ?? '').includes('element_reference_does_not_resolve')],
  [false, true]);

// A dimension and an assertion are two halves of one thing: the word is the identity, the
// assertion is what a generated test checks. A dimension with no assertion is a state nothing can
// decide at runtime, so it is reported while the graph still can be corrected.
const unassertedDimension = rule({
  states: [STATE({
    identity: { page_type: 'cart_with_items', dimensions: { count: 'non_empty', coupon: 'applied' } },
    identity_key: '["cart_with_items","",[]]',
    elements: [{ semantic_purpose: 'cart_count', role: 'list', name: 'Items', locator: '[data-testid="cart-items"]' }],
    detection: [
      { type: 'url' },
      { type: 'value', target: 'count', element: 'cart_count', operator: 'equals', expected: 'non_empty' },
    ],
  })],
});
const unasserted = finding(unassertedDimension.report, 'state_dimension_not_asserted');
check('a dimension nothing asserts is reported, and the asserted one is not',
  [unasserted?.scope ?? null, unasserted?.severity, unasserted?.basis], ['state_a', 'info', 'vocabulary']);
check('naming the dimension and the assertion that would read it',
  [(unasserted?.detail ?? '').includes('"coupon"'), (unasserted?.detail ?? '').includes('"target":"coupon"'),
    (unasserted?.detail ?? '').includes('"count"')],
  [true, true, false]);

// --- journeys are a checked claim, not just an emitted array ----------------
// `invariantsOf` is fed a graph directly here, because the point is what the rules do with a walk
// that does not hold together — and the assembler cannot produce one, which is exactly why the
// rules are worth having.
const walkGraph = (journeys, edges) => ({
  schema_version: '0.1',
  application: { id: 'app_x', name: 'X' },
  capabilities: [CAP],
  states: [STATE(), STATE({ id: 'state_b', state_id: 'state_b', identity: { page_type: 'other' } })],
  transitions: edges,
  journeys,
});
const GO = EDGE({ id: 'transition_go', transition_id: 'transition_go', from_state: 'state_a', to_state: 'state_b' });
const BACK = EDGE({ id: 'transition_return', transition_id: 'transition_return', from_state: 'state_a', to_state: 'state_a' });
const WALK = { id: 'journey_a_to_b', name: 'w', start_state: 'state_a', transitions: ['transition_go'] };
const asInvariants = (graph) => Object.fromEntries(invariantsOf(graph).map((result) => [result.code, result]));

const goodWalk = asInvariants(walkGraph([WALK], [GO]));
check('a walk that holds together passes — and is an error-severity rule now',
  [goodWalk.journey_is_a_walk.ok, goodWalk.journey_is_a_walk.severity], [true, 'error']);
check('reachability is asked from the walk start, and this graph passes it',
  [goodWalk.reachability.ok, goodWalk.reachability.severity, goodWalk.reachability.detail.includes('from where the walks began: state_a')], [true, 'warning', true]);
check('a state the walk stopped at is not held against the graph', goodWalk.reachability.detail.includes('a walk stops at state_b'), true);

const jumped = asInvariants(walkGraph([{ ...WALK, transitions: ['transition_go', 'transition_return'] }], [GO, BACK]));
check('a journey that jumps is an error, not a warning', [jumped.journey_is_a_walk.ok, jumped.journey_is_a_walk.severity], [false, 'error']);
check('and the jump names both ends', jumped.journey_is_a_walk.detail.includes('transition_go ends at state_b and transition_return starts at state_a'), true);

const unknownStep = asInvariants(walkGraph([{ ...WALK, transitions: ['transition_go', 'transition_missing'] }], [GO]));
check('a journey naming an edge the graph lacks is a dangling reference', unknownStep.no_dangling_references.detail.includes('journey_a_to_b.transitions → transition_missing'), true);
check('and the walk rule says so too', unknownStep.journey_is_a_walk.detail.includes('which are not edges in this graph'), true);

const wrongStart = asInvariants(walkGraph([{ ...WALK, start_state: 'state_b' }], [GO]));
check('a journey whose start disagrees with its first step is refused', wrongStart.journey_is_a_walk.detail.includes('starts at state_b but its first step transition_go starts at state_a'), true);

const noStart = asInvariants({ schema_version: '0.1', application: { id: 'app_x', name: 'X' }, capabilities: [CAP], states: [STATE()], transitions: [], journeys: [] });
check('states and no walk is not vacuous: nothing is reachable', [noStart.reachability.ok, noStart.reachability.severity, noStart.reachability.detail.includes('none of its 1 state(s) is reachable from one')], [false, 'warning', true]);
const nothingAtAll = asInvariants({ schema_version: '0.1', application: { id: 'app_x', name: 'X' }, capabilities: [], states: [], transitions: [], journeys: [] });
check('with neither walk nor states there is nothing to ask, and the rule says so', [nothingAtAll.reachability.ok, nothingAtAll.reachability.severity, nothingAtAll.reachability.detail.includes('nothing to ask reachability of')], [true, 'info', true]);

// --- what cuts a walk -------------------------------------------------------
const step = (id, from, to) => ({ kind: 'transition', transition_id: id, id, from_state: from, to_state: to, recorded_at: '2026-01-01T00:00:00.000Z' });
const edge = (id, from, to) => EDGE({ id, transition_id: id, from_state: from, to_state: to });
const assembled = (transitions, edges, stateIds = new Set(['state_a', 'state_b', 'state_c', 'state_d']), instruction = null) => assembleJourneys({ transitions, edges, stateIds, generatedAt: '2026-01-01T00:00:00.000Z', instruction });

const cut = assembled(
  [step('transition_go', 'state_a', 'state_b'), step('transition_away', 'state_c', 'state_d')],
  [edge('transition_go', 'state_a', 'state_b'), edge('transition_away', 'state_c', 'state_d')],
);
check('a jump cuts the walk into two journeys', cut.journeys.map((journey) => journey.transitions), [['transition_go'], ['transition_away']]);
check('and the cut records what it joined', cut.breaks, [{ after: 'state_b', before: 'state_c', transition: 'transition_away', reason: 'walk_jumped' }]);

const restart = assembled(
  [step('transition_go', 'state_a', 'state_b'), step('transition_go', 'state_a', 'state_b')],
  [edge('transition_go', 'state_a', 'state_b')],
);
check('two walks between the same states are two journeys', restart.journeys.map((journey) => journey.id), ['journey_a_to_b', 'journey_a_to_b_2']);
check('and a second one is still a walk of one distinct edge', restart.journeys.map((journey) => journey.metadata.extra.distinct_transitions), [1, 1]);

// The same two records again, with the second one flagged as a restatement: one step of one walk,
// stated twice out of the same two readings, which is how a run corrects its own account of a step.
// The records are otherwise identical, and that is the point — what makes one a repeated walk and the
// other not is not the shape of the record but a fact only the recorder can know, written down as a
// flag, and the two cases above and below are the test of the flag.
//
// It is the 0.1.29 defect in miniature. That run recorded `transition_submit_login` with the address
// it had typed, the commit refused the edge for an argument nobody had watched, and the run recorded
// it again without the argument. The correction was invisible in the graph and visible only as a
// second, one-step journey at a step nobody had walked twice.
const restated = assembled(
  [step('transition_go', 'state_a', 'state_b'), { ...step('transition_go', 'state_a', 'state_b'), restatement: true }],
  [edge('transition_go', 'state_a', 'state_b')],
);
check('a step stated again is not a second journey', restated.journeys.map((journey) => journey.transitions), [['transition_go']]);
check('and does not cut the walk it is in', restated.breaks, []);

// A restatement holds the place the step already has, and the one field it can change is the step's
// own account of itself — including the name the model gave the walk, which is carried per step
// precisely so that a walk named once is named that way for every step of it.
const renamed = assembled(
  [
    step('transition_go', 'state_a', 'state_b'),
    step('transition_away', 'state_b', 'state_c'),
    { ...step('transition_go', 'state_a', 'state_b'), restatement: true, journey_name: 'Sign in' },
  ],
  [edge('transition_go', 'state_a', 'state_b'), edge('transition_away', 'state_b', 'state_c')],
);
check('a restated step keeps its place in the walk it is in',
  [renamed.journeys.length, renamed.journeys[0].transitions], [1, ['transition_go', 'transition_away']]);
check('and the name on it names that walk',
  [renamed.journeys[0].name, renamed.journeys[0].metadata.extra.name_source_kind,
    renamed.journeys[0].metadata.extra.name_stated],
  ['Sign in', 'model', true]);

const orphan = assembled(
  [step('transition_go', 'state_a', 'state_b'), step('transition_away', 'state_b', 'state_c')],
  [edge('transition_go', 'state_a', 'state_b')],
);
check('a step whose edge is not in the graph cannot be walked through', [orphan.steps, orphan.unusableSteps], [1, ['transition_away']]);
check('and it cuts the walk rather than being skipped over', orphan.breaks.map((entry) => entry.reason), ['edge_not_committed']);
check('an edge to a state that is not in the graph is not walked either', assembled(
  [step('transition_go', 'state_a', 'state_b')],
  [edge('transition_go', 'state_a', 'state_missing')],
).journeys, []);

// --- the goal: the run's instruction, quoted or withheld --------------------
// This is the whole of what the graph will ever say about intent, so it is worth testing on its own:
// a goal the machinery invented would be the one claim in the document with no evidence behind it.
check('an instruction is a goal, quoted as it was written',
  goalFromInstruction('Log in and check the dashboard.'), 'Log in and check the dashboard.');
check('the first sentence is the task; the rest is usually the details',
  goalFromInstruction('Sign in to the demo app, then add a product to the cart. Use the seeded account.'),
  'Sign in to the demo app, then add a product to the cart.');
check('a task with its details under it is still one goal, however the author wrapped it',
  goalFromInstruction('Log in and check the dashboard.\n\nUse the seeded account.'), 'Log in and check the dashboard.');
// A line break is not punctuation. The 0.1.21 live run's goal was the first *physical* line of a
// hard-wrapped instruction, so it read `… the credentials the page shows, and` — a quotation that
// stopped mid-sentence on the conjunction that joined it to the rest.
check('and a sentence wrapped across lines is read whole, not up to the margin',
  goalFromInstruction('Open the demo app in the browser, sign in with the credentials the page\nshows, and record what you find.\nRules: one action per step.'),
  'Open the demo app in the browser, sign in with the credentials the page shows, and record what you find.');
check('and a goal whose first sentence runs past the limit is cut and marked, not left a fragment',
  (() => {
    const wrapped = goalFromInstruction('Add a product ' + 'and a second product '.repeat(20) + '\nto the cart.');
    return [wrapped.endsWith('\u2026'), wrapped.includes('\n')];
  })(), [true, false]);
check('a line with no full stop at all is taken whole',
  goalFromInstruction('Add a product to the cart'), 'Add a product to the cart');
check('a goal that will not fit is cut on a word boundary and marked',
  (() => {
    const clipped = goalFromInstruction('Add a product ' + 'and a second product '.repeat(20));
    return [clipped.endsWith('\u2026'), clipped.length <= 161, clipped.startsWith('Add a product and a second product')];
  })(), [true, true, true]);
check('an instruction that is not a string is no goal, and whitespace is not either',
  [goalFromInstruction(null), goalFromInstruction('   '), goalFromInstruction(undefined)], [null, null, null]);

// The same instruction, read a second time as a *name* for the walk. A goal is a sentence and a
// name is a handle: quoting a whole instruction into `name` produced a journey called "Using the
// browser tools, open ...", which names the operator's prompt rather than the walk.
check('a single-clause goal is its own name, minus the full stop that made it a sentence',
  journeyNameFromGoal('Log in and check the dashboard.'), 'Log in and check the dashboard');
check('a goal with a continuation is named by its first clause, and the goal keeps every word',
  journeyNameFromGoal('Sign in to the demo app, then add a product to the cart.'), 'Sign in to the demo app');
check('the cut is at every way two clauses are joined',
  ['Add a product to the cart; then check out', 'Open the cart — add a product', 'Sign in and then log out']
    .map(journeyNameFromGoal),
  ['Add a product to the cart', 'Open the cart', 'Sign in']);
check('an instruction that opens by describing the tools is the operator\'s prompt, not the app\'s goal',
  journeyNameFromGoal('Using the browser tools, open the demo app and sign in.'), 'open the demo app and sign in');
check('a name that will not fit is cut on a word boundary and marked',
  (() => {
    const clipped = journeyNameFromGoal('Sign in to the demo application as the seeded user and reach the authenticated project list');
    return [clipped.endsWith('\u2026'), clipped.length <= 61, clipped.startsWith('Sign in to the demo application as the seeded')];
  })(), [true, true, true]);
check('and a goal that yields no clause at all is no name, so the endpoints name the walk instead',
  [journeyNameFromGoal('Using the browser tools,'), journeyNameFromGoal('   '), journeyNameFromGoal(null)], [null, null, null]);

const stated = assembled([step('transition_go', 'state_a', 'state_b')], [edge('transition_go', 'state_a', 'state_b')], undefined,
  'Log in and check the dashboard.');
check('one strand means the instruction describes exactly this walk',
  [stated.journeys[0].goal, stated.journeys[0].name], ['Log in and check the dashboard.', 'Log in and check the dashboard']);
check('and the whole instruction is kept beside the goal, so a cut one is visible as cut',
  [stated.journeys[0].metadata.extra.run_instruction, stated.journeys[0].metadata.extra.goal_stated],
  ['Log in and check the dashboard.', true]);
check('and the journey says the name came from the goal rather than from the model',
  [stated.journeys[0].metadata.extra.name_source_kind, stated.journeys[0].metadata.extra.name_stated],
  ['goal', true]);

const twoWithInstruction = assembled(
  [step('transition_go', 'state_a', 'state_b'), step('transition_away', 'state_c', 'state_d')],
  [edge('transition_go', 'state_a', 'state_b'), edge('transition_away', 'state_c', 'state_d')],
  undefined,
  'Log in and check the dashboard.',
);
// Two strands mean the instruction is about the run, and attributing it to either of them would be
// the machinery inventing a fact about intent to make the document look more finished.
check('an instruction that describes the run is not attributed to a walk',
  twoWithInstruction.journeys.map((entry) => [entry.goal ?? null, entry.metadata.extra.goal_stated]),
  [[null, false], [null, false]]);
check('but it is still carried, unclaimed, on every journey',
  twoWithInstruction.journeys.map((entry) => entry.metadata.extra.run_instruction),
  ['Log in and check the dashboard.', 'Log in and check the dashboard.']);
check('and each journey says why the goal was withheld',
  twoWithInstruction.journeys[0].metadata.extra.goal_source.includes('withheld'), true);
check('a withheld goal still names the walk by its endpoints',
  twoWithInstruction.journeys.map((entry) => entry.name),
  ['Derived walk 1: state_a to state_b (1 step(s))', 'Derived walk 2: state_c to state_d (1 step(s))']);

const unstated = assembled([step('transition_go', 'state_a', 'state_b')], [edge('transition_go', 'state_a', 'state_b')]);
check('with no instruction there is no goal, and none is invented',
  [unstated.journeys[0].goal ?? null, unstated.journeys[0].metadata.extra.goal_stated,
    'run_instruction' in unstated.journeys[0].metadata.extra], [null, false, false]);
check('and the journey says the run recorded none',
  unstated.journeys[0].metadata.extra.goal_source.includes('the run recorded no instruction'), true);

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

// ---------------------------------------------------------------------------
// 0.1.21: the count, the linkage, the feature, the name
// ---------------------------------------------------------------------------
// Four rules that exist so that a *generator* has something to work from, which is the milestone
// this version was written for. Each is tested against the fixture the live run produced, because
// the live run is where each of them was found wanting.

// `projects: non_empty` was the live run's uncheckable dimension, and the reason it was uncheckable
// was that the model named the dimension `projects` while naming the element `project_list`, so the
// exact name match never fired.
check('two spellings of one collection are recognised as one',
  [sameCollectionName('projects', 'project_list'), sameCollectionName('cart_items', 'cartItems'),
    sameCollectionName('project_list', 'projects')],
  [true, true, true]);
check('but a word from the middle of a name is not the head or the tail of it',
  [sameCollectionName('item', 'cart_item_price'), sameCollectionName('cart', 'shopping_cart_items')],
  [false, false]);
check('and two names with nothing in common are two collections',
  [sameCollectionName('projects', 'invoices'), sameCollectionName('projects', '')],
  [false, false]);

const COUNTED_ELEMENT = { semantic_purpose: 'project_list', role: 'list', name: 'Projects', locator: '[data-testid="project-list"]' };
const countedObservation = (id, rows) => ({
  ...OBS(id, 'http://x/projects'),
  tool: 'browser_click',
  capture: { url: 'http://x/projects', interactive: [{ role: 'list', name: 'Projects', items: rows, ...(rows ? { first_item: 'Alpha' } : {}) }] },
});
const countedWalk = ({ rows, dimensions = { projects: 'non_empty' }, elements = [COUNTED_ELEMENT] }) => rule({
  observations: [OBS('obs_0001', 'http://x/login'), countedObservation('obs_0002', rows)],
  states: [
    STATE(),
    STATE({
      id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002',
      identity: { page_type: 'project_list', dimensions },
      identity_key: '["project_list","",[["projects","non_empty"]]]',
      detection: [{ type: 'url' }],
      elements,
    }),
  ],
  transitions: [EDGE({
    id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
    before_observation: 'obs_0001',
    after_observation: 'obs_0002',
    // Both readings carry role `action`, which is the shape that caused the misattribution: a
    // recorder that cannot tell the reading it acted on from the reading it produced writes the
    // same role on both, and the rank rule alone then gives the step to whichever it reaches last.
    // Only the edge's own `after_observation` says which of them is the step.
    evidence: [{ observation: 'obs_0001', role: 'action' }, { observation: 'obs_0002', role: 'action' }],
    effects: [{ type: 'state_entered', to: 'state_b' }],
  })],
});
const counted = countedWalk({ rows: 3 });
const countedCommit = counted.graph.transitions[0].metadata.extra.commit;
const counterCandidate = countedCommit.candidate_assertions.find((candidate) => candidate.basis === 'dimension');
check('a dimension a reading counted becomes an assertion of the count, on the element it counted',
  counterCandidate?.assertion, { type: 'value', target: 'projects', element: 'element_project_list', operator: 'greater_than', expected: 0 });
check('and the candidate says which reading counted it and how many rows it saw',
  [counterCandidate?.from, (counterCandidate?.detail ?? '').includes('counted 3 row(s) in element_project_list')],
  ['obs_0002', true]);
check('and it is offered as a candidate rather than written into the edge\'s own assertions',
  [counted.graph.transitions[0].assertions ?? [], countedCommit.candidate_assertions.map((candidate) => candidate.basis)],
  [[], ['effect', 'dimension']]);
check('a dimension the reading counted zero rows for is declined, not proposed as a passing check',
  (() => {
    const commit = countedWalk({ rows: 0 }).graph.transitions[0].metadata.extra.commit;
    return [commit.candidate_assertions.filter((candidate) => candidate.basis === 'dimension').length,
      commit.candidate_assertions_declined.find((item) => item.effect === 'dimension')?.reason];
  })(),
  [0, 'no_reading_counted_the_collection']);
check('an empty collection is countable too, when that is what the dimension claims',
  (() => {
    const commit = countedWalk({ rows: 0, dimensions: { projects: 'empty' } }).graph.transitions[0].metadata.extra.commit;
    return commit.candidate_assertions.find((candidate) => candidate.basis === 'dimension')?.assertion;
  })(),
  { type: 'value', target: 'projects', element: 'element_project_list', operator: 'equals', expected: 0 });
check('two collections that could be the one named is not a tie broken in private',
  (() => {
    const two = countedWalk({
      rows: 3,
      elements: [COUNTED_ELEMENT, { semantic_purpose: 'project_list_summary', role: 'list', name: 'Projects', locator: '[data-testid="project-summary"]' }],
    }).graph.transitions[0].metadata.extra.commit;
    const declined = two.candidate_assertions_declined.find((item) => item.reason === 'more_than_one_collection_could_be_the_one');
    return [two.candidate_assertions.filter((candidate) => candidate.basis === 'dimension').length, declined?.target];
  })(),
  [0, 'projects']);

// Item 5 of the review, which was the misattribution: `obs_0001` documented the step it was the
// *input* to. The rule: only the reading an action produced documents that action.
check('the reading a step was made from does not document the step, and says whose source it is',
  (() => {
    const [before] = counted.graph.observations;
    return [before.transition ?? null, before.metadata.extra.linkage.observation_role,
      before.metadata.extra.linkage.precedes, before.metadata.extra.linkage.documents];
  })(),
  [null, 'before_action', ['transition_login'], null]);
check('while the reading the action produced documents it, and is named as the step\'s own',
  (() => {
    const after = counted.graph.observations[1];
    return [after.transition, after.metadata.extra.linkage.observation_role,
      after.metadata.extra.linkage.documents, after.metadata.extra.linkage.action];
  })(),
  ['transition_login', 'after_action', 'transition_login', { tool: 'browser_click', arguments: null }]);
check('and the edge says which two readings it was made of, by id',
  [countedCommit.step.before_observation, countedCommit.step.after_observation, countedCommit.step.before_role, countedCommit.step.after_role],
  ['obs_0001', 'obs_0002', 'identity', 'action']);
check('a step that started where it arrived points at one reading, not two',
  (() => {
    const selfLoop = rule({ transitions: [EDGE({ evidence: [{ observation: 'obs_0001', role: 'action' }] })] });
    const linkage = selfLoop.graph.observations[0].metadata.extra.linkage;
    return [linkage.observation_role, linkage.documents, linkage.precedes];
  })(),
  ['after_action', 'transition_go', []]);

// Item 9 of the review: `features: []` was the missing semantic layer. The name is the model's word,
// the membership is derived, and what no step named is reported rather than covered by invention.
const featuredWalk = rule({
  capabilities: [CAP, { kind: 'capability', id: 'cap_login', capability_id: 'cap_login', name: 'login', composed_of: ['cap_go'] }],
  observations: [OBS('obs_0001', 'http://x/login'), countedObservation('obs_0002', 3)],
  states: [
    STATE(),
    STATE({ id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002', identity: { page_type: 'project_list' }, identity_key: '["project_list","",[]]' }),
  ],
  transitions: [EDGE({
    id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
    action: { capability: 'cap_go' },
    feature: 'Authentication',
    evidence: [{ observation: 'obs_0001', role: 'identity' }, { observation: 'obs_0002', role: 'action' }],
  })],
});
const feature = featuredWalk.graph.features[0];
check('a feature exists because a step named it, with the model\'s own spelling as its name',
  [feature?.id, feature?.name], ['feature_authentication', 'Authentication']);
check('and its membership is the steps that named it, and the composite that contains their capability',
  [feature?.capabilities, feature?.states, feature?.transitions, feature?.journeys],
  [['cap_go', 'cap_login'], ['state_a', 'state_b'], ['transition_login'], ['journey_a_to_b']]);
check('the feature says who named it and where its id came from, because a name is not evidence',
  [feature?.metadata.extra.declared.claimed_by, feature?.metadata.extra.id_from,
    feature?.metadata.extra.observed.transitions],
  ['graph_transition `feature` argument', 'slugify("Authentication") → feature_authentication', 1]);
check('and the report says what no feature covers, rather than covering it',
  [featuredWalk.report.features.claimed, featuredWalk.report.features.committed, featuredWalk.report.features.unassigned.transitions],
  [['Authentication'], 1, []]);
check('a name with nothing alphanumeric in it cannot become an id, and the claim is not committed',
  (() => {
    const named = rule({ transitions: [EDGE({ feature: '???' })] });
    return [named.graph.features, named.graph.warnings.some((line) => line.includes('has no letters or digits'))];
  })(),
  [[], true]);
check('a feature closure that is not complete warns, and says exactly what nobody named',
  (() => {
    const partial = rule({
      capabilities: [CAP, { kind: 'capability', id: 'cap_other', capability_id: 'cap_other', name: 'other' }],
      transitions: [EDGE({ feature: 'Authentication' })],
    });
    const result = invariantsOf(partial.graph).find((entry) => entry.code === 'feature_closure');
    // A warning and not a gate: naming one area and walking three is a real, useful graph, and the
    // check's job is to say which parts nobody named rather than to refuse the run.
    return [result.ok, result.severity, result.detail.includes('capabilities: cap_other'), result.detail.includes('1 of 4 object(s)')];
  })(),
  [false, 'warning', true, true]);

// Naming by the model, which outranks the goal: the model naming the walk it is walking says what
// the walk *is*, and the goal says only what it was for.
const claimedJourney = rule({
  observations: [OBS('obs_0001', 'http://x/login'), OBS('obs_0002', 'http://x/projects')],
  states: [STATE(), STATE({ id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002', identity: { page_type: 'project_list' }, identity_key: '["project_list","",[]]' })],
  transitions: [EDGE({
    id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
    journey_name: 'Sign in to Acme Demo',
    evidence: [{ observation: 'obs_0001', role: 'identity' }, { observation: 'obs_0002', role: 'action' }],
  })],
});
check('the model\'s own name for the walk is the journey\'s name, and outranks the goal',
  [claimedJourney.graph.journeys[0].name, claimedJourney.graph.journeys[0].metadata.extra.name_source_kind,
    claimedJourney.report.journeys.named_by_model],
  ['Sign in to Acme Demo', 'model', 1]);
check('and every claim is kept beside the name, so a disagreement is readable',
  (() => {
    const twice = rule({
      observations: [OBS('obs_0001', 'http://x/login'), OBS('obs_0002', 'http://x/projects')],
      states: [STATE(), STATE({ id: 'state_b', state_id: 'state_b', observation_id: 'obs_0002', identity: { page_type: 'project_list' }, identity_key: '["project_list","",[]]' })],
      transitions: [EDGE({
        id: 'transition_login', transition_id: 'transition_login', from_state: 'state_a', to_state: 'state_b',
        journey_name: 'Sign in',
        evidence: [{ observation: 'obs_0001', role: 'identity' }, { observation: 'obs_0002', role: 'action' }],
      }), EDGE({
        id: 'transition_back', transition_id: 'transition_back', from_state: 'state_b', to_state: 'state_a',
        journey_name: 'Log in to the demo',
        evidence: [{ observation: 'obs_0002', role: 'identity' }],
      })],
    });
    return [twice.graph.journeys[0].name, twice.graph.journeys[0].metadata.extra.journey_names_claimed,
      twice.report.journeys.name_conflicts];
  })(),
  ['Log in to the demo', ['Sign in', 'Log in to the demo'], [{ journey: 'journey_a_to_a', claimed: ['Sign in', 'Log in to the demo'] }]]);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
