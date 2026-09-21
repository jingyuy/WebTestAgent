/**
 * The mask, and the one moment it can be applied.
 *
 * `capture.js` writes `[set]` where a password field's value would go, for one reason: "the graph is
 * a durable artefact and a credential in it outlives the run". That mask covers the *page's* copy of
 * the value — the element's state, the effect a reading reports — and nothing else. The call that
 * put the value there is a separate record with its own copy of it, and the run's own instruction is
 * a third. Both are durable, both outlive the run, and both were left untouched: the 0.1.36 live run
 * carried a real password at eight paths across `observations.jsonl`, `run.json`,
 * `commit_report.json`, `graph.json` and `application-model.json`, while the behaviour's realization
 * said `[set]` and every projection of it did too.
 *
 * So the mask has to be applied where the value *enters* the record rather than where it is later
 * projected, and this module is that place. It is one module rather than a rule restated in the
 * recorder, the projection and the generator because the three would agree until the day they did
 * not, and the disagreement would be a credential.
 *
 * The test the recorder applies is not "does this look like a secret" — a password is a string like
 * any other, and a rule that read the *value* would be a rule that guesses. It is narrower and
 * checkable: **the page withheld this field's value, and this call is the one that gave it one.**
 * The reading says which fields withheld theirs (`value === [set]`); the call says which field it
 * targeted (`selector`); where they name the same control, the argument that carried the value is
 * recorded as the mask instead.
 */

/**
 * What a value the page withheld is written as, everywhere.
 *
 * `capture.js` writes the same three characters as a literal inside the page-evaluated expression
 * (that file is a template literal with a deliberate no-interpolation rule, so the constant cannot be
 * spliced in), and `generate.js` re-exports the same string as `REDACTED`. `test/redaction.test.mjs`
 * asserts the three agree, because three spellings of one mask that are allowed to drift are three
 * masks.
 */
export const REDACTION = '[set]';

/**
 * The calls that carry a value *into* a control, and the argument they carry it in.
 *
 * One entry. `browser_select_option` and `browser_upload` also supply values and are not listed,
 * because nothing in this repository says which argument name they use, and a rule that guessed
 * would read the wrong field and then call the result a credential — or, worse, call a credential
 * something else. This is the same discipline as `index.js#requestedUrl`, which reads
 * `browser_open`'s `url` by name for the same reason.
 */
export const SUPPLIED_ARGUMENT = new Map([['browser_type', 'text']]);

/** The mask's own evidence: the controls this reading says withheld their value. */
export const withheldTargets = (capture) => new Set(
  (Array.isArray(capture?.interactive) ? capture.interactive : [])
    .filter((element) => element?.value === REDACTION)
    .map((element) => element?.selector)
    .filter((selector) => typeof selector === 'string' && selector),
);

/**
 * What a call was given, with the values the page withholds taken back out.
 *
 * Returns `{ arguments, withheld, value }`. `arguments` is what may be written; `value` is the
 * literal the page was given, handed back **in memory only** for the one job that needs it — taking
 * it back out of a record that already holds it (`session.js#withholdValue`). Nothing in this module
 * writes anything, and a caller that puts `value` on a record has undone the redaction it just
 * asked for.
 *
 * `withheld` is false in every case where the question cannot be answered: no such field in the
 * reading, no selector on the call, a value that is already the mask, or an empty value. A run that
 * cannot see the field is a run that cannot redact it, and the honest report of that is the argument
 * as it was given rather than a guess.
 */
export const redactCallArguments = (tool, toolArgs, capture) => {
  const key = SUPPLIED_ARGUMENT.get(tool);
  if (!key || !toolArgs || typeof toolArgs !== 'object') return { arguments: toolArgs, withheld: false, value: null };
  const selector = typeof toolArgs.selector === 'string' ? toolArgs.selector : null;
  const value = toolArgs[key];
  if (!selector || typeof value !== 'string' || !value || value === REDACTION) {
    return { arguments: toolArgs, withheld: false, value: null };
  }
  if (!withheldTargets(capture).has(selector)) return { arguments: toolArgs, withheld: false, value: null };
  return { arguments: { ...toolArgs, [key]: REDACTION }, withheld: true, value };
};

/**
 * A sentence with the values the run may not keep replaced by the mask.
 *
 * The run's instruction is where a credential usually enters the record: it is the task, and a task
 * that says to sign in usually says as whom. The machinery cannot tell that it *is* a credential
 * until a field that refuses to be read has received one, so the removal happens the moment that
 * happens rather than when the sentence is written — see `session.js#withholdValue` for why that is
 * the earliest possible point and what the record looks like in the window before it.
 *
 * Shorter values are skipped entirely. Four characters is the floor the projection uses when it asks
 * whether an instruction repeats a value the walk supplied, and it is the floor here for the same
 * reason: replacing a four-character string inside arbitrary prose would rewrite words rather than
 * remove a secret, and a mask that damages the record is the failure this is meant to prevent. The
 * floor only ever applies to a value the page itself declined to disclose, so it is a limit on
 * damage, not a decision about what a secret is.
 */
export const MIN_WITHHELD_CHARS = 4;

export const redactProse = (text, values) => {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.length < MIN_WITHHELD_CHARS) continue;
    result = result.split(value).join(REDACTION);
  }
  return result;
};
