// The correction: one walk, one step stated twice, and what the two documents make of it.
//
// The exploration protocol's fifth step promises that nothing a run records is retracted by
// committing, and it has exactly one exception — a step stated again out of the same two readings
// replaces the walk's own account of that step. 0.1.29 is the run where the exception was needed and
// three mechanisms worked against it:
//
//   * the recorder numbered the second statement as a second step of the walk and, because a
//     restatement names the state its step *started* from (never where the walk stands, since the
//     step it restates is the one that moved it), computed a `chain_break` at a step nobody had
//     walked twice;
//   * the commit ranked the candidates with the *older* first, so the withdrawn statement won and
//     the correction was filed as the loser — the graph kept the argument the run had taken back;
//   * the journey assembler read the same record as a jump back to a state the walk had left, so one
//     corrected step became a second, one-step journey: a walk the run never made, written into the
//     document as a fact.
//
// The result was that the correction did not take and the model was withheld by the very rule it was
// answering. This suite is that run: a walk makes the same mistake, states the step again, and the
// run commits twice — once before the correction and once after — because "did the correction take?"
// is a question about the run, not about either document on its own.
//
// It drives the seam `abm-commit.test.mjs` drives, for the same reason: the two documents have to be
// about a real walk, or the assertions below are assertions about a fixture.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from '../lib/capture.js';
import { apply, Config } from '../lib/index.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// --- the harness: the same seam, and an application that is declared ---------
const cwd = mkdtempSync(join(tmpdir(), 'gx-restatement-'));
const tools = new Map();
const handlers = new Map();
let queue = [];

const exec = {
  name: 'browser_open', arguments: { url: 'http://x/' }, token: 'tok', signal: undefined,
  agent: { options: { provider: 'p', model: 'm' }, session: { header: { cwd, id: 'session-restatement' } } },
};

const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    execute: async (call) => {
      if (call.name === 'browser_eval') {
        const expression = call.arguments?.expression;
        if (expression === SETTLE_EXPRESSION) {
          return { isError: false, value: { waited_ms: 0, quiet_ms: 250, idle_ms: 1000, budget_ms: 3000, changes: 0, in_flight: 0, timed_out: false, watched: true } };
        }
        if (expression !== CAPTURE_EXPRESSION) throw new Error('restatement.test: an unexpected browser_eval was dispatched');
        const value = queue.length > 1 ? queue.shift() : queue[0];
        return { isError: false, value };
      }
      return { isError: false, value: null };
    },
  },
  on: (name, handler) => handlers.set(name, handler),
  systemPrompt: { section: () => {} },
};
apply(ctx, Config({
  application: { id: 'app_shop', name: 'Shop', actors: [{ id: 'anonymous' }, { id: 'authenticated' }] },
}));

const capture = (over = {}) => ({ url: 'http://x/', title: 'T', headings: [], interactive: [], status: [], storage: {}, scroll: {}, network: [], console: [], page_errors: [], ...over });
const act = (name, args = {}) => handlers.get('tools/execute')({ ...exec, name, arguments: args }, async () => ({ isError: false, value: null }));
const observe = (args) => tools.get('graph_observe').execute(args, exec);
const transition = (args) => tools.get('graph_transition').execute(args, exec);
const commit = (args) => tools.get('graph_commit').execute(args, exec);

