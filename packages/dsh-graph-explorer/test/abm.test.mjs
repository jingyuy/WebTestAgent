/**
 * The profile rules, one at a time, against a run that reproduces the 0.1.22 walk in miniature.
 *
 * The fixture below is the sign-in walk shrunk to what the rules need: two states, four committed
 * capabilities (three steps and the composite that names them), three edges, one journey. Its
 * point is that the projection of it fails exactly the way the real 0.1.22 graph does — three P1
 * errors, three P2 warnings and nine P14 errors (D9's laundering, D11's ceiling) — so every other
 * case in this file can be read as "break exactly this one thing, and exactly this one rule
 * notices". Its `metadata` blocks are the producers the real commit wrote, because a fixture
 * without them would be a document nothing had claimed anything about, and P14's whole subject is
 * who claimed what.
 *
 * The rule is what is asserted, never the wording: each case names the rule, the code and the
 * subject, because those three are the contract `reconcile()` will enforce in phase 2. The
 * severities are checked against `PROFILE_RULES` at the end, so a rule that starts reporting a
 * weaker severity than §3 gives it fails here rather than in a green commit.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAIM_LEVELS,
  LEVEL_CEILING,
  MECHANISM_VERBS,
  PROFILE_RULES,
  candidatesFromRun,
  claimLevel,
  claimsOf,
  graphShapeOf,
  modelFromCandidates,
  profileFindings,
  summarizeFindings,
} from '../lib/abm.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    fails++;
    console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected));
  } else console.log('ok  ', label);
};

const ok = (label, condition, detail = '') => {
  if (condition) { console.log('ok  ', label); return; }
  fails++;
  console.log('FAIL', label, detail ? `\n  ${detail}` : '');
};

// --- the fixture -------------------------------------------------------------------------------
// The 0.1.22 walk, reduced to what the rules read. Names, ids and the shape of the evidence are
// copied from the real run (`~/tmp/live-graph/graph-run`): the defect this suite quantifies is the
// one that run produced, and a fixture that renamed things would be measuring a different walk.

const evidence = (observation, role) => ({ observation, role });
const THREE_ROLES = [evidence('obs_0001', 'identity'), evidence('obs_0002', 'action'), evidence('obs_0002', 'effect')];

const element = (id, role, name, extra = {}) => ({
  id,
  role,
  name,
  semantic: { purpose: id.replace(/^element_/, '') },
  locator: { strategy: 'label', value: name },
  evidence: [evidence('obs_0001', 'element')],
  metadata: { confidence: 1, status: 'verified', producer: 'playwright' },
  ...extra,
});

export const candidates = () => structuredClone({
  run: { instruction: 'Sign in with test@example.com and password123.' },
  application: { id: 'app_acme-demo', name: 'Acme Demo App', base_url: 'http://127.0.0.1:4173/' },
  observations: [
    { id: 'obs_0001', type: 'browser_state', timestamp: '2026-09-18T10:00:01Z', state: 'state_login_anonymous' },
    { id: 'obs_0002', type: 'action', timestamp: '2026-09-18T10:00:02Z', parent: 'obs_0001', action: { raw: 'fill Email', arguments: { value: 'test@example.com' } } },
    { id: 'obs_0003', type: 'browser_state', timestamp: '2026-09-18T10:00:03Z', state: 'state_project_list_authenticated_projects_populated', transition: 'transition_submit_login', parent: 'obs_0002' },
  ],
  states: [
    {
      id: 'state_login_anonymous',
      identity: { route: '/', page_type: 'login', variant: 'anonymous' },
      kind: 'page',
      elements: [
        element('element_email_input', 'textbox', 'Email', { actions: ['fill'] }),
        element('element_password_input', 'textbox', 'Password', { actions: ['fill'] }),
        element('element_login_button', 'button', 'Sign in', { actions: ['click'] }),
        element('element_forgot_password_link', 'link', 'Forgot password?', { actions: ['click'] }),
      ],
      detection: [{ type: 'element_state', element: 'element_login_button', operator: 'exists' }],
      capabilities: ['cap_fill_login_email', 'cap_fill_login_password', 'cap_submit_login'],
      evidence: [evidence('obs_0001', 'identity')],
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'state_project_list_authenticated_projects_populated',
      identity: { route: '/', page_type: 'project_list', variant: 'authenticated', dimensions: { projects: 'populated' } },
      kind: 'page',
      elements: [
        element('element_project_list', 'list', 'Project list', { evidence: [evidence('obs_0003', 'identity')] }),
        element('element_add_project_button', 'button', 'Add project', { evidence: [evidence('obs_0003', 'element')] }),
      ],
      detection: [{ type: 'element_state', element: 'element_project_list', operator: 'exists' }],
      evidence: [evidence('obs_0003', 'identity')],
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
  ],
  capabilities: [
    {
      id: 'cap_fill_login_email',
      name: 'fill_login_email',
      kind: 'interaction',
      description: 'Type the account email into the sign-in form.',
      input: { email: { type: 'string', required: true } },
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'cap_fill_login_password',
      name: 'fill_login_password',
      kind: 'interaction',
      input: { password: { type: 'string', required: true } },
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'cap_submit_login',
      name: 'submit_login',
      kind: 'interaction',
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'cap_login',
      name: 'login',
      kind: 'interaction',
      description: 'Sign in and reach the project list.',
      composed_of: ['cap_fill_login_email', 'cap_fill_login_password', 'cap_submit_login'],
      metadata: { confidence: 0.5, status: 'inferred', producer: 'llm:deepseek-flash' },
    },
  ],
  transitions: [
    {
      id: 'transition_fill_login_email',
      from_state: 'state_login_anonymous',
      to_state: 'state_login_anonymous',
      action: { capability: 'cap_fill_login_email', arguments: { email: 'test@example.com' }, target: 'element_email_input' },
      guard: null,
      effects: [{ type: 'value_changed', target: 'element_email_input', to: 'test@example.com', observed: true }],
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'transition_fill_login_password',
      from_state: 'state_login_anonymous',
      to_state: 'state_login_anonymous',
      action: { capability: 'cap_fill_login_password', arguments: { password: '[set]' }, target: 'element_password_input' },
      effects: [{ type: 'value_changed', target: 'element_password_input', to: '[set]', observed: true }],
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
    {
      id: 'transition_submit_login',
      from_state: 'state_login_anonymous',
      to_state: 'state_project_list_authenticated_projects_populated',
      action: { capability: 'cap_submit_login', target: 'element_login_button' },
      effects: [
        { type: 'state_entered', to: 'state_project_list_authenticated_projects_populated', observed: true },
        { type: 'storage_changed', target: 'localStorage.acme-demo-state', observed: true },
      ],
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    },
  ],
  journeys: [
    {
      id: 'journey_login_anonymous_to_project_list',
      name: 'Sign in to the Acme demo app',
      goal: 'Sign in with test@example.com and password123.',
      start_state: 'state_login_anonymous',
      transitions: ['transition_fill_login_email', 'transition_fill_login_password', 'transition_submit_login'],
      evidence: [evidence('obs_0001', 'identity'), evidence('obs_0003', 'effect')],
      metadata: { status: 'inferred', producer: 'importer:dsh-graph-explorer', extra: { goal_stated: true } },
    },
  ],
});

/** A projection of the fixture, plus the profile of it, in the shape every case below edits. */
const projected = (over = {}) => {
  const source = { ...candidates(), ...over };
  const model = modelFromCandidates(source);
  return { model, source, findings: profileFindings(model, { candidates: source }) };
};

