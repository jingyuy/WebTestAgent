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
  ELEMENT_ID_PATTERN,
  ELEMENT_PURPOSE_PATTERN,
  EVIDENCE_ROLES,
  NOTE_SEVERITY,
  PAGE_TYPE_PATTERN,
  purposeOf,
  SEVERITIES,
  STEP_ACTIONS,
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
 * One recorded realisation step, as `capability.schema.json#/$defs/capabilityStep`, or `null`
 * when the record is not one.
 *
 * The recorded record is `behavior.schema.json#/$defs/behaviorStep`, which is a documented
 * *superset* of the graph's step: it adds `purpose` and `effects`. So this is a projection and
 * not a copy, and the two keys it leaves behind are not an oversight — `capabilityStep` sets
 * `additionalProperties: false`, so a step that carried them would be a `graph.json` the graph's
 * own validator rejects. A step that arrives without its prose is a worse document than a step
 * with it; a document that cannot be validated is not a document. Nothing is lost either way,
 * because the log keeps the whole record and the projection reads the log.
 *
 * `action` is required by both schemas and is the only key without which there is no step at
 * all: everything else can be absent and `{action: "assert"}` is still a real step of a real
 * behaviour. Every other key is checked where it is present, too, rather than dropped — a step
 * whose element is not an element id was not *that* step as recorded, and quietly writing the
 * fill without its target would be the exact failure this whole layer exists to prevent.
 *
 * Returning `null` rather than throwing is deliberate: the tool refuses an unknown verb at the
 * call, but what arrives here is a file, and the file is judged rather than trusted.
 */
function projectStep(record) {
  if (!STEP_ACTIONS.has(record.action)) return null;
  if (record.element !== undefined && !(typeof record.element === 'string' && ELEMENT_ID_PATTERN.test(record.element))) return null;
  if (record.value !== undefined && typeof record.value !== 'string') return null;
  if (record.arguments !== undefined && !(record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments))) return null;
  if (record.optional !== undefined && typeof record.optional !== 'boolean') return null;
  if (record.description !== undefined && typeof record.description !== 'string') return null;
  if (record.timeout_ms !== undefined && !(Number.isInteger(record.timeout_ms) && record.timeout_ms >= 0)) return null;
  return {
    action: record.action,
    ...(record.element !== undefined ? { element: record.element } : {}),
    ...(record.value !== undefined ? { value: record.value } : {}),
    ...(record.arguments !== undefined ? { arguments: record.arguments } : {}),
    ...(record.optional !== undefined ? { optional: record.optional } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.timeout_ms !== undefined ? { timeout_ms: record.timeout_ms } : {}),
  };
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
export const routeOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname || '/';
  } catch {
    return null;
  }
};

const distinct = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];

/**
 * The API entities one capture's request list shows, in the order the requests were made.
 *
 * The page hooks (`page-hooks.js`) record every `fetch` and `XMLHttpRequest` a document makes —
 * method, url, status, duration, failure — and `capture.js` drains that list, which is why a
 * reading's `network` is exactly what happened since the previous reading. Until now nothing was
 * made of it: the requests reached `graph.observations[].network` and stopped there, so no
 * transition could say which endpoint it called and no state could say what its readings fetched.
 *
 * This is the pure half of turning them into entities, exported for a specific reason: the digest
 * `graph_observe` hands the model and the entities `graph_commit` writes must carry the SAME ids.
 * A model that names `api_post_api_login` in a `request` effect has to be naming the id the
 * network log itself produced, or the effect is dropped as an unresolvable reference and the step
 * reads as having called nothing.
 *
 * The id is derived from the method and the path, and nothing else — not from a status, a
 * duration or a count — so the same endpoint is one entity across the whole run, which is what
 * `api.schema.json` means by an API.
 */
export const observedApis = (network) => {
  const list = [];
  const seen = new Map();
  for (const entry of Array.isArray(network) ? network : []) {
    if (!entry || typeof entry.url !== 'string') continue;
    const method = API_METHODS.has(String(entry.method ?? '').toUpperCase()) ? String(entry.method).toUpperCase() : 'GET';
    const path = endpointOf(entry.url);
    if (!path) continue;
    const id = apiIdFor(method, path);
    // Grouped on the endpoint and not on the id: `/a-b` and `/a/b` slug to the same id, and two
    // endpoints that collide in their slug are two endpoints — folding them together here would
    // record one entity whose statuses came from two different calls. The commit suffixes the
    // second id and says so, because the rename is a fact about the graph, not about this reading.
    const endpoint = `${method} ${path}`;
    const existing = seen.get(endpoint);
    if (existing) {
      // The same endpoint called twice in one reading is one API with two responses, and a
      // response that arrived is what the schema's `response.status` is for: an endpoint whose
      // readings disagreed (a 401 that then succeeded) carries both, rather than whichever
      // happened to be last.
      for (const status of Number.isInteger(entry.status) ? [entry.status] : []) {
        if (!existing.statuses.includes(status)) existing.statuses.push(status);
      }
      if (entry.failed === true) existing.failed = true;
      if (Number.isInteger(entry.duration_ms)) existing.durations.push(entry.duration_ms);
      existing.requests += 1;
      continue;
    }
    const api = {
      id,
      method,
      path,
      url: entry.url,
      statuses: Number.isInteger(entry.status) ? [entry.status] : [],
      durations: Number.isInteger(entry.duration_ms) ? [entry.duration_ms] : [],
      requests: 1,
      ...(entry.failed === true ? { failed: true } : {}),
      ...(typeof entry.failure_reason === 'string' ? { failure_reason: entry.failure_reason } : {}),
    };
    seen.set(endpoint, api);
    list.push(api);
  }
  return list;
};

/** The methods `observation.schema.json#/$defs/networkEntry` allows, which is the whole HTTP verb set. */
const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * The path a request went to, which is the part that identifies the endpoint.
 *
 * No query string and no host: `POST /api/login` is the endpoint whatever the port, and a query
 * string usually carries the parameters of one call rather than naming a different one. What the
 * URL actually was is kept on the entity and on the observation's network entry, so nothing that
 * was captured is lost by grouping on the path.
 */
export const endpointOf = (url) => {
  try {
    return new URL(url, 'http://localhost').pathname || '/';
  } catch {
    return null;
  }
};

/**
 * The id of the `api` entity an observed call belongs to.
 *
 * `api_` + the method and the path, which is `common.schema.json#/$defs/apiId`'s prefix and a
 * readable name for the same thing. Derived only from the method and the path, so an id can be
 * computed from a network entry as easily as it can be looked up — which is what lets the digest
 * and the commit agree without sharing state.
 */
export const apiIdFor = (method, path) => 'api_' + slugify(
  `${API_METHODS.has(String(method ?? '').toUpperCase()) ? String(method).toUpperCase() : 'GET'}_${path}`,
);

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
    const purpose = purposeOf(entry.element !== undefined ? entry.element : entry.target);
    const element = purpose ? ctx.elementIdByPurpose.get(purpose) : null;
    if (element) assertion.element = element;
    else if (typeof entry.target === 'string') assertion.target = entry.target;
    assertion.operator = 'not_exists';
    return { assertion };
  }

  // Element-bound checks: resolve the purpose to the element the graph declares.
  const wantsElement = type === 'element_state' || type === 'element_value';
  if (wantsElement) {
    const raw = entry.element !== undefined ? entry.element : entry.target;
    const purpose = purposeOf(raw);
    const element = purpose === null ? null : ctx.elementIdByPurpose.get(purpose);
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
 * Will this entry survive into the graph, asked while it can still be fixed?
 *
 * `normalizeAssertion` is the rule; this is the same rule asked as a yes/no question. The
 * difference is *when* it is asked. Every branch of `normalizeAssertion` that gives up
 * (`element_reference_does_not_resolve`, `element_assertion_has_nothing_to_check`,
 * `state_assertion_names_no_state`, …) is silent from the model's side: the entry is dropped
 * at commit time, minutes after the page it describes was closed, and the model that wrote it
 * cannot tell a state whose detection held from one whose detection evaporated.
 *
 * So the tool asks here too, with the ctx it *can* build from what has been recorded so far —
 * `route` from the reading in hand, `stateIds` from the states the store has, and
 * `elementIdByPurpose` from the purposes those states declared, plus any declared by the call
 * being validated. That is deliberately weaker than the commit's registry (which is built from
 * the readings that survived to be canonical), so anything refused here would also be dropped
 * there; the reverse is not guaranteed, and that gap is why the commit still reports drops.
 *
 * Returns `null` when the entry would survive, or `{reason, detail}` when it would not.
 */
export function assertionSurvival(entry, ctx) {
  const result = normalizeAssertion(entry, ctx);
  if (result.assertion) return null;
  return { reason: result.dropped ?? 'not_an_assertion', detail: result.detail ?? null };
}

/**
 * The roles that make an element something a user can act on.
 *
 * A diff lists appearances by `role:name`, and a list that grew adds plain text nodes rather
 * than controls. Keeping only controls is what separates "the same screen with one more item
 * in it" — a legitimate effect on a stable state — from "a different screen", which is a
 * state identity that does not hold. It lives here rather than in `index.js` because two
 * things now read a capture this way — the cross-check that asks whether a step's two readings
 * are one screen, and `surfaceOf` below — and two definitions of "something you can act on"
 * would be two chances to disagree about what a screen is.
 */
export const CONTROL_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'switch',
  'menuitem', 'tab', 'searchbox',
]);

/**
 * What a capture offers to act on, as `role:name`: the one property of a reading that says
 * *which screen* it is rather than what the screen holds.
 *
 * Values, messages, counts and storage are all things a screen has, and every one of them
 * changes within a single state — that is what makes them effects. The controls are what the
 * state *is*: the login form and the project list share no button between them, and any two
 * readings of one page share whatever navigation, form or list it has. So this is the property
 * a reading can be compared on without being told anything about the application, which is what
 * makes it usable as evidence about a state identity that only the model can name.
 *
 * Sorted and deduplicated, so two readings are compared by set membership rather than by the
 * order the DOM happened to be walked in.
 */
export const surfaceOf = (capture) => [...new Set(
  (Array.isArray(capture?.interactive) ? capture.interactive : [])
    .map((entry) => (entry && typeof entry.role === 'string' && typeof entry.name === 'string' && entry.name
      ? `${entry.role}:${entry.name}`
      : null))
    .filter((control) => control !== null && CONTROL_ROLES.has(control.split(':')[0])),
)].sort();

/**
 * Whether a reading shares no control at all with readings already known to be of its state.
 *
 * The blunt end of a question that is otherwise a judgement. *How much* may two screens differ
 * and still be one state? A ratio would be a threshold invented here and defended nowhere,
 * because the answer is the application's and not the machinery's. "Nothing at all in common"
 * needs neither: the login form and the project list are not one state, and any two readings of
 * a page with navigation, a form or a list share more than nothing.
 *
 * `false` when either side has no control to compare. A capture that lists none refutes
 * nothing: the honest answer to "is this a different screen?" is then "no evidence either
 * way", and this declines rather than guessing.
 */
export const surfaceIsDisjoint = (surface, others) => {
  if (!Array.isArray(surface) || surface.length === 0) return false;
  const union = new Set((others ?? []).flat());
  if (union.size === 0) return false;
  return !surface.some((control) => union.has(control));
};

/**
 * What a form is, to a machine that cannot read the page: where it posts and what it holds.
 *
 * `POST /login [email,password]` is the whole of a form's identity as evidence. The values are
 * left out on purpose — a filled-in form is a moment of a state, not the state, and the model's
 * `filled` effects already record what was typed. The action travels exactly as the page wrote it,
 * because normalising it into a route template would be a guess about the application (the same
 * reason an observed API path is not templated).
 */
export const formSignature = (form) => {
  if (!form || typeof form !== 'object') return null;
  const method = typeof form.method === 'string' && form.method ? form.method.toUpperCase() : 'GET';
  const action = typeof form.action === 'string' ? form.action : '';
  const fields = distinct((Array.isArray(form.fields) ? form.fields : []).filter((field) => typeof field === 'string' && field));
  return `${method} ${action} [${fields.join(',')}]`;
};

/** How many controls of a fingerprint are written into the graph. `surface_size` is the true count. */
export const OBSERVABLE_SURFACE_MAX = 40;

/**
 * Everything the machinery can see about a screen, as one comparable object — the evidence side of
 * a state identity.
 *
 * A state's identity is the model's judgement: `page_type`, `variant` and `dimensions` are words it
 * chose, and §14.4 checks them only against each other. Nothing in the commit until now asked
 * whether two states the model distinguished were distinguished by anything the page did, so two
 * readings of one screen could be committed as two states and the only trace is that the walk
 * visits them one after another for no reason. This is the other half of that question: the
 * controls, forms, storage keys, cookie names and routes the captures actually recorded, folded
 * into one object a pair of states can be compared on.
 *
 * Union rather than intersection across a state's readings. Two readings of one state are the same
 * screen at two moments — a tab that appears, a list that grew — and the state is what they have in
 * common plus what either showed; the readings that share *nothing* are already reported by
 * `surfaceIsDisjoint`. `surface_size` is the true size of the set and `surface` is capped at
 * `OBSERVABLE_SURFACE_MAX`, because a fingerprint is written into every state of every graph.
 *
 * `null` when a capture carries none of it. A page with no controls, no form, no storage and no
 * route is not a state with an empty fingerprint — it is a reading that refutes nothing, and the
 * caller can then leave the field out rather than write `{}` onto every state read from a blank
 * page.
 */
export const observableOf = (captures) => {
  const list = (Array.isArray(captures) ? captures : []).filter((capture) => capture && typeof capture === 'object');
  const strings = (values) => distinct(values.map((value) => (typeof value === 'string' && value ? value : null)));
  const keysOf = (value) => (value && typeof value === 'object' ? Object.keys(value) : []);
  const routes = strings(list.map((capture) => routeOf(capture.url))).sort();
  const surface = [...new Set(list.flatMap((capture) => surfaceOf(capture)))].sort();
  const forms = strings(list.flatMap((capture) => (Array.isArray(capture.forms) ? capture.forms : []).map(formSignature))).sort();
  const storageKeys = strings(list.flatMap((capture) => keysOf(capture.storage))).sort();
  const sessionKeys = strings(list.flatMap((capture) => (Array.isArray(capture.session_storage_keys) ? capture.session_storage_keys : []))).sort();
  const cookieNames = strings(list.flatMap((capture) => (Array.isArray(capture.cookie_names) ? capture.cookie_names : []))).sort();
  if (!routes.length && !surface.length && !forms.length && !storageKeys.length && !sessionKeys.length && !cookieNames.length) return null;
  return {
    ...(routes.length ? { routes } : {}),
    surface_size: surface.length,
    ...(surface.length ? { surface: surface.slice(0, OBSERVABLE_SURFACE_MAX) } : {}),
    ...(forms.length ? { forms } : {}),
    ...(storageKeys.length ? { storage_keys: storageKeys } : {}),
    ...(sessionKeys.length ? { session_storage_keys: sessionKeys } : {}),
    ...(cookieNames.length ? { cookie_names: cookieNames } : {}),
  };
};

/**
 * The committed states the machinery cannot tell apart, grouped.
 *
 * Compared on the whole `observable` object, serialized in the order `observableOf` builds it, so a
 * field added there joins this comparison without a second edit here — which is the point: the
 * question is "did anything the page did distinguish these two", and the answer should not depend
 * on somebody remembering to add a field to a list.
 *
 * A shared fingerprint is not an error and is not treated as one. Two screens can differ in
 * something the surface does not carry — an empty cart and a cart with one item offer the same
 * controls and differ in a count — and then the model's `identity.dimensions` is the honest place
 * for the difference, and the warning is the prompt to record it. This is the state-identity
 * analogue of `surfaceIsDisjoint`, and it declines for the same reason that one does: a state whose
 * readings recorded nothing has no fingerprint, so nothing here claims it is a duplicate.
 */
export const indistinguishableStates = (states) => {
  const byFingerprint = new Map();
  for (const state of states ?? []) {
    const observable = state?.metadata?.extra?.observable;
    if (!observable || typeof observable !== 'object') continue;
    const key = JSON.stringify(observable);
    const group = byFingerprint.get(key);
    if (group) group.ids.push(state.id);
    else byFingerprint.set(key, { ids: [state.id], observable });
  }
  return [...byFingerprint.values()].filter((group) => group.ids.length > 1);
};

