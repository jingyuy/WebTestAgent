/**
 * The mask, and the three places it is spelled.
 *
 * This suite exists because of one measured defect rather than one imagined. The 0.1.36 live run
 * carried a real password at eight paths across `observations.jsonl`, `run.json`,
 * `commit_report.json`, `graph.json` and `application-model.json`, while the behaviour's
 * realization said `[set]` and every projection of it did too — the mask was applied when a value
 * was *reported*, and never when it was *recorded*. The review that found it put the rule in bold:
 * redaction must happen before data enters the persistent evidence layer.
 *
 * So what is asserted here is not a string comparison for its own sake. It is:
 *
 *   - the three files that spell the mask spell the same three characters, because three spellings
 *     allowed to drift are three masks, and the drift would be silent;
 *   - the test the recorder applies is about *withholding* rather than about what looks secret —
 *     a page that declines to read a field back, and the one call that gave it a value;
 *   - a question that cannot be answered is answered with the value as it was given, because a run
 *     that cannot see the field cannot redact it, and a guess here would mislabel a field rather
 *     than protect it;
 *   - the literal leaves and comes back in memory only, and nothing is written.
 *
 * The properties are checked against the module's own exports rather than against its source, so
 * that a rewrite that keeps the contract keeps the suite green.
 */

import { readFileSync } from 'node:fs';
import { MIN_WITHHELD_CHARS, REDACTION, SUPPLIED_ARGUMENT, redactCallArguments, redactProse, withheldTargets } from '../lib/redaction.js';
import { CAPTURE_EXPRESSION } from '../lib/capture.js';
import { REDACTED } from '../lib/generate.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    fails++;
    console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected));
  } else console.log('ok  ', label);
};
const ok = (label, condition, detail = '') => {
  if (condition) { console.log('ok  ', label); return; }
  fails++;
  console.log('FAIL', label, detail ? `\n  ${detail}` : '');
};

// --- one mask, three spellings ----------------------------------------------------------------
// `capture.js` cannot splice the constant in: the file is a template literal evaluated in the page,
// with a deliberate no-interpolation rule, so the mask is a literal inside it. `generate.js` names
// the same string for tests it writes into a file. If any two of the three drift, a value would be
// masked in one artefact and readable in the next — which is the defect, not a cosmetic difference.
console.log('# the mask is one string, spelled in three files');
check('`redaction.js` and `generate.js` agree', REDACTION, REDACTED);
ok('`capture.js` writes the same literal into the page-evaluated expression',
  CAPTURE_EXPRESSION.includes(`'${REDACTION}'`),
  'the capture expression does not contain the mask as a quoted literal');
ok('and it writes it for a password field and for nothing else',
  /el\.type === 'password'\s*\?\s*\(el\.value \? '[^']*' : ''\)/.test(CAPTURE_EXPRESSION),
  'the password branch of the capture expression is not the one that writes the mask');

// --- the page withholds a field, the call is the one that filled it ----------------------------
// The reading is the evidence: a `browser_type` call's own arguments are not. The capture below says
// `[set]` for one control and a real value for another, so the same call shape is masked in one case
// and carried in the other — which is the whole test, and the reason it does not read the value.
const CAPTURE = {
  interactive: [
    { selector: '[data-testid="password-input"]', type: 'password', value: REDACTION },
    { selector: '[data-testid="email-input"]', type: 'email', value: 'test@example.com' },
    { selector: '[data-testid="search"]', type: 'search', value: '' },
  ],
};
const TYPED = { selector: '[data-testid="password-input"]', text: 'password123' };

console.log('\n# a value the page declines to read back is not written down');
check('the call\'s own arguments name the value', TYPED.text, 'password123');
check('and the mask is what is carried instead',
  redactCallArguments('browser_type', TYPED, CAPTURE).arguments,
  { selector: '[data-testid="password-input"]', text: REDACTION });
ok('and the call is reported as having withheld something',
  redactCallArguments('browser_type', TYPED, CAPTURE).withheld === true);
// The value is handed back so a second record holding it — the run's own instruction — can be
// rewritten. A caller that writes it anywhere has undone the redaction it just asked for, which is
// why it is a separate field and not folded into `arguments`.
check('the literal comes back in memory only, for the caller that must remove it elsewhere',
  redactCallArguments('browser_type', TYPED, CAPTURE).value, 'password123');
ok('and it is not left on the arguments under any name',
  !Object.values(redactCallArguments('browser_type', TYPED, CAPTURE).arguments).includes('password123'));

console.log('\n# a field the page does read back is not a credential');
const EMAIL = { selector: '[data-testid="email-input"]', text: 'test@example.com' };
check('a non-password field is carried as it was typed',
  redactCallArguments('browser_type', EMAIL, CAPTURE), { arguments: EMAIL, withheld: false, value: null });
check('an empty value is carried, because nothing was supplied to withhold',
  redactCallArguments('browser_type', { selector: '[data-testid="search"]', text: '' }, CAPTURE).withheld, false);