const codes = (findings) => findings.map((finding) => `${finding.rule}:${finding.code}`).sort();
const subjects = (findings, rule) => findings.filter((finding) => finding.rule === rule).map((finding) => finding.subject).sort();
const withRule = (findings, rule) => findings.filter((finding) => finding.rule === rule);

// --- the projection ----------------------------------------------------------------------------

console.log('\n# projection');
{
  const { model } = projected();
  check('actors are the variants the run distinguished',
    model.application.actors.map((actor) => actor.id), ['anonymous', 'authenticated']);
  // The variant is all a run can witness, so with nothing declared that is all the projection may
  // name — and it says so in the description rather than letting a derived id read as a decided
  // role. `application.actors[]` cannot carry metadata, so the description is the only place the
  // document has to admit the row was derived.
  check('and each one admits it was derived, because an actor has no metadata to say it in',
    model.application.actors.map((actor) => actor.description),
    ['Observed as the surface variant "anonymous"; the projection cannot say what it means.',
      'Observed as the surface variant "authenticated"; the projection cannot say what it means.']);

  // --- a declared vocabulary -------------------------------------------------------------------
  // The declaration is the one input the evidence cannot supply, so this is the one place the
  // projection has something to copy rather than something to name: a role the run never used is
  // still a role the application can be exercised as, and `credentials_ref` names a credential no
  // page ever shows. What is *not* copied is a role the walk used and nobody declared — that id is
  // a reference every state variant already makes, so dropping it would break the document rather
  // than report the omission.
  const vocabulary = projected({
    application: {
      id: 'app_acme-demo', name: 'Acme Demo App', base_url: 'http://127.0.0.1:4173/',
      actors: [
        { id: 'anonymous', description: 'Nobody is signed in.' },
        { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
        { id: 'admin', description: 'A role this run never exercised.' },
      ],
    },
  });
  check('a declared vocabulary is carried as declared, in the order it was declared',
    vocabulary.model.application.actors,
    [
      { id: 'anonymous', description: 'Nobody is signed in.' },
      { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
      { id: 'admin', description: 'A role this run never exercised.' },
    ]);
  check('a declared role the walk read no state as is kept, and named as the declaration named it',
    vocabulary.model.application.actors.find((actor) => actor.id === 'admin').description,
    'A role this run never exercised.');
  const partial = projected({
    application: { id: 'app_acme-demo', name: 'Acme Demo App', actors: [{ id: 'anonymous', description: 'Nobody is signed in.' }] },
  });
  check('a used role the declaration omits is carried with the derived wording, after the declared ones',
    partial.model.application.actors,
    [
      { id: 'anonymous', description: 'Nobody is signed in.' },
      { id: 'authenticated', description: 'Observed as the surface variant "authenticated"; the projection cannot say what it means.' },
    ]);
  // A declaration is not a repair: it adds rows, and it must not make a document that says more
  // than the walk did. The states, behaviours and transitions are the evidence's, unchanged.
  check('and a declaration adds actors without touching anything the run recorded',
    [vocabulary.model.states.length, vocabulary.model.behaviors.length, vocabulary.model.transitions.length],
    [model.states.length, model.behaviors.length, model.transitions.length]);
  check('one behaviour per committed capability, in document order',
    model.behaviors.map((behavior) => behavior.id),
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login', 'behavior_login']);
  check('composed_of names behaviours, not capabilities',
    model.behaviors.find((behavior) => behavior.id === 'behavior_login').composed_of,
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login']);
  check('state.behaviors is the inverse view of the edges, plus what 0.1 recorded as offered',
    model.states[0].behaviors,
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login']);
  check('affordances are the declared controls no committed step used',
    model.states[0].affordances.map((affordance) => affordance.element), ['element_forgot_password_link']);
  check('a non-control (a list) is not an affordance, and an untouched button is',
    model.states[1].affordances.map((affordance) => affordance.element), ['element_add_project_button']);
  check('an affordance carries the confidence of a claim nothing refuted',
    model.states[1].affordances[0].metadata.confidence, 0.3);
  check('a dimension becomes a state variable whose detection reads the state\'s own element',
    model.state_variables,
    [{
      name: 'projects',
      description: 'A distinction a state identity draws; the projection cannot say what it means.',
      type: 'string',
      values: ['populated'],
      dimension_of: ['state_project_list_authenticated_projects_populated'],
      detection: { type: 'value', element: 'element_project_list', operator: 'equals', expected: 'populated' },
      evidence: [evidence('obs_0003', 'identity')],
      metadata: {
        confidence: 0.5,
        status: 'inferred',
        producer: 'importer:dsh-graph-explorer',
        extra: { derived: 'state.identity.dimensions' },
      },
    }]);
  check('the journey keeps the walk order, the edge arguments and the starting variant',
    model.journeys[0].steps.map((step) => [step.transition, step.arguments?.email ?? step.arguments?.password ?? null]),
    [['transition_fill_login_email', 'test@example.com'], ['transition_fill_login_password', '[set]'], ['transition_submit_login', null]]);
  check('goal_stated is the commit\'s flag, not a guess', model.journeys[0].goal_stated, true);
  check('the journey actor is the variant the walk started as', model.journeys[0].actor, 'anonymous');
  ok('the actor choice is recorded in the document\'s own notes',
    model.warnings.some((note) => note.includes('starts as "anonymous" and ends as "authenticated"')),
    JSON.stringify(model.warnings));
  ok('a null guard is not carried (0a: null is not a value here)',
    !('guard' in model.transitions[0]), JSON.stringify(model.transitions[0].guard));
  ok('the projection never writes to the candidates it read',
    candidates().capabilities[0].evidence.length === 3 && model.capabilities === undefined);
}

// --- the fixture is the defect it reproduces ----------------------------------------------------

console.log('\n# the 0.1.22 defect, in miniature');
{
  const { findings, source } = projected();
  check('three P1 errors (the mechanism names), three P2 warnings (steps with no realization)',
    codes(findings.filter((finding) => finding.rule === 'P1' || finding.rule === 'P2')),
    ['P1:behavior_name_is_a_mechanism', 'P1:behavior_name_is_a_mechanism', 'P1:behavior_name_is_a_mechanism',
      'P2:behavior_without_realization', 'P2:behavior_without_realization', 'P2:behavior_without_realization']);
  check('P1 refuses the three capabilities the real run committed',
    subjects(findings, 'P1'),
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login']);
  check('and passes the composite that names the goal', subjects(findings, 'P1').includes('behavior_login'), false);
  const p14 = withRule(findings, 'P14');
  // A derived state variable used to claim `verified` with no producer behind it, which is the one
  // claim in the projection that outranked the reading it came from. It is now inferred, honestly,
  // and P14 no longer refuses it: the level is the level of the thing that produced it.
  check('P14 refuses eight claims the same way the real walk measured (8 read, 0 derived)',
    [p14.length, p14.filter((finding) => finding.code === 'claim_outranks_its_producer').length,
      p14.filter((finding) => finding.code === 'claim_has_no_producer').length],
    [8, 8, 0]);
  check('and the three steps, their three edges and both states are which',
    subjects(findings, 'P14'),
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login',
      'state_login_anonymous', 'state_project_list_authenticated_projects_populated',
      'transition_fill_login_email', 'transition_fill_login_password', 'transition_submit_login']);
  check('the composite and the journey are the two the commit wrote honestly, so they are untouched',
    [subjects(findings, 'P14').includes('behavior_login'), subjects(findings, 'P14').includes('journey_login_anonymous_to_project_list')],
    [false, false]);
  check('the summary counts them the way a gate would read them', summarizeFindings(findings),
    { total: 14, errors: 11, warnings: 3, infos: 0, bySeverity: { info: 0, warning: 3, error: 11 }, byRule: { P1: 3, P2: 3, P14: 8 }, failed: true });
  ok('the fixture really is the run\'s own vocabulary',
    MECHANISM_VERBS.has('fill') && MECHANISM_VERBS.has('submit') && source.capabilities[3].name === 'login');
}

// --- P1 ------------------------------------------------------------------------------------------

console.log('\n# P1 a behaviour is named for the goal');
{
  const { model } = projected();
  for (const behavior of model.behaviors) {
    if (behavior.name !== 'login') continue;
    behavior.name = 'open_login';
  }
  const findings = profileFindings(model, {});
  ok('a name that repeats the surface is refused for that reason',
    withRule(findings, 'P1').some((finding) => finding.subject === 'behavior_login' && finding.detail.includes('repeats the surface')),
    JSON.stringify(withRule(findings, 'P1')));
}
{
  const { findings } = projected({
    capabilities: [
      { id: 'cap_login', name: 'login', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' } },
      { id: 'cap_sign_in', name: 'sign_in', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' } },
      { id: 'cap_view_projects', name: 'view_projects', kind: 'query', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' } },
      { id: 'cap_add_project', name: 'add_project', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' } },
    ],
  });
  ok('goal names pass: the leading verb is not a mechanism verb and no later word is the surface',
    withRule(findings, 'P1').length === 0, JSON.stringify(withRule(findings, 'P1')));
  ok('including a name whose later word is an element\'s name: view_projects is a sentence a user says',
    !withRule(findings, 'P1').length);
}

// --- P2, P3 ------------------------------------------------------------------------------------

console.log('\n# P2 how it is performed, P3 what a composition is made of');
{
  const { model } = projected();
  const behavior = model.behaviors.find((entry) => entry.id === 'behavior_submit_login');
  behavior.realization = [{ action: 'click', element: 'element_login_button' }];
  check('a realization step answers P2 for that behaviour',
    subjects(profileFindings(model, {}), 'P2'), ['behavior_fill_login_email', 'behavior_fill_login_password']);
}
{
  const { model } = projected();
  model.behaviors.push({ id: 'behavior_dismiss_banner', name: 'dismiss_banner', kind: 'navigation' });
  check('a navigation behaviour needs no realization to answer P2',
    subjects(profileFindings(model, {}), 'P2').includes('behavior_dismiss_banner'), false);
}
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_login').composed_of = ['cap_check_remember'];
  check('composed_of naming something no behaviours[] entry declares is P3',
    codes(profileFindings(model, {})).includes('P3:composed_of_is_not_a_behavior'), true);
}
{
  const { model } = projected();
  model.behaviors.push({ id: 'behavior_check_remember', name: 'check_remember', kind: 'interaction', evidence: THREE_ROLES });
  model.behaviors.find((entry) => entry.id === 'behavior_login').composed_of = ['behavior_check_remember'];
  ok('a member nothing walked and nothing realised is P3',
    codes(profileFindings(model, {})).includes('P3:composite_part_never_walked'));
}

// --- P4 ------------------------------------------------------------------------------------------

console.log('\n# P4 every element a step or effect names is a declared element');
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_submit_login').realization = [
    { action: 'click', element: 'element_does_not_exist' },
  ];
  ok('a realization naming an element no state declares is refused',
    withRule(profileFindings(model, {}), 'P4').some((finding) => finding.code === 'realization_element'));
}
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_submit_login').realization = [
    { action: 'click', element: 'login_button' },
  ];
  ok('an element reference that is not an element id is refused as a type error, not a dangling one',
    withRule(profileFindings(model, {}), 'P4').some((finding) => finding.code === 'realization_element_is_not_an_id'),
    JSON.stringify(withRule(profileFindings(model, {}), 'P4')));
}
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_submit_login').realization = [
    { action: 'click', element: 'element_add_project_button' },
  ];
  ok('an element declared somewhere else is refused: a step acts on a surface that has it',
    withRule(profileFindings(model, {}), 'P4').some((finding) => finding.code === 'realization_element_not_on_the_surface'));
}
{
  const { model } = projected();
  model.transitions[0].effects[0].target = 'element_gone';
  ok('an element-shaped effect target that resolves to nothing is refused',
    withRule(profileFindings(model, {}), 'P4').some((finding) => finding.code === 'effect_target'));
}

// --- P5 ------------------------------------------------------------------------------------------

console.log('\n# P5 parameters bind, concrete values were observed');
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_fill_login_email').realization = [
    { action: 'fill', element: 'element_email_input', value: '{{email}}' },
  ];
  check('a parameter bound to a declared input is fine', withRule(profileFindings(model, {}), 'P5').length, 0);
  model.behaviors.find((entry) => entry.id === 'behavior_fill_login_email').realization[0].value = '{{account}}';
  ok('a parameter bound to nothing declared is refused',
    withRule(profileFindings(model, {}), 'P5').some((finding) => finding.code === 'unbound_parameter'));
}
{
  const { model } = projected();
  check('the observed email is accepted', withRule(profileFindings(model, {}), 'P5').length, 0);
  check('[set] is the honest record of a redacted field, not an unobserved value',
    model.transitions[1].arguments.password, '[set]');
  model.transitions[0].arguments.email = 'somebody-else@example.com';
  ok('a value the model typed and the run never read back is refused',
    withRule(profileFindings(model, {}), 'P5').some((finding) => finding.code === 'unobserved_argument'));
}
// The rescue P5 depends on, and it had no test until the protocol started telling the walk to rely
// on it. A live 0.1.28 walk wrote a template and declared no input; the section had never said that
// writing one obliges you to declare it, and the machinery's own answer — a behaviour's input is
// the inputs of the capabilities it is composed of — is only worth telling the walk about if it
// works. A walk sent to declare a parameter somewhere the projection does not read is being told to
// do something it cannot do, which is the defect this whole exchange is about.
{
  const source = candidates();
  source.capabilities.find((entry) => entry.id === 'cap_login').steps = [
    { action: 'fill', element: 'element_email_input', value: '{{email}}', purpose: 'enter_credentials' },
    { action: 'fill', element: 'element_password_input', value: '{{password}}', purpose: 'enter_credentials' },
  ];
  const { model, findings } = projected(source);
  const login = model.behaviors.find((entry) => entry.id === 'behavior_login');
  check('a behaviour that declares no input of its own takes the inputs of the capabilities it is composed of',
    Object.keys(login.input ?? {}).sort(), ['email', 'password']);
  check('and a step binding them is accepted, not refused as unbound',
    withRule(findings, 'P5').length, 0);
}

