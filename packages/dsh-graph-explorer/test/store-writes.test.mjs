// The store's contract with the run, when the workspace stops cooperating.
//
// The run directory is a directory in someone's checkout. It can be deleted,
// moved, or shadowed by a file while the agent is still working, and none of
// that is a reason for a browser action that worked to be reported as a
// failure — but neither is it a reason to pretend a record was written.
//
// Two properties are checked here, and they are the two halves of one rule:
//
//   * writing never throws, and a missing directory is repaired when it can be;
//   * nothing is remembered that is not in the log, so a refused record leaves
//     no id behind and burns no sequence number.
//
// The second is the one that is easy to get wrong and expensive when you do: a
// state whose `kind: "state"` line never landed, but which the index remembers,
// is a state the commit reads as a *sighting* of nothing and silently drops.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun } from '../lib/session.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label, '=', JSON.stringify(actual));
};
const lines = (dir, name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const observation = (tool) => ({ tool, toolArgs: {}, phase: 'after', capture: { url: 'http://x/', title: 'X' }, error: null, screenshot: null });

// --- a run that can write ------------------------------------------------
const healthyProblems = [];
const cwd = mkdtempSync(join(tmpdir(), 'gx-writes-'));
const run = createRun({
  cwd,
  provenance: { plugin: { name: 'graph-explorer', version: '0.0.0-test' } },
  onStoreError: (problem) => healthyProblems.push(problem),
});
check('run.json is written through the guarded path', existsSync(join(run.dir, 'run.json')), true);
check('a store that can write reports no problems', [healthyProblems, run.writeProblem(), run.writeFailures(), run.recreations()], [[], null, 0, 0]);
check('the evidence directory is created', existsSync(run.evidenceDir), true);

// --- the directory is deleted mid-run ------------------------------------
const surviving = run.addObservation({ ...observation('browser_open'), capture: null, error: 'page not read' });
check('the first observation is written', surviving.id, 'obs_0001');
const beforeState = run.addState({ observationId: 'obs_0001', page_type: 'dashboard', detection: [{ type: 'url' }] });
const beforeCapability = run.addCapability({ name: 'login', kind: 'setup' });
check('with a reading and a capability beside it',
  [beforeState.id, beforeCapability.id, run.stateCount(), run.capabilityCount()],
  ['state_dashboard', 'cap_login', 1, 1]);
const beforeText = readFileSync(join(run.dir, 'run.json'), 'utf8');
const recordedAt = JSON.parse(beforeText).started_at;

rmSync(run.dir, { recursive: true, force: true });
check('the run directory is really gone', existsSync(run.dir), false);

let afterDeletion = null;
let threw = null;
try {
  afterDeletion = run.addObservation(observation('browser_click'));
} catch (error) {
  threw = error;
}
check('a deleted run directory does not throw out of a store write', threw, null);
check('and the record is written, not dropped', afterDeletion?.id, 'obs_0002');
check('the count follows the log: two records written, two counted', [run.observationCount(), run.writeProblem()], [2, null]);
check('run.json is restored verbatim — the same run, not a new one', JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')).started_at, recordedAt);
check('the evidence directory comes back with it', existsSync(run.evidenceDir), true);
// The earlier line went with the directory, and the repair does not pretend
// otherwise: it is announced, and the count of unwritten records is not touched,
// because nothing was lost to a *failed write* — it was deleted.
check('the recreated log holds what was written after the deletion', lines(run.dir, 'observations.jsonl').map((r) => r.id), ['obs_0002']);
check('the repair is counted and announced', [run.recreations(), healthyProblems.filter((p) => p.kind === 'recreated').length], [1, 1]);
check('the announcement names the directory and the repair', [healthyProblems[0].path === run.dir, /recreated/.test(healthyProblems[0].message)], [true, true]);
check('a repair is not a write failure: the count stays clean', run.writeFailures(), 0);
// What the log lost, the store stops claiming to know. A state or a capability the
// new log has never seen would be referenced by the next transition as though the
// commit could resolve it, and the commit cannot.
check('the index is emptied of the records the log lost',
  [run.stateCount(), run.stateForObservation('obs_0001'), run.capabilityNames(), run.walkLength(), run.transitionCount()],
  [0, undefined, [], 0, 0]);

// The reading that follows the repaired write is therefore a first sighting, not a
// repeat: the identity was seen before, but in the directory that went away, and a
// repeat written without a canonical state is a state the commit silently drops.
const stateAfterRepair = run.addState({ observationId: 'obs_0001', page_type: 'dashboard', detection: [{ type: 'url' }] });
check('the run carries on: a reading after the repair is minted', [stateAfterRepair.id, stateAfterRepair.minted, run.stateForObservation('obs_0001')],
  ['state_dashboard', true, 'state_dashboard']);
check('and written as a state, not as a sighting of nothing',
  lines(run.dir, 'states.jsonl').map((r) => [r.id, r.kind]), [['state_dashboard', 'state']]);
check('the vocabulary was emptied too, so the same name is free again',
  run.addCapability({ name: 'login', kind: 'setup' }).created, true);

// --- the directory cannot be put back ------------------------------------
// A file where the directory was is the portable way to make the repair itself
// fail: `mkdirSync` cannot create a directory over a file. This is the state a
// misconfigured `run_dir_name` produces, and the run has to survive it.
const blockedProblems = [];
const blockedCwd = mkdtempSync(join(tmpdir(), 'gx-blocked-'));
const blocked = createRun({ cwd: blockedCwd, onStoreError: (problem) => blockedProblems.push(problem) });
rmSync(blocked.dir, { recursive: true, force: true });
writeFileSync(blocked.dir, 'a file where the run directory was\n');

check('a record that cannot be written returns null rather than throwing',
  blocked.addObservation(observation('browser_open')), null);
check('the failure names the file it could not write and the reason the repair failed',
  [blocked.writeProblem()?.path, typeof blocked.writeProblem()?.message, blocked.writeProblem()?.repaired, typeof blocked.writeProblem()?.repair_error],
  [blocked.observationsPath, 'string', false, 'string']);
check('the count of unwritten records is kept', blocked.writeFailures(), 1);

const refusedState = blocked.addState({ observationId: 'obs_0001', page_type: 'dashboard', detection: [{ type: 'url' }] });
const refusedCapability = blocked.addCapability({ name: 'login', kind: 'setup' });
const refusedTransition = blocked.recordTransition({
  from_state: 'state_dashboard',
  to_state: 'state_login',
  capability_id: 'cap_login',
  capability_name: 'login',
  before_observation: 'obs_0001',
  after_observation: 'obs_0002',
  observed_change: {},
});
check('a refused state, capability and transition all come back as null',
  [refusedState, refusedCapability, refusedTransition], [null, null, null]);
check('nothing refused is remembered: the state index is empty',
  [blocked.stateCount(), blocked.stateForObservation('obs_0001'), blocked.capabilityNames()], [0, undefined, []]);
check('nothing refused is remembered: the walk has not moved',
  [blocked.walkLength(), blocked.transitionCount(), blocked.lastTransition(), blocked.observationCount()], [0, 0, null, 0]);
check('the failure is reported for every record, not only the first', blockedProblems.filter((p) => p.kind === 'unwritten').length, 4);

// --- the workspace becomes writable again --------------------------------
rmSync(blocked.dir, { force: true });
const recovered = blocked.addObservation(observation('browser_open'));
check('the write succeeds once the path is usable', recovered?.id, 'obs_0001');
check('run.json is written back, so the directory is a run directory again', existsSync(join(blocked.dir, 'run.json')), true);
check('the recovered write clears the current problem', blocked.writeProblem(), null);
check('but the count of unwritten records is sticky, because a gap is a gap', blocked.writeFailures(), 4);

const recoveredState = blocked.addState({ observationId: 'obs_0001', page_type: 'dashboard', detection: [{ type: 'url' }] });
check('a state refused earlier is minted now, not mistaken for a re-sighting', [recoveredState.minted, lines(blocked.dir, 'states.jsonl').map((r) => r.kind)],
  [true, ['state']]);
const recoveredCapability = blocked.addCapability({ name: 'login', kind: 'setup' });
check('and the capability name is still unclaimed, so the same call creates it', [recoveredCapability.id, recoveredCapability.created, blocked.capabilityNames()],
  ['cap_login', true, ['login']]);

// --- a workspace that can never be written to ----------------------------
// Creating a run must not throw either: the store is created from inside the
// recorder, where an exception would fail the browser action that happened to
// be first, and the honest place to report this is the first attempt to record.
const fileAsParent = join(mkdtempSync(join(tmpdir(), 'gx-nowhere-')), 'not-a-directory');
writeFileSync(fileAsParent, 'x');
let createThrew = null;
let dead = null;
try {
  dead = createRun({ cwd: fileAsParent });
} catch (error) {
  createThrew = error;
}
check('a run in an unwritable workspace is created, not thrown', createThrew, null);
check('and it says so at once, before any record is attempted', dead?.writeProblem()?.path, join(fileAsParent, 'graph-run', 'run.json'));
check('the first record is refused rather than throwing', dead?.addObservation(observation('browser_open')), null);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
