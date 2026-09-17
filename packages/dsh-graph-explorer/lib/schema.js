/**
 * Facts copied from the normative schema.
 *
 * `~/IntegrationTestGenerator/graph-schema.md` and `schemas/*.schema.json` are the
 * authority; this module is the subset of it the plugin has to enforce *while the
 * model is still exploring*, because a violation caught here costs one correction
 * and a violation caught at commit time costs the whole run.
 *
 * The rule for anything in here is that the schema states it as a closed
 * vocabulary or a required field, so the check is mechanical. Everything the schema
 * leaves to judgement (is this the same capability? is this really a different
 * state?) is NOT enforced here — it is reported back to the model, which is the
 * layer that can judge it.
 */

/**
 * Assertion kinds the schema permits in `state.detection`.
 * From `common.schema.json#/$defs/assertion.properties.type`.
 */
export const DETECTION_TYPES = new Set([
  'state',
  'url',
  'element_state',
  'element_value',
  'value',
  'api',
  'effect',
  'message',
  'absence',
  'custom',
]);

/**
 * Effect kinds, and what each one must carry to be a legal `transition.effects[]`
 * entry. From `transition.schema.json#/$defs/effect` — the `allOf` block is exactly
 * this table expressed as JSON Schema conditionals.
 *
 * `value_changed` and `visibility_changed` require a value as well as a target,
 * because "something about this changed" with no direction is not testable.
 */
export const EFFECT_REQUIRED = new Map([
  ['value_changed', ['target', 'to']],
  ['visibility_changed', ['target', 'to']],
  ['navigation', ['to']],
  ['url_changed', ['to']],
  ['state_entered', ['to']],
  ['message', ['message']],
  ['request', ['api']],
  ['storage_changed', ['target']],
  ['validation_error', ['target']],
  ['element_created', ['target']],
  ['element_destroyed', ['target']],
  ['list_changed', ['target']],
  ['custom', []],
]);

export const EFFECT_TYPES = new Set(EFFECT_REQUIRED.keys());

export const SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

export const LIST_OPERATIONS = new Set(['add', 'remove', 'reorder', 'reset']);

export const CAPABILITY_KINDS = new Set(['interaction', 'navigation', 'query', 'setup', 'composite']);

/**
 * `application.id` is a prefixed id: `app_` or `app-` followed by the shared id
 * alphabet. From `common.schema.json#/$defs/appId`, which narrows the generic `id`
 * definition with exactly this pattern.
 */
export const APPLICATION_ID_PATTERN = /^app[-_][A-Za-z0-9._:-]+$/;

/**
 * The only keys accepted in a configured `application`.
 *
 * `application.schema.json` declares `additionalProperties: false`, so a key it does
 * not list makes the object invalid rather than merely odd. An unrecognized key that
 * is silently dropped is the same class of falsehood as a guessed default: `baseUrl`
 * for `base_url` would leave the graph claiming an application with no base URL, and
 * nothing in the output would say the value had been discarded. Refused, not carried.
 */
const APPLICATION_KEYS = new Set(['id', 'name']);

/**
 * The application this run is declared to be about, or `null` when none was declared.
 *
 * This is the one field of the graph the machinery cannot observe. `run.json` records
 * the start URL and the instruction, and neither of those names an application: a host
 * is where an app is *served*, not what it *is*. That is why `application.schema.json`
 * carries `id` beside `base_url`, and adds an `environments` map for the same graph
 * reused across hosts — the identity has to outlive the address. So it is declared in
 * config, and this checks only that the declaration is usable.
 *
 * `null` is a real answer and is kept distinct from a bad one. An undeclared
 * application is a run whose graph cannot be committed yet, and that refusal names the
 * setting to supply, so it is recoverable. An id derived from the start URL is not:
 * it would be written into the graph where nothing downstream could tell it apart from
 * a declared one, and walking the same app on staging would silently become a second
 * application.
 *
 * The rules enforced here live beside the schema rather than with the config because
 * both are the normative schema's (the `app` prefix, `additionalProperties: false`),
 * and because the value reaches `run.json`, which can be written by a caller with no
 * config schema in front of it.
 */
