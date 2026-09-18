/**
 * The phase-3 acceptance, measured on the log rather than on the finished model.
 *
 * The claim under test is what the protocol is for, and it is the one thing no tool can enforce:
 *
 *   a run driven by the protocol records **behaviours**, and the interactions it performed are
 *   recorded as *steps of them* — not as a run of capabilities named after the control they moved.
 *
 * The measure is the log, and D13 is why. The projection demotes a capability that is a step of a
 * behaviour, so a step never becomes a behaviour in `application-model.json` and P1 has nothing to
 * count there; the projection cannot move a number it deliberately erases. `capabilities.jsonl` is
 * where the protocol's own output is visible, so it is where this is measured.
 *
 * Three numbers, each derived from the log and nothing else:
 *
 *   unattached   a canonical capability that no behaviour composes *and* that composes nothing —
 *                a call recorded with no behaviour attached. This is the 0.1.20 failure written
 *                down: a sign-in logged as `fill_login_email`, `fill_login_password` and `login`,
 *                three behaviours in a row for one thing a user asked for.
 *   realised     per behaviour, the steps it composes against the realisations it has. A step of a
 *                behaviour with no realisation is a step recorded as a mechanism name and never
 *                described as one — `fill_login_email` with no verb, no element and no purpose.
 *   described    a realisation that names its action and its `purpose`. A realisation without a
 *                purpose is a step the model cannot describe, which is the difference between a
 *                behaviour model and a list of commands.
 *
 * The baselines on this machine are read as history, not as the acceptance: `~/tmp/live-fix/graph-run`
 * is the 0.1.20 walk the first number was written against (three unattached capabilities), and
 * `~/tmp/live-graph/graph-run` is the 0.1.22 walk that introduced compositions but no realisations
 * (so its zero is evidence that the record kind did not exist yet, as much as of the wording). A
 * 0.1.23 run is the only evidence for the wording; the older two say what the numbers mean.
 *
 * It is a harness, not a suite: `npm test` must keep working in a clone with nothing installed, so
 * this is `npm run profile:protocol`, and a machine with no run directory SKIPs with a reason.
 *
 * Usage:
 *   node test/protocol-coverage.mjs [run-dir...] [--quiet]
 *   PROTOCOL_RUN_DIR=/path/to/graph-run npm run profile:protocol
 *
 * With no directory the first of these that exists is used, and a refusal to guess is printed if
 * none of them do:
 *   $PROTOCOL_RUN_DIR, ~/tmp/live-graph/graph-run, <repo>/artifacts/graph-spike
 *
 * Several directories may be named, and the last line is then a table of them: the point of a
 * measure is the comparison, and the comparison is what says which number the phase moved. The exit
 * status is 0 only when every run named satisfies every verdict, so naming a baseline on the command
 * line is asking for its failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STEP_ACTIONS } from '../lib/schema.js';

const HERE = new URL('..', import.meta.url).pathname;
const REPO = resolve(HERE, '..', '..');
const HOME = homedir();

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const named = args.filter((arg) => !arg.startsWith('--'));
const candidates = named.length
  ? named
  : [process.env.PROTOCOL_RUN_DIR, join(HOME, 'tmp/live-graph/graph-run'), join(REPO, 'artifacts/graph-spike')]
    .filter((value) => typeof value === 'string' && value.length > 0);
const dirs = candidates.map((dir) => resolve(dir)).filter((dir) => existsSync(join(dir, 'capabilities.jsonl')));

const jsonl = (path) => {
  const records = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try { records.push(JSON.parse(lines[index])); } catch (error) {
      throw new Error(`${path}:${index + 1} is not JSON: ${error.message}`);
    }
  }
  return records;
};

const idOf = (record) => record.id ?? record.capability_id ?? null;

/**
 * One run's log, read as the protocol's output. Nothing here is a claim about what the run *should*
 * have recorded — every expectation below is derived from the records themselves, because a
 * snapshot of a good run would only prove the snapshot.
 */
