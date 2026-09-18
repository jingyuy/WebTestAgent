#!/usr/bin/env node
// Proves that the ABM schema fork (schemas/abm/0.2) refuses what it claims to.
//
// A schema that validates a well-formed document is weak evidence: it might
// accept everything. This script therefore does two things, the way
// prove-generate.py does for the generation rules.
//
//   1. POSITIVE — the hand-written target shape (test/fixtures/abm/example.json)
//      validates against schemas/abm/0.2, and, when GRAPH_JSON points at a
//      recorded run, that document still validates against the vendored
//      schemas/0.1. The second half is what keeps the vendored copy honest: it
//      is never edited, so if the 0.1 check ever fails the blame is not the
//      schemas.
//
//   2. NEGATIVE — every mutation in REFUSALS below is applied to the fixture and
//      must be rejected. Each one is the structural half of a decision recorded
//      in docs/abm-pivot.md: D5, D6, D7 and P6/P7/P12. A mutation that comes
//      back VALID is reported as SURVIVED, because a rule nothing enforces is
//      not a rule the schema has.
//
// ajv is an opt-in dependency. `npm test` must keep working in a clone with
// nothing installed, so when ajv cannot be resolved this script prints SKIP and
// exits 0. To actually run it:
//
//   npm i -D ajv ajv-formats && npm run prove:schema
//   # or reuse an installed copy:
//   NODE_PATH=/path/to/node_modules npm run prove:schema
//
// The fixture is only ever deep-cloned in memory; no file is written.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIRS = {
  '0.1': join(ROOT, 'schemas', '0.1'),
  'abm/0.2': join(ROOT, 'schemas', 'abm', '0.2'),
};
const ROOTS = {
  '0.1': 'https://integration-test-generator.local/schemas/0.1/graph.schema.json',
  'abm/0.2': 'https://webtestagent.local/schemas/abm/0.2/application-model.schema.json',
};

const require = createRequire(import.meta.url);
let Ajv2020;
let addFormats;
try {
  const mod = require('ajv/dist/2020.js');
  Ajv2020 = mod.default ?? mod;
  const formats = require('ajv-formats');
  addFormats = formats.default ?? formats;
} catch {
  console.log('SKIP  ajv is not resolvable from here, so the schema proof did not run.');
  console.log('      npm i -D ajv ajv-formats && npm run prove:schema');
  console.log('      (or set NODE_PATH to a node_modules that has them)');
  process.exit(0);
}

function compiler(schemaDir, rootId) {
  const schemas = readdirSync(schemaDir)
    .filter((name) => name.endsWith('.schema.json'))
    .map((name) => JSON.parse(readFileSync(join(schemaDir, name), 'utf8')));
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false, schemas });
  addFormats(ajv, { mode: 'full' });
  const validate = ajv.getSchema(rootId);
  if (!validate) throw new Error(`${rootId} did not register from ${schemaDir}`);
  return { validate, count: schemas.length };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