export function normalizeApplication(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'application must be a mapping of id and name, e.g. { id: "app_acme", name: "Acme" }; got '
      + JSON.stringify(value) + '.',
    );
  }
  const unknown = Object.keys(value).filter((key) => !APPLICATION_KEYS.has(key));
  if (unknown.length) {
    throw new Error(
      'application has no key ' + JSON.stringify(unknown[0]) + '. The schema lists exactly id and name '
      + '(application.schema.json sets additionalProperties: false), so an unrecognized key is a typo — and '
      + 'carrying it would put an undeclared field into run.json.',
    );
  }
  const { id, name } = value;
  if (typeof id !== 'string' || !APPLICATION_ID_PATTERN.test(id)) {
    throw new Error(
      'application.id ' + JSON.stringify(id ?? null) + ' is not a usable application id: it must be prefixed, '
      + 'like app_acme or app-acme. It is the graph\'s stable name for this application across hosts, so it '
      + 'cannot be derived from the start URL.',
    );
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(
      'application.name must be a non-empty string: it is the human-readable name the graph shows for '
      + JSON.stringify(id) + '.',
    );
  }
  return { id, name };
}

/**
 * `capability.name` is a stable snake_case verb phrase — `common`-style pattern from
 * `capability.schema.json`. Enforced because an invalid name produces a graph that
 * cannot be committed, and the model can always rename.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `element.semantic.purpose` — the element's stable identity, and therefore the one
 * name in the graph a reference can be resolved against. From `element.schema.json`,
 * which gives it the same alphabet as a capability name.
 */
export const ELEMENT_PURPOSE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The purpose a claim names, under either of the two forms a model writes it in.
 *
 * A bare string (`"email_input"`) and an object (`{semantic_purpose: "email_input"}`) mean the
 * same thing, and both are real: the tool's own refusal message for a state with no detection
 * invites the object form, while `normalizeAssertion` resolved only the string — so an entry
 * the model was *told* to write was dropped at commit with nothing to say it had been. One
 * resolver, used by every reader of a claim, is the fix for that class of thing.
 *
 * Returns `null` when the value names nothing, which is a different answer from a name that
 * does not resolve: only the caller knows which one it is holding, and what to say about it.
 */
export function purposeOf(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.semantic_purpose === 'string' && value.semantic_purpose) {
    return value.semantic_purpose;
  }
  return null;
}

/**
 * `state.identity.page_type` — the coarse semantic page kind, same alphabet again.
 * From `state.schema.json`. Enforced at commit because the page type is required, so a
 * page type the pattern rejects makes the whole state invalid rather than merely odd.
 */
export const PAGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The keys a committed `transition.effects[]` entry may carry.
 *
 * `transition.schema.json#/$defs/effect` sets `additionalProperties: false` and lists
 * exactly these. The model's effect shorthand is closed by `EFFECT_REQUIRED` while the
 * run is live, but a graph is a document: an unrecognized key that survived would make
 * the whole document invalid, and the run it came from is already over. The keys are
 * filtered at commit time for that reason.
 */
export const EFFECT_KEYS = new Set([
  'id',
  'type',
  'target',
  'from',
  'to',
  'value',
  'message',
  'severity',
  'api',
  'state',
  'element',
  'operation',
  'observed',
  'description',
  'evidence',
]);

/**
 * `assertion.severity` — a *third* severity enum, and not the one effects use.
 *
 * Effects are graded `info|success|warning|error` (how strongly the effect is claimed);
 * assertions are graded `assert|warn|info` (what a generated test should do when the check
 * fails). From `common.schema.json#/$defs/assertion`. One enum for both would silently
 * produce assertions that are invalid documents, which is exactly the class of thing this
 * file exists to prevent.
 */