// --- P6, P7 ---------------------------------------------------------------------------------------

console.log('\n# P6 actors are declared and traceable, P7 a dimension has a detection');
{
  const { model } = projected();
  model.application.actors = [{ id: 'anonymous', description: 'not signed in' }];
  ok('a state variant no actor declares is reported',
    withRule(profileFindings(model, {}), 'P6').some((finding) => finding.code === 'undeclared_actor' && finding.scope === 'states'));

  model.application.actors.push({ id: 'admin' });
  model.journeys[0].actor = 'admin';
  ok('a declared actor no state variant and no observation shows is reported as untraceable',
    withRule(profileFindings(model, {}), 'P6').some((finding) => finding.code === 'untraceable_actor'));

  delete model.journeys[0].actor;
  ok('a journey with no actor at all is reported',
    withRule(profileFindings(model, {}), 'P6').some((finding) => finding.code === 'journey_actor_missing'));

  model.application.actors = [];
  ok('no actors at all is reported, because the document cannot be read without one',
    withRule(profileFindings(model, {}), 'P6').some((finding) => finding.code === 'no_actors_declared'));
}
{
  const { model } = projected();
  check('the derived detection is enough for P7', withRule(profileFindings(model, {}), 'P7').length, 0);

  delete model.state_variables[0].detection;
  ok('a dimension with no detection is refused',
    codes(profileFindings(model, {})).includes('P7:dimension_without_detection'));

  model.state_variables[0].detection = { type: 'value', operator: 'equals', expected: 'populated' };
  ok('a detection that reads neither an element nor a route is refused',
    codes(profileFindings(model, {})).includes('P7:detection_reads_no_surface'));

  model.state_variables[0].detection = { type: 'value', element: 'element_project_list', operator: 'equals', expected: 'populated' };
  model.state_variables[0].values = ['empty'];
  ok('a value a state identity uses and the declaration does not list is refused',
    codes(profileFindings(model, {})).includes('P7:dimension_value_undeclared'));

  model.state_variables[0].values = ['populated'];
  model.state_variables[0].name = 'project_count';
  ok('a dimension no state variable declares is refused',
    codes(profileFindings(model, {})).includes('P7:undeclared_dimension'));
}

