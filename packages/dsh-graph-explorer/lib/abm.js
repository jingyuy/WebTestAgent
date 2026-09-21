/**
 * The application behaviour model, derived from a recorded run, and the profile that judges it.
 *
 * Phase 0b of the pivot in `docs/abm-pivot.md`. The ABM is what the project is moving *to*: a
 * document whose unit is the user's goal (`login`) rather than the model's mechanism
 * (`fill_login_email`), which still carries the committed walk as `realization[]` steps. Phase 1
 * records behaviourally; phase 2 commits both documents. Neither can be built before there is
 * something that can *say what is wrong* with a document, which is this module. It is a
 * diagnostic over recorded runs and never the production path:
 *
 * - `modelFromCandidates()` turns a run — live candidates or a committed `graph.json` — into the
 *   ABM shape of §3.
 * - `profileFindings()` implements **P1–P17**, the judgement rules of §3, as the flat findings
 *   the commit already emits (`{code, severity, detail, basis, …}`, plus `rule` and `scope`).
 *   P16 is the exception that judges shape rather than meaning: every reference in a document
 *   must resolve *within that document*, because a reference copied from a parent's edge set
 *   resolves fine where it came from and names nothing here. P17 is the contract's half of D9:
 *   an outcome may not be stated at a level stronger than the readings that support it.
 * - `claimsOf()` is the list of claims a document makes, each with the epistemic level P14/P15
 *   judge it at (D9); `claimLevel()` is the level of one `metadata` block (D11).
 * - `summarizeFindings()` is the counting half, for a CLI.
 *
 * ## The projection is deliberately mechanical, and that is the point
 *
 * `modelFromCandidates()` maps **one capability to one behaviour**, copies the committed edges,
 * and derives only what the recorded document already states — actors from state variants,
 * `state_variables` from `identity.dimensions`, affordances from declared controls no step used.
 * It does not name anything. That is not the ABM's constructor; it is the **baseline the pivot has
 * to beat**. Pointed at the 0.1.22 walk it produces exactly the document the current pipeline
 * *would* produce if `capability` were renamed `behavior`, and `profileFindings` then refuses it:
 * `fill_login_email`, `fill_login_password` and `submit_login` are P1 violations, and three
 * behaviours have no realization because they are steps of `login`, not behaviours. Those numbers
 * are 0b's acceptance evidence (`test/abm-baseline.mjs`) and they are what phase 3 measures down.
 *
 * ## No writes, ever
 *
 * Nothing here commits, appends, heals or repairs. `candidatesFromRun()` reads a directory —
 * `run.json`, `graph.json` or the four `.jsonl` logs — and that is the only filesystem access in
 * the module. A profile that could edit the document it judges would be able to make itself green.
 *
 * It is also allowed to refuse. A run whose `run.json` declares no application cannot become a 0.2
 * document (the schema requires one, and a host is not an application), so `modelFromCandidates()`
 * throws the same refusal the commit's `application_not_declared` gate makes, rather than emitting
 * a placeholder that would satisfy every shape check while naming nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTROL_ROLES, ELEMENT_TARGET_EFFECTS, readRun, readJsonl, reconcile } from './commit.js';
import { MIN_WITHHELD_CHARS, REDACTION, SUPPLIED_ARGUMENT, redactProse } from './redaction.js';
import { EVIDENCE_ROLES, templateParameter } from './schema.js';
import { slugify } from './session.js';

/** The schema generation this module emits. `schemas/abm/0.2/` is the only reader of it. */
export const ABM_SCHEMA_VERSION = '0.2';

/**
 * The verbs that name a mechanism rather than a goal.
 *
 * P1 needs *some* vocabulary to refuse `<verb>_<page>_<element>`, and it must not be the
 * application's — a rule that learns its nouns from the document it judges cannot refuse a name
 * the document invented. These are the words the browser tools themselves use (`browser_fill`,
 * `browser_click`, `browser_type`), so the list is the machinery's own vocabulary rather than a
 * guess about the app: a behaviour whose first word is one of these is named after the call that
 * was made, which is exactly the thing P1 exists to stop.
 */
export const MECHANISM_VERBS = new Set([
  'fill', 'type', 'enter', 'set', 'clear', 'click', 'press', 'tap', 'submit', 'select', 'check',
  'uncheck', 'toggle', 'hover', 'focus', 'blur', 'upload', 'drag', 'scroll', 'read', 'wait',
]);

/** The evidence roles a transition must carry (P9). A subset of the schema's vocabulary. */
export const TRANSITION_EVIDENCE_ROLES = ['identity', 'action', 'effect'];

/**
 * The three epistemic levels (D9), weakest first.
 *
 * The order *is* the rule: a claim derived from other claims takes the **minimum** of theirs
 * (D11), so re-deriving a reading cannot promote it and copying a document forward cannot either.
 * `modelled` is what nothing claimed, `inferred` is what a producer read out of a capture,
 * `observed` is what the collector watched or the operator declared.
 */
export const CLAIM_LEVELS = Object.freeze(['modelled', 'inferred', 'observed']);

/**
 * The strongest `status` and `confidence` each level permits (D11).
 *
 * `verified` means *executed and verified* — the schema's own gloss on confidence 1.0 — so both
 * fields are the same claim in two places, and a fix for one that leaves the other standing is not
 * a fix. A reading may be reported `inferred` at 0.5 (again the schema's gloss), a derivation
 * `draft` at 0.3 (§3's number for a claim nothing refuted). `draft` is also the schema's default
 * for a missing status, so silence is never a promotion.
 */
export const LEVEL_CEILING = Object.freeze({
  modelled: Object.freeze({ status: 'draft', confidence: 0.3 }),
  inferred: Object.freeze({ status: 'inferred', confidence: 0.5 }),
  observed: Object.freeze({ status: 'verified', confidence: 1 }),
});

/** The schema's `status` enum, ordered. A status outside it is read as the default (`draft`). */
export const STATUS_RANK = Object.freeze({ draft: 0, inferred: 1, verified: 2 });

/**
 * The producers that *reason*: they read a claim out of a capture rather than being in a position
 * to know it. `llm:<model>` names a semantic object; `importer:<tool>` derives one from a document.
 */
const REASONING_PRODUCERS = /^(llm|importer)(:|$)/;

/**
 * The producers that *observe*. `playwright` was there; `manual` is the operator, who is the
 * authority on what the application is — the commit's own `application_not_declared` gate says the
 * identity is declared, never derived. Neither is a fourth level: D9's levels are about what the
 * *claim* is, and the owner of the application saying what it is called is not a machine reading a
 * walk. A producer this list does not recognise is treated as `modelled`, never as `observed` —
 * a producer the rule has not heard of cannot borrow the collector's status.
 */
const OBSERVING_PRODUCERS = /^(playwright|manual)(:|$)/;

/**
 * The level one `metadata` block was obtained at (D9, D11).
 *
 * `inputs` are the levels of the claims this one is derived from — a composite's members, say. A
 * derived claim is the minimum of its inputs' levels and its own, which is how a `login` composed
 * of three observed steps but *named* by a model stays `inferred`: the parts were watched, the
 * name was read, and the object makes both claims.
 */
export function claimLevel(metadata, inputs = []) {
  const producer = typeof metadata?.producer === 'string' ? metadata.producer : '';
  const own = REASONING_PRODUCERS.test(producer) ? 'inferred'
    : OBSERVING_PRODUCERS.test(producer) ? 'observed'
      : 'modelled';
  return [own, ...rows(inputs)].reduce(
    (lowest, level) => (CLAIM_LEVELS.indexOf(level) < CLAIM_LEVELS.indexOf(lowest) ? level : lowest),
    own,
  );
}

/**
 * Every rule, and the severities it is allowed to report.
 *
 * The table is exported so a test can refuse a finding whose severity drifted, and so the
 * refusal-to-severity mapping lives in one place instead of in the middle of thirteen loops.
 * `P13` is the only rule with two: an affordance naming an element the surface does not declare
 * is an error, and an affordance the walk *did* perform is a warning about the walk's own claim.
 */
export const PROFILE_RULES = Object.freeze({
  P1: ['error'],
  P2: ['warning'],
  P3: ['error'],
  P4: ['error'],
  P5: ['error'],
  P6: ['warning'],
  P7: ['error'],
  P8: ['warning'],
  P9: ['error', 'warning'],
  P10: ['warning'],
  P11: ['warning'],
  P12: ['error', 'info'],
  P13: ['error', 'warning'],
  P14: ['error'],
  P15: ['error'],
  P16: ['error'],
  P17: ['error'],
});

/** The kinds a behaviour may declare. Copied from `behavior.schema.json`'s enum. */
const BEHAVIOR_KINDS = new Set(['interaction', 'navigation', 'query', 'setup', 'composite']);

const rows = (value) => (Array.isArray(value) ? value : []);

const isElementId = (value) => typeof value === 'string' && /^element[-_][A-Za-z0-9._:-]+$/.test(value);

const isStorageKey = (value) => typeof value === 'string'
  && /^(localStorage|sessionStorage|cookie)[.:]/i.test(value);

// A value that is entirely a `{{param}}` template is a reference, not a literal: the schema
// states the form (`templateParameter`, which the generator reads the same way) and the
// projection is the caller that has to check the parameter is declared.
const isPlaceholder = (value) => templateParameter(value) !== null;

/** Drop the keys a document must not carry. `null` is not a value here: 0a measured that. */
const prune = (object) => {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
};

const distinct = (values) => [...new Set(values.filter((value) => value !== undefined && value !== null))];

const behaviorIdFor = (name) => `behavior_${slugify(name)}`;

/** The placeholders inside a realisation value or a bound argument. */
const placeholdersIn = (value) => {
  const found = [];
  for (const text of [value, ...(typeof value === 'object' && value !== null ? Object.values(value) : [])]) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) found.push(match[1]);
  }
  return found;
};

// ---------------------------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------------------------

/**
 * A committed `graph.json` as the candidate arrays the projection takes.
 *
 * The commit writes the graph from exactly these candidates, so the graph *is* a candidate set —
 * one that has already been judged once. Reading it back is what makes 0b runnable against runs
 * that are already on disk, which is the only way to quantify the defect before changing anything.
 */
export function candidatesFromGraph(graph, run = null, recordedSteps = null) {
  // `capabilities[].steps[]` as *written* has been through the graph's own step shape
  // (`capability.schema.json#/$defs/capabilityStep`, which sets `additionalProperties: false`), so
  // it has no room for `purpose` or `effects` — the two keys the behaviour model's `behaviorStep`
  // adds, and `commit.js` drops them at the projection and says why. The run's log keeps the whole
  // record, so when the caller can hand over what was recorded, that is what the model is built
  // from and the graph's narrower steps are the fallback. Nothing is invented either way: it is the
  // same recorded step, read at the resolution the behaviour document gives it — and the prose on a
  // step is exactly what says a collapsed move arrived somewhere in the middle of itself.
  const capabilities = rows(graph?.capabilities).map((capability) => {
    const recorded = recordedSteps?.get(capability.id);
    return recorded?.length ? { ...capability, steps: recorded } : capability;
  });
  return {
    run: run ?? null,
    application: graph.application ?? null,
    observations: rows(graph.observations),
    states: rows(graph.states),
    capabilities,
    transitions: rows(graph.transitions),
    journeys: rows(graph.journeys),
    coverage: graph.coverage ?? null,
    warnings: rows(graph.warnings),
    source: 'graph.json',
  };
}

/**
 * One edge is one step of a behaviour however many times it was walked.
 *
 * The log is append-only, so a re-walked step is a second record for the same
 * `capability_id`/`transition_id` pair, and the pair is the key for the same reason
 * `recordTransition` keys an edge by its endpoints: the walk is where the run is now, and a
 * behaviour's edge is its last step's destination (D12). The newest `walk_index` stands.
 *
 * This is exported because it is a rule about the log and not a step of either reader. A live
 * 0.1.29 run re-recorded one edge to correct a mistake, the commit's own assembly collapsed the
 * two records and this module's reader did not, and the two readings of that one run disagreed
 * about how many times the behaviour clicked Sign in — the shipped model performing the click
 * once, the profile reading performing it twice with a different `storage_changed` target each
 * time. Two readers of one log have to agree, so the rule lives in one of them.
 *
 * A record with no `walk_index` cannot be ordered against the others, so it sorts before all of
 * them rather than after: guessing last would claim that an unordered step ends a behaviour,
 * which is the one position a step cannot be guessed into.
 */
export function keyedRealizationSteps(records) {
  const byKey = new Map();
  for (const record of rows(records)) {
    const id = record.capability_id ?? record.id;
    if (record.kind !== 'realization_step' || typeof id !== 'string') continue;
    const key = JSON.stringify([id, record.transition_id ?? null]);
    const previous = byKey.get(key);
    if (previous && (previous.walk_index ?? -1) > (record.walk_index ?? -1)) continue;
    byKey.set(key, record);
  }
  return byKey;
}

/**
 * The steps a run recorded, per capability, out of the run's own log.
 *
 * `capabilities.jsonl` holds three kinds of record and the `realization_step` one is the behaviour
 * model's step — a `behaviorStep`, with the `purpose` and the `effects` the graph's step shape has
 * no key for. Reading them here rather than out of `graph.json` is what keeps a behaviour's own
 * account of itself in the model: a step's `purpose` is why a person asked for it, and a step's
 * `effects` is where the move landed, which is the only thing that can explain a state the walk
 * entered between two calls of one behaviour (P12, `collapsed_past_a_state`).
 *
 * `null` when there is no log to read, which is a plain "the graph is all there is" and not an
 * empty answer.
 */
function recordedStepsIn(dir) {
  const path = join(dir, 'capabilities.jsonl');
  if (!existsSync(path)) return null;
  const byCapability = new Map();
  for (const record of keyedRealizationSteps(readJsonl(path)).values()) {
    const id = record.capability_id ?? record.id;
    byCapability.set(id, [...(byCapability.get(id) ?? []), record]);
  }
  for (const list of byCapability.values()) {
    list.sort((left, right) => (left.walk_index ?? -1) - (right.walk_index ?? -1));
  }
  return byCapability;
}

/**
 * Everything one run recorded, read-only.
 *
 * `graph.json` wins when it is there: it is the document that was judged and it carries the
 * journeys, which the logs do not (a journey is a claim about a walk, and only the commit makes
 * it) — and the log wins for the *steps*, because the graph's step shape is narrower than the
 * behaviour model's on purpose and the model is not built from the narrower one.
 *
 * Without it the four logs are read — and through `reconcile()`, not by hand. The logs hold the
 * *candidate* records, whose shape is older and looser than the committed one (`states.jsonl`
 * elements carry a `semantic_purpose` and a raw CSS string, and no element id at all), so anything
 * this module did to them would be a second, divergent reading of the same evidence. The commit
 * already knows how to turn them into a document; it writes that document when its gates pass, and
 * hands back `draft` when they do not. Profiling a run that never committed is exactly the case a
 * profile is for, so the draft is projected, and the gates that blocked it are carried as notes.
 * Nothing here writes: `commitRun` is what writes, and this is not it.
 */
