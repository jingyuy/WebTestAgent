/**
 * The protocol's own claims, read off the section the harness is actually given.
 *
 * Phase 3 of the ABM pivot rewrote what this plugin tells the model to look for: the reading is
 * understand → name → infer → validate → walk, a per-element interaction is recorded as a *step of
 * a behaviour*, and a surface's unused controls are recorded as affordances. None of that is
 * enforced by a tool — the protocol is the only thing that asks for it — so the only way it can be
 * held down is by reading the text the model is handed and asserting the sentences that do the
 * asking. D8: *a rule nothing enforces is not a rule the schema has; a shared rule needs a test.*
 *
 * What this suite deliberately does not do is snapshot the section. A snapshot passes on the day it
 * is taken and fails on every honest edit. What is asserted instead is: the sentences this phase is
 * about, the refusal sentences that had to survive it **verbatim**, the order of the reading, and
 * one seam that is worth more than either — that every argument a recording tool declares is named
 * in the loop the model reads, so an argument cannot be added to a tool and go unmentioned.
 *
 * The section is rendered by `apply`, not by calling `protocolText` by hand, because the thing that
 * has to be true is true of the assembled section: the tool names in it are the names the tools were
 * registered with. The final block renders it with different names to prove that they are, in fact,
 * substituted rather than spelled out.
 */

import { apply, Config } from '../lib/index.js';
import { protocolText } from '../lib/protocol.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};
// The section is wrapped prose, and a sentence is a sentence however the line happens to break, so
// every match below is made against the text with its whitespace collapsed. A needle written as one
// line therefore matches a sentence the source wrapped — which is the whole point of asking about
// sentences rather than about lines.
const flat = (value) => String(value).replace(/\s+/g, ' ');
const has = (label, haystack, needle) => {
  if (!flat(haystack).includes(flat(needle))) { fails++; console.log('FAIL', label, '\n  missing ', JSON.stringify(needle)); }
  else console.log('ok  ', label);
};
const hasNot = (label, haystack, needle) => {
  if (flat(haystack).includes(flat(needle))) { fails++; console.log('FAIL', label, '\n  present ', JSON.stringify(needle)); }
  else console.log('ok  ', label);
};
const order = (label, haystack, first, second) => {
  const a = flat(haystack).indexOf(flat(first));
  const b = flat(haystack).indexOf(flat(second));
  if (a < 0 || b < 0 || a >= b) {
    fails++;
    console.log('FAIL', label, `\n  ${JSON.stringify(first)} at ${a}, ${JSON.stringify(second)} at ${b}`);
  } else console.log('ok  ', label);
};

// --- the section the harness is given -------------------------------------
const config = Config({});
const tools = new Map();
const sections = [];
const ctx = {
  tools: {
    register: (tool) => tools.set(tool.name, tool),
    execute: async () => ({ isError: false, value: null }),
  },
  on: () => {},
  systemPrompt: { section: (section) => sections.push(section) },
};
apply(ctx, config);

const text = sections[0]?.text ?? '';

check('one protocol section, contributed where it has always been',
  sections.map((section) => [section.name, section.order]),
  [['graph:exploration-protocol', 150]]);
check('and it is the protocol module text, rendered from this config',
  text, protocolText({
    runDirName: config.runDirName,
    observeTool: config.observeTool,
    transitionTool: config.transitionTool,
    commitTool: config.commitTool,
    generateTool: config.generateTool,
    maxSteps: config.maxSteps ?? null,
  }));
check('and the tool names in it are the names the tools were registered with',
  ['graph_observe', 'graph_transition', 'graph_commit', 'graph_test'].filter((name) => !text.includes(name)),
  []);

// --- the reading comes before the walk ------------------------------------
// §5 of the pivot: reorder the procedure to understand → name → infer → validate → walk. A walk
// that starts at step 1 is a transcript; the point of the phase is that the vocabulary is decided
// before the first click, because a name chosen while clicking is a name chosen for a control.
has('the reading is named before the walk', text, 'Understand the application before you walk it');
order('and the reading comes before the loop that records it',
  text, 'Understand the application before you walk it', 'For every step:');
has('the reading asks what the application is', text, 'What application is this, and who acts on it?');
has('and asks which actor, and what the application remembers',
  text, 'Which actor, and what does the application remember?');
has('and asks for the behaviours by name before the walk',
  text, 'What are the behaviours?');