// --- a question that cannot be answered is answered honestly -----------------------------------
// Every case below is a run that cannot tell whether the value was withheld. Each must return the
// arguments as they were given: a rule that guessed would read the wrong field and then call the
// result a credential, which is worse than the leak it was trying to close, because it would be
// believed.
console.log('\n# where the question cannot be answered, nothing is removed and nothing is claimed');
check('a call for a tool whose argument name this repo does not know',
  redactCallArguments('browser_click', { selector: '[data-testid="sign-in"]' }, CAPTURE).arguments,
  { selector: '[data-testid="sign-in"]' });
check('a call with no selector of its own to match against',
  redactCallArguments('browser_type', { text: 'password123' }, CAPTURE).arguments, { text: 'password123' });
check('a reading that reported no interactive elements at all',
  redactCallArguments('browser_type', TYPED, null).arguments, TYPED);
check('a reading that names controls but withheld nothing',
  redactCallArguments('browser_type', TYPED, { interactive: [{ selector: TYPED.selector, type: 'text', value: 'x' }] }).arguments,
  TYPED);
check('a value that is already the mask, so there is nothing to take back out',
  redactCallArguments('browser_type', { ...TYPED, text: REDACTION }, CAPTURE).withheld, false);
check('no arguments at all, which is not a call that supplied anything',
  redactCallArguments('browser_type', null, CAPTURE), { arguments: null, withheld: false, value: null });

console.log('\n# the mask is read off the reading, not off the argument name');
check('the controls a reading says withheld their value',
  [...withheldTargets(CAPTURE)], ['[data-testid="password-input"]']);
check('and a reading with nothing to say offers no targets', [...withheldTargets(null)], []);
check('exactly one call supplies a value, and it is `browser_type`',
  [...SUPPLIED_ARGUMENT], [['browser_type', 'text']]);

// --- the same value inside a sentence ----------------------------------------------------------
// The instruction is where a credential usually enters the record: it is the task, and a task that
// says to sign in usually says as whom. Rewriting it is the same mask applied to prose, so the same
// function is used for `run.json` and for the instruction a journey quotes.
console.log('\n# a recorded sentence is rewritten with the same mask');
check('every occurrence of the value is replaced, not only the first',
  redactProse('sign in with test@example.com and password123, not password123 again', ['password123']),
  `sign in with test@example.com and ${REDACTION}, not ${REDACTION} again`);
check('an unrelated value in the same sentence is left alone',
  redactProse('sign in with test@example.com', ['password123']), 'sign in with test@example.com');
check('the sentence is returned unchanged when there is nothing to remove',
  redactProse('open the app', []), 'open the app');
check('a sentence that is not a string is handed back rather than thrown on',
  redactProse(null, ['password123']), null);
// The floor is a limit on damage rather than a decision about what a secret is: replacing a short
// string inside arbitrary prose would rewrite words, and a mask that damages the record is the
// failure it is meant to prevent. It only ever applies to a value the page declined to disclose.
console.log('\n# a short value is skipped, because a mask that rewrites words has damaged the record');
check('the floor is four characters', MIN_WITHHELD_CHARS, 4);
check('a value below the floor is not replaced',
  redactProse('sign in as ann with the password ann', ['ann']), 'sign in as ann with the password ann');
check('a value at the floor is replaced',
  redactProse('sign in as anna with the password anna', ['anna']), `sign in as ${REDACTION} with the password ${REDACTION}`);

// --- nothing here writes ------------------------------------------------------------------------
// The module is pure, and the one thing a caller must not do with `value` is persist it. Asserting
// immutability is how that stays true through a rewrite: a function that mutated its input would
// leave the raw value on a record the caller had already decided was safe.
console.log('\n# the module writes nothing, and mutates nothing it was handed');
const before = JSON.stringify(TYPED);
redactCallArguments('browser_type', TYPED, CAPTURE);
check('the arguments object is unchanged after the call', JSON.stringify(TYPED), before);
const prose = 'sign in with password123';
redactProse(prose, ['password123']);
check('the sentence is unchanged after the call', prose, 'sign in with password123');

// --- the guard the whole file is about ----------------------------------------------------------
// A value the page withheld must not appear in any of the module's returned arguments, whatever the
// call looked like. Enumerated rather than spot-checked, because the failure mode is "some call
// shape nobody thought of", and this is the cheapest way to cover the shapes that exist.
console.log('\n# no call shape returns the value it was asked to withhold');
{
  const shapes = [
    ['browser_type', { selector: '[data-testid="password-input"]', text: 'password123' }],
    ['browser_type', { selector: '[data-testid="password-input"]', text: 'password123', delay: 10 }],
    ['browser_type', { text: 'password123', selector: '[data-testid="password-input"]' }],
  ];
  const leaks = shapes.filter(([tool, args]) =>
    Object.values(redactCallArguments(tool, args, CAPTURE).arguments ?? {}).includes('password123'));
  check('every shape that names the withheld control comes back masked', leaks, []);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall redaction checks passed');
process.exit(fails ? 1 : 0);
