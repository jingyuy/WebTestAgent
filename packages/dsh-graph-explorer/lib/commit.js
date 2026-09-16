/**
 * `graph_commit` — the reconciliation step.
 *
 * Everything before this point produced a *candidate* record: what was walked, in
 * the order it was walked, with the machinery's evidence beside the model's
 * reading of it. Exploration is allowed to be wrong, and the logs say so — a step
 * read at the wrong moment, a claim the capture contradicts, a walk that jumped.
 * None of that is a reason to stop, and none of it is knowledge either.
 *
 * This module is where the run decides what becomes knowledge, and the shape of
 * the answer is the whole design:
 *
 *   Raw evidence      run.json, observations.jsonl, evidence/*.png
 *                     NEVER rewritten. Not by this module, not to make the graph
 *                     consistent. The graph is derived and can be rebuilt.
 *   Candidate graph   states.jsonl, capabilities.jsonl, transitions.jsonl
 *                     Append-only, MAY contain contradictions. A contradictory
 *                     candidate is a fact about the exploration.
 *   Committed graph   graph.json — internally consistent, schema-shaped, every
 *                     claim traceable to a raw record.
 *   Commit report     commit_report.json — what was decided and why, including
 *                     every candidate that was refused.
 *
 * Three consequences that shape the code:
 *
 * 1. **A candidate is never deleted.** Refusal is a decision recorded in the
 *    report, not an erasure. The rejected edge stays in transitions.jsonl and in
 *    the report, with the reason the recorder itself gave it.
 * 2. **Only `status: committed` candidates become graph edges**, so the graph
 *    never carries a contradictory edge — and the report never loses one.
 * 3. **The graph cannot express the decision, so the report is not optional.**
 *    `transition.schema.json` sets `additionalProperties: false`: a transition
 *    has no `status`, no `rejection_reason` and no structured `warnings`. The
 *    schema's own homes for bookkeeping are `metadata` (with `extra`, which is
 *    open-ended) and the root `warnings[]` (an array of plain strings). So the
 *    graph says *what the application does* and carries the decision in
 *    `metadata.extra.commit`, while commit_report.json carries the reasoning in
 *    full. A reader who only has the graph can still see that something was
 *    refused; a reader who wants to know why reads the report.
 *
 * Reference resolution is the other half of the job. The model names elements by
 * `semantic_purpose`, writes effects and assertions in a shorthand that predates
 * the schema's closed vocabularies, and refers to states by role words rather
 * than ids. Every one of those has to resolve to an id that exists, or be
 * dropped and reported — invariant 2 (no dangling references) and invariant 3
 * (element reachability) are not expressible in JSON Schema, and a generator
 * that trusted an unresolvable reference would emit a test that cannot run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ASSERTION_SEVERITIES,
  CAPABILITY_KINDS,
  DETECTION_TYPES,
  EFFECT_KEYS,
  EFFECT_REQUIRED,
  EFFECT_TYPES,
  ELEMENT_PURPOSE_PATTERN,
  EVIDENCE_ROLES,
  NOTE_SEVERITY,
  PAGE_TYPE_PATTERN,
  SEVERITIES,
  TRANSITION_DECISIONS,
  UNKNOWN_NOTE_SEVERITY,
} from './schema.js';
import { slugify } from './session.js';

/** Severity ordering: a candidate's verdict is the worst thing said about it. */
const SEVERITY_RANK = { info: 0, warning: 1, error: 2 };

const SEVERITY_OF = (findings) => findings
  .reduce((worst, finding) => (
    SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst
  ), 'info');

