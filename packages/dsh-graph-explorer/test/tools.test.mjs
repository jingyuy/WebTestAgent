import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';
import { losslessPaths } from './lossless.mjs';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};
const refuses = async (label, fn, expectedFragment) => {
  try { await fn(); fails++; console.log('FAIL', label, '(no error thrown)'); }
  catch (error) {
    const ok = String(error.message).includes(expectedFragment);
    if (!ok) { fails++; console.log('FAIL', label, '\n  message ', error.message, '\n  expected to contain', expectedFragment); }
    else console.log('ok  ', label);
  }
};

// --- fake harness ---------------------------------------------------------
const cwd = mkdtempSync(join(tmpdir(), 'gx-tools-'));
const tools = new Map();
const handlers = new Map();
const sections = [];
const logs = [];
let queue = [];           // capture values served to browser_eval, in order

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-test' } } },
};

const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    execute: async (call) => {
      if (call.name === 'browser_eval') {
        // The recorder dispatches two evaluations around every action: the settle that
        // waits for the page to stop moving, and the reading itself. Only the reading is
        // served a queued capture — the queue is this test's script of what the page
        // looks like, and the settle is not asking about the page, only about its clock.
        const expression = call.arguments?.expression;
        if (expression === SETTLE_EXPRESSION) {
          return { isError: false, value: { waited_ms: 0, quiet_ms: 250, idle_ms: 1000, budget_ms: 3000, changes: 0, in_flight: 0, timed_out: false, watched: true } };
        }
        if (expression !== CAPTURE_EXPRESSION) {
          throw new Error('tools.test: an unexpected browser_eval was dispatched by the collector');
        }
        const value = queue.length > 1 ? queue.shift() : queue[0];
        return { isError: false, value };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section: (section) => sections.push(section) },
};
apply(ctx, Config({ }));

const capture = (over = {}) => ({ url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {}, scroll: {}, network: [], console: [], page_errors: [], ...over });
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);

// --- registration ---------------------------------------------------------
check('all three tools registered', [...tools.keys()].sort(), ['graph_commit', 'graph_observe', 'graph_transition']);
check('protocol section contributed', sections.map((s) => [s.name, s.order]), [['graph:exploration-protocol', 150]]);
check('protocol teaches the transition tool', sections[0].text.includes('graph_transition'), true);
check('protocol teaches where the run ends', sections[0].text.includes('graph_commit'), true);
// Two runs recorded a transition for their first action and were refused: the procedure said to
// record a transition for every step, and the rule that the first one has no state to move between
// was only in the tool description. A procedure whose first iteration is not the procedure.
check('protocol says the first action is a step, not a transition', sections[0].text.includes('The first action of a run is a step, not a transition'), true);
// And two runs wrote the page_type where a state id was meant, because the paragraph that defines
// `target` as a semantic name left `to` undefined for `state_entered`.
check('protocol says what state_entered\'s `to` is', sections[0].text.includes('**state id**'), true);

// --- refusals before anything has happened --------------------------------
await refuses('observe with no evidence', () => observe({}), 'nothing to interpret');
await refuses('transition with no evidence', () => transition({ capability: 'login' }), 'no transition to record');

// --- step 1: home ---------------------------------------------------------
// The opening capture carries the request the document loaded with, because the
// hooks are in place before the document runs. There is no earlier capture to diff
// it against, so this is the one step where the digest reports it as the entry
// document — the requests that got the run started are evidence in their own right,
// not a difference from something.
queue = [
  capture({
    url: 'http://x/',
    title: 'Home',
    hooks_installed_at: 'document_start',
    network: [{ method: 'GET', url: '/api/session', status: 200 }],
  }),
  capture({ url: 'http://x/login', title: 'Sign in' }),
];
await act('browser_open');
await refuses('transition before any state was read', () => transition({ capability: 'go_to_login' }), 'the first browser action establishes the entry state');
await refuses('observe rejects a state with no detection', () => observe({ page_type: 'home' }), 'no detection');
await refuses('observe rejects an unknown detection type', () => observe({ page_type: 'home', detection: [{ type: 'vibes' }] }), 'not one of');
await refuses('observe rejects an element with no semantic_purpose', () => observe({ page_type: 'home', detection: [{ type: 'url' }], elements: [{ role: 'link' }] }), 'semantic_purpose');
const s1 = await observe({ page_type: 'home', variant: 'anonymous', detection: [{ type: 'url' }], elements: [{ semantic_purpose: 'login_link', role: 'link' }] });
check('state recorded', [s1.graph.state.state_id, s1.graph.states_recorded], ['state_home_anonymous', 1]);

