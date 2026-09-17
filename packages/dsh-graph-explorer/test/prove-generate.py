#!/usr/bin/env python3
"""Break one rule at a time and check the suite notices.

Each case: an exact string in a source file, the edit that removes the rule, and the suite that has
to fail. A rule whose removal leaves the suite green is a rule nobody is testing.

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