export function candidatesFromRun(dir) {
  const graphPath = join(dir, 'graph.json');
  const runPath = join(dir, 'run.json');
  const run = existsSync(runPath) ? JSON.parse(readFileSync(runPath, 'utf8')) : null;
  if (existsSync(graphPath)) {
    return candidatesFromGraph(
      JSON.parse(readFileSync(graphPath, 'utf8')),
      run,
      recordedStepsIn(dir),
    );
  }
  const read = readRun(dir);
  const { graph, draft, report } = reconcile({ ...read, command: 'graph_profile' });
  const notes = rows(report?.gates).map((gate) => (
    `the commit refused this run: ${gate.code} — ${gate.detail}`
  ));
  return {
    ...candidatesFromGraph(graph ?? draft, run),
    source: graph ? 'logs' : 'draft',
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------------------------

/**
 * The values this walk supplied into a field, and therefore the values the model may not repeat as
 * prose.
 *
 * `capture.js` masks a password box before it is read (`entry.value = el.type === 'password' ? …
 * '[set]' …`) for one reason: "the graph is a durable artefact and a credential in it outlives the
 * run". The *semantic* layer honours that mask (`fill_login_password` is realised with the value
 * `[set]`), but a goal quoted from the run's instruction undoes it in prose — the 0b live run's goal
 * was "Using the browser tools, open the Acme demo app at http://127.0.0.1:4173/ and sign in with
 * test@example.com and password123.", and the email it names is also on an edge's `arguments` while
 * the password is on the recorded action. This is the set of values that make an instruction one
 * that "carried a credential" (`journey.schema.json`, `goal`).
 *
 * Read from the evidence, never from the shape of a word: an instruction that says "sign in as the
 * seeded user" repeats nothing the walk typed, and this module does not decide whether a word looks
 * like a secret. What it does is narrower and checkable: a sentence that repeats a value the walk put
 * in a field is a sentence quoting test data rather than stating an outcome.
 *
 * Four characters is the floor (`redaction.js#MIN_WITHHELD_CHARS`, the same number for the same
 * reason), because a walk that typed "yes" must not have its goal withheld for the instruction's own
 * "yes": a value shorter than that is not specific enough to be told apart from the sentence around
 * it, and a rule that fires on the word "yes" is a rule nobody can keep.
 */
const suppliedValuesOf = ({ observations = [], transitions = [], capabilities = [] } = {}) => {
  const values = new Set();
  const note = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    // The mask is not a value the walk supplied — it is the standing for one, and a projection that
    // took it for data would withhold a goal for having typed "[set]". The call's own arguments are
    // redacted at ingestion now (`redaction.js`), so this is the branch the password takes: the run
    // says it supplied something, and the document says exactly that much.
    if (trimmed === REDACTION) return;
    if (trimmed.length >= MIN_WITHHELD_CHARS) values.add(trimmed);
  };
  // The run's own record of each call. A page reads back what a field *holds* — and a password box
  // reads back `[set]`, by design — while the call that filled it still says what was typed, which is
  // why the value is read from the call as well as from the edge. It is also the only source that knows
  // a password at all: `transitions[].action.arguments` are the commit's field→value map, and they
  // honour the capture's mask.
  for (const observation of rows(observations)) {
    for (const value of Object.values(observation.action?.arguments ?? {})) note(value);
    const tool = observation.metadata?.extra?.tool;
    if (SUPPLIED_ARGUMENT.has(tool)) note(observation.metadata?.extra?.tool_arguments?.[SUPPLIED_ARGUMENT.get(tool)]);
  }
  for (const transition of rows(transitions)) {
    for (const value of Object.values(transition.action?.arguments ?? {})) note(value);
  }
  for (const capability of rows(capabilities)) {
    for (const step of rows(capability.steps)) {
      for (const value of [step.value, ...Object.values(step.arguments ?? {})]) note(value);
    }
  }
  return values;
}

/** What a value the walk supplied is, as far as a sentence can tell. */
const repeatedIn = (text, supplied) => (typeof text === 'string'
  ? [...supplied].filter((value) => text.includes(value))
  : []);

/**
 * The sentence a journey may keep, and the reason it may not keep the other one.
 *
 * `journey.schema.json` gives `goal` exactly one prohibition — it is "the business outcome in one
 * sentence", and "NEVER the raw instruction when the instruction carried a credential" — and this
 * projection is the layer that can enforce it, because the commit quotes the run's instruction as the
 * goal (it has to: `run.json` is the only place intent was written down) and an instruction is
 * usually a task with the account to use attached to it. The test is not whether a word looks like a
 * secret — a password is a string like any other — it is whether the sentence repeats a value the walk
 * actually typed into a field.
 *
 * Withholding is not dropping. The journey keeps saying what the walk was for, in the model's own
 * vocabulary: the behaviour names it performed, in walk order, and the surface it reached — the voice
 * the fallback journey already uses, prefixed so a reader knows no person wrote it. And `goal_stated`
 * becomes false, which is what that flag means: the run stated a different sentence, so this one is
 * derived.
 *
 * The instruction is redacted rather than kept or removed. Kept verbatim beside a withheld goal, the
 * credential would be back in the same object; removed, the document would lose the only record of
 * what the run was asked for. Redacted, the sentence still says what the task was, and the run's own
 * actions still carry the value the generator resolves test data from.
 */
const goalOf = ({ journey, turns = [], supplied = new Set() } = {}) => {
  const stated = typeof journey?.goal === 'string' && journey.goal.trim() ? journey.goal.trim() : null;
  const raw = journey?.metadata?.extra?.run_instruction;
  const instruction = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const statedRepeats = repeatedIn(stated, supplied);
  const instructionRepeats = repeatedIn(instruction, supplied);
  const count = (values) => (values.length === 1 ? 'a value' : `${values.length} values`);
  const answer = {
    goal: stated,
    goal_stated: journey?.metadata?.extra?.goal_stated ?? Boolean(stated),
    goal_source: null,
    repeated: distinct([...statedRepeats, ...instructionRepeats]),
  };
  if (!statedRepeats.length) return answer;
  const names = distinct(turns.map((turn) => turn.name));
  const start = turns.length ? turns[0].from_state : null;
  const end = turns.length ? turns[turns.length - 1].to_state : null;
  return {
    ...answer,
    goal: `Derived goal: the walk performs ${names.join(', ') || 'nothing'} and reaches ${end ?? 'no surface'} from ${start ?? 'no surface'} (${turns.length === 1 ? '1 move' : `${turns.length} moves`}).`,
    goal_stated: false,
    goal_source: `withheld: the run's instruction was quoted as this walk's goal and it repeats ${count(statedRepeats)} the walk supplied into a field, so it carried a credential — and a goal is never the raw instruction when the instruction carried one. The goal kept here is derived from the walk's own behaviours: what it performed, in order, and where it ended. The instruction itself is left where the record has it, and so is every value: a generator resolves test data from the run's own actions, and a value deleted here would be a value something downstream has to invent.`,
  };
};

/**
 * The ABM shape of §3, from a recorded run. Mechanical by construction; see the module docstring.
 *
 * Every derived object carries `metadata.extra.derived`, so a later reader can tell what the
 * document *claims* from what the projection *inferred* — the same distinction the commit makes
 * when it records a decision next to a record.
 */
export function modelFromCandidates({
  run = null,
  application = null,

  observations = [],
  states = [],
  capabilities = [],
  transitions = [],
  journeys = [],
  coverage = null,
  warnings = [],
  generatedAt = null,
} = {}) {
  const notes = [];
  // A 0.2 document is a document *about an application*: the schema requires `application` with an
  // id and a name, so a run that recorded neither cannot become one, and inventing a placeholder
  // would produce a document that passes every shape check while naming nothing. The commit refuses
  // exactly this run with the `application_not_declared` gate, and no amount of evidence supplies
  // the answer: a host is where an app is served, not what it is.
  const applicationId = typeof application?.id === 'string' && application.id.trim() ? application.id : null;
  const applicationName = typeof application?.name === 'string' && application.name.trim() ? application.name : null;
  if (!applicationId || !applicationName) {
    throw new Error(
      `abm: this run cannot be projected. It declares ${applicationId ? '' : 'no application id'}${!applicationId && !applicationName ? ' and ' : ''}${applicationName ? '' : 'no application name'}, and a 0.2 document is a document about an application. Declare it where the exploration is configured (\`application: {id, name}\`) and run again — the commit refuses the same run with the application_not_declared gate.`,
    );
  }
  const capabilityById = new Map(capabilities.map((entry) => [entry.id ?? entry.capability_id, entry]));
  const transitionById = new Map(transitions.map((entry) => [entry.id, entry]));
  const stateById = new Map(states.map((entry) => [entry.id, entry]));
  const variantOfState = (stateId) => stateById.get(stateId)?.identity?.variant ?? null;
  // The values this walk supplied, read once from the evidence and used for one thing: telling a goal
  // that states an outcome from a goal that quotes the run's instruction and the account it used.
  const supplied = suppliedValuesOf({ observations, transitions, capabilities });
  // The level each reading was obtained at, so a contract can state its outcomes at the level of the
  // readings that support them rather than at a level of its own choosing (D11). Without this the
  // projection writes `observed` about a set of readings that may all be `modelled` — a legal document,
  // produced by any tool that stamps no `producer` — and a contract that outranks its own evidence is
  // the one shape P17 exists to refuse. A projection must not be able to trip its own rule.
  const levelByObservation = new Map(observations.map((observation) => [observation.id, claimLevel(observation.metadata)]));
  const levelOfObservation = (id) => (id == null ? null : levelByObservation.get(id) ?? null);

  // --- the realisation the run recorded, and what it demotes (D13/D14) --------------------------
  // A capability is a *behaviour* only while nothing recorded it as a *step*. Phase 1 fills
  // `capabilities[].steps[]` out of the `realization_step` log, so a capability that carries steps
  // is the behaviour those steps perform, and the capabilities those same steps named are the
  // mechanism rather than behaviours: `fill_login_email` is how `login` happens, not something a
  // person asks for. The gate is that record and never `composed_of` alone — a capability composed
  // of other capabilities (`session` = `go` then `b`) is a real behaviour built from real
  // behaviours, and demoting its members because they are members would delete two behaviours a
  // model declared and nothing refuted. On a run that recorded no realisation (`0.1.22`), nothing
  // is demoted and the projection is the one 0b quantified.
  const stepsOf = (capability) => rows(capability?.steps);
  const realized = capabilities.filter((capability) => stepsOf(capability).length > 0);
  const ownerOf = new Map(); // a step capability's id -> the realized behaviour that performed it
  for (const behaviour of realized) {
    for (const member of rows(behaviour.composed_of)) {
      if (typeof member === 'string' && capabilityById.has(member)) ownerOf.set(member, behaviour);
    }
  }
  const ownerOfCall = (edge) => {
    const called = edge.action?.capability;
    if (typeof called !== 'string') return null;
    return ownerOf.get(called) ?? capabilityById.get(called) ?? null;
  };

  // --- D5/D12: one edge per move a behaviour performs, not per call it makes ---------------------
  // `transitions[]` is re-scoped to the behaviour: a behaviour whose steps were recorded is *one*
  // move, and its destination is where its last step landed. The walk's own order is what makes the
  // move readable — an invocation is a chain of the behaviour's calls, each starting where the one
  // before it arrived — so two invocations of one behaviour are two edges however many calls each
  // took, and a behaviour is never collapsed across a state it did not stay in. The log and
  // `graph.json` keep every call, because a call is what happened and the edge is what it means.
  // The survivor is the last call of the invocation, so the edge is known by the id of the call that
  // ended it, its `metadata.extra.commit.step` is the reading it ended in, and the calls it absorbed
  // are named on it — which is what P12a checks every committed call against.
  const dedupeRefs = (list, key) => {
    const seen = new Set();
    const kept = [];
    for (const item of list) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(item);
    }
    return kept;
  };
  const absorbed = new Map(); // an absorbed call's id -> the id of the edge that carries it
  const survivorById = new Map(); // the surviving edge's id -> the merged edge
  // Which invocation a call belonged to, for the calls that are one of several. A journey turn is a
  // *move*, and the move is the invocation: the calls it took are the behaviour's `realization[]`,
  // which the document already carries, so a turn per call would name one move as many times as it
  // happened to take DOM steps. Two invocations of one behaviour between the same two states are
  // still two turns, which is why this is keyed by invocation and not by call or by pair.
  const invocationOf = new Map();
  for (const behaviour of realized) {
    const ownerId = behaviour.id ?? behaviour.capability_id;
    const order = [ownerId, ...rows(behaviour.composed_of).filter((member) => typeof member === 'string')];
    const rank = new Map(order.map((id, index) => [id, index]));
    const calls = transitions
      .filter((edge) => rank.has(edge.action?.capability))
      .sort((left, right) => rank.get(left.action.capability) - rank.get(right.action.capability));
    const invocations = [];
    for (const call of calls) {
      const current = invocations[invocations.length - 1];
      if (current && current[current.length - 1].to_state === call.from_state) current.push(call);
      else invocations.push([call]);
    }
    // D5's key then dedupes the invocations: two invocations of one behaviour between the same two
    // states are one edge walked twice, however many calls each of them took, and the edge's
    // `metadata.extra.collapsed.calls` is where that is written down.
    const byMove = new Map();
    for (const invocation of invocations) {
      const key = `${invocation[0].from_state}|${invocation[invocation.length - 1].to_state}`;
      const list = byMove.get(key) ?? [];
      list.push(invocation);
      byMove.set(key, list);
    }
    for (const group of byMove.values()) {
      const final = group[group.length - 1];
      const last = final[final.length - 1];
      const carried = group.flatMap((invocation) => invocation).slice(0, -1);
      // Every call of one invocation is one move, so the key is the invocation's own first call
      // rather than each call's id — the last call of the last invocation is not in `carried` and
      // is not absorbed, and it has to share the key of the calls that are.
      for (const invocation of group) {
        const key = `${ownerId}|${invocation[0].id}`;
        for (const call of invocation) invocationOf.set(call.id, key);
      }
      for (const call of carried) absorbed.set(call.id, last.id);
      if (!carried.length) continue;
      // P0-1: the prose the merged edge carries. `...last` below copies the surviving call's own
      // `name` and `description`, and those describe a *step* — which is how an edge whose behaviour
      // is `login`, whose `realization[]` is three actions and whose `behavior` is `behavior_login`,
      // came to be described as "Submit the sign-in form". A document whose edge says one thing in
      // `behavior` and another in `description` is a reader's contradiction, and the schema states
      // the rule the merge has to satisfy: the edge "is what the application did, in domain terms",
      // and "the steps live in behavior.realization[]".
      //
      // So the edge's name is the behaviour's and its description is built from what the move was
      // made of — the calls it was recorded as, in the order the walk performed them. Nothing is
      // invented: a behaviour that declared no name of its own keeps the surviving call's, and the
      // call names are the committed capabilities' own.
      const ownerBehaviour = realized.find((entry) => (entry.id ?? entry.capability_id) === ownerId) ?? null;
      const moveSteps = [...carried, last];
      const behaviourName = ownerBehaviour?.name ?? last.name ?? last.id;
      const callNames = moveSteps.map((call) => {
        const step = capabilityById.get(call.action?.capability);
        return step?.name ?? call.action?.capability ?? call.id;
      });
      survivorById.set(last.id, {
        ...last,
        // D12: the edge is the behaviour's *move*, so it starts where the invocation started and ends
        // where the last of its calls landed. Its id is still the id of the call that ended it — that
        // is what keeps the collapse readable against the log — but a move's origin is the reading it
        // was performed from, and carrying the last call's `from_state` would have claimed the
        // behaviour started wherever its final call started and lost the state the walk stood in when
        // it was asked for.
        from_state: final[0].from_state,
        // P0-1: see the note above the literal. The moved bounds alone would leave the edge named
        // and described after its final step, which is the contradiction the review names: a
        // behaviour with a three-action realization whose edge reads like one of the three.
        name: behaviourName,
        description:
          `${behaviourName} performed as one move from ${final[0].from_state} to ${last.to_state} — ` +
          `${moveSteps.length} recorded call(s): ${callNames.join(', ')}. ` +
          'The calls are this behaviour\'s realization[]; the edge is the move they add up to.',
        action: { ...last.action },
        effects: dedupeRefs([...carried, last].flatMap((call) => rows(call.effects)), (effect) => JSON.stringify(effect)),
        apis: distinct([...carried, last].flatMap((call) => rows(call.apis))),
        evidence: dedupeRefs(
          [...carried, last].flatMap((call) => rows(call.evidence)),
          (ref) => `${ref.observation ?? ''}|${ref.role ?? ''}`,
        ),
        metadata: {
          ...(last.metadata ?? {}),
          extra: {
            ...(last.metadata?.extra ?? {}),
            collapsed: {
              behaviour: ownerId,
              // The move's own bounds, and then the calls it swallowed. `from_state` here is the
              // edge's origin, so the two agree: a reader checking the collapse against the log has
              // one place to look and no way to read the pair as disagreeing.
              from_state: final[0].from_state,
              to_state: last.to_state,
              // How many times the behaviour was walked between these two states, and which calls
              // each of those invocations made. A reader has to be able to tell "walked twice" from
              // "one walk with a detour", because only the first is a repetition the model can
              // rely on — and `calls` alone cannot say which without knowing where each began.
              invocations: group.length,
              calls: [...carried, last].map((call) => call.id),
              passed_through: distinct(carried.map((call) => call.to_state).filter((state) => state !== last.to_state)),
              // P0-1: the sentence the surviving call was recorded with. The edge's `description`
              // now describes the move, so this is where the model's own account of the step that
              // ended it is kept: it is the evidence the edge's prose was derived from, and a reader
              // comparing the edge with the committed call should find it rather than infer it.
              last_call: prune({ id: last.id, name: last.name, description: last.description }),
            },
          },
        },
      });
    }
  }
  // The surviving edges in the document's own order: a call that was absorbed is not an edge any
  // more, and the edge that carries it stands where that call's last step stood.
  const survivors = [];
  const survivorSeen = new Set();
  for (const edge of transitions) {
    if (absorbed.has(edge.id)) continue;
    const survivor = survivorById.get(edge.id) ?? edge;
    if (survivorSeen.has(survivor.id)) continue;
    survivorSeen.add(survivor.id);
    survivors.push(survivor);
  }
  const edgesByCapability = new Map(); // a capability's id -> the surviving calls it made
  const behaviourEdges = new Map(); // a realized behaviour's id -> the surviving edges it performs
  for (const edge of survivors) {
    const called = edge.action?.capability ?? null;
    if (typeof called === 'string') {
      edgesByCapability.set(called, [...(edgesByCapability.get(called) ?? []), edge]);
    }
    const owner = ownerOfCall(edge);
    if (owner) {
      const id = owner.id ?? owner.capability_id;
      behaviourEdges.set(id, [...(behaviourEdges.get(id) ?? []), edge]);
    }
  }
  const edgesFor = (capability) => {
    const id = capability.id ?? capability.capability_id;
    return behaviourEdges.get(id) ?? edgesByCapability.get(id) ?? [];
  };

  // A realized behaviour's parameters live on the step capabilities that declared them, so the
  // behaviour's `input` is their union: a step binding `{{email}}` is the behaviour's parameter,
  // and a behaviour that performs that step without declaring it is the `unbound_parameter` the
  // profile refuses (P5). Nothing is invented — the union is a copy of a declaration the run made.
  const inputOf = (behaviour) => {
    const declared = behaviour.input && typeof behaviour.input === 'object' ? behaviour.input : null;
    const members = rows(behaviour.composed_of)
      .map((member) => (typeof member === 'string' ? capabilityById.get(member) : null))
      .filter((member) => member?.input && typeof member.input === 'object');
    if (!members.length) return declared;
    const union = Object.assign({}, ...members.map((member) => member.input), declared ?? {});
    if (!Object.keys(union).length) return undefined;
    if (!declared) {
      notes.push(`${behaviour.id}: input was taken from the capabilities its realization performs (${members.map((member) => member.id).join(', ')}), because a behaviour whose steps bind a parameter has to declare it.`);
    }
    return union;
  };

  // --- actors: the declared vocabulary first, then the variants the run used and nobody declared -
  // `application.actors[]` is the one part of the document the evidence cannot supply. A page shows
  // which variant it was read as; it never shows that `authenticated` is a role somebody can sign in
  // as, nor which credential they sign in with. So a declared entry is carried through as declared —
  // id, description, credentials_ref — and the projection says nothing about it beyond copying it,
  // except for the one thing it can check: whether any state or journey of this run actually used
  // that id (P6's `untraceable_actor`). The one decision the projection takes about roles is whether
  // a journey may claim one, and it is at the journey builder: a role is a declaration, so a variant
  // that no declaration names is not one.
  //
  // A variant the run used and the declaration does not name is *also* carried, because
  // `state.identity.variant` is read through this vocabulary and `actors` cannot be empty (the schema
  // needs one row even when the run declared none), so dropping the row would leave a state variant
  // pointing at nothing. It is carried as what it is — a surface variant, explicitly not a role —
  // which is also why it does not become a journey's `actor`: see the journey builder below. A run
  // that declares nothing therefore projects exactly as it did before this registry existed: the
  // union is the old behaviour, and a declaration only adds rows and metadata the run could not have
  // derived.
  const declaredActors = Array.isArray(application?.actors) ? application.actors.filter((actor) => actor?.id) : [];
  const declaredIds = new Set(declaredActors.map((actor) => actor.id));
  const variantRows = distinct(states.map((state) => state.identity?.variant));
  const actors = [
    ...declaredActors.map((actor) => prune({
      id: actor.id,
      description: actor.description ?? `Declared as the actor "${actor.id}"; nothing this run recorded says what it means.`,
      credentials_ref: actor.credentials_ref,
    })),
    ...variantRows
      .filter((id) => !declaredIds.has(id))
      .map((id) => ({
        id,
        description: `Observed as the surface variant "${id}"; no declaration names an actor with this id. A variant is what the run saw and not a role the application offers, so this row is what a state's variant resolves to rather than a claim about who can use the application.`,
      })),
  ];

  // --- state variables: every dimension a state identity distinguishes, with its detection ----
  //
  // A dimension is read off the *reading*, and the reading that measures one is the step that moved
  // the state: the commit counts a collection's rows there ("the reading at the end of the step
  // counted 3 row(s) in element_project_list — so the dimension is checkable as a count") and offers
  // it as an assertion. That offer, and the model's own assertion on the same edge, are the two
  // signals `detectionFor` falls back to when the state's own `detection` names no surface. Neither
  // is invented here: both are copied, and the name link (`target`) is what says which variable they
  // are about.
  const dimensionReadings = new Map();
  const recordDimensionReading = (assertion) => {
    if (assertion?.type !== 'value') return;
    const name = assertion.target;
    if (typeof name !== 'string' || name === '' || dimensionReadings.has(name)) return;
    dimensionReadings.set(name, assertion);
  };
  for (const edge of survivors) {
    // The model's own assertion first: it is the claim, and the commit's candidate is a proposal.
    for (const assertion of rows(edge.assertions)) recordDimensionReading(assertion);
    for (const candidate of rows(edge.metadata?.extra?.commit?.candidate_assertions)) {
      if (candidate?.basis === 'dimension') recordDimensionReading(candidate.assertion);
    }
  }

  const variables = new Map();
  for (const state of states) {
    for (const [name, value] of Object.entries(state.identity?.dimensions ?? {})) {
      let variable = variables.get(name);
      if (!variable) {
        variable = {
          name,
          description: 'A distinction a state identity draws; the projection cannot say what it means.',
          type: 'string',
          values: [],
          dimension_of: [],
          detection: detectionFor(state, name, dimensionReadings),
          evidence: [],
          // A variable is not read off a page the way a state is: the state is the reading, the
          // variable is the commit's reading *of the reading*, so it is `inferred` and says who
          // inferred it. Claiming `verified` here was the one row in the projection that carried a
          // level with no producer behind it (P14/`claim_has_no_producer`).
          metadata: {
            confidence: 0.5,
            status: 'inferred',
            producer: 'importer:dsh-graph-explorer',
            extra: { derived: 'state.identity.dimensions' },
          },
        };
        // A dimension the projection could not ground is said out loud, because dropping a claim
        // the state made is exactly the kind of silence this projection exists to refuse: the
        // finding that follows it (P7) says a test cannot check the difference, and this says why
        // the projector had nothing to carry — the reading named no surface, or no reading named
        // the dimension at all.
        const claimed = rows(state.detection).find((entry) => entry?.target === name);
        if (!variable.detection) {
          notes.push(claimed
            ? `${name}: ${state.id} asserts the dimension in \`detection\` and names no element or route to read it on, so the state variable carries no detection (P7).`
            : `${name}: ${state.id} declares the dimension and no reading of it records an element or route that measures it, so the state variable carries no detection (P7 asks for one: an element that shows the distinction, or the count of the collection it names).`);
        }
      }
      if (!variable.values.includes(value)) variable.values.push(value);
      if (!variable.dimension_of.includes(state.id)) variable.dimension_of.push(state.id);
      // §P1: a variable's evidence has to be evidence *about the variable*, and the reference this
      // used to carry was the state's own `evidence[]` copied whole — including the state's note,
      // which says "the reading that made this a *state*". A reference whose prose answers a
      // question about a different claim is the sort of traceability that looks present and is not:
      // a reader following it learns when the state was first seen, and nothing about why this
      // reading is evidence for `projects` holding the value `populated`. So the observation is the
      // same observation — nothing is invented, and the readings a state has are the readings the
      // dimension was read in — and the note is this claim's own: it names the state whose identity
      // draws the distinction and the value that state was read with, both of which are fields of
      // this document and checkable against it.
      //
      // The role stays `identity`, and that is a correction rather than an oversight: the reading is
      // evidence for the *identity* that declares the dimension, not for the variable's detection.
      // `detection` would say this reading is where a predicate measured the distinction, and in a
      // run where no reading asserted the dimension (the live 0b run) there is no such reading — the
      // P7 finding named below is the truth about it, and a role that claimed otherwise would be
      // this projection papering over the gap it exists to report.
      for (const ref of rows(state.evidence)) {
        const observationId = ref.observation;
        if (!observationId || variable.evidence.some((entry) => entry.observation === observationId)) continue;
        variable.evidence.push({
          observation: observationId,
          role: 'identity',
          note: `the reading in which ${state.id} was seen drawing this distinction: its identity declares ${name} = ${JSON.stringify(value)}, and the reading is where the surface was read as that state`,
        });
      }
      variables.set(name, variable);
    }
  }

  // --- behaviours: one per committed capability, minus what the run recorded as a step ---------
  // An element-shaped effect names the control it happened to. The tool's own description of `effects`
  // says the target is written as a `semantic_purpose`, and the commit resolves it to an element id
  // where it writes the edge, because every other reference in the graph is an id. A step of the
  // model reads the *recorded* step, which still carries the purpose, so the same resolution happens
  // here — a document whose steps name their element by id and whose effects name theirs by purpose
  // is a document with two vocabularies in it, and P4 refuses the second one. A purpose that resolves
  // to no element this run declared is left alone rather than guessed at, and P4 reports it.
  const elementIdByPurpose = new Map();
  // The reverse index, for the contract: a behaviour's parameter is sensitive when a step fed it into a
  // field the page declines to read back, and the only link the document states between an element and
  // an input is the element's semantic purpose.
  const purposeOfElement = new Map();
  for (const state of states) {
    for (const element of rows(state.elements)) {
      const purpose = element.semantic?.purpose;
      if (typeof purpose !== 'string' || !isElementId(element.id)) continue;
      elementIdByPurpose.set(purpose, element.id);
      purposeOfElement.set(element.id, purpose);
    }
  }
  const resolveEffectTargets = (steps) => steps.map((step) => {
    if (!rows(step.effects).length) return step;
    return {
      ...step,
      effects: rows(step.effects).map((effect) => (
        ELEMENT_TARGET_EFFECTS.has(effect.type) && !isElementId(effect.target) && elementIdByPurpose.has(effect.target)
          ? { ...effect, target: elementIdByPurpose.get(effect.target) }
          : effect
      )),
    };
  });
  const behaviorIdOf = (capability) => behaviorIdFor(slugify(capability?.name ?? capability?.id ?? ''));
  const behaviors = capabilities
    .filter((capability) => !ownerOf.has(capability.id ?? capability.capability_id))
    .map((capability) => {
      const name = slugify(capability.name ?? capability.id ?? '');
      if (name !== capability.name) {
        notes.push(`${capability.id}: name "${capability.name}" is not a behaviour-name slug and was carried as "${name}".`);
      }
      const edges = edgesFor(capability);
      const steps = resolveEffectTargets(stepsOfCapability(capability, notes));
      // D14: `realization[]` is how a behaviour is performed, `composed_of` is what it is made of,
      // and a behaviour with both has two answers to one question. A realized behaviour's members
      // *are* its steps, so the composition is dropped with the demotion (D13); a behaviour with no
      // recorded realization keeps its composition, because that is the only answer it has.
      const composed = steps.length ? [] : rows(capability.composed_of).map((member) => (
        capabilityById.has(member) ? behaviorIdFor(capabilityById.get(member).name) : member
      ));
      // P0-1, the other half of D14: `kind: "composite"` is a claim about how the behaviour is
      // *defined*, and the schema gives the word exactly one meaning — "'composite' means the
      // behaviour is defined only by composed_of". A behaviour this run realized has steps instead:
      // the composition was the pre-pivot spelling of those very steps (D12 reads `realization[]`
      // straight out of 0.1's `capability.steps`), and it is dropped one line above. Copying the
      // word would leave a behaviour that declares itself defined only by a `composed_of` it does
      // not carry — a document contradicting the schema's own definition of the value it wrote. The
      // declared kind stands whenever the realization does not contradict it; where it does, the
      // document states no kind, and the schema's default ("interaction") is what is in force. A
      // composite the walk never realized keeps the word: that one *is* defined only by composed_of.
      const kind = BEHAVIOR_KINDS.has(capability.kind) && !(steps.length && capability.kind === 'composite')
        ? capability.kind
        : undefined;
      const actor = singleVariant([
        ...edges.map((edge) => variantOfState(edge.from_state)),
        ...composed.flatMap((member) => (edgesByCapability.get(memberIdOf(member, capabilityById)) ?? [])
          .map((edge) => variantOfState(edge.from_state))),
      ]);
      // P9: a realized behaviour is anchored by the evidence of the calls its steps performed. The
      // capability's own `evidence[]` is empty — the commit collects evidence per edge — so without
      // this a behaviour whose members were just demoted would carry no evidence and no walkable
      // member, which is exactly the shape `behavior_without_evidence` refuses.
      const evidence = steps.length
        ? dedupeRefs(edges.flatMap((edge) => rows(edge.evidence)), (ref) => `${ref.observation ?? ''}|${ref.role ?? ''}`)
        : rows(capability.evidence);
      const id = behaviorIdFor(name);
      // The declared inputs, whether they came from the run's `steps[]` (0.1's spelling of a
      // realization) or from the capability's own `input` map: a behaviour with no realization has no
      // steps to read them from, and a behaviour whose realization exists has both.
      const declaredInput = steps.length ? inputOf(capability) : capability.input;
      const contract = contractOf({ behavior: id, edges, steps, input: declaredInput, purposeOfElement, notes, dedupeRefs, levelOfObservation });
      return prune({
        id,
        name,
        description: capability.description,
        kind,
        actor,
        input: declaredInput,
        output: capability.output,
        contract,
        // The recorded steps, when the run recorded any: they are what the behaviour is, and the
        // `steps[]` a 0.1 capability carries is the same claim in the older spelling.
        realization: steps,
        composed_of: composed,
        aliases: rows(capability.aliases),
        evidence,
        metadata: capability.metadata,
      });
    });

  // What the contracts do *not* cover, said once rather than left to be noticed.
  //
  // A contract derived from evidence can only ever describe the paths the walk took, and the review's
  // second P0 asked for failure outcomes because that is exactly the part it cannot reach: nothing in
  // the run shows what an invalid credential does, and an outcome invented from what is plausible
  // would sit in the contract looking precisely like the one that was watched. So the honest report is
  // the count of outcomes each behaviour has and what that count means, in one line, rather than a
  // fabricated refusal path that a test would then assert. This is also the sentence a reader needs in
  // order to know how to *fix* it: exercise the path and the contract grows on its own.
  const successOnly = behaviors.filter((behavior) => behavior.contract?.outcomes?.length === 1).map((behavior) => behavior.id);
  if (successOnly.length) {
    notes.push(`${successOnly.length} behaviour(s) carry exactly one outcome, the state the walk's success path reached (${successOnly.join(', ')}). A refusal path — an invalid credential, a rejected field — is an outcome no reading of this run saw, and none is stated: an outcome supplied from what is plausible is indistinguishable in a contract from one that was watched, which is the whole point of D9. Read these contracts as the path the run exercised, and exercise the others to grow them.`);
  }
  // What a turn is called in prose. A collapsed edge is named after the behaviour it became (P0-1),
  // and an edge that was never collapsed may carry no name at all — so the behaviour's own name is
  // the second answer, and the transition id the last, because a sentence that names a behaviour by
  // its id is a sentence no reader can use.
  const behaviorNameById = new Map(behaviors.map((behavior) => [behavior.id, behavior.name]));

  // --- affordances: declared controls on a surface that no committed step used -----------------
  // Read off the walk's own calls, not the collapsed edges: the question is which declared controls
  // the walk *used*, and a control used by a call that a behaviour's move absorbed was used.
  //
  // And marked used on the surfaces that *declare* the control, not on the state the call was
  // recorded from. Which page a control belongs to is a fact about the state; which state the walk
  // stood in when a call was written is a fact about the walk, and a call made right after a
  // navigation the walk did not record a call for is attributed to the page it started on. Reading
  // `from_state` would report a control the walk used as an offer nobody took, on the very page it
  // was used on — a finding the evidence refutes, which is the one thing a profile must never say.
  const surfacesOfElementId = new Map();
  for (const state of states) {
    for (const element of rows(state.elements)) {
      if (!isElementId(element.id)) continue;
      surfacesOfElementId.set(element.id, distinct([...(surfacesOfElementId.get(element.id) ?? []), state.id]));
    }
  }
  const actedOn = new Map();
  for (const edge of transitions) {
    const touched = distinct([
      edge.action?.target,
      ...rows(edge.effects)
        .filter((effect) => ELEMENT_TARGET_EFFECTS.has(effect.type))
        .map((effect) => effect.target),
    ].filter(isElementId));
    for (const element of touched) {
      for (const surface of surfacesOfElementId.get(element) ?? distinct([edge.from_state])) {
        actedOn.set(surface, new Set([...(actedOn.get(surface) ?? []), element]));
      }
    }
  }

  // A call made by a demoted step capability is performed *by* the behaviour that owns it, so the
  // edge names the behaviour and not the step: `login` is what the walk did, and
  // `fill_login_email` was how.
  const behaviorOfEdge = (edge) => {
    const owner = ownerOfCall(edge);
    return owner ? behaviorIdOf(owner) : undefined;
  };

  // --- transitions: one edge per move a behaviour performs (D5) --------------------------------
  // Built before the states, because `state.outgoing_transitions` is an index *of these*.
  const projectedTransitions = survivors.map((edge) => {
    const capability = capabilityById.get(edge.action?.capability);
    if (!capability) {
      notes.push(`${edge.id}: names capability "${edge.action?.capability}", which is not declared; the edge was carried without a behaviour.`);
    }
    if (edge.action?.target !== undefined && !isElementId(edge.action.target)) {
      notes.push(`${edge.id}: action.target "${edge.action.target}" is not an element id and was dropped; 0.2's transition.target is an element reference.`);
    }
    return prune({
      id: edge.id,
      name: edge.name,
      description: edge.description,
      from_state: edge.from_state,
      to_state: edge.to_state,
      behavior: behaviorOfEdge(edge),
      arguments: edge.action?.arguments,
      target: isElementId(edge.action?.target) ? edge.action.target : undefined,
      guard: typeof edge.guard === 'string' ? edge.guard : undefined,
      effects: rows(edge.effects),
      apis: rows(edge.apis),
      evidence: rows(edge.evidence),
      metadata: edge.metadata,
    });
  });
  // The projected edge of a walk step, keyed by the id the walk names — the edge the document ends up
  // carrying rather than the record it came from, which is what prose about a turn must be written
  // from: a reader is told about the edge that is there.
  const projectedById = new Map(projectedTransitions.map((transition) => [transition.id, transition]));

  // --- states, after the transitions -----------------------------------------------------------------
  //
  // `state.capabilities` is 0.1's inverse view and 0.2 renamed it `behaviors` (D2), so the key is
  // translated rather than copied: the ids are looked up, and an id no capability declares is
  // dropped with a note rather than carried as a behaviour that does not exist.
  //
  // `outgoing_transitions` is the same kind of thing one level down, and this is where the review's
  // first P0 came from. The graph keeps it as stored data — `commit.js` builds it from the edges it
  // committed — and the model inherited it through the object spread above, so the reviewer's
  // `application-model.json` had a state whose `outgoing_transitions` named
  // `transition_fill_email_input`, `transition_fill_password_input` and `transition_submit_login`
  // while the document's own `transitions[]` held only the last of them. Nothing was broken in the
  // graph: its `transitions[]` is the uncollapsed set, and every one of the three resolved. The
  // reference rotted *in the projection*, because `survivors` — the collapsed edge set D12 writes
  // into `transitions[]` — is not the set the graph derived the index from. Two levels of the same
  // document then disagreed about what an edge is, and both were schema-valid, because no schema can
  // check that a reference resolves. So the index is not carried any more: it is derived from
  // `transitions[]` after `transitions[]` exists, which is the one ordering in which it cannot go
  // stale, and the ids it dropped are named in `warnings[]` rather than disappearing quietly.
  const projectedStates = states.map((state) => {
    const { capabilities: offered = [], outgoing_transitions: declared, ...rest } = state;
    const fromDocument = rows(offered).map((id) => {
      const capability = capabilityById.get(id);
      if (!capability) {
        notes.push(`${state.id}: capabilities[] names "${id}", which no committed capability declares; the behaviour reference was dropped.`);
        return null;
      }
      // An offered step capability is offered as the behaviour that performs it, because the step
      // is not a behaviour any more (D13).
      return behaviorIdOf(ownerOf.get(id) ?? capability);
    });
    const outgoing = projectedTransitions
      .filter((transition) => transition.from_state === state.id)
      .map((transition) => transition.id);
    const unresolved = rows(declared).filter((id) => !projectedById.has(id));
    if (unresolved.length) {
      notes.push(`${state.id}: outgoing_transitions named ${unresolved.join(', ')}, which this document's transitions[] does not contain — the calls those edges were made of are one move now (D5/D12), and the index was recomputed from the transitions the model carries instead of copied from the graph's uncollapsed set.`);
    }
    return {
      ...prune(rest),
      // The inverse view of `transitions[].from_state`, plus what 0.1 already recorded as offered.
      behaviors: distinct([
        ...survivors.filter((edge) => edge.from_state === state.id).map(behaviorOfEdge),
        ...fromDocument,
      ]),
      ...(outgoing.length ? { outgoing_transitions: outgoing } : {}),
      affordances: affordancesOf(state, actedOn.get(state.id) ?? new Set(), state.affordances),
    };
  });

  // --- journeys: the walk the commit reassembled, with an actor the document declares ----------
  //
  // D4's fallback, and the reason it is here rather than only in the commit: a document with edges
  // and no walk is a document P12 has nothing to check (its `no_journey` finding is an *error*, so
  // the model would be blocked by a fact about the run rather than about the model). The fallback is
  // the run's own walk — `transitions[]` in the order they were taken, which is the order the run
  // records them in — with `goal_stated: false`, because nobody asked for it. No priority is judged
  // either, so `criticality` is omitted and the schema default applies: a fallback that guessed a
  // priority would be the projection making the one judgement this module never makes.
  //
  // A journey the commit reassembled always exists when there is an edge, so this is reached only
  // by a caller who handed the projection a graph of its own (the baseline profiler does) — which
  // is exactly the case D4 is written for: the profiler must be able to say something about a walk
  // it was given, not only about one the commit built.
  const walkedJourneys = journeys.length || !projectedTransitions.length ? journeys : [{
    id: 'journey_derived_walk',
    name: `Derived walk: ${projectedTransitions[0].from_state} to ${projectedTransitions[projectedTransitions.length - 1].to_state} (${projectedTransitions.length} step(s))`,
    goal_stated: false,
    start_state: projectedTransitions[0].from_state,
    transitions: projectedTransitions.map((transition) => transition.id),
    metadata: {
      status: 'inferred',
      confidence: 0.5,
      producer: 'importer:dsh-graph-explorer',
      extra: {
        derived: 'D4: the document carried no journey, so the order of `transitions[]` — the order the run took them — is used as the walk',
        goal_stated: false,
        criticality: 'not set: no priority was judged, so the schema default (standard) applies',
        ...(typeof run?.instruction === 'string' && run.instruction ? { run_instruction: run.instruction } : {}),
      },
    },
  }];
  const projectedJourneys = walkedJourneys.map((journey, index) => {
    // The walk's per-call ids are remapped onto the edges that carry them, so a journey names the
    // behaviour it walked. Two calls of one behaviour between the same two states are one edge
    // walked twice, and the journey names it twice (D5/D12) — but the calls of *one* invocation are
    // one move, so they become one turn however many of them there were, and the turn they become
    // is placed where the invocation began. Keeping the first call of each invocation as it is
    // encountered also keeps the walk order the log wrote, which is the one thing a journey is for.
    const steps = [];
    const namedInvocation = new Set();
    for (const step of journeySteps(journey, transitionById)) {
      const invocation = invocationOf.get(step.transition);
      if (invocation !== undefined) {
        if (namedInvocation.has(invocation)) continue;
        namedInvocation.add(invocation);
      }
      // A step's `arguments` are the arguments of the edge the step names, because a turn is a turn of
      // that edge and the document must not have the turn saying one thing about an edge while the
      // edge says another. An absorbed call names the edge that carries it, so its own values are not
      // the turn's: the values the walk supplied are on the behaviour's `realization[]` (where the
      // generator reads them), and a call's `arguments` kept here would put a value on the turn's edge
      // that the edge does not carry. Not hypothetical — `P5` refuses an edge carrying an argument no
      // effect of that edge reports, and the correction the protocol offers for it removes the
      // argument from the edge, so keeping the opening call's would leave the model still claiming it
      // on the very edge the correction was made about.
      const carried = absorbed.get(step.transition);
      steps.push(carried === undefined
        ? step
        : prune({ transition: carried, arguments: transitionById.get(carried)?.action?.arguments }));
    }
    const startState = journey.start_state ?? steps[0]?.from_state ?? null;
    // P1: a role is a declaration, and an authentication state is not one. `state.identity.variant` is
    // the run's own word for the *surface* — "authenticated", "anonymous" are the schema's own examples
    // of it, alongside "mobile" and "ab_test_b", which are nobody's role — and `journey.actor` means
    // "role the journey is exercised as". So the variant is handed over only where the application
    // declares that id as an actor: then the run shows which surface the role was exercised on, and the
    // declaration says that id is a role. Where it does not, the journey claims no actor and P6 reports
    // the gap — a field that has to mean a role may not be filled with the nearest word available, which
    // is what made the 0b model describe a walk that ends signed in as "walked as anonymous".
    const startVariant = startState ? variantOfState(startState) : null;
    const actor = startVariant && declaredIds.has(startVariant) ? startVariant : null;
    const endState = [...steps].reverse().map((step) => transitionById.get(step.transition)?.to_state)[0] ?? null;
    const endVariant = endState ? variantOfState(endState) : null;
    if (actor && endVariant && actor !== endVariant) {
      notes.push(`${journey.id}: the walk starts as "${actor}" and ends as "${endVariant}"; the journey's actor is the starting variant, and the walk is the transition between them.`);
    }
    if (!actor && startVariant) {
      notes.push(`${journey.id}: the walk's surfaces are read as variant "${startVariant}", which is an authentication state and not a role, and application.actors[] declares no actor with that id; the journey claims no actor (P6).`);
    }
    // P1: the narrative a journey may carry. Its two sentences are usually the run's own words — the
    // commit quotes the instruction as the goal because nothing else in the run states intent, and it
    // derives the name from that goal — and the schema forbids exactly one thing about them: a goal is
    // never the raw instruction when the instruction carried a credential. `goalOf` is where that is
    // decided, and where the sentence that replaces one is derived from the walk itself.
    const turns = steps.map((step) => {
      const edge = projectedById.get(step.transition) ?? {};
      return {
        name: edge.name ?? behaviorNameById.get(edge.behavior) ?? step.transition,
        from_state: edge.from_state ?? null,
        to_state: edge.to_state ?? null,
      };
    });
    const narrative = goalOf({ journey, turns, supplied });
    const nameRepeats = repeatedIn(journey.name, supplied);
    // The derivation note the graph wrote describes the graph's walk, and a journey that comes from the
    // graph carries it verbatim — three transitions, `distinct_transitions: 3` — into a document whose
    // `steps[]` holds one turn, because the collapse (D5/D12) happens here and not there. The reviewer
    // read exactly that: "the journey's derivation metadata still lists all three original transitions,
    // while the committed journey has one step referencing the collapsed login transition". So the
    // derivation is recomputed from the turns *this* document carries. Metadata describing a different
    // document is worse than no metadata: it is a provenance claim that fails the first time anyone
    // follows it, and the reader who follows it is the one checking the document's own integrity.
    const inheritedSteps = rows(journey.metadata?.extra?.steps);
    const derivation = {
      derivation: 'the model\'s own transitions in walk order, one turn per behaviour invocation: the calls one behaviour performs are one move (D5/D12), so a turn names the edge the invocation moved along and the calls it was made of are that behaviour\'s realization.',
      steps: steps.map((step) => prune({
        transition: step.transition,
        from_state: projectedById.get(step.transition)?.from_state ?? step.from_state ?? null,
        to_state: projectedById.get(step.transition)?.to_state ?? step.to_state ?? null,
      })),
      distinct_transitions: distinct(steps.map((step) => step.transition)).length,
    };
    if (inheritedSteps.length !== derivation.steps.length) {
      notes.push(`${journey.id}: the derivation note the graph carried listed ${inheritedSteps.length} transition(s), and this document's walk has ${derivation.steps.length}; the note was recomputed from the turns the model carries, because the calls of one behaviour are one move here.`);
    }
    const narrativeExtra = {
      ...derivation,
      // The instruction is the run's own account of what it was asked to do, and the model carries it
      // as evidence of intent rather than as the journey's goal (`goalOf` above decides that). It is
      // put through the mask on the way in: a value the walk supplied into a field is recorded where a
      // machine reads it — the edge's `arguments`, the behaviour's `realization[].value` — and a
      // sentence is not the place for it. The recorder has already done this once (`redaction.js`), and
      // doing it again here is not redundancy: it is the difference between the run *having* redacted
      // the record and the model *publishing* only the redacted form, which is the only one of the two
      // this document can be held to.
      ...(typeof journey.metadata?.extra?.run_instruction === 'string'
        ? { run_instruction: redactProse(journey.metadata.extra.run_instruction, supplied) }
        : {}),
      ...(narrative.goal_source ? { goal_stated: false, goal_source: narrative.goal_source } : {}),
      // A name is a handle for a walk and a goal is a sentence about it, so a name is *less* likely to
      // quote an account than a goal is — but the commit derives the name from the goal, and a name
      // that repeats one is the same defect in a shorter field. The keys are the graph's own
      // (`name_from`, `name_source_kind`, `name_stated`), corrected rather than supplemented, because
      // a document that disagrees with itself about its own provenance is worse than either answer.
      ...(nameRepeats.length
        ? {
          name_from: 'the endpoints of the walk: the name the run\'s instruction produced this walk repeated a value the walk supplied into a field, so it could not be carried',
          name_source_kind: 'endpoints',
          name_stated: false,
        }
        : {}),
    };
    if (narrative.goal_source) notes.push(`${journey.id}: ${narrative.goal_source}`);
    if (nameRepeats.length) {
      notes.push(`${journey.id}: the walk's name repeats a value the walk supplied, so the name is derived from the walk instead of quoted from the run's instruction.`);
    }
    const metadata = prune({ ...journey.metadata, extra: { ...(journey.metadata?.extra ?? {}), ...narrativeExtra } });
    return prune({
      id: journey.id ?? `journey_${index + 1}`,
      name: nameRepeats.length ? `Derived walk: ${startState ?? 'no surface'} to ${endState ?? 'no surface'} (${steps.length} step(s))` : journey.name,
      goal: narrative.goal,
      goal_stated: narrative.goal_stated,
      description: journey.description,
      actor,
      start_state: startState,
      steps,
      assertions: rows(journey.assertions),
      criticality: journey.criticality,
      evidence: rows(journey.evidence),
      metadata,
    });
  });

  if (!capabilities.length) {
    notes.push('No capability was committed, so the model has no behaviour and P11/P12 have nothing to walk.');
  }

  return prune({
    schema_version: ABM_SCHEMA_VERSION,
    generated_at: generatedAt ?? run?.started_at ?? null,
    generator: {
      name: 'dsh-graph-explorer',
      command: 'abm_projection',
      notes: 'Mechanical projection of a recorded run (phase 0b). It renames and copies; it does not name anything. Every derived object says so in metadata.extra.derived.',
    },
    application: application ? prune({
      id: application.id,
      name: application.name,
      base_url: application.base_url,
      description: application.description,
      actors,
      metadata: application.metadata,
    }) : undefined,
    entities: [],
    state_variables: [...variables.values()].map((variable) => prune({ ...variable, detection: variable.detection ?? undefined })),
    states: projectedStates,
    behaviors,
    transitions: projectedTransitions,
    apis: [],
    journeys: projectedJourneys,
    observations,
    coverage: coverage ?? undefined,
    warnings: [...warnings, ...notes],
  });
}