const logPath = (name) => join(cwd, 'graph-run', name);
const readDoc = (name) => (existsSync(logPath(name)) ? JSON.parse(readFileSync(logPath(name), 'utf8')) : null);
const logLines = (name) => (existsSync(logPath(name))
  ? readFileSync(logPath(name), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  : []);

// --- the walk, up to the step that is recorded wrongly ----------------------
queue = [
  capture({ url: 'http://x/', title: 'Home' }),
  capture({ url: 'http://x/login', title: 'Sign in' }),
  capture({ url: 'http://x/dashboard', title: 'Dashboard' }),
];
await act('browser_open');
await observe({
  page_type: 'home',
  variant: 'anonymous',
  detection: [{ type: 'url' }],
  elements: [{ semantic_purpose: 'login_link', role: 'link', name: 'Sign in' }],
});
await act('browser_click', { selector: '#login' });
await observe({
  page_type: 'login',
  detection: [{ type: 'url' }],
  elements: [
    { semantic_purpose: 'email_input', role: 'textbox', name: 'Email' },
    { semantic_purpose: 'submit_button', role: 'button', name: 'Sign in' },
  ],
});
const loginStateId = logLines('states.jsonl').filter((record) => record.kind === 'state').at(-1).state_id;

// The mistake, and it is the 0.1.29 mistake in one argument: the model attaches the value it typed
// to the edge of the call that submitted the form. The two records that run left are
// `transition_submit_login` with `arguments.email = "test@example.com"` and then without it, and the
// argument is what `P5/unobserved_argument` refuses: a value the model typed is not a value the run
// observed. Nothing in this walk reports that value — the effect says `[set]`, because a field that
// was set and never read back is recorded as set rather than as its value.
//
// The behaviour declares `email` as an input in the same call as its first step, so the realisation's
// `{{email}}` is the bound-parameter shape rather than an unbound one: `[set]` and `{{param}}` are the
// two spellings of a reference, and only one of them is a claim about what the page showed.
const fill = await transition({
  capability: 'fill_login_email',
  capability_behaviour: 'login',
  capability_kind: 'composite',
  capability_input: { email: { type: 'string', required: true } },
  // The value the call was walked with, on the call's own edge. This is where the 0.1.29 log had it
  // too, and it is not the argument `P5` refuses: that one is on the call that submitted the form.
  arguments: { email: 'test@example.com' },
  target: 'element_email_input',
  feature: 'authentication',
  description: 'Fill in the sign-in form',
  effects: [{ type: 'state_entered', to: loginStateId, observed: true }, { type: 'value_changed', target: 'email_input', to: '[set]' }],
  realization: {
    action: 'fill',
    element: 'element_email_input',
    value: '{{email}}',
    purpose: 'enter_credentials',
    effects: [{ type: 'state_entered', to: loginStateId, observed: true }, { type: 'value_changed', target: 'email_input', to: '[set]' }],
  },
});
await act('browser_click', { selector: '#submit' });
await observe({ page_type: 'dashboard', variant: 'authenticated', detection: [{ type: 'url' }] });
const dashboardStateId = logLines('states.jsonl').filter((record) => record.kind === 'state').at(-1).state_id;

// The step whose account is wrong, and it is deliberately the *last* call of the behaviour: that is
// the call the collapse into one move leaves standing, so it is the only one of the two whose
// `arguments` ever reach the model — and therefore the only one `P5` can be asked about. The 0.1.29
// records are exactly this shape.
const submitArgs = (extra = {}) => ({
  capability: 'submit_login',
  capability_behaviour: 'login',
  target: 'element_submit_button',
  feature: 'authentication',
  description: 'Submit the sign-in form',
  effects: [{ type: 'state_entered', to: dashboardStateId, observed: true }],
  realization: {
    action: 'click',
    element: 'element_submit_button',
    purpose: 'submit',
    effects: [{ type: 'state_entered', to: dashboardStateId, observed: true }],
  },
  ...extra,
});
const submit = await transition(submitArgs({ arguments: { email: 'test@example.com' } }));
check('the step is recorded with the value the model typed',
  [submit.transition.restatement, submit.transition.new, logLines('transitions.jsonl').at(-1).action.arguments.email],
  [false, true, 'test@example.com']);

// --- the commit that refuses it, on the rule the correction answers ---------
const refused = await commit({});
const refusedReport = JSON.parse(readFileSync(logPath('commit_report.json'), 'utf8'));
const unobserved = refusedReport.profile.findings.filter((finding) => finding.code === 'unobserved_argument');
check('the commit refuses the value the model typed, on the edge the behaviour collapsed to',
  [refused.committed, unobserved.length, unobserved[0]?.rule, unobserved[0]?.severity, unobserved[0]?.subject],
  [true, 1, 'P5', 'error', 'transition_submit_login']);
check('and the model is withheld rather than annotated, because nothing downstream reads it',
  [refused.model_path, refusedReport.documents.model.written], [null, false]);

// --- the correction: the same step, out of the same two readings ------------
// This is the whole protocol bullet: call again for the step just taken, with the same capability
// and the same two readings, and drop the claim. Nothing else about the call changes — the effects,
// the realisation and the description are the walk's account of the step, and the account is what is
// being restated.
const before = submit.graph.steps_walked;
const again = await transition(submitArgs());
const correctedLog = logLines('transitions.jsonl');
check('a step stated again reuses its edge rather than minting one',
  [again.transition.transition_id, again.transition.new, again.transition.restatement],
  ['transition_submit_login', false, true]);
check('and is the same step by the step\'s own account of itself: one edge, two readings',
  [again.transition.derived_from, submit.transition.derived_from], [submit.transition.derived_from, submit.transition.derived_from]);
check('and moves the walk nowhere',
  [again.graph.steps_walked, again.graph.transitions_recorded], [before, submit.graph.transitions_recorded]);
check('and reports no chain break, because the walk did not move',
  [again.chain_break, again.chain_break_note], [null, null]);
check('and the tool says the account was replaced rather than the step re-recorded',
  [again.transition.note.includes('stated it again'), again.transition.note.includes('appended the step to the walk')],
  [true, false]);
check('the realisation is not re-filed as a new step of the behaviour either',
  [again.realization.position, again.realization.note.includes('the step keeps its position')], [1, true]);
// The log is append-only, and that is what makes the exception an exception rather than a retraction:
// the statement the walk withdrew is still there, and a reader of the log can see both the mistake and
// the correction. What changed is which one the walk *holds*.
check('the statement the walk replaced is still in the log, which is append-only',
  correctedLog.map((record) => [record.restatement, record.action?.arguments?.email ?? null]),
  [[false, 'test@example.com'], [false, 'test@example.com'], [true, null]]);

// --- the commit that takes the correction ----------------------------------
const verdict = await commit({});
const report = JSON.parse(readFileSync(logPath('commit_report.json'), 'utf8'));
const graph = readDoc('graph.json');
const model = readDoc('application-model.json');
const submitEdge = (graph?.transitions ?? []).find((edge) => edge.id === 'transition_submit_login');
check('the correction takes: the model is written, and nothing in either document is in error',
  [verdict.model_path, report.profile.errors, model !== null],
  [join(cwd, 'graph-run', 'application-model.json'), 0, true]);
// The three mechanisms, each asked the question it was wrong about before. `superseded: 1` is the
// commit telling the truth about the two records: one is the step, the other is the account of it the
// walk replaced, and neither is thrown away.
check('the two statements of one step are one step, and the loser is named as a restatement',
  [report.transitions, report.decisions.find((decision) => decision.decision === 'superseded')?.reason],
  [{ candidates: 3, distinct: 2, committed: 2, rejected: 0, superseded: 1 },
    'the walk stated this step again out of the same two readings; one step has one account, and the later one is the walk\u2019s']);
check('and the edge the graph kept is the corrected one',
  [submitEdge?.action?.arguments ?? null, submitEdge?.action?.target], [null, 'element_submit_button']);
// The correction reaches the edge, and the value the call was walked with does not go with it: it is
// on the edge of the call that typed it, which is where the walk recorded it. What must not survive
// is the claim about the *invocation's* edge — and the journey is the second door into that claim,
// because a turn names an edge and the turn here names the corrected one. A turn saying the
// invocation carried an `email` while the edge it names carries none is the same claim back again,
// one document further along, and a reader of the model has no way to tell it from the claim the
// graph just refused.
const fillEdge = (graph?.transitions ?? []).find((edge) => edge.id === 'transition_fill_login_email');
check('the value the call was walked with is still on the call\'s own edge',
  [fillEdge?.action?.arguments?.email ?? null, submitEdge?.action?.arguments ?? null],
  ['test@example.com', null]);
check('and the turn that names the corrected edge carries that edge\'s arguments, not the call\'s',
  model?.journeys?.[0]?.steps?.map((step) => [step.transition, step.arguments ?? null]),
  [['transition_submit_login', null]]);
check('and a corrected step does not cut the walk, so there is one journey and no break',
  [report.journeys.assembled, report.journeys.breaks, model?.journeys?.length], [1, 0, 1]);
check('with the behaviour still performed by the two calls the walk made',
  model?.behaviors?.find((behavior) => behavior.name === 'login')?.realization?.map((step) => step.action),
  ['fill', 'click']);

// --- the same log, read by a commit that was not there ---------------------
// Everything above is a commit reading a log this process just wrote, and the field on the record is
// the recorder's own note about what it did. That is not the case the defect arrived in. The run it
// arrived in was recorded *before* the rule existed, so its second statement was written as an
// ordinary step with no `restatement` on it — and the run that produced the defect is a directory on
// disk, not a premise this test may assume away: whatever the commit makes of a log written by an
// older version, the evidence is already there.
//
// So the field comes off the log and the commit is asked the same question again. It has to answer it
// from the records — one edge, one pair of readings — because that is all the log is, and a commit
// that needs the recorder's note is a commit that cannot read the run it exists to fix.
const stripped = logLines('transitions.jsonl').map((record) => {
  const { restatement, ...rest } = record;
  return rest;
});
writeFileSync(logPath('transitions.jsonl'), stripped.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
// The premise, asserted rather than assumed: nothing left in the log says which record is the
// restatement, so anything below that turns on it was derived. Without this the block could pass on a
// log that still carried the field and prove nothing.
check('the log the older version wrote carries no field naming the restatement',
  logLines('transitions.jsonl').map((record) => [record.restatement, record.action?.arguments?.email ?? null]),
  [[undefined, 'test@example.com'], [undefined, 'test@example.com'], [undefined, null]]);

const reread = await commit({ force: true });
const rereadReport = JSON.parse(readFileSync(logPath('commit_report.json'), 'utf8'));
const rereadGraph = readDoc('graph.json');
const rereadModel = readDoc('application-model.json');
const rereadEdge = (rereadGraph?.transitions ?? []).find((edge) => edge.id === 'transition_submit_login');
check('and the commit still takes the correction, from the records alone',
  [reread.model_path !== null, rereadReport.profile.errors, rereadEdge?.action?.arguments ?? null],
  [true, 0, null]);
check('and still knows the loser was the walk\'s own account of the step',
  [rereadReport.decisions.find((decision) => decision.decision === 'superseded')?.reason,
    rereadReport.profile.findings.filter((finding) => finding.code === 'unobserved_argument').length],
  ['the walk stated this step again out of the same two readings; one step has one account, and the later one is the walk\u2019s', 0]);
check('and one corrected step is still one walk, one journey and no break',
  [rereadReport.journeys.assembled, rereadReport.journeys.breaks, rereadModel?.journeys?.length,
    rereadReport.transitions.superseded],
  [1, 0, 1, 1]);

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log('\nALL PASSED');
