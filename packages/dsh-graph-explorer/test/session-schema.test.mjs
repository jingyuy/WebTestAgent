import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from '../lib/session.js';
import { normalizeApplication, normalizeActors, vocabularyNotes, EFFECT_REQUIRED, CAPABILITY_NAME_PATTERN } from '../lib/schema.js';

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

const cwd = mkdtempSync(join(tmpdir(), 'gx-'));
const run = createRun({ cwd, provenance: { plugin: { name: 'x', version: '0.0.0' } } });

// --- states indexed by observation ---------------------------------------
run.addState({ observationId: 'obs_0001', page_type: 'home', dimensions: { auth: 'anonymous' }, detection: [{ type: 'url' }] });
run.addState({ observationId: 'obs_0002', page_type: 'login', detection: [{ type: 'url' }] });
run.addState({ observationId: 'obs_0003', page_type: 'home', dimensions: { auth: 'authenticated' }, detection: [{ type: 'url' }] });
check('obs->state index', [run.stateForObservation('obs_0001'), run.stateForObservation('obs_0002'), run.stateForObservation('obs_0003')],
  ['state_home_auth_anonymous', 'state_login', 'state_home_auth_authenticated']);
check('unread observation has no state', run.stateForObservation('obs_0099'), undefined);

// --- capability minting / dedupe ----------------------------------------
const a = run.addCapability({ name: 'login', kind: 'setup' });
const b = run.addCapability({ name: 'login', kind: 'interaction' });
check('capability minted once', [a.created, b.created, a.id, b.id], [true, false, 'cap_login', 'cap_login']);
check('first kind wins', b.record.capability_kind, 'setup');
const c = run.addCapability({ name: 'add_product_to_cart' });
check('second capability', [c.id, run.capabilityCount()], ['cap_add_product_to_cart', 2]);
check('capability names', run.capabilityNames(), ['login', 'add_product_to_cart']);

// --- transition minting, reuse, collision naming -------------------------
const t1 = run.recordTransition({ from_state: 'state_home_anonymous', to_state: 'state_login', capability_id: 'cap_login', capability_name: 'login', before_observation: 'obs_0001', after_observation: 'obs_0002', observed_change: { url: ['/a', '/b'] } });
check('first transition id', [t1.id, t1.minted, t1.chain_break], ['transition_login', true, null]);

const t2 = run.recordTransition({ from_state: 'state_login', to_state: 'state_home_authenticated', capability_id: 'cap_login', capability_name: 'login', before_observation: 'obs_0002', after_observation: 'obs_0003', observed_change: { url: ['/b', '/a'] } });
check('same capability, different destination -> distinct id', [t2.id, t2.minted], ['transition_login_home_authenticated', true]);
check('no chain break on a contiguous walk', t2.chain_break, null);

const t3 = run.recordTransition({ from_state: 'state_home_anonymous', to_state: 'state_login', capability_id: 'cap_login', capability_name: 'login', before_observation: 'obs_0001', after_observation: 'obs_0002', observed_change: {} });
check('walking an edge again reuses its id', [t3.id, t3.minted], ['transition_login', false]);
check('re-walk still counts as a step', [run.walkLength(), run.transitionCount()], [3, 2]);
check('lastTransition is the newest step', run.lastTransition().from_state, 'state_home_anonymous');

// The walk now ends at state_login, so starting from home_authenticated breaks it.
const t4 = run.recordTransition({ from_state: 'state_home_auth_authenticated', to_state: 'state_login', capability_id: 'cap_add_product_to_cart', capability_name: 'add_product_to_cart', before_observation: 'obs_0003', after_observation: 'obs_0002', observed_change: null });
check('chain break detected and named', t4.chain_break, { previous_transition: 'transition_login', previous_to_state: 'state_login', from_state: 'state_home_auth_authenticated' });
check('a contiguous step after the break is clean again', run.recordTransition({ from_state: 'state_login', to_state: 'state_home_auth_anonymous', capability_id: 'cap_login', capability_name: 'login', before_observation: 'obs_0002', after_observation: 'obs_0001', observed_change: {} }).chain_break, null);
check('second collision on the same base gets a destination-qualified id', t2.id, 'transition_login_home_authenticated');