/** What a shared fingerprint looked at, for a finding's detail. */
export const observableSummary = (observable) => [
  (observable?.routes ?? []).length ? `route(s) ${observable.routes.join(', ')}` : null,
  observable?.surface_size ? `${observable.surface_size} control(s)` : null,
  (observable?.forms ?? []).length ? `${observable.forms.length} form(s)` : null,
  (observable?.storage_keys ?? []).length ? `localStorage key(s) ${observable.storage_keys.join(', ')}` : null,
  (observable?.session_storage_keys ?? []).length ? `sessionStorage key(s) ${observable.session_storage_keys.join(', ')}` : null,
  (observable?.cookie_names ?? []).length ? `cookie(s) ${observable.cookie_names.join(', ')}` : null,
].filter(Boolean).join(', ');

/**
 * Whether a reading contains an element.
 *
 * Matched on what the capture actually recorded — role and accessible name, or the testid /
 * selector the locator names — because the capture has no `semantic_purpose`: the purpose is
 * the model's word for the element, and the role+name is the page's. This is the only place
 * where a claim in the graph can be checked against a raw reading instead of against another
 * claim, so it is worth the care.
 *
 * `false` is a *positive* finding: the capture was read and the element was not in it. `null`
 * is the absence of evidence (no capture at all) and refutes nothing. Exported because
 * `graph_observe` asks the same question of the reading in hand — a claim this predicate
 * refutes at the moment it is made can never become true later, since the reading it is bound
 * to is immutable, so the tool refuses it where the page can still be read again.
 */
export const elementPresentIn = (capture, declaration) => {
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
 * Which of two declarations of one element should own it.
 *
 * Ownership is not a popularity contest, and it is not an election by arrival: the owning
 * declaration is the one that carries the id, the locator and the role/name the graph hands
 * downstream, so the declaration that should carry them is the one whose own reading can vouch for
 * them. `observed` is the tri-state: `true` (the capture lists it) beats `null` (no capture, or a
 * capture with no interactive list at all) beats `false` (the capture was read and does not list
 * it). A tie keeps the canonical record ahead of a repeat reading, and then whichever was declared
 * first — which is the whole of the rule this replaced, so a run whose evidence is silent is
 * reconciled exactly as before.
 */
export const outranksAsEvidence = (candidate, held) => {
  const rank = (entry) => (entry?.observed === true ? 2 : entry?.observed === false ? 0 : 1);
  const delta = rank(candidate) - rank(held);
  if (delta) return delta > 0;
  if (Boolean(candidate?.canonical) !== Boolean(held?.canonical)) return Boolean(candidate?.canonical);
  return false;
};

/**
 * What an element-shaped detection entry claims about a reading, or `null` when it claims
 * nothing about one.
 *
 * `absence` is the only claim that wants the element gone; every other element-bound check
 * asserts the element is there to be checked.
 */
export const elementClaim = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'absence') {
    const purpose = purposeOf(entry.element !== undefined ? entry.element : entry.target);
    return purpose ? { purpose, want: 'absent' } : null;
  }
  if (entry.type === 'element_state' || entry.type === 'element_value') {
    const purpose = purposeOf(entry.element !== undefined ? entry.element : entry.target);
    return purpose ? { purpose, want: 'present' } : null;
  }
  return null;
};

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
export const ELEMENT_TARGET_EFFECTS = new Set([
  'value_changed',
  'visibility_changed',
  'element_created',
  'element_destroyed',
  'validation_error',
]);

/**
 * The effects that move a *state variable*, the kind of variable each one moves, and what
 * the fact being moved is *for*.
 *
 * A state variable is a fact about the application that can hold more than one value while the
 * screen stays the same: whether the cart has items, whether a coupon is applied, whether the user
 * is remembered. The graph has two places for such a fact and one place it must not go:
 *
 *   - `state.identity.dimensions`, when the fact is what tells two states apart that share a
 *     route — `{cart: non_empty}` is why /cart with items and /cart without are two states;
 *   - a `value` assertion in `state.detection`, when the fact has to be *checked* rather than
 *     named — a dimension nothing asserts is a label, not a variable;
 *   - a new state per value, which is the explosion this exists to avoid: a three-valued fact
 *     would be three screens.
 *
 * Deliberately not every effect, and the exclusions are the point:
 *   - `value_changed` is a *form's* contents, not the application's state — what the user typed is
 *     element state, which is why the recorder reports a state minted out of it rather than
 *     encouraging a dimension for it;
 *   - `visibility_changed` / `element_created` / `element_destroyed` are presence: what a state
 *     *contains*, which `elements[]` already records;
 *   - `validation_error` / `message` are text the page showed.
 *
 * The two survivors are not the same kind of thing, and conflating them was an error worth
 * naming. `list_changed` is a *semantic* fact: the collection the step grew is one the screen was
 * already showing, so the count is what the arrival means and a dimension is exactly how the graph
 * holds it. `storage_changed` is a *persistence* fact: a key the application wrote down. It is
 * stronger evidence than a dimension is — it is the run's proof that the state survives a reload —
 * and it is not an observable. A browser can be asked "how many rows?" and cannot be asked "what
 * does the app remember about this user?", so asking a state to assert a storage key as a
 * dimension would produce a test that cannot be run; and asking storage nothing at all would throw
 * away the only evidence in the run that the session is persistent.
 *
 * Hence `role`: `semantic` facts are (or should be) dimensions, and `persistence` facts are
 * evidence about the state and belong in the report and in the graph's own notes — not in
 * `identity.dimensions`.
 */
export const STATE_VARIABLE_EFFECTS = new Map([
  ['storage_changed', { kind: 'storage', role: 'persistence' }],
  ['list_changed', { kind: 'collection', role: 'semantic' }],
]);

/** The state variables a step's effects moved, as `{name, kind, role}`, deduped by name, sorted. */
export const stateVariablesOf = (effects) => {
  const byName = new Map();
  for (const effect of Array.isArray(effects) ? effects : []) {
    const entry = STATE_VARIABLE_EFFECTS.get(effect?.type);
    if (!entry) continue;
    const name = typeof effect?.target === 'string' ? effect.target.trim() : '';
    if (!name || byName.has(name)) continue;
    byName.set(name, { name, kind: entry.kind, role: entry.role });
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
};

/**
 * The variables a step moved that are a *fact about the screen* rather than about what the
 * application remembers.
 *
 * This is the split the report is built on: only these can be a dimension, because only these can
 * be read back from the page at runtime.
 */
export const semanticVariablesOf = (effects) => stateVariablesOf(effects).filter((variable) => variable.role === 'semantic');

/**
 * The variables a step moved that only say what was *remembered*.
 *
 * Kept, not dropped: a storage write is the run's only evidence that the state is persistent, and
 * dropping it would leave the graph silent about the difference between a session that survives a
 * reload and one that does not.
 */
export const persistenceVariablesOf = (effects) => stateVariablesOf(effects).filter((variable) => variable.role === 'persistence');

/** The names a state's identity declares as its discriminating variables, sorted. */
export const dimensionNamesOf = (identity) => (
  identity && typeof identity.dimensions === 'object' && identity.dimensions !== null
    ? Object.keys(identity.dimensions).sort()
    : []
);

/**
 * Do two names spell the same variable?
 *
 * Exact, or one is the other's last dot-segment — `cart.items` on the effect and `items` on the
 * state are the same variable named twice, and the names come from two different authors (the
 * effect's `target` is a storage key or a semantic path, the dimension is the model's word). The
 * match is by name and nothing more: the commit cannot see a storage key's value change and a
 * dimension's value agree, so this is used to decide what to *report*, never to reject.
 */
export const sameVariableName = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === right) return true;
  const leaf = (name) => name.split('.').filter(Boolean).pop() ?? name;
  return leaf(left) === leaf(right);
};

/**
 * The words of a name, cut into tokens and made singular.
 *
 * `cart_items`, `cartItems` and `Cart Items` are one name spelled three ways, and a dimension is
 * spelled by the model while an element's purpose is spelled by the model too — two spellings of one
 * thing is the normal case here, not an error to report.
 */
const collectionTokens = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean)
  .map((token) => (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));

/**
 * Do two names look like the same *collection*?
 *
 * Looser than `sameVariableName` on purpose, and used only where a count is being attributed rather
 * than a claim being checked. The live run declared the dimension `projects: non_empty` and declared
 * the element as `project_list`, so the exact rule never fired and the one assertion that could have
 * checked the dimension was never offered — the count was read and thrown away, which is worse than
 * not reading it, because the graph then said nothing about a fact it had in hand.
 *
 * The relation is: the shorter name's tokens are a leading or trailing run of the longer one's. So
 * `project` matches `project_list`, `item` matches `cart_item`, and `item` does *not* match
 * `cart_item_price` — a prefix or suffix, never a word from the middle, because the head of a name
 * says what a collection is and the middle says which one.
 */
export const sameCollectionName = (left, right) => {
  const a = collectionTokens(left);
  const b = collectionTokens(right);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === long.length) return short.join(' ') === long.join(' ');
  const head = long.slice(0, short.length).join(' ');
  const tail = long.slice(long.length - short.length).join(' ');
  return head === short.join(' ') || tail === short.join(' ');
};

/**
 * The variables a step moved that none of the given identities records as a dimension.
 *
 * `identities` is every endpoint of the step, because a variable can be a dimension on either
 * side: the state it left (the value before) and the state it arrived in (the value now).
 */
export const unrecordedStateVariables = (effects, identities) => {
  const recorded = (Array.isArray(identities) ? identities : []).flatMap(dimensionNamesOf);
  return semanticVariablesOf(effects)
    .filter((variable) => !recorded.some((name) => sameVariableName(name, variable.name)));
};

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
      // `request` names the api it called, and this is the one effect whose reference the machinery
      // can check against its own evidence rather than against the model's vocabulary: an api
      // entity exists because a page hook saw the call (see `observedApis`). An effect naming an
      // endpoint nothing observed would dangle (invariant 2), so it is still dropped — but a step
      // that called an endpoint can now name it and mean exactly what the observation recorded.
      if (!ctx.apiIds.has(effect.api)) {
        droppedEffects.push({ effect, reason: 'api_does_not_resolve' });
        continue;
      }
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
      detail: `these api ids were named by the step and no reading in this run observed a call to them, so the references were not carried over: ${droppedApis.join(', ')}. An api id is minted from what the page's own request hooks saw; the ids in the digest are the ones that exist.`,
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
 * The walks in the run, reassembled from the transitions log.
 *
 * `transitions.jsonl` is written in the order the steps were taken, and the store's own header
 * says that is the only thing which makes a journey reconstructible afterwards. So a journey here
 * is *derived* rather than invented: the log is read in that order and cut into the longest runs
 * of live steps where each step starts in the state the previous one ended in. That is invariant
 * 5 (a journey is a walk) applied to the evidence instead of to a claim, which is why the check
 * at the other end of a commit has something real to check.
 *
 * Three things cut a run, and all three are facts about the walk rather than opinions about it:
 *
 *   - a step whose edge was refused. A refused edge is not an edge, so a journey through it would
 *     name a transition this graph does not have (invariant 2).
 *   - a step whose edge is in the graph but does not join two committed states. Same reason: a
 *     journey walks states that exist.
 *   - a step that starts somewhere other than where the previous step ended. The model may have
 *     re-opened a page, or the recorder may have missed a navigation; either way the walk jumped,
 *     and a journey that bridged the jump would be the graph inventing an edge.
 *
 * Where a goal comes from is the one part of a journey that is not in the walk. Nothing in a
 * browser session says what a user was trying to achieve — a page cannot be asked — but the run
 * itself was *asked* to do something, and `agent/pre-step` recorded that instruction in
 * `run.json`. So the goal is not invented here: it is the run's own instruction, quoted.
 *
 * It is attributed to a journey only when there is exactly one journey to attribute it to. One
 * strand means the instruction describes exactly that walk. Several strands mean the instruction
 * describes the run, and copying it onto each of them would claim that every strand is an
 * attempt at the whole thing — which is a claim the walk does not support. In that case the
 * instruction is carried in `metadata.extra.run_instruction` and `goal_stated` stays false.
 *
 * Pure and exported for the same reason `reconcile` is: this is the rule that decides what the
 * finished graph claims was walked, so it is worth testing without a filesystem or a browser.
 */

/**
 * The run's instruction, read back as a goal.
 *
 * Quoted, never paraphrased: this module refuses to invent meaning everywhere else, and a goal it
 * made up would be the one claim in the graph with no evidence of any kind behind it. The first
 * sentence is taken because an instruction is usually a task followed by its details — "Sign in
 * to the demo app, then add a product to the cart" is a goal, and the account to use is not. A
 * sentence longer than the limit is cut on a word boundary and marked with an ellipsis, and the
 * whole instruction is kept beside it in `metadata.extra.run_instruction`, so the cut is visible
 * rather than silent.
 *
 * The lines are joined before the sentence is looked for, because **a line break is not
 * punctuation**. Instructions arrive hard-wrapped — the harness prompts are, and so is any task
 * written into a file — and reading the goal off the first physical line means taking a fragment
 * that ends wherever the author's editor reached the margin. The 0.1.21 live run's goal was
 * `Open http://127.0.0.1:4173/ in the browser, sign in with the credentials the page shows, and`,
 * which is a quotation of the instruction that stops mid-sentence on a comma and a conjunction the
 * sentence needed. 0.1.20 did not show this because its instruction happened to be one line long.
 */
const GOAL_MAX_CHARS = 160;
export const goalFromInstruction = (instruction) => {
  if (typeof instruction !== 'string') return null;
  const line = instruction.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  const sentence = /^(.{10,}?[.!?])(?:\s|$)/.exec(line);
  const text = (sentence ? sentence[1] : line).trim();
  if (text.length <= GOAL_MAX_CHARS) return text;
  const clipped = text.slice(0, GOAL_MAX_CHARS);
  const cut = clipped.lastIndexOf(' ');
  return (cut > 40 ? clipped.slice(0, cut) : clipped).trim() + '…';
};

/**
 * A journey's name, derived from the goal it was given.
 *
 * A goal and a name are different fields doing different jobs, and the review was right that
 * quoting the whole instruction into the name was the wrong call: the goal is a *sentence* — "Sign
 * in with test@example.com and reach the authenticated Projects list" — and a name is a *handle*,
 * the shortest string that still tells two walks apart in a list of them. A name that is a whole
 * instruction is a name nobody reads, and the deadline of a goal is not a name.
 *
 * So the name is the goal's first clause, and nothing beyond it is invented: the cut is at the first
 * comma, semicolon, colon, dash or "then", so "Sign in to the demo app, then add a product to the
 * cart" is named `Sign in to the demo app` while its `goal` keeps every word. A single-clause goal is
 * its own name, minus the sentence's closing punctuation, because a period is what makes it a
 * sentence rather than a label.
 *
 * One piece of the text is dropped by rule rather than by cut: an instruction that opens by
 * describing the tools is the operator's prompt and not the application's goal — our own
 * `agent/pre-step` instruction begins with a preamble about the browser tools, and a journey called
 * "Using the browser tools" names the machine rather than the walk. The whole instruction stays in
 * `metadata.extra.run_instruction` and the whole goal in `goal`, so the dropped words are beside the
 * name rather than gone.
 *
 * A name longer than the limit is cut on a word boundary and marked with an ellipsis, and a clause
 * that reduces to nothing — an instruction that is only a preamble — returns null so the caller
 * falls back to the endpoints rather than naming the walk with an empty string.
 *
 * A URL or an email address in a goal is a *parameter* of the walk and not part of its name, and it
 * is cut before the clause boundary is looked for — which is not a detail. Our own instruction reads
 * "open the Acme demo app at http://127.0.0.1:4173/ and sign in with test@example.com", and a cut at
 * the first colon does not stop at the clause: it stops inside `http:`, and then inside `:4173`, so a
 * name derived that way is `open the Acme demo app at http`. Cutting at the parameter first leaves
 * `open the Acme demo app`, which is what the walk was: the address is still in `goal`, still in
 * `run.json`, and still in the graph's `application.base_url` for anything that needs to *use* it.
 *
 * What the cut leaves behind is trimmed as well, because `open the demo app at` is a handle with a
 * dangling connector on it. A trailing word that only related the name to the parameter it lost
 * (`at`, `with`, `as`, `and`) is dropped with it — and *only* when a parameter was what was cut,
 * which is the whole reason the word is dangling. Trimming indiscriminately is how `open the demo
 * app and sign in` loses the `in` that makes `sign in` a verb, which is a name edited into a lie.
 */