const measure = (dir) => {
  const records = jsonl(join(dir, 'capabilities.jsonl'));
  const edges = existsSync(join(dir, 'transitions.jsonl')) ? jsonl(join(dir, 'transitions.jsonl')) : [];

  // Three kinds of record in one file (the commit reads them together and filters the same way):
  // the canonical capability per name, the later declaration of what a behaviour is made of, and
  // one realisation per step of a behaviour.
  const canonical = records.filter((record) => record.kind !== 'capability_composition' && record.kind !== 'realization_step');
  const compositions = records.filter((record) => record.kind === 'capability_composition');
  const realisations = records.filter((record) => record.kind === 'realization_step');

  // What each capability is made of. The canonical record carries the members it was created with
  // and each `capability_behaviour` call appends a row — the composition of a behaviour is usually
  // only complete after the walk that performed it, which is why the union is taken rather than the
  // last row read.
  const composedOf = new Map();
  for (const record of canonical) {
    const id = idOf(record);
    if (!id) continue;
    const members = new Set(composedOf.get(id) ?? []);
    for (const member of record.composed_of ?? []) members.add(member);
    composedOf.set(id, members);
  }
  for (const record of compositions) {
    const id = record.capability_id ?? record.id;
    if (!id) continue;
    const members = new Set(composedOf.get(id) ?? []);
    for (const member of record.composed_of ?? []) members.add(member);
    composedOf.set(id, members);
  }

  const stepIds = new Set();
  for (const members of composedOf.values()) for (const member of members) stepIds.add(member);

  // Which transitions each behaviour was realised on. Keyed by behaviour, deduplicated: one edge is
  // one step of that behaviour however many times the log recorded the pair.
  const realisedOn = new Map();
  for (const record of realisations) {
    const id = record.capability_id ?? record.id;
    if (!id) continue;
    const set = realisedOn.get(id) ?? new Set();
    set.add(record.transition_id ?? null);
    realisedOn.set(id, set);
  }

  const behaviours = new Set([...composedOf.keys()].filter((id) => (composedOf.get(id)?.size ?? 0) > 0));
  for (const id of realisedOn.keys()) behaviours.add(id);

  const nameOf = new Map();
  for (const record of canonical) {
    const id = idOf(record);
    if (id) nameOf.set(id, record.name ?? id);
  }
  const label = (id) => nameOf.get(id) ?? id;

  const unattached = canonical
    .map((record) => idOf(record))
    .filter((id) => id && !stepIds.has(id) && !behaviours.has(id));

  const coverage = [...behaviours].map((id) => ({
    id,
    name: label(id),
    steps: composedOf.get(id)?.size ?? 0,
    realised: realisedOn.get(id)?.size ?? 0,
  })).sort((left, right) => left.name.localeCompare(right.name));

  const described = realisations.filter((record) => {
    const action = record.realization?.action ?? record.action;
    const purpose = record.realization?.purpose ?? record.purpose;
    return typeof action === 'string' && STEP_ACTIONS.has(action) && typeof purpose === 'string' && purpose.trim().length > 0;
  });
  const verbs = realisations.map((record) => record.realization?.action ?? record.action).filter(Boolean);

  // Every edge is a capability the run recorded: an edge that names nothing in this log is an edge
  // no behaviour owns, whichever half of the pivot you read it from. Both spellings are accepted,
  // because the log's edges carry ids and the tools are called with names.
  const known = new Set([...nameOf.keys(), ...nameOf.values()]);
  for (const record of canonical) { const id = idOf(record); if (id) known.add(id); }
  const unknownEdges = [...new Set(edges.map((edge) => edge.action?.capability ?? null).filter((id) => id && !known.has(id)))];

  return {
    dir,
    capabilities: canonical.length,
    behaviours: behaviours.size,
    steps: stepIds.size,
    unattached,
    nameOf,
    coverage,
    realisations: realisations.length,
    described: described.length,
    verbs,
    edges: edges.length,
    unknownEdges,
  };
};