// --- files ---------------------------------------------------------------
const lines = (p) => readFileSync(join(run.dir, p), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const caps = lines('capabilities.jsonl');
const trans = lines('transitions.jsonl');
check('capabilities file: one record per capability', caps.length, 2);
check('capability record shape', [caps[0].kind, caps[0].capability_kind, caps[0].name], ['capability', 'setup', 'login']);
check('transitions file: one record per step', trans.length, 5);
check('re-walk marked', trans.map((r) => r.repeated), [false, false, true, false, false]);
check('evidence roles say what each observation is evidence for', trans[0].evidence, [
  { observation: 'obs_0001', role: 'identity', note: 'the surface as it stood when the action was taken (from_state)' },
  { observation: 'obs_0002', role: 'action', note: 'the action itself, and the surface it produced (to_state)' },
  { observation: 'obs_0002', role: 'effect', note: 'what the machinery saw change between the two readings' },
]);
check('observed_change kept beside claimed effects', trans[3].observed_change, null);
check('chain_break is written to the log, not just returned', [trans[3].chain_break && trans[3].chain_break.previous_transition, trans[4].chain_break], ['transition_login', null]);
check('claimed effects default to empty', trans[0].effects, []);

// --- a composition that arrives after the name ---------------------------
// The store is append-only, so a later claim about a capability is a second record naming the
// capability it is about rather than a revision of the first. The index holds the merged view,
// which is what a commit reads: the step list has to be complete even though no single line is.
const late = run.addCapability({ name: 'login', kind: 'composite', composed_of: ['cap_add_product_to_cart'] });
const composition = lines('capabilities.jsonl')[2];
check('a later composition does not create a capability', [late.created, late.id, run.capabilityCount()], [false, 'cap_login', 2]);
check('the appended row is a record about the capability, not a second capability',
  [composition.kind, composition.capability_id, composition.name, composition.composed_of, composition.added, composition.capability_kind],
  ['capability_composition', 'cap_login', 'login', ['cap_add_product_to_cart'], ['cap_add_product_to_cart'], 'composite']);
check('and the merged view is what the index hands back',
  [late.record.composed_of, late.record.capability_kind, late.composition_added],
  [['cap_add_product_to_cart'], 'composite', ['cap_add_product_to_cart']]);
check('saying the same thing twice appends nothing',
  [run.addCapability({ name: 'login', kind: 'composite', composed_of: ['cap_add_product_to_cart'] }).composition_added,
    lines('capabilities.jsonl').length],
  [[], 3]);
check('a name is resolved to a reference, or to nothing at all',
  [run.capabilityIdFor('login'), run.capabilityIdFor('nobody'), run.capabilityIdFor(undefined)], ['cap_login', null, null]);
check('an empty id is dropped before it can become a dangling reference',
  run.addCapability({ name: 'submit_order', composed_of: ['', null, 'cap_login'] }).record.composed_of, ['cap_login']);
check('a capability nobody has named keeps its name in the log, but is not in the vocabulary twice',
  [run.capabilityNames().includes('submit_order'), run.capabilityCount()], [true, 3]);

// --- vocabulary ----------------------------------------------------------
check('exact vocabulary name raises nothing', vocabularyNotes('add_product_to_cart', []).length, 0);
check('curated synonym', vocabularyNotes('place_order', []).map((n) => [n.signal, n.vocabulary_name]), [['known_synonym', 'submit_order']]);
check('narrower name flags the vocabulary entry', vocabularyNotes('add_to_cart', []).map((n) => n.vocabulary_name), ['add_product_to_cart']);
check('same words reordered', vocabularyNotes('cart_add', ['add_cart']).map((n) => n.signal), ['same_words', 'overlapping_words']);
check('strongest signal wins for one vocabulary name', vocabularyNotes('add_to_cart', []).map((n) => [n.signal, n.vocabulary_name]), [['known_synonym', 'add_product_to_cart']]);
check('note cap holds', vocabularyNotes('add_cart_product_remove', []).length <= 5, true);
check('run-local duplicate is flagged too', vocabularyNotes('open_project', ['open_project_list']).map((n) => n.signal), ['overlapping_words']);
check('a genuinely new name is quiet', vocabularyNotes('delete_project', ['login', 'submit_order']).length, 0);

// --- effect requirements -------------------------------------------------
check('value_changed needs target and to', EFFECT_REQUIRED.get('value_changed'), ['target', 'to']);
check('custom needs nothing', EFFECT_REQUIRED.get('custom'), []);
check('name pattern', [CAPABILITY_NAME_PATTERN.test('add_product_to_cart'), CAPABILITY_NAME_PATTERN.test('Add_Product'), CAPABILITY_NAME_PATTERN.test('add-product'), CAPABILITY_NAME_PATTERN.test('')],
  [true, false, false, false]);
check('run.json untouched by transitions', JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).plugin.version, '0.0.0');

