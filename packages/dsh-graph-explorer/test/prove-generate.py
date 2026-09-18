#!/usr/bin/env python3
"""Break one rule at a time and check the suite notices.

Each case: an exact string in a source file, the edit that removes the rule, and the suite that has
to fail. A rule whose removal leaves the suite green is a rule nobody is testing.

The last four cases are Phase 4's, and they are two rules with one warning between them: the
generator reading a model rather than a graph takes a step's value from the `realization[]` step it
was recorded on, refuses a step that has none — because otherwise "every action traces to a
realization step" would be true of the model and false of the specs written from it — and says in
the file which of the two documents it was written from.

Restores every file it touches, including on the exception path, and leaves the tree byte-identical.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

CASES = [
    {
        'rule': 'the dimension resolves to the collection the commit named, not to an element id',
        'file': 'lib/generate.js',
        'old': "const collections = [...ctx.elements.values()].filter((entry) => sameCollectionName(entry.semantic?.purpose ?? '', named) || sameCollectionName(entry.id, named));",
        'new': "const collections = [...ctx.elements.values()].filter((entry) => false);",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a role and a name outrank the recorded locator only on a role a user acts on',
        'file': 'lib/generate.js',
        'old': "  if (role && name && CONTROL_ROLES.has(role)) {",
        'new': "  if (role && name && true) {",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a value the run withheld is read from the environment, not written down',
        'file': 'lib/generate.js',
        'old': "  if (typeof raw === 'string' && raw === REDACTED) {",
        'new': "  if (typeof raw === 'string' && raw === REDACTED && false) {",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a negated state check reads as the opposite matcher rather than as a double negative',
        'file': 'lib/generate.js',
        'old': "    const want = type === 'absence' ? 'hidden' : (negated ? OPPOSITE[wanted] ?? wanted : wanted);",
        'new': "    const want = type === 'absence' ? 'hidden' : wanted;",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a step whose target the graph does not declare is refused, not guessed at',
        'file': 'lib/generate.js',
        'old': "        code: 'step_targets_no_element',",
        'new': "        code: 'step_targets_no_element_REMOVED',",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'the arrival state is checked, using the detection the graph declares for it',
        'file': 'lib/generate.js',
        'old': "      if (named.identity?.route && named.identity.route !== beforeRoute) {",
        'new': "      if (false) {",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a step whose own reading says the value was withheld is not typed from the argument',
        'file': 'lib/generate.js',
        'old': "        const withheld = withheldByEvidence(transition, element);",
        'new': "        const withheld = null;",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'the withheld reading is matched to the field it was read from',
        'file': 'lib/generate.js',
        'old': "    if (purpose && sameCollectionName(target, purpose)) return { target };",
        'new': "    if (purpose && true) return { target };",
        'suite': 'test/generate.test.mjs',
    },
    {
        'rule': 'a journey name stops at a parameter, and never trims a word that was not left dangling',
        'file': 'lib/commit.js',
        'old': "  while (cutParameter && words.length > 1 && TRAILING_CONNECTORS.has(words[words.length - 1].toLowerCase())) {",
        'new': "  const LOOSE = new Set(['in', 'as', 'via', 'at', 'with', 'and', 'then', 'to', 'for', 'on', 'by', 'from', 'into']);\n  while (words.length > 1 && LOOSE.has(words[words.length - 1].toLowerCase())) {",
        'suite': 'test/commit.test.mjs',
    },
    # --- Phase 4: the generator reading a model rather than a graph --------------------------------
    # Two rules, and they are the two halves of the pivot's acceptance sentence. The first says where
    # a model's values come from: a `realization[]` step carries the control it acted on and the
    # value it was walked with, recorded by the machinery, so it beats the model's own account of the
    # same thing *by name* — and a graph transition, which has no realization, is unaffected.
    {
        'rule': 'a realization step beats the step\'s transcribed arguments, because it cannot be wrong about its own element',
        'file': 'lib/generate.js',
        'old': "  const realized = transition?.realization;\n",
        'new': "  const realized = undefined;\n",
        'suite': 'test/generate.test.mjs',
    },
    {
        # The second half: a model edge with no realization is refused by name. Without it the
        # generator writes an action no reading stands behind, and the acceptance sentence — every
        # action in the spec traces to a `realization[]` step — stops being true of the specs it
        # writes while every other test stays green.
        'rule': 'a model step with no realization behind it is refused rather than written',
        'file': 'lib/generate.js',
        'old': "      if (fromModel && !transition.realization) {\n",
        'new': "      if (false) {\n",
        'suite': 'test/generate.test.mjs',
    },
    {
        # Asked once per edge, because the report is about the edge: the expanded calls of one move
        # all carry the same `collapsed` record, and three warnings for one fact read as three
        # problems. The known limit is stated as this report, so a reader who saw it three times
        # would be told the walk had three problems instead of one that nobody can fix yet.
        'rule': 'the shared-values report is made once per edge, not once per call',
        'file': 'lib/generate.js',
        'old': "  if (ctx.notedShared.has(edge)) return false;\n",
        'new': "  if (false) return false;\n",
        'suite': 'test/generate.test.mjs',
    },
    {
        # The file says what it is, on the one line of the artifact nothing downstream can check. A
        # spec written from the model and headed "Generated from a committed graph" is a claim its
        # own generator could contradict: the model is read for its `realization[]`, which is why an
        # action with no reading under it is refused, and the graph is the reading where that rule
        # does not apply.
        'rule': 'the header names the document the spec was actually written from',
        'file': 'lib/generate.js',
        'old': "    fromModel\n      ? ' * Generated from a committed behaviour model — not written by hand.'\n      : ' * Generated from a committed graph — not written by hand.',\n",
        'new': "    ' * Generated from a committed graph — not written by hand.',\n",
        'suite': 'test/generate.test.mjs',
    },
    {
        # The value the document recorded has two forms and one of them had no test under it until a
        # live 0.1.32 run walked the other one. `[set]` is the capture's word for a value that was
        # typed and not kept; `{{param}}` is the schema's word for the same thing said by the model,
        # and `realization.value` may be either. A generator that quotes the second writes
        # `.fill("{{password}}")` — a spec whose own document says the parameter is declared, failing
        # for a reason that has nothing to do with the application.
        'rule': 'a value that is a template is a reference and is read from the environment',
        'file': 'lib/generate.js',
        'old': '  const parameter = templateParameter(raw);\n',
        'new': '  const parameter = null;\n',
        'suite': 'test/generate.test.mjs',
    },
    {
        # Only the whole value. The schema's substitution has one argument, so `"user-{{n}}@example.com"`
        # is a string with braces in it and not a reference; a rule that read it as one would invent an
        # environment variable named after a fragment, which nobody can supply.
        'rule': 'only a value that *is* the template is a reference, not one that contains braces',
        'file': 'lib/schema.js',
        'old': '  const match = /^\\{\\{\\s*([^{}]+?)\\s*\\}\\}$/.exec(value.trim());\n',
        'new': '  const match = /\\{\\{\\s*([^{}]+?)\\s*\\}\\}/.exec(value);\n',
        'suite': 'test/generate.test.mjs',
    },
    {
        # The same rule read in the one other place the two are compared. A step that binds
        # `{{password}}` *and* whose reading says the value was withheld has said one thing twice; if
        # only the capture's spelling counted, the generator would warn a reader that their document
        # contradicts itself when both halves of it say exactly the same thing.
        'rule': 'a template is a reference where the reading is compared too, not only where it is rendered',
        'file': 'lib/generate.js',
        'old': "const isReference = (value) => value === REDACTED || templateParameter(value) !== null;\n",
        'new': "const isReference = (value) => value === REDACTED;\n",
        'suite': 'test/generate.test.mjs',
    },
]

for case in CASES:
    path = ROOT / case['file']
    original = path.read_text()
    if case['old'] not in original:
        print(f'SKIP  {case["rule"]}\n      the string to break is not in {case["file"]}')
        continue
    path.write_text(original.replace(case['old'], case['new'], 1))
    try:
        run = subprocess.run(['node', case['suite']], cwd=ROOT, capture_output=True, text=True)
    finally:
        path.write_text(original)
    failed = run.returncode != 0
    first = next((line for line in run.stdout.splitlines() if line.startswith('FAIL')), '')
    print(f'{"BROKEN" if failed else "SURVIVED"}  {case["rule"]}')
    if failed:
        print(f'        {first[:150]}')
    else:
        print(f'        the suite stayed green with the rule removed — nothing tests it')

# Prove the tree is back where it started.
verify = subprocess.run(['node', 'test/run.mjs'], cwd=ROOT, capture_output=True, text=True)
print('\nafter restoring:', verify.stdout.strip().splitlines()[-1] if verify.stdout.strip() else verify.stderr[-200:])
sys.exit(0 if verify.returncode == 0 else 1)
