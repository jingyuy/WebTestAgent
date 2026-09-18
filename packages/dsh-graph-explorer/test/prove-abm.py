#!/usr/bin/env python3
"""Break one Phase-1, Phase-2 or Phase-3 rule at a time and check the suite notices.

Each case: an exact string in a source file, the edit that removes the rule, and the suite that has
to fail. A rule whose removal leaves the suite green is a rule nobody is testing — and Phase 1's
rules are the ones most likely to rot quietly, because every one of them is about a claim that ends
up in the *log* rather than in `graph.json`: nothing downstream fails when a recording rule is
deleted, the run simply claims less and looks cleaner for it.

Phase 2's cases are different in kind and are listed separately: there the artifact is a *second
document*, and the way to earn its acceptance without earning it is to write less of it — an empty
model is schema-valid and has no findings. So each Phase-2 case removes one rule that the two
documents owe each other and checks that `test/abm-commit.test.mjs` notices.

Phase 3's artifact is neither a document nor a log: it is a *sentence*. No tool can require a
behaviour-first reading — the tool that records a step takes the same call whichever one it was —
so the only thing holding the rule down is the text the model is handed. Each case below breaks one
sentence that asks for it and checks that `test/protocol.test.mjs` notices, including the case that
puts the previous version's clause *back*: a rewrite that leaves the old instruction available has
not rewritten anything.

Same protocol as `test/prove-generate.py`: break the rule, not a clause the code already treats as
equivalent. Restores every file it touches, including on the exception path, and leaves the tree
byte-identical.

Usage: python3 test/prove-abm.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

CASES = [
    # --- the realisation, and what it is not ---------------------------------
    {
        # The whole point of D14: the graph's `steps[]` is folded from the log's `realization_step`
        # records, and a graph with no `steps[]` is a vocabulary with no verbs.
        'rule': 'a recorded step is folded into the capability as the schema\'s steps[]',
        'file': 'lib/commit.js',
        'old': "      ...(realizationSteps.length ? { steps: realizationSteps } : {}),",
        'new': "      ...(realizationSteps.length ? { steps: [] } : {}),",
        'suite': 'test/realization.test.mjs',
    },
    {
        # The step-of relation is recorded BESIDE the composition, not instead of it (D14): a
        # realisation record that also became a capability would be the demotion happening in the
        # wrong phase, and it would show up as a fourth capability.
        'rule': 'a realisation record is not committed as a capability of its own',
        'file': 'lib/commit.js',
        'old': "  const canonicalCapabilities = capabilities.filter((record) => record.kind !== 'capability_composition' && record.kind !== 'realization_step');",
        'new': "  const canonicalCapabilities = capabilities.filter((record) => record.kind !== 'capability_composition');",
        'suite': 'test/realization.test.mjs',
    },
    {
        # A step that is not a step is dropped and reported, never carried into the document.
        'rule': 'a recorded step the schema cannot hold is dropped and reported',
        'file': 'lib/commit.js',
        'old': "        code: 'realization_step_not_a_step',",
        'new': "        code: 'realization_step_not_a_step_REMOVED',",
        'suite': 'test/realization.test.mjs',
    },
    # --- the two spellings, which is what the suite exists for ----------------
    {
        # A step's `element` is the element ID. Remove the check and the bare purpose is accepted,
        # the step names a control nothing can resolve, and a generated test cannot find the field.
        'rule': 'a step\'s element is an element ID this run declared, not a bare purpose',
        'file': 'lib/index.js',
        'old': "            if (realizationStep?.element !== undefined && !declaredElementIds.has(realizationStep.element)) {",
        'new': "            if (false) {",
        'suite': 'test/realization.test.mjs',
    },
    {
        # The other half of the same distinction: an element-shaped step effect takes the bare
        # purpose. Reading it as an id would refuse every valid step effect and accept none.
        'rule': 'an element-shaped step effect names the semantic_purpose, not the id',
        'file': 'lib/index.js',
        'old': "                if (ELEMENT_TARGET_EFFECTS.has(type) && !known.declarations.has(String(effect.target))) {",
        'new': "                if (false) {",
        'suite': 'test/realization.test.mjs',
    },
    # --- the affordance ------------------------------------------------------
    {
        # P13 in the small. An affordance is offered BY a surface, so an element this state's own
        # readings did not declare is a claim about a different page.
        'rule': 'an affordance\'s element must be one this state\'s own readings declared',
        'file': 'lib/index.js',
        'old': "                    if (offerable.has(affordance.element)) continue;",
        'new': "                    continue;",
        'suite': 'test/realization.test.mjs',
    },
    {
        # The claim is about a surface, so it cannot be held for one that is already gone: an
        # affordance with no `page_type` would be unrefutable for the rest of the run.
        'rule': 'affordances without a page_type are refused, not held for later',
        'file': 'lib/index.js',
        'old': "            if (args.affordances !== undefined && !args.page_type) {",
        'new': "            if (false) {",
        'suite': 'test/realization.test.mjs',
    },
    {
        # The keys a recording argument accepts are the keys the schema declares for that object,
        # minus the two only the machinery can supply. `confidence` is the one that looks right.
        'rule': 'an affordance accepts only the keys the schema declares for one',
        'file': 'lib/schema.js',
        'old': "export const AFFORDANCE_KEYS = new Set(['element', 'expected_behavior', 'description']);",
        'new': "export const AFFORDANCE_KEYS = new Set(['element', 'expected_behavior', 'confidence', 'description']);",
        'suite': 'test/realization.test.mjs',
    },
    {
        # `graph.json` has no room for the claim, so the report is where its absence from the
        # document stops being a silent drop. A count that is always zero says nothing.
        'rule': 'the affordances the log holds are counted in the commit report',
        'file': 'lib/commit.js',
        'old': "      recorded: recordedAffordances.length,",
        'new': "      recorded: 0,",
        'suite': 'test/realization.test.mjs',
    },
    {
        # And the reading is what claims it: an affordance nothing recorded is an affordance the
        # run cannot be said to have read for.
        'rule': 'the affordance reaches the log on the reading that made it',
        'file': 'lib/session.js',
        'old': "        ...(Array.isArray(affordances) && affordances.length ? { affordances } : {}),",
        'new': "        ...({}),",
        'suite': 'test/realization.test.mjs',
    },
    # --- the actor registry --------------------------------------------------
    {
        # An actor vocabulary that does not reach the document is a registry nothing resolves
        # against: a journey's `actor` and a state's variant both name it, and `application.actors`
        # is where the schema says it lives.
        'rule': 'the declared actors are carried into application.actors',
        'file': 'lib/commit.js',
        'old': "        ...(actorRecords.length ? { actors: actorRecords } : {}),",
        'new': "        ...({}),",
        'suite': 'test/realization.test.mjs',
    },
    # --- Phase 2: the two documents, and what each one owes the other ---------
    {
        # D5/D12. The calls of one invocation are one move: without the merge a behaviour is as
        # many edges as it made calls, and "what a user asks for" stops being the unit the model
        # counts. A projection that reports the walk once per call is the walk's log, not a model.
        'rule': 'the calls of one behaviour between two states are one edge',
        'file': 'lib/abm.js',
        'old': "      if (!carried.length) continue;",
        'new': "      if (true) continue;",
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # The graph's `steps[]` is a deliberately narrower projection of the recorded step —
        # `capabilityStep` is closed and has no room for a `purpose` or an `effects` — so the model
        # has to read the log. Remove that and the model loses exactly the facts the graph never
        # carried, which is the reason there are two documents rather than one.
        'rule': 'the model\'s steps are the recorded ones, not the graph\'s projection of them',
        'file': 'lib/abm.js',
        'old': "      recordedStepsIn(dir),",
        'new': "      null,",
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # Every reference in the document is an id. An element-shaped effect is recorded with the
        # control's `semantic_purpose` (`email_input`), and a document whose steps name their
        # element by id while their effects name the same control by purpose has two vocabularies
        # in it. P4 refuses the second one, so this one has to be resolved.
        'rule': 'an element-shaped effect is resolved to an element id, not left as a purpose',
        'file': 'lib/abm.js',
        'old': "        ELEMENT_TARGET_EFFECTS.has(effect.type) && !isElementId(effect.target) && elementIdByPurpose.has(effect.target)",
        'new': "        false",
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # D4's fallback. A walk that named no journey still has to be projected as one, because
        # P12's `no_journey` is an *error*: without the fallback a run that claimed no goal is
        # blocked by a fact about the run rather than by anything wrong with the model.
        'rule': 'a walk that claimed no journey is projected as the walk it was',
        'file': 'lib/abm.js',
        'old': "  const walkedJourneys = journeys.length || !projectedTransitions.length ? journeys : [{",
        'new': "  const walkedJourneys = journeys.length || true ? journeys : [{",
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # The model is a document beside the graph, not a description of the graph: it is written
        # where the run is, and a commit that reports a model it did not write is the report this
        # phase exists to make honest.
        'rule': 'the model is written beside the graph, not only reported',
        'file': 'lib/commit.js',
        'old': "  if (modelDocument) writeFileSync(modelPath, JSON.stringify(modelDocument, null, 2) + '\\n', 'utf8');",
        'new': "  if (false) writeFileSync(modelPath, JSON.stringify(modelDocument, null, 2) + '\\n', 'utf8');",
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # README gap 8, which Phase 2 exists to close: both documents are checked against the
        # schema they name *before* `report.ok` is answered, and one that does not validate is
        # never written. Checking nothing is not checking and passing — `valid: null` is the third
        # answer, and the write gate treats it as a refusal.
        'rule': 'the model is checked against the schema it names before the commit answers',
        'file': 'lib/commit.js',
        'old': "    model: check(model, 'abm/0.2/application-model.schema.json', 'application-model.json'),",
        'new': "    model: check(null, 'abm/0.2/application-model.schema.json', 'application-model.json'),",
        'suite': 'test/abm-commit.test.mjs',
    },
    # --- Phase 3: the protocol, which is a sentence rather than an artifact ---
    {
        # §5's first edit: the reading comes before the walk, and before the loop that records it.
        # The order is the phase — a vocabulary decided one action at a time is a vocabulary of
        # controls — so this case removes the heading the order is asserted on, and both the naming
        # check and the ordering check go with it.
        'rule': 'the application is understood before it is walked',
        'file': 'lib/protocol.js',
        'old': '**Understand the application before you walk it.**',
        'new': '**Understand the application while you walk it.**',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # D3. A per-element interaction is the *default* thing a call does; the exception is a call a
        # user would ask for by name. Flip the default and the model goes back to recording the walk
        # as a list of capabilities. (The live run the suite was written against took the old clause's
        # other half and reported a sign-in as three behaviours.)
        'rule': 'a per-element interaction is recorded as a step unless a user would ask for it',
        'file': 'lib/protocol.js',
        'old': 'is the *default* thing a call does',
        'new': 'is one of the things a call does',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # The case that matters most for a rewrite: put the previous version's instruction back and
        # check the suite notices it is available again. A protocol that offers both readings is a
        # protocol whose rule depends on which sentence the model read last. (Written without
        # backticks around the phrase: this text lands inside the protocol's own template literal, and
        # an unescaped backtick would end the string and make the case "broken" for a parse error.)
        'rule': 'the previous composite-clause is gone, not merely followed by a better one',
        'file': 'lib/protocol.js',
        'old': 'claims to *be* a behaviour',
        'new': 'claims to *be* a behaviour — record both kinds, with capability_kind: composite on the one that is the behaviour',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # D5. A behaviour is what a user asks for; a step is one interaction. A behaviour described
        # as a group of interactions is the demotion in a sentence, and the model writes what it
        # reads.
        'rule': 'a behaviour is what a user asks for, not a group of interactions',
        'file': 'lib/protocol.js',
        'old': 'a **behaviour** is what a user asks for',
        'new': 'a **behaviour** is a group of interactions',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # And the edge: recorded once, when the behaviour completes. An edge per step is the walk's
        # log, and the unit the model counts stops being what a user asks for.
        'rule': 'the edge is recorded once, when the behaviour completes',
        'file': 'lib/protocol.js',
        'old': 'recorded once, when the behaviour completes',
        'new': 'recorded once for each step of the behaviour',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # D6, and the key that looks right: `graph_observe` refuses `confidence` on an affordance by
        # name, so a protocol that offers one asks the model to make a call the tool refuses.
        'rule': 'an affordance is recorded without the confidence the tool refuses',
        'file': 'lib/protocol.js',
        'old': '"expected_behavior"',
        'new': '"expected_behavior", "confidence"',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # The grounding paragraph. A behaviour inferred with no evidence behind it is a hallucination
        # and the profile says so; soften the sentence and the honesty it asks for goes with it.
        'rule': 'a behaviour with no evidence behind it is reported as a hallucination',
        'file': 'lib/protocol.js',
        'old': 'behind it is a hallucination',
        'new': 'behind it is a claim like any other',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # §5's last edit: keep every existing refusal sentence verbatim. Each one is a failure mode
        # paid for in a live run, and a rewrite that reflows the paragraphs around them is exactly
        # the edit that drops one.
        'rule': 'the refusal sentences the rewrite had to keep are still there',
        'file': 'lib/protocol.js',
        'old': 'A negative result is a result.',
        'new': 'A negative result is not a result.',
        'suite': 'test/protocol.test.mjs',
    },
    {
        # The seam between the loop and the tools: an argument nobody describes is an argument the
        # model will not use, so adding one to a recording tool is a decision rather than an
        # omission. This case adds one and checks that the suite asks why.
        'rule': 'every argument a recording tool declares is named in the loop',
        'file': 'lib/index.js',
        'old': "            confidence: { type: 'number', description: '0..1 confidence in this reading' },",
        'new': "            confidence: { type: 'number', description: '0..1 confidence in this reading' },\n            mystery: { type: 'string', description: 'a reading the protocol never asks for' },",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # The manifest is part of the artifact. `lib/validate.js` reads `../schemas/` at commit
        # time and `files` did not name it — `npm test` was green on a package whose commit would
        # have answered "the schema set could not be read" and written neither document. This is
        # that defect: the reader ships, the directory it reads does not.
        'rule': 'the schema set the commit reads at runtime is published',
        'file': 'package.json',
        'old': '        "schemas",\n',
        'new': '',
        'suite': 'test/package.test.mjs',
    },
    {
        # And the same rule for a directory that does not exist yet: the check is derived from what
        # the modules resolve, so a new read has to be published rather than remembered.
        'rule': 'a module that reads a new directory fails until the manifest names it',
        'file': 'lib/validate.js',
        'old': "new URL('../schemas/', import.meta.url)",
        'new': "new URL('../schemas-2/', import.meta.url)",
        'suite': 'test/package.test.mjs',
    },
    {
        # A section's text is a prompt template, and 0.1.24 shipped a placeholder written as a
        # template: the harness refused to boot with `unknown prompt variable "{{param}}"`. A
        # placeholder is a legitimate thing to want in an example, which is why the suite has to say
        # that this is not how to write one — and the section now describes the spelling instead of
        # printing it, which is exactly the care this case holds down.
        'rule': 'the protocol text cannot spell a prompt variable the harness does not register',
        'file': 'lib/protocol.js',
        'old': "or a template bound to the behaviour's input",
        'new': "or a \\`\"{{param}}\"\\` bound to the behaviour's input",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # P12's boundary, which the live sign-in walk of 2026-09-18 was refused for. A call that stays
        # where the walk already stood puts that state in `passed_through`, and that state is the
        # surviving edge's own `from_state` — so requiring the behaviour to "arrive" there asks a step
        # to record a `state_entered` for a state the walk never left, and the only way to satisfy it
        # is a false effect. Removing the guard puts that demand back.
        'rule': 'a state the surviving edge itself names is not a state the collapse hid',
        'file': 'lib/abm.js',
        'old': '      if (state === transition.from_state || state === transition.to_state) continue;\n',
        'new': '',
        'suite': 'test/abm-commit.test.mjs',
    },
    {
        # The recorder fix, and the defect a live run measured: a walk that names the control on every
        # step and no `target` at all recorded three committed transitions with `action.target: null`,
        # so the generator reported `step_targets_no_element` for every step and wrote a spec that
        # asserts the signed-in screen without ever signing in. The step's element and the transition's
        # target are one element id, and reading only `args.target` is the rule that made a field the
        # protocol never asked for decide what two consumers could say.
        'rule': 'the edge is recorded acting on the control the step names',
        'file': 'lib/index.js',
        'old': "            const actionTarget = typeof args.target === 'string' ? args.target : stepElement;\n",
        'new': "            const actionTarget = typeof args.target === 'string' ? args.target : null;\n",
        'suite': 'test/realization.test.mjs',
    },
    {
        # The other half: one element id in two places cannot be said two ways. A call that gives both
        # and gives them differently has mistyped one of them, and the repair is to drop `target` —
        # resolving it by preferring either would write a graph whose edge and whose step disagree
        # about which control moved the page.
        'rule': 'an edge whose target and whose step name different controls is refused',
        'file': 'lib/index.js',
        'old': "            if (stepElement && typeof args.target === 'string' && args.target !== stepElement) {\n",
        'new': "            if (false) {\n",
        'suite': 'test/realization.test.mjs',
    },
    {
        # Where the id came from is reported, and `info` is the claim: nothing was inferred, because a
        # step's element and a transition's target are the same element id. A severity above `info`
        # would make every walk that states the control on the step — which is the shape the protocol
        # asks for — commit under a warning it cannot avoid.
        'rule': 'the control taken from the step is reported at info, not as a finding against the walk',
        'file': 'lib/schema.js',
        'old': "  ['target_from_realization', 'info'],",
        'new': "  ['target_from_realization', 'warning'],",
        'suite': 'test/realization.test.mjs',
    },
    {
        # `requires` holds records, not names. Joining the list into the sentence a run is left with
        # produced *Set [object Object] before running it* — the one instruction a person has to act
        # on before the spec runs at all, and one that cannot be acted on.
        'rule': 'the variable a spec needs is named in the instruction, not the record that describes it',
        'file': 'lib/generate.js',
        'old': "    const names = requires.map((entry) => entry.env).join(', ');\n",
        'new': "    const names = requires.join(', ');\n",
        'suite': 'test/generate.test.mjs',
    },
    {
        # The seventh defect a live run found, and the `target` defect one field over: the section
        # offered a value template and never said that writing one obliges the walk to declare the
        # parameter. A 0.1.28 walk wrote two templates, declared no input anywhere, and had its whole
        # model withheld by `P5` for a convention it had been told half of.
        'rule': 'a value template is named as a parameter the walk has to declare',
        'file': 'lib/protocol.js',
        'old': "     a parameter you have to declare**:\n",
        'new': "     a parameter you may declare if you like**:\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # And the other half of the convention: *where* the declaration goes, and why that is where.
        # A behaviour's input is read from the inputs of the capabilities it is composed of, so a
        # walk told to declare the parameter and not told where has been told nothing it can do.
        'rule': 'and the section says where the parameter is declared, and why that is where',
        'file': 'lib/protocol.js',
        'old': "     because a behaviour's input is read from the inputs of the capabilities it is composed of, and\n",
        'new': "     because a behaviour's input is whatever the behaviour says it is, and\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # The consequence, which is the part that makes it a rule rather than advice: the refusal
        # costs the whole model, not the one step.
        'rule': 'and the consequence of an undeclared parameter is named as the model, not the step',
        'file': 'lib/protocol.js',
        'old': "     the whole model, not the one step. Write the literal instead if you would rather not declare\n",
        'new': "     the one step alone. Write the literal instead if you would rather not declare\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # And the way out, so that a walk that does not want to declare a parameter has something to
        # do other than invent one: write the literal the page was actually given.
        'rule': 'and writing the literal instead is offered, with the reason it is accepted',
        'file': 'lib/protocol.js',
        'old': "     it: the page was given one, and P5 accepts it.\n",
        'new': "     it: a value is a value.\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        # And the machinery the sentence now relies on. Telling the walk to declare a parameter on
        # the capability that is the step is only worth saying if the projection actually reads it
        # there: a behaviour's input is the inputs of the capabilities it is composed of. Sending a
        # walk somewhere the code does not look would be the same defect with one more move in it.
        'rule': 'a behaviour takes the inputs of the capabilities it is composed of',
        'file': 'lib/abm.js',
        'old': "    if (!members.length) return declared;\n",
        'new': "    if (!members.length) return declared;\n    return declared;\n",
        'suite': 'test/abm.test.mjs',
    },
    {
        # The other half of the same live run. Its walk re-recorded one edge to correct a mistake,
        # the commit's own assembly folded the two records and the behaviour profile's reader did
        # not, so one run had two readings of how many times the behaviour clicked Sign in. The
        # rule is one edge is one step however many times it was walked; this mutation keys the
        # collapse by the walk as well, which is the shape the reader had before the fix.
        'rule': 'a step re-walked is one step of a behaviour, not two',
        'file': 'lib/abm.js',
        'old': "    const key = JSON.stringify([id, record.transition_id ?? null]);\n",
        'new': "    const key = JSON.stringify([id, record.transition_id ?? null, record.walk_index]);\n",
        'suite': 'test/abm.test.mjs',
    },
    {
        # The tenth defect, which is the seventh one's twin: the section invited a concrete value
        # with `arguments` and never said whose value it is. A 0.1.29 walk filled the email and then
        # put `{"email": ...}` on the click that followed, and P5 refused it — correctly, because no
        # effect of a click reports the email. The rule is per edge; which edge was never stated.
        # These three mutations are the three ways of leaving that unsaid.
        'rule': 'a value is read against the edge it was given to, and not the run at large',
        'file': 'lib/protocol.js',
        'old': "     They are read against this edge's own evidence: each one is looked for among this\n",
        'new': "     They are read against the run's own evidence: each one is looked for among this\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        'rule': 'and what they are read against is this edge\'s own evidence',
        'file': 'lib/protocol.js',
        'old': "     transition's effects and this step's own observation, so a value the page reports\n",
        'new': "     effects and observations of the whole run, so a value the page reports\n",
        'suite': 'test/protocol.test.mjs',
    },
    {
        'rule': 'and the fill\'s value is placed on the fill, not on the click that followed it',
        'file': 'lib/protocol.js',
        'old': "     the rule is per edge, so the fill's value goes on the fill.\n",
        'new': "     the rule is wherever the value reads best.\n",
        'suite': 'test/protocol.test.mjs',
    },
    # --- a turn of a journey is a move, and a move is an invocation --------------------------------
    # Measured on the live 0.1.30 run, and in the projected document the pivot produces rather than in
    # the graph: `journeys[0].steps` named `transition_submit_login` three times while the very same
    # edge's `collapsed.invocations` said one, because the projection remapped each *call* of the
    # invocation onto the edge that absorbed it and every one of them became a turn. The document
    # therefore told a reader the behaviour was performed three times. The two mutations below are
    # the two ways of saying it wrong, and they are different rules: one turn per call over-counts,
    # one turn per behaviour under-counts a walk that genuinely performed it twice.
    {
        'rule': 'the calls of one invocation are one turn of the journey, not one turn each',
        'file': 'lib/abm.js',
        'old': "        if (namedInvocation.has(invocation)) continue;\n",
        'new': "        if (false) continue;\n",
        'suite': 'test/abm.test.mjs',
    },
    {
        # The other direction, and the reason the key is the invocation rather than the behaviour: a
        # walk that signs in, leaves and signs in again performed two moves. Keying by the behaviour
        # alone would collapse them into one turn while `collapsed.invocations` said two — the same
        # disagreement in the opposite direction, and the same defect.
        'rule': 'and two invocations of one behaviour are two turns, not one',
        'file': 'lib/abm.js',
        'old': "        const key = `${ownerId}|${invocation[0].id}`;\n",
        'new': "        const key = `${ownerId}`;\n",
        'suite': 'test/abm.test.mjs',
    },
]

broken = survived = invalid = skipped = 0

for case in CASES:
    path = ROOT / case['file']
    original = path.read_text()
    if case['old'] not in original:
        skipped += 1
        print(f'SKIP  {case["rule"]}\n      the string to break is not in {case["file"]}')
        continue
    path.write_text(original.replace(case['old'], case['new'], 1))
    try:
        run = subprocess.run(['node', case['suite']], cwd=ROOT, capture_output=True, text=True)
    finally:
        path.write_text(original)
    failed = run.returncode != 0
    first = next((line for line in run.stdout.splitlines() if line.startswith('FAIL')), '')
    # A case that stops the file parsing fails every suite for a reason that is not the rule, and
    # counting it would let a badly written case look like a proof. The bracket for the string it
    # injects is the usual culprit: these edits land inside template literals.
    unparsed = any(word in run.stderr for word in ('SyntaxError', 'Unexpected identifier', 'Unexpected token'))
    if failed and not first and unparsed:
        invalid += 1
        print(f'INVALID  {case["rule"]}')
        print(f'        the edit does not parse ({run.stderr.strip().splitlines()[0][:110]})')
        continue
    if failed:
        broken += 1
    else:
        survived += 1
    print(f'{"BROKEN" if failed else "SURVIVED"}  {case["rule"]}')
    if failed:
        print(f'        {first[:150]}')
    else:
        print(f'        the suite stayed green with the rule removed — nothing tests it')

print(f'\n{len(CASES)} cases: {broken} BROKEN, {survived} SURVIVED, {invalid} INVALID, {skipped} SKIPPED')

# Prove the tree is back where it started.
verify = subprocess.run(['node', 'test/run.mjs'], cwd=ROOT, capture_output=True, text=True)
print('after restoring:', verify.stdout.strip().splitlines()[-1] if verify.stdout.strip() else verify.stderr[-200:])
sys.exit(0 if verify.returncode == 0 and not survived and not invalid and not skipped else 1)