// --- the declared application --------------------------------------------
// The one graph field the machinery cannot observe, so it is declared in config
// and only checked here. Every refusal below is a value that would otherwise have
// been written into a graph as though someone had declared it.
check('an undeclared application is null, not a guess',
  [normalizeApplication(undefined), normalizeApplication(null)], [null, null]);
check('a declared application is carried verbatim',
  normalizeApplication({ id: 'app_acme-demo', name: 'Acme Demo App' }),
  { id: 'app_acme-demo', name: 'Acme Demo App' });
refuses('an unprefixed id is refused', () => normalizeApplication({ id: 'acme', name: 'Acme' }), 'must be prefixed');
refuses('a missing id is refused', () => normalizeApplication({ name: 'Acme' }), 'is not a usable application id');
refuses('a whitespace-only name is refused', () => normalizeApplication({ id: 'app_x', name: '   ' }), 'must be a non-empty string');
refuses('an unrecognized key is refused, not dropped',
  () => normalizeApplication({ id: 'app_x', name: 'Acme', baseUrl: 'http://x/' }), 'no key');
refuses('a non-mapping is refused', () => normalizeApplication('app_x'), 'must be a mapping');

// --- the declared actor vocabulary ---------------------------------------
// `application.schema.json` declares `actors` in both document versions and nothing ever populated
// it: the id was inferred from the variant a state happened to carry, which is the graph deriving
// an identity rather than reporting one. A variant says what a *reading* was taken as; a declared
// actor says which roles the application can be exercised as, whether or not this run used them —
// and it is the only place a `credentials_ref` can come from, because no page states which
// credential a role signs in with.
//
// The entries below are refused one at a time so that each message names its own mistake. Every one
// of them is a value that would otherwise have been written into run.json and read back out of the
// committed graph as though someone had declared it.
check('no actors declared is an empty list, not a placeholder role',
  [normalizeApplication({ id: 'app_x', name: 'X' }).actors ?? [], normalizeActors(undefined)], [[], []]);
check('and the key is omitted rather than written empty, because the schema requires at least one',
  Object.keys(normalizeApplication({ id: 'app_x', name: 'X' })), ['id', 'name']);
check('a declared vocabulary is carried with its references',
  normalizeActors([
    { id: 'anonymous' },
    { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
  ]),
  [
    { id: 'anonymous' },
    { id: 'authenticated', description: 'Signed in as the seeded test user.', credentials_ref: 'TEST_USER' },
  ]);
check('a declared vocabulary reaches application',
  normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: 'admin' }] }).actors, [{ id: 'admin' }]);
refuses('a non-array actors is refused',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: { id: 'admin' } }), 'must be an array');
refuses('an entry with no id is refused',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ description: 'someone' }] }), 'id must be a non-empty string');
refuses('a blank id is refused',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: '  ' }] }), 'id must be a non-empty string');
// Two entries, one id: every `state.identity.variant` and `journey.actor` that names it would then
// point at two roles, and nothing downstream could say which one a walk was. Refused rather than
// deduplicated, because dropping the second would lose a `credentials_ref` silently.
refuses('the same id twice is refused, not deduplicated',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: 'admin' }, { id: 'admin', credentials_ref: 'ADMIN_USER' }] }),
  'twice');
refuses('a misspelled credential key is refused, not read as absent',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: 'admin', credential_ref: 'ADMIN_USER' }] }), 'no key');
refuses('a credential carried as a value is refused: the field names one',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: 'admin', credentials_ref: { user: 'a', password: 'b' } }] }),
  'must be a string naming a credential entry');
refuses('a non-string description is refused',
  () => normalizeApplication({ id: 'app_x', name: 'X', actors: [{ id: 'admin', description: 7 }] }), 'description must be a string');

const declaredDir = mkdtempSync(join(tmpdir(), 'gx-app-'));
const declared = createRun({
  cwd: declaredDir,
  provenance: {
    application: normalizeApplication({
      id: 'app_acme',
      name: 'Acme',
      actors: [{ id: 'anonymous' }, { id: 'authenticated', credentials_ref: 'TEST_USER' }],
    }),
  },
});
check('the declared application reaches run.json',
  JSON.parse(readFileSync(join(declared.dir, 'run.json'), 'utf8')).application,
  { id: 'app_acme', name: 'Acme', actors: [{ id: 'anonymous' }, { id: 'authenticated', credentials_ref: 'TEST_USER' }] });
check('an undeclared application is written as null, so the commit can refuse',
  JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).application, null);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