/** The behaviour id a `composed_of` entry from the projection's own list points back to. */
function memberIdOf(member, capabilityById) {
  for (const [id, capability] of capabilityById) {
    if (behaviorIdFor(capability.name) === member) return id;
  }
  return null;
}

const singleVariant = (values) => {
  const found = distinct(values);
  return found.length === 1 ? found[0] : undefined;
};

/**
 * The realisation steps a committed capability already carries.
 *
 * A 0.1 capability body has no steps (the commit puts them on the edge), so this is empty for
 * every run recorded so far — and that emptiness is the finding: a behaviour with no realization
 * is P2, and three of them is the baseline's headline. A step whose `action` is missing is not
 * carried, because the projection may not invent one; the loss is recorded instead, and P12 then
 * reports the committed transition that went missing.
 */
function stepsOfCapability(capability, notes) {
  const steps = [];
  for (const step of rows(capability.steps)) {
    if (typeof step?.action !== 'string') {
      notes.push(`${capability.id}: a step with no action was not carried (a realisation step needs one).`);
      continue;
    }
    // A `behaviorStep` has no `metadata` key — the schema closes it, and rightly: a step is a
    // position inside a behaviour, not a claim that can be trusted on its own, and a step that
    // claimed `verified` would outrank the behaviour it belongs to (D11). Nothing is lost by
    // leaving the level off, because the behaviour that performs the step carries the metadata and
    // the step's provenance is the record it was folded from.
    steps.push(prune({
      action: step.action,
      element: isElementId(step.element ?? step.target) ? step.element ?? step.target : undefined,
      value: step.value,
      purpose: step.purpose,
      arguments: step.arguments,
      effects: rows(step.effects),
      description: step.description,
      optional: step.optional,
      timeout_ms: step.timeout_ms,
    }));
  }
  return steps;
}