has('and asks what would prove each one', text, 'What would prove each one?');
has('and only then walks', text, 'Then walk it');
// An instruction to name entities and state variables is only actionable if it names where they
// are recorded: no tool declares an entity, so they are what `dimensions`, `effects` and the
// digest's own `state_variables` add up to.
has('the actor/entity/variable question is grounded in what a tool accepts', text, '`dimensions`');
has('and in the digest\'s own state variables', text, '`state_variables`');
has('and in the effects of a step', text, 'your `effects`');

// --- D3: a per-element interaction is a step ------------------------------
// Before this phase the protocol offered two readings of one call — "record both, with
// `capability_kind: composite` on the one that is the behaviour" — and a live run took the first
// one and reported a sign-in as three behaviours. The default is now the step, and the tool that
// attaches it is named in the same breath.
has('a per-element interaction is the default thing a call does',
  text, 'is the *default* thing a call does');
has('and the step is attached to its behaviour by name', text, '`capability_behaviour`');
has('and the call that attaches it carries the realisation', text, '`realization`');
has('and a call with no behaviour claims to be one', text, 'claims to *be* a behaviour');
has('and the one-click case is named as the exception', text, '`apply_coupon` is one click');
has('and the verb is the schema\'s, not the capability\'s name',
  text, 'the capability\'s name is not the verb');
has('and the step\'s purpose is asked for', text, '`purpose` is the step\'s part in the behaviour');
hasNot('the old classification instruction is gone', text, 'capability_kind: composite');
hasNot('and so is the clause that called a composite the behaviour',
  text, 'A **composite** is the behaviour a user would ask');
hasNot('and the sentence that framed the step as the exception is gone',
  text, 'One of those notes means the opposite');
has('a behaviour is not renamed after one of its steps',
  text, 'not a collision to resolve but the shape a behaviour and its steps are supposed to have');
has('`capability_composed_of` keeps its own meaning: behaviours made of behaviours',
  text, 'never for the interactions that perform one');

// --- D5: a step, a behaviour and an edge are three things -----------------
has('a step is one interaction with one control',
  text, 'a **step** is one interaction with one control');
has('a behaviour is what a user asks for',
  text, 'a **behaviour** is what a user asks for by that name');
has('and an edge is one behaviour applied between two states',
  text, 'an **edge** is one behaviour applied between two states');
has('three calls in one sign-in are three steps and one edge',
  text, 'three steps, one behaviour and one edge');
has('the edge is recorded once, when the behaviour completes',
  text, 'recorded once, when the behaviour completes');
has('and it starts where the behaviour was asked for',
  text, 'it starts where the behaviour was asked for');

// --- D6: what the surface offers and the walk does not use ----------------
has('an unused control is an affordance', text, '`affordances`');
has('and the sentence says what recording one buys',
  text, 'the only way the model can say what the application *can* do and this walk did **not**');
has('and it is a claim about a surface, so it is made on the surface',
  text, 'made while the surface is on screen and it cannot be made later');
has('and the element must be one this reading declares',
  text, 'the element must be one this reading declares in `elements`');
has('and the walk is told the affordance retires when it is performed',
  text, 'The first committed step that performs one retires it');
has('and it is not a coverage note', text, 'It is not a coverage note');
// `graph_observe` refuses `confidence` by name, so the affordance bullet must not invite one. The
// bullet is read on its own — from `affordances` to the next field — rather than the whole section,
// because `confidence` is named elsewhere in it and legitimately so.
const bulletStart = flat(text).indexOf('- `affordances`');
const bulletEnd = flat(text).indexOf('- `summary`', bulletStart);
check('both ends of the affordance bullet were found',
  [bulletStart > 0, bulletEnd > bulletStart], [true, true]);
const affordanceBullet = flat(text).slice(bulletStart, bulletEnd);
hasNot('an affordance is not given a confidence', affordanceBullet, 'confidence');
has('an affordance names an element', affordanceBullet, '"element"');
has('and the behaviour it would perform', affordanceBullet, '"expected_behavior"');

// --- the grounding paragraph ----------------------------------------------
has('a behaviour with no evidence is a hallucination',
  text, 'A behaviour with no evidence behind it is a hallucination');
has('and `confidence` is named as how grounded a claim is',
  text, '`confidence` is the honest report of how well grounded it is');
has('and the correction is to name the basis or drop the claim',
  text, 'name the basis, or leave the claim out');
has('and writing something down verifies nothing',
  text, 'Nothing becomes verified by being written down');