export const ASSERTION_SEVERITIES = new Set(['assert', 'warn', 'info']);

/**
 * The value-spec vocabulary of a capability's `input` and `output` maps.
 *
 * From `common.schema.json#/$defs/argumentValueSpec`, which is a `oneOf` of two forms: a bare
 * primitive type name (`"number"`), or an object whose only keys are the ones below and whose
 * `type` is required. Both forms are closed, and `argumentMap` says the important part in its
 * own description — *"Values are argumentValueSpec, not JSON Schema"*.
 *
 * Enforced while the run is live because this is the one part of the graph the model writes
 * as free-form JSON and nothing downstream looks at it: `graph_commit`'s rules are identity,
 * evidence and dangling references, so it reports `ok: true` for a document an `input` of
 * `{"email":{"type":"string","sensitive":true}}` makes INVALID. A shape error there costs the
 * whole run, and the model can always fix the spec on the call that wrote it.
 */
export const ARGUMENT_VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'any']);

const ARGUMENT_SPEC_KEYS = new Set([
  'type', 'description', 'required', 'format', 'enum', 'minimum', 'maximum', 'pattern', 'default', 'example',
]);

/**
 * Why one entry of a capability's `input`/`output` map is not a usable value spec, or `null`
 * when it is. `label` names the argument the model passed, so the message can quote the path
 * it actually wrote (`capability_input.email`).
 */
export function argumentSpecProblem(label, spec) {
  if (typeof spec === 'string') {
    if (ARGUMENT_VALUE_TYPES.has(spec)) return null;
    return `${label} is ${JSON.stringify(spec)}, which is not a type name. A value spec is either a primitive `
      + `type name (${[...ARGUMENT_VALUE_TYPES].join(', ')}) or an object with a \`type\`. If ${JSON.stringify(spec)} `
      + 'is a value you actually used, it belongs in `arguments` — this parameter describes the capability\'s '
      + 'parameters, not the values of this one call.';
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return `${label} is ${JSON.stringify(spec ?? null)}, which is not a value spec. Use a type name `
      + `(${[...ARGUMENT_VALUE_TYPES].join(', ')}) or {"type":"string","required":true}.`;
  }
  const unknown = Object.keys(spec).filter((key) => !ARGUMENT_SPEC_KEYS.has(key));
  if (unknown.length) {
    return `${label} carries ${JSON.stringify(unknown[0])}, which is not a key a value spec can have. The schema `
      + `lists exactly ${[...ARGUMENT_SPEC_KEYS].join(', ')} (additionalProperties: false), so the committed graph `
      + 'would be an invalid document — and nothing between this call and the document would have said so. Keep '
      + 'the keys the schema has; say the rest in `description`.';
  }
  if (!ARGUMENT_VALUE_TYPES.has(spec.type)) {
    return `${label} has type ${JSON.stringify(spec.type ?? null)}, which is not one of: `
      + `${[...ARGUMENT_VALUE_TYPES].join(', ')}. The schema's value specs are stricter than a JSON Schema type `
      + 'and `any` is the escape hatch.';
  }
  return null;
}

/**
 * The same question for a whole `input`/`output` map: the first entry that would make the
 * graph invalid, or `null`. One entry at a time is enough — the message names the path, and a
 * second bad entry is found on the corrected call.
 */
export function argumentMapProblem(label, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `${label} is ${JSON.stringify(value)}, which is not a map of argument names to value specs. Use `
      + '{"email":{"type":"string","required":true}} — an empty object is fine when there is nothing to say.';
  }
  for (const [name, spec] of Object.entries(value)) {
    const problem = argumentSpecProblem(`${label}.${name}`, spec);
    if (problem) return problem;
  }
  return null;
}