// --- how the run began ----------------------------------------------------
check('the first observation reports the entry document', [s1.entry_document.url, s1.entry_document.title], ['http://x/', 'Home']);
check('with the requests it loaded with', s1.entry_document.requests, [{ method: 'GET', url: '/api/session', status: 200 }]);
check('and whether the collector was there in time', [s1.hooks_installed_at, s1.entry_document.hooks_installed_at], ['document_start', 'document_start']);
check('there was no earlier capture, so there is no diff to confuse it with', s1.changed_since_previous_observation, null);
check('the marker is in the evidence, not only in the digest', JSON.parse(
  readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8').trim().split('\n')[0],
).capture.hooks_installed_at, 'document_start');

// --- step 2: navigate to login --------------------------------------------
await act('browser_click', { selector: '#login' });
await refuses('transition with no destination state read yet', () => transition({ capability: 'go_to_login' }), 'has no destination');
const s2 = await observe({ page_type: 'login', detection: [{ type: 'url' }] });
check('second state is a distinct state', [s2.graph.state.state_id, s2.graph.state.new], ['state_login', true]);
check('a later observation carries its own change, not the entry document again', [s2.entry_document, s2.changed_since_previous_observation.url], [null, ['http://x/', 'http://x/login']]);

// --- the transition itself ------------------------------------------------
const t1 = await transition({
  capability: 'go_to_login',
  capability_kind: 'navigation',
  effects: [{ type: 'navigation', to: 'state_login', observed: true }, { type: 'message', message: 'Welcome back' }],
  description: 'Open the sign-in page from the home page.',
});
check('derived endpoints', [t1.transition.from_state, t1.transition.to_state], ['state_home_anonymous', 'state_login']);
check('derived evidence pair', t1.transition.derived_from, { before: 'obs_0001', after: 'obs_0002' });
check('transition id minted', [t1.transition.transition_id, t1.transition.new], ['transition_go_to_login', true]);
check('capability minted', [t1.capability.capability_id, t1.capability.kind, t1.capability.new], ['cap_go_to_login', 'navigation', true]);
check('no chain break', t1.chain_break, null);
check('machinery saw the url change', t1.observed_change.url, ['http://x/', 'http://x/login']);
check('claimed message that was never seen is reported', t1.disagreements.map((w) => w.kind), ['claimed_message_not_seen']);
check('a disagreement is recorded, not just returned', JSON.parse(readFileSync(join(cwd, 'graph-run', 'transitions.jsonl'), 'utf8')).notes.map((w) => w.kind), ['claimed_message_not_seen']);

// --- refusals on a real transition ---------------------------------------
await refuses('unknown effect type', () => transition({ capability: 'go_to_login', effects: [{ type: 'teleport', to: 'x' }] }), 'is not one of');
await refuses('effect missing a required field', () => transition({ capability: 'go_to_login', effects: [{ type: 'value_changed', target: 'element_x' }] }), 'missing to');
await refuses('bad effect severity', () => transition({ capability: 'go_to_login', effects: [{ type: 'message', message: 'x', severity: 'catastrophic' }] }), 'severity');
await refuses('bad list operation', () => transition({ capability: 'go_to_login', effects: [{ type: 'list_changed', target: 'element_x', operation: 'shuffle' }] }), 'operation');
await refuses('bad assertion type', () => transition({ capability: 'go_to_login', assertions: [{ type: 'pretty_sure' }] }), 'assertion type');
await refuses('bad capability name', () => transition({ capability: 'Go To Login' }), 'snake_case');
await refuses('bad capability kind', () => transition({ capability: 'go_to_login', capability_kind: 'vibe' }), 'capability_kind');
await refuses('bad target id', () => transition({ capability: 'go_to_login', target: 'div#login' }), 'element_<semantic_purpose>');
await refuses('bad api id', () => transition({ capability: 'go_to_login', apis: ['/api/login'] }), 'api_<name>');
await refuses('effect contradicting the derived destination', () => transition({ capability: 'go_to_login', effects: [{ type: 'state_entered', to: 'state_home_anonymous' }] }), 'cannot end in two places');
// A refusal is only as good as the correction it suggests. `to_state` is derived — the model never
// passes it — so a message that leaves the reader to work out which of the two is wrong sends it
// back to a field it did not choose. Two live runs guessed here: one wrote the page_type, one the
// variant, and neither is a state.
await refuses(
  'the refusal says which side has to change',
  () => transition({ capability: 'go_to_login', effects: [{ type: 'state_entered', to: 'state_home_anonymous' }] }),
  'not the page_type and not the variant',
);
check('a refused transition records nothing', readFileSync(join(cwd, 'graph-run', 'transitions.jsonl'), 'utf8').trim().split('\n').length, 1);
check('a refused transition mints no capability', JSON.parse(readFileSync(join(cwd, 'graph-run', 'capabilities.jsonl'), 'utf8')).name, 'go_to_login');