const FIXTURE = join(ROOT, 'test', 'fixtures', 'abm', 'example.json');
const model = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// Every mutation is the structural half of a decision in docs/abm-pivot.md.
// Anything the schema cannot express belongs in NOT_STRUCTURAL, not here.
const REFUSALS = [
  {
    decision: 'D2',
    rule: 'schema_version separates a walk record from a behaviour model',
    why: 'a document that says 0.1 is graph.json, and must never be read as a model',
    mutate: (m) => { m.schema_version = '0.1'; },
  },
  {
    decision: 'D5',
    rule: 'an edge is one concrete pairing',
    why: 'from_state "*" is not a pairing, so it cannot be an entry in a set of pairings',
    mutate: (m) => { m.transitions[0].from_state = '*'; },
  },
  {
    decision: 'D5',
    rule: 'an edge is one concrete pairing',
    why: 'a from_state array re-imports the cross-product the edge set exists to avoid',
    mutate: (m) => { m.transitions[0].from_state = ['state_login_anonymous']; },
  },
  {
    decision: 'D5',
    rule: 'effects belong to the edge, not the behaviour',
    why: 'a behaviour-level effects[] gives one fact two homes and two chances to disagree',
    mutate: (m) => {
      m.behaviors[0].effects = [{
        type: 'state_entered',
        to: 'state_project_list_authenticated_projects_populated',
      }];
    },
  },
  {
    decision: 'D5',
    rule: 'a behaviour carries no preconditions[]',
    why: 'a precondition on a behaviour is a statement about one edge of it, and a behaviour has many',
    mutate: (m) => { m.behaviors[0].preconditions = ['user_is_anonymous']; },
  },
  {
    decision: 'D5',
    rule: 'the walk is steps over edges',
    why: "journey.transitions[] is the graph's key; the model's key is steps[]",
    mutate: (m) => {
      m.journeys[0].transitions = ['transition_login'];
      delete m.journeys[0].steps;
    },
  },
  {
    decision: 'P4',
    rule: 'a step acts on an element id, not a description',
    why: 'a step whose element is not an element id cannot be derived from the state declaration',
    mutate: (m) => { m.behaviors[0].realization[0].element = 'the email box'; },
  },
  {
    decision: 'P2',
    rule: 'realization[] steps are named actions',
    why: 'an action outside the vocabulary is one no runner can execute',
    mutate: (m) => { m.behaviors[0].realization[2].action = 'submit'; },
  },
  {
    decision: 'D7',
    rule: 'no features[] in the ABM',
    why: 'the product map is a different document doing a different job',
    mutate: (m) => { m.features = [{ id: 'feature_authentication' }]; },
  },
  {
    decision: 'D7',
    rule: 'no capabilities[] in the ABM',
    why: 'the vocabulary this pivot removed must not be re-enterable under its old name',
    mutate: (m) => { m.capabilities = [{ id: 'cap_login', name: 'login' }]; },
  },
  {
    decision: 'P1',
    rule: 'behaviour ids are behaviour ids',
    why: 'a cap_-prefixed id is the old vocabulary, and the behaviorId pattern is what refuses it',
    mutate: (m) => { m.behaviors[0].id = 'cap_login'; },
  },
  {
    decision: 'P1',
    rule: 'an edge references a behaviour, not a capability id',
    why: 'the edge must not be able to point outside the behaviour vocabulary',
    mutate: (m) => { m.transitions[0].behavior = 'cap_login'; },
  },
  {
    decision: 'P7',
    rule: 'a detection reads an element or a route',
    why: 'type value with no element is a dimension-shaped claim nothing can evaluate',
    mutate: (m) => { delete m.state_variables[0].detection.element; },
  },
  {
    decision: 'P7',
    rule: 'a detection reads an element or a route',
    why: "the old `target` field names a storage key, which is exactly the case P7 exists to refuse",
    mutate: (m) => {
      const detection = m.state_variables[0].detection;
      detection.target = detection.element;
      delete detection.element;
    },
  },
  {
    decision: 'P7',
    rule: 'a detection reads an element or a route',
    why: 'type route with no route is the mirror image of the same gap',
    mutate: (m) => { m.state_variables[0].detection = { type: 'route', operator: 'matches', expected: '/' }; },
  },
  {
    decision: 'D6',
    rule: 'the affordance array is the claim, so there is no status to set',
    why: 'metadata.status has no `unwalked` member on purpose: it is bookkeeping, never application semantics',
    mutate: (m) => { m.states[0].affordances[0].metadata.status = 'unwalked'; },
  },
  {
    decision: 'D6',
    rule: 'an affordance names what it offers',
    why: 'an affordance with no expected_behavior records that a control exists, which the element already said',
    mutate: (m) => { delete m.states[0].affordances[0].expected_behavior; },
  },
  {
    decision: 'D6',
    rule: 'an affordance hangs on an element, not on a route',
    why: 'an affordance is offered by a surface, and a surface is identified by what is on it',
    mutate: (m) => { m.states[0].affordances[0].element = '/forgot-password'; },
  },
  {
    decision: 'P6',
    rule: 'the actor vocabulary is required',
    why: 'a model that cannot name who it describes has not finished describing it',
    mutate: (m) => { delete m.application.actors; },
  },
  {
    decision: 'P6',
    rule: 'the actor vocabulary is required',
    why: 'an empty actors[] is the same gap wearing a placeholder',
    mutate: (m) => { m.application.actors = []; },
  },
  {
    decision: 'P8',
    rule: 'an entity name is a semantic noun',
    why: 'a storage key is where an entity lives, not what it is, and the pattern keeps the two apart',
    mutate: (m) => { m.entities[0].name = 'localStorage.acme-demo-state'; },
  },
  {
    decision: 'D4',
    rule: 'a journey says whether its goal was stated',
    why: 'a derived walk and an asked-for walk are different claims, and a reader must be able to tell',
    mutate: (m) => { delete m.journeys[0].goal_stated; },
  },
  {
    decision: 'P13',
    rule: 'a state cannot carry an affordance for an element it does not have',
    why: 'the schema refuses the storage-shaped spelling of this; the same-state half is P13 in Phase 0b',
    mutate: (m) => { m.states[0].affordances[0].element = 42; },
  },
];