/**
 * What the machinery's own notes mean for the commit.
 *
 * The notes are written while the run is live — `crossCheckEffects` on a transition, and
 * `graph_observe` on the claims a reading was given — where the cost of a false positive is a
 * sentence of the model's attention. At commit time the same note is a verdict, so the severity
 * has to be decided once, here, beside the note kinds themselves.
 *
 * Only `self_loop_but_controls_changed` is an error, because it is the only note that says
 * the record's *identity* is wrong rather than its *detail*: the step claims to start and end
 * in one state while the two readings share no interactive surface, and a state that does not
 * hold for both endpoints cannot be committed as either. Every other note is a disagreement
 * about something inside an edge whose endpoints the evidence still supports — a real edge
 * with an overstated effect, which is worse to lose than to carry with a warning.
 */
export const NOTE_SEVERITY = new Map([
  ['self_loop_but_controls_changed', 'error'],
  ['claimed_navigation_not_observed', 'warning'],
  ['claimed_message_not_seen', 'warning'],
  ['claimed_request_not_observed', 'warning'],
  ['unclaimed_url_change', 'warning'],
  ['no_observed_change', 'warning'],
  ['previous_step_not_read', 'warning'],
  // A detection whose value the capture contradicts, noted by `graph_observe`. The commit
  // reaches the same conclusion about the same entry under the same code — `info`, carried as
  // written — and the two are the same claim, so they are the same severity. Deciding it here
  // and not by the fallback below is the point of the map: the fallback exists for kinds a
  // newer recorder writes and this version has never heard of.
  ['detection_value_not_in_evidence', 'info'],
  // A state identity minted out of element state — a form's progress read as a state of the
  // application. A warning rather than an error because the endpoints the edge names are still
  // the readings they were: what is doubtful is the extra identity, and refusing the edge would
  // throw away a real step to punish a state that is merely unnecessary. (`self_loop_but_
  // controls_changed` is the error in this family, and for the opposite reason: there the
  // identity the edge *names* does not hold for both of its endpoints.)
  ['identity_read_from_element_state', 'warning'],
  // Two readings bound to one state whose controls have nothing in common, reported by the commit
  // and refused at the reading that would have made it worse. A warning for the same reason the
  // note above is one: the state is a real state and the edges through it are real edges — what is
  // doubtful is which screen one of its readings was of, and only the model can say.
  ['state_readings_share_no_surface', 'warning'],
]);

/**
 * A note kind this version does not know is a `warning`, never an `error`.
 *
 * The note vocabulary is the recorder's, and the recorder is the same plugin: an older
 * `graph_commit` naming a note a newer `graph_transition` writes must not turn a logging
 * change into a refused edge. Erring towards committing is the safe direction precisely
 * because nothing is lost — the note itself is carried into the report.
 */
export const UNKNOWN_NOTE_SEVERITY = 'warning';

/**
 * The commit decision as a `metadata.status` value.
 *
 * Every object the commit touches gets a decision, and the decision has to be expressible in
 * the schema's own vocabulary rather than in a new field — `additionalProperties: false` leaves
 * no room for a `commit_status`. Only `committed` and `inferred` reach the graph; `rejected` and
 * `superseded` are report-only, and read as `draft` and `deprecated` there.
 */
export const TRANSITION_DECISIONS = new Map([
  ['committed', 'verified'],
  ['inferred', 'inferred'],
  ['rejected', 'draft'],
  ['superseded', 'deprecated'],
]);

/**
 * The roles an `evidenceRef` may name (`common.schema.json#/$defs/evidenceRef`).
 *
 * A ref outside the enum is not dropped — the observation it names is still the evidence — but
 * its role becomes `unknown`, which is the enum's own word for "the machinery knows it was
 * evidence and cannot say of what".
 */
export const EVIDENCE_ROLES = new Set([
  'identity', 'element', 'action', 'effect', 'api', 'detection', 'counterexample', 'unknown',
]);

/**
 * The vocabulary §7 says to converge on. Not a whitelist: an app is free to have
 * capabilities these names do not describe. It is the reference a near-duplicate is
 * compared against, so the model converges on one name per behaviour instead of
 * accumulating `add_to_cart`, `add_item_to_cart` and `add_product_to_cart` as three
 * capabilities of one behaviour.
 */
