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
 * - `profileFindings()` implements **P1–P13**, the judgement rules of §3, as the flat findings
 *   the commit already emits (`{code, severity, detail, basis, …}`, plus `rule` and `scope`).
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

import { CONTROL_ROLES, ELEMENT_TARGET_EFFECTS, readRun, reconcile } from './commit.js';
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
export function candidatesFromGraph(graph, run = null) {
  return {
    run: run ?? null,
    application: graph.application ?? null,
    observations: rows(graph.observations),
    states: rows(graph.states),
    capabilities: rows(graph.capabilities),
    transitions: rows(graph.transitions),
    journeys: rows(graph.journeys),
    coverage: graph.coverage ?? null,
    warnings: rows(graph.warnings),
    source: 'graph.json',
  };
}

/**
 * Everything one run recorded, read-only.
 *
 * `graph.json` wins when it is there: it is the document that was judged and it carries the
 * journeys, which the logs do not (a journey is a claim about a walk, and only the commit makes
 * it).
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
    return candidatesFromGraph(JSON.parse(readFileSync(graphPath, 'utf8')), run);
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

  const edgesByCapability = new Map();
  for (const edge of transitions) {
    const capability = edge.action?.capability ?? null;
    if (!capability) continue;
    edgesByCapability.set(capability, [...(edgesByCapability.get(capability) ?? []), edge]);
  }

  // --- actors: the variants the run distinguished, and nothing invented -----------------------
  // An actor carries no metadata: `application.actors[]` allows an id, a description and a
  // credentials_ref and nothing else, so "this was derived" has to be said in the description.
  const variantRows = distinct(states.map((state) => state.identity?.variant));
  const actors = variantRows.map((id) => ({
    id,
    description: `Observed as the surface variant "${id}"; the projection cannot say what it means.`,
  }));

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
        metadata: { confidence: 1, status: 'verified', extra: { derived: 'state.identity.dimensions' } },
      };
      if (!variable.values.includes(value)) variable.values.push(value);
      if (!variable.dimension_of.includes(state.id)) variable.dimension_of.push(state.id);
      if (!variable.evidence.length) variable.evidence = rows(state.evidence);
      variables.set(name, variable);
    }
  }

  // --- behaviours: one per committed capability, in the order the document declares them ------
  const behaviors = capabilities.map((capability) => {
    const name = slugify(capability.name ?? capability.id ?? '');
    if (name !== capability.name) {
      notes.push(`${capability.id}: name "${capability.name}" is not a behaviour-name slug and was carried as "${name}".`);
    }
    const edges = edgesByCapability.get(capability.id ?? capability.capability_id) ?? [];
    const composed = rows(capability.composed_of).map((member) => (
      capabilityById.has(member) ? behaviorIdFor(capabilityById.get(member).name) : member
    ));
    const actor = singleVariant([
      ...edges.map((edge) => variantOfState(edge.from_state)),
      ...composed.flatMap((member) => (edgesByCapability.get(memberIdOf(member, capabilityById)) ?? [])
        .map((edge) => variantOfState(edge.from_state))),
    ]);
    const steps = stepsOfCapability(capability, notes);
    return prune({
      id: behaviorIdFor(name),
      name,
      description: capability.description,
      kind: BEHAVIOR_KINDS.has(capability.kind) ? capability.kind : undefined,
      actor,
      input: capability.input,
      output: capability.output,
      realization: steps,
      composed_of: composed,
      aliases: rows(capability.aliases),
      evidence: rows(capability.evidence),
      metadata: capability.metadata,
    });
  });

  // --- affordances: declared controls on a surface that no committed step used -----------------
  const actedOn = new Map();
  for (const edge of transitions) {
    const from = edge.from_state;
    const list = actedOn.get(from) ?? new Set();
    if (isElementId(edge.action?.target)) list.add(edge.action.target);
    for (const effect of rows(edge.effects)) {
      if (ELEMENT_TARGET_EFFECTS.has(effect.type) && isElementId(effect.target)) list.add(effect.target);
    }
    actedOn.set(from, list);
  }

  const behaviorOfEdge = (edge) => {
    const capability = capabilityById.get(edge.action?.capability);
    return capability ? behaviorIdFor(capability.name) : undefined;
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
      return behaviorIdFor(capability.name);
    });
    return {
      ...prune(rest),
      // The inverse view of `transitions[].from_state`, plus what 0.1 already recorded as offered.
      behaviors: distinct([
        ...transitions.filter((edge) => edge.from_state === state.id).map(behaviorOfEdge),
        ...fromDocument,
      ]),
      affordances: affordancesOf(state, actedOn.get(state.id) ?? new Set()),
    };
  });

  // --- transitions: the committed edges, one per move ------------------------------------------
  const projectedTransitions = transitions.map((edge) => {
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
  const projectedJourneys = journeys.map((journey, index) => {
    const steps = journeySteps(journey, transitionById);
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
    steps.push(prune({
      action: step.action,
      element: isElementId(step.element ?? step.target) ? step.element ?? step.target : undefined,
      value: step.value,
      purpose: step.purpose,
      arguments: step.arguments,
      effects: rows(step.effects),
      description: step.description,
      metadata: { confidence: 1, status: 'verified', extra: { derived: 'capability.steps' } },
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
 * What a surface offers and the walk never took (D6).
 *
 * Only controls (`CONTROL_ROLES`), because a heading is not something a user can do, and only
 * elements no committed step on this surface touched, because an affordance the walk performed is
 * refuted by the walk (P13's second clause). `expected_behavior` is the element's own declared
 * purpose: the projection has no name to offer and will not invent one, so the claim is the
 * element's vocabulary and its confidence is 0.3 — the number §3 gives a claim nothing refuted.
 */
function affordancesOf(state, actedOn) {
  const evidence = rows(state.evidence);
  return rows(state.elements)
    .filter((element) => CONTROL_ROLES.has(element.role) && !actedOn.has(element.id))
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
    }));
}

const expectedBehaviorOf = (element) => {
  const purpose = element.semantic?.purpose;
  if (typeof purpose === 'string' && /^[a-z][a-z0-9_]*$/.test(purpose)) return purpose;
  return slugify(element.name ?? element.id ?? 'unnamed');
};

/** A journey's steps, in the order the walk took them, with the values the edge was walked with. */
function journeySteps(journey, transitionById) {
  const declared = rows(journey.steps).filter((step) => typeof step?.transition === 'string');
  if (declared.length) {
    return declared.map((step) => prune({
      transition: step.transition,
      arguments: step.arguments,
      description: step.description,
      optional: step.optional,
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
 * P1–P13 over a projected model.
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
    const surfaces = new Set(rows(edgesByBehavior.get(behavior.id)).map((edge) => edge.from_state));
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

/** The evidence roles this module assumes the schema defines. Asserted once, at import. */
for (const role of TRANSITION_EVIDENCE_ROLES) {
  if (!EVIDENCE_ROLES.has(role)) {
    throw new Error(`TRANSITION_EVIDENCE_ROLES names "${role}", which schema.js does not define. P9 would refuse evidence the schema itself allows.`);
  }
}