// The rules that are neither shape nor reference, so no schema and no reference
// walk over the document can decide them: they are claims about what the model
// MEANS, and they are owed to the profile in phase 0b.
const NOT_STRUCTURAL = [
  ['P1', 'a behaviour name is a verb phrase rather than a mechanism', 'fill_login_email matches the id pattern perfectly; only judgement refuses it'],
  ['P5', 'a {{param}} binds to a declared input, and a concrete value was observed', 'a template string and a sibling object are not related by any standard keyword'],
  ['P9', 'an edge carries the identity/action/effect roles', 'the roles exist in the vocabulary; requiring all three per edge is a rule over the array'],
  ['P10', 'low confidence cannot back a critical journey', 'a comparison between two sibling values, neither of them wrong on its own'],
  ['P11', 'every behaviour reaches an edge or is composed_of one that does', 'reachability over the edge set'],
];

// The blind spot, measured rather than asserted. A dangling reference is not a
// schema failure: the pattern on an id checks the spelling, never the presence.
// These mutations must therefore be ACCEPTED, and if one is ever refused the
// note above is stale and the mutation belongs in REFUSALS instead.
const SHAPE_ONLY = [
  {
    decision: 'P12c',
    rule: 'a dangling transition id in a journey step',
    mutate: (m) => { m.journeys[0].steps[0].transition = 'transition_nonexistent'; },
  },
  {
    decision: 'P4',
    rule: 'a dangling element id in a realization step',
    mutate: (m) => { m.behaviors[0].realization[0].element = 'element_email_typo'; },
  },
  {
    decision: 'P13',
    rule: "an affordance pointing at another state's element",
    mutate: (m) => { m.states[0].affordances[0].element = 'element_nav_settings'; },
  },
  {
    decision: 'P6',
    rule: 'an actor id no actors[] entry declares',
    mutate: (m) => { m.journeys[0].actor = 'administrator'; },
  },
  {
    decision: 'D5',
    rule: 'two edges for the same (from_state, behavior, to_state)',
    mutate: (m) => { m.transitions.push(clone(m.transitions[0])); },
  },
];

let failures = 0;

console.log('schema proof — schemas/abm/0.2');
console.log('');

// 1. POSITIVE
const abm = compiler(SCHEMA_DIRS['abm/0.2'], ROOTS['abm/0.2']);
const fixtureOk = abm.validate(model);
console.log(`${fixtureOk ? 'VALID  ' : 'INVALID'} test/fixtures/abm/example.json  (${abm.count} schemas loaded)`);
if (!fixtureOk) {
  failures++;
  for (const error of abm.validate.errors ?? []) {
    console.log(`        ${error.instancePath || '/'} ${error.keyword} ${error.message}`);
  }
}

const graphJson = process.env.GRAPH_JSON;
if (graphJson) {
  const old = compiler(SCHEMA_DIRS['0.1'], ROOTS['0.1']);
  const recorded = JSON.parse(readFileSync(graphJson, 'utf8'));
  const ok = old.validate(recorded);
  console.log(`${ok ? 'VALID  ' : 'INVALID'} ${graphJson} against the vendored 0.1  (${old.count} schemas loaded)`);
  if (!ok) {
    failures++;
    for (const error of old.validate.errors ?? []) {
      console.log(`        ${error.instancePath || '/'} ${error.keyword} ${error.message}`);
    }
  }
} else {
  console.log('SKIP   the 0.1 cross-check (set GRAPH_JSON to a recorded run\'s graph.json)');
}

// 2. NEGATIVE
console.log('');
let refused = 0;
for (const { decision, rule, why, mutate } of REFUSALS) {
  const candidate = clone(model);
  mutate(candidate);
  const accepted = abm.validate(candidate);
  if (accepted) {
    failures++;
    console.log(`SURVIVED  ${decision}  ${rule}`);
    console.log(`          ${why}`);
    console.log('          the fixture was mutated as described and the schema still accepted it');
  } else {
    refused++;
    console.log(`REFUSED   ${decision}  ${rule}`);
  }
}

console.log('');
console.log(`${REFUSALS.length} mutation(s) the schema must refuse: ${refused} refused, ${REFUSALS.length - refused} survived.`);

// 3. THE BLIND SPOT, measured.
console.log('');
let stale = 0;
for (const { decision, rule, mutate } of SHAPE_ONLY) {
  const candidate = clone(model);
  mutate(candidate);
  if (abm.validate(candidate)) {
    console.log(`SHAPE-ONLY  ${decision}  ${rule}`);
  } else {
    stale++;
    console.log(`STALE       ${decision}  ${rule}`);
    console.log('            the schema now refuses this — move it into REFUSALS');
  }
}

console.log('');
console.log('Not expressible as document shape or as a reference walk, so owed to');
console.log("phase 0b's profileFindings():");
for (const [decision, rule, why] of NOT_STRUCTURAL) {
  console.log(`  ${decision.padEnd(5)} ${rule}`);
  console.log(`        ${why}`);
}

console.log('');
console.log(failures ? `${failures} schema check(s) failed` : 'all schema checks passed');
if (stale) console.log(`${stale} note(s) above are stale and should be moved`);
process.exit(failures ? 1 : 0);