// A verdict with nothing to check is reported as `n/a` rather than as a pass, and it is left out of
// the tally: a green result is evidence of a positive and never of a negative, and "nothing was
// recorded to check" is not a pass. The failure it would otherwise hide is the one this whole
// measure is about, so the numbers stay separate.
const verdicts = (run) => {
  const results = [];
  results.push({
    name: 'no capability is recorded with no behaviour attached',
    ok: run.unattached.length === 0,
    detail: run.unattached.length
      ? `${run.unattached.length} recorded as a behaviour in its own right: ${run.unattached.map((id) => run.nameOf.get(id) ?? id).join(', ')}`
      : `${run.capabilities} capabilities, every one a step of a behaviour or a behaviour itself`,
  });
  const incomplete = run.coverage.filter((entry) => entry.realised < entry.steps);
  results.push({
    name: 'every step of every behaviour is recorded as a realisation',
    skipped: run.coverage.length === 0,
    ok: incomplete.length === 0,
    detail: run.coverage.length === 0
      ? 'no behaviour in this log has steps'
      : incomplete.length
        ? incomplete.map((entry) => `${entry.name}: ${entry.realised}/${entry.steps} steps realised`).join('; ')
        : run.coverage.map((entry) => `${entry.name}: ${entry.realised}/${entry.steps}`).join('; '),
  });
  results.push({
    name: 'every realisation names the browser action and the step purpose',
    skipped: run.realisations === 0,
    ok: run.realisations === run.described,
    detail: run.realisations === 0
      ? 'nothing was recorded to check'
      : `${run.described}/${run.realisations} described${run.verbs.length ? ` (verbs: ${[...new Set(run.verbs)].sort().join(', ')})` : ''}`,
  });
  results.push({
    name: 'every edge is a capability this run recorded',
    skipped: run.edges === 0,
    ok: run.unknownEdges.length === 0,
    detail: run.edges === 0
      ? 'the log has no transitions'
      : run.unknownEdges.length
        ? `edges name ${run.unknownEdges.join(', ')}`
        : `${run.edges} edges, each resolving to a canonical capability`,
  });
  return results;
};

if (!dirs.length) {
  console.log('SKIP  no run directory with a capabilities.jsonl.');
  console.log('      Point it at one: node test/protocol-coverage.mjs <run-dir>, or set PROTOCOL_RUN_DIR.');
  console.log(`      Looked at: ${candidates.join(', ') || '(nothing configured)'}`);
  process.exit(0);
}

let failures = 0;
const table = [];

for (const dir of dirs) {
  const run = measure(dir);
  const results = verdicts(run);
  const checked = results.filter((result) => !result.skipped);
  failures += checked.filter((result) => !result.ok).length;

  console.log(`\n== ${dir}`);
  console.log(`   capabilities ${run.capabilities} (${run.behaviours} behaviours, ${run.steps} steps, ${run.unattached.length} unattached)`);
  console.log(`   realisations ${run.realisations} (${run.described} described)`);
  console.log(`   edges        ${run.edges}`);
  if (!quiet) for (const entry of run.coverage) console.log(`   behaviour    ${entry.name}  ${entry.realised}/${entry.steps} steps realised`);
  for (const result of results) {
    console.log(`   ${result.skipped ? 'n/a ' : result.ok ? 'ok  ' : 'FAIL'} ${result.name} — ${result.detail}`);
  }

  table.push({
    dir,
    capabilities: run.capabilities,
    behaviours: run.behaviours,
    steps: run.steps,
    unattached: run.unattached.length,
    realisations: run.realisations,
    described: run.described,
    verdicts: `${checked.filter((result) => result.ok).length}/${checked.length || results.length}`,
  });
}

if (table.length > 1) {
  console.log('\nrun                                            caps  behav  steps  unatt  real  descr  verdicts');
  for (const row of table) {
    const short = row.dir.replace(HOME, '~');
    console.log(`${short.padEnd(46)}${String(row.capabilities).padStart(4)}${String(row.behaviours).padStart(7)}${String(row.steps).padStart(7)}${String(row.unattached).padStart(7)}${String(row.realisations).padStart(6)}${String(row.described).padStart(7)}  ${row.verdicts}`);
  }
}

console.log(failures
  ? `\n${failures} FAILURE(S): this run is not the protocol's output. A baseline named on purpose fails on purpose.`
  : '\nACCEPTED: every capability this walk recorded belongs to a behaviour, and the steps of those behaviours are recorded as steps.');
process.exit(failures ? 1 : 0);