/** Read and parse a `.jsonl` file. A blank line is not a record; a bad line is an error. */
function readJsonl(path, sink) {
  if (!existsSync(path)) return [];
  const rows = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text));
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not JSON (${error instanceof Error ? error.message : String(error)}). The run log is evidence and is never repaired in place.`);
    }
  }
  if (sink) sink.push(...rows);
  return rows;
}

/**
 * Everything one run wrote. The run directory is the argument rather than the store
 * object, because committing a run that has already finished is the normal case: the
 * store holds in-memory indexes the logs no longer need, and the whole point of a
 * log is that it can be read by something that was not there.
 */
export function readRun(dir) {
  const runPath = join(dir, 'run.json');
  if (!existsSync(runPath)) {
    throw new Error(`${dir} is not a run directory: no run.json. Point this at the directory the exploration wrote (the configured runDirName).`);
  }
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  return {
    dir,
    run,
    observations: readJsonl(join(dir, 'observations.jsonl')),
    states: readJsonl(join(dir, 'states.jsonl')),
    capabilities: readJsonl(join(dir, 'capabilities.jsonl')),
    transitions: readJsonl(join(dir, 'transitions.jsonl')),
  };
}

/** The path of a URL, which is the part worth pinning a state to. */
const routeOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    return null;
  }
};

const distinct = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];

/** `element_` + the purpose, which is the schema's element id convention. */
const elementIdFor = (purpose) => 'element_' + slugify(purpose);

/**
 * A locator as the schema wants it: a strategy and a value, not a selector string.
 *
 * The model writes what it copied from the page (`[data-testid="email-input"]`,
 * `text=Projects`), which is evidence about how to *drive* the element and never its
 * identity. `element.schema.json` requires `{strategy, value}`, so the string is
 * classified rather than passed through — and the string itself is kept in the
 * element's `metadata.extra.raw_locator` so nothing the model observed is lost when
 * its shorthand is translated.
 */
export function normalizeLocator(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  // The model's own shorthand, when it wrote `strategy=value`.
  const prefixed = /^(role|label|placeholder|text|testid|id|name|css|xpath|href|alt|title)=(.+)$/s.exec(text);
  if (prefixed) {
    const value = prefixed[2].trim();
    // `role=link[name="Sign in"]` is a role locator with an accessible-name filter, which
    // is how the schema's `name` field is meant to be used.
    const role = prefixed[1] === 'role' ? /^(\w+)\s*\[name=["']?([^"'\]]+)["']?\]$/.exec(value) : null;
    if (role) return { strategy: 'role', value: role[1], name: role[2] };
    return { strategy: prefixed[1], value };
  }
  const testid = /^\[data-testid=["']?([^"'\]]+)["']?\]$/.exec(text);
  if (testid) return { strategy: 'testid', value: testid[1] };
  if (text.startsWith('#')) return { strategy: 'id', value: text.slice(1) };
  return { strategy: 'css', value: text };
}

/**
 * The state's `identity.route`, from the URLs the machinery actually captured.
 *
 * The observation is the source, not the model's typed URL, because the URL is the one
 * thing here the page recorded for us. When the same identity was seen at more than one
 * route the route is OMITTED rather than picked: `identity.route` is a discriminator, and
 * silently choosing one of two answers is how a state acquires a route it does not have.
 * The disagreement is reported instead.
 */
function routeForState(observations) {
  const routes = distinct(observations.map((observation) => routeOf(observation?.capture?.url)));
  if (routes.length === 1) return { route: routes[0], routes };
  return { route: null, routes };
}

/**
 * Turn one of the model's shorthand detection/assertion entries into a schema assertion,
 * or explain why it cannot be.
 *
 * The model's vocabulary is close to the schema's but not equal, and the differences are
 * exactly the ones `additionalProperties: false` refuses:
 *   - `value` is not an assertion field (it belongs to effects). The schema wants `expected`.
 *   - `visible` / `hidden` / `enabled` / `disabled` are not operators. They are the *value*
 *     an element's state is compared against, so they become `operator: equals|not_equals`
 *     plus `expected: "visible"`.
 *   - `target` holds a `semantic_purpose` for elements and free text for states. An element
 *     reference has to become the resolved `element_*` id, and a `type: state` assertion has
 *     to name a state that exists — `{type: "state", target: "auth"}` names nothing, and a
 *     check with nothing behind it is worse than a missing check.
 *
 * Dropping is always reported. A silently dropped assertion is a generated test that checks
 * less than the graph implies it does.
 */
export function normalizeAssertion(entry, ctx) {
  if (typeof entry === 'string') {
    return entry.trim() ? { assertion: { description: entry.trim() } } : { dropped: 'empty_assertion' };
  }
  if (!entry || typeof entry !== 'object') return { dropped: 'not_an_assertion' };

  const type = entry.type;
  if (!DETECTION_TYPES.has(type)) return { dropped: 'unknown_assertion_type', detail: `type ${JSON.stringify(type)}` };

  const assertion = { type };
  if (typeof entry.description === 'string') assertion.description = entry.description;

  const STATE_WORDS = new Set(['visible', 'hidden', 'enabled', 'disabled']);
  const OPERATORS = new Set([
    'equals', 'not_equals', 'matches', 'contains', 'not_contains', 'greater_than',
    'less_than', 'one_of', 'exists', 'not_exists', 'truthy', 'falsy',
  ]);

  // The value the model compared against arrives under one of three names.
  const value = entry.value !== undefined ? entry.value : entry.expected;

  if (type === 'url') {
    // A URL is pinned by route, not by host: the same graph is committed against staging
    // and production, and `expected: "http://127.0.0.1:4173/"` would be true of exactly one
    // machine. The full URL is kept in the description, which is where an observation note
    // belongs.
    const raw = typeof value === 'string' ? value : (typeof entry.target === 'string' ? entry.target : null);
    if (!raw) {
      // A bare `{type: "url"}` is the shortest and most common detection a model writes: "this
      // state is the page at this address". The address it means is the one its readings were
      // taken at, which the commit derived from the captures — so it is pinned to that route
      // rather than refused. `pinned` is returned so the caller can record the translation: what
      // lands in the graph is not the string the model wrote, and a rewrite nobody can see is
      // how a graph acquires a claim its author did not make.
      if (typeof ctx.route === 'string' && ctx.route) {
        return {
          assertion: { type, operator: 'matches', expected: ctx.route, description: `observed at ${ctx.route}` },
          pinned: ctx.route,
        };
      }
      return { dropped: 'url_assertion_without_a_url' };
    }
    const route = routeOf(raw);
    assertion.operator = 'matches';
    assertion.expected = route ?? raw;
    if (route) assertion.description = `${assertion.description ? assertion.description + ' — ' : ''}observed at ${raw}`;
    return { assertion };
  }

  if (type === 'state') {
    // A state assertion must name a state id that exists (invariant 2). The model writes
    // role words here (`auth`, `signed_in`), which resolve to nothing.
    const named = typeof entry.state === 'string' ? entry.state : (typeof value === 'string' ? value : null);
    const resolved = named ? ctx.stateIds.get(named) : null;
    if (!resolved) {
      return { dropped: 'state_assertion_names_no_state', detail: `expected state ${JSON.stringify(named ?? null)}` };
    }
    assertion.state = resolved;
    assertion.operator = OPERATORS.has(entry.operator) ? entry.operator : 'equals';
    return { assertion };
  }

  if (type === 'absence') {
    const purpose = typeof entry.element === 'string' ? entry.element : entry.target;
    const element = purpose ? ctx.elementIdByPurpose.get(String(purpose)) : null;
    if (element) assertion.element = element;
    else if (typeof entry.target === 'string') assertion.target = entry.target;
    assertion.operator = 'not_exists';
    return { assertion };
  }

  // Element-bound checks: resolve the purpose to the element the graph declares.
  const wantsElement = type === 'element_state' || type === 'element_value';
  if (wantsElement) {
    const raw = entry.element !== undefined ? entry.element : entry.target;
    const element = raw === undefined ? null : ctx.elementIdByPurpose.get(String(raw));
    if (!element) {
      return {
        dropped: 'element_reference_does_not_resolve',
        detail: `no committed state declares an element with semantic_purpose ${JSON.stringify(raw ?? null)}`,
      };
    }
    assertion.element = element;

    if (STATE_WORDS.has(entry.operator)) {
      // `operator: "visible"` means "the element's state is visible" — the operator slot
      // holds the expected value, and a false `expected` flips the comparison.
      const positive = value === undefined ? true : value === true || value === 'true';
      assertion.operator = positive ? 'equals' : 'not_equals';
      assertion.expected = entry.operator;
      return { assertion };
    }
    if (value !== undefined) {
      assertion.operator = OPERATORS.has(entry.operator) ? entry.operator : 'equals';
      assertion.expected = value;
      return { assertion };
    }
    if (OPERATORS.has(entry.operator)) {
      assertion.operator = entry.operator;
      return { assertion };
    }
    return { dropped: 'element_assertion_has_nothing_to_check' };
  }

  // Everything else (`value`, `message`, `api`, `effect`, `custom`) is a semantic path or
  // free text, which the schema allows as `target`. Carried as written.
  if (entry.target !== undefined) assertion.target = entry.target;
  if (value !== undefined) {
    assertion.operator = OPERATORS.has(entry.operator) ? entry.operator : 'equals';
    assertion.expected = value;
  } else if (OPERATORS.has(entry.operator)) {
    assertion.operator = entry.operator;
  }
  if (SEVERITIES.has(entry.severity)) {
    // Assertions are graded on their own scale (what a test should do on failure), not on the
    // effect scale (how strongly a change is claimed). Translated rather than copied.
    const grade = { error: 'assert', success: 'assert', warning: 'warn', info: 'info' }[entry.severity];
    if (ASSERTION_SEVERITIES.has(grade)) assertion.severity = grade;
  }
  if (Array.isArray(entry.evidence) && entry.evidence.length) assertion.evidence = entry.evidence;
  return { assertion };
}

/**
 * The recorder's own notes, as findings with a severity.
 *
 * The severity is what gives the commit deterministic rules, and it lives in `schema.js`
 * with the rest of the vocabulary copied from the normative schema. An unrecognised note
 * kind becomes a `warning`, never an `error`: refusing to commit an edge because of a note
 * this version does not know would turn a logging change into a data-loss bug.
 */
export function noteFindings(notes) {
  return (Array.isArray(notes) ? notes : []).map((note) => {
    const code = note && typeof note.kind === 'string' ? note.kind : 'unrecognised_note';
    return {
      code,
      severity: NOTE_SEVERITY.get(code) ?? UNKNOWN_NOTE_SEVERITY,
      detail: note && typeof note.detail === 'string' ? note.detail : null,
      basis: 'recorder_note',
      note: note ?? null,
    };
  });
}

/**
 * The effect types whose `target` is an element.
 *
 * Deliberately not every effect: `storage_changed.target` is a storage key and
 * `list_changed.target` is a semantic path, and resolving those against the element
 * registry would rewrite a key into an element id the moment the two names coincided.
 */
const ELEMENT_TARGET_EFFECTS = new Set([
  'value_changed',
  'visibility_changed',
  'element_created',
  'element_destroyed',
  'validation_error',
]);

/**
 * Resolve a `target` the model wrote as a semantic purpose into the element id the graph
 * declares.
 *
 * `effect.target` is typed as a plain string — the schema allows a semantic path there, so a
 * bare `submit_login` is a *legal* value that means nothing to anything downstream. The
 * purpose is the element's stable identity, so when the name matches one it is the element
 * being referenced, and resolving it turns a string nothing can check into a reference
 * invariant 3 can check. Returns the id when a rewrite happened, so the report can say so.
 */
function resolveEffectTarget(effect, ctx) {
  if (!ELEMENT_TARGET_EFFECTS.has(effect.type) || typeof effect.target !== 'string') return null;
  const id = ctx.elementIdByPurpose.get(effect.target);
  if (!id) return null;
  effect.target = id;
  return id;
}

/**
 * Judge one candidate transition.
 *
 * The rules, in order of authority:
 *   - a broken reference or a self-contradicting record is an `error`: no evidence can
 *     make it true, so the edge is refused;
 *   - a recorder note is whatever severity the note table says (the self-loop note is an
 *     error: the record itself says the state identity does not hold);
 *   - otherwise the candidate is clean.
 *
 * A refused edge is not dropped. It is reported with the reason the recorder gave it, which
 * is why `rejection_reason` is a note kind rather than a new word invented here: the note IS
 * the recorded reason, and a second vocabulary would be a second chance to be wrong.
 */
function judge(record, ctx) {
  const findings = noteFindings(record.notes);

  const fromState = record.from_state;
  const toState = record.to_state;
  const fromKnown = ctx.stateIds.has(fromState);
  const toKnown = ctx.stateIds.has(toState);
  if (!fromKnown || !toKnown) {
    const missing = [!fromKnown ? fromState : null, !toKnown ? toState : null].filter(Boolean);
    findings.push({
      code: 'unknown_state_endpoint',
      severity: 'error',
      basis: 'reference_check',
      detail: `the transition names ${missing.map((id) => JSON.stringify(id)).join(' and ')}, which no committed state has (invariant 2).`,
    });
  }

  const capabilityId = record.action?.capability;
  if (!capabilityId || !ctx.capabilityIds.has(capabilityId)) {
    findings.push({
      code: 'unknown_capability',
      severity: 'error',
      basis: 'reference_check',
      detail: `action.capability is ${JSON.stringify(capabilityId ?? null)}, which is not in the committed vocabulary.`,
    });
  }

  const effects = [];
  const droppedEffects = [];
  const resolvedTargets = [];
  for (const effect of Array.isArray(record.effects) ? record.effects : []) {
    const type = effect?.type;
    if (!EFFECT_TYPES.has(type)) {
      droppedEffects.push({ effect, reason: 'unknown_effect_type' });
      continue;
    }
    const missing = EFFECT_REQUIRED.get(type).filter((field) => effect[field] === undefined);
    if (missing.length) {
      droppedEffects.push({ effect, reason: `missing_${missing.join('_and_')}` });
      continue;
    }
    if (type === 'state_entered' && effect.to !== toState) {
      // The recorder refuses this outright, so seeing it means the log was edited or written
      // by another producer. Either way the two accounts cannot both be true.
      findings.push({
        code: 'effect_contradicts_destination',
        severity: 'error',
        basis: 'self_contradiction',
        detail: `a state_entered effect says ${JSON.stringify(effect.to)} while to_state is ${JSON.stringify(toState)}.`,
      });
      continue;
    }
    if (type === 'request') {
      // No API entities are modelled yet, so a request effect would dangle (invariant 2).
      droppedEffects.push({ effect, reason: 'api_not_modelled' });
      continue;
    }
    // `transition.schema.json#/$defs/effect` is closed: carrying a key the schema does not
    // list would make the committed graph an invalid document, and this is the last place
    // where the run's shorthand can be translated.
    const carried = {};
    for (const key of EFFECT_KEYS) {
      if (effect[key] !== undefined) carried[key] = effect[key];
    }
    if (carried.severity !== undefined && !SEVERITIES.has(carried.severity)) delete carried.severity;
    const resolvedTarget = resolveEffectTarget(carried, ctx);
    if (resolvedTarget) resolvedTargets.push({ effect: type, purpose: effect.target, element: resolvedTarget });
    else if (ELEMENT_TARGET_EFFECTS.has(carried.type) && typeof carried.target === 'string' && !ctx.elementIds.has(carried.target)) {
      // An element-shaped effect whose target is neither a declared element id nor a purpose that
      // resolves to one. `effect.target` is typed as a plain string, so this is legal JSON that
      // means nothing — and an effect nothing can be checked against is a claim the graph cannot
      // keep. Dropped, counted, and said out loud rather than carried as a decorative string.
      droppedEffects.push({ effect, reason: 'element_target_does_not_resolve' });
      continue;
    }
    effects.push(carried);
  }
  if (resolvedTargets.length) {
    findings.push({
      code: 'effect_targets_resolved',
      severity: 'info',
      basis: 'reference_check',
      detail: `${resolvedTargets.length} effect target(s) were written as a semantic purpose and are carried as the element id: ${resolvedTargets.map((item) => `${item.purpose} → ${item.element}`).join(', ')}.`,
    });
  }
  if (droppedEffects.length) {
    findings.push({
      code: 'effects_dropped',
      severity: 'warning',
      basis: 'reference_check',
      detail: `${droppedEffects.length} effect(s) could not be carried into the graph: ${distinct(droppedEffects.map((item) => item.reason)).join(', ')}.`,
    });
  }

  const assertions = [];
  const droppedAssertions = [];
  for (const entry of Array.isArray(record.assertions) ? record.assertions : []) {
    const result = normalizeAssertion(entry, ctx);
    if (result.assertion) assertions.push(result.assertion);
    else droppedAssertions.push({ entry, reason: result.dropped, detail: result.detail ?? null });
  }
  if (droppedAssertions.length) {
    findings.push({
      code: 'assertions_dropped',
      severity: 'warning',
      basis: 'reference_check',
      detail: `${droppedAssertions.length} assertion(s) referenced something the graph does not declare and were not carried over: ${distinct(droppedAssertions.map((item) => item.reason)).join(', ')}.`,
    });
  }

  const apis = distinct(Array.isArray(record.apis) ? record.apis : []).filter((api) => ctx.apiIds.has(api));
  const droppedApis = (Array.isArray(record.apis) ? record.apis : []).filter((api) => !ctx.apiIds.has(api));
  if (droppedApis.length) {
    findings.push({
      code: 'api_references_dropped',
      severity: 'warning',
      basis: 'reference_check',
      detail: `these api ids are not modelled in the graph and the references were not carried over: ${droppedApis.join(', ')}.`,
    });
  }

  const severity = SEVERITY_OF(findings);
  const decision = severity === 'error' ? 'rejected' : 'committed';
  const blocking = findings.filter((finding) => finding.severity === 'error');
  // The reason a candidate is refused is the recorder's own note when there is one, because
  // that note was written at the moment of the step, by the machinery, next to the numbers
  // that produced it. A reference check failing later is a symptom; the note is the diagnosis.
  const primary = blocking.find((finding) => finding.basis === 'recorder_note') ?? blocking[0];

  return {
    decision,
    severity,
    findings,
    effects,
    assertions,
    apis,
    dropped: { effects: droppedEffects, assertions: droppedAssertions, apis: droppedApis },
    resolved_targets: resolvedTargets,
    rejection_reason: decision === 'rejected' ? (primary?.code ?? 'unspecified') : null,
    rejection_basis: decision === 'rejected' ? (primary?.basis ?? null) : null,
  };
}