// --- P8, P9 ---------------------------------------------------------------------------------------

console.log('\n# P8 semantic paths name entities, P9 nothing is claimed without evidence');
{
  const { model } = projected();
  check('a storage key is not a semantic path', withRule(profileFindings(model, {}), 'P8').length, 0);
  model.transitions[2].effects.push({ type: 'list_changed', target: 'project.list', operation: 'append', observed: true });
  ok('a semantic path no entity declares is reported',
    codes(profileFindings(model, {})).includes('P8:entity_not_declared'));
  model.entities = [{ name: 'project.list' }];
  check('and declaring the entity answers it', withRule(profileFindings(model, {}), 'P8').length, 0);
}
{
  const { model } = projected();
  check('every behaviour is anchored: the three steps by their edges, login by its members',
    withRule(profileFindings(model, {}), 'P9').length, 0);

  delete model.behaviors[0].evidence;
  // Both are reported, and that is the point of anchoring a composition by its parts: a claim
  // built out of a step nothing observed is itself a step nothing observed, so the composite is
  // refused with it rather than quietly inheriting an anchor it no longer has.
  check('a leaf behaviour with no evidence is refused, and the composite it stands under with it',
    subjects(profileFindings(model, {}), 'P9'), ['behavior_fill_login_email', 'behavior_login']);

  for (const behavior of model.behaviors) delete behavior.evidence;
  check('a composite with no evidence of its own is refused once its members have none either',
    subjects(profileFindings(model, {}), 'P9'),
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_login', 'behavior_submit_login']);

  const { model: roles } = projected();
  roles.transitions[0].evidence = [evidence('obs_0002', 'action')];
  check('an edge missing two of the three roles is refused twice',
    withRule(profileFindings(roles, {}), 'P9').filter((finding) => finding.code === 'transition_missing_evidence_role').length, 2);

  roles.transitions[0].evidence = [evidence('obs_9999', 'identity'), evidence('obs_9999', 'action'), evidence('obs_9999', 'effect')];
  ok('evidence naming an observation the document does not carry is refused',
    withRule(profileFindings(roles, {}), 'P9').some((finding) => finding.code === 'unresolved_evidence'));
}

// --- P10, P11 -------------------------------------------------------------------------------------

console.log('\n# P10 a critical journey is not backed by a guess, P11 a behaviour an edge can perform');
{
  const { model } = projected();
  check('a journey that is not critical says nothing about confidence', withRule(profileFindings(model, {}), 'P10').length, 0);
  model.transitions[0].metadata = { confidence: 0.3, status: 'inferred' };
  model.journeys[0].criticality = 'critical';
  ok('a low-confidence edge backing a critical journey is reported',
    withRule(profileFindings(model, {}), 'P10').some((finding) => finding.detail.includes('transition_fill_login_email')));
  model.journeys[0].criticality = 'standard';
  check('and the same edge backing a standard journey is not', withRule(profileFindings(model, {}), 'P10').length, 0);
}
{
  const { model } = projected();
  check('the composite is walkable through its members, so it is not reported', withRule(profileFindings(model, {}), 'P11').length, 0);
  model.behaviors.push({ id: 'behavior_check_remember', name: 'check_remember', kind: 'interaction', evidence: THREE_ROLES });
  check('a behaviour no edge can perform and no composition contains is a vocabulary entry',
    subjects(profileFindings(model, {}), 'P11'), ['behavior_check_remember']);
}

// --- P12 ------------------------------------------------------------------------------------------

console.log('\n# P12 walk preservation, both directions');
{
  const collapsed = projected();
  const step = (elementId) => ({ action: 'fill', element: elementId, purpose: 'enter_credentials' });
  collapsed.model.transitions = collapsed.model.transitions.filter((entry) => entry.id === 'transition_submit_login');
  collapsed.model.behaviors.find((entry) => entry.id === 'behavior_submit_login').realization = [
    step('element_email_input'), step('element_password_input'),
  ];
  collapsed.model.states[0].behaviors = ['behavior_submit_login'];
  collapsed.model.journeys[0].steps = [{ transition: 'transition_submit_login' }];
  check('the collapse D3 describes is accepted: three committed calls become one edge and two steps',
    withRule(profileFindings(collapsed.model, { candidates: collapsed.source }), 'P12').length, 0);
  ok('and the journey follows the collapse: it names the move, not the calls it was made of',
    collapsed.model.journeys[0].steps.length === 1);
}

// --- one move is one turn of the walk -----------------------------------------------------------
// The live 0.1.30 walk, which is where this came from: one behaviour whose realization recorded
// three calls (fill, fill, click), committed as three edges and collapsed into one move. The
// projection remapped every *call* onto the edge that absorbed it, so the journey named the move
// three times — three turns, every one of them `transition_submit_login` — and the document told a
// reader the behaviour was performed three times while the same edge's
// `metadata.extra.collapsed.invocations` said one. A turn of a journey is a move, and a move is an
// *invocation*: the calls it was made of are the behaviour's own `realization[]`, which the
// document already holds, so naming them again as turns is a second place to say one thing — the
// exact shape D5 exists to prevent.

console.log('\n# one move is one turn of the walk');
{
  const realized = candidates();
  realized.capabilities.find((entry) => entry.id === 'cap_login').steps = [
    { action: 'fill', element: 'element_email_input', value: 'test@example.com' },
    { action: 'fill', element: 'element_password_input', value: '[set]' },
    { action: 'click', element: 'element_login_button' },
  ];
  const model = modelFromCandidates(realized);
  check('one invocation of a three-call behaviour is one turn of the journey, not three',
    [model.journeys[0].steps.map((step) => step.transition),
      model.transitions.map((entry) => entry.id),
      model.transitions[0].metadata.extra.collapsed.invocations],
    [['transition_submit_login'], ['transition_submit_login'], 1]);
  check('and the calls it was made of are the behaviour\'s own steps, where a reader can check them',
    model.behaviors.find((entry) => entry.id === 'behavior_login').realization.map((step) => [step.action, step.element]),
    [['fill', 'element_email_input'], ['fill', 'element_password_input'], ['click', 'element_login_button']]);
}
{
  // The other direction, because a rule that only ever collapses is a rule that would merge two
  // real invocations into one: the walk performs the behaviour, leaves, and performs it again from
  // the same state. Two invocations, two turns — the edge is one edge and the walk names it twice.
  const twice = candidates();
  const call = (id, capability, target, from, to, extra = {}) => ({
    id, from_state: from, to_state: to,
    action: { capability, target },
    effects: [], evidence: THREE_ROLES,
    metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
    ...extra,
  });
  const login = 'state_login_anonymous';
  const projects = 'state_project_list_authenticated_projects_populated';
  const walk = [
    call('transition_fill_email', 'cap_fill_login_email', 'element_email_input', login, login),
    call('transition_fill_password', 'cap_fill_login_password', 'element_password_input', login, login),
    call('transition_submit_login', 'cap_submit_login', 'element_login_button', login, projects),
    call('transition_fill_email_again', 'cap_fill_login_email', 'element_email_input', login, login),
    call('transition_fill_password_again', 'cap_fill_login_password', 'element_password_input', login, login),
    call('transition_submit_login_again', 'cap_submit_login', 'element_login_button', login, projects),
  ];
  twice.capabilities.find((entry) => entry.id === 'cap_login').steps = walk.map((entry) => ({
    action: entry.action.capability === 'cap_submit_login' ? 'click' : 'fill',
    element: entry.action.target,
  }));
  twice.transitions = walk;
  twice.journeys[0].transitions = walk.map((entry) => entry.id);
  const model = modelFromCandidates(twice);
  check('two invocations of one move are two turns, both naming the edge that carries them',
    [model.transitions.map((entry) => entry.id),
      model.transitions[0].metadata.extra.collapsed.invocations,
      model.journeys[0].steps.map((step) => step.transition)],
    [['transition_submit_login_again'], 2, ['transition_submit_login_again', 'transition_submit_login_again']]);
}
// --- the model in the shape the generator reads ----------------------------------------------
// Phase 4's adapter, and its three decisions are three facts about the document it returns:
// a turn expands into the calls it was made of, the value stays on the realization rather than
// being copied into a synthesized `arguments`, and composition is not consulted because a model's
// behaviour already says how it was performed (D13). What makes it worth a section of its own is
// the fourth fact, the one the live walk found: the *journey* expands through the same map, so a
// spec written from a model performs one move once — which is the sentence the whole pivot is
// measured on, stated here as something a test can fail.

console.log('\n# the model in the shape the generator reads');
{
  const realized = () => {
    const source = candidates();
    source.capabilities.find((entry) => entry.id === 'cap_login').steps = [
      { action: 'fill', element: 'element_email_input', value: 'test@example.com' },
      { action: 'fill', element: 'element_password_input', value: '[set]' },
      { action: 'click', element: 'element_login_button' },
    ];
    // A model's own edge carries no assertions — an arrival is a claim about the journey, and the
    // projection puts it on `journey.assertions` — so a candidate's `assertions` never reaches the
    // model and there is nothing to break here. The rule is pinned on the model instead, below.
    return source;
  };
  const model = modelFromCandidates(realized());
  // One assertion, on the move, by hand: it belongs to the move, so it lands on the call that ended
  // the move and on no other, and no spec can be made to assert a half-performed behaviour.
  model.transitions.find((edge) => edge.id === 'transition_submit_login').assertions = [
    { type: 'url', operator: 'matches', expected: '/' },
  ];
  const graph = graphShapeOf(model);
  check('one move becomes the calls it was made of, named by the ids the log gave them',
    graph.transitions.map((edge) => [edge.id, edge.action.target]),
    [['transition_fill_login_email', 'element_email_input'],
      ['transition_fill_login_password', 'element_password_input'],
      ['transition_submit_login', 'element_login_button']]);
  // The move starts where the invocation started and lands where the behaviour lands: the calls in
  // between neither arrive anywhere nor leave, so nothing can be made to assert an arrival in the
  // middle of one move — the same rule the collapse obeys.
  check('and each call says where the move it belongs to started, and only the last where it arrived',
    graph.transitions.map((edge) => [edge.from_state, edge.to_state]),
    [['state_login_anonymous', 'state_login_anonymous'],
      ['state_login_anonymous', 'state_login_anonymous'],
      ['state_login_anonymous', 'state_project_list_authenticated_projects_populated']]);
  // The behaviour is named once, on the call that ended the move: a claim about a behaviour is one
  // claim, and the calls before it are what they are — calls.
  check('the behaviour is named on the call that ended it, and not on the ones it was made of',
    graph.transitions.map((edge) => edge.action.capability ?? null),
    [null, null, 'behavior_login']);
  // A model's own edge carries no assertions, because arriving somewhere is a claim about the
  // journey rather than about the call that reached it. The adapter is given one by hand here: the
  // rule is that an assertion belongs to the move, so it lands on the call that ended the move and
  // on no other, and a spec cannot be made to assert a half-performed behaviour.
  check('an assertion on the move lands on the call that ended it, and on no other',
    [graph.transitions.map((edge) => (edge.assertions ?? []).length),
      graph.transitions.map((edge) => edge.metadata !== undefined),
      graph.transitions[2].metadata.extra.collapsed.invocations],
    [[0, 0, 1], [false, false, true], 1]);
  // Every action a spec can perform is a realization step or there is no transition at all, which
  // is what makes "every action traces to a realization[] step" true by construction rather than by
  // review. The reference is on the step, and it names the behaviour, the index and the edge.
  check('every call is a reference into the behaviour\'s own realization, not a copy of it',
    graph.transitions.map((edge) => [edge.realization.behavior, edge.realization.index, edge.realization.of]),
    [['behavior_login', 0, 'transition_submit_login'],
      ['behavior_login', 1, 'transition_submit_login'],
      ['behavior_login', 2, 'transition_submit_login']]);
  check('and it keeps the value the step recorded, without the edge translating it',
    [graph.transitions[0].realization.value, graph.transitions[1].realization.value, graph.transitions[2].realization.value],
    ['test@example.com', '[set]', null]);
  check('the journey expands through the same map, so the walk names the calls it performs',
    graph.journeys[0].transitions, graph.transitions.map((edge) => edge.id));
}
{
  // The value is the lossy half of the pair and the adapter exists to be measured on the
  // difference, so it is deliberately not copied into `arguments`: a synthesized argument is an
  // argument the walk never wrote, and it would hide the very reading `argumentFor` is being asked
  // to prefer. The old reader finds no arguments, and that is the report.
  const source = candidates();
  source.capabilities.find((entry) => entry.id === 'cap_login').steps = [
    { action: 'fill', element: 'element_email_input', value: 'test@example.com' },
  ];
  const graph = graphShapeOf(modelFromCandidates(source));
  ok('no argument is invented for the generator to read, so the realization is the only place the value is',
    !('arguments' in graph.transitions[0]) && graph.transitions[0].realization.value === 'test@example.com',
    JSON.stringify(graph.transitions[0]));
}
{
  // A behaviour nobody recorded the steps of is a move with no account of how it was performed. It
  // is carried as itself and without a realization reference, so `generateTest` refuses it by name
  // rather than writing an action no reading stands behind.
  const graph = graphShapeOf(modelFromCandidates(candidates()));
  check('a move with no recorded realization is carried as itself',
    graph.transitions.map((edge) => [edge.id, edge.realization === undefined, edge.action.target]),
    [['transition_fill_login_email', true, 'element_email_input'],
      ['transition_fill_login_password', true, 'element_password_input'],
      ['transition_submit_login', true, 'element_login_button']]);
  // A model's behaviour is atomic by D13 — its members are its realization steps, so there is no
  // composition left to check a move against — and this is the adapter saying so rather than
  // handing the generator a composite whose members are the calls it would then look for twice.
  ok('and no behaviour is offered as a composite, because from a model there is nothing to check it against',
    graph.capabilities.every((entry) => entry.kind === 'atomic' && !('composed_of' in entry)),
    JSON.stringify(graph.capabilities));
  check('the document says which file it was read from', graph.source, 'application-model.json');
}
{
  // Two invocations of one behaviour are two moves, so they expand to two runs of calls: the fix
  // from the previous window arrived at the projection, and this is the same fact one layer up —
  // the adapter reads the journey, so a journey that named a move twice performs it twice.
  const twice = candidates();
  twice.capabilities.find((entry) => entry.id === 'cap_login').steps = [
    { action: 'fill', element: 'element_email_input', value: 'test@example.com' },
    { action: 'fill', element: 'element_password_input', value: '[set]' },
    { action: 'click', element: 'element_login_button' },
  ];
  const walk = ['transition_fill_email', 'transition_fill_password', 'transition_submit_login',
    'transition_fill_email_again', 'transition_fill_password_again', 'transition_submit_login_again'];
  twice.transitions = walk.map((id) => ({
    id,
    from_state: 'state_login_anonymous',
    to_state: id.includes('submit') ? 'state_project_list_authenticated_projects_populated' : 'state_login_anonymous',
    action: { capability: id.includes('submit') ? 'cap_submit_login' : (id.includes('password') ? 'cap_fill_login_password' : 'cap_fill_login_email'), target: 'element_email_input' },
    effects: [], evidence: THREE_ROLES,
    metadata: { confidence: 1, status: 'verified', producer: 'llm:deepseek-flash' },
  }));
  twice.journeys[0].transitions = walk;
  const graph = graphShapeOf(modelFromCandidates(twice));
  // Two invocations of one behaviour between two states are one edge (D5) that says so —
  // `collapsed.invocations` is 2 — and the journey names it twice, so the walk performs the same
  // three calls twice. That is also the known limit stated as an assertion: one `realization[]` per
  // behaviour cannot tell the two invocations' values apart, and the second run of calls is the
  // first run's, which is why a caller is told rather than shown.
  check('two invocations are two turns of the journey, and each turn is the three calls it was made of',
    [graph.transitions.length, graph.transitions[2].metadata.extra.collapsed.invocations, graph.journeys[0].transitions.length],
    [3, 2, 6]);
  ok('and both turns name the same calls, which is the difference the model cannot yet draw',
    graph.journeys[0].transitions.slice(0, 3).join() === graph.journeys[0].transitions.slice(3).join(),
    JSON.stringify(graph.journeys[0].transitions));
}

{
  const { model, source } = projected();
  model.transitions = model.transitions.filter((entry) => entry.id !== 'transition_fill_login_password');
  ok('a committed call the model does not carry is refused',
    withRule(profileFindings(model, { candidates: source }), 'P12')
      .some((finding) => finding.code === 'committed_transition_not_carried' && finding.subject === 'transition_fill_login_password'));
}
{
  const { model, source } = projected();
  model.transitions.push({
    id: 'transition_invented', from_state: 'state_login_anonymous', to_state: 'state_project_list_authenticated_projects_populated',
    behavior: 'behavior_login', evidence: THREE_ROLES,
  });
  ok('an edge no committed step backs is refused as an invented move',
    withRule(profileFindings(model, { candidates: source }), 'P12')
      .some((finding) => finding.code === 'transition_not_backed_by_a_committed_step' && finding.subject === 'transition_invented'));
}
{
  const { model, source } = projected();
  model.transitions.push({ ...model.transitions[2], id: 'transition_submit_login_again' });
  ok('two edges for one move are refused (D5)',
    codes(profileFindings(model, { candidates: source })).includes('P12:duplicate_transition'));
}
{
  const { model, source } = projected();
  model.journeys = [];
  ok('a model with no journey is refused: D4 requires the walk to survive as a journey',
    codes(profileFindings(model, { candidates: source })).includes('P12:no_journey'));

  const { model: named } = projected();
  named.journeys[0].steps[0].transition = 'transition_nope';
  ok('a step naming no declared transition is refused',
    codes(profileFindings(named, {})).includes('P12:journey_step_names_no_transition'));

  const { model: stepless } = projected();
  stepless.journeys[0].steps = [];
  ok('a journey with no steps is refused',
    codes(profileFindings(stepless, {})).includes('P12:journey_without_steps'));
}
{
  const { model } = projected();
  const findings = profileFindings(model, {});
  check('without the committed log, coverage is not claimed and not silently skipped',
    findings.filter((finding) => finding.rule === 'P12').map((finding) => finding.code), ['coverage_unchecked']);
  check('and the info severity is the table\'s, not the caller\'s', withRule(findings, 'P12')[0].severity, 'info');
}

// --- P13 ------------------------------------------------------------------------------------------

console.log('\n# P13 an affordance is offered, not performed');
{
  const { model } = projected();
  check('the derived affordances are controls this walk did not use', withRule(profileFindings(model, {}), 'P13').length, 0);

  model.states[1].affordances.push({ element: 'element_not_here', expected_behavior: 'open_something' });
  ok('an affordance naming an element the surface does not declare is refused',
    codes(profileFindings(model, {})).includes('P13:affordance_element_not_on_surface'));

  const { model: walked } = projected();
  walked.states[0].affordances.push({ element: 'element_email_input', expected_behavior: 'enter_email' });
  ok('an affordance a realized step performs is reported: the walk refutes the claim',
    codes(profileFindings(walked, {})).includes('P13:affordance_already_walked'));
  check('and it is a warning, not an error', withRule(profileFindings(walked, {}), 'P13')
    .find((finding) => finding.code === 'affordance_already_walked').severity, 'warning');
}

// --- P14, P15 ------------------------------------------------------------------------------------

console.log('\n# P14/P15 a document is reported at the level its claims were obtained at (D9, D11)');
{
  check('the order of CLAIM_LEVELS *is* the rule: a lower index is a weaker claim',
    CLAIM_LEVELS, ['modelled', 'inferred', 'observed']);
  check('the producer is what makes a claim one level or another',
    ['playwright', 'manual', 'llm:deepseek-flash', 'importer:dsh-graph-explorer'].map((producer) => claimLevel({ producer })),
    ['observed', 'observed', 'inferred', 'inferred']);
  ok('and a producer nobody recognises is a derivation, never a collector',
    claimLevel({ producer: 'something-new' }) === 'modelled' && claimLevel({}) === 'modelled',
    claimLevel({ producer: 'something-new' }));
}
{
  const { model } = projected();
  model.journeys[0].metadata = { status: 'verified', confidence: 1, producer: 'importer:dsh-graph-explorer' };
  ok('a tool that read the document may not report what it read as verified',
    subjects(profileFindings(model, {}), 'P14').includes('journey_login_anonymous_to_project_list'));
}
{
  const { model } = projected();
  model.journeys[0].metadata = { status: 'inferred', producer: 'importer:dsh-graph-explorer', confidence: 1 };
  const finding = withRule(profileFindings(model, {}), 'P14')
    .find((entry) => entry.subject === 'journey_login_anonymous_to_project_list');
  ok('confidence 1 is the same claim as "verified", so it is refused the same way',
    finding?.detail.includes('confidence 1'), finding?.detail);
}
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_login').metadata =
    { status: 'verified', confidence: 1, producer: 'playwright' };
  const finding = withRule(profileFindings(model, {}), 'P14').find((entry) => entry.subject === 'behavior_login');
  check('a composite takes the minimum of its parts, even when its own producer watched every click',
    finding?.code, 'claim_outranks_its_inputs');
  ok('and the detail names the weaker parts, so the fix is a list and not a guess',
    finding?.detail.includes('derived from claims at inferred'), finding?.detail);
}
{
  const { model } = projected();
  model.behaviors.find((entry) => entry.id === 'behavior_submit_login').realization = [
    { action: 'click', element: 'element_login_button', metadata: { status: 'verified', confidence: 1 } },
  ];
  const finding = withRule(profileFindings(model, {}), 'P14')
    .find((entry) => entry.subject === 'behavior_submit_login' && entry.code === 'claim_has_no_producer');
  ok('a realization step stamped verified with no producer is a derivation nobody signed',
    finding !== undefined, JSON.stringify(withRule(profileFindings(model, {}), 'P14').map((entry) => [entry.subject, entry.code])));
}
{
  const { model } = projected();
  check('the fixture\'s honest claims raise no P15 at all', withRule(profileFindings(model, {}), 'P15'), []);

  const { model: unowned } = projected();
  unowned.journeys[0].metadata = { status: 'inferred', extra: { goal_stated: true } };
  check('an inference that names nobody is a claim nobody can be asked about',
    codes(withRule(profileFindings(unowned, {}), 'P15')), ['P15:inference_without_producer']);

  const { model: baseless } = projected();
  baseless.behaviors.push({
    id: 'behavior_dismiss_banner', name: 'dismiss_banner', kind: 'navigation',
    metadata: { status: 'inferred', confidence: 0.5, producer: 'llm:deepseek-flash' },
  });
  check('an inference from nothing is a hallucination, and is reported as one rather than carried',
    codes(withRule(profileFindings(baseless, {}), 'P15')), ['P15:inference_without_basis']);
}
{
  // D8's floor under the rule: what P14 refuses has to be reachable, or the rule can only be
  // satisfied by recording less. Writing the ceiling each claim earned is what an honest document
  // says — and it is the same object list, so the rule and its fix cannot drift apart.
  const { model } = projected();
  for (const claim of claimsOf(model)) {
    if (!claim.object.metadata) continue;
    const ceiling = LEVEL_CEILING[claim.level];
    claim.object.metadata = {
      ...claim.object.metadata,
      status: ceiling.status,
      confidence: Math.min(claim.object.metadata.confidence ?? 1, ceiling.confidence),
    };
  }
  const findings = profileFindings(model, {});
  check('writing each claim\'s ceiling satisfies P14', withRule(findings, 'P14'), []);
  check('and P15: a downgraded claim still names who read it', withRule(findings, 'P15'), []);
  check('and it is not silence: the claim is still there, at the level it was obtained at',
    [model.behaviors[0].metadata.status, model.behaviors[0].metadata.producer, model.behaviors[0].metadata.confidence],
    ['inferred', 'llm:deepseek-flash', 0.5]);
}

