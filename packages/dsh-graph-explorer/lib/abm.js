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
 * - `profileFindings()` implements **P1–P15**, the judgement rules of §3, as the flat findings
 *   the commit already emits (`{code, severity, detail, basis, …}`, plus `rule` and `scope`).
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
import { EVIDENCE_ROLES } from './schema.js';
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
  P9: ['error'],
  P10: ['warning'],
  P11: ['warning'],
  P12: ['error', 'info'],
  P13: ['error', 'warning'],
  P14: ['error'],
  P15: ['error'],
});

/** The kinds a behaviour may declare. Copied from `behavior.schema.json`'s enum. */
const BEHAVIOR_KINDS = new Set(['interaction', 'navigation', 'query', 'setup', 'composite']);

/** The honest record of a value that was set but never read back. */
const REDACTION = '[set]';

const rows = (value) => (Array.isArray(value) ? value : []);

const isElementId = (value) => typeof value === 'string' && /^element[-_][A-Za-z0-9._:-]+$/.test(value);

const isStorageKey = (value) => typeof value === 'string'
  && /^(localStorage|sessionStorage|cookie)[.:]/i.test(value);

const isPlaceholder = (value) => typeof value === 'string' && /^\{\{\s*[^}]+\s*\}\}$/.test(value.trim());

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
  for (const record of readJsonl(path)) {
    const id = record?.capability_id;
    if (record?.kind !== 'realization_step' || typeof id !== 'string') continue;
    byCapability.set(id, [...(byCapability.get(id) ?? []), record]);
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
      for (const call of carried) absorbed.set(call.id, last.id);
      if (!carried.length) continue;
      survivorById.set(last.id, {
        ...last,
        // D12: the edge is the behaviour's *move*, so it starts where the invocation started and ends
        // where the last of its calls landed. Its id is still the id of the call that ended it — that
        // is what keeps the collapse readable against the log — but a move's origin is the reading it
        // was performed from, and carrying the last call's `from_state` would have claimed the
        // behaviour started wherever its final call started and lost the state the walk stood in when
        // it was asked for.
        from_state: final[0].from_state,
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
  // that id (P6's `untraceable_actor`).
  //
  // A variant the run used and the declaration does not name is *also* carried, with the derived
  // description, because every `state.identity.variant` and `journey.actor` is a reference to one of
  // these ids and dropping the row would break the reference rather than report the omission. The
  // omission is reported where the graph is built (`commit.js` warns when a used variant is
  // undeclared); here the row has to exist for the document to hold together at all. A run that
  // declares nothing therefore projects exactly as it did before this registry existed: the union is
  // the old behaviour, and a declaration only adds rows and metadata the run could not have derived.
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
        description: `Observed as the surface variant "${id}"; the projection cannot say what it means.`,
      })),
  ];

  // --- state variables: every dimension a state identity distinguishes, with its detection ----
  const variables = new Map();
  for (const state of states) {
    for (const [name, value] of Object.entries(state.identity?.dimensions ?? {})) {
      const variable = variables.get(name) ?? {
        name,
        description: 'A distinction a state identity draws; the projection cannot say what it means.',
        type: 'string',
        values: [],
        dimension_of: [],
        detection: detectionFor(state, value),
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
      if (!variable.values.includes(value)) variable.values.push(value);
      if (!variable.dimension_of.includes(state.id)) variable.dimension_of.push(state.id);
      if (!variable.evidence.length) variable.evidence = rows(state.evidence);
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
  for (const state of states) {
    for (const element of rows(state.elements)) {
      const purpose = element.semantic?.purpose;
      if (typeof purpose === 'string' && isElementId(element.id)) elementIdByPurpose.set(purpose, element.id);
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
      return prune({
        id: behaviorIdFor(name),
        name,
        description: capability.description,
        kind: BEHAVIOR_KINDS.has(capability.kind) ? capability.kind : undefined,
        actor,
        input: steps.length ? inputOf(capability) : capability.input,
        output: capability.output,
        // The recorded steps, when the run recorded any: they are what the behaviour is, and the
        // `steps[]` a 0.1 capability carries is the same claim in the older spelling.
        realization: steps,
        composed_of: composed,
        aliases: rows(capability.aliases),
        evidence,
        metadata: capability.metadata,
      });
    });

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

  // `state.capabilities` is 0.1's inverse view and 0.2 renamed it `behaviors` (D2), so the key is
  // translated rather than copied: the ids are looked up, and an id no capability declares is
  // dropped with a note rather than carried as a behaviour that does not exist.
  const projectedStates = states.map((state) => {
    const { capabilities: offered = [], ...rest } = state;
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
    return {
      ...prune(rest),
      // The inverse view of `transitions[].from_state`, plus what 0.1 already recorded as offered.
      behaviors: distinct([
        ...survivors.filter((edge) => edge.from_state === state.id).map(behaviorOfEdge),
        ...fromDocument,
      ]),
      affordances: affordancesOf(state, actedOn.get(state.id) ?? new Set(), state.affordances),
    };
  });

  // --- transitions: one edge per move a behaviour performs (D5) --------------------------------
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
    // walked twice, and the journey names it twice (D5/D12).
    const steps = journeySteps(journey, transitionById).map((step) => (
      absorbed.has(step.transition) ? { ...step, transition: absorbed.get(step.transition) } : step
    ));
    const startState = journey.start_state ?? steps[0]?.from_state ?? null;
    const actor = startState ? variantOfState(startState) : null;
    const endState = [...steps].reverse().map((step) => transitionById.get(step.transition)?.to_state)[0] ?? null;
    const endVariant = endState ? variantOfState(endState) : null;
    if (actor && endVariant && actor !== endVariant) {
      notes.push(`${journey.id}: the walk starts as "${actor}" and ends as "${endVariant}"; the journey's actor is the starting variant, and the walk is the transition between them.`);
    }
    return prune({
      id: journey.id ?? `journey_${index + 1}`,
      name: journey.name,
      goal: journey.goal,
      goal_stated: journey.metadata?.extra?.goal_stated
        ?? (typeof journey.goal === 'string' && journey.goal.trim() !== ''),
      description: journey.description,
      actor,
      start_state: startState,
      steps,
      assertions: rows(journey.assertions),
      criticality: journey.criticality,
      evidence: rows(journey.evidence),
      metadata: journey.metadata,
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
 * How a test would read the dimension a state identity drew.
 *
 * An element the state's own detection already reads is the strongest available reading: the
 * distinction and the evidence for it then come from the same place. A route is the fallback, and
 * if the state has neither, `null` — which P7 reports, because a dimension nothing observable
 * reports is a distinction no test can make.
 */
function detectionFor(state, value) {
  const element = rows(state.detection).find((entry) => isElementId(entry.element))?.element;
  if (element) return { type: 'value', element, operator: 'equals', expected: value };
  const route = rows(state.detection).find((entry) => typeof entry.route === 'string')?.route
    ?? state.identity?.route;
  if (typeof route === 'string' && route !== '') return { type: 'route', route, operator: 'equals', expected: value };
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
 * P1–P15 over a projected model.
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
  const transitionIds = new Set(transitions.map((transition) => transition.id));
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
        detail: `A state is written as variant "${variant}", which no application.actors[] entry declares. The id is the join; both sides must name one of these.`,
      });
    }
  }
  for (const journey of journeys) {
    if (!journey.actor) {
      add({
        rule: 'P6', code: 'journey_actor_missing', severity: 'warning', scope: 'journeys', subject: journey.id,
        detail: 'The journey names no actor, so nothing says who it is for.',
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
        detail: `"${variable.name}" declares no detection, so no test can tell its values apart.`,
      });
    } else if (!variable.detection.element && !variable.detection.route) {
      add({
        rule: 'P7', code: 'detection_reads_no_surface', severity: 'error', scope: 'state_variables', subject: variable.name,
        detail: `The detection of "${variable.name}" reads neither an element nor a route. A check over a storage key is a dimension-shaped claim nothing can evaluate.`,
      });
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
  for (const transition of transitions) {
    const passed = rows(transition.metadata?.extra?.collapsed?.passed_through);
    if (!passed.length) continue;
    const behavior = behaviorById.get(transition.behavior);
    const explained = new Set(rows(behavior?.realization).flatMap((step) => rows(step.effects)
      .filter((effect) => effect?.type === 'state_entered' && typeof effect.to === 'string')
      .map((effect) => effect.to)));
    for (const state of passed) {
      if (explained.has(state)) continue;
      add({
        rule: 'P12', code: 'collapsed_past_a_state', severity: 'error', scope: 'transitions', subject: transition.id,
        detail: `The edge ${transition.from_state} → ${transition.to_state} collapsed calls that went through ${state}, and no step of "${transition.behavior}" says it arrived there. A state the walk entered that no edge leads to is a reading nothing in the document explains.`,
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
