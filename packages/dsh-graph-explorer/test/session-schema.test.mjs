import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from '../lib/session.js';
import { vocabularyNotes, EFFECT_REQUIRED, CAPABILITY_NAME_PATTERN } from '../lib/schema.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label, '=', JSON.stringify(actual));
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

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