// --- the commit writes both documents ------------------------------------
// Phase 2 made the commit write `application-model.json` beside `graph.json`; the protocol is where
// the model learns that the second document exists, and that a model rule withholds the model
// rather than blocking the run.
has('the commit is said to write the graph', text, '`graph.json`');
has('and the application model beside it', text, '`application-model.json`');
has('and the two verdicts are kept apart',
  text, 'a rule about the graph blocks the run, and a rule about the model withholds the model');

// --- the refusal sentences, verbatim --------------------------------------
// §5 of the pivot: keep every existing refusal sentence. Each one below is a live-run failure mode
// that was paid for once, and the phase that rewrote the protocol around them is exactly the phase
// most likely to have dropped one while rearranging the paragraphs.
const SURVIVING = [
  'A negative result is a result.',
  'Let the commit refuse.',
  'never re-record a step differently just to make the commit pass',
  'Two states must differ in `page_type`, `variant` or `dimensions`.',
  'a walk that mints a state per keystroke reports a two-screen app as a dozen states',
  'Read the app\'s own words.',
  'Never write a credential into the graph.',
  'so a detection asserting one can never hold',
  'Confidence, not decoration, is what the graph is for.',
  'is the only way states reach the graph.',
  '`browser_eval` is an action, not a look.',
  'A reading taken before an action is not evidence of that action.',
  'needs the step before it to have been read too.',
  'The first action of a run is a step, not a transition.',
  'The tool refuses the first one rather than inventing an entry state for it.',
];
for (const sentence of SURVIVING) has(`refusal survives: ${JSON.stringify(sentence.slice(0, 46))}`, text, sentence);

// --- the seam: an argument cannot be declared and never mentioned ----------
// The protocol is the loop, and the tools declare what the loop is allowed to say. A new argument
// that the loop never names is an argument the model will not use; this is the check that makes
// adding one a decision rather than an omission.
const OBSERVE = ['page_type', 'variant', 'dimensions', 'summary', 'elements', 'detection', 'affordances', 'confidence'];
const declaredObserve = Object.keys(tools.get('graph_observe')?.parameters?.properties ?? {});
// The list above is the tool's declaration as this phase leaves it, asserted rather than assumed:
// an argument renamed, or added, without this list and the loop following is an argument the model
// never sees. `capability_kind` is the one that went the other way — the protocol stopped asking the
// model to classify, so the argument is real and unmentioned on purpose, and it is listed below.
check('`graph_observe` declares the arguments the loop describes', declaredObserve, OBSERVE);
check('and every one of them is named in the loop',
  declaredObserve.filter((name) => !text.includes(name)), []);
// Arguments deliberately left to the tool's own description, each with a reason:
//   capability_kind      — Phase 3 stopped asking the model to classify: a step is a step because it
//                          is attached to a behaviour, and a behaviour made of behaviours is
//                          `capability_composed_of`.
//   capability_input     — the signature, which the tool description argues with the digest's forms.
//   capability_output    — the ABM's; the graph has no room for it.
//   apis, assertions,
//   preconditions        — refinements of one call rather than parts of the loop.
//   description          — prose about the capability.
const TRANSITION_OFF_THE_LOOP = new Set([
  'capability_kind', 'capability_input', 'capability_output', 'apis', 'assertions', 'preconditions', 'description',
]);
const declared = Object.keys(tools.get('graph_transition')?.parameters?.properties ?? {});
check('and `graph_transition`\'s arguments are mentioned or deliberately exempt',
  declared.filter((name) => !text.includes(name) && !TRANSITION_OFF_THE_LOOP.has(name)), []);
check('with no exemption left behind by a rename',
  [...TRANSITION_OFF_THE_LOOP].filter((name) => !declared.includes(name)), []);

// --- the tool names are substitutions, not spellings ----------------------
// `apply` passes its configured names into the text, and every path in the protocol that tells the
// model to call a tool goes through one of them. If a name were ever written out by hand, a profile
// that renamed a tool would be handed a protocol describing a tool it does not have.
const renamed = protocolText({
  runDirName: 'somewhere-else', observeTool: 'observe_x', transitionTool: 'transition_x',
  commitTool: 'commit_x', generateTool: 'generate_x', maxSteps: 42,
});
check('a renamed tool set is what the text says',
  ['observe_x', 'transition_x', 'commit_x', 'generate_x'].filter((name) => !renamed.includes(name)), []);
check('and no default name survives in it',
  ['graph_observe', 'graph_transition', 'graph_commit', 'graph_test'].filter((name) => renamed.includes(name)), []);
has('the run directory is substituted too', renamed, 'somewhere-else');
has('and so is the step budget', renamed, '42');
hasNot('and the previous run directory is gone with it', renamed, 'graph-run');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