/**
 * The contract of a behaviour: what performing it means, derived from the walk that performed it.
 *
 * The review's second P0 was that `login` had actions and an outcome but no preconditions, no
 * postconditions and no failure outcomes — and it is worth being precise about what was missing,
 * because the answer is not "the walk forgot to write them down". There was no field. `graph_observe`
 * and `graph_transition` between them record a *surface*, an *action* and an *effect*, and a
 * behaviour's meaning was being read off the effects of the last step: the state arrived at is the
 * outcome, the state left is the precondition, and nothing anywhere in the protocol asked for either
 * as a claim about the behaviour rather than as a property of a move. The consequences are the ones
 * the review names. A generator can write a test that asserts the project list appeared — the one
 * thing the recording happens to contain — and cannot write one that asserts the authenticated user is
 * correct, because *correct as whom* was never stated; and a refusal path is invisible, because an
 * outcome the walk never reached leaves no effect to read.
 *
 * So this derives the contract from the evidence, which is the only thing a projection is allowed to
 * do (D13: it reports, it does not repair), and it is careful about the two ways that goes wrong:
 *
 *   - **An empty field is not a field with a guess in it.** A precondition is a state the walk
 *     actually performed the behaviour from, an outcome is a state a reading saw the application
 *     arrive at, a sensitive parameter is one a step fed into a field the page declined to read back.
 *     None of the four is inferred from what a behaviour of that name would normally need.
 *   - **A contract takes the level of its evidence.** An outcome's `status` is not a word the
 *     projection chooses; it is the minimum level among the readings that outcome cites (D11), so a
 *     behaviour whose steps were all rationalised rather than watched yields outcomes that say so.
 *     The earlier spelling of this derivation wrote `observed` unconditionally on the argument that an
 *     outcome names a state a reading was taken in — true, and beside the point: the field is a claim
 *     about the *evidence*, and a document can be full of readings taken by a tool whose producer this
 *     code does not recognise, which makes every one of them `modelled` (D9). A projection that wrote
 *     `observed` over those would be the exact defect the review's P0-2 names, produced by the tool
 *     that is supposed to be enforcing it.
 *   - **Absence has to be stated.** A contract derived this way only ever describes the paths the walk
 *     took, so the caller is told which behaviours carry a single outcome — the success path — rather
 *     than being left to notice. The review's rule is exact here: "The model should not silently turn
 *     a plausible failure path into an observed fact." Stating the one path is the other half of
 *     refusing to invent the second.
 *
 * `undefined` when there is nothing to say — a behaviour with no realization, no edge and no input
 * carries no contract, because an empty contract is a claim that the behaviour has no inputs and no
 * effects, and the truth is that this run did not say.
 */
function contractOf({ behavior, edges, steps, input, purposeOfElement, notes, dedupeRefs, levelOfObservation = () => null }) {
  const entries = Object.entries(input ?? {});
  // The words of every purpose a masked step acted on. A parameter is a binding a test resolves, and
  // the derivation is the recorder's own test read one level up: the *reading* says this field withheld
  // its value, the *step* says which control was fed, and the control's semantic purpose is the only
  // link between the two that the document states. It is a word match rather than a binding because a
  // literal was recorded (the walk typed a value and the mask replaced it) — where the walk wrote a
  // `{{param}}` template instead, the same purpose words match the same declared input, so both
  // spellings land on the same parameter.
  const maskedPurposes = new Set();
  const maskedWords = new Set();
  for (const step of steps) {
    if (step.value !== REDACTION) continue;
    const purpose = purposeOfElement.get(step.element);
    if (typeof purpose !== 'string' || !purpose) continue;
    maskedPurposes.add(purpose);
    for (const word of purpose.split(/[^A-Za-z0-9]+/)) {
      if (word) maskedWords.add(word.toLowerCase());
    }
  }
  const parameters = entries.map(([name, spec]) => prune({
    name,
    // Only the type travels: `input` is the declared map and already carries every other hint
    // (`format`, `enum`, `pattern`), and duplicating a declaration into two places in one document is
    // how they come to disagree. `argumentValueSpec` is closed, so a spec copied whole would be
    // refused by the schema the moment the walk declared anything it allowed and this def did not.
    type: typeof spec === 'string' ? { type: spec } : (typeof spec?.type === 'string' ? { type: spec.type } : undefined),
    sensitive: maskedWords.has(name.toLowerCase()) ? true : undefined,
  }));
  if (maskedPurposes.size && !parameters.some((parameter) => parameter.sensitive)) {
    notes.push(`${behavior}: a realization step supplied a value into a field the page declines to read back (${[...maskedPurposes].join(', ')}), and no declared input shares a word with that field's purpose, so no parameter is marked sensitive — a generator reading this contract will look for a literal, and there is none.`);
  }

  const fromStates = distinct(rows(edges).map((edge) => edge.from_state).filter(Boolean));
  const preconditions = fromStates.map((state) => ({
    kind: 'state',
    state,
    description: `the walk performed this behaviour from ${state}, so that surface is the precondition this run can vouch for. It is not a claim about everywhere the behaviour could be performed from — nothing in the run tried another surface — and a guessed precondition is exactly what this document may not carry.`,
  }));

  const evidenceByTo = new Map();
  for (const edge of rows(edges)) {
    if (!edge.to_state) continue;
    const list = evidenceByTo.get(edge.to_state) ?? [];
    for (const ref of rows(edge.evidence)) list.push(ref);
    evidenceByTo.set(edge.to_state, list);
  }
  const toStates = [...evidenceByTo.keys()];
  // The level of one state's outcome is the *weakest* level among the readings that support it, which
  // is D11's rule for any claim with inputs, applied to a contract instead of stated beside it. Two
  // consequences are the point rather than side effects. The first: a document whose readings arrived
  // without a producer this code recognises produces an outcome at `modelled`, which is weaker than
  // any of P17's complaints, so the projection cannot write a contract its own judgement rule would
  // reject. The second: nothing here is invented. The level is not a hedge the projection adds to be
  // safe — it is the level the evidence actually has, and where a walk was watched end to end it is
  // `observed`, exactly as before.
  const levelOfOutcome = (refs) => rows(refs)
    .map((ref) => levelOfObservation(ref?.observation))
    .filter(Boolean)
    .reduce((lowest, level) => (CLAIM_LEVELS.indexOf(level) < CLAIM_LEVELS.indexOf(lowest) ? level : lowest), CLAIM_LEVELS[0]);
  const levelByToState = new Map(toStates.map((state) => [state, levelOfOutcome(evidenceByTo.get(state))]));
  // A description and a status are two claims about one outcome, so the prose cannot say "observed"
  // over a status of `modelled`: the sentence a generator reads and the field it branches on would
  // disagree, and the field is the one that is right. Seeded at the weakest level, so an outcome whose
  // evidence list is empty — an edge that arrived carrying no reading at all — is described as what
  // this document says rather than as what a walk saw.
  const OUTCOME_PHRASES = {
    observed: 'was observed to leave',
    inferred: 'is stated, on the strength of reasoning readings, to leave',
    modelled: 'is stated by this document, with no reading behind it, to leave',
  };
  const outcomes = toStates.map((state) => prune({
    id: `outcome_${state}`,
    description: `performing this behaviour ${OUTCOME_PHRASES[levelByToState.get(state)]} the application at ${state}.`,
    to_state: state,
    status: levelByToState.get(state),
    evidence: dedupeRefs(evidenceByTo.get(state), (ref) => `${ref.observation ?? ''}|${ref.role ?? ''}`),
  }));
  // `postconditions` and `outcomes` are the same evidence stated two ways on purpose, and both are
  // needed: a postcondition is a fact that holds afterwards and has no state attached to it in the
  // schema (a variable can be a postcondition, which is how "the session is authenticated" would be
  // said), while an outcome is the end a test can navigate to. A behaviour with two ends shares neither.
  const postconditions = toStates.map((state) => ({
    kind: 'state',
    state,
    description: `reaching ${state} is what ${levelByToState.get(state) === 'observed' ? 'this behaviour was observed to do' : `this document states this behaviour does, at the level of ${levelByToState.get(state)}`}.`,
  }));

  if (!parameters.length && !preconditions.length && !outcomes.length) return undefined;
  return prune({ parameters, preconditions, postconditions, outcomes });
}

