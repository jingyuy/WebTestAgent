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
 * `capability.name` is a stable snake_case verb phrase — `common`-style pattern from
 * `capability.schema.json`. Enforced because an invalid name produces a graph that
 * cannot be committed, and the model can always rename.
 */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

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
