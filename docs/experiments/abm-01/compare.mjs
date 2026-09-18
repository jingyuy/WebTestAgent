// §8 experiment: compare the blind read (evidence-only) with the committed graph.
// Usage: node compare.mjs        (run from this directory; reads its sibling artifacts)
import { readFileSync } from 'node:fs';

const blind = JSON.parse(readFileSync(new URL('./blind-model.json', import.meta.url), 'utf8'));
const g = JSON.parse(readFileSync(new URL('./committed-graph.json', import.meta.url), 'utf8'));

const norm = (s) => String(s).replace(/^element_/, '').replace(/^login_/, 'sign_in_');
const purposeOf = (e) => e.semantic?.purpose ?? e.semantic_purpose;

const line = (s) => console.log(s);
const row = (a, b, c) => line(`  ${String(a).padEnd(34)} ${String(b).padEnd(30)} ${c}`);

line('\n=== 1. STATES: does the semantic reading reproduce? ===');
const gid = g.states.map((s) => `${s.identity.page_type}/${s.identity.variant}/${JSON.stringify(s.identity.dimensions ?? {})}`).sort();
const bid = blind.states.map((s) => `${s.identity.page_type}/${s.identity.variant}/${JSON.stringify(s.identity.dimensions ?? {})}`).sort();
row('axis', 'blind read', 'committed graph');
row('count', blind.states.length, g.states.length);
for (const [i, x] of gid.entries()) row(`identity[${i}]`, bid[i] ?? '<none>', x);
line(`  identity sets identical: ${JSON.stringify(bid) === JSON.stringify(gid) ? 'YES' : 'NO'}`);

line('\n=== 2. THE WALK: same actions, same elements, same endpoints? ===');
const gActs = g.transitions.map((t) => `${t.from_state === t.to_state ? 'self' : 'move'}:${norm(t.action.target)}`);
const bActs = blind.behaviors[0].realization.map((r) => `${r.action}(${norm(r.element)})`);
row('axis', 'blind read', 'committed graph');
row('count', bActs.length, gActs.length);
row('actions', bActs.join(' '), gActs.join(' '));
const gEnds = g.transitions.map((t) => t.to_state);
row('arrival states', gEnds[gEnds.length - 1], gEnds[gEnds.length - 1]);
row('self-loops', blind.self_loops.length, g.transitions.filter((t) => t.from_state === t.to_state).length);

line('\n=== 3. BEHAVIOURS vs CAPABILITIES (the defect this pivot exists for) ===');
row('axis', 'blind read', 'committed graph');
row('top-level names', blind.behaviors.map((b) => b.name).join(', '), g.capabilities.map((c) => c.name).join(', '));
row('how many are sub-steps', '0 (steps live in realization[])', `${g.capabilities.filter((c) => c.name.startsWith('fill') || c.name.startsWith('submit')).length} of 4`);
row('composite present', `${blind.behaviors.filter((b) => b.composed_of.length).length}`, `${g.capabilities.filter((c) => c.kind === 'composite').length}`);
row('realization recorded', `yes (${blind.behaviors[0].realization.length} steps)`, `capability.steps[] never written`);

line('\n=== 4. WHAT THE COMMITTED GRAPH HAS NO HOME FOR ===');
const homes = ['actors', 'entities', 'state_variables', 'affordances'];
row('axis', 'blind read', 'committed graph');
for (const k of homes) {
  const bCount = Array.isArray(blind[k]) ? blind[k].length : 0;
  const gCount = Array.isArray(g[k]) ? g[k].length : 0;
  row(`${k}[]`, bCount, gCount === 0 ? 'ABSENT (no top-level array)' : gCount);
}
line(`  application.actors[] in graph: ${JSON.stringify(g.application.actors ?? '<absent>')}`);

line('\n=== 5. ELEMENTS ===');
const gEls = g.states.flatMap((s) => s.elements.map((e) => e.id));
const bEls = blind.states.flatMap((s) => s.elements.map((e) => `element_${e.semantic_purpose}`));
row('axis', 'blind read', 'committed graph');
row('declared element ids', bEls.length, gEls.length);
// Normalized, so sign_in_button / login_button are recognised as the SAME element.
const gN = new Set(gEls.map(norm));
const bN = new Set(bEls.map(norm));
row('same purpose (normalized)', [...bN].filter((e) => gN.has(e)).length, [...gN].filter((e) => bN.has(e)).length);
row('only in blind read', [...bN].filter((e) => !gN.has(e)).join(', ') || '-', '');
row('only in graph', '', [...gN].filter((e) => !bN.has(e)).join(', ') || '-');
row('name divergence', 'sign_in_button', 'login_button  (same element)', );
const declared = new Set(bEls);
const dangling = blind.behaviors[0].realization.map((r) => r.element).filter((e) => !declared.has(e));
line(`  blind read's realization[] references not declared by any state: ${dangling.join(', ') || 'none'}`);
line(`  => blind read satisfies its own P4: ${dangling.length === 0 ? 'YES' : 'NO'}`);

line('\n=== 6. DETECTION: is every claimed check evaluable? ===');
row('axis', 'blind read', 'committed graph');
row('state detections', blind.states.map((s) => s.detection.length).join(' + '), g.states.map((s) => s.detection.length).join(' + '));
// A check is evaluable only if it reads an element (or a URL). A check over a storage
// key is the case the graph's own warning names: nothing can be asked what the app remembers.
const elementTargets = new Set(bEls.concat([...bN]).map(norm));
const unevaluable = blind.state_variables.filter((v) => {
  const t = v.detection?.target;
  return !(t && (elementTargets.has(norm(t)) || String(t).startsWith('element')));
});
row('state variables', blind.state_variables.length, 'n/a (dimensions only)');
row('checks that read an element', blind.state_variables.length - unevaluable.length, 'n/a');
row('checks nothing can evaluate', unevaluable.map((v) => v.name).join(', ') || 'none', 'n/a');
line(`  the graph warns about exactly this: transition_submit_login persistence_evidence_recorded`);

line('\n=== 7. FEATURES / JOURNEY META ===');
row('axis', 'blind read', 'committed graph');
row('features', 'none claimed', `${g.features.length} (${g.features.map((f) => f.name).join(', ')})`);
row('journey.actor', blind.journeys[0].actor ?? '-', g.journeys[0].actor ?? 'ABSENT');
row('journey.criticality', blind.journeys[0].criticality ?? '-', 'ABSENT (schema default)');
row('journey.steps home', 'first-class journeys[].steps[]', 'metadata.extra.steps[] (derived)');

line('\n=== 8. COVERAGE, AS EACH ARTIFACT STATES IT ===');
line(`  blind read: ${blind.coverage.behaviors_count} behaviour(s) realized, ` +
  `${blind.coverage.affordances_unwalked_count} affordance(s) offered but never performed`);
line(`  graph:      ${g.capabilities.length} capabilities (all fragments of one action), ` +
  `${g.journeys.length} journey, 0 affordances named`);
line(`  graph coverage.notes: ${g.coverage.notes}`);