/**
 * How a test would read the dimension a state identity drew — or `null`, when nothing does.
 *
 * A dimension is the model's word for a difference the screen does not spell out ("the project list
 * is seeded"), so the only detector that *measures* it is one the run grounded: an entry that says
 * both which dimension it is about (`target`) and which surface a browser reads it on (`element` or
 * `route`), with the value it was read as. This function used to take any element the state's own
 * detection happened to mention and write the dimension's declared word into `expected`, which is
 * how a state whose only reading was "the sign-in button is absent" came to claim
 * `element_sign_in_button equals "seeded"`: an element-identity check wearing a dimension's name,
 * measuring nothing the variable claims and passing for the wrong reason. Two consequences, both of
 * them the review's §2: the document said a state was verified when nothing had verified it, and
 * P7's two surface rules could never fire, because the fabricator always produced a surface.
 *
 * Three outcomes, and the third is the point:
 *   - the state's own `detection` entry names this dimension and reads a surface → carried;
 *   - a committed step recorded the same reading (`recorded`: the count the commit attributed to
 *     the dimension, or the model's own assertion about it) → carried, because that is the check
 *     the walk watched pass;
 *   - neither → `null`. Nothing is invented. An absent detector is a *finding* — P7 reports
 *     `dimension_without_detection` and the commit will not write a model that claims a state
 *     variable it cannot check — where a fabricated one was a claim no reading could refute.
 */
function detectionFor(state, name, recorded = new Map()) {
  const named = rows(state.detection).find((entry) => entry?.target === name) ?? recorded.get(name) ?? null;
  if (!named || named.expected === undefined) return null;
  if (typeof named.operator !== 'string' || named.operator === '') return null;
  const element = isElementId(named.element) ? named.element : null;
  if (element) {
    return prune({ type: 'value', element, operator: named.operator, expected: named.expected });
  }
  const route = typeof named.route === 'string' && named.route !== '' ? named.route : null;
  if (route) {
    return prune({ type: 'route', route, operator: named.operator, expected: named.expected });
  }
  // The entry names the dimension and no surface reads it: a value assertion over a semantic path
  // or a storage key is a dimension-shaped claim nothing can evaluate, and carrying it would put a
  // check in the document that no generator could turn into a line of a test.
  return null;
}

/**
 * What a surface offers and the walk never took (D6/D15).
 *
 * Two claims, one name. The run may have *recorded* an affordance: the reading that declared a
 * control no step acted on names it (D15), and that claim is carried as recorded — but only where
 * the state's own readings declare the element, because an affordance is offered by a surface and a
 * claim about an element no reading saw is not about this state. What the run did not record is
 * derived: a declared control on this surface that no committed step touched. Both are `inferred`,
 * because both are read out of the reading rather than observed acting: the recorded one says which
 * record it came from, the derived one says which element it was read off.
 *
 * Only controls (`CONTROL_ROLES`) are derived, because a heading is not something a user can do.
 * `expected_behavior` is the element's own declared purpose: the projection has no name to offer and
 * will not invent one, and the confidence is 0.3 — the number §3 gives a claim nothing refuted.
 */
function affordancesOf(state, actedOn, recorded = []) {
  const evidence = rows(state.evidence);
  const elementIds = new Set(rows(state.elements).map((element) => element.id));
  const claimed = new Map();
  for (const entry of rows(recorded)) {
    const element = entry?.element ?? entry?.element_id ?? null;
    if (!isElementId(element) || !elementIds.has(element)) continue;
    claimed.set(element, prune({
      element,
      expected_behavior: typeof entry.expected_behavior === 'string' && entry.expected_behavior
        ? entry.expected_behavior
        : expectedBehaviorOf(rows(state.elements).find((each) => each.id === element) ?? {}),
      description: `Recorded as offered by this surface when it was read${
        entry.expected_behavior ? ` (${entry.expected_behavior})` : ''}.`,
      evidence: rows(entry.evidence).length ? rows(entry.evidence) : evidence,
      metadata: {
        confidence: 0.5,
        status: 'inferred',
        producer: 'importer:dsh-graph-explorer',
        extra: { derived: 'the affordances recorded on this reading' },
      },
    }));
  }
  return rows(state.elements)
    .filter((element) => CONTROL_ROLES.has(element.role) && !actedOn.has(element.id) && !claimed.has(element.id))
    .map((element) => prune({
      element: element.id,
      expected_behavior: expectedBehaviorOf(element),
      description: `Declared on this surface and not taken by the recorded walk${
        element.name ? ` (${element.role} "${element.name}")` : ''}.`,
      evidence: rows(element.evidence).length ? rows(element.evidence) : evidence,
      metadata: {
        confidence: 0.3,
        status: 'inferred',
        producer: 'importer:dsh-graph-explorer',
        extra: { derived: 'declared control with no committed step' },
      },
    }))
    .concat([...claimed.values()]);
}

const expectedBehaviorOf = (element) => {
  const purpose = element.semantic?.purpose;
  if (typeof purpose === 'string' && /^[a-z][a-z0-9_]*$/.test(purpose)) return purpose;
  return slugify(element.name ?? element.id ?? 'unnamed');
};

/** A journey's steps, in the order the walk took them, with the values the edge was walked with. */
function journeySteps(journey, transitionById) {
  // `journeyStep` is closed to `transition` and `arguments` (journey.schema.json: "anything a step
  // could restate about the edge ... already lives on the edge"), so a step's own prose and its
  // optionality are dropped here rather than written into a document the schema would refuse. Both
  // are on the edge the step names: `description` from the graph's transition, and `optional`
  // nowhere, because nothing in a recorded walk was optional.
  const declared = rows(journey.steps).filter((step) => typeof step?.transition === 'string');
  if (declared.length) {
    return declared.map((step) => prune({
      transition: step.transition,
      arguments: step.arguments,
    }));
  }
  return rows(journey.transitions)
    .filter((id) => typeof id === 'string')
    .map((id) => prune({ transition: id, arguments: transitionById.get(id)?.action?.arguments }));
}

/**
 * The behaviour model in the shape its generator reads, so that the model can be what a spec is
 * written from without a second generator existing.
 *
 * Phase 4's acceptance sentence is that *"a spec is generated with `graph.json` absent from the run
 * directory, and every action in the spec traces to a `realization[]` step"*. The generator's input
 * contract is the committed graph's shape — `states[].elements[]`, `transitions[].action.{target,
 * capability}`, `journeys[].transitions[]` — and the model is a projection of precisely those
 * things, so the honest way to meet that sentence is to present the model in the shape the one
 * generator already reads rather than to write a second renderer that would drift from the first.
 *
 * Three decisions, and each of them is a fact about the model rather than a convenience:
 *
 *   - **A turn becomes the calls it was made of.** A turn of a journey is a move (D5); a move is an
 *     invocation; and the calls an invocation was made of are the behaviour's own `realization[]`,
 *     which the document carries. So a turn *expands* into one transition per realization step,
 *     whose own `element` is the control that call acted on and whose own `effects` are the reading
 *     the capture made of it. That expansion is what makes the acceptance sentence true by
 *     construction: every action of the spec is one realization step, or there is no transition and
 *     no action. It is also the inverse of D5, and deliberately so — the model holds the move, the
 *     log held the calls, and a spec is a sequence of calls.
 *
 *   - **The value stays on the realization and is not copied into `arguments`.** A `realization`
 *     step's `value` is the spelling the protocol asks a walk for (a `value` on the step, or a
 *     `{{param}}` template); the graph's transition has `arguments` and no `value`, which is the
 *     lossy half of the pair. Copying the value across so the old reader would find it would invent
 *     an argument the walk never wrote, and it would hide the difference this adapter exists to be
 *     measured on. The transition therefore carries a `realization` reference and no synthesized
 *     `arguments`, and the generator prefers the realization (see `argumentFor` in `generate.js`).
 *
 *   - **Composition is not consulted.** A behaviour is *what it is* and its realization is *how it
 *     was performed*; the model keeps both, and the generator's composite checks exist for 0.1's
 *     `composed_of`, a document where composition doubled as execution. Presenting a model's
 *     behaviour as a composite would set those checks against `composed_of` entries that 0.2
 *     deliberately demoted to steps (`D13`), and they would fire on a walk that is perfectly
 *     described. So a behaviour is offered as an atomic capability: from a model, the realization
 *     is the account of how the move was performed, and there is nothing left for the composition
 *     to be checked against.
 *
 * The one thing the model cannot yet say, and does not pretend to here: `realization[]` is one list
 * per behaviour, so two invocations of one behaviour share it even when the log gave them different
 * values. A caller that needs to know cares about `metadata.extra.collapsed.invocations`, and
 * `generateTest` reports it rather than rendering a second walk's values as the first walk's.
 */
export function graphShapeOf(model) {
  const behaviorById = new Map(rows(model?.behaviors)
    .filter((behavior) => typeof behavior?.id === 'string')
    .map((behavior) => [behavior.id, behavior]));
  const callsOfEdge = new Map();
  const projected = [];
  for (const edge of rows(model?.transitions)) {
    if (typeof edge?.id !== 'string') continue;
    const realization = rows(behaviorById.get(edge.behavior)?.realization)
      .filter((step) => step && typeof step.action === 'string');
    if (!realization.length) {
      // A behaviour with no realization is a move nobody recorded the steps of. It is offered as one
      // call — the edge's own control, with no `realization` reference — and in the shape the
      // generator reads, because that is what makes the refusal a fact about the *model* rather than
      // about the shape it arrived in: the generator names `action_has_no_realization` for it, where
      // a document handed over untranslated would be read as a step with no element at all and
      // reported as `step_targets_no_element`.
      const { behavior, target, ...rest } = edge;
      callsOfEdge.set(edge.id, [edge.id]);
      projected.push(prune({ ...rest, action: prune({ capability: behavior, target }) }));
      continue;
    }
    // The collapsed edge names the calls it absorbed in walk order, and the realization is the same
    // calls in the same order, so the log's own ids are used as the expanded steps' ids when the
    // two lists are the same length. They are a *name* and not the provenance: the provenance is the
    // `realization` reference on each step, and a mismatch falls back to a synthesized id rather
    // than pairing a call with a step it may not be.
    const callIds = rows(edge.metadata?.extra?.collapsed?.calls);
    const ids = realization.map((step, index) => (
      callIds.length === realization.length && typeof callIds[index] === 'string'
        ? callIds[index]
        : `${edge.id}::${index + 1}`
    ));
    callsOfEdge.set(edge.id, ids);
    for (const [index, step] of realization.entries()) {
      const last = index === realization.length - 1;
      const element = typeof step.element === 'string' ? step.element : null;
      projected.push(prune({
        id: ids[index],
        description: last ? edge.description : undefined,
        // The move starts where the invocation started and lands where the behaviour's own edge
        // lands; the calls in between neither arrive anywhere nor leave, so a spec cannot be made to
        // assert an arrival in the middle of one move (§D5, and the same rule the collapse obeys).
        from_state: edge.from_state,
        to_state: last ? edge.to_state : edge.from_state,
        action: prune({
          // The behaviour is named once, on the call that ended the move, so a claim about the
          // behaviour is made once and the intermediate calls are what they are: calls.
          capability: last ? edge.behavior : undefined,
          target: element,
        }),
        effects: rows(step.effects),
        assertions: last ? rows(edge.assertions) : [],
        metadata: last ? edge.metadata : undefined,
        realization: prune({
          behavior: edge.behavior,
          action: step.action,
          element,
          value: step.value,
          purpose: step.purpose,
          index,
          of: edge.id,
        }),
      }));
    }
  }
  return {
    ...model,
    // The three keys whose shape differs, replaced rather than extended. `states` are carried as
    // they are: `elementsById` and `statesById` in the generator read `states[].elements[]` and
    // `states[].detection` off them, which the model's own surfaces already carry.
    capabilities: rows(model?.behaviors).map((behavior) => prune({
      id: behavior.id,
      name: behavior.name,
      kind: 'atomic',
      description: behavior.description,
    })),
    transitions: projected,
    journeys: rows(model?.journeys).map((journey) => prune({
      ...journey,
      transitions: rows(journey.steps)
        .map((step) => step?.transition)
        .filter((id) => typeof id === 'string')
        .flatMap((id) => callsOfEdge.get(id) ?? [id]),
    })),
    source: 'application-model.json',
  };
}

// ---------------------------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------------------------

/**
 * Every claim a document makes, each with the level it was obtained at (D9, D11).
 *
 * One list, so the rule and the *fix* the rule asks for read the same objects: writing
 * `LEVEL_CEILING[level]` onto each object's `metadata` is what an honest document says, and a rule
 * whose fix is that one line over this one walk is a rule an author can satisfy rather than a
 * refusal to describe anything.
 *
 * Deliberately absent: the surfaces' `elements[]` and the `observations[]` themselves. Those are
 * the capture — the thing the claims here are *checked against* — and the collector wrote them.
 * The claims a behaviour profile judges are the semantic ones: what a behaviour is called, what a
 * move was, what a surface is, what a distinction means, who a journey is for.
 */
export function claimsOf(model) {
  const behaviors = rows(model.behaviors);
  const behaviorById = new Map(behaviors.map((behavior) => [behavior.id, behavior]));

  // Memoised per id, and a cycle is `modelled` rather than a stack overflow: a composition that
  // contains itself is a derivation with no bottom, which is the weakest thing a claim can be.
  const levelOfBehavior = (id, seen = new Set()) => {
    if (seen.has(id)) return 'modelled';
    seen.add(id);
    const behavior = behaviorById.get(id);
    if (!behavior) return 'modelled';
    return claimLevel(behavior.metadata, rows(behavior.composed_of).map((member) => levelOfBehavior(member, seen)));
  };

  const claim = (scope, object, { subject, label, inputs = [], basis = [] } = {}) => ({
    scope,
    subject: subject ?? object?.id ?? object?.name ?? null,
    label: label ?? null,
    object,
    inputs,
    basis,
    // The level the object's own producer earned, and the weakest level among its inputs: kept
    // apart so P14 can say *which* of the two set the ceiling, since that is the difference
    // between "your reading is over-claimed" and "your composition inherited a weaker part".
    own: claimLevel(object?.metadata),
    parts: inputs.length ? inputs.reduce((lowest, level) => (CLAIM_LEVELS.indexOf(level) < CLAIM_LEVELS.indexOf(lowest) ? level : lowest)) : null,
    level: claimLevel(object?.metadata, inputs),
  });

  return [
    ...(model.application ? [claim('application', model.application)] : []),
    ...behaviors.map((behavior) => claim('behaviors', behavior, {
      label: `"${behavior.name}"`,
      inputs: rows(behavior.composed_of).map((member) => levelOfBehavior(member)),
      basis: rows(behavior.composed_of),
    })),
    ...behaviors.flatMap((behavior) => rows(behavior.realization).map((step, index) => claim('behaviors', step, {
      subject: behavior.id,
      label: `${behavior.name}'s realization[${index}]`,
    }))),
    ...rows(model.transitions).map((transition) => claim('transitions', transition)),
    ...rows(model.states).flatMap((state) => [
      claim('states', state),
      ...rows(state.affordances).map((affordance) => claim('states', affordance, {
        subject: state.id,
        label: `the affordance on ${affordance.element}`,
      })),
    ]),
    ...rows(model.journeys).map((journey) => claim('journeys', journey)),
    ...rows(model.state_variables).map((variable) => claim('state_variables', variable)),
    ...rows(model.entities).map((entity) => claim('entities', entity)),
    ...rows(model.apis).map((api) => claim('apis', api)),
  ];
}

/**
 * P1–P17 over a projected model.
 *
 * `candidates` is the second document P12 needs: the committed transitions and capabilities the
 * model has to account for. Without them P12 checks only the model's internal coherence and says
 * so, rather than reporting a walk-preservation failure it never looked for.
 */