// --- step 3: back to home, same capability as an edge that exists ---------
queue = [capture({ url: 'http://x/', title: 'Home' }), capture({ url: 'http://x/', title: 'Home' })];
await act('browser_navigate', { url: 'http://x/' });
await observe({ page_type: 'home', variant: 'anonymous', detection: [{ type: 'url' }] });
const t2 = await transition({ capability: 'go_to_login', capability_kind: 'navigation' });
check('reused capability', [t2.capability.capability_id, t2.capability.new], ['cap_go_to_login', false]);
check('same capability arriving elsewhere gets its own edge', [t2.transition.transition_id, t2.transition.new], ['transition_go_to_login_home_anonymous', true]);
check('walk is contiguous', t2.chain_break, null);
check('vocabulary note names the run-local near-duplicate first', (await transition({ capability: 'go_to_login_page' })).capability.vocabulary_notes.map((n) => n.vocabulary_name), ['go_to_login', 'login']);

// --- an eval is an action too --------------------------------------------
// `browser_eval` runs arbitrary JavaScript in the page, so it can change the page
// as thoroughly as a click. Left uncaptured, the step becomes a hole in the
// evidence chain and the reading after it describes a page nothing observed.
queue = [capture({ url: 'http://x/', title: 'Home' })];
await act('browser_eval', { expression: 'localStorage.setItem("draft", "1")' });
const observations = readFileSync(join(cwd, 'graph-run', 'observations.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
check('browser_eval is captured', observations[observations.length - 1].tool, 'browser_eval');
await refuses('a transition cannot skip the eval nobody read', () => transition({ capability: 'save_draft' }), 'has no destination');

// --- summary --------------------------------------------------------------
const report = await transition({});
check('omitting the capability only reports', [report.recorded, report.transition ?? null], [false, null]);
check('the report says where the walk stands', [report.walk.steps_walked, report.walk.transitions_recorded, report.walk.last_step.to_state], [3, 3, 'state_home_anonymous']);
check('the report lists the vocabulary', report.vocabulary, ['go_to_login', 'go_to_login_page']);
check('a partially supplied call is reported as ignored, not recorded', (await transition({ effects: [{ type: 'navigation', to: 'state_home_anonymous' }] })).note.includes('read and ignored: effects'), true);
check('file counts', (() => {
  const lines = (p) => readFileSync(join(cwd, 'graph-run', p), 'utf8').trim().split('\n').length;
  return [lines('observations.jsonl'), lines('states.jsonl'), lines('capabilities.jsonl'), lines('transitions.jsonl')];
})(), [4, 3, 2, 3]);

// --- the commit, through the same seam ------------------------------------
// The walk above is a real run — the store wrote it, not a fixture — so this is the end-to-end
// shape of the tool: it reads what the session recorded and reports a verdict. No application was
// declared in this suite's config, so the verdict is a refusal, and a refusal must arrive as a
// result rather than as an exception: the report is the product, and an agent that treats a
// blocked commit as a crash would lose it.
const verdict = await commit({});
check('the commit reads the run this session wrote', [verdict.counts.states.committed, verdict.counts.transitions.committed, verdict.counts.capabilities], [2, 3, 2]);
check('it knows which application it is about', verdict.application, null);
check('an undeclared application blocks the document', [verdict.committed, verdict.blocked_by.map((blocker) => blocker.code)], [false, ['application_not_declared']]);
check('a blocked commit still writes its report', verdict.report_path.endsWith('commit_report.json'), true);
check('a blocked commit writes no graph', verdict.graph_path, null);
check('the refusal names the setting to fix', verdict.blocked_by[0].detail.includes('application: {id, name}'), true);
check('and says what to do next', verdict.next.includes('No graph was written'), true);
check('the findings are summarised by severity', [verdict.warnings.errors, verdict.warnings.detail.length > 0], [0, true]);
check('the invariants travelled with it', verdict.invariants.filter((result) => result.severity === 'error' && !result.ok).length, 0);
check('the same run can be named explicitly', (await commit({ run_dir: 'graph-run' })).run_dir, join(cwd, 'graph-run'));
const forced = await commit({ force: true });
check('forcing writes the assembled document', existsSync(join(cwd, 'graph-run', 'graph.json')), true);
check('forcing does not make the verdict a pass', forced.committed, false);
await refuses('a directory that is not a run is refused', () => commit({ run_dir: 'nope' }), 'not an exploration run');

// --- the run directory is deleted mid-run ---------------------------------
// The worst case for a store, and the one a long-lived server invites: the directory
// the agent is still writing into is removed between two of its steps. What must not
// happen is the store failing the browser action it was recording — that action has
// already happened, and reporting it as a failure makes the model retry it against a
// page that has moved on. What must happen is a repaired directory, a log that admits
// what it lost, and a walk that never references evidence nobody can read.
const runDir = join(cwd, 'graph-run');
const manifest = readFileSync(join(runDir, 'run.json'), 'utf8');
queue = [capture({ url: 'http://x/cart', title: 'Cart' })];
const beforeDeletion = await act('browser_click', { selector: '#buy' });
check('the step before the deletion is recorded', beforeDeletion.isError, false);
rmSync(runDir, { recursive: true, force: true });

const across = await act('browser_click', { selector: '#buy' });
check('a browser action is not failed by the store that was recording it', across.isError, false);
check('the run directory is back, with run.json restored verbatim', readFileSync(join(runDir, 'run.json'), 'utf8'), manifest);
check('the id is not recycled: the log starts where the run is, not at obs_0001',
  readFileSync(join(runDir, 'observations.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).id), ['obs_0006']);

const repaired = await observe({ page_type: 'cart', detection: [{ type: 'url' }] });
check('a reading after the repair is recorded and minted fresh', [repaired.graph.state.state_id, repaired.graph.state.new], ['state_cart', true]);
check('the digest says the log lost ground', [repaired.graph.directory_recreations, repaired.graph.unwritten_records], [1, 0]);

// The step before the deletion is in the store's memory but not in the log, so a
// transition across that hole would carry a reference the commit cannot resolve — and
// the commit blocks the whole graph for one dangling reference. Refused here instead,
// where the model can do something about it.
await refuses('a transition across the hole is refused, naming the hole',
  () => transition({ capability: 'buy_item' }), 'the run directory had to be recreated');

queue = [capture({ url: 'http://x/thanks', title: 'Thanks' })];
await act('browser_click', { selector: '#buy' });
const resumed = await observe({ page_type: 'order_confirmation', detection: [{ type: 'url' }] });
const after = await transition({ capability: 'buy_item', effects: [{ type: 'navigation', to: 'state_order_confirmation' }] });
check('and the walk picks up again from the last step the log still has',
  [after.transition.from_state, after.transition.to_state, after.chain_break], ['state_cart', 'state_order_confirmation', null]);
check('the recreation is counted once, not once per step after it', [resumed.graph.directory_recreations, after.graph.directory_recreations], [1, 1]);
check('the capability minted after the repair is in the log the commit reads',
  readFileSync(join(runDir, 'capabilities.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).name), ['buy_item']);

// --- walking the same edge twice: the report has to survive its own verdict -
// Repeating a step is ordinary — a model re-checks a flow, a page is reloaded — and it leaves two
// candidates for one transition, the second of which is superseded. That row is a decision with no
// rejection to report, and it is exactly where the tool boundary broke: the projection copies a
// decision's fields straight out, a field that is *absent* rather than null is `undefined`, and the
// harness will not call `undefined` JSON. It does not hand back a report with a hole in it — it
// fails the whole `graph_commit` call, and its error
// — `value is not lossless JSON` — names neither the field nor the reason. The model sees a tool
// that stopped working and has nothing to read. Only a re-walk reaches that row, so the walk is
// repeated here rather than described.
queue = [capture({ url: 'http://x/cart', title: 'Cart' })];
await act('browser_click', { selector: '#back' });
const returned = await observe({ page_type: 'cart', detection: [{ type: 'url' }] });
const back = await transition({ capability: 'return_to_cart', capability_kind: 'navigation' });
check('a second visit to a state is a state, not a new one', [returned.graph.state.state_id, returned.graph.state.new, back.transition.to_state], ['state_cart', false, 'state_cart']);
queue = [capture({ url: 'http://x/thanks', title: 'Thanks' })];
await act('browser_click', { selector: '#buy' });
await observe({ page_type: 'order_confirmation', detection: [{ type: 'url' }] });
const again = await transition({
  capability: 'buy_item',
  capability_kind: 'navigation',
  effects: [{ type: 'navigation', to: 'state_order_confirmation' }],
});
check('the same edge walked twice is the same transition', [again.transition.transition_id, again.transition.new], ['transition_buy_item', false]);
check('and the tool says it reused the edge rather than minting one', again.transition.note.includes('already recorded'), true);
const rewalked = await commit({ force: true });
check('the second walk of one edge is superseded, not duplicated', rewalked.counts.transitions.superseded, 1);
check('and graph_commit still returns JSON', losslessPaths(rewalked), []);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