// --- reading a run --------------------------------------------------------------------------------

console.log('\n# reading a run: the committed document, or the commit run again');
{
  const mkRun = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'abm-run-'));
    writeFileSync(join(dir, 'run.json'), JSON.stringify(body));
    return dir;
  };
  const declared = {
    started_at: '2026-09-18T10:00:00Z',
    instruction: 'sign in',
    application: { id: 'app_acme', name: 'Acme' },
    start_url: 'http://127.0.0.1:4173/',
  };

  const empty = candidatesFromRun(mkRun(declared));
  check('with no graph.json the logs go through the commit\'s own reconciliation', empty.source, 'draft');
  check('and the application the commit assembled is the one that gets projected', empty.application.id, 'app_acme');
  ok('a run the commit refused carries that refusal as a note, quoting the gate',
    (empty.notes ?? []).some((note) => note.includes('nothing_to_commit')), JSON.stringify(empty.notes));

  const bare = candidatesFromRun(mkRun({ started_at: '2026-09-18T10:00:00Z', instruction: 'sign in' }));
  let refusal = null;
  try { modelFromCandidates(bare); } catch (error) { refusal = error; }
  ok('a run that declares no application is refused, not given a placeholder that would validate',
    refusal !== null && refusal.message.includes('application_not_declared'), refusal?.message);
  ok('and the refusal is the same one the commit made for the same run, quoted',
    (bare.notes ?? []).some((note) => note.includes('application_not_declared')), JSON.stringify(bare.notes));

  const committed = mkRun(declared);
  writeFileSync(join(committed, 'graph.json'), JSON.stringify({
    schema_version: '0.1', application: declared.application, states: [], capabilities: [], transitions: [], journeys: [], observations: [],
  }));
  check('a document already on disk is read as it was judged, not committed again',
    candidatesFromRun(committed).source, 'graph.json');

  // One edge is one step of a behaviour however many times it was walked — and this is the reader
  // that did not have the rule while the commit's own assembly did. A live 0.1.29 run re-recorded
  // one edge to correct a mistake it had made: the shipped model performed the click once, and
  // this reading performed it twice, naming a different `storage_changed` target each time. Two
  // readers of one log agreeing is not a detail, because this one is what a profile reports and
  // what anyone reading the run back sees.
  const rewound = mkRun(declared);
  writeFileSync(join(rewound, 'graph.json'), JSON.stringify({
    schema_version: '0.1', application: declared.application, states: [], journeys: [], observations: [],
    capabilities: [{ id: 'cap_login', name: 'login', capability_kind: 'composite' }],
    transitions: [],
  }));
  writeFileSync(join(rewound, 'capabilities.jsonl'), [
    { kind: 'realization_step', capability_id: 'cap_login', transition_id: 'transition_submit_login', walk_index: 2, action: 'click', element: 'element_sign_in_button', effects: [{ type: 'storage_changed', target: 'acme-demo-state', observed: true }] },
    { kind: 'realization_step', capability_id: 'cap_login', transition_id: 'transition_submit_login', walk_index: 3, action: 'click', element: 'element_sign_in_button', effects: [{ type: 'storage_changed', target: 'localStorage.acme-demo-state', observed: true }] },
  ].map((record) => JSON.stringify(record)).join('\n'));
  const read = modelFromCandidates(candidatesFromRun(rewound));
  const steps = read.behaviors.find((entry) => entry.id === 'behavior_login').realization;
  check('a step re-recorded because the first attempt was wrong is one step, not two', steps.length, 1);
  check('and the newest walk of it is the one that stands, not the first',
    steps[0].effects[0].target, 'localStorage.acme-demo-state');
}

// --- the severity table ---------------------------------------------------------------------------

console.log('\n# the severities are §3\'s');
{
  const broken = projected().model;
  broken.behaviors[0].name = 'fill_login_email';
  broken.behaviors[0].realization = [{ action: 'fill', element: 'element_gone', value: '{{nothing}}' }];
  broken.states[0].affordances.push({ element: 'element_gone', expected_behavior: 'x' });
  broken.journeys[0].steps[0].transition = 'transition_nope';
  broken.transitions.push({ ...broken.transitions[2], id: 'transition_again' });
  const findings = profileFindings(broken, { candidates: candidates() });
  const wrong = findings.filter((finding) => !(PROFILE_RULES[finding.rule] ?? []).includes(finding.severity));
  check('every finding reports a severity its rule allows', wrong, []);
  ok('the broken model produces findings from many rules at once',
    new Set(findings.map((finding) => finding.rule)).size >= 6,
    JSON.stringify([...new Set(findings.map((finding) => finding.rule))]));
  ok('every finding carries the rule, the code, the scope and a detail',
    findings.every((finding) => finding.rule && finding.code && finding.scope && finding.detail && finding.basis === 'abm_profile'));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall abm checks passed');
process.exit(fails ? 1 : 0);