export function profileFindings(model, { candidates = null } = {}) {
  const findings = [];
  const add = ({ rule, code, severity, scope, subject = null, detail }) => {
    const allowed = PROFILE_RULES[rule] ?? [];
    if (!allowed.includes(severity)) {
      throw new Error(`${rule} may not report "${severity}" (allowed: ${allowed.join(', ')}).`);
    }
    findings.push({ rule, code, severity, scope, subject, detail, basis: 'abm_profile' });
  };

  const behaviors = rows(model.behaviors);
  const transitions = rows(model.transitions);
  const states = rows(model.states);
  const journeys = rows(model.journeys);
  const variables = rows(model.state_variables);
  const observations = rows(model.observations);
  const actors = rows(model.application?.actors);
  const actorIds = new Set(actors.map((actor) => actor.id));
  const behaviorById = new Map(behaviors.map((behavior) => [behavior.id, behavior]));
  const behaviorIds = new Set(behaviorById.keys());
  const stateIds = new Set(states.map((state) => state.id));
  const transitionIds = new Set(transitions.map((transition) => transition.id));
  const transitionById = new Map(transitions.map((transition) => [transition.id, transition]));
  const observationIds = new Set(observations.map((observation) => observation.id));
  const surfacesOfElement = elementSurfaces(states);
  const vocabulary = surfaceVocabulary(states);

  const edgesByBehavior = new Map();
  for (const transition of transitions) {
    edgesByBehavior.set(transition.behavior, [...(edgesByBehavior.get(transition.behavior) ?? []), transition]);
  }

  // --- P1: a behaviour is named for the goal, not for the mechanism ----------------------------
  for (const behavior of behaviors) {
    const reason = mechanismName(behavior.name, vocabulary);
    if (reason) {
      add({
        rule: 'P1',
        code: 'behavior_name_is_a_mechanism',
        severity: 'error',
        scope: 'behaviors',
        subject: behavior.id,
        detail: `"${behavior.name}" ${reason}. A behaviour is named for what the user wants; a name built from the call that was made cannot be asked for, and cannot be reused.`,
      });
    }
  }

  // --- P2: a behaviour says how it is performed -------------------------------------------------
  for (const behavior of behaviors) {
    const realized = rows(behavior.realization).length > 0;
    const composed = rows(behavior.composed_of).length > 0;
    const excused = behavior.kind === 'navigation' || behavior.kind === 'query';
    if (!realized && !composed && !excused) {
      add({
        rule: 'P2',
        code: 'behavior_without_realization',
        severity: 'warning',
        scope: 'behaviors',
        subject: behavior.id,
        detail: `"${behavior.name}" has no realization[] step and no composed_of, so nothing in the document says how it is performed.`,
      });
    }
  }

  // --- P3: composed_of names behaviours, and they can be walked ---------------------------------
  for (const behavior of behaviors) {
    for (const member of rows(behavior.composed_of)) {
      const target = behaviorById.get(member);
      if (!target) {
        add({
          rule: 'P3',
          code: 'composed_of_is_not_a_behavior',
          severity: 'error',
          scope: 'behaviors',
          subject: behavior.id,
          detail: `composed_of names "${member}", which no behaviors[] entry declares. A composition is made of behaviours, not of mechanisms.`,
        });
        continue;
      }
      if (rows(edgesByBehavior.get(target.id)).length === 0 && rows(target.realization).length === 0) {
        add({
          rule: 'P3',
          code: 'composite_part_never_walked',
          severity: 'error',
          scope: 'behaviors',
          subject: behavior.id,
          detail: `composed_of names "${target.id}", which no committed step performs: it is neither the behaviour of a transition nor realised by steps of its own.`,
        });
      }
    }
  }

  // --- P4: every element a step or an effect names is a declared element id ---------------------
  // The surfaces a behaviour's steps may have been performed on: its own edges' origins, plus the
  // origins of the calls a collapsed edge absorbed. A behaviour is one move (D5), so the edge that
  // swallowed two calls starts where the invocation started — and the step performed in the middle of
  // it was performed on the surface that call started from, which is the second reason the collapse
  // names the calls it absorbed instead of only counting them.
  const committedById = new Map(rows(candidates?.transitions).map((call) => [call.id, call]));
  const surfacesOfBehavior = (behaviorId) => {
    const found = new Set();
    for (const edge of rows(edgesByBehavior.get(behaviorId))) {
      if (edge.from_state) found.add(edge.from_state);
      for (const id of rows(edge.metadata?.extra?.collapsed?.calls)) {
        const call = committedById.get(id);
        if (call?.from_state) found.add(call.from_state);
      }
    }
    return found;
  };
  const elementIds = new Set(surfacesOfElement.keys());
  const checkElement = (value, { rule, code, scope, subject, what }) => {
    if (value === undefined) return;
    if (!isElementId(value)) {
      add({ rule, code: `${code}_is_not_an_id`, severity: 'error', scope, subject, detail: `${what} is "${value}"; an element reference is an element id. A purpose is not an element.` });
      return;
    }
    if (!elementIds.has(value)) {
      add({ rule, code, severity: 'error', scope, subject, detail: `${what} is "${value}", which no state's elements[] declares. The reference resolves to nothing.` });
    }
  };

  for (const behavior of behaviors) {
    const surfaces = surfacesOfBehavior(behavior.id);
    for (const [index, step] of rows(behavior.realization).entries()) {
      checkElement(step.element, {
        rule: 'P4', code: 'realization_element', scope: 'behaviors', subject: behavior.id,
        what: `realization[${index}].element`,
      });
      if (isElementId(step.element) && elementIds.has(step.element) && surfaces.size) {
        const declaredOn = surfacesOfElement.get(step.element) ?? new Set();
        if (![...surfaces].some((state) => declaredOn.has(state))) {
          add({
            rule: 'P4',
            code: 'realization_element_not_on_the_surface',
            severity: 'error',
            scope: 'behaviors',
            subject: behavior.id,
            detail: `realization[${index}] acts on "${step.element}", which is not declared by any state this behaviour's transitions start from (${[...surfaces].join(', ') || 'none'}). A step is performed on a surface that has the element.`,
          });
        }
      }
      for (const effect of rows(step.effects)) {
        if (!ELEMENT_TARGET_EFFECTS.has(effect.type)) continue;
        checkElement(effect.target, {
          rule: 'P4', code: 'realization_effect_target', scope: 'behaviors', subject: behavior.id,
          what: `realization[${index}] ${effect.type}.target`,
        });
      }
    }
  }

  for (const transition of transitions) {
    for (const effect of rows(transition.effects)) {
      if (!ELEMENT_TARGET_EFFECTS.has(effect.type)) continue;
      checkElement(effect.target, {
        rule: 'P4', code: 'effect_target', scope: 'transitions', subject: transition.id,
        what: `${effect.type}.target`,
      });
    }
  }

  // --- P5: parameters bind, and concrete values were observed -----------------------------------
  for (const behavior of behaviors) {
    const inputs = new Set(Object.keys(behavior.input ?? {}));
    for (const [index, step] of rows(behavior.realization).entries()) {
      for (const param of [...placeholdersIn(step.value), ...placeholdersIn(step.arguments)]) {
        if (!inputs.has(param)) {
          add({
            rule: 'P5',
            code: 'unbound_parameter',
            severity: 'error',
            scope: 'behaviors',
            subject: behavior.id,
            detail: `realization[${index}] binds {{${param}}}, which is not a declared input of "${behavior.name}" (declared: ${[...inputs].join(', ') || 'none'}).`,
          });
        }
      }
    }
  }

  // P0-3: a journey step binds only what the behaviour it performs declares. `journeyStep` allows
  // `arguments` and states the rule for them in one line — "Keys must be the behaviour's declared
  // input names" — because the step is a *reference* to the behaviour: the walk supplies the values,
  // the behaviour owns the vocabulary. A key no `input` declares is the journey disagreeing with the
  // semantic model about how the behaviour is called, which is the second place to say it the schema
  // refused to create. It is checked here rather than left to the generator for the same reason P5
  // checks `{{param}}`: an unbound binding is a run that cannot start, discovered late.
  for (const journey of journeys) {
    for (const [index, step] of rows(journey.steps).entries()) {
      const keys = Object.keys(step.arguments ?? {});
      if (!keys.length) continue;
      const transition = transitionById.get(step.transition);
      const behavior = transition ? behaviorById.get(transition.behavior) : null;
      if (!behavior) continue; // no edge, or no behaviour: `journey_step_names_no_transition` / P3
      const inputs = new Set(Object.keys(behavior.input ?? {}));
      for (const key of keys) {
        if (inputs.has(key)) continue;
        add({
          rule: 'P5', code: 'journey_step_argument_not_declared', severity: 'error', scope: 'journeys', subject: journey.id,
          detail: `steps[${index}] binds "${key}", which is not a declared input of "${behavior.name}" (declared: ${[...inputs].join(', ') || 'none'}). A step names the behaviour it performs and the values the walk has for it; the names are the behaviour's.`,
        });
      }
    }
  }

  const observationArguments = new Set();
  for (const observation of observations) {
    for (const value of Object.values(observation.action?.arguments ?? {})) {
      if (typeof value === 'string') observationArguments.add(value);
    }
  }

  for (const transition of transitions) {
    const observed = new Set([
      ...rows(transition.effects).flatMap((effect) => [effect.to, effect.value]).filter((value) => typeof value === 'string'),
      ...observationArguments,
    ]);
    for (const [key, value] of Object.entries(transition.arguments ?? {})) {
      if (typeof value !== 'string' || isPlaceholder(value) || value === REDACTION) continue;
      if (!observed.has(value)) {
        add({
          rule: 'P5',
          code: 'unobserved_argument',
          severity: 'error',
          scope: 'transitions',
          subject: transition.id,
          detail: `arguments.${key} = "${value}" is not a value any effect or observation of this edge reports. A value the model typed is not a value the run observed; a field that was set and never read back is recorded as "${REDACTION}".`,
        });
      }
    }
  }

  // --- P6: actors are declared, and traceable ---------------------------------------------------
  const variants = new Set(states.map((state) => state.identity?.variant).filter(Boolean));
  const variantByState = new Map(states.map((state) => [state.id, state.identity?.variant]));
  if (!actorIds.size) {
    add({
      rule: 'P6', code: 'no_actors_declared', severity: 'warning', scope: 'application', subject: null,
      detail: 'application.actors is empty. The schema requires at least one, so the document cannot be read at all.',
    });
  }
  for (const variant of variants) {
    if (!actorIds.has(variant)) {
      add({
        rule: 'P6', code: 'undeclared_actor', severity: 'warning', scope: 'states', subject: null,
        detail: `A state is read as the surface variant "${variant}", which no application.actors[] entry declares. A variant names a surface and not a role, so this is not a broken reference — it is the declaration not saying which actor is on that surface.`,
      });
    }
  }
  for (const journey of journeys) {
    if (!journey.actor) {
      const startVariant = variantByState.get(journey.start_state);
      add({
        rule: 'P6', code: 'journey_actor_missing', severity: 'warning', scope: 'journeys', subject: journey.id,
        detail: 'The journey names no actor, so nothing says who it is for.'
          + (startVariant
            ? ` Its first surface is read as variant "${startVariant}", which is where the run's word for who is looking at it stops: a variant is not a role, and application.actors[] declares no actor with that id. A role is a declaration, because no page shows that "authenticated" is something somebody can sign in as.`
            : ''),
      });
      continue;
    }
    if (!actorIds.has(journey.actor)) {
      add({
        rule: 'P6', code: 'undeclared_actor', severity: 'warning', scope: 'journeys', subject: journey.id,
        detail: `The journey is walked as "${journey.actor}", which no application.actors[] entry declares.`,
      });
    } else if (!variants.has(journey.actor)) {
      add({
        rule: 'P6', code: 'untraceable_actor', severity: 'warning', scope: 'journeys', subject: journey.id,
        detail: `The journey is walked as "${journey.actor}", which no state variant and no observation shows. A declared actor with no trace is a name, not a role.`,
      });
    }
  }

  // --- P7: a dimension is declared, and its detection reads a surface ---------------------------
  const declaredVariables = new Map(variables.map((variable) => [variable.name, variable]));
  for (const state of states) {
    for (const [name, value] of Object.entries(state.identity?.dimensions ?? {})) {
      const variable = declaredVariables.get(name);
      if (!variable) {
        add({
          rule: 'P7', code: 'undeclared_dimension', severity: 'error', scope: 'states', subject: state.id,
          detail: `identity.dimensions names "${name}", which no state_variables[] entry declares, so the distinction is drawn and never read.`,
        });
        continue;
      }
      if (!rows(variable.values).includes(value)) {
        add({
          rule: 'P7', code: 'dimension_value_undeclared', severity: 'error', scope: 'state_variables', subject: variable.name,
          detail: `"${variable.name}" is "${value}" on ${state.id}, which is not one of its declared values (${rows(variable.values).join(', ') || 'none'}).`,
        });
      }
    }
  }
  for (const variable of variables) {
    if (!variable.detection) {
      add({
        rule: 'P7', code: 'dimension_without_detection', severity: 'error', scope: 'state_variables', subject: variable.name,
        detail: `"${variable.name}" declares no detection, so no test can tell its values apart. A detection that measures a dimension reads it on a surface: {"type":"value","element":"<the element that shows it>","operator":"equals","expected":"<the value>"}, or the count of the collection it names ({"operator":"greater_than","expected":0} over the element that lists the rows). A distinction nothing can read at runtime is a description, not an identity.`,
      });
    } else if (!variable.detection.element && !variable.detection.route) {
      add({
        rule: 'P7', code: 'detection_reads_no_surface', severity: 'error', scope: 'state_variables', subject: variable.name,
        detail: `The detection of "${variable.name}" reads neither an element nor a route. A check over a storage key is a dimension-shaped claim nothing can evaluate.`,
      });
    } else if (variable.detection.element) {
      // The detector and the variable have to be about the same surface, which is the one thing the
      // document can be held to without a `target` on the detection: the element it reads must be
      // declared by a state whose own identity draws *this* dimension. The fabricated detector this
      // rule exists for read `element_sign_in_button` on a state whose only dimension was a project
      // count — an element-identity check attributed to a collection, which is a check that would
      // have passed on the login page. Reported, not repaired: the fix is either to read the
      // collection on the state that has it, or to stop calling the difference a dimension.
      const readers = new Set(rows(model.states)
        .filter((state) => rows(variable.dimension_of).includes(state.id))
        .flatMap((state) => rows(state.elements).map((element) => element.id)));
      if (readers.size && !readers.has(variable.detection.element)) {
        add({
          rule: 'P7', code: 'detection_reads_another_surface', severity: 'error', scope: 'state_variables', subject: variable.name,
          detail: `The detection of "${variable.name}" reads ${variable.detection.element}, which no state that draws the dimension declares (${[...readers].join(', ')}). The check and the variable would be about two different surfaces, which is a detector that passes for the wrong reason.`,
        });
      }
    }
  }

  // --- P8: a semantic path names a declared entity ----------------------------------------------
  const entityNames = new Set(rows(model.entities).map((entity) => entity.name));
  for (const transition of transitions) {
    for (const effect of rows(transition.effects)) {
      if (ELEMENT_TARGET_EFFECTS.has(effect.type) || effect.type === 'state_entered') continue;
      const target = effect.target;
      if (typeof target !== 'string' || target === '') continue;
      if (isStorageKey(target) || entityNames.has(target)) continue;
      add({
        rule: 'P8', code: 'entity_not_declared', severity: 'warning', scope: 'transitions', subject: transition.id,
        detail: `${effect.type}.target is "${target}", which is neither a declared entity nor local/session storage nor a cookie. A semantic path nothing declares is a name the commit invented.`,
      });
    }
  }

  // --- P9: the anti-hallucination rule ----------------------------------------------------------
  //
  // The one place the rule is read rather than copied. §3 says "every behaviour carries ≥1
  // evidence[] entry"; taken literally that refuses a composite, and a composite's evidence *is*
  // its parts' — `login` is `fill_email → fill_password → submit`, and the three edges carry the
  // readings. So a composition is anchored when every member it names is declared, carries
  // evidence, and is anchored itself. The teeth are unchanged where they matter: a behaviour with
  // no realization and no evidence is a vocabulary entry, and it is still refused.
  const anchored = new Map();
  const isAnchored = (behaviorId, seen = new Set()) => {
    if (anchored.has(behaviorId)) return anchored.get(behaviorId);
    if (seen.has(behaviorId)) return false;
    seen.add(behaviorId);
    const behavior = behaviorById.get(behaviorId);
    if (!behavior) return false;
    const members = rows(behavior.composed_of);
    const result = rows(behavior.evidence).length > 0
      || (members.length > 0 && members.every((member) => isAnchored(member, seen)));
    anchored.set(behaviorId, result);
    return result;
  };

  for (const behavior of behaviors) {
    if (isAnchored(behavior.id)) continue;
    const members = rows(behavior.composed_of);
    add({
      rule: 'P9', code: 'behavior_without_evidence', severity: 'error', scope: 'behaviors', subject: behavior.id,
      detail: members.length
        ? `"${behavior.name}" carries no evidence[] and neither do the members it is composed of (${members.join(', ')}). A behaviour nothing was observed doing is a vocabulary entry.`
        : `"${behavior.name}" carries no evidence[]. A behaviour nothing was observed doing is a vocabulary entry.`,
    });
  }
  for (const transition of transitions) {
    const roles = new Set(rows(transition.evidence).map((entry) => entry.role));
    for (const role of TRANSITION_EVIDENCE_ROLES) {
      if (roles.has(role)) continue;
      add({
        rule: 'P9', code: 'transition_missing_evidence_role', severity: 'error', scope: 'transitions', subject: transition.id,
        detail: `The edge carries no ${role} evidence. An edge is a claim about a move, and identity, action and effect are the three readings it is made of.`,
      });
    }
  }
  for (const [scope, owner, list] of [
    ...behaviors.map((behavior) => ['behaviors', behavior.id, rows(behavior.evidence)]),
    ...transitions.map((transition) => ['transitions', transition.id, rows(transition.evidence)]),
    ...journeys.map((journey) => ['journeys', journey.id, rows(journey.evidence)]),
  ]) {
    for (const entry of list) {
      if (entry?.observation === undefined) continue;
      if (observationIds.has(entry.observation)) continue;
      add({
        rule: 'P9', code: 'unresolved_evidence', severity: 'error', scope, subject: owner,
        detail: `Evidence names observation "${entry.observation}", which the document does not carry.`,
      });
    }
  }

  // §P1: a role-bearing reference has to say *what it is evidence for*, in words. A role says what
  // kind of reading it is — `identity` is the surface as it stood, `effect` is what the machinery saw
  // change — and cannot say which claim the reading is evidence for, so a document whose references
  // are bare roles is a document where every reading is attached to every claim with nothing to tell
  // them apart. That is the shape the 0b projection had: one journey carrying nine references and
  // nine identical notes, with nothing saying which step any of them documented.
  //
  // Two codes, one idea. `evidence_without_a_role` is a reference that does not say what kind of
  // reading it is — a bare observation id, which the schema does permit as shorthand;
  // `evidence_without_a_note` is a reference that does not say what it is evidence for. Both are
  // warnings and not errors: the short form is legal, and a document written by hand is not a
  // hallucination — it is a document a reader cannot follow, which is what the warning level is for.
  // Nothing this project writes can trip either, and that is the point of having them: `commit.js`
  // writes one note per reading (the session's own note, or one derived from the store's record),
  // so the rule's job is to keep a dropped note from being a silent regression.
  for (const [scope, owner, list] of [
    ...behaviors.map((behavior) => ['behaviors', behavior.id, rows(behavior.evidence)]),
    ...transitions.map((transition) => ['transitions', transition.id, rows(transition.evidence)]),
    ...journeys.map((journey) => ['journeys', journey.id, rows(journey.evidence)]),
    ...states.map((state) => ['states', state.id, rows(state.evidence)]),
    ...variables.map((variable) => ['state_variables', variable.name, rows(variable.evidence)]),
  ]) {
    for (const entry of list) {
      const short = typeof entry === 'string';
      const role = short || entry === null || typeof entry !== 'object' ? null : entry.role ?? null;
      const note = short || entry === null || typeof entry !== 'object'
        ? null
        : (typeof entry.note === 'string' && entry.note.trim() ? entry.note : null);
      if (!role) {
        add({
          rule: 'P9', code: 'evidence_without_a_role', severity: 'warning', scope, subject: owner,
          detail: `A reference on ${owner} does not say what kind of reading it is — ${short
            ? `it is the bare observation id ${JSON.stringify(entry)}`
            : 'it carries no role'}. A reader cannot tell whether the reading is the surface the step started from, the action itself, or what the step changed.`,
        });
      }
      if (!note) {
        add({
          rule: 'P9', code: 'evidence_without_a_note', severity: 'warning', scope, subject: owner,
          detail: `A reference on ${owner} does not say what it is evidence for (${role
            ? `role \`${role}\``
            : 'and it carries no role either'}, observation ${JSON.stringify(short ? entry : entry?.observation ?? null)}). The role says what kind of reading it is; the note is the one place a reader is told which claim the reading belongs to.`,
        });
      }
    }
  }

  // §P1's *persistence*, as a check on the fact rather than on the prose. A `storage_changed` effect
  // is a claim about what the application wrote down, and the reading is what evidences it: the
  // commit records what the reader saw change in `metadata.extra.recorder.observed_change.storage`,
  // keyed by storage key. An effect whose key is not in there is an effect nothing saw — which is the
  // shape a hallucinated "and it saved the session" takes, and the shape a state comparison cannot
  // catch, because nothing about the DOM changes when a token is written to `localStorage`.
  //
  // A warning, not an error: the effect can come from a document whose reading is carried somewhere
  // this projection does not read, and refusing the model over that would be this rule claiming to
  // know that nothing saw it. What the rule does say is that the document as it stands cannot show it.
  for (const transition of transitions) {
    const declared = rows(transition.effects)
      .filter((effect) => effect?.type === 'storage_changed' && typeof effect.target === 'string' && effect.target);
    if (!declared.length) continue;
    const recorded = transition.metadata?.extra?.recorder?.observed_change?.storage;
    const keys = recorded && typeof recorded === 'object' && !Array.isArray(recorded) ? Object.keys(recorded) : [];
    for (const effect of declared) {
      // The same reading `isStorageKey` reads, with the kind kept: the effect names the place and the
      // recorder's sample is keyed by the place alone (`localStorage.acme-demo-state` against
      // `acme-demo-state`), and both spellings are in the wild.
      const key = effect.target.replace(/^(localStorage|sessionStorage|cookie)[.:]/i, '');
      if (keys.some((recordedKey) => recordedKey === effect.target || recordedKey === key)) continue;
      add({
        rule: 'P9', code: 'persistence_effect_without_a_reading', severity: 'warning', scope: 'transitions', subject: transition.id,
        detail: `The edge declares a \`storage_changed\` effect on ${effect.target} and no reading shows it: this step's recorded change names ${keys.length ? keys.map((recordedKey) => JSON.stringify(recordedKey)).join(', ') : 'no storage key at all'}. What a session remembers is the one effect a comparison of two states cannot see, so it is the effect that most needs a reading behind it.`,
      });
    }
  }

  // --- P10: a critical journey is not backed by a guess -----------------------------------------
  for (const journey of journeys.filter((entry) => entry.criticality === 'critical')) {
    for (const step of rows(journey.steps)) {
      const transition = transitions.find((entry) => entry.id === step.transition);
      const behavior = transition ? behaviorById.get(transition.behavior) : null;
      for (const node of [transition, behavior, journey].filter(Boolean)) {
        const confidence = node.metadata?.confidence;
        const guessed = node.metadata?.status === 'inferred' || (typeof confidence === 'number' && confidence < 0.5);
        if (!guessed) continue;
        add({
          rule: 'P10', code: 'low_confidence_backs_critical_journey', severity: 'warning', scope: 'journeys', subject: journey.id,
          detail: `${node.id} is ${node.metadata?.status ?? 'unmarked'}${
            typeof confidence === 'number' ? ` at confidence ${confidence}` : ''
          }, and the journey is critical. A critical journey may not be backed by something the walk only guessed.`,
        });
      }
    }
  }

  // --- P11: a behaviour an edge can perform -----------------------------------------------------
  const walkable = new Map();
  const isWalkable = (behaviorId, seen = new Set()) => {
    if (walkable.has(behaviorId)) return walkable.get(behaviorId);
    if (seen.has(behaviorId)) return false;
    seen.add(behaviorId);
    const behavior = behaviorById.get(behaviorId);
    if (!behavior) return false;
    const members = rows(behavior.composed_of);
    const result = rows(edgesByBehavior.get(behaviorId)).length > 0
      || (members.length > 0 && members.every((member) => isWalkable(member, seen)));
    walkable.set(behaviorId, result);
    return result;
  };

  const performed = new Set([...behaviors.map((behavior) => behavior.id)].filter((id) => isWalkable(id)));
  const members = new Set([...performed].flatMap((id) => rows(behaviorById.get(id).composed_of)));
  for (const behavior of behaviors) {
    if (performed.has(behavior.id) || members.has(behavior.id)) continue;
    add({
      rule: 'P11', code: 'behavior_no_edge_can_perform', severity: 'warning', scope: 'behaviors', subject: behavior.id,
      detail: `"${behavior.name}" is the behaviour of no transition and a member of no walkable behaviour's composed_of, so nothing in the document can perform it.`,
    });
  }

  // --- P12: walk preservation, both directions (D1, D4, D5) --------------------------------------
  const committedTransitions = rows(candidates?.transitions);
  const committedCapabilities = rows(candidates?.capabilities);
  if (committedTransitions.length) {
    for (const committed of committedTransitions) {
      const capability = committedCapabilities.find((entry) => entry.id === committed.action?.capability) ?? null;
      const target = isElementId(committed.action?.target) ? committed.action.target : null;
      const carriedAsEdge = transitions.some((transition) => transition.id === committed.id);
      const carriedAsBehaviour = capability !== null && transitions.some((transition) => (
        transition.from_state === committed.from_state
        && transition.to_state === committed.to_state
        && behavioursOfCapability(capability, behaviors, committedCapabilities).has(transition.behavior)
      ));
      const carriedAsStep = target !== null && behaviors.some((behavior) => (
        rows(behavior.realization).some((step) => step.element === target)
        && rows(edgesByBehavior.get(behavior.id)).some((edge) => edge.from_state === committed.from_state)
      ));
      if (!carriedAsEdge && !carriedAsBehaviour && !carriedAsStep) {
        add({
          rule: 'P12', code: 'committed_transition_not_carried', severity: 'error', scope: 'transitions', subject: committed.id,
          detail: `${committed.from_state} → ${committed.to_state} was committed and nothing in the model accounts for it: no transition with that id, no edge of a behaviour whose capability is ${committed.action?.capability ?? 'unstated'}, and no realization step on ${target ?? 'its target'}. The collapse from calls to behaviours may not lose a call.`,
        });
      }
    }
  } else {
    add({
      rule: 'P12', code: 'coverage_unchecked', severity: 'info', scope: 'transitions', subject: null,
      detail: 'No committed transition log was supplied, so every committed call being carried could not be checked. Passing the candidates P12 compares against is what makes this a coverage claim.',
    });
  }

  // Only the log can say whether an edge was walked. With no log there is nothing to compare
  // against, and refusing every edge would turn a missing input into a document full of invented
  // moves — the coverage_unchecked note above is the honest report of that state.
  for (const transition of committedTransitions.length ? transitions : []) {
    const backed = committedTransitions.some((committed) => committed.id === transition.id
      || (committed.from_state === transition.from_state
        && committed.to_state === transition.to_state
        && behaviourBacksCapability(transition.behavior, committed.action?.capability, behaviorById, committedCapabilities)));
    if (!backed) {
      add({
        rule: 'P12', code: 'transition_not_backed_by_a_committed_step', severity: 'error', scope: 'transitions', subject: transition.id,
        detail: `The edge ${transition.from_state} → ${transition.to_state} (behaviour "${transition.behavior}") is backed by no committed transition. An edge nothing walked is an invented move.`,
      });
    }
  }

  // A collapse may not hide a state. An invocation whose steps passed through a state the edge does
  // not name has taken a reading at a place no transition of the document leads to, and that reading
  // is a fact: the projection writes down what it passed through rather than dropping it, and the
  // behaviour's own steps may account for it — a step whose effect entered that state is the model
  // saying the behaviour did arrive there. When neither says so, the move is refused (D12).
  //
  // "the edge does not name" is the whole of the rule, so the edge's own two endpoints are where it
  // stops. A call that stays where the walk already stood — a self-loop, which is what typing into a
  // form is — puts that state in `passed_through`, and that state is the surviving edge's
  // `from_state`. Demanding the behaviour "arrive" there asks for a `state_entered` that no honest
  // step can record: the walk never entered the state, it was already in it. The only way to satisfy
  // it would be a false effect, and a rule whose sole satisfaction is a lie is refused here rather
  // than obeyed — the live sign-in walk of 2026-09-18 is the case: three calls (fill, fill, click)
  // over two states, one behaviour, and a model withheld for a state the edge itself names.
  for (const transition of transitions) {
    const passed = rows(transition.metadata?.extra?.collapsed?.passed_through);
    if (!passed.length) continue;
    const behavior = behaviorById.get(transition.behavior);
    const explained = new Set(rows(behavior?.realization).flatMap((step) => rows(step.effects)
      .filter((effect) => effect?.type === 'state_entered' && typeof effect.to === 'string')
      .map((effect) => effect.to)));
    for (const state of passed) {
      if (state === transition.from_state || state === transition.to_state) continue;
      if (explained.has(state)) continue;
      add({
        rule: 'P12', code: 'collapsed_past_a_state', severity: 'error', scope: 'transitions', subject: transition.id,
        detail: `The edge ${transition.from_state} → ${transition.to_state} collapsed calls that went through ${state}, and no step of "${transition.behavior}" says it arrived there. A state the walk entered between the edge's own two states is a reading nothing in the document explains.`,
      });
    }
  }

  if (!journeys.length) {
    add({
      rule: 'P12', code: 'no_journey', severity: 'error', scope: 'journeys', subject: null,
      detail: 'The model carries no journey. A walk with no journey is a pile of edges: D4 requires every committed walk to survive the pivot as a journey.',
    });
  }
  for (const journey of journeys) {
    if (!rows(journey.steps).length) {
      add({
        rule: 'P12', code: 'journey_without_steps', severity: 'error', scope: 'journeys', subject: journey.id,
        detail: 'The journey has no steps, so it names no walk.',
      });
    }
    for (const [index, step] of rows(journey.steps).entries()) {
      if (transitionIds.has(step.transition)) continue;
      add({
        rule: 'P12', code: 'journey_step_names_no_transition', severity: 'error', scope: 'journeys', subject: journey.id,
        detail: `steps[${index}] names "${step.transition}", which no transitions[] entry declares. A step is a move the document can make.`,
      });
    }
    // P0-3: the walk has to be one walk. A journey is "an ordered walk over transitions"
    // (journey.schema.json), and a walk is a path: every turn begins where the turn before it
    // finished, and the first begins where the journey says it starts. Nothing else in the document
    // says this — the transitions are a set, and a step is "deliberately thin" precisely so the
    // order lives in one place — so a step that begins where the previous one did not end is a turn
    // of some *other* walk, and a reader (or the generator that expands these references into a
    // test) follows it out of the document. The shape that made this a rule: a journey naming one
    // edge three times. Three turns, each saying "walk this edge", while only the first of them
    // stood at the state that edge starts from — a walk that reads as a repetition the graph cannot
    // perform. The projection is where this is fixed (one invocation is one move, one turn), and
    // this is the gate that says so rather than trusting it.
    for (const [index, step] of rows(journey.steps).entries()) {
      const transition = transitionById.get(step.transition);
      if (!transition) continue; // the step's own missing-transition finding is above
      if (index === 0) {
        if (typeof journey.start_state !== 'string' || journey.start_state === transition.from_state) continue;
        add({
          rule: 'P12', code: 'journey_start_state_not_where_the_walk_starts', severity: 'error', scope: 'journeys', subject: journey.id,
          detail: `The journey starts at ${journey.start_state} and its first step walks ${transition.from_state} → ${transition.to_state}. A goal attached to a surface the walk never stood on is a journey that cannot be taken.`,
        });
        continue;
      }
      const previous = transitionById.get(rows(journey.steps)[index - 1].transition);
      if (!previous || previous.to_state === transition.from_state) continue;
      add({
        rule: 'P12', code: 'journey_step_does_not_continue_the_walk', severity: 'error', scope: 'journeys', subject: journey.id,
        detail: `steps[${index}] walks ${transition.from_state} → ${transition.to_state}, and steps[${index - 1}] ended at ${previous.to_state}. No move of this document leads from the one to the other, so the step is not a turn of this walk.`,
      });
    }
  }

  const seenMoves = new Map();
  for (const transition of transitions) {
    const key = `${transition.from_state}|${transition.behavior}|${transition.to_state}`;
    if (seenMoves.has(key)) {
      add({
        rule: 'P12', code: 'duplicate_transition', severity: 'error', scope: 'transitions', subject: transition.id,
        detail: `${transition.from_state} → ${transition.to_state} via "${transition.behavior}" is already ${seenMoves.get(key)}. One move is one edge (D5); two edges for one move are two claims about the same walk.`,
      });
      continue;
    }
    seenMoves.set(key, transition.id);
  }

  // --- P13: an affordance is offered, not performed ----------------------------------------------
  const walked = new Set();
  for (const behavior of behaviors) {
    for (const step of rows(behavior.realization)) if (isElementId(step.element)) walked.add(step.element);
  }
  for (const transition of transitions) {
    if (isElementId(transition.target)) walked.add(transition.target);
  }

  for (const state of states) {
    const declared = new Set(rows(state.elements).map((element) => element.id));
    for (const affordance of rows(state.affordances)) {
      if (!declared.has(affordance.element)) {
        add({
          rule: 'P13', code: 'affordance_element_not_on_surface', severity: 'error', scope: 'states', subject: state.id,
          detail: `affordances[] names "${affordance.element}", which this state's own elements[] does not declare. An affordance is offered by a surface; it is the one place the model states what it did not do, so it anchors to the capture or it says nothing.`,
        });
        continue;
      }
      if (walked.has(affordance.element)) {
        add({
          rule: 'P13', code: 'affordance_already_walked', severity: 'warning', scope: 'states', subject: state.id,
          detail: `affordances[] offers "${affordance.element}" as something nobody did, and a realized step performs it. The walk refutes the claim.`,
        });
      }
    }
  }

  // --- P14/P15: the epistemic levels (D9, D11) ---------------------------------------------------
  //
  // One `metadata` block covers several claims, and they are not the same claim: an edge's *move*
  // is something the collector watched, while its *name* is something a model read, and `verified`
  // describes the first while appearing to describe both. Measured on the 0.1.22 walk,
  // `cap_submit_login` reports `status: verified, confidence: 1` and its name `submit_login` is an
  // LLM's reading — nothing in the pipeline before this rule could say so. So D11 makes the level
  // the **minimum** over the claims an object carries: P14 refuses a status above that ceiling, and
  // P15 makes the honest alternative state its own basis, so the downgrade P14 asks for is a claim
  // somebody can still read rather than a shrug. Neither rule is a judgement about what a
  // behaviour *means*; both are about a document not asserting more than it was told.
  for (const claim of claimsOf(model)) {
    const metadata = claim.object?.metadata;
    const ceiling = LEVEL_CEILING[claim.level];
    const declared = typeof metadata?.status === 'string' ? metadata.status : 'draft';
    const confidence = typeof metadata?.confidence === 'number' ? metadata.confidence : null;
    const stated = [
      typeof metadata?.status === 'string' ? `status "${metadata.status}"` : 'no status',
      confidence === null ? null : `confidence ${confidence}`,
    ].filter(Boolean).join(' at ');
    const outranks = (STATUS_RANK[declared] ?? 0) > STATUS_RANK[ceiling.status]
      || (confidence !== null && confidence >= 1 && ceiling.status !== 'verified');
    // Weaker than the object's *own* reading: that is what makes the ceiling a composition's and
    // not the producer's, and it is also the list the author has to go and look at.
    const weaker = claim.inputs.filter((level) => CLAIM_LEVELS.indexOf(level) < CLAIM_LEVELS.indexOf(claim.own));

    if (outranks) {
      const producer = typeof metadata?.producer === 'string' ? metadata.producer : null;
      const code = claim.level === 'modelled' ? 'claim_has_no_producer'
        : weaker.length ? 'claim_outranks_its_inputs'
          : 'claim_outranks_its_producer';
      const why = code === 'claim_has_no_producer'
        ? `No metadata.producer says who claimed this, so it is a derivation: the document computed it, and a derivation may be at most "${ceiling.status}" at confidence ${ceiling.confidence}. This is the copy path, not a judgement about the object — anything that reads a document and writes one back is where a level gets promoted.`
        : code === 'claim_outranks_its_inputs'
          ? `It is derived from claims at ${weaker.join(', ')}, and a derived claim is the minimum of its inputs' levels (D11): it may be at most "${ceiling.status}". The parts are weaker than the whole.`
          : `metadata.producer is "${producer}", which read this out of the capture: a reading may be at most "${ceiling.status}" at confidence ${ceiling.confidence}. "verified" is the collector's status, and what the collector saw is the action — not the name.`;
      add({
        rule: 'P14', code, severity: 'error', scope: claim.scope, subject: claim.subject,
        detail: `${claim.label ?? claim.subject} is at level "${claim.level}" and is reported ${stated}. ${why}`,
      });
    }

    // P15 is the other half of D11: a document that must not assert `verified` about a reading has
    // to say *whose* reading it is and *what* it rests on, or the fix for P14 is to record less.
    if (declared === 'inferred') {
      const producer = typeof metadata?.producer === 'string' ? metadata.producer.trim() : '';
      const basis = distinct([
        ...rows(claim.object.evidence).map((entry) => entry?.observation),
        ...claim.basis,
        ...(typeof metadata?.extra?.derived === 'string' ? [metadata.extra.derived] : []),
      ]);
      if (!producer) {
        add({
          rule: 'P15', code: 'inference_without_producer', severity: 'error', scope: claim.scope, subject: claim.subject,
          detail: `${claim.label ?? claim.subject} is inferred and names no producer. An inference is somebody's reading, and a document that does not say whose cannot be argued with — nor can it be traced when the reading is wrong.`,
        });
      } else if (!basis.length) {
        add({
          rule: 'P15', code: 'inference_without_basis', severity: 'error', scope: claim.scope, subject: claim.subject,
          detail: `${claim.label ?? claim.subject} is inferred by "${producer}" from nothing: no evidence[], no composed_of, no named derivation. An inference with no basis is a hallucination, and it is reported as one rather than carried as a claim P9 could anchor.`,
        });
      }
    }
  }

  // --- P16: every reference resolves --------------------------------------------------------------
  //
  // The one rule about the document's *shape* rather than about what it claims, and the acceptance
  // criterion the review put first: "Every state, behaviour, transition, actor, and journey reference
  // resolves". It exists because the two failure modes it catches are both silent and both survive a
  // schema. A dangling id is a string like any other — `additionalProperties: false` and a
  // `pattern` on the id grammar will both pass a name that was never written — and a *stale* id, one
  // that resolves to an object which is not the one meant, is worse: `outgoing_transitions` was
  // inherited from an earlier document's uncollapsed edge set, so the ids resolved in the graph and
  // pointed at transitions this document had collapsed away. Nothing but this rule reads a reference
  // on both sides and asks whether they are the same one.
  //
  // A reference is checked for *existence* and, where there is a second thing to agree with, for
  // agreement: a transition's `from_state` must be the state that lists it, a behaviour's
  // `contract.preconditions[].state` must be a state, a journey step's transition must exist. An id
  // that names nothing and an id that names the wrong thing are one finding with different prose,
  // because the fix is the same and the reader needs the four things: which object, which field,
  // which id, and which collection it should have been in.
  //
  // This rule never repairs anything. The projection derives what it can and reports what it
  // rewrote; by the time a document is profiled, a reference that does not resolve is a defect in the
  // document and must be reported as one, because a reader who is told "the ids were fixed" has
  // learned nothing about the ids that were not.
  // The pool each `target` name refers to, spelled as the reader has to spell it in the message, and
  // the objects each scope holds. Two tables rather than one so that adding a field to a scope is a
  // one-line change and cannot get the pool's *name* wrong without getting the pool wrong too.
  const referencePools = {
    transitions: transitionIds,
    behaviors: behaviorIds,
    states: stateIds,
    observations: observationIds,
    'application.actors[]': actorIds,
    'element ids': new Set(surfacesOfElement.keys()),
  };
  const scoped = {
    states,
    transitions,
    behaviors,
    journeys,
    state_variables: variables,
  };
  // Every stored reference in the document, by the scope that holds it. A field absent from this
  // table is a reference this rule does not check, and there is exactly one kind: a value inside
  // `metadata`, which is the producer's own record and not the document's vocabulary.
  const references = [
    { scope: 'states', label: 'outgoing_transitions', field: 'outgoing_transitions', target: 'transitions', list: true },
    { scope: 'states', label: 'behaviors', field: 'behaviors', target: 'behaviors', list: true },
    { scope: 'states', label: 'elements', field: 'elements', target: 'element ids', list: 'id' },
    { scope: 'transitions', label: 'from_state', field: 'from_state', target: 'states' },
    { scope: 'transitions', label: 'to_state', field: 'to_state', target: 'states' },
    { scope: 'transitions', label: 'behavior', field: 'behavior', target: 'behaviors' },
    { scope: 'transitions', label: 'evidence[].observation', field: 'evidence', target: 'observations', list: 'observation' },
    { scope: 'behaviors', label: 'actor', field: 'actor', target: 'application.actors[]' },
    { scope: 'behaviors', label: 'composed_of', field: 'composed_of', target: 'behaviors', list: true },
    { scope: 'behaviors', label: 'contract.preconditions[].state', field: 'contract.preconditions', target: 'states', list: 'state' },
    { scope: 'behaviors', label: 'contract.postconditions[].state', field: 'contract.postconditions', target: 'states', list: 'state' },
    { scope: 'behaviors', label: 'contract.outcomes[].to_state', field: 'contract.outcomes', target: 'states', list: 'to_state' },
    // An outcome's evidence is a reference like any other, and it is the one P17 ranks: a contract
    // that cites a reading the document does not hold is a claim with no support that *looks* like
    // it has some, which is worse than the empty case P17's first code catches. This is the one
    // reference in the table that is two levels deep — an array of outcomes, each holding an array
    // of evidence entries — which is why `list` can also name a path rather than a key.
    { scope: 'behaviors', label: 'contract.outcomes[].evidence[].observation', field: 'contract.outcomes', target: 'observations', list: { through: 'evidence', at: 'observation' } },
    { scope: 'journeys', label: 'start_state', field: 'start_state', target: 'states' },
    { scope: 'journeys', label: 'actor', field: 'actor', target: 'application.actors[]' },
    { scope: 'journeys', label: 'steps[].transition', field: 'steps', target: 'transitions', list: 'transition' },
    { scope: 'state_variables', label: 'dimension_of', field: 'dimension_of', target: 'states' },
  ];
  // How a field names its ids: `list: true` reads the field as an array of ids, `list: 'x'` reads it
  // as an array of objects whose `x` is the id, `list: {through, at}` reads it as an array of objects
  // each holding an array of objects whose `at` is the id, and no `list` reads the field as one id.
  // Getting this wrong is how a rule about dangling references reports nothing at all while appearing
  // to run — which is the failure it exists to catch, so the shapes are named rather than inferred
  // from the value at hand.
  const lookup = (object, path) => path.split('.').reduce((held, key) => (held == null ? held : held[key]), object);
  // The ids one field names, given the shape that field has. Four shapes and no fifth, each one a
  // fact about the schema rather than a convenience: a scalar (`transition.from_state`), an array of
  // ids (`state.behaviors`), an array of objects carrying an id (`state.elements[].id`), and an
  // array of objects carrying an array of objects carrying an id (`contract.outcomes[].evidence[]
  // .observation`). Declared per row and never inferred from the value, because inferring it is how
  // this rule reported nothing at all the first time it was written: `rows(value)` over a scalar is
  // an empty array, and an empty array is silence, which reads exactly like agreement.
  const idsNamed = (value, list) => {
    if (list === true) return rows(value);
    if (typeof list === 'string') return rows(value).map((entry) => entry?.[list]);
    if (list && typeof list === 'object') {
      return rows(value).flatMap((entry) => rows(entry?.[list.through]).map((inner) => inner?.[list.at]));
    }
    return [value];
  };
  for (const reference of references) {
    const pool = referencePools[reference.target] ?? new Set();
    const held = rows(scoped[reference.scope]);
    for (const object of held) {
      // A scalar that is absent was pruned by the projection for having nothing to say, and that is
      // not a dangling reference: the difference between "this behaviour performs no move" and "this
      // behaviour performs a move that is not in the document" is the whole point of the rule.
      const value = lookup(object, reference.field);
      const named = idsNamed(value, reference.list);
      for (const id of named) {
        if (typeof id !== 'string' || !id || pool.has(id)) continue;
        add({
          rule: 'P16',
          code: 'reference_does_not_resolve',
          severity: 'error',
          scope: reference.scope,
          subject: object.id ?? object.name ?? null,
          detail: `${object.id ?? object.name ?? 'this object'}: ${reference.label} names "${id}", and no ${reference.target} entry carries that id.`,
        });
      }
    }
  }
  // A state that lists an edge the edge does not own is a *stale* reference rather than a dangling
  // one, and it is the specific defect the review found: the ids resolved in the graph they were
  // copied from, and pointed at edges this document does not have the calls for.
  for (const state of states) {
    for (const id of rows(state.outgoing_transitions)) {
      const transition = transitionById.get(id);
      if (!transition || transition.from_state === state.id) continue;
      add({
        rule: 'P16',
        code: 'reference_is_stale',
        severity: 'error',
        scope: 'states',
        subject: state.id,
        detail: `${state.id}: outgoing_transitions names "${id}", which resolves to a transition whose from_state is "${transition.from_state ?? null}". An edge belongs to the state it leaves: this id was copied from a document whose edges this one does not share.`,
      });
    }
  }

  // --- P17: a contract states what was watched, and no more ---------------------------------------
  //
  // The gap the review named as P0-2, in one sentence: *"The model should not silently turn a
  // plausible failure path into an observed fact."* A contract that says an outcome is `observed`
  // is making exactly that claim, and until this rule existed nothing read it — the outcome's
  // `status` is a closed enum and its `to_state` is checked by P16, so a hand-written or
  // LLM-written contract could assert any of the three levels about anything and validate.
  //
  // The projection never trips it: `contractOf` writes `observed` only from an edge's own evidence
  // and copies that evidence in the same breath. That is the point. The rule exists for the
  // document the projection did not write, and its two codes are the two ways a contract can
  // outrun what it watched:
  //
  //   - an outcome that claims observation and names no reading at all (`outcome_without_evidence`),
  //     which is the invented failure path with the paperwork of a watched one;
  //   - an outcome stronger than every reading it does name (`outcome_outranks_its_evidence`) — the
  //     same defect, one step quieter, and the one a document will reach by *editing* a real
  //     outcome's `status` rather than by writing a new one.
  //
  // A weaker claim is not reported, and that is deliberate rather than an omission: `inferred` on a
  // failure path someone reasoned about is the honest way to state a path no walk took, and this
  // rule's whole value is that it leaves that door open. The levels are `CLAIM_LEVELS`, the same
  // three D9 already uses, so a contract and a claim are ranked by one vocabulary and not two.
  const levelOf = (level) => CLAIM_LEVELS.indexOf(level ?? 'modelled');
  // The observations by id, so an outcome's citation can be *ranked* and not merely counted. P16
  // builds the same set as a set — it only needs to know an id exists — and this is the map a rule
  // needs when existence is not the question.
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  for (const behavior of behaviors) {
    const outcomes = rows(behavior.contract?.outcomes);
    for (const outcome of outcomes) {
      const claimed = levelOf(outcome.status);
      const named = rows(outcome.evidence);
      const cited = named
        .map((entry) => observationById.get(entry?.observation))
        .filter(Boolean);
      // A citation that names no reading at all is this rule's finding. A citation that names a
      // reading the document does not hold is *P16's* — the two codes are separate complaints and one
      // edit must not draw both, because "this claim has nothing behind it" and "this claim points at
      // something that is not here" are different things to go and fix, and a document reported twice
      // for one mistake is a document whose report is read as noise.
      if (claimed >= levelOf('observed') && !cited.length && !named.length) {
        add({
          rule: 'P17',
          code: 'outcome_without_evidence',
          severity: 'error',
          scope: 'behaviors',
          subject: behavior.id,
          detail: `${behavior.id}: the outcome "${outcome.id ?? ''}" is stated ${outcome.status} and names no reading, so nothing in this document supports it. A failure path no walk took is a path the contract may state as inferred; stating it as observed is the one thing it may not do.`,
        });
        continue;
      }
      const support = cited.length
        ? cited.reduce((lowest, observation) => Math.min(lowest, levelOf(claimLevel(observation.metadata))), Number.POSITIVE_INFINITY)
        : null;
      if (support === null || claimed <= support) continue;
      add({
        rule: 'P17',
        code: 'outcome_outranks_its_evidence',
        severity: 'error',
        scope: 'behaviors',
        subject: behavior.id,
        detail: `${behavior.id}: the outcome "${outcome.id ?? ''}" is stated ${outcome.status}, while the weakest of the ${cited.length} reading(s) it names was obtained at ${CLAIM_LEVELS[support]}. A contract is a claim like any other and takes the level of its evidence (D11); state this outcome ${CLAIM_LEVELS[support]} or cite a reading that was actually executed.`,
      });
    }
  }

  return findings;
}