/** Metadata for a committed object: the decision, in the schema's own bookkeeping layer. */
const commitMetadata = ({ status, confidence, producer, createdAt, extra }) => {
  const metadata = { status, producer };
  if (typeof confidence === 'number') metadata.confidence = confidence;
  if (createdAt) metadata.created_at = createdAt;
  metadata.extra = extra;
  return metadata;
};

/**
 * Reconcile a run's logs into a graph.
 *
 * Pure: it reads nothing from disk and writes nothing. `commitRun` does the I/O, so the
 * decisions can be tested against fixture logs without a filesystem or a browser — which
 * matters more here than anywhere else in the plugin, because these are the rules that
 * decide what the finished graph claims.
 */
export function reconcile({ dir = null, run, observations = [], states = [], capabilities = [], transitions = [], now = new Date(), command = 'graph_commit' }) {
  const generatedAt = now.toISOString();
  const findings = [];
  const gates = [];
  const report = {
    generated_at: generatedAt,
    command,
    run_dir: dir,
    application: run.application ?? null,
    start_url: run.start_url ?? null,
    instruction: run.instruction ?? null,
    version: { plugin: run.plugin ?? null, model: run.model ?? null, provider: run.provider ?? null },
  };

  // --- the gate that the declared application exists for ------------------
  if (!run.application || !run.application.id || !run.application.name) {
    gates.push({
      code: 'application_not_declared',
      severity: 'error',
      detail: 'run.json carries no application, and nothing in the evidence can supply one: a host is where an app is served, not what it is. Declare it in the plugin config (`application: {id, name}`) and run an exploration, or commit a run that was made with it declared.',
    });
  }

  // --- states: the canonical record is the first sighting ----------------
  const canonicalStates = states.filter((record) => record.kind === 'state');
  const sightings = states.filter((record) => record.kind !== 'state');
  const observationsById = new Map(observations.map((observation) => [observation.id, observation]));

  // Every reading of a state, canonical or repeat, is evidence for it. The store writes a
  // record per reading (a `sighting`), each carrying the observation it was made in — so the
  // graph can say how often a state was confirmed, and by which readings.
  const observationsByState = new Map();
  const sightingsByState = new Map();
  for (const record of [...canonicalStates, ...sightings]) {
    if (!record.state_id || !record.observation_id) continue;
    const list = observationsByState.get(record.state_id) ?? [];
    if (!list.includes(record.observation_id)) list.push(record.observation_id);
    observationsByState.set(record.state_id, list);
    if (record.kind !== 'state') {
      const repeats = sightingsByState.get(record.state_id) ?? [];
      repeats.push(record);
      sightingsByState.set(record.state_id, repeats);
    }
  }

  const stateIds = new Map();
  for (const record of canonicalStates) stateIds.set(record.state_id, record.state_id);
  for (const record of canonicalStates) {
    if (record.id && record.id !== record.state_id) stateIds.set(record.id, record.state_id);
  }

  // Invariant 4 as a check rather than an assumption: the store mints ids from the identity
  // tuple, so a collision means the log was written by something else.
  const byIdentity = new Map();
  for (const record of canonicalStates) {
    const key = record.identity_key ?? JSON.stringify(record.identity ?? {});
    const seen = byIdentity.get(key);
    if (seen) {
      gates.push({
        code: 'state_identity_collision',
        severity: 'error',
        detail: `${seen} and ${record.state_id} share the identity ${key}, so two states claim to be the same situation (invariant 4).`,
      });
    } else {
      byIdentity.set(key, record.state_id);
    }
  }

  // --- the element registry, which is what makes a reference resolvable ---
  // --- the element registry, which is what makes a reference resolvable ---
  //
  // An element's id is derived from its purpose, and §14.1 requires element ids to be unique
  // across *all* states — but the schema also keeps elements embedded per state, because the
  // same semantic element (the login form's email field) genuinely appears in several states.
  // Those two facts together mean one purpose must have exactly ONE owning declaration, and the
  // other states that saw it are recorded on it rather than beside it. Without that, invariant 1
  // fails the moment a model walks two states that share a form, which is most of them.
  //
  // The owner is the first state to declare the purpose, in the order the states were first seen:
  // the state where the element was actually first observed. Deterministic, and it does not need
  // the commit to have an opinion about which of two states is the better home.
  const elementIdByPurpose = new Map();
  const declarations = new Map();
  const stateElements = new Map();
  // A state's elements are the union of what the canonical record and every repeat reading of it
  // declared. A repeat reading is a reading of the *same* state, so an element it saw and the
  // canonical record did not is still an element of that state — the canonical record being first
  // is not the same as being complete, and treating it as complete would drop real elements (and
  // then drop the effects that point at them).
  const declaredInState = new Map();
  for (const record of [...canonicalStates, ...sightings]) {
    if (!record.state_id) continue;
    const purposes = declaredInState.get(record.state_id) ?? [];
    for (const element of Array.isArray(record.elements) ? record.elements : []) {
      const purpose = element?.semantic_purpose;
      if (typeof purpose === 'string' && ELEMENT_PURPOSE_PATTERN.test(purpose) && !purposes.some((entry) => entry.purpose === purpose)) {
        purposes.push({ purpose, element, from: record.observation_id ?? null, canonical: record.kind === 'state' });
      }
    }
    declaredInState.set(record.state_id, purposes);
  }
  // An element no record declared usable is reported once per purpose, not once per record.
  const droppedPurposes = new Set();
  for (const record of [...canonicalStates, ...sightings]) {
    for (const element of Array.isArray(record.elements) ? record.elements : []) {
      const purpose = element?.semantic_purpose;
      if (typeof purpose === 'string' && ELEMENT_PURPOSE_PATTERN.test(purpose)) continue;
      const key = `${record.state_id}:${JSON.stringify(purpose ?? null)}`;
      if (droppedPurposes.has(key)) continue;
      droppedPurposes.add(key);
      findings.push({
        scope: record.state_id,
        code: 'element_dropped',
        severity: 'warning',
        basis: 'vocabulary',
        detail: `an element was not carried over: semantic_purpose ${JSON.stringify(purpose ?? null)} is missing or is not snake_case, and the purpose is the element's identity (invariant 3 has nothing to resolve without it).`,
      });
    }
  }

  const elementsSeenElsewhere = new Map();
  for (const record of canonicalStates) {
    const elements = [];
    const elsewhere = {};
    for (const { purpose, element, from, canonical } of declaredInState.get(record.state_id) ?? []) {
      const id = elementIdFor(purpose);
      elementIdByPurpose.set(purpose, id);

      const known = declarations.get(purpose);
      if (known) {
        // The element exists; this state sees it. States that see an element without owning its
        // declaration record the fact on themselves, because the declaration can only live in one
        // `elements[]` and a reader of that state should still be told what it saw.
        if (!known.seen_in.includes(record.state_id)) known.seen_in.push(record.state_id);
        if (known.role !== element.role || known.name !== element.name) known.conflicting = true;
        elsewhere[purpose] = known.owner;
        continue;
      }

      const locator = normalizeLocator(element.locator);
      declarations.set(purpose, {
        id,
        purpose,
        owner: record.state_id,
        seen_in: [record.state_id],
        role: typeof element.role === 'string' ? element.role : null,
        name: typeof element.name === 'string' ? element.name : null,
        locator,
        conflicting: false,
        element: null,
      });
      const declaration = declarations.get(purpose);
      const carried = {
        id,
        ...(typeof element.role === 'string' ? { role: element.role } : {}),
        ...(typeof element.name === 'string' ? { name: element.name } : {}),
        semantic: { purpose, ...(typeof element.description === 'string' ? { description: element.description } : {}) },
        ...(locator ? { locator } : {}),
        metadata: commitMetadata({
          status: 'verified',
          producer: 'playwright',
          createdAt: record.first_seen_at ?? undefined,
          extra: {
            observed_in: record.state_id,
            ...(canonical ? {} : { declared_by_a_repeat_reading: from }),
            ...(typeof element.locator === 'string' ? { raw_locator: element.locator } : {}),
          },
        }),
      };
      declaration.element = carried;
      elements.push(carried);
    }
    if (Object.keys(elsewhere).length) elementsSeenElsewhere.set(record.state_id, elsewhere);
    stateElements.set(record.state_id, elements);
  }

  // The same purpose declared by several states, and any of them disagreeing about what it is.
  for (const declaration of declarations.values()) {
    if (declaration.seen_in.length < 2) continue;
    // The other states are recorded on the element itself, not only in the report: a reader of
    // the graph alone can still see that this element appears in more than one state, which is
    // the fact §3.12 keeps elements embedded for.
    declaration.element.metadata.extra.also_declared_in = declaration.seen_in.slice(1);
    findings.push({
      code: 'element_declared_in_several_states',
      severity: declaration.conflicting ? 'warning' : 'info',
      basis: 'schema_invariant',
      detail: `${declaration.id} was declared by ${declaration.seen_in.join(' and ')}. Element ids are unique across all states (§14.1), so it is declared once — in ${declaration.owner}, the state that saw it first — and the other states are listed on it in metadata.extra.also_declared_in.`
        + (declaration.conflicting
          ? ' One of the declarations describes a different element (role/name differ), so the purpose may be naming two things; give them distinct purposes.'
          : ''),
    });
  }

  /**
   * Whether a reading contains an element.
   *
   * Matched on what the capture actually recorded — role and accessible name, or the testid /
   * selector the locator names — because the capture has no `semantic_purpose`: the purpose is
   * the model's word for the element, and the role+name is the page's. This is the only place
   * where a claim in the graph can be checked against a raw reading instead of against another
   * claim, so it is worth the care.
   */
  const elementPresentIn = (capture, declaration) => {
    if (!capture) return null;
    const entries = Array.isArray(capture.interactive) ? capture.interactive : [];
    for (const entry of entries) {
      if (!entry) continue;
      if (declaration.role && declaration.name && entry.role === declaration.role && entry.name === declaration.name) return true;
      const locator = declaration.locator;
      if (!locator) continue;
      if (locator.strategy === 'testid' && entry.testid === locator.value) return true;
      if ((locator.strategy === 'id' || locator.strategy === 'css') && entry.selector === locator.value) return true;
    }
    return false;
  };

  /**
   * What an element-shaped detection entry claims about a reading, or `null` when it claims
   * nothing about one.
   *
   * `absence` is the only claim that wants the element gone; every other element-bound check
   * asserts the element is there to be checked.
   */
  const elementClaim = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type === 'absence') {
      const purpose = typeof entry.element === 'string' ? entry.element : entry.target;
      return typeof purpose === 'string' ? { purpose, want: 'absent' } : null;
    }
    if (entry.type === 'element_state' || entry.type === 'element_value') {
      const purpose = entry.element !== undefined ? entry.element : entry.target;
      return typeof purpose === 'string' ? { purpose, want: 'present' } : null;
    }
    return null;
  };

  const ctx = {
    stateIds,
    elementIdByPurpose,
    elementIds: new Set(elementIdByPurpose.values()),
    declarations,
    capabilityIds: new Set(capabilities.map((record) => record.capability_id ?? record.id).filter(Boolean)),
    apiIds: new Set(), // no API entities are modelled yet; see `request` effects in `judge`
  };

  // --- transitions: group the candidates, then decide each group ----------
  const groups = new Map();
  for (const record of transitions) {
    const id = record.transition_id ?? record.id;
    if (!id) {
      findings.push({
        scope: 'transitions',
        code: 'transition_without_id',
        severity: 'warning',
        basis: 'log_shape',
        detail: 'a transition record has no id and could not be reconciled.',
      });
      continue;
    }
    const list = groups.get(id) ?? [];
    list.push(record);
    groups.set(id, list);
  }

  const decisions = [];
  const committedEdges = [];
  const attemptsByCapability = new Map();

  for (const [id, candidates] of groups) {
    const judged = candidates.map((record) => ({ record, ...judge(record, ctx) }));

    // Every judgement about an edge is also a finding of the run. `decisions[]` is the per-edge
    // rollup a reader wants when asking "what happened to this edge"; `findings[]` is the flat log
    // a reader wants when asking "what did this commit complain about". Two views of one decision,
    // and the flat one has to be complete or a dropped assertion on a committed edge would be
    // visible in neither.
    for (const item of judged) {
      for (const finding of item.findings) findings.push({ ...finding, scope: id });
    }

    // A group exists because the same edge was walked more than once, or because two records
    // claimed the same id. The best candidate is the one to keep: a clean walk of an edge is
    // stronger evidence for it than a version of the same edge the recorder complained about.
    const rank = (item) => [
      item.decision === 'committed' ? 0 : 1,
      item.findings.filter((finding) => finding.severity === 'warning').length,
      item.record.recorded_at ?? '',
    ];
    const ordered = [...judged].sort((a, b) => {
      const left = rank(a);
      const right = rank(b);
      for (let index = 0; index < left.length; index++) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
      }
      return 0;
    });
    const [winner, ...rest] = ordered;

    for (const loser of rest) {
      decisions.push({
        transition_id: id,
        candidate_recorded_at: loser.record.recorded_at ?? null,
        capability: loser.record.action?.capability ?? null,
        from_state: loser.record.from_state ?? null,
        to_state: loser.record.to_state ?? null,
        decision: 'superseded',
        superseded_by: winner.record.recorded_at ?? null,
        reason: loser.decision === 'rejected'
          ? 'the same edge was walked again without the recorder’s objection'
          : 'a repeat of the same edge; the step is in the walk, but one edge is one edge',
        findings: loser.findings,
      });
    }

    const capabilityId = winner.record.action?.capability ?? null;
    if (capabilityId) {
      const attempts = attemptsByCapability.get(capabilityId) ?? [];
      attempts.push({
        transition_id: id,
        from_state: winner.record.from_state ?? null,
        to_state: winner.record.to_state ?? null,
        decision: winner.decision,
        severity: winner.severity,
        recorded_at: winner.record.recorded_at ?? null,
        rejection_reason: winner.rejection_reason,
      });
      attemptsByCapability.set(capabilityId, attempts);
    }

    const verdict = {
      transition_id: id,
      capability: capabilityId,
      from_state: winner.record.from_state ?? null,
      to_state: winner.record.to_state ?? null,
      decision: winner.decision,
      status: TRANSITION_DECISIONS.get(winner.decision),
      severity: winner.severity,
      warnings: winner.findings,
      rejection_reason: winner.rejection_reason,
      rejection_basis: winner.rejection_basis,
      evidence: winner.record.evidence ?? [],
      candidates: candidates.length,
    };
    decisions.push(verdict);

    if (winner.decision !== 'committed') continue;

    // The edge's evidence is the readings the walk attached to it, and the recorder writes those
    // as `evidenceRef`s already (`{observation, role, note}`), so this is a filter rather than a
    // construction: keep the refs that name a reading this run actually has, in a role the schema
    // knows. A ref to a reading that is not in the log is reported rather than carried, because a
    // pointer into nothing is worse than no pointer.
    const edgeEvidence = [];
    const seenEvidence = new Set();
    const candidateEvidence = Array.isArray(winner.record.evidence) ? winner.record.evidence : [];
    for (const ref of candidateEvidence) {
      const observationId = typeof ref === 'string' ? ref : ref?.observation;
      if (!observationId) continue;
      if (!observationsById.has(observationId)) {
        findings.push({
          scope: id,
          code: 'evidence_ref_does_not_resolve',
          severity: 'warning',
          basis: 'evidence',
          detail: `the edge names ${observationId} as evidence and no such reading is in observations.jsonl. The reference was dropped: the graph points at readings that exist.`,
        });
        continue;
      }
      const role = typeof ref === 'object' && EVIDENCE_ROLES.has(ref.role) ? ref.role : 'unknown';
      const key = `${observationId}:${role}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      edgeEvidence.push({
        observation: observationId,
        role,
        ...(typeof ref?.note === 'string' && ref.note ? { note: ref.note } : {}),
      });
    }
    // `before_observation` / `after_observation` are the other way the recorder has named an
    // edge's readings; accepted so an older or newer log shape does not lose its evidence.
    for (const [field, role] of [['before_observation', 'identity'], ['after_observation', 'action']]) {
      const observationId = winner.record[field];
      if (!observationId || !observationsById.has(observationId)) continue;
      const key = `${observationId}:${role}`;
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      edgeEvidence.push({ observation: observationId, role });
    }

    committedEdges.push({
      id,
      // `transition_id` is the log's key for the candidate and would be a second name for the
      // same thing in the graph; the schema forbids properties it does not know, and it is right
      // to: the edge is `id`, and the log is where the other spelling lives.
      from_state: winner.record.from_state,
      to_state: winner.record.to_state,
      action: {
        capability: capabilityId,
        ...(winner.record.action?.arguments && Object.keys(winner.record.action.arguments).length
          ? { arguments: winner.record.action.arguments }
          : {}),
        ...(winner.record.action?.target ? { target: winner.record.action.target } : {}),
      },
      ...(typeof winner.record.description === 'string' && winner.record.description ? { description: winner.record.description } : {}),
      ...(typeof winner.record.guard === 'string' && winner.record.guard ? { guard: winner.record.guard } : {}),
      effects: winner.effects,
      ...(winner.assertions.length ? { assertions: winner.assertions } : {}),
      ...(winner.apis.length ? { apis: winner.apis } : {}),
      ...(Array.isArray(winner.record.preconditions) && winner.record.preconditions.length
        ? { preconditions: winner.record.preconditions }
        : {}),
      ...(edgeEvidence.length ? { evidence: edgeEvidence } : {}),
      metadata: commitMetadata({
        status: TRANSITION_DECISIONS.get(winner.decision),
        confidence: winner.severity === 'warning' ? 0.5 : 1,
        producer: run.model ? `llm:${run.model}` : 'llm',
        createdAt: winner.record.recorded_at ?? undefined,
        extra: {
          commit: {
            decision: winner.decision,
            severity: winner.severity,
            candidate_id: id,
            candidates_seen: candidates.length,
            warnings: winner.findings,
            rejection_reason: winner.rejection_reason,
            rejection_basis: winner.rejection_basis,
            dropped: winner.dropped,
          },
          recorder: {
            observed_change: winner.record.observed_change ?? null,
            chain_break: winner.record.chain_break ?? null,
            notes: Array.isArray(winner.record.notes) ? winner.record.notes.length : 0,
            evidence: winner.record.evidence ?? [],
          },
        },
      }),
    });
  }

  // --- states, now that the committed edges are known --------------------
  const stateRecords = [];
  for (const record of canonicalStates) {
    const observationIds = observationsByState.get(record.state_id) ?? [];
    const bound = observationIds.map((id) => observationsById.get(id)).filter(Boolean);
    const { route, routes } = routeForState(bound);
    // `state.identity.page_type` is required and patterned, so a page type the alphabet rejects
    // makes the whole document invalid. Gate rather than rewrite: the page type is the model's
    // judgement about what kind of screen this is, and there is no mechanical fix for it.
    if (typeof record.identity?.page_type !== 'string' || !PAGE_TYPE_PATTERN.test(record.identity.page_type)) {
      gates.push({
        code: 'state_page_type_not_usable',
        severity: 'error',
        detail: `${record.state_id} has identity.page_type ${JSON.stringify(record.identity?.page_type ?? null)}, which is required and must be snake_case (state.schema.json), e.g. "login" or "product_detail".`,
      });
    }
    if (routes.length > 1) {
      findings.push({
        scope: record.state_id,
        code: 'state_seen_at_several_routes',
        severity: 'warning',
        basis: 'identity',
        detail: `this identity was read at ${routes.join(', ')}. identity.route is left out rather than chosen: it discriminates states, and picking one of two answers would pin a route the state does not have. Add a dimension if they really are different states (invariant 4).`,
      });
    }

    const detection = [];
    const droppedDetection = [];
    const refutedDetection = [];
    const pinnedDetection = [];
    // The state's own route, so a `{type: "url"}` detection can be pinned to the address its
    // readings were taken at instead of being refused for not naming one.
    const stateCtx = { ...ctx, route };
    for (const entry of Array.isArray(record.detection) ? record.detection : []) {
      // The one check in the whole commit that compares a claim in the graph against a raw
      // reading rather than against another claim. A state's detection is a predicate that has to
      // hold *wherever the state is* — that is what makes it a detection — so a claim its own
      // evidence refutes is refused, and refused loudly: a detection that is false at one of the
      // state's readings produces a test that fails on arrival, which is worse than a missing
      // assertion because it looks like a passing graph.
      const claim = elementClaim(entry);
      const declaration = claim ? declarations.get(claim.purpose) : null;
      if (declaration) {
        const verdicts = bound
          .map((observation) => ({ observation, present: elementPresentIn(observation.capture, declaration) }))
          .filter((verdict) => verdict.present !== null);
        const refuting = verdicts.filter((verdict) => (claim.want === 'present' ? verdict.present === false : verdict.present === true));
        if (refuting.length) {
          refutedDetection.push({
            entry,
            purpose: claim.purpose,
            want: claim.want,
            observations: refuting.map((verdict) => verdict.observation.id),
            readings: verdicts.length,
          });
          continue;
        }
        // `element_value` names a value the element should hold. Presence is checked above; the
      // value itself is the model's shorthand (`filled` for a password) and is not compared here,
        // because deciding that `filled` means "non-empty" is judgement, not validation. A value
        // that plainly differs from the capture is noted and kept.
        if (entry.type === 'element_value' && typeof (entry.value ?? entry.expected) === 'string') {
          const expected = entry.value ?? entry.expected;
          const recorded = verdicts
            .map((verdict) => (verdict.observation.capture?.interactive ?? [])
              .find((item) => item && item.name === declaration.name && item.role === declaration.role)?.value)
            .filter((value) => typeof value === 'string');
          if (recorded.length && !recorded.includes(expected)) {
            findings.push({
              scope: record.state_id,
              code: 'detection_value_not_in_evidence',
              severity: 'info',
              basis: 'evidence_check',
              detail: `detection expects ${JSON.stringify(declaration.purpose)} to hold ${JSON.stringify(expected)}, while the captures recorded ${JSON.stringify(recorded[0])}. Carried as written — this may be a summary rather than a literal — but a generator would turn it into an assertion that fails.`,
            });
          }
        }
      }
      const result = normalizeAssertion(entry, stateCtx);
      if (result.assertion) detection.push(result.assertion);
      else droppedDetection.push({ entry, reason: result.dropped, detail: result.detail ?? null });
      if (result.pinned) pinnedDetection.push(result.pinned);
    }
    if (pinnedDetection.length) {
      findings.push({
        scope: record.state_id,
        code: 'detection_url_pinned_to_route',
        severity: 'info',
        basis: 'evidence_check',
        detail: `${distinct(pinnedDetection).join(', ')} was written as a bare url detection, so the expected value is the route this state's readings were actually taken at — read from the captures, not typed.`, 
      });
    }
    if (refutedDetection.length) {
      findings.push({
        scope: record.state_id,
        code: 'detection_refuted_by_evidence',
        severity: 'error',
        basis: 'evidence_check',
        detail: refutedDetection.map((refuted) => {
          const readings = `${refuted.observations.join(', ')} of ${refuted.readings} reading(s)`;
          return `${JSON.stringify(refuted.purpose)} is claimed ${refuted.want} in this state, but ${readings} bound to it show the opposite`;
        }).join('; ')
          + '. The claim was not carried into `detection`: a detection that is false at one of the state\'s own readings fails a test on arrival. If the readings really are one state, record a detection that holds in all of them; if they are two states, their identity has to distinguish them (§5.1, invariant 4).',
      });
    }
    if (droppedDetection.length) {
      findings.push({
        scope: record.state_id,
        code: 'detection_dropped',
        severity: 'warning',
        basis: 'reference_check',
        detail: `${droppedDetection.length} detection entry/entries could not be carried over: ${distinct(droppedDetection.map((item) => item.reason)).join(', ')}. A state is only as assertable as its detection.`,
      });
    }
    // Invariant 7 is a gate, not a warning: a state with no detection cannot be asserted, so
    // it cannot appear in a generated test, and committing it would produce a graph that
    // looks complete and is not.
    if (!detection.length) {
      gates.push({
        code: 'state_without_detection',
        severity: 'error',
        detail: `${record.state_id} has no detection left after reconciliation (invariant 7). Give it at least one entry that resolves, e.g. {"type":"url","operator":"matches","expected":"/projects"}.`,
      });
    }

    // An element list is an inventory, not a predicate, so an element no reading shows is noted
    // rather than removed: the captures list interactive elements, and one that is in the DOM but
    // outside that list would be a capture limit misread as a defect. It is worth saying anyway,
    // because the alternative explanation is an element nothing observed.
    const unsupportedElements = (stateElements.get(record.state_id) ?? []).filter((element) => {
      const declaration = declarations.get(element.semantic.purpose);
      if (!declaration) return false;
      const verdicts = bound.map((observation) => elementPresentIn(observation.capture, declaration)).filter((present) => present !== null);
      return verdicts.length > 0 && verdicts.every((present) => present === false);
    });
    if (unsupportedElements.length) {
      findings.push({
        scope: record.state_id,
        code: 'element_not_seen_in_evidence',
        severity: 'info',
        basis: 'evidence_check',
        detail: `no reading bound to this state lists ${unsupportedElements.map((element) => element.id).join(', ')} in its interactive surface. Carried because an element list is an inventory rather than a claim about every moment, but the capture (or the element) is worth a second look.`,
      });
    }

    const outgoing = committedEdges.filter((edge) => edge.from_state === record.state_id).map((edge) => edge.id);
    const available = distinct(committedEdges
      .filter((edge) => edge.from_state === record.state_id)
      .map((edge) => edge.action.capability));

    const identity = {
      ...(route ? { route } : {}),
      page_type: record.identity?.page_type,
      ...(record.identity?.variant ? { variant: record.identity.variant } : {}),
      ...(record.identity?.dimensions && Object.keys(record.identity.dimensions).length
        ? { dimensions: record.identity.dimensions }
        : {}),
    };

    stateRecords.push({
      id: record.state_id,
      identity,
      ...(typeof record.summary === 'string' && record.summary ? { description: record.summary } : {}),
      ...(stateElements.get(record.state_id)?.length ? { elements: stateElements.get(record.state_id) } : {}),
      ...(available.length ? { capabilities: available } : {}),
      ...(outgoing.length ? { outgoing_transitions: outgoing } : {}),
      detection,
      ...(observationIds.length
        ? { evidence: observationIds.map((observationId) => ({ observation: observationId, role: 'identity' })) }
        : {}),
      metadata: commitMetadata({
        status: 'verified',
        confidence: typeof record.confidence === 'number' ? record.confidence : 1,
        producer: run.model ? `llm:${run.model}` : 'llm',
        createdAt: record.first_seen_at ?? undefined,
        extra: {
          commit: { decision: 'committed', candidate_id: record.state_id, readings: observationIds.length },
          identity_key: record.identity_key ?? null,
          // The store's own record kind is `state`, which is not one of `state.schema.json`'s
          // kinds (page, modal, ...). Left unset rather than mapped onto a value the model
          // never chose; the schema default applies and the original is recorded here.
          observed_record_kind: record.kind ?? null,
          dropped_detection: droppedDetection,
          // Elements this state was seen with whose declaration lives in another state's
          // `elements[]`. The schema keeps element ids unique across all states, so a shared
          // element is declared once; this is how the states that merely *saw* it still say so.
          ...(elementsSeenElsewhere.has(record.state_id)
            ? { elements_declared_elsewhere: elementsSeenElsewhere.get(record.state_id) }
            : {}),
        },
      }),
    });
  }
  for (const record of canonicalStates) {
    if (observationIdsForState(observationsByState, record.state_id).length === 0) {
      findings.push({
        scope: record.state_id,
        code: 'state_without_observation',
        severity: 'warning',
        basis: 'evidence',
        detail: 'this state is not bound to any observation, so nothing in the raw evidence justifies it (invariant 8).',
      });
    }
  }

  // --- capabilities: the vocabulary, with every attempt kept -------------
  // Evidence is observations, not transitions. `common.schema.json#/$defs/evidenceRef` points at
  // a raw Observation and nothing else, so a capability's evidence is the readings its committed
  // edges were made from — the transition ids live in `report.capabilities.attempts`, which is the
  // commit's own account and not part of the graph.
  const evidenceByCapability = new Map();
  for (const edge of committedEdges) {
    const list = evidenceByCapability.get(edge.action.capability) ?? [];
    for (const ref of edge.evidence ?? []) {
      if (ref.observation) list.push({ observation: ref.observation, role: ref.role });
    }
    evidenceByCapability.set(edge.action.capability, list);
  }
  const dedupeEvidence = (refs) => {
    const seen = new Map();
    for (const ref of refs) {
      const key = JSON.stringify([ref.observation, ref.role]);
      if (!seen.has(key)) seen.set(key, ref);
    }
    return [...seen.values()];
  };
  const capabilityRecords = capabilities.map((record) => {
    const id = record.capability_id ?? record.id;
    const attempts = attemptsByCapability.get(id) ?? [];
    const committed = attempts.filter((attempt) => attempt.decision === 'committed');
    const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
    const input = plain(record.input);
    const output = plain(record.output);
    return {
      id,
      name: record.name,
      ...(typeof record.description === 'string' && record.description ? { description: record.description } : {}),
      ...(CAPABILITY_KINDS.has(record.capability_kind) ? { kind: record.capability_kind } : {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(Array.isArray(record.aliases) && record.aliases.length ? { aliases: record.aliases.filter((alias) => typeof alias === 'string') } : {}),
      ...(evidenceByCapability.get(id)?.length
        ? { evidence: dedupeEvidence(evidenceByCapability.get(id)) }
        : {}),
      metadata: commitMetadata({
        status: committed.length ? 'verified' : 'inferred',
        confidence: committed.length ? 1 : 0.5,
        producer: run.model ? `llm:${run.model}` : 'llm',
        createdAt: record.first_seen_at ?? undefined,
        extra: {
          commit: {
            decision: committed.length ? 'committed' : 'inferred',
            attempts: attempts.length,
            committed_edges: committed.length,
          },
          vocabulary_notes: record.notes ?? [],
          minted_by: 'graph_transition (first use of the name)',
        },
      }),
    };
  });

  // A capability whose every attempt was refused is still vocabulary — it was named, and
  // hiding it would lose the fact that the run tried. It is committed as `inferred`, with no
  // edges, and said so in the report.

  // --- observations, with the state each one was read as -----------------
  const stateByObservation = new Map();
  for (const record of [...canonicalStates, ...sightings]) {
    if (record.observation_id && record.state_id) stateByObservation.set(record.observation_id, record.state_id);
  }
  // An observation points at the edge it participated in, and only a *committed* edge exists as
  // far as the graph is concerned: a reading that was part of a refused walk is still evidence of
  // a state, but pointing it at an edge the graph refused would be a dangling reference.
  // An observation can sit on two edges — the reading a walk produced is the reading the next walk
  // started from — and `observation.transition` is a single field. The edge the reading *produced*
  // claims it: `action` and `effect` refs beat `identity`, and the first edge to claim a reading
  // wins a tie, so the answer does not depend on map iteration order.
  const EVIDENCE_ROLE_RANK = { action: 2, effect: 2 };
  const transitionByObservation = new Map();
  for (const edge of committedEdges) {
    for (const ref of edge.evidence ?? []) {
      const rank = EVIDENCE_ROLE_RANK[ref.role] ?? (ref.role === 'unknown' ? 0 : 1);
      const held = transitionByObservation.get(ref.observation);
      if (held && held.rank >= rank) continue;
      transitionByObservation.set(ref.observation, { transition: edge.id, rank });
    }
  }

  const observationRecords = observations.map((observation, index) => {
    const capture = observation.capture ?? null;
    // `screenshot` is an artifact path, and the schema's own example is relative
    // (`artifacts/obs_001.png`). Relative to the run directory, so the graph and its evidence
    // stay movable together; a shot outside the run is recorded by full path in metadata
    // rather than as a relative path that would leave the run.
    let screenshot = null;
    let externalArtifact = null;
    if (typeof observation.screenshot === 'string' && observation.screenshot) {
      const relativePath = dir ? relative(dir, observation.screenshot) : observation.screenshot;
      if (dir && (relativePath.startsWith('..') || relativePath.startsWith('/'))) externalArtifact = observation.screenshot;
      else screenshot = relativePath;
    }
    const consoleEntries = (Array.isArray(capture?.console) ? capture.console : [])
      .filter((entry) => entry && typeof entry.text === 'string')
      .map((entry) => ({ level: ['log', 'info', 'debug', 'warn', 'error'].includes(entry.level) ? entry.level : 'log', text: entry.text }));
    const network = (Array.isArray(capture?.network) ? capture.network : [])
      .filter((entry) => entry && typeof entry.url === 'string')
      .map((entry) => ({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(entry.method) ? entry.method : 'GET',
        url: entry.url,
        ...(Number.isInteger(entry.status) ? { status: entry.status } : {}),
        ...(Number.isInteger(entry.duration_ms) ? { duration_ms: entry.duration_ms } : {}),
        ...(entry.failed === true ? { failed: true } : {}),
        ...(typeof entry.failure_reason === 'string' ? { failure_reason: entry.failure_reason } : {}),
      }));
    const statusTexts = (Array.isArray(capture?.status) ? capture.status : [])
      .map((entry) => entry?.text)
      .filter((text) => typeof text === 'string' && text);
    return {
      id: observation.id,
      type: 'browser_state',
      timestamp: observation.recorded_at,
      ...(typeof capture?.url === 'string' ? { url: capture.url } : {}),
      ...(typeof capture?.title === 'string' && capture.title ? { title: capture.title } : {}),
      ...(stateByObservation.has(observation.id) ? { state: stateByObservation.get(observation.id) } : {}),
      ...(transitionByObservation.has(observation.id) ? { transition: transitionByObservation.get(observation.id).transition } : {}),
      ...(index > 0 && observations[index - 1]?.id ? { parent: observations[index - 1].id } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(statusTexts.length ? { text_content: statusTexts.join(' · ') } : {}),
      ...(consoleEntries.length ? { console: consoleEntries } : {}),
      ...(Array.isArray(capture?.page_errors) && capture.page_errors.length
        ? { page_errors: capture.page_errors.filter((error) => typeof error === 'string') }
        : {}),
      ...(network.length ? { network } : {}),
      collector: {
        tool: 'dsh-browser',
        ...(run.session_id ? { run_id: run.session_id } : {}),
        artifacts_dir: 'evidence',
      },
      metadata: commitMetadata({
        status: 'verified',
        producer: 'playwright',
        createdAt: observation.recorded_at,
        extra: {
          tool: observation.tool ?? null,
          phase: observation.phase ?? null,
          tool_arguments: observation.tool_arguments ?? null,
          capture_error: observation.capture_error ?? null,
          ...(externalArtifact ? { artifact_outside_run: externalArtifact } : {}),
          // The capture records a localStorage snapshot, and `observation.schema.json` has no
          // field for it. It stays in the run log rather than being smuggled into `metadata`,
          // which the schema reserves for bookkeeping and explicitly not for application state.
          storage_captured: capture?.storage && Object.keys(capture.storage).length
            ? Object.keys(capture.storage)
            : [],
        },
      }),
    };
  });

  // --- the graph ---------------------------------------------------------
  const graphWarnings = [];
  for (const finding of findings) {
    graphWarnings.push(`${finding.scope ?? 'run'}: ${finding.code} — ${finding.detail}`);
  }
  for (const decision of decisions.filter((item) => item.decision === 'rejected')) {
    graphWarnings.push(
      `${decision.transition_id} was refused and is not an edge: ${decision.rejection_reason}`
      + `${decision.rejection_basis ? ` (${decision.rejection_basis})` : ''}. The candidate is preserved in transitions.jsonl and in commit_report.json.`,
    );
  }
  if (!run.application?.version) {
    graphWarnings.push('application: no application version was recorded, so this graph cannot be tied to a build — invariant 9 (version coherence) is vacuous here, and evidence from a different build cannot be told apart from this one.');
  }

  // `coverage` is where the graph admits what it does not cover. Optional in the schema and the
  // honest place to say it: a route the walk visited but never turned into a state is a hole, and
  // a hole that is written down is a work item rather than a surprise.
  const visitedRoutes = distinct(observationRecords.map((observation) => routeOf(observation.url)));
  const modelledRoutes = distinct(stateRecords.map((state) => state.identity.route));
  const coverage = {
    visited_routes: visitedRoutes,
    unmodelled_routes: visitedRoutes.filter((route) => !modelledRoutes.includes(route)),
    notes: `${stateRecords.length} state(s) reconciled from ${observations.length} reading(s); `
      + `${committedEdges.length} committed edge(s) from ${transitions.length} candidate(s); `
      + `${sightings.length} repeat reading(s) collapsed.`,
  };

  const graph = {
    schema_version: '0.1',
    generated_at: generatedAt,
    generator: {
      name: run.plugin?.name ?? '@webtestagent/dsh-graph-explorer',
      version: run.plugin?.version ?? 'unknown',
      command,
      notes: 'Assembled by graph_commit from an exploration run. Raw evidence in observations.jsonl is unchanged; this file is derived and can be rebuilt.',
    },
    application: run.application
      ? {
        id: run.application.id,
        name: run.application.name,
        // A version is never derived (there is nothing in a page that says what build it is), but
        // when something upstream recorded one it is carried: invariant 9 can only compare the
        // application's version with what the observations claim if the version is in the graph.
        ...(run.application.version ? { version: run.application.version } : {}),
        ...(typeof run.start_url === 'string' && run.start_url ? { base_url: run.start_url } : {}),
        metadata: commitMetadata({
          status: 'verified',
          producer: 'manual',
          createdAt: run.started_at ?? undefined,
          extra: {
            declared: { id: 'plugin config `application.id`', name: 'plugin config `application.name`' },
            observed: { base_url: 'run.json `start_url`' },
            note: 'The identity is declared, never derived: the start URL is where this walk happened, not what the application is.',
          },
        }),
      }
      : null,
    features: [],
    capabilities: capabilityRecords,
    states: stateRecords,
    transitions: committedEdges,
    apis: [],
    journeys: [],
    observations: observationRecords,
    coverage,
    warnings: graphWarnings,
  };

  const invariantResults = invariantsOf(graph);
  // An exploration that recorded nothing is not a small graph, it is a missing one, and writing
  // `{states: [], transitions: []}` would look like a committed result. Refused, with the one
  // instruction that helps.
  if (!stateRecords.length && !committedEdges.length) {
    gates.push({
      code: 'nothing_to_commit',
      severity: 'error',
      detail: `${observations.length} reading(s) but no state was ever read for any of them, so there is nothing to reconcile. Read the states with graph_observe (it is what turns a page into a state) before committing.`,
    });
  }
  const blocking = [
    ...gates,
    ...invariantResults.filter((result) => !result.ok && result.severity === 'error').map((result) => ({
      code: result.code,
      severity: 'error',
      detail: result.detail,
    })),
  ];

  report.ok = blocking.length === 0;
  report.blocking = blocking;
  // A document that was written despite a blocking rule (a forced commit) has to carry the rule
  // in its own `warnings[]`: the warning list is what a reader with only graph.json has, and a
  // graph that was refused by its own commit and does not say so is the one lie worth refusing
  // to tell. Prepended in order, so the most serious thing about the document is read first.
  for (const blocker of [...blocking].reverse()) {
    graphWarnings.unshift(`${blocker.severity}: ${blocker.code} — ${blocker.detail}`);
  }
  report.gates = gates;
  report.states = {
    candidates: states.length,
    committed: stateRecords.length,
    deduplicated: sightings.length,
    readings: observationsByState.size,
  };
  report.capabilities = {
    candidates: capabilities.length,
    committed: capabilityRecords.length,
    attempts: Object.fromEntries(attemptsByCapability),
  };
  report.transitions = {
    candidates: transitions.length,
    distinct: groups.size,
    committed: committedEdges.length,
    rejected: decisions.filter((item) => item.decision === 'rejected').length,
    superseded: decisions.filter((item) => item.decision === 'superseded').length,
  };
  report.observations = { records: observations.length, carried: observationRecords.length };
  report.elements = {
    declared: declarations.size,
    conflicts: [...declarations.values()].filter((declaration) => declaration.conflicting).length,
    shared: [...declarations.values()].filter((declaration) => declaration.seen_in.length > 1).length,
  };
  report.notes = [
    '`ok` and `blocking` describe the graph document: `blocking` is the gates plus the failed error-severity invariants, and `graph.json` is written only when it is empty.',
    '`findings[].severity` describes the candidate record, not the document: `error` means a claim was refused (and the refusal is the repair), `warning` means something was dropped or weakened, `info` means it was noted and carried through.',
    'The raw logs are not touched by a commit. Every record this report judged is still in the run directory exactly as the walk wrote it, which is why a rejected candidate can be re-judged later without re-walking anything.',
    'One candidate does not become one edge: candidates sharing a `transition_id` are the same edge walked more than once, and only the best of them is committed. `decisions[]` records what happened to the rest.',
  ];

  report.decisions = decisions;
  report.findings = findings;
  report.invariants = invariantResults;
  report.warnings = graphWarnings;

  // `draft` is the document that was assembled whether or not it is allowed to be written. It is
  // not part of the report — a report that embedded the graph would be as big as the graph — but
  // it is what a forced commit writes, and what an invariant's detail can be read against.
  return { graph: blocking.length ? null : graph, draft: graph, report, invariants: invariantResults };
}

const observationIdsForState = (map, stateId) => map.get(stateId) ?? [];

/**
 * The invariants from §14 that this graph can be checked against.
 *
 * Reported, not assumed, and reported in full: a graph that has an unreachable state is not
 * a graph with a bug, it is a graph of a partial walk, and the difference matters to whoever
 * reads the report. Only the ones that make the document *wrong* rather than *incomplete*
 * are errors, and those also gate the commit.
 */
export function invariantsOf(graph) {
  const results = [];
  const states = graph.states ?? [];
  const transitions = graph.transitions ?? [];
  const capabilities = graph.capabilities ?? [];
  const stateIds = new Set(states.map((state) => state.id));

  // 1. uniqueness, including element ids across every state.
  const seenIds = new Map();
  const elementIds = new Map();
  const duplicates = [];
  for (const [scope, list] of [['states', states], ['transitions', transitions], ['capabilities', capabilities], ['observations', graph.observations ?? []]]) {
    for (const item of list) {
      if (!item?.id) continue;
      const known = seenIds.get(item.id);
      if (known) duplicates.push(`${item.id} appears in both ${known} and ${scope}`);
      else seenIds.set(item.id, scope);
    }
  }
  for (const state of states) {
    for (const element of state.elements ?? []) {
      if (!element?.id) continue;
      const known = elementIds.get(element.id);
      if (known) duplicates.push(`${element.id} is declared by both ${known} and ${state.id}`);
      else elementIds.set(element.id, state.id);
    }
  }
  results.push({
    code: 'unique_ids',
    name: '§14.1 uniqueness',
    severity: 'error',
    ok: duplicates.length === 0,
    detail: duplicates.length ? duplicates.join('; ') : `${seenIds.size} entity ids and ${elementIds.size} element ids are unique.`,
  });

  // 2. dangling references.
  const dangling = [];
  const observationIds = new Set((graph.observations ?? []).map((observation) => observation.id));
  for (const transition of transitions) {
    if (!stateIds.has(transition.from_state)) dangling.push(`${transition.id}.from_state → ${transition.from_state}`);
    if (!stateIds.has(transition.to_state)) dangling.push(`${transition.id}.to_state → ${transition.to_state}`);
    if (!capabilities.some((capability) => capability.id === transition.action?.capability)) {
      dangling.push(`${transition.id}.action.capability → ${transition.action?.capability}`);
    }
    for (const evidence of transition.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.observation;
      if (id && !observationIds.has(id)) dangling.push(`${transition.id}.evidence → ${id}`);
    }
    for (const effect of transition.effects ?? []) {
      if (effect.type === 'state_entered' && effect.to && !stateIds.has(effect.to)) dangling.push(`${transition.id} effect → ${effect.to}`);
    }
  }
  for (const state of states) {
    for (const capabilityId of state.capabilities ?? []) {
      if (!capabilities.some((capability) => capability.id === capabilityId)) dangling.push(`${state.id}.capabilities → ${capabilityId}`);
    }
    for (const transitionId of state.outgoing_transitions ?? []) {
      if (!transitions.some((transition) => transition.id === transitionId)) dangling.push(`${state.id}.outgoing_transitions → ${transitionId}`);
    }
    for (const evidence of state.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.observation;
      if (id && !observationIds.has(id)) dangling.push(`${state.id}.evidence → ${id}`);
    }
  }
  for (const capability of capabilities) {
    for (const evidence of capability.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.transition;
      if (id && !transitions.some((transition) => transition.id === id)) dangling.push(`${capability.id}.evidence → ${id}`);
    }
  }
  results.push({
    code: 'no_dangling_references',
    name: '§14.2 dangling references',
    severity: 'error',
    ok: dangling.length === 0,
    detail: dangling.length ? dangling.slice(0, 12).join('; ') : 'every id that is referenced exists.',
  });

  // 3. element reachability. `transition.schema.json#/$defs/effect` types its `target` as a plain
  // string, so "looks like an element" is not the test: the test is whether the effect is *about*
  // an element, and for those the target has to name one that exists.
  const referencedElements = [];
  for (const transition of transitions) {
    if (transition.action?.target) referencedElements.push([`${transition.id}.action.target`, transition.action.target]);
    for (const effect of transition.effects ?? []) {
      if (typeof effect.target !== 'string') continue;
      if (ELEMENT_TARGET_EFFECTS.has(effect.type) || effect.target.startsWith('element_')) {
        referencedElements.push([`${transition.id} ${effect.type}.target`, effect.target]);
      }
    }
    for (const assertion of transition.assertions ?? []) {
      if (assertion.element) referencedElements.push([`${transition.id} assertion.element`, assertion.element]);
    }
  }
  for (const state of states) {
    for (const assertion of state.detection ?? []) {
      if (assertion.element) referencedElements.push([`${state.id} detection.element`, assertion.element]);
    }
  }
  const unreachable = referencedElements.filter(([, id]) => !elementIds.has(id));
  results.push({
    code: 'elements_reachable',
    name: '§14.3 element reachability',
    severity: 'error',
    ok: unreachable.length === 0,
    detail: unreachable.length
      ? unreachable.slice(0, 12).map(([where, id]) => `${where} → ${id}`).join('; ')
      : `${referencedElements.length} element references all resolve to a declared element.`,
  });

  // 4. state identity uniqueness.
  const identities = new Map();
  const collisions = [];
  for (const state of states) {
    const identity = state.identity ?? {};
    const key = JSON.stringify([identity.page_type ?? '', identity.variant ?? '', identity.dimensions ?? {}]);
    if (identities.has(key)) collisions.push(`${identities.get(key)} and ${state.id}`);
    else identities.set(key, state.id);
  }
  results.push({
    code: 'state_identity_unique',
    name: '§14.4 state identity uniqueness',
    severity: 'error',
    ok: collisions.length === 0,
    detail: collisions.length ? collisions.join('; ') : `no two of ${states.length} states share (page_type, variant, dimensions).`,
  });

  // 5. journeys — none are produced yet, so this is vacuous rather than passing.
  results.push({
    code: 'journey_is_a_walk',
    name: '§14.5 journey is a walk',
    severity: 'info',
    ok: true,
    detail: 'no journeys are committed yet, so there is no walk to check.',
  });

  // 6. reachability. A partial walk is expected, so this never gates the commit.
  const incoming = new Map();
  for (const transition of transitions) {
    incoming.set(transition.to_state, (incoming.get(transition.to_state) ?? 0) + 1);
  }
  const entryCandidates = states.filter((state) => !incoming.has(state.id) && !transitions.some((transition) => transition.from_state === state.id));
  const reachable = new Set();
  const queue = states.filter((state) => !incoming.has(state.id)).map((state) => state.id);
  for (const id of queue) reachable.add(id);
  while (queue.length) {
    const current = queue.shift();
    for (const transition of transitions.filter((item) => item.from_state === current)) {
      if (!reachable.has(transition.to_state)) {
        reachable.add(transition.to_state);
        queue.push(transition.to_state);
      }
    }
  }
  const unreachableStates = states.filter((state) => !reachable.has(state.id)).map((state) => state.id);
  const terminals = states.filter((state) => !transitions.some((transition) => transition.from_state === state.id)).map((state) => state.id);
  results.push({
    code: 'reachability',
    name: '§14.6 reachability',
    severity: 'warning',
    ok: unreachableStates.length === 0 && terminals.length === 0,
    detail: [
      unreachableStates.length ? `not reachable from any entry state: ${unreachableStates.join(', ')}` : null,
      terminals.length ? `no outgoing transition: ${terminals.join(', ')}` : null,
      entryCandidates.length ? `entry candidates with neither side: ${entryCandidates.map((state) => state.id).join(', ')}` : null,
    ].filter(Boolean).join('; ') || 'every state is reachable and every state has an outgoing transition.',
  });

  // 7. detection completeness.
  const undetectable = states.filter((state) => !(state.detection ?? []).length).map((state) => state.id);
  results.push({
    code: 'detection_complete',
    name: '§14.7 detection completeness',
    severity: 'error',
    ok: undetectable.length === 0,
    detail: undetectable.length ? `states with no detection: ${undetectable.join(', ')}` : `all ${states.length} states carry detection.`,
  });

  // 8. evidence integrity.
  const unbound = states.filter((state) => !(state.evidence ?? []).length).map((state) => state.id);
  const unsupportedEdges = transitions
    .filter((transition) => {
      const refs = transition.evidence ?? [];
      return !refs.length || refs.some((ref) => !observationIds.has(typeof ref === 'string' ? ref : ref?.observation));
    })
    .map((transition) => transition.id);
  const mismatched = [];
  const stateOfObservation = new Map();
  for (const state of states) {
    for (const evidence of state.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.observation;
      if (id) stateOfObservation.set(id, state.id);
    }
  }
  for (const observation of graph.observations ?? []) {
    const claimed = observation.state;
    const known = stateOfObservation.get(observation.id);
    if (claimed && known && claimed !== known) mismatched.push(`${observation.id} claims ${claimed} but is evidence for ${known}`);
  }
  results.push({
    code: 'evidence_integrity',
    name: '§14.8 evidence integrity',
    severity: 'warning',
    ok: unbound.length === 0 && unsupportedEdges.length === 0 && mismatched.length === 0,
    detail: [
      unbound.length ? `states with no observation behind them: ${unbound.join(', ')}` : null,
      unsupportedEdges.length ? `edges with no reading behind them, or pointing at a reading that is not in the log: ${unsupportedEdges.join(', ')}` : null,
      mismatched.length ? mismatched.join('; ') : null,
    ].filter(Boolean).join('; ') || `every one of ${states.length} states and ${transitions.length} edges is bound to readings that exist in the log, and no observation claims a state it is not attached to.`,
  });

  // 9. version coherence.
  const observationCommits = distinct((graph.observations ?? []).map((observation) => observation.environment?.commit));
  const applicationCommit = typeof graph.application?.version === 'string'
    ? graph.application.version
    : graph.application?.version?.commit ?? null;
  const coherent = (!applicationCommit && observationCommits.length === 0) || observationCommits.every((commit) => commit === applicationCommit);
  results.push({
    code: 'version_coherence',
    name: '§14.9 version coherence',
    severity: applicationCommit || observationCommits.length ? 'error' : 'info',
    ok: coherent,
    detail: applicationCommit || observationCommits.length
      ? `application version ${JSON.stringify(applicationCommit)} vs observation commits ${JSON.stringify(observationCommits)}`
      : 'no application version was recorded and no observation claims a build, so there is nothing to disagree — the graph cannot be tied to a version at all.',
  });

  // 10. feature closure.
  const uncovered = {
    capabilities: capabilities.map((capability) => capability.id),
    states: states.map((state) => state.id),
    transitions: transitions.map((transition) => transition.id),
  };
  const uncoveredCount = uncovered.capabilities.length + uncovered.states.length + uncovered.transitions.length;
  results.push({
    code: 'feature_closure',
    name: '§14.10 feature closure (should, not must)',
    severity: 'warning',
    ok: uncoveredCount === 0,
    detail: uncoveredCount
      ? `no features are committed, so all ${uncoveredCount} objects (${capabilities.length} capabilities, ${states.length} states, ${transitions.length} transitions) are uncovered. Features have no source in browser evidence.`
      : 'every object is covered by a feature.',
  });

  // 11/12. Hygiene and confidence floor — reported as what this commit actually did.
  results.push({
    code: 'short_form_hygiene',
    name: '§14.11 short-form hygiene',
    severity: 'info',
    ok: true,
    detail: 'every produced source_mappings/evidence/preconditions/assertions is full form; the short forms the model wrote were normalized, and anything that could not resolve was dropped and reported.',
  });
  const lowConfidence = [...states, ...transitions, ...capabilities]
    .filter((item) => (item.metadata?.confidence ?? 1) < 0.5 || item.metadata?.status === 'inferred')
    .map((item) => item.id);
  results.push({
    code: 'confidence_floor',
    name: '§14.12 confidence floor',
    severity: 'info',
    ok: true,
    detail: lowConfidence.length
      ? `${lowConfidence.length} object(s) are below the confidence floor or marked inferred and must not drive a criticality:critical test: ${lowConfidence.slice(0, 12).join(', ')}`
      : 'no object is below the confidence floor.',
  });

  return results;
}

/**
 * Write the two commit artifacts. The raw logs are opened read-only, above.
 *
 * `force` writes the assembled document even when a blocking rule fired. It does not make the
 * graph correct and it hides nothing: the violations are still in the report and in the
 * document's own `warnings`. It exists for the case where the near-miss is what you need to
 * look at — a rule is usually easier to understand against the document it refused.
 */
export function commitRun({ dir, now = new Date(), command = 'graph_commit', graphFile = 'graph.json', reportFile = 'commit_report.json', force = false }) {
  const run = readRun(dir);
  const { graph, draft, report } = reconcile({ ...run, now, command });
  const reportPath = join(dir, reportFile);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  const document = graph ?? (force ? draft : null);
  const graphPath = document ? join(dir, graphFile) : null;
  if (document) writeFileSync(graphPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
  return { graph: document, report, graphPath, reportPath };
}

/**
 * A command line, so a finished run can be committed without an agent in the loop.
 *
 * The commit is a decision about evidence that already exists, so it must not require the
 * thing that produced it to be running: a run directory is enough.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  const json = process.argv.includes('--json');
  if (!dir) {
    console.error('usage: node lib/commit.js <run-dir> [--json]');
    process.exit(2);
  }
  try {
    const { graph, report, graphPath, reportPath } = commitRun({ dir, command: 'dsh-graph-explorer commit' });
    if (json) {
      console.log(JSON.stringify({ ok: report.ok, graph: graphPath, report: reportPath, transitions: report.transitions, blocking: report.blocking }, null, 2));
    } else {
      console.log(`run:        ${dir}`);
      console.log(`states:     ${report.states.committed} committed from ${report.states.candidates} records (${report.states.deduplicated} repeat readings collapsed)`);
      console.log(`capabilities: ${report.capabilities.committed}`);
      console.log(`transitions: ${report.transitions.committed} committed, ${report.transitions.rejected} rejected, ${report.transitions.superseded} superseded`);
      console.log(`report:     ${reportPath}`);
      console.log(`graph:      ${graphPath ?? '(not written — the commit was blocked)'}`);
      for (const blocker of report.blocking) console.log(`BLOCKED:    ${blocker.code} — ${blocker.detail}`);
    }
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