const JOURNEY_NAME_MAX_CHARS = 60;
const TRAILING_CONNECTORS = new Set(['at', 'with', 'using', 'and', 'then', 'to', 'for', 'on', 'by', 'from', 'into', 'as', 'via']);
const PARAMETER_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/u;
export const journeyNameFromGoal = (goal) => {
  if (typeof goal !== 'string') return null;
  const text = goal.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Dropped before the cut, not after: the preamble is separated from the task by the same comma
  // the cut looks for, so cutting first would leave the preamble as the whole first clause.
  const task = text.replace(/^(?:please\s+)?using the (?:browser|available|provided)?\s*tools?,?\s*/i, '').trim();
  if (!task) return null;
  // The parameter first, then the clause. `> 0` on each, because a cut at index 0 is a task that
  // *begins* with the thing being cut, and the answer to that is not an empty name.
  const parameter = task.search(PARAMETER_PATTERN);
  const cutParameter = parameter > 0;
  const head = cutParameter ? task.slice(0, parameter) : task;
  const boundary = head.search(/(?:[;:,]|—|–|\b(?:and\s+)?then\b|\bafter\s+that\b|\bfollowed\s+by\b)/i);
  let clause = (boundary > 0 ? head.slice(0, boundary) : head).trim();
  clause = clause.replace(/[\s.;:,!?—–-]+$/u, '').trim();
  // The dangling connector, repeatedly: "open the demo app at and sign in with" is a name built out
  // of nothing but the words that pointed at the parameters that were cut. Never down to nothing —
  // one word is a name however thin, and an empty one is what `null` is for.
  let words = clause.split(' ');
  while (cutParameter && words.length > 1 && TRAILING_CONNECTORS.has(words[words.length - 1].toLowerCase())) {
    clause = words.slice(0, -1).join(' ').trim();
    words = clause.split(' ');
  }
  if (!clause) return null;
  if (clause.length <= JOURNEY_NAME_MAX_CHARS) return clause;
  const clipped = clause.slice(0, JOURNEY_NAME_MAX_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trim() + '…';
};

export function assembleJourneys({ transitions = [], edges = [], stateIds = new Set(), generatedAt = null, instruction = null }) {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const strands = [];
  const breaks = [];
  const unusableSteps = [];
  let current = null;

  for (const record of transitions) {
    const id = record.transition_id ?? record.id;
    if (!id) continue;
    const edge = byId.get(id);
    const previous = current?.steps.length ? current.steps[current.steps.length - 1] : null;
    const joinable = edge && stateIds.has(edge.from_state) && stateIds.has(edge.to_state);
    if (!joinable) {
      if (previous) {
        breaks.push({
          after: previous.to_state,
          before: record.from_state ?? null,
          transition: id,
          reason: edge ? 'edge_does_not_join_committed_states' : 'edge_not_committed',
        });
      }
      unusableSteps.push(id);
      current = null;
      continue;
    }
    const from = edge.from_state;
    const to = edge.to_state;
    if (!previous || previous.to_state !== from) {
      if (previous) {
        breaks.push({ after: previous.to_state, before: from, transition: id, reason: 'walk_jumped' });
      }
      current = { steps: [] };
      strands.push(current);
    }
    current.steps.push({
      id,
      from_state: from,
      to_state: to,
      // A step that re-walks an edge already in this journey. Computed from the strand rather than
      // read off the log's `repeated` flag, because "repeated" is a fact about the walk so far and
      // the flag is a fact about the store's index.
      repeated: current.steps.some((step) => step.id === id),
      // The name the model gave the walk this step is part of, in the user's words, when it gave
      // one. Carried per step rather than per journey because the walk is cut into strands here and
      // the model was naming the thing it was doing, not the numbers this function draws: which
      // strand a claim belongs to is decided below, from which steps made it.
      journey_name: typeof record.journey_name === 'string' && record.journey_name.trim()
        ? record.journey_name.trim()
        : null,
    });
  }

  const journeys = [];
  const used = new Set();
  // Naming, kept as two facts rather than folded into the loop: which walks carry the model's own
  // words, and which were named more than one way. Both are reported by the commit, because a
  // journey's name is the one field a reader takes at face value.
  const namedByModel = [];
  const nameConflicts = [];
  // The run's instruction, quoted: `run.json` is the only place intent was ever written down.
  const instructionText = typeof instruction === 'string' && instruction.trim() ? instruction.trim() : null;
  const derivedGoal = goalFromInstruction(instructionText);
  // One strand means the instruction is about this walk. Several mean it is about the run.
  const goalText = strands.length === 1 ? derivedGoal : null;
  const goalSource = !instructionText
    ? 'none: the run recorded no instruction, and nothing in a browser session says what a user was trying to achieve'
    : goalText
      ? 'run.json `instruction`, quoted verbatim: the run walked one strand, so the instruction describes exactly this walk'
      : derivedGoal
        ? `withheld: the run assembled ${strands.length} strands, so the instruction describes the run rather than any one of them — attribute it by hand, or widen the walk to one strand`
        : 'none: the recorded instruction could not be read as a goal sentence';
  strands.forEach((strand, index) => {
    const [first] = strand.steps;
    const last = strand.steps[strand.steps.length - 1];
    const stem = slugify(String(first.from_state).replace(/^state_/, ''))
      + '_to_' + slugify(String(last.to_state).replace(/^state_/, ''));
    let id = 'journey_' + stem;
    let suffix = 2;
    while (used.has(id)) id = 'journey_' + stem + '_' + suffix++;
    used.add(id);

    // The walk's own name, in the user's words, when the model gave one on any of its steps. This
    // is the third source of a name and the best one: a goal says what the walk was *for*, and the
    // endpoints say only where it went, but the model naming the walk it was walking is the one
    // statement that says what the walk *is*. Two steps can disagree — a run that names the same
    // walk twice, or names it again after being cut in half — and the last claim in walk order wins,
    // because the later word is the model's better-informed one, with every claim kept beside it in
    // `journey_names_claimed` so the disagreement is readable rather than settled silently.
    const claims = distinct(strand.steps.map((step) => step.journey_name).filter(Boolean));
    const nameClaim = claims.length ? claims[claims.length - 1] : null;
    const claimStep = nameClaim
      ? [...strand.steps].reverse().find((step) => step.journey_name === nameClaim)
      : null;

    // Evidence is observations and only observations: `common.schema.json#/$defs/evidenceRef`
    // points at a raw reading and at nothing else. So a journey's evidence is the readings its
    // steps were made from, deduplicated by reading and role.
    const evidence = new Map();
    for (const step of strand.steps) {
      for (const ref of byId.get(step.id)?.evidence ?? []) {
        const key = `${ref.observation}:${ref.role}`;
        if (!evidence.has(key)) evidence.set(key, ref);
      }
    }

    const stated = Boolean(goalText);
    // The name is derived from the goal rather than being the goal: `goal` is the run's sentence and
    // `name` is a handle for a list of walks (see `journeyNameFromGoal`). Kept as its own value
    // because there are three sources of a name and the report counts them apart.
    const nameFromGoal = stated ? journeyNameFromGoal(goalText) : null;
    const derivedName = `Derived walk ${index + 1}: ${first.from_state} to ${last.to_state} (${strand.steps.length} step(s))`;
    // Three sources, in the order of how much they say: the model's own name for this walk, then
    // the run's stated goal, then the endpoints. The endpoints are always the worst of them — they
    // say where a walk went and nothing about what it was — so they are the name only when nothing
    // was ever stated.
    const name = nameClaim ?? nameFromGoal ?? derivedName;
    const nameSource = nameClaim
      ? `the model's own name for this walk, claimed on ${claimStep?.id} of it (journey_name on the step record)`
      : nameFromGoal
        ? 'the first clause of the run\'s stated goal, cut at its first comma: a name is a handle for a walk, and the whole sentence is kept in `goal`'
        : stated
          ? 'the endpoints of the walk: the run stated a goal, but none of it could be read as a name for a walk'
          : 'the endpoints of the walk, because neither the run nor the model named it';
    if (claims.length > 1) nameConflicts.push({ journey: id, claimed: claims });
    if (nameClaim) namedByModel.push(id);
    journeys.push({
      id,
      name,
      ...(stated ? { goal: goalText } : {}),
      start_state: first.from_state,
      transitions: strand.steps.map((step) => step.id),
      ...(evidence.size ? { evidence: [...evidence.values()] } : {}),
      tags: ['derived'],
      metadata: commitMetadata({
        status: 'inferred',
        producer: 'importer:dsh-graph-explorer',
        createdAt: generatedAt ?? undefined,
        extra: {
          derivation: 'transitions.jsonl in walk order, cut where a step does not start where the previous one ended, or where its edge is not a committed edge between two committed states',
          steps: strand.steps.map((step) => ({
            transition: step.id,
            from_state: step.from_state,
            to_state: step.to_state,
            ...(step.repeated ? { repeat_of_earlier_step: true } : {}),
          })),
          // A walk that repeats an edge carries the same transition id more than once, because a
          // journey is a sequence of steps and two adds to one cart are two steps. The count of
          // distinct transitions is here so that difference is readable without re-deriving it.
          distinct_transitions: new Set(strand.steps.map((step) => step.id)).size,
          // `goal_stated` says one thing and only one: this journey carries a goal that was
          // stated by the run, rather than one inferred from the shape of the walk. A withheld
          // goal is still a stated goal that exists — which is why the instruction below is
          // carried whether or not the goal was attributed.
          goal_stated: stated,
          goal_source: goalSource,
          ...(instructionText ? { run_instruction: instructionText } : {}),
          criticality: 'not set: the walk was recorded, the priority was not judged, so the schema default (standard) applies',
          // Where the name came from, said explicitly: a reader of the graph has to be able to tell
          // the model's words from this module's arithmetic, and a name is the one field a reader
          // takes at face value. `name_stated` is true only when a person's words are in it.
          name_from: nameSource,
          // The same fact as a word a caller can count, rather than as a sentence it would have to
          // pattern-match. Three sources, three values, and `report.journeys` counts these.
          name_source_kind: nameClaim ? 'model' : nameFromGoal ? 'goal' : 'endpoints',
          name_stated: Boolean(nameClaim || nameFromGoal),
          ...(claims.length ? { journey_names_claimed: claims } : {}),
          ...(claims.length > 1
            ? { name_conflict: `this walk was named ${claims.map((claim) => JSON.stringify(claim)).join(' and ')} by its own steps — the last claim in walk order is the name, and the earlier ones are kept here rather than dropped` }
            : {}),
          name_derived_from: `${first.from_state} to ${last.to_state}, the endpoints of the walk${nameClaim || stated ? ' (kept here rather than used as the name)' : ''}`,
        },
      }),
    });
  });

  return {
    journeys,
    steps: strands.reduce((total, strand) => total + strand.steps.length, 0),
    unusableSteps,
    breaks,
    // The two facts about naming the caller reports: which walks the model named itself, and where
    // a walk was named more than one way.
    namedByModel,
    nameConflicts,
  };
}

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
  // A declaration is a claim like any other, and the reading it was made in is the one piece of
  // evidence that can refute it on the spot, so each declaration is recorded with what its own
  // reading says about it: `true` the capture lists it, `false` the capture was read and does not,
  // `null` the reading cannot say (no capture, or a capture with no interactive list at all). The
  // last two are not degrees of the same answer — a reading nobody took refutes nothing — and
  // keeping them apart is what lets the registry below choose an owner by evidence rather than by
  // the order two records happened to be merged in.
  const declaredInState = new Map();
  for (const record of [...canonicalStates, ...sightings]) {
    if (!record.state_id) continue;
    const purposes = declaredInState.get(record.state_id) ?? [];
    const capture = record.observation_id ? observationsById.get(record.observation_id)?.capture ?? null : null;
    for (const element of Array.isArray(record.elements) ? record.elements : []) {
      const purpose = element?.semantic_purpose;
      if (typeof purpose !== 'string' || !ELEMENT_PURPOSE_PATTERN.test(purpose)) continue;
      if (purposes.some((entry) => entry.purpose === purpose)) continue;
      const observed = capture && Array.isArray(capture.interactive)
        ? elementPresentIn(capture, { role: element.role, name: element.name, locator: normalizeLocator(element.locator) })
        : null;
      purposes.push({
        purpose,
        element,
        from: record.observation_id ?? null,
        canonical: record.kind === 'state',
        state_id: record.state_id,
        observed,
      });
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

  // --- who owns a purpose, decided by evidence rather than by arrival ---
  // One purpose has exactly one declaration, and the declaration carries the id, the locator and
  // the role/name the graph will use. Choosing the owner by election order is what made an element
  // declared in a state whose reading never showed it take the id and the locator, while the state
  // whose reading *did* show it was recorded as merely seeing it: a locator and a description read
  // from the one reading that cannot vouch for them. So the owner is settled here, before anything
  // is carried, and outranksAsEvidence is the whole rule.
  const ownerByPurpose = new Map();
  for (const purposes of declaredInState.values()) {
    for (const entry of purposes) {
      const held = ownerByPurpose.get(entry.purpose);
      if (!held || outranksAsEvidence(entry, held)) ownerByPurpose.set(entry.purpose, entry);
    }
  }

  const elementsSeenElsewhere = new Map();
  for (const record of canonicalStates) {
    const elements = [];
    const elsewhere = {};
    for (const { purpose, element, from, canonical } of declaredInState.get(record.state_id) ?? []) {
      const id = elementIdFor(purpose);
      elementIdByPurpose.set(purpose, id);

      const owner = ownerByPurpose.get(purpose);
      if (owner && owner.state_id !== record.state_id) {
        // The element exists; this state sees it. States that see an element without owning its
        // declaration record the fact on themselves, because the declaration can only live in one
        // `elements[]` and a reader of that state should still be told what it saw. The owner is
        // already settled, so a state that declared the element first but whose reading does not
        // show it records it as belonging elsewhere, rather than taking it by arriving early.
        elsewhere[purpose] = owner.state_id;
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

  // Every state that also declared a purpose is recorded on the declaration itself — including the
  // states reached *before* it, which the old order could not see: the carried element can only
  // live in one `elements[]`, and §3.12 keeps elements embedded in every state that has one for
  // exactly this. A disagreement about what the element is (role/name) is still a disagreement
  // wherever it was declared from, so `conflicting` is settled here too.
  for (const [purpose, owner] of ownerByPurpose) {
    const declaration = declarations.get(purpose);
    if (!declaration) continue;
    for (const [stateId, purposes] of declaredInState) {
      if (stateId === owner.state_id) continue;
      for (const entry of purposes) {
        if (entry.purpose !== purpose) continue;
        if (!declaration.seen_in.includes(stateId)) declaration.seen_in.push(stateId);
        if (entry.canonical && (declaration.role !== entry.element.role || declaration.name !== entry.element.name)) declaration.conflicting = true;
      }
    }
  }

  // And a declaration a reading refutes is reported, once per state and purpose, rather than
  // quietly repaired. It is not dropped, and the one place it is not already a `warning` is here:
  // an element list is an inventory rather than a claim about every moment, and a capture has
  // limits (an element in the DOM but outside the interactive list). What the commit can say is
  // narrower and worth saying — this claim was made from a reading that does not show it, so either
  // the element or the reading is wrong, and it is the reader who can still go and look.
  for (const [stateId, purposes] of declaredInState) {
    for (const entry of purposes) {
      if (entry.observed !== false) continue;
      const owner = ownerByPurpose.get(entry.purpose);
      const keepsIt = !owner || owner.state_id === stateId;
      findings.push({
        scope: stateId,
        code: 'element_declaration_refuted_by_its_reading',
        severity: 'info',
        basis: 'evidence_check',
        detail: `semantic_purpose ${JSON.stringify(entry.purpose)} was declared in ${stateId} from reading ${entry.from ?? 'an unnamed reading'}, and that reading's own capture does not list it in its interactive surface. `
          + (keepsIt
            ? 'No state\'s reading shows it either, so the declaration is kept where it was made: an element list is an inventory, not a claim about every moment, and a capture has limits that would make dropping it a data loss. Nothing in the evidence supports it, though, and the locator and description come from the one reading that cannot vouch for them.'
            : `The declaration is kept in ${owner.state_id} instead — that state's reading does show the element, and this state is listed on the declaration in metadata.extra.also_declared_in.`),
      });
    }
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
      detail: `${declaration.id} was declared by ${declaration.seen_in.join(' and ')}. Element ids are unique across all states (§14.1), so it is declared once — in ${declaration.owner}, the state whose own reading best supports the declaration — and the other states are listed on it in metadata.extra.also_declared_in.`
        + (declaration.conflicting
          ? ' One of the declarations describes a different element (role/name differ), so the purpose may be naming two things; give them distinct purposes.'
          : ''),
    });
  }

  // --- capabilities: a behaviour is named once and may be composed later -----
  // `capabilities.jsonl` holds one canonical record per behaviour name, plus one
  // `capability_composition` row per later declaration of what that behaviour is built from —
  // which steps a behaviour contains is usually only visible after they have been walked, so the
  // composition often arrives in a call after the one that named it. Two records, one object:
  // the commit is where they are read together.
  const canonicalCapabilities = capabilities.filter((record) => record.kind !== 'capability_composition' && record.kind !== 'realization_step');
  const compositionsByCapability = new Map();
  for (const record of capabilities) {
    if (record.kind !== 'capability_composition') continue;
    const id = record.capability_id ?? record.id;
    if (!id) continue;
    const list = compositionsByCapability.get(id) ?? [];
    list.push(record);
    compositionsByCapability.set(id, list);
  }

  // --- realisation: which step of a behaviour each edge is ------------------
  // The third kind of record in `capabilities.jsonl`. A composition says what a behaviour is
  // made of and is a claim about capabilities; a realisation says what a browser does and is a
  // claim about the page. They are written in the same file because they are read together —
  // but a realisation is not a capability, and the filter above is what keeps one from being
  // committed as one.
  //
  // A step of a behaviour is a step *of that behaviour*, so one edge is one step however many
  // times it was walked: the key is the pair, exactly as `recordTransition` keys an edge by its
  // endpoints. The log is append-only, so a re-walked step has more than one record and the
  // newest stands — the walk is where the run is now, and a behaviour's edge is its last step's
  // destination (D12). A record with no `walk_index` cannot be ordered against the others, so it
  // sorts before all of them rather than after: guessing last would claim that an unordered step
  // ends a behaviour, which is the one position a step cannot be guessed into.
  const realizationByKey = new Map();
  for (const record of capabilities) {
    if (record.kind !== 'realization_step') continue;
    const id = record.capability_id ?? record.id;
    if (!id) continue;
    const key = JSON.stringify([id, record.transition_id ?? null]);
    const previous = realizationByKey.get(key);
    if (previous && (previous.walk_index ?? -1) > (record.walk_index ?? -1)) continue;
    realizationByKey.set(key, record);
  }
  const realizationsByCapability = new Map();
  for (const record of realizationByKey.values()) {
    const list = realizationsByCapability.get(record.capability_id) ?? [];
    list.push(record);
    realizationsByCapability.set(record.capability_id, list);
  }
  for (const list of realizationsByCapability.values()) {
    list.sort((left, right) => (left.walk_index ?? -1) - (right.walk_index ?? -1));
  }

  // --- APIs: the requests the machinery watched, as entities ---------------
  // The evidence here is the run's own network log, not a claim by the model. That is the whole
  // difference between this section and the rest of the graph: a state, a capability or a journey
  // is the model's reading of a page, but an endpoint either was called or was not, and the page
  // hooks saw it either way. Aggregated per endpoint across the whole run, because one call in one
  // reading is not enough to describe an API: the status a call answers with is what a generator
  // asserts on, and the interesting ones (a 401 before a login, a 200 after) only appear when the
  // readings are read together.
  const apis = new Map(); // id -> entity
  const apiIdByEndpoint = new Map(); // 'GET /api/projects' -> id
  const apisByObservation = new Map(); // observation id -> [api id]
  const apiIdCollisions = [];
  for (const observation of observations) {
    const list = [];
    for (const seen of observedApis(observation.capture?.network)) {
      const endpoint = `${seen.method} ${seen.path}`;
      let id = apiIdByEndpoint.get(endpoint);
      if (!id) {
        id = seen.id;
        const holder = apis.get(id);
        if (holder && `${holder.method} ${holder.path}` !== endpoint) {
          // Two endpoints whose ids slug to the same string, which takes a long path — the slug is
          // clipped — or a `/a-b` that reads as `/a/b`. Both are kept, because dropping one would
          // mean the evidence says a call happened and the graph says no such endpoint exists;
          // the second is renamed and the rename is reported, because the model may have seen the
          // unsuffixed id in a digest and that id now names a different endpoint.
          let candidate = id;
          let suffix = 2;
          while (apis.has(candidate)) candidate = `${id}_${suffix++}`;
          apiIdCollisions.push({
            id,
            first: `${holder.method} ${holder.path}`,
            second: endpoint,
            minted: candidate,
          });
          id = candidate;
        }
        apiIdByEndpoint.set(endpoint, id);
        apis.set(id, {
          id,
          method: seen.method,
          path: seen.path,
          endpoint,
          urls: [],
          statuses: [],
          durations: [],
          failure_reasons: [],
          failures: 0,
          requests: 0,
          observations: [],
        });
      }
      const entity = apis.get(id);
      if (!entity.urls.includes(seen.url)) entity.urls.push(seen.url);
      for (const status of seen.statuses) if (!entity.statuses.includes(status)) entity.statuses.push(status);
      for (const duration of seen.durations) entity.durations.push(duration);
      if (seen.failed === true) {
        entity.failures += 1;
        if (seen.failure_reason && !entity.failure_reasons.includes(seen.failure_reason)) {
          entity.failure_reasons.push(seen.failure_reason);
        }
      }
      entity.requests += seen.requests;
      if (!entity.observations.includes(observation.id)) entity.observations.push(observation.id);
      if (!list.includes(id)) list.push(id);
    }
    if (list.length) apisByObservation.set(observation.id, list);
  }

  const ctx = {
    stateIds,
    elementIdByPurpose,
    elementIds: new Set(elementIdByPurpose.values()),
    declarations,
    capabilityIds: new Set(canonicalCapabilities.map((record) => record.capability_id ?? record.id).filter(Boolean)),
    apiIds: new Set(apis.keys()),
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

  // The identity each endpoint of a step carries, for the state-variable rule below. Read from the
  // canonical records rather than from the committed states, because edges are decided before
  // states are built and what a step's own report says should not depend on that order.
  const identityByStateId = new Map(
    canonicalStates.map((record) => [record.state_id, record.identity ?? {}]),
  );

  // --- what the readings counted -----------------------------------------
  //
  // `{projects: non_empty}` is a claim about how many rows a collection holds, and until this
  // existed the graph could not check it: the capture read a list for *presence* and nothing read
  // it for *size*, so the only assertion the commit could offer for such a dimension was a `value`
  // comparison against the word itself — a check no browser can evaluate. `capture.js` now counts
  // the rows of a row-shaped container, and this is the index the rest of the commit already uses
  // (declared element → the reading that shows it), read for the count.
  //
  // Keyed by state, because the count is a fact about the surface a state was read at — the
  // destination of a step, asked for the row count its own identity depends on.
  const collectionFacts = new Map();
  for (const record of canonicalStates) {
    const facts = [];
    for (const element of stateElements.get(record.state_id) ?? []) {
      const purpose = element?.semantic?.purpose;
      const declaration = purpose ? declarations.get(purpose) : null;
      if (!declaration) continue;
      for (const observationId of observationsByState.get(record.state_id) ?? []) {
        const capture = observationsById.get(observationId)?.capture ?? null;
        if (!capture) continue;
        const entry = (capture.interactive ?? []).find((item) => {
          if (!item || !Number.isInteger(item.items)) return false;
          if (declaration.role && declaration.name && item.role === declaration.role && item.name === declaration.name) return true;
          const locator = declaration.locator;
          if (!locator) return false;
          if (locator.strategy === 'testid' && item.testid === locator.value) return true;
          if ((locator.strategy === 'id' || locator.strategy === 'css') && item.selector === locator.value) return true;
          return false;
        });
        if (!entry) continue;
        facts.push({
          element: element.id,
          purpose,
          items: entry.items,
          first_item: entry.first_item ?? null,
          observation: observationId,
        });
      }
    }
    if (facts.length) collectionFacts.set(record.state_id, facts);
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
        // A superseded candidate is not a rejection, so there is no reason to give — but the
        // key has to be here all the same. `decisions[]` is one table with one shape, and a row
        // whose keys depend on which branch produced it is a row every reader has to special-case.
        // The tool boundary is where that stops being a style question: the projection copies
        // these fields straight out, and a key that is absent rather than null is `undefined`,
        // which is not JSON. See `graph_commit`'s projection.
        rejection_reason: null,
        rejection_basis: null,
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

    // What this step actually called. Two things can say: the model may name endpoints (the
    // `apis` argument of `graph_transition`), and the reading taken after the step shows the
    // requests the page made while it ran — the hooks are drained on every capture, so a reading's
    // network list is its own step's traffic. Both are kept, and both are recorded separately,
    // because "the model says this step calls that endpoint" and "this reading saw a call to that
    // endpoint" are different kinds of claim and a reader is entitled to tell them apart.
    //
    // The reading the step produced is named by the record's own evidence, not by a field: the
    // store writes `before_observation`/`after_observation` into `evidence[]` with the roles that
    // say what each reading is evidence *for*, so the `action` ref is the reading the action
    // produced. A log shape that carries the field itself is accepted too — neither spelling may
    // lose the step's own traffic.
    const readingWithRole = (role) => {
      for (const ref of candidateEvidence) {
        if ((typeof ref === 'object' ? ref?.role : null) !== role) continue;
        const observationId = typeof ref === 'string' ? ref : ref?.observation;
        if (observationId) return observationId;
      }
      return null;
    };
    const afterObservation = winner.record.after_observation
      ?? readingWithRole('action')
      ?? readingWithRole('effect')
      ?? null;
    const observedForStep = afterObservation ? apisByObservation.get(afterObservation) ?? [] : [];
    const declaredApis = winner.apis;
    const unobservedClaims = declaredApis.filter((apiId) => !observedForStep.includes(apiId));
    if (unobservedClaims.length) {
      findings.push({
        scope: id,
        code: 'api_declared_but_not_observed',
        severity: 'info',
        basis: 'evidence_check',
        detail: `the step names ${unobservedClaims.join(', ')} and the reading taken after it shows no request to them. The reference is kept — an app is free to burst a second request after the page settles — but this step's own evidence does not show that call, so a generator should not treat it as verified by this edge.`,
      });
    }
    const stepApis = distinct([...declaredApis, ...observedForStep]);

    // The variables this step moved, split by what the movement is *evidence of*.
    //
    // This is the third answer to a difference the model can see and the page cannot: a step that
    // changed something the application remembers is not a new screen, and it is not nothing. It
    // is a variable — and the report is where that has to be said, because the two ways of losing
    // it are both silent. Naming a *screen* fact as a dimension keeps two states apart without
    // minting a state per value; a `value` assertion of the same name in the state's detection is
    // what makes it checkable. Recording neither leaves a generator with two states it cannot tell
    // apart at runtime, or with no state at all for a difference that is real.
    //
    // A *persistence* fact is the other case, and it is not the same advice. `storage_changed` is
    // the run's proof that what happened survives a reload, which is evidence about the state and
    // not an observable: no browser can be asked what the application remembers, so telling the
    // model to pin the key as a dimension would ask for a test that cannot be written. It is
    // reported — named, and attributed to this edge — and it is not counted as unrecorded.
    const movedVariables = stateVariablesOf(winner.effects);
    const semanticVariables = semanticVariablesOf(winner.effects);
    const persistenceVariables = persistenceVariablesOf(winner.effects);
    const endpointIdentities = [
      identityByStateId.get(winner.record.from_state) ?? {},
      identityByStateId.get(winner.record.to_state) ?? {},
    ];
    const unrecordedVariables = unrecordedStateVariables(winner.effects, endpointIdentities);
    if (unrecordedVariables.length) {
      const named = unrecordedVariables.map((variable) => `${variable.name} (${variable.kind})`).join(', ');
      const example = unrecordedVariables[0].name.split('.').filter(Boolean).pop();
      findings.push({
        scope: id,
        code: 'state_variable_not_in_state_identity',
        severity: 'info',
        basis: 'evidence_check',
        detail: `this step changed ${named}, and neither ${winner.record.from_state} nor ${winner.record.to_state} records it as a dimension. A collection the screen is showing is a state variable: if it is what makes the destination a different situation, name it in that state's identity.dimensions ({${example}: non_empty}) and pin the same name in its detection with an assertion a browser can actually evaluate — {"type":"value","target":"${example}","operator":"greater_than","expected":0} when the evidence counted the rows, since a reader of the page cannot tell "three projects" from "one project" without counting. A dimension nothing asserts cannot be checked, and one state per value reports a three-valued variable as three screens. If nothing downstream reads it, it belongs in the effect and nowhere else.`,
      });
    }
    if (persistenceVariables.length) {
      findings.push({
        scope: id,
        code: 'persistence_evidence_recorded',
        severity: 'info',
        basis: 'evidence_check',
        detail: `the reading at the end of this step shows ${persistenceVariables.map((variable) => JSON.stringify(variable.name)).join(', ')} written to the page's own storage, so ${winner.record.to_state} is remembered rather than merely displayed. Kept as evidence and deliberately not offered as a dimension: no browser can be asked what the application remembers about a user, so a value assertion over a storage key is a check nothing can evaluate. It belongs in this edge's evidence and in a test's setup, or as a precondition on the states that depend on it.`,
      });
    }
    const variableRollup = {
      moved: movedVariables,
      // By name: `unrecordedStateVariables` reads the effects again, so the entries are equal as
      // values and not as objects, and an identity comparison would put every variable in both
      // lists at once. Over the *semantic* half, because "recorded" means a state identity names
      // it as a dimension: a storage key was never a candidate to be one, so it appears in neither
      // of these lists and in `persistence` instead — and a rollup that called it "recorded" would
      // be saying the graph holds a difference it deliberately does not.
      recorded: semanticVariables.filter(
        (variable) => !unrecordedVariables.some((entry) => entry.name === variable.name),
      ),
      unrecorded: unrecordedVariables,
      // The two lists the old single rollup conflated: what the screen shows, and what the
      // application remembers. Named separately so a reader — model or generator — cannot mistake
      // one for the other, which is exactly the mistake the merged list invited.
      semantic: semanticVariables.map((variable) => variable.name),
      persistence: persistenceVariables.map((variable) => variable.name),
    };

    // --- what this step proves, as an assertion a test could carry ------
    //
    // The graph has one place for a check and the model is the only thing that writes it, which is
    // right (a check is a claim about what matters) and leaves the one gap the review found: a step
    // whose evidence *already proves* something leaves the graph with no assertion at all, and a
    // generator then has to invent the assertion for the very step the machinery watched. So the
    // candidates are derived here, from the step's own effects and the reading at the end of it,
    // and written into the commit report beside the edge — never into the edge's `assertions[]`,
    // which is the model's list and stays exactly as the model wrote it.
    //
    // Every candidate has to clear the same bar: the machinery's own evidence must show the thing
    // it claims. An effect the reading at the end of the step does not corroborate is *not*
    // proposed, because that would be the commit writing a check it cannot itself pass.
    const arrivalIdentity = identityByStateId.get(winner.record.to_state) ?? {};
    const arrivalDimensions = arrivalIdentity.dimensions ?? {};
    const afterCapture = afterObservation ? observationsById.get(afterObservation)?.capture ?? null : null;
    const candidateAssertions = [];
    const declinedAssertions = [];
    const addCandidate = (assertion, basis, detail) => {
      const key = JSON.stringify(assertion);
      if (candidateAssertions.some((candidate) => JSON.stringify(candidate.assertion) === key)) return;
      candidateAssertions.push({ assertion, basis, detail, from: afterObservation });
    };
    // The same purpose-to-id resolution every other reference here goes through, so a candidate
    // names the element the graph declares rather than the word the effect used.
    const effectElementId = (effect) => {
      const purpose = purposeOf(effect?.target);
      return purpose === null ? null : ctx.elementIdByPurpose.get(purpose) ?? null;
    };
    const effectElementPresent = (effect) => {
      const purpose = purposeOf(effect?.target);
      const declaration = purpose === null ? null : declarations.get(purpose);
      return declaration ? elementPresentIn(afterCapture, declaration) : null;
    };
    for (const effect of winner.effects) {
      if (effect.type === 'state_entered') {
        const named = typeof effect.to === 'string' ? effect.to.trim() : '';
        if (named && stateIds.has(named)) {
          addCandidate(
            { type: 'state', state: named, operator: 'equals' },
            'effect',
            `the step claims it arrived in ${named}, and ${named} is a state this graph commits.`,
          );
        } else if (named) {
          declinedAssertions.push({ effect: effect.type, reason: 'state_target_is_not_committed', target: named });
        }
        continue;
      }
      if (effect.type === 'navigation' || effect.type === 'url_changed') {
        const raw = typeof effect.to === 'string' ? effect.to.trim() : '';
        const route = raw ? routeOf(raw) ?? raw : null;
        if (route) {
          addCandidate(
            { type: 'url', operator: 'matches', expected: route, description: `arrived at ${raw}` },
            'effect',
            `the step claims it navigated to ${raw}, which is ${route}.`,
          );
        }
        continue;
      }
      if (effect.type === 'element_created' || effect.type === 'element_destroyed') {
        const element = effectElementId(effect);
        if (!element) continue;
        const wants = effect.type === 'element_created' ? 'visible' : 'hidden';
        const present = effectElementPresent(effect);
        // Only when the reading the step produced agrees. `null` — no capture, or a capture with
        // no interactive list — is not agreement, because a candidate has to be a claim the
        // evidence supports rather than one it merely does not contradict.
        if (present === null) {
          declinedAssertions.push({ effect: effect.type, reason: 'no_reading_to_corroborate_it', target: element });
          continue;
        }
        const agrees = effect.type === 'element_created' ? present === true : present === false;
        if (!agrees) {
          declinedAssertions.push({ effect: effect.type, reason: 'reading_does_not_show_it', target: element });
          continue;
        }
        addCandidate(
          { type: 'element_state', element, operator: 'equals', expected: wants },
          'effect',
          `the step claims it ${effect.type === 'element_created' ? 'created' : 'destroyed'} ${element}, and the reading at the end of the step shows it ${wants}.`,
        );
        continue;
      }
      if (effect.type === 'value_changed') {
        const element = effectElementId(effect);
        if (!element || typeof effect.to !== 'string') continue;
        // Read back from the capture, not from the effect: the effect says what the model believed
        // the field would hold, and a `value_changed` nobody can confirm is exactly the kind of
        // assertion that fails on the first run.
        const purpose = purposeOf(effect.target);
        const recorded = afterCapture && purpose !== null
          ? (afterCapture.interactive ?? []).find((item) => item && item.role === declarations.get(purpose)?.role
            && item.name === declarations.get(purpose)?.name)?.value
          : undefined;
        if (typeof recorded === 'string' && recorded === effect.to) {
          addCandidate(
            { type: 'element_value', element, operator: 'equals', expected: effect.to },
            'effect',
            `the step claims the field now holds ${JSON.stringify(effect.to)}, and the reading at the end of the step shows the same value.`,
          );
        } else {
          declinedAssertions.push({
            effect: effect.type,
            reason: typeof recorded === 'string' ? 'reading_shows_a_different_value' : 'reading_cannot_confirm_the_value',
            target: element,
          });
        }
        continue;
      }
    }
    // The destination's own dimensions, offered against a count when the evidence has one. This is
    // the third shape of the same problem: a dimension is the model's word for a difference the
    // screen does not spell out, and `{projects: non_empty}` is uncheckable until something says
    // how many. The capture counts a collection's rows (capture.js), so when a reading bound to
    // the destination counted them, the candidate is the count — not the word.
    for (const [name, value] of Object.entries(arrivalDimensions)) {
      const facts = collectionFacts.get(winner.record.to_state) ?? [];
      // Exact first, then tolerant. A name that matches exactly is taken; the looser relation is
      // consulted only when nothing did, because `projects` and `project_list` are two spellings of
      // one collection but `projects` and `project` are not — and a suggestion that is right for the
      // wrong reason is a failing test nobody can explain.
      const exact = facts.filter(
        (fact) => sameVariableName(fact.purpose, name) || sameVariableName(fact.element, name),
      );
      const related = exact.length ? exact : facts.filter(
        (fact) => sameCollectionName(fact.purpose, name) || sameCollectionName(fact.element, name),
      );
      // Two collections that could each be the one the dimension names is not a tie to break
      // quietly: the count would be of one and the dimension about another, which is exactly the
      // assertion that passes for the wrong reason. Said, and declined, so the model can name the
      // dimension after the element it means.
      if (related.length > 1) {
        declinedAssertions.push({
          effect: 'dimension',
          reason: 'more_than_one_collection_could_be_the_one',
          target: name,
          detail: `${JSON.stringify(name)} is declared as ${JSON.stringify(value)}, and ${related.length} collections on ${winner.record.to_state} could be the one it names (${related.map((fact) => fact.element).join(', ')}). Name the dimension after the element it means and the count can be attributed.`,
        });
        continue;
      }
      const countable = related[0];
      if (!countable) continue;
      const word = String(value).toLowerCase();
      const wantsRows = ['non_empty', 'not_empty', 'has_items', 'some'].includes(word);
      const wantsZero = ['empty', 'none', 'no_items'].includes(word);
      if (wantsRows && countable.items > 0) {
        addCandidate(
          { type: 'value', target: name, operator: 'greater_than', expected: 0 },
          'dimension',
          `${winner.record.to_state} declares the dimension ${JSON.stringify(name)} as ${JSON.stringify(value)}, and the reading at the end of the step counted ${countable.items} row(s) in ${countable.element} — so the dimension is checkable as a count.`,
        );
      } else if (wantsZero && countable.items === 0) {
        addCandidate(
          { type: 'value', target: name, operator: 'equals', expected: 0 },
          'dimension',
          `${winner.record.to_state} declares the dimension ${JSON.stringify(name)} as ${JSON.stringify(value)}, and the reading at the end of the step counted no rows in ${countable.element} — so the dimension is checkable as a count.`,
        );
      } else {
        declinedAssertions.push({
          effect: 'dimension',
          reason: 'no_reading_counted_the_collection',
          target: name,
          detail: `${JSON.stringify(name)} is declared as ${JSON.stringify(value)}, and no reading bound to ${winner.record.to_state} carries a row count for the collection it names.`,
        });
      }
    }

    // --- which reading documents this step ------------------------------
    //
    // The reading the action produced, which is the reading the step's evidence calls `action`,
    // and the reading it started from. Kept on the edge — in the commit's own account, not in the
    // schema's fields, because `transition.schema.json` has no place for it and the review's point
    // stands: an edge whose evidence cannot say which reading documented the action is an edge a
    // reader has to infer.
    const beforeObservation = winner.record.before_observation ?? readingWithRole('identity') ?? null;
    const beforeCapture = beforeObservation ? observationsById.get(beforeObservation)?.capture ?? null : null;
    const stepLinkage = {
      action_id: winner.record.action_id ?? observationsById.get(afterObservation)?.action_id ?? null,
      before_observation: beforeObservation,
      after_observation: afterObservation,
      before_role: 'identity',
      after_role: 'action',
      // What the two readings were compared against each other: the surface the step started from
      // and the surface it left. Recorded because the difference between them is the whole of what
      // the machinery observed about this step, and a report that says "the step changed a
      // collection" without saying what it saw change is asking to be taken on trust.
      before_surface: beforeCapture ? surfaceOf(beforeCapture).length : null,
      after_surface: afterCapture ? surfaceOf(afterCapture).length : null,
    };

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
      ...(stepApis.length ? { apis: stepApis } : {}),
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
            // Which endpoint references came from the model and which from the reading taken after
            // the step. `apis` on the edge is the union; these two say who claimed what.
            apis_declared: declaredApis,
            apis_observed: observedForStep,
            // The state variables this step moved, and which of them the graph can hold. On the
            // edge rather than only in the report, because the question "is this difference a
            // dimension or a state?" is asked about a *step*, and the edge is where the step is.
            // `semantic` and `persistence` split it by what the movement is evidence *of*: a
            // collection the screen shows (a dimension), and a key the application remembers (not
            // an observable at all).
            state_variables: variableRollup,
            // The readings this step was *made of*: the one the action produced and the one it
            // started from, by id, plus what the machinery saw each look like. The edge's
            // `evidence[]` says what each reading is evidence for; this says which reading is the
            // step itself, which is the question a reader of the graph asks first.
            step: stepLinkage,
            // What the step's own effects prove, as assertions a generator could carry, and what
            // was declined and why. Deliberately not written into `assertions[]`: that list is the
            // model's, and a commit that wrote into it would be making the claim itself. This is
            // the closest thing to "what the machinery watched happen", graded by what the
            // evidence can support, so that a test generator has something to start from when the
            // model supplied no assertion for the step that mattered.
            candidate_assertions: candidateAssertions,
            candidate_assertions_declined: declinedAssertions,
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

  // --- journeys: the walk, reassembled ------------------------------------
  // Now that the edges are decided, the walk can be read back as journeys. `canonicalStates` is
  // the set of state ids the graph is about to carry, which is what a journey's steps have to
  // join: every one of them becomes a `stateRecords[]` entry below, gated or not.
  const assembled = assembleJourneys({
    transitions,
    edges: committedEdges,
    stateIds: new Set(canonicalStates.map((record) => record.state_id)),
    generatedAt,
    // The run's own instruction, which is the only statement of intent the run has. Quoted into
    // the journey rather than paraphrased: see `assembleJourneys`.
    instruction: run.instruction ?? null,
  });
  const journeys = assembled.journeys;
  const journeysWithGoal = journeys.filter((journey) => typeof journey.goal === 'string' && journey.goal);

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

    // Every reading bound to a state is read as evidence for *that* state — that is what binding
    // one means — so a reading whose controls have nothing in common with the others is evidence
    // that at least one of them was named with a state it was not on. This is what the detection
    // check above leaves behind: a misbinding is caught there only when the detection happens to
    // mention the surface it contradicts, and a state whose detection is a bare route assertion
    // is contradicted by nothing.
    //
    // Nothing is dropped, and this is not a gate. Which of two readings is the wrong one is
    // exactly the judgement the commit does not make, and evidence cannot be withdrawn anyway —
    // so the fact is carried in `graph.json`'s own warnings, which is the only place a reader who
    // arrives after the browser is closed can learn that a state is two screens.
    const surfaces = bound.map((observation) => ({ observation, surface: surfaceOf(observation.capture) }));
    const strangers = surfaces.filter((reading) => surfaceIsDisjoint(
      reading.surface,
      surfaces.filter((other) => other !== reading).map((other) => other.surface),
    ));
    if (strangers.length) {
      findings.push({
        scope: record.state_id,
        code: 'state_readings_share_no_surface',
        severity: 'warning',
        basis: 'evidence_check',
        detail: `${strangers.map((reading) => `${reading.observation.id} shows ${reading.surface.slice(0, 4).join(', ')}${reading.surface.length > 4 ? ', …' : ''}`).join('; ')}, and shares no control with the other reading(s) of this state. A state's readings are all readings of one screen, so one of these bindings is wrong — most often a reading named with the state the action had just left, which nothing contradicted because an identity is the model's judgement. Carried rather than repaired: which reading is the wrong one is not for the evidence to settle. But the state's detection is only as strong as the readings it is checked against, and a detection that names no element (a bare route assertion, say) is refuted by neither of these screens.`,
      });
    }

    // The evidence side of the identity above, written next to it because that is what it is for:
    // `indistinguishableStates` compares these across the committed states, and a state whose
    // readings recorded nothing gets no fingerprint rather than an empty one.
    const observable = observableOf(bound.map((observation) => observation.capture));

    // A dimension is the model's word for a fact the screen does not carry — `{cart: non_empty}` is
    // why two states can share a route and still be two situations. The schema asks a state's
    // detection to pin the values from `identity.dimensions`, and this is that sentence as a check:
    // a dimension nothing asserts is a label rather than a variable, because the generator gets the
    // word and no way to decide the state at runtime. Asserted with the same name, the dimension is
    // what the test checks and the state is provable; the assertion is a `value` target, which the
    // schema carries as a semantic path (see `normalizeAssertion`).
    const dimensions = dimensionNamesOf(record.identity);
    const unassertedDimensions = dimensions.filter((name) => !detection.some(
      (entry) => entry?.type === 'value' && sameVariableName(entry.target, name),
    ));
    if (unassertedDimensions.length) {
      findings.push({
        scope: record.state_id,
        code: 'state_dimension_not_asserted',
        severity: 'info',
        basis: 'vocabulary',
        detail: `this state's identity declares ${unassertedDimensions.map((name) => JSON.stringify(name)).join(', ')} in \`identity.dimensions\`, and no detection entry asserts it. A dimension is what tells this state apart from the sibling that shares its route, and only an assertion can check it: add {"type":"value","target":${JSON.stringify(unassertedDimensions[0])},"operator":"equals","expected":"<the value>"} to \`detection\` — the same name, so the graph's word for the difference and the test's check for it are one thing. A dimension nothing can read at runtime is a description, not an identity.`,
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

    // The endpoints this state's readings show a call to. A reading's network list is the traffic
    // of the step that led to it, so a state that was entered by a form post carries the endpoint
    // that post went to; the same request also lands on the transition, from the other side.
    const stateApis = distinct(observationIds.flatMap((observationId) => apisByObservation.get(observationId) ?? []));

    stateRecords.push({
      id: record.state_id,
      identity,
      ...(typeof record.summary === 'string' && record.summary ? { description: record.summary } : {}),
      ...(stateElements.get(record.state_id)?.length ? { elements: stateElements.get(record.state_id) } : {}),
      ...(available.length ? { capabilities: available } : {}),
      ...(stateApis.length ? { apis: stateApis } : {}),
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
          commit: { decision: 'committed', candidate_id: record.state_id, readings: observationIds.length, apis: stateApis },
          identity_key: record.identity_key ?? null,
          // What the captures recorded, so a reader can see what a state identity was told apart
          // *by*, and so the pair rule (`indistinguishableStates`) has something to compare. The
          // model's own words are in `identity` and `identity_key` above; this is the page's.
          ...(observable ? { observable } : {}),
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

  // --- states the evidence cannot tell apart --------------------------------
  // The other half of §14.4. That rule compares the identities the model wrote against each other;
  // this one asks whether the evidence distinguished them at all. A state's identity is a judgement
  // — `page_type`, `variant`, `dimensions` are words — and a pair of states the model told apart
  // and the page did not is either one screen with two names, or two screens whose difference is a
  // value the surface does not carry. Both are worth saying, and neither is repaired here: which of
  // two identities is the wrong one is not something the captures can settle.
  for (const group of indistinguishableStates(stateRecords)) {
    for (const stateId of group.ids) {
      const others = group.ids.filter((id) => id !== stateId);
      findings.push({
        scope: stateId,
        code: 'state_indistinguishable_from_another',
        severity: 'warning',
        basis: 'evidence_check',
        detail: `nothing the captures recorded tells this state apart from ${others.join(', ')}: ${observableSummary(group.observable)}. If they are two screens, the difference is a value the surface does not carry — record it in \`identity.dimensions\`, which is what a generator reads to know which variant it is looking at; if they are one screen, one of the ids is not a state and the readings of both belong to one. Carried rather than repaired: which identity is the wrong one is not for the evidence to settle. The fingerprint itself is on every one of them, in \`metadata.extra.observable\`.`,
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
  // A realisation that names a behaviour the run never committed is a step of nothing, and it is
  // invisible rather than merely unresolved: the loop below attaches steps per capability, so a
  // record whose capability is not there has no iteration to be attached on. Reported here, once
  // per orphan, because a silent drop is the one outcome this layer must never produce.
  for (const record of realizationByKey.values()) {
    if (ctx.capabilityIds.has(record.capability_id)) continue;
    findings.push({
      scope: record.capability_id ?? 'realization',
      code: 'realization_does_not_resolve',
      severity: 'warning',
      basis: 'reference_check',
      detail: `a step is recorded as part of ${JSON.stringify(record.capability_id ?? null)}, which no committed behaviour has (invariant 2), so it belongs to nothing and was dropped. A step is a step *of* a behaviour: if that behaviour was meant to exist, the call that would have named it never recorded a name.`,
    });
  }

  const capabilityRecords = canonicalCapabilities.map((record) => {
    const id = record.capability_id ?? record.id;
    const attempts = attemptsByCapability.get(id) ?? [];
    const committed = attempts.filter((attempt) => attempt.decision === 'committed');
    const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
    const input = plain(record.input);
    const output = plain(record.output);
    // What the behaviour is built from, from every record that said: the first sighting and every
    // composition appended afterwards. A step is kept only when it names a capability this graph
    // commits — a `composed_of` pointing at nothing is the same dangling reference every other
    // one here is refused for, and a behaviour that contains itself is not one a test can perform.
    const declaredSteps = distinct([
      ...(Array.isArray(record.composed_of) ? record.composed_of : []),
      ...(compositionsByCapability.get(id) ?? []).flatMap((entry) => (Array.isArray(entry.composed_of) ? entry.composed_of : [])),
    ].filter((value) => typeof value === 'string' && value));
    const steps = declaredSteps.filter((value) => value !== id && ctx.capabilityIds.has(value));
    // A composition record may also be the call that says the behaviour is a composite, and that
    // has to win: the kind is recorded on first use and a behaviour named before its structure was
    // understood would otherwise stay a single action forever.
    const kindWasUpgraded = (compositionsByCapability.get(id) ?? []).some((entry) => entry.capability_kind === 'composite');
    const kind = kindWasUpgraded ? 'composite' : record.capability_kind;
    if (declaredSteps.includes(id)) {
      findings.push({
        scope: id,
        code: 'composed_of_names_itself',
        severity: 'warning',
        basis: 'reference_check',
        detail: `${id} was declared as built from itself. A behaviour cannot be one of its own steps, so the self-reference was dropped: name the steps it is made of, and keep the transition that completes it as this capability's own edge.`,
      });
    }
    const unresolvedSteps = declaredSteps.filter((value) => !ctx.capabilityIds.has(value));
    if (unresolvedSteps.length) {
      findings.push({
        scope: id,
        code: 'composed_of_does_not_resolve',
        severity: 'warning',
        basis: 'reference_check',
        detail: `${id} is built from ${unresolvedSteps.join(', ')}, which no committed capability has (invariant 2). The reference was dropped, so the graph does not claim a step it cannot name.`,
      });
    }
    if (kind === 'composite' && !steps.length) {
      findings.push({
        scope: id,
        code: 'composite_without_composed_of',
        severity: 'info',
        basis: 'schema_invariant',
        detail: `${id} is committed as kind \`composite\` and names no steps, so nothing says which behaviours it expands into — a generator has to expand it itself or the composite is a single opaque action (capability.schema.json: composite is a capability built from other capabilities).`,
      });
    }
    if (kind !== 'composite' && steps.length) {
      findings.push({
        scope: id,
        code: 'composed_of_on_a_non_composite',
        severity: 'warning',
        basis: 'schema_invariant',
        detail: `${id} is built from ${steps.join(', ')} and its kind is ${JSON.stringify(kind ?? null)}, not \`composite\`. The composition is carried, because the run declared it, but a generator reading \`kind\` will treat this as one action rather than as the steps it is made of.`,
      });
    }
    // --- the realisation: how the behaviour is performed --------------------
    // `capability.schema.json` already has the home for this — `steps[]`, "how to realise the
    // capability in the UI. Ordered, deterministic" — so folding the recorded steps into it is a
    // translation rather than a new field of our own, exactly as `actors` is. It matters more
    // here than there: a `composed_of` names the behaviours a composite contains, which a
    // generator can expand only if it already knows how each of them is performed, and a `steps[]`
    // is the answer. Without it the graph is a vocabulary with no verbs, and the only way to
    // perform one is to replay the run.
    //
    // Order is the recording order, and the recording order is the walk. A behaviour's steps are
    // performed in the order they were performed, so this is the one array in the graph whose
    // order is load-bearing rather than incidental. A step whose edge the run never walked cannot
    // exist here (the tool records the step against the edge it just wrote) but a step whose
    // behaviour does cannot either, and both are reported rather than carried.
    const recordedRealization = realizationsByCapability.get(id) ?? [];
    const realizationSteps = [];
    const droppedRealization = [];
    for (const record of recordedRealization) {
      const step = projectStep(record);
      if (step) realizationSteps.push(step);
      else droppedRealization.push(record);
    }
    if (droppedRealization.length) {
      findings.push({
        scope: id,
        code: 'realization_step_not_a_step',
        severity: 'warning',
        basis: 'schema_invariant',
        detail: `${id} has ${droppedRealization.length} recorded step(s) that are not steps \`capability.schema.json\` can hold: `
          + `${droppedRealization.map((record) => JSON.stringify(record.action ?? null)).join(', ')}. A step needs a browser `
          + `action from the schema's own list (${[...STEP_ACTIONS].join(', ')}), and any other key it carries has to be the `
          + 'type the schema gives it. Each one was dropped, so the graph does not describe a behaviour by a step that is '
          + 'not one — read `capabilities.jsonl` for what was recorded.',
      });
    }
    return {
      id,
      name: record.name,
      ...(typeof record.description === 'string' && record.description ? { description: record.description } : {}),
      ...(CAPABILITY_KINDS.has(kind) ? { kind } : {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
      ...(steps.length ? { composed_of: steps } : {}),
      // `steps` here is the schema's key and `realizationSteps` is the run's record. The two local
      // names above (`steps` for the composition, `declaredSteps` for what it was declared from)
      // are the run's; only the keys are the schema's, and confusing the two is the mistake D13
      // is about.
      ...(realizationSteps.length ? { steps: realizationSteps } : {}),
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
          // The names behind the step ids, because the ids are slugs of them and a reader should
          // not have to reverse a slug to see what a composite is made of.
          composed_of_names: steps.map((value) => (canonicalCapabilities.find((candidate) => (candidate.capability_id ?? candidate.id) === value)?.name ?? null)),
          ...(declaredSteps.length !== steps.length ? { composed_of_dropped: declaredSteps.filter((value) => !steps.includes(value)) } : {}),
          // The projection carries only what `capability.schema.json` has room for, so a reader
          // who wants the verb's prose (`purpose`) or the step that did the work (`effects`) is
          // sent to the log rather than left to conclude they were never recorded.
          ...(droppedRealization.length ? { realization_dropped: droppedRealization.map((entry) => ({ action: entry.action ?? null, transition_id: entry.transition_id ?? null })) } : {}),
          kind_recorded_by_a_later_composition: kindWasUpgraded,
          minted_by: 'graph_transition (first use of the name)',
        },
      }),
    };
  });

  // A cycle is the one composition problem a per-capability check cannot see: every step of every
  // capability in it resolves. It is reported rather than repaired, like every other judgement
  // here, because which of the capabilities in the loop is the one named wrongly is not something
  // the evidence can settle — but a generator asked to expand `a → b → a` never finishes.
  {
    const stepsOf = new Map(capabilityRecords.map((capability) => [capability.id, capability.composed_of ?? []]));
    const reported = new Set();
    const visit = (id, path) => {
      if (path.includes(id)) {
        const cycle = [...path.slice(path.indexOf(id)), id];
        // The same loop is found once per capability in it, each time from a different starting
        // point, so the key is the set of capabilities in the loop rather than the sequence —
        // otherwise `a → b → a` is reported twice and `a → b → c → a` three times.
        const key = [...new Set(cycle)].sort().join('>');
        if (!reported.has(key)) {
          reported.add(key);
          findings.push({
            scope: id,
            code: 'composed_of_cycle',
            severity: 'warning',
            basis: 'schema_invariant',
            detail: `these capabilities contain each other in a loop: ${cycle.join(' → ')}. Each step resolves, so nothing else here notices, but a behaviour cannot be performed in terms of itself.`,
          });
        }
        return;
      }
      for (const step of stepsOf.get(id) ?? []) visit(step, [...path, id]);
    };
    for (const id of stepsOf.keys()) visit(id, []);
  }

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
  //
  // An observation can sit on two edges — the reading a walk produced is the reading the next walk
  // started from — and `observation.transition` is a single field. Only the reading a step *made*
  // points at that step: the refs that say so are the ones an action or an effect produced
  // (`action`/`effect`), because the schema defines `observation.transition` as "the transition this
  // observation documents". The reading a step *started from* documents that step's identity, not
  // the step, and giving it the transition too was the misattribution the live run showed: a
  // reading taken before an action carried the id of the action it preceded, so a reader of
  // `graph.json` saw a reading "documenting" a step it was the *input* to, with no way to tell the
  // two apart. The sibling relation is real and is recorded — as `metadata.extra.linkage`, where
  // the schema has room for it — but not in the field that means "documents".
  const EVIDENCE_ROLE_RANK = { action: 2, effect: 2 };
  const transitionByObservation = new Map();
  const precedesByObservation = new Map();
  for (const edge of committedEdges) {
    const produced = edge.metadata?.extra?.commit?.step?.after_observation ?? null;
    const startedFrom = edge.metadata?.extra?.commit?.step?.before_observation ?? null;
    for (const ref of edge.evidence ?? []) {
      const rank = EVIDENCE_ROLE_RANK[ref.role] ?? (ref.role === 'unknown' ? 0 : 1);
      if (rank < 2) continue;
      if (produced && ref.observation !== produced) continue;
      const held = transitionByObservation.get(ref.observation);
      if (held && held.rank >= rank) continue;
      transitionByObservation.set(ref.observation, { transition: edge.id, rank, role: 'after_action' });
    }
    // The reading the step started from, when it is not also the reading the step produced — the
    // first step of a walk reads one page and then acts on it, and one reading cannot be both.
    if (startedFrom && startedFrom !== produced) {
      const held = precedesByObservation.get(startedFrom);
      if (held) held.precedes.push(edge.id);
      else precedesByObservation.set(startedFrom, { precedes: [edge.id], action_id: edge.metadata?.extra?.commit?.step?.action_id ?? null });
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
      .map((entry) => {
        const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(entry.method) ? entry.method : 'GET';
        const path = endpointOf(entry.url);
        // The endpoint this call belongs to, so the raw request and the api entity that groups it
        // are tied together from both directions: `graph.apis[].evidence` points here, and this
        // points back. An entry whose path could not be read stays without one rather than being
        // dropped — the request happened, and the graph says what it can about it.
        const api = path ? apiIdByEndpoint.get(`${method} ${path}`) : null;
        return {
          method,
          url: entry.url,
          ...(api ? { api } : {}),
          ...(Number.isInteger(entry.status) ? { status: entry.status } : {}),
          ...(Number.isInteger(entry.duration_ms) ? { duration_ms: entry.duration_ms } : {}),
          ...(entry.failed === true ? { failed: true } : {}),
          ...(typeof entry.failure_reason === 'string' ? { failure_reason: entry.failure_reason } : {}),
        };
      });
    const statusTexts = (Array.isArray(capture?.status) ? capture.status : [])
      .map((entry) => entry?.text)
      .filter((text) => typeof text === 'string' && text);
    // What the capture found in the page's own storage, by key name. The capture reads values for
    // localStorage and names only for sessionStorage and cookies (see capture.js: a value is a
    // credential), and `observation.schema.json` has no field for any of it — the names stay in the
    // observation's own metadata rather than being smuggled into a field the schema reserves for
    // bookkeeping. This is the key half of a state's fingerprint, per reading, which is what makes
    // `state.metadata.extra.observable` checkable by hand.
    const capturedKeys = {
      localStorage: capture?.storage && typeof capture.storage === 'object' ? Object.keys(capture.storage) : [],
      sessionStorage: Array.isArray(capture?.session_storage_keys) ? capture.session_storage_keys : [],
      cookies: Array.isArray(capture?.cookie_names) ? capture.cookie_names : [],
    };
    const capturedKeyCount = capturedKeys.localStorage.length + capturedKeys.sessionStorage.length + capturedKeys.cookies.length;
    // What this reading *is* in the walk, which is the question the review asked of the live graph
    // and the schema has no field for. `observation.transition` says which step the reading
    // documents; this says where it sits relative to the steps around it, by the machine's own
    // account: which action produced it (the `action_id` the recorder wrote when it took the
    // reading), which step it documents, and which step it is the input to. A reading with no
    // producing action is the run's entry reading, and saying so is the difference between
    // "unlabelled" and "nothing came before it".
    const linkage = (() => {
      const producedBy = transitionByObservation.get(observation.id);
      const precedes = precedesByObservation.get(observation.id);
      const actionId = observation.action_id ?? producedBy?.transition ?? null;
      const role = producedBy
        ? 'after_action'
        : precedes
          ? 'before_action'
          : (index === 0 ? 'entry' : 'unlinked');
      if (role === 'unlinked' && !observation.action_id) return null;
      return {
        observation_role: role,
        action_id: observation.action_id ?? null,
        action: observation.tool ? { tool: observation.tool, arguments: observation.tool_arguments ?? null } : null,
        documents: producedBy ? producedBy.transition : null,
        precedes: precedes ? precedes.precedes : [],
        ...(role === 'entry' ? { note: 'the first reading of the run: it is the surface the first action was taken on, and no action produced it.' } : {}),
        ...(role === 'before_action'
          ? {
            note: `this reading was the surface ${precedes.precedes.join(', ')} started from, so it documents that step's source rather than the step.`
              + (index === 0 ? ' It is also the first reading of the run, and no action produced it.' : ''),
          }
          : {}),
        ...(actionId && !producedBy && !precedes ? { action_id: actionId } : {}),
      };
    })();
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
          ...(linkage ? { linkage } : {}),
          ...(externalArtifact ? { artifact_outside_run: externalArtifact } : {}),
          ...(capturedKeyCount ? { keys_captured: capturedKeys } : {}),
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
  if (journeys.length && journeysWithGoal.length === journeys.length) {
    graphWarnings.push(
      `journeys: ${journeys.length} walk(s) were reassembled from the order the steps were taken, and the run's own instruction is carried as their goal — quoted from run.json, not paraphrased, because nothing in a browser session says what a user was trying to achieve. Each \`criticality\` is the schema default, so a test generator still has to judge the priority.`,
    );
  }
  if (journeys.length && !journeysWithGoal.length) {
    graphWarnings.push(
      `journeys: ${journeys.length} walk(s) were reassembled from the order the steps were taken, and none of them carries a stated goal — the run's instruction is in \`metadata.extra.run_instruction\` ${run.instruction ? 'but describes the run rather than any one of its strands' : 'and the run recorded none'}. Each \`name\` is derived from the endpoints of its walk and each \`criticality\` is the schema default, so a test generator must supply the goal before these become tests.`,
    );
  }
  if (journeysWithGoal.length && journeysWithGoal.length !== journeys.length) {
    graphWarnings.push(
      `journeys: ${journeysWithGoal.length} of ${journeys.length} walk(s) carry the run's instruction as their goal; the others do not, because a goal can only be attributed to a journey when the run walked one strand. The instruction is on all of them in \`metadata.extra.run_instruction\`.`,
    );
  }
  for (const collision of apiIdCollisions) {
    graphWarnings.push(
      `apis: ${collision.first} and ${collision.second} both read as the id ${collision.id}, so the second was committed as ${collision.minted}. A digest may have shown the unsuffixed id for either of them, and a transition naming ${collision.id} now means ${collision.first}.`,
    );
  }

  // --- apis: one entity per endpoint the readings saw a call to -------------
  // The obligation here is the opposite of the rest of the graph's. A state or a capability has to
  // be careful not to claim more than the evidence carries; an api entity is only ever what a page
  // hook recorded, so the care is in not *losing* what was recorded — which statuses were seen, by
  // which readings, and what nothing recorded at all. `api.schema.json` requires an id, a method
  // and a path and nothing else; the rest is what the run can honestly say.
  const apiRecords = [...apis.values()].map((entity) => ({
    id: entity.id,
    method: entity.method,
    path: entity.path,
    ...(entity.statuses.length
      // One status is one status; a set of them is what the schema's array form is for. Sorted, so
      // a 401-then-200 login reads as `[200, 401]` from the first build of the graph onward.
      ? { response: { status: entity.statuses.length === 1 ? entity.statuses[0] : [...entity.statuses].sort((left, right) => left - right) } }
      : {}),
    ...(entity.observations.length
      ? { evidence: entity.observations.map((observation) => ({ observation, role: 'api' })) }
      : {}),
    metadata: commitMetadata({
      status: 'verified',
      producer: 'playwright',
      createdAt: run.started_at ?? undefined,
      extra: {
        observed: {
          requests: entity.requests,
          urls: entity.urls,
          statuses: entity.statuses,
          ...(entity.durations.length
            ? { duration_ms: { min: Math.min(...entity.durations), max: Math.max(...entity.durations) } }
            : {}),
          ...(entity.failures ? { failed: entity.failures } : {}),
          ...(entity.failure_reasons.length ? { failure_reasons: entity.failure_reasons } : {}),
          readings: entity.observations.length,
        },
        // The path is the URL the call actually went to, and it is deliberately not turned into a
        // route template: an observed URL says what this run called, not what the endpoint accepts.
        // A `/api/projects/1234` is evidence for `/api/projects/1234`, and calling it
        // `/api/projects/{id}` would be a guess dressed as a fact — the same line the graph draws
        // for state identity, held here too.
        path_is_observed: true,
        request_body: 'not recorded: the page hooks capture method, url, status and duration (page-hooks.js), and no request or response body is in the evidence, so nothing here says what this endpoint takes or returns.',
        evidence_chain: 'observation.capture.network → observation.schema.json#/$defs/networkEntry.api → this entity',
      },
    }),
  }));
  if (apiRecords.length) {
    graphWarnings.push(
      `apis: ${apiRecords.length} endpoint(s) were observed in the network log and are committed as api entities, with the statuses the readings saw. The evidence carries no request or response bodies, so nothing here describes what a call takes or returns, and no endpoint appears that the page did not call — a generator needs more than this graph to exercise one.`,
    );
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
      + `${sightings.length} repeat reading(s) collapsed; `
      + `${journeys.length} walk(s) reassembled from ${assembled.steps} step(s), with ${assembled.unusableSteps.length} step(s) that could not be walked through.`,
  };

  // --- features: the vocabulary the model brought, joined to the evidence ---
  //
  // `feature.schema.json` is the layer between code and user behaviour, and it had no source at
  // all: `features` was hardcoded empty, `feature_closure` could only ever say "nothing is
  // covered", and gap 6 in the README has been open since the first commit because of it. The
  // missing half is not information — it is *provenance*. Nothing in a browser session says what
  // product area a screen belongs to; that is a word a person brings, exactly like a capability
  // name or a journey's goal. So the model supplies the word (`feature` on the step that belongs
  // to it) and the machinery supplies the membership, from the edges that claimed it: which
  // capabilities those steps perform, which states they join, which walk contains them, which
  // endpoints they called. That split is the whole design of this module, applied to the one
  // entity left without it.
  //
  // Nothing is invented here. A feature exists only when a step claimed it, its `name` is the
  // model's spelling rather than a tidied one, and a feature with no transition under it cannot
  // exist at all — minting one from a name alone would put an entity in the graph that no
  // evidence touches, which is the failure mode every rule in this file is aimed at.
  const featureOfTransition = new Map();
  for (const record of transitions) {
    const transitionId = record.transition_id ?? record.id;
    const claimed = typeof record.feature === 'string' ? record.feature.trim() : '';
    if (transitionId && claimed) featureOfTransition.set(transitionId, claimed);
  }
  // Grouped case-insensitively, because "Authentication" and "authentication" are one feature that
  // was spelled twice, not two features — and the first spelling in walk order is the name, with
  // every spelling kept in `metadata.extra.spellings_seen`. Nothing is merged that differs by more
  // than case: a second spelling that is a different word is a second feature, and saying so is the
  // model's job.
  const featuresByName = new Map();
  for (const edge of committedEdges) {
    const claimed = featureOfTransition.get(edge.id);
    if (!claimed) continue;
    const key = claimed.toLowerCase();
    const entry = featuresByName.get(key) ?? { name: claimed, spellings: [], edges: [] };
    if (!entry.spellings.includes(claimed)) entry.spellings.push(claimed);
    if (!entry.edges.includes(edge.id)) entry.edges.push(edge.id);
    featuresByName.set(key, entry);
  }
  const featureIdUsed = new Set();
  const featureRecords = [];
  const unassigned = { capabilities: [], states: [], transitions: [], journeys: [] };
  for (const entry of featuresByName.values()) {
    const subjects = entry.edges.map((edgeId) => committedEdges.find((edge) => edge.id === edgeId)).filter(Boolean);
    // The id is a slug of the model's word, so the schema's `feature_` prefix holds whatever the
    // name looks like — and a name with nothing alphanumeric in it cannot produce one, which is a
    // refusal rather than a fabrication.
    const stem = /[a-z0-9]/i.test(entry.name) ? slugify(entry.name) : '';
    if (!stem) {
      graphWarnings.push(
        `features: the step(s) ${entry.edges.join(', ')} claimed the feature ${JSON.stringify(entry.name)}, which has no letters or digits in it and so cannot become a feature id (the schema requires feature_<name>). The claim was not committed: name the product area in words, e.g. "authentication".`,
      );
      continue;
    }
    let id = 'feature_' + stem;
    let suffix = 2;
    while (featureIdUsed.has(id)) id = `feature_${stem}_${suffix++}`;
    featureIdUsed.add(id);

    const capabilityIds = distinct(subjects.map((edge) => edge.action?.capability).filter(Boolean));
    // A composite that contains one of this feature's capabilities is part of the feature too:
    // `login` is built from `fill_login_email` and `fill_login_password`, and a feature that named
    // only the two steps would hide the behaviour a generator expands when it tests the feature.
    // Whole composites only — the relation is declared, and this reads it rather than guessing.
    const containing = capabilityRecords
      .filter((capability) => Array.isArray(capability.composed_of)
        && capability.composed_of.some((step) => capabilityIds.includes(step)))
      .map((capability) => capability.id);
    const stateIds = distinct(subjects.flatMap((edge) => [edge.from_state, edge.to_state]));
    const journeyIds = journeys
      .filter((journey) => journey.transitions.some((transitionId) => entry.edges.includes(transitionId)))
      .map((journey) => journey.id);
    const apiIds = distinct(subjects.flatMap((edge) => (Array.isArray(edge.apis) ? edge.apis : [])));

    featureRecords.push({
      id,
      // The model's word, as the model spelled it. `name` is what a reader sees, and tidying it
      // would put a name in the graph that nothing ever said.
      name: entry.name,
      capabilities: distinct([...capabilityIds, ...containing]),
      ...(stateIds.length ? { states: stateIds } : {}),
      transitions: entry.edges,
      ...(journeyIds.length ? { journeys: journeyIds } : {}),
      ...(apiIds.length ? { apis: apiIds } : {}),
      metadata: commitMetadata({
        // `inferred` and not `verified`: the word is a person's reading of what the application is
        // for, not something the page said, and the graph's `status` is about the evidence. The
        // *membership* below is derived and exact, which is what makes the feature usable — but the
        // name it is filed under was never observed.
        status: 'inferred',
        producer: run.model ? `llm:${run.model}` : 'llm',
        createdAt: run.started_at ?? undefined,
        extra: {
          declared: {
            name: `${entry.name} — the model's own word, claimed on the step(s) ${entry.edges.join(', ')}`,
            claimed_by: 'graph_transition `feature` argument',
          },
          // Provenance for the schema's `metadata`, because `feature.schema.json` has no `evidence`
          // property and the temptation is to put readings here. Readings attach to the states and
          // transitions; a feature attaches to those, so its evidence is one hop away and named.
          observed: {
            transitions: entry.edges.length,
            capabilities: capabilityIds.length,
            states: stateIds.length,
            journeys: journeyIds.length,
            apis: apiIds.length,
          },
          derived_from: 'the transitions whose step records claimed this name: their capabilities, the states they join, the walks that contain them, the endpoints they called',
          // Where the id came from, because the id is a slug and the name is prose: a reader has to
          // be able to see that `feature_project_management` is the singular word the model wrote.
          id_from: `slugify(${JSON.stringify(entry.name)}) → ${id}`,
          ...(entry.spellings.length > 1
            ? { spellings_seen: entry.spellings, spelling_note: `this feature was named ${entry.spellings.length} ways and they differ only by case; the first in walk order is the name` }
            : {}),
          related_features: 'not set: which features change together is the model\'s judgement and nothing in the evidence implies it',
          user_value: 'not set: why this feature exists for the user is prose nothing in a browser session supplies',
          note: `the name is the model's; the membership was derived from the evidence of ${entry.edges.length} step(s) and can be re-derived from this graph alone.`,
        },
      }),
    });
  }
  // What no step put a name to. Reported rather than attached to something: a feature invented to
  // cover an orphan is the graph making a claim, and the honest output of an exploration that named
  // one area and walked three is a graph that says so.
  const covered = {
    capabilities: new Set(featureRecords.flatMap((feature) => feature.capabilities ?? [])),
    states: new Set(featureRecords.flatMap((feature) => feature.states ?? [])),
    transitions: new Set(featureRecords.flatMap((feature) => feature.transitions ?? [])),
    journeys: new Set(featureRecords.flatMap((feature) => feature.journeys ?? [])),
  };
  unassigned.capabilities = capabilityRecords.map((capability) => capability.id).filter((id) => !covered.capabilities.has(id));
  unassigned.states = stateRecords.map((state) => state.id).filter((id) => !covered.states.has(id));
  unassigned.transitions = committedEdges.map((edge) => edge.id).filter((id) => !covered.transitions.has(id));
  unassigned.journeys = journeys.map((journey) => journey.id).filter((id) => !covered.journeys.has(id));
  if (featureRecords.length) {
    const orphans = unassigned.capabilities.length + unassigned.states.length + unassigned.transitions.length + unassigned.journeys.length;
    graphWarnings.push(
      `features: ${featureRecords.length} feature(s) were committed from the names the steps claimed, with their membership derived from those steps — the name is the model's, and nothing here was inferred from a URL or a screen.`
      + (orphans
        ? ` ${orphans} object(s) belong to no feature: ${[...unassigned.capabilities, ...unassigned.states, ...unassigned.transitions, ...unassigned.journeys].slice(0, 12).join(', ')}. Name the feature on a step of the walk that produced them, or leave them uncovered — an exploration that named one area and walked three says so here.`
        : ' Every committed object belongs to one.'),
    );
  }

  // --- actors: the declared vocabulary, plus every role the walk actually used ----
  // `application.actors[]` is declared in config because the vocabulary is a property of the
  // application rather than of one walk: a role exists because somebody can sign in as it,
  // whether or not this run ever did. But the reference runs the other way too —
  // `state.identity.variant` and `journey.actor` name an actor id, and an id that only ever
  // came from a state would otherwise be a dangling reference the moment the declaration is
  // silent. So the committed list is the union, in a fixed order: what was declared, then what
  // was used and not declared. A used-but-undeclared id is kept rather than dropped, because
  // dropping it would break every reference that already points at it, and it is reported so
  // the omission is visible instead of sealed into the graph as if it were a decision.
  const declaredActors = Array.isArray(run.application?.actors) ? run.application.actors : [];
  const usedVariants = distinct([
    ...stateRecords.map((state) => state.identity?.variant),
    ...journeys.map((journey) => journey.actor),
  ].filter((id) => typeof id === 'string' && id));
  const undeclaredActors = usedVariants.filter((id) => !declaredActors.some((actor) => actor?.id === id));
  const actorRecords = [
    ...declaredActors,
    ...undeclaredActors.map((id) => ({ id })),
  ];
  if (undeclaredActors.length) {
    graphWarnings.push(
      `actors: ${undeclaredActors.map((id) => JSON.stringify(id)).join(', ')} ${undeclaredActors.length === 1 ? 'is' : 'are'} used by a committed state or journey and declared by no \`application.actors[]\` entry. ${undeclaredActors.length === 1 ? 'It was' : 'They were'} carried into the graph so the references resolve, but a role nobody declared — with no \`description\` and no \`credentials_ref\` — is a name the walk invented rather than a role the application has. Declare it in the plugin config (\`application: { actors: [{ id: ... }] }\`) beside the ones that are already there.`,
    );
  }

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
        ...(actorRecords.length ? { actors: actorRecords } : {}),
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
    features: featureRecords,
    capabilities: capabilityRecords,
    states: stateRecords,
    transitions: committedEdges,
    apis: apiRecords,
    journeys,
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
  // What the run's readings said their surfaces OFFER and the walk did not take. Read off every
  // record rather than off `canonicalStates` alone: a sighting is a reading too, and the surface it
  // read offered exactly as much as the first one did. `state_id` is the record's own, which for a
  // sighting is the state it was deduplicated onto — which is the surface the claim is about.
  const recordedAffordances = [...canonicalStates, ...sightings]
    .flatMap((record) => (Array.isArray(record.affordances) ? record.affordances : [])
      .map((affordance) => ({ state_id: record.state_id ?? null, element: affordance?.element ?? null })))
    .filter((affordance) => typeof affordance.element === 'string');
  report.states = {
    candidates: states.length,
    committed: stateRecords.length,
    deduplicated: sightings.length,
    readings: observationsByState.size,
    // The one claim the log holds that this document has no room for. 0.1's `state.schema.json`
    // closes `state` to its declared keys and has no `affordances`, so what a surface OFFERS is
    // recorded in the log and carried by the application model, not by `graph.json` — counted and
    // graded here so its absence from the document is a stated fact rather than a silent drop, for
    // the same reason `report.capabilities.realization` is counted.
    //
    // `retired` is the clause that makes the claim falsifiable rather than decorative: an
    // affordance says nobody performed this, so a committed step that performed it refutes the
    // claim, and the walk — not the model's memory of the surface — is what settles it.
    affordances: {
      recorded: recordedAffordances.length,
      surfaces: distinct(recordedAffordances.map((affordance) => affordance.state_id).filter(Boolean)).length,
      retired: recordedAffordances.filter((affordance) => committedEdges.some((edge) => edge.from_state === affordance.state_id
        && (edge.action?.target === affordance.element
          || (edge.effects ?? []).some((effect) => ELEMENT_TARGET_EFFECTS.has(effect?.type) && effect.target === affordance.element)))).length,
    },
  };
  report.capabilities = {
    candidates: canonicalCapabilities.length,
    committed: capabilityRecords.length,
    // A composition declared after the behaviour was named is a second record about the same
    // capability, not a second capability — counted here so the two are not confused in a reader's
    // head when the raw log is inspected.
    compositions: [...compositionsByCapability.values()].reduce((total, list) => total + list.length, 0),
    composites: capabilityRecords.filter((record) => record.kind === 'composite').length,
    // The realisation is the third kind of record in `capabilities.jsonl` and is counted so a
    // reader can tell "the run never said how this behaviour is performed" from "it said, and the
    // steps are in the graph" without diffing the log against the document. `projects` is what
    // reached `capabilities[].steps[]`; `recorded` is what the log holds.
    realization: {
      recorded: realizationByKey.size,
      projected: capabilityRecords.reduce((total, record) => total + (record.steps?.length ?? 0), 0),
    },
    attempts: Object.fromEntries(attemptsByCapability),
  };
  report.transitions = {
    candidates: transitions.length,
    distinct: groups.size,
    committed: committedEdges.length,
    rejected: decisions.filter((item) => item.decision === 'rejected').length,
    superseded: decisions.filter((item) => item.decision === 'superseded').length,
  };
  // Journeys are not decided, they are read back: `walked` is the number of steps in the log that
  // are part of a journey, `unusable_steps` the number that are not (a refused edge, or an edge
  // that does not join committed states), and `breaks` the places the walk was cut.
  report.journeys = {
    assembled: journeys.length,
    walked: assembled.steps,
    unusable_steps: assembled.unusableSteps.length,
    breaks: assembled.breaks.length,
    entry_states: distinct(journeys.map((journey) => journey.start_state)),
    // A goal is stated when the run was asked to do something and the walk could be attributed
    // to that request. `instruction` is reported either way: a run whose instruction could not be
    // attributed is a hand-attribution job, and the text has to be visible to do it.
    stated_goals: journeysWithGoal.length,
    instruction: run.instruction ?? null,
    // Naming, counted rather than described: `named_by_model` is the walks the model named itself
    // (which is a better name than either the goal or the endpoints), and `name_conflicts` is where
    // one walk was named more than one way — a model that names a walk twice is telling the commit
    // something, and the commit passes that on rather than settling it in private.
    named_by_model: journeys.filter((journey) => journey.metadata?.extra?.name_source_kind === 'model').length,
    names_from_goals: journeys.filter((journey) => journey.metadata?.extra?.name_source_kind === 'goal').length,
    names_derived: journeys.filter((journey) => journey.metadata?.extra?.name_source_kind === 'endpoints').length,
    name_conflicts: assembled.nameConflicts,
  };
  // Features are the one entity the model names and the machinery populates, so the report says
  // both halves at once: what was claimed, what it became, and what no step put a name to. A model
  // reading this after a commit learns the one thing it can no longer change by hand — the walk is
  // over, so a feature nobody named has to be named in a later run.
  report.features = {
    claimed: [...featuresByName.values()].map((entry) => entry.name),
    committed: featureRecords.length,
    ids: featureRecords.map((feature) => feature.id),
    // Every object no feature covers, by kind. Not an error and not repaired: the graph is allowed
    // to say that a part of it nobody named.
    unassigned,
    note: 'A feature is claimed by the model on the step that belongs to it (graph_transition `feature`) and its membership is then derived from that step: the capability it performs, the states it joins, the walk that contains it, the endpoints it called. Nothing here is inferred from a URL or a screen — a page does not say what a product area is for. Feature ids are slugs of the name and the name is the model\'s spelling, so `metadata.extra.declared.name` is the authoritative form.',
  };
  report.observations = { records: observations.length, carried: observationRecords.length };
  // APIs are the one part of the graph the machinery found rather than the model, so the report
  // says both what was found and where it landed: an endpoint no transition references is a call
  // the walk made without the step that made it saying so, which is worth seeing.
  report.apis = {
    endpoints: apiRecords.length,
    requests: [...apis.values()].reduce((total, entity) => total + entity.requests, 0),
    by_method: [...apis.values()].reduce((counts, entity) => ({ ...counts, [entity.method]: (counts[entity.method] ?? 0) + 1 }), {}),
    statuses: distinct(apiRecords.flatMap((api) => (Array.isArray(api.response?.status) ? api.response.status : [api.response?.status]).filter((status) => status !== undefined))),
    failures: [...apis.values()].reduce((total, entity) => total + entity.failures, 0),
    referenced_by_transitions: distinct(committedEdges.flatMap((edge) => edge.apis ?? [])).length,
    unreferenced: [...apis.keys()].filter((id) => !committedEdges.some((edge) => (edge.apis ?? []).includes(id))),
    id_collisions: apiIdCollisions,
    // The one thing a reader must not read into this section: an api entity is what the run
    // happened to call, not what the application offers.
    note: 'Derived from the request log the page hooks keep (observations[].network), never from the model: an endpoint is here because a reading shows a call to it, and no endpoint is here that the run did not call. No bodies were recorded, so a generator has to supply what a call takes and returns.',
  };
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
    '`journeys[]` is derived, not decided: it is the transitions log read back in walk order and cut where a step does not start where the previous one ended, or where its edge is not a committed edge between two committed states. The walk is evidence; the name is the model\'s own word for the walk when a step claimed one (`journey_name`, recorded per step in `metadata.extra.journey_names_claimed`), the run\'s instruction verbatim from `run.json` when the run walked one strand and the name was not claimed, and the endpoints of the walk otherwise — `metadata.extra.name_from` says which, and `name_stated` says whether any of it was a person\'s words.',
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
  const journeys = graph.journeys ?? [];
  const stateIds = new Set(states.map((state) => state.id));
  const transitionById = new Map(transitions.map((transition) => [transition.id, transition]));

  // 1. uniqueness, including element ids across every state.
  const seenIds = new Map();
  const elementIds = new Map();
  const duplicates = [];
  for (const [scope, list] of [['states', states], ['transitions', transitions], ['capabilities', capabilities], ['journeys', journeys], ['features', graph.features ?? []], ['observations', graph.observations ?? []]]) {
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
  const apiIds = new Set((graph.apis ?? []).map((api) => api.id));
  for (const transition of transitions) {
    if (!stateIds.has(transition.from_state)) dangling.push(`${transition.id}.from_state → ${transition.from_state}`);
    if (!stateIds.has(transition.to_state)) dangling.push(`${transition.id}.to_state → ${transition.to_state}`);
    if (!capabilities.some((capability) => capability.id === transition.action?.capability)) {
      dangling.push(`${transition.id}.action.capability → ${transition.action?.capability}`);
    }
    // An edge that names the endpoints it calls and a state that names what its readings fetched
    // are references like the rest: a page that calls `/api/login` and a graph that says so only
    // helps if the id is one of the graph's own api entities.
    for (const api of transition.apis ?? []) {
      if (!apiIds.has(api)) dangling.push(`${transition.id}.apis → ${api}`);
    }
    for (const effect of transition.effects ?? []) {
      if (effect.type === 'request' && effect.api && !apiIds.has(effect.api)) dangling.push(`${transition.id} request.api → ${effect.api}`);
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
    for (const api of state.apis ?? []) {
      if (!apiIds.has(api)) dangling.push(`${state.id}.apis → ${api}`);
    }
  }
  for (const api of graph.apis ?? []) {
    for (const evidence of api.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.observation;
      if (id && !observationIds.has(id)) dangling.push(`${api.id}.evidence → ${id}`);
    }
  }
  for (const capability of capabilities) {
    for (const evidence of capability.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.transition;
      if (id && !transitions.some((transition) => transition.id === id)) dangling.push(`${capability.id}.evidence → ${id}`);
    }
    // A composite names the capabilities it is built from, which is a reference like any other
    // and is checked like one: §14.2 says every id that appears has to exist, and a behaviour
    // built from a behaviour the graph does not have is a generator's dead end.
    for (const step of capability.composed_of ?? []) {
      if (!capabilities.some((candidate) => candidate.id === step)) dangling.push(`${capability.id}.composed_of → ${step}`);
    }
    // A step names an element the same way a transition names its target, and is checked the same
    // way for the same reason: an element id no committed state declares is a selector nothing can
    // resolve, so a generator handed this step can only guess at the control. Absent is not
    // dangling — `goto` and `wait` act on the page rather than on a control, and both schemas make
    // `element` optional for exactly those steps.
    for (const [index, step] of (capability.steps ?? []).entries()) {
      if (step?.element && !elementIds.has(step.element)) dangling.push(`${capability.id}.steps[${index}].element → ${step.element}`);
    }
  }
  // A journey is a new set of references and gets checked like every other one: a journey naming an
  // edge the graph does not have, or starting somewhere that is not a state, is exactly the kind of
  // dangling pointer an ungenerated test is made of.
  const actors = (graph.application?.actors ?? []).map((actor) => actor?.id).filter(Boolean);
  for (const journey of journeys) {
    if (journey.start_state && !stateIds.has(journey.start_state)) dangling.push(`${journey.id}.start_state → ${journey.start_state}`);
    for (const transitionId of journey.transitions ?? []) {
      if (!transitionById.has(transitionId)) dangling.push(`${journey.id}.transitions → ${transitionId}`);
    }
    if (journey.actor && actors.length && !actors.includes(journey.actor)) dangling.push(`${journey.id}.actor → ${journey.actor}`);
    for (const evidence of journey.evidence ?? []) {
      const id = typeof evidence === 'string' ? evidence : evidence?.observation;
      if (id && !observationIds.has(id)) dangling.push(`${journey.id}.evidence → ${id}`);
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

  // The same question from the evidence's side, which §14 does not ask: §14.4 compares the
  // identities the model wrote, and this compares what the captures recorded for them (see
  // `observableOf`). A document can pass §14.4 and still have two states that nothing the page did
  // distinguishes — which is what a reader of the committed graph has no other way to notice.
  // A warning, not an error: the fingerprint is a union of what the readings showed, so it is
  // evidence about the pair and not a proof that the two identities are one.
  const indistinguishable = indistinguishableStates(states);
  const fingerprinted = states.filter((state) => state.metadata?.extra?.observable).length;
  results.push({
    code: 'state_indistinguishable_from_another',
    name: 'states told apart by their own evidence (this rule is the plugin\'s, beyond §14)',
    severity: 'warning',
    ok: indistinguishable.length === 0,
    detail: indistinguishable.length
      ? indistinguishable.map((group) => `${group.ids.join(' and ')} share ${observableSummary(group.observable)}`).join('; ')
      : `${fingerprinted} of ${states.length} state(s) carry a fingerprint from their readings, and no two of them are equal.`,
  });

  // 5. journeys. A journey is a walk: it starts where its first transition starts, and every later
  // transition starts where the previous one ended. `journey.start_state` is omitted when it is the
  // first transition's `from_state` (the schema derives it), so both spellings are checked. The one
  // thing that matches any state is the wildcard `from_state: "*"`, which nothing in this commit
  // emits but which the schema's own open questions allow a hand-written graph to use.
  const journeyProblems = [];
  for (const journey of journeys) {
    const ids = Array.isArray(journey.transitions) ? journey.transitions : [];
    if (!ids.length) {
      journeyProblems.push(`${journey.id} walks no transitions`);
      continue;
    }
    const edges = ids.map((id) => transitionById.get(id) ?? null);
    const missing = ids.filter((id, index) => edges[index] === null);
    if (missing.length) {
      // Invariant 2 says the same thing; saying it here too is what makes this rule readable on
      // its own, and a walk whose steps are not edges cannot be judged as a walk at all.
      journeyProblems.push(`${journey.id} walks ${missing.join(', ')}, which are not edges in this graph`);
      continue;
    }
    const start = journey.start_state ?? edges[0].from_state;
    if (start !== edges[0].from_state && edges[0].from_state !== '*') {
      journeyProblems.push(`${journey.id} starts at ${start} but its first step ${edges[0].id} starts at ${edges[0].from_state}`);
    }
    for (let index = 1; index < edges.length; index++) {
      const previous = edges[index - 1];
      const current = edges[index];
      if (previous.to_state === '*' || current.from_state === '*') continue;
      if (previous.to_state !== current.from_state) {
        journeyProblems.push(`${journey.id} jumps: ${previous.id} ends at ${previous.to_state} and ${current.id} starts at ${current.from_state}`);
      }
    }
  }
  const walkedSteps = journeys.reduce((total, journey) => total + (journey.transitions ?? []).length, 0);
  results.push({
    code: 'journey_is_a_walk',
    name: '§14.5 journey is a walk',
    severity: journeys.length ? 'error' : 'info',
    ok: journeyProblems.length === 0,
    detail: journeyProblems.length
      ? journeyProblems.slice(0, 12).join('; ')
      : journeys.length
        ? `${journeys.length} journey(s) walk ${walkedSteps} step(s), and every step starts where the one before it ended.`
        : 'no journeys are committed, so there is no walk to check.',
  });

  // 6. reachability. A journey's start is an entry state — that is what §14.6 needs and all it
  // needs, since the walk is where the graph says it began. It stays a warning: a state that no
  // committed walk reaches is a fact about the run (an edge was refused, or a state was read
  // without being walked to), not a contradiction in the document.
  const entryStates = distinct(journeys.map((journey) => {
    const first = transitionById.get((journey.transitions ?? [])[0]);
    return journey.start_state ?? first?.from_state ?? null;
  })).filter((id) => stateIds.has(id));
  const reachable = new Set();
  const queue = [...entryStates];
  for (const id of queue) reachable.add(id);
  while (queue.length) {
    const current = queue.shift();
    for (const transition of transitions) {
      if (transition.from_state !== current && transition.from_state !== '*') continue;
      if (reachable.has(transition.to_state)) continue;
      reachable.add(transition.to_state);
      queue.push(transition.to_state);
    }
  }
  const unreachableStates = states.filter((state) => !reachable.has(state.id)).map((state) => state.id);
  // The end of a walk is a state the graph genuinely has nothing more to say about — the sample
  // stopped there, which is not the same as the application being finished — so it is reported as
  // what it is and does not count against the graph. A state with no outgoing edge that no walk
  // ended at is the one worth looking at.
  const walkEnds = distinct(journeys.map((journey) => transitionById.get((journey.transitions ?? [])[(journey.transitions ?? []).length - 1])?.to_state));
  const stranded = states
    .filter((state) => !transitions.some((transition) => transition.from_state === state.id) && !walkEnds.includes(state.id))
    .map((state) => state.id);
  results.push({
    code: 'reachability',
    name: '§14.6 reachability',
    // With no walk assembled and no states either there is nothing to ask reachability of, which is
    // the one vacuous case. States and no walk is not vacuous: every one of those states is
    // unreachable from an entry state, because the graph has not got one.
    severity: states.length ? 'warning' : 'info',
    ok: unreachableStates.length === 0 && stranded.length === 0,
    detail: entryStates.length
      ? [
        `entry state(s), from where the walks began: ${entryStates.join(', ')}`,
        unreachableStates.length ? `not reachable from one of them: ${unreachableStates.join(', ')}` : null,
        stranded.length ? `no outgoing transition and no walk ends there: ${stranded.join(', ')}` : null,
        walkEnds.length ? `a walk stops at ${walkEnds.join(', ')}, which is where a sample ends rather than where the application does` : null,
      ].filter(Boolean).join('; ')
      : states.length
        ? `no walk was assembled, so this graph declares no entry state and none of its ${states.length} state(s) is reachable from one: ${unreachableStates.join(', ')}`
        : 'no walk was assembled and there are no states, so there is nothing to ask reachability of.',
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
  //
  // Features used to have no source in browser evidence, and that is still true of the *name*: a
  // page never says what product area it belongs to. What changed is that the name now has a place
  // to come from — the step that claims it — so this check has something to count instead of a
  // constant. It stays a `should`: an exploration that named one area and walked three is a real
  // and useful graph, and refusing it would make the naming rule into a gate.
  const features = graph.features ?? [];
  const uncovered = {
    capabilities: capabilities.map((capability) => capability.id).filter((id) => !features.some((feature) => (feature.capabilities ?? []).includes(id))),
    states: states.map((state) => state.id).filter((id) => !features.some((feature) => (feature.states ?? []).includes(id))),
    transitions: transitions.map((transition) => transition.id).filter((id) => !features.some((feature) => (feature.transitions ?? []).includes(id))),
  };
  const uncoveredCount = uncovered.capabilities.length + uncovered.states.length + uncovered.transitions.length;
  const totalCount = capabilities.length + states.length + transitions.length;
  results.push({
    code: 'feature_closure',
    name: '§14.10 feature closure (should, not must)',
    severity: 'warning',
    ok: uncoveredCount === 0,
    detail: !features.length
      ? `no features are committed, so all ${totalCount} objects (${capabilities.length} capabilities, ${states.length} states, ${transitions.length} transitions) are uncovered: no step of this run claimed a product feature. A feature can only come from the model — nothing in a page says what a product area is for — and it is claimed on the step that belongs to it (\`feature\` on graph_transition), which is what gives the machinery the membership to derive.`
      : uncoveredCount
        ? `${uncoveredCount} of ${totalCount} object(s) belong to no feature — ${Object.entries(uncovered).filter(([, ids]) => ids.length).map(([kind, ids]) => `${kind}: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` (+${ids.length - 8} more)` : ''}`).join('; ')}. Membership is derived from the transitions that claimed each name, so an object is uncovered when no step on or around it claimed one. Name the feature on a step of the walk that produced it, or leave it — this is a warning, and an honest graph that says which parts nobody named is worth more than one that invents a feature to close the check.`
        : `every one of ${totalCount} object(s) is covered by one of ${features.length} feature(s).`,
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