export const CAPABILITY_VOCABULARY = [
  'login',
  'logout',
  'search_product',
  'add_product_to_cart',
  'remove_product_from_cart',
  'apply_coupon',
  'submit_order',
  'change_shipping_address',
];

/**
 * Synonyms the word-overlap rule cannot see, because they share no tokens with the
 * name they mean (`place_order` -> `submit_order`, `search` -> `search_product`).
 *
 * Curated and deliberately short: this table is a hint to the model, never a
 * rewrite, so a wrong entry costs one confusing note, and a missing entry costs
 * nothing.
 */
export const CAPABILITY_SYNONYMS = new Map([
  ['signin', 'login'],
  ['sign_in', 'login'],
  ['signout', 'logout'],
  ['sign_out', 'logout'],
  ['add_to_cart', 'add_product_to_cart'],
  ['add_item_to_cart', 'add_product_to_cart'],
  ['remove_from_cart', 'remove_product_from_cart'],
  ['remove_item', 'remove_product_from_cart'],
  ['search', 'search_product'],
  ['search_for_product', 'search_product'],
  ['checkout', 'submit_order'],
  ['place_order', 'submit_order'],
  ['purchase', 'submit_order'],
  ['submit_checkout', 'submit_order'],
  ['change_address', 'change_shipping_address'],
  ['set_shipping_address', 'change_shipping_address'],
]);

const tokens = (name) => new Set(String(name).split('_').filter(Boolean));

/**
 * Names the model may be reaching for, when the name it just used is not the name
 * the schema's vocabulary would give the same behaviour.
 *
 * This only reports. It never renames anything: a name is what the app's author
 * called the behaviour, and silently rewriting the model's word for it would put a
 * name in the graph that no observation supports. The model is told, and decides.
 *
 * Three signals, in descending confidence:
 *   `known_synonym`    — the curated table maps this name onto a vocabulary entry.
 *   `same_words`       — identical words in a different order (`cart_add`/`add_cart`).
 *   `overlapping_words`— one name's words are contained in the other's
 *                        (`add_to_cart` inside `add_product_to_cart`). Weakest by
 *                        design: `login` vs `login_as_admin` trips it too, which is
 *                        why it asks rather than concludes.
 */
export function vocabularyNotes(name, knownNames) {
  const notes = [];
  const mine = tokens(name);

  const canonical = CAPABILITY_SYNONYMS.get(name);
  if (canonical) {
    notes.push({
      signal: 'known_synonym',
      you_said: name,
      vocabulary_name: canonical,
      detail: `The schema's vocabulary (§7) calls this behaviour "${canonical}". If it is the same behaviour, use that name so the graph does not carry two names for one thing.`,
    });
  }

  for (const other of new Set([...knownNames, ...CAPABILITY_VOCABULARY])) {
    if (!other || other === name) continue;
    const theirs = tokens(other);
    const contained = [...mine].every((token) => theirs.has(token));
    const contains = [...theirs].every((token) => mine.has(token));
    if (contained && contains) {
      notes.push({
        signal: 'same_words',
        you_said: name,
        vocabulary_name: other,
        detail: `"${other}" already exists and uses exactly the same words. Treat them as one capability unless they are genuinely different.`,
      });
    } else if (contained || contains) {
      notes.push({
        signal: 'overlapping_words',
        you_said: name,
        vocabulary_name: other,
        relation: contained ? 'narrower_than' : 'broader_than',
        detail: `"${name}" ${contained ? 'uses a subset of the words in' : 'contains the words of'} "${other}" (which already exists). They may be one behaviour described two ways. Reuse "${other}" if they are.`,
      });
    }
  }

  // The same pair can be reached through two signals; keep the first (strongest).
  const seen = new Set();
  return notes.filter((note) => {
    if (seen.has(note.vocabulary_name)) return false;
    seen.add(note.vocabulary_name);
    return true;
  }).slice(0, 5);
}
