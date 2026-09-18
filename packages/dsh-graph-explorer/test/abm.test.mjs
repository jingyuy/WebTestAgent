/**
 * The profile rules, one at a time, against a run that reproduces the 0.1.22 walk in miniature.
 *
 * The fixture below is the sign-in walk shrunk to what the rules need: two states, four committed
 * capabilities (three steps and the composite that names them), three edges, one journey. Its
 * point is that the projection of it fails exactly the way the real 0.1.22 graph does — three P1
 * errors and three P2 warnings, and nothing else — so every other case in this file can be read as
 * "break exactly this one thing, and exactly this one rule notices".
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
  MECHANISM_VERBS,
  PROFILE_RULES,
  candidatesFromRun,
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
  metadata: { confidence: 1, status: 'verified' },
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
      metadata: { confidence: 1, status: 'verified' },
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
      metadata: { confidence: 1, status: 'verified' },
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
      metadata: { confidence: 1, status: 'verified' },
    },
    {
      id: 'cap_fill_login_password',
      name: 'fill_login_password',
      kind: 'interaction',
      input: { password: { type: 'string', required: true } },
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified' },
    },
    {
      id: 'cap_submit_login',
      name: 'submit_login',
      kind: 'interaction',
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified' },
    },
    {
      id: 'cap_login',
      name: 'login',
      kind: 'interaction',
      description: 'Sign in and reach the project list.',
      composed_of: ['cap_fill_login_email', 'cap_fill_login_password', 'cap_submit_login'],
      metadata: { confidence: 0.5, status: 'inferred' },
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
      metadata: { confidence: 1, status: 'verified' },
    },
    {
      id: 'transition_fill_login_password',
      from_state: 'state_login_anonymous',
      to_state: 'state_login_anonymous',
      action: { capability: 'cap_fill_login_password', arguments: { password: '[set]' }, target: 'element_password_input' },
      effects: [{ type: 'value_changed', target: 'element_password_input', to: '[set]', observed: true }],
      evidence: THREE_ROLES,
      metadata: { confidence: 1, status: 'verified' },
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
      metadata: { confidence: 1, status: 'verified' },
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
      metadata: { status: 'verified', producer: 'importer:dsh-graph-explorer', extra: { goal_stated: true } },
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
      metadata: { confidence: 1, status: 'verified', extra: { derived: 'state.identity.dimensions' } },
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
    codes(findings),
    ['P1:behavior_name_is_a_mechanism', 'P1:behavior_name_is_a_mechanism', 'P1:behavior_name_is_a_mechanism',
      'P2:behavior_without_realization', 'P2:behavior_without_realization', 'P2:behavior_without_realization']);
  check('P1 refuses the three capabilities the real run committed',
    subjects(findings, 'P1'),
    ['behavior_fill_login_email', 'behavior_fill_login_password', 'behavior_submit_login']);
  check('and passes the composite that names the goal', subjects(findings, 'P1').includes('behavior_login'), false);
  check('the summary counts them the way a gate would read them', summarizeFindings(findings),
    { total: 6, errors: 3, warnings: 3, infos: 0, bySeverity: { info: 0, warning: 3, error: 3 }, byRule: { P1: 3, P2: 3 }, failed: true });
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
      { id: 'cap_login', name: 'login', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified' } },
      { id: 'cap_sign_in', name: 'sign_in', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified' } },
      { id: 'cap_view_projects', name: 'view_projects', kind: 'query', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified' } },
      { id: 'cap_add_project', name: 'add_project', kind: 'interaction', evidence: THREE_ROLES, metadata: { confidence: 1, status: 'verified' } },
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