/** `elementId → the states that declare it`. */
function elementSurfaces(states) {
  const index = new Map();
  for (const state of states) {
    for (const element of rows(state.elements)) {
      if (!isElementId(element.id)) continue;
      const set = index.get(element.id) ?? new Set();
      set.add(state.id);
      index.set(element.id, set);
    }
  }
  return index;
}

/**
 * The application's own vocabulary, as far as the document states it: the page types and the route
 * segments. P1's second clause refuses a name that repeats one of these, and it must come from the
 * document — a behaviour called `login` is only suspicious once something else is called `login`,
 * and that something is the surface.
 */
function surfaceVocabulary(states) {
  const vocabulary = new Set();
  for (const state of states) {
    const pageType = state.identity?.page_type;
    if (typeof pageType === 'string' && pageType) vocabulary.add(pageType);
    for (const segment of String(state.identity?.route ?? '').split('/')) {
      const cleaned = slugify(segment);
      if (cleaned) vocabulary.add(cleaned);
    }
  }
  return vocabulary;
}

/**
 * Why a behaviour name is a mechanism, or `null`.
 *
 * Two clauses, both falsifiable against the document itself:
 *
 * 1. the first word is a verb of the machinery (`fill_login_email`) — the name is the call;
 * 2. a later word repeats a page type or a route segment (`..._login`) — the name is the place.
 *
 * What is deliberately *not* checked: a later word matching an element's name. `view_projects`
 * would be refused by it, and "view projects" is a sentence a user says. The rule refuses names
 * built from the machinery's words or the surface's own name, and leaves the rest to judgement.
 */
