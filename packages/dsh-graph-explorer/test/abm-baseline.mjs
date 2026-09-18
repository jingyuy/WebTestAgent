/**
 * The acceptance proof for phase 0b: profile a real run, and refuse it for the reason the pivot
 * exists.
 *
 * The claim under test is narrow and it is the whole justification for the fork:
 *
 *   the 0.1.22 sign-in walk committed `fill_login_email`, `fill_login_password` and `submit_login`
 *   as capabilities — names that say *how the tool moved the mouse*, not *what the user was
 *   trying to do* — and nothing in the 0.1 pipeline noticed, because nothing in it can.
 *
 * And the same walk is the measured case for D9/D11 (P14/P15): every one of those capabilities,
 * every edge and both states carry `status: verified` at `confidence: 1` because a model
 * (`llm:deepseek-flash`) said so, while the only thing that was actually watched is the action. The
 * projection re-emits those `metadata` blocks verbatim, so this document is the *mechanism* of the
 * promotion, not just a witness to it — which is why the acceptance now has to be that the profile
 * names it.
 *
 * So this script reads a run the plugin actually produced, projects it into an `abm/0.2` document,
 * and profiles that document. The expected P1 refusals are **derived from the run's own log**, not
 * written here: every committed capability whose leading word is a mechanism verb must come out
 * refused, and nothing else may be refused for that reason. A snapshot would only prove the
 * snapshot. The P14 refusals are derived the same way — the objects whose own producer is a reading
 * reported at the collector's status — and P15 is asserted silent *because* the walk's inferences
 * name their producer and their basis.
 *
 * It is a harness, not a suite: `npm test` must keep working in a clone with nothing installed, so
 * this is `npm run profile:abm`, and every part that needs a dependency or a run on this machine
 * SKIPs with a reason instead of failing.
 *
 * Usage:
 *   node test/abm-baseline.mjs [run-dir] [--out <path>] [--out-dir <dir>] [--quiet]
 *   ABM_RUN_DIR=/path/to/graph-run npm run profile:abm
 *
 * With no directory the first of these that exists is used, and a refusal to guess is printed if
 * none of them do:
 *   $ABM_RUN_DIR, ~/tmp/live-graph/graph-run, <repo>/artifacts/graph-spike
 *
 * `--out` writes the projected document. `--out-dir` writes the three things a person reading the
 * profile wants: `application-model.json` (what the profile read), `findings.json` (what it said,
 * one entry per refusal) and — when the projection refuses, which is a real answer — `refused.json`
 * instead. Findings are the output here; with neither flag the only place they exist is the
 * terminal, and a result you cannot open is a result you cannot argue with.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadAjv } from './ajv.mjs';
import {
  MECHANISM_VERBS,
  PROFILE_RULES,
  candidatesFromRun,
  modelFromCandidates,
  profileFindings,
  summarizeFindings,
} from '../lib/abm.js';
import { slugify } from '../lib/session.js';

const HERE = new URL('..', import.meta.url).pathname;
const REPO = resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
let out = null;
let outDir = null;
const targets = [];
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--out') { out = argv[++index]; continue; }
  if (argv[index] === '--out-dir') { outDir = argv[++index]; continue; }
  if (argv[index].startsWith('--')) continue;
  targets.push(argv[index]);
}

const DEFAULT_RUNS = [
  process.env.ABM_RUN_DIR,
  join(process.env.HOME ?? '', 'tmp/live-graph/graph-run'),
  join(REPO, 'artifacts/graph-spike'),
].filter(Boolean);

const runDir = targets[0] ? resolve(targets[0]) : DEFAULT_RUNS.find((dir) => existsSync(join(dir, 'run.json')));

const say = (...args) => { if (!quiet) console.log(...args); };
const verdict = (label, passed, detail = '') => {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  return passed;
};
let failures = 0;
const assert = (label, passed, detail) => { if (!verdict(label, passed, detail)) failures++; };

const writeOut = (name, value) => {
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  say(`written    ${path}`);
};

if (!runDir || !existsSync(join(runDir, 'run.json'))) {
  console.log('SKIP  no run directory to profile.');
  console.log('      Looked for run.json in:');
  for (const dir of targetDirs()) console.log(`        ${dir}`);
  console.log('      Point it at one: node test/abm-baseline.mjs <run-dir>');
  process.exit(0);
}

function targetDirs() {
  return targets.length ? [resolve(targets[0])] : DEFAULT_RUNS;
}

// --- read the run ------------------------------------------------------------------------------

// The profile is a reading. If it left a mark on the run it read, the reading would be part of what
// it read — and phase 0b is allowed to be a diagnostic precisely because it never writes.
const fingerprint = (dir) => readdirSync(dir).sort()
  .map((name) => `${name}:${statSync(join(dir, name)).size}:${statSync(join(dir, name)).mtimeMs}`)
  .join('|');
const before = fingerprint(runDir);

const candidates = candidatesFromRun(runDir);

// A run the commit refused to write a document for is itself one of the things a profile has to be
// able to say. It is not a crash: the projection refuses for the same reason the commit's gate did,
// and the two refusals have to agree.
let model = null;
let refusal = null;
try {
  model = modelFromCandidates(candidates);
} catch (error) {
  refusal = error;
}

say(`run        ${runDir}`);
say(`read from  ${candidates.source}${candidates.source === 'graph.json' ? '' : ' (no graph.json: the logs, through the commit\'s own reconciliation)'}`);
say(`committed  ${candidates.capabilities.length} capabilities, ${candidates.transitions.length} transitions, ${candidates.states.length} states, ${candidates.journeys.length} journeys`);

if (refusal) {
  console.log('REFUSED  this run cannot become a 0.2 document.');
  console.log(`      ${refusal.message}`);
  console.log('');
  const gates = candidates.notes ?? [];
  for (const note of gates) console.log(`      ${note}`);
  writeOut('refused.json', { run: runDir, source: candidates.source, refused: true, message: refusal.message, gates });
  assert('the refusal is the commit\'s own gate, quoted', gates.some((note) => note.includes('application_not_declared')), gates.join('\n      '));
  assert('profiling the run did not write to it', fingerprint(runDir) === before);
  console.log('');
  console.log(failures ? `${failures} FAILURE(S)` : 'REFUSED: the pipeline refuses this run as a document, and so does the profile, for the same stated reason.');
  process.exit(failures ? 1 : 0);
}

const findings = profileFindings(model, { candidates });
const summary = summarizeFindings(findings);

say(`projected  ${model.behaviors.length} behaviors, ${model.transitions.length} transitions, ${model.states.length} states, ${model.journeys.length} journeys`);
say(`profile    ${JSON.stringify(summary)}`);

if (out) {
  writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`);
  say(`written    ${out}`);
}

// The findings are the profile's output; the model is what it read to get them. Both are written,
// so a finding can be checked against the sentence it is about without re-running anything.
writeOut('application-model.json', model);
writeOut('findings.json', { run: runDir, source: candidates.source, summary, findings });

if (findings.length && !quiet) {
  say('');
  for (const finding of findings) {
    say(`  ${finding.severity.padEnd(7)} ${finding.rule}  ${finding.code}  ${finding.subject ?? '-'}`);
  }
}
say('');

// --- the projection carries the log -------------------------------------------------------------

const behaviourIds = new Set(model.behaviors.map((behavior) => behavior.id));
const missing = candidates.capabilities
  .map((capability) => `behavior_${slugify(capability.name)}`)
  .filter((id) => !behaviourIds.has(id));
assert('every committed capability survives as a behaviour', missing.length === 0,
  missing.length ? `not projected: ${missing.join(', ')}` : `${candidates.capabilities.length} of ${candidates.capabilities.length}`);

// A capability's declared composition must name behaviours, not capabilities: a document that
// still pointed at 0.1 ids would validate and be wrong.
const danglingComposition = model.behaviors
  .flatMap((behavior) => (behavior.composed_of ?? []).map((member) => [behavior.id, member]))
  .filter(([, member]) => !behaviourIds.has(member));
assert('composed_of names behaviours the document declares', danglingComposition.length === 0,
  danglingComposition.map(([owner, member]) => `${owner} → ${member}`).join(', '));

// --- the defect ---------------------------------------------------------------------------------

// Derived from the run's own vocabulary, with the same predicate the rule uses and no knowledge of
// the rule's output: the names the walk committed, and which of them are mechanism verbs.
const mechanismNames = candidates.capabilities
  .filter((capability) => MECHANISM_VERBS.has(String(capability.name).split('_')[0]))
  .map((capability) => `behavior_${slugify(capability.name)}`);

const refusedP1 = findings.filter((finding) => finding.rule === 'P1').map((finding) => finding.subject).sort();
assert('P1 refuses exactly the capabilities named after a mechanism',
  JSON.stringify(refusedP1) === JSON.stringify([...mechanismNames].sort()),
  `refused: ${refusedP1.join(', ') || '(none)'}${mechanismNames.length ? `\n      expected: ${[...mechanismNames].sort().join(', ')}` : ''}`);

assert('a document built from a real run is refused, not filed',
  mechanismNames.length === 0 ? true : summary.failed === true,
  `errors ${summary.errors}, warnings ${summary.warnings}${mechanismNames.length ? '' : ' (this run commits no mechanism-named capability, so there is nothing here to refuse)'}`);

if (mechanismNames.length) {
  const refusedForTheRightReason = findings.filter((finding) => finding.rule === 'P1')
    .every((finding) => finding.code === 'behavior_name_is_a_mechanism');
  assert('and it says why, in terms the commit can act on', refusedForTheRightReason);
}

// --- the same objects reported at the collector's confidence (D9, D11) --------------------------

// Same method: the predicate comes from the run's log, not from the rule's output. An object whose
// `metadata.producer` is a reading (`llm:*`, `importer:*`) cannot be `verified`, because what was
// actually watched is the action, not the name.
const READING = /^(llm|importer)(:|$)/;
const claimedByAReading = [
  ...candidates.capabilities.map((capability) => [`behavior_${slugify(capability.name)}`, capability]),
  ...candidates.states.map((state) => [state.id, state]),
  ...candidates.transitions.map((transition) => [transition.id, transition]),
].filter(([, object]) => READING.test(String(object?.metadata?.producer ?? '')) && object.metadata.status === 'verified')
  .map(([id]) => id).sort();
const refusedForTheReading = findings
  .filter((finding) => finding.rule === 'P14' && finding.code === 'claim_outranks_its_producer')
  .map((finding) => finding.subject).sort();

assert('P14 refuses exactly the objects a reading reported as verified',
  JSON.stringify(refusedForTheReading) === JSON.stringify(claimedByAReading),
  `refused: ${refusedForTheReading.join(', ') || '(none)'}${claimedByAReading.length ? `\n      expected: ${claimedByAReading.join(', ')}` : ''}${refusedForTheReading.length ? `\n      so the walk is refused for the reason the pivot exists even after the naming rule is satisfied: ${refusedForTheReading.length} of the ${findings.length} findings are this one.` : ''}`);

// P15's silence is a claim too, and it is checked against the log rather than assumed: every
// inference in this walk says who made it and what it rests on, so there is nothing to refuse.
const inferencesWithoutAProducer = [...candidates.capabilities, ...candidates.journeys]
  .filter((object) => object?.metadata?.status === 'inferred' && !object.metadata.producer);
assert('P15 is silent because every inference this walk made names its producer',
  inferencesWithoutAProducer.length === 0 && findings.every((finding) => finding.rule !== 'P15'),
  [inferencesWithoutAProducer.map((object) => object.id).join(', '), findings.filter((finding) => finding.rule === 'P15').map((finding) => finding.subject).join(', ')].filter(Boolean).join(' / '));

// --- the profile is §3's, and the document is 0.2's ---------------------------------------------

const wrongSeverity = findings.filter((finding) => !(PROFILE_RULES[finding.rule] ?? []).includes(finding.severity));
assert('every finding reports a severity its rule allows', wrongSeverity.length === 0,
  wrongSeverity.map((finding) => `${finding.rule}/${finding.severity}`).join(', '));

assert('the projected document is stamped with the schema it targets', model.schema_version === '0.2');

// The validator is optional by design: ajv is not a dependency of this plugin.
let validate = null;
const ajvModules = await loadAjv();
if (ajvModules) {
  const { Ajv2020, addFormats, root } = ajvModules;
  const dir = join(HERE, 'schemas/abm/0.2');
  const schemas = readdirSync(dir).filter((name) => name.endsWith('.schema.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false, schemas });
  addFormats(ajv, { mode: 'full' });
  validate = ajv.getSchema('https://webtestagent.local/schemas/abm/0.2/application-model.schema.json');
  say(`schemas    ${schemas.length} from ${dir} (ajv by way of ${root})`);
}
if (validate) {
  const ok = validate(model);
  const broken = ok ? [] : (validate.errors ?? []).slice(0, 6)
    .map((error) => `${error.instancePath || '/'} ${error.message}`);
  assert('the projected document validates against abm/0.2', ok, broken.join('\n      '));
} else {
  console.log('SKIP  schema validation: ajv is not resolvable here (set ABM_AJV_ROOT, or npm i ajv ajv-formats in a directory it names).');
}

// --- the reading left no mark --------------------------------------------------------------------

assert('profiling the run did not write to it', fingerprint(runDir) === before);

console.log('');
console.log(failures ? `${failures} FAILURE(S)` : 'ACCEPTED: the projection reads a real run and the profile refuses it for the reason the pivot exists — the mechanism names, and the confidence they were reported at.');
process.exit(failures ? 1 : 0);