function mechanismName(name, vocabulary) {
  const tokens = String(name ?? '').split('_').filter(Boolean);
  if (!tokens.length) return 'is empty';
  if (MECHANISM_VERBS.has(tokens[0])) return `begins with the control's own verb ("${tokens[0]}")`;
  const repeated = tokens.slice(1).find((token) => vocabulary.has(token));
  if (repeated) return `repeats the surface it happens on ("${repeated}")`;
  return null;
}

/** The behaviour ids a committed capability's steps are named by — itself and its members. */
function behavioursOfCapability(capability, behaviors, capabilities) {
  const names = new Set([slugify(capability.name ?? '')]);
  for (const member of rows(capability.composed_of)) {
    const entry = capabilities.find((candidate) => candidate.id === member);
    if (entry) {
      names.add(slugify(entry.name ?? ''));
      for (const nested of rows(entry.composed_of)) {
        const inner = capabilities.find((candidate) => candidate.id === nested);
        if (inner) names.add(slugify(inner.name ?? ''));
      }
    }
  }
  return new Set([...names].map((name) => behaviorIdFor(name)).filter((id) => behaviors.some((behavior) => behavior.id === id)));
}

/** Whether a behaviour is the projection of a committed capability. */
function behaviourBacksCapability(behaviorId, capabilityId, behaviorById, capabilities) {
  const behavior = behaviorById.get(behaviorId);
  const capability = capabilities.find((entry) => entry.id === capabilityId);
  if (!behavior || !capability) return false;
  if (slugify(capability.name ?? '') === behavior.name) return true;
  return rows(capability.composed_of).some((member) => {
    const entry = capabilities.find((candidate) => candidate.id === member);
    return entry ? slugify(entry.name ?? '') === behavior.name : false;
  });
}

/** The counting half, for a CLI: what the profile said, by rule and by severity. */
export function summarizeFindings(findings) {
  const list = rows(findings);
  const bySeverity = { info: 0, warning: 0, error: 0 };
  const byRule = {};
  for (const finding of list) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  }
  return {
    total: list.length,
    errors: bySeverity.error,
    warnings: bySeverity.warning,
    infos: bySeverity.info,
    bySeverity,
    byRule,
    failed: bySeverity.error > 0,
  };
}

/**
 * The rules as invariants, in the shape `commit.js` reports the graph's own invariants in.
 *
 * The profile is a diagnostic and the commit is a gate, and the one thing that must not happen is
 * for the two to disagree about what the rules are: a document that passes the commit and fails
 * the profiler (or the reverse) makes both worthless. So the commit calls `profileFindings` and
 * maps *its* output here rather than restating any rule — one definition, two readers, and the
 * mapping is mechanical enough to be checked.
 *
 * One entry per rule, in the table's order. `ok` is "no error-severity finding of this rule": a
 * warning is something the profile noted and the document still carries, which is what
 * `PROFILE_RULES` says a warning is. `severity` is the worst the rule can report, so a reader can
 * tell `P12` (which explains an unchecked coverage as an `info`) from `P2` (which never fails a
 * document). The `document` field says which of the two documents the entry is about — this is
 * about the application model, and `report.ok` is about `graph.json`.
 */
export function profileInvariants(findings) {
  const list = rows(findings);
  return Object.entries(PROFILE_RULES).map(([rule, severities]) => {
    const mine = list.filter((finding) => finding.rule === rule);
    const failures = mine.filter((finding) => finding.severity === 'error');
    return {
      code: rule,
      name: `application model ${rule} (${severities.join('/')})`,
      severity: severities.includes('error') ? 'error' : 'warning',
      ok: failures.length === 0,
      detail: mine.length
        ? mine.map((finding) => `${finding.severity}: ${finding.code}${finding.subject ? ` (${finding.subject})` : ''} — ${finding.detail}`).join(' | ')
        : `no finding from ${rule}.`,
      document: 'model',
      findings: mine.length,
    };
  });
}

/** The evidence roles this module assumes the schema defines. Asserted once, at import. */
for (const role of TRANSITION_EVIDENCE_ROLES) {
  if (!EVIDENCE_ROLES.has(role)) {
    throw new Error(`TRANSITION_EVIDENCE_ROLES names "${role}", which schema.js does not define. P9 would refuse evidence the schema itself allows.`);
  }
}
