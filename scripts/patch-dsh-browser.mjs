#!/usr/bin/env node
/**
 * LOCAL PATCH for the installed `dsh-browser` package, per profile.
 *
 * Two independent edits, because `dsh-browser` cannot be configured into
 * either of them:
 *
 *   args    (always)  Restore `--disable-blink-features=AutomationControlled`.
 *                     Without it Blink leaves `navigator.webdriver === true`,
 *                     which is the single most common automation check on the
 *                     web. The retired plugin passed this flag; dsh-browser
 *                     passes only --no-sandbox/--disable-dev-shm-usage, and its
 *                     Config schema has no `launchArgs` key, so config cannot
 *                     reach it. This edit only makes the browser stop
 *                     *volunteering* that it is automated, restoring the
 *                     behaviour this repo already had.
 *
 *   headed  (opt-in)  Let the browser open a real window. `launch()` hardcodes
 *                     `headless: true` and the schema has no `headless` key, so
 *                     the attended `web` profile needs this to keep a window.
 *
 * Both are source edits because that is the only route short of forking.
 *
 * Usage:
 *   node scripts/patch-dsh-browser.mjs --profile <name> [--headed] [--verify|--revert]
 *
 *   --profile <name>  which profile to patch (e.g. headless, web)
 *   --headed          also apply the headed edit (omit to leave it alone)
 *   --verify          launch through the patched manager and prove the edits took
 *   --revert          undo both edits, back to the shipped behaviour
 *
 *   node scripts/patch-dsh-browser.mjs --profile web --headed
 *   node scripts/patch-dsh-browser.mjs --profile headless
 *
 * Per-run escape hatch for the headed edit, without reverting anything:
 *   DSH_BROWSER_HEADED=0 dsh --profile web "…"
 *
 * IMPORTANT: any `pnpm install` (including `dsh plugin add/remove`) replaces
 * this file with the pristine registry copy and silently reverts both edits.
 * Re-run this script afterwards. It is idempotent, so that is free.
 *
 * ── two different questions, deliberately kept apart ────────────────────────
 *
 * `isApplied` asks "is this EFFECT already in the file?", by looking for the
 * code the edit produces — the flag itself, the `headed` const. That is what
 * decides whether to skip. It deliberately does not look for our comment
 * markers, because a comment is not the effect: an earlier version keyed
 * "already applied" on marker text and then could not revert its own older
 * output, once the comment in it named a file that had since been renamed.
 *
 * `isOurs` asks "did THIS script put it there?" — a structural match on the
 * exact block we insert — and is what `--revert` requires before touching
 * anything. So a flag upstream added itself is never removed by us, while a
 * patch of ours is removed even if its comment text has since changed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const FLAG = '--disable-blink-features=AutomationControlled';
const HEADED_ENV = 'DSH_BROWSER_HEADED';

/** The shipped args line, and what we replace it with. */
const ARGS_FROM = `                    args: ['--no-sandbox', '--disable-dev-shm-usage'],`;
const ARGS_TO =
  `                    // LOCAL PATCH: args — see scripts/patch-dsh-browser.mjs.\n` +
  `                    // Without this, Blink leaves \`navigator.webdriver\` true, the\n` +
  `                    // most commonly checked automation signal on the web. The retired\n` +
  `                    // plugin passed it; dsh-browser has no config key for launch args.\n` +
  `                    args: [\n` +
  `                        '--no-sandbox',\n` +
  `                        '--disable-dev-shm-usage',\n` +
  `                        '${FLAG}',\n` +
  `                    ],`;

/** The shipped `headless: true,`, and what we replace it with. */
const HEADLESS_FROM = '                    headless: true,';
const HEADLESS_TO = '                    headless: !headed,';

/** The launch preamble as shipped. */
const DECL_FROM =
  '        const { executablePath, channel, viewport } = this.config;\n' +
  '        const attempts = [];';

/** The `headed` const, plus whatever LOCAL PATCH comment precedes it. Tolerant
 *  of the comment text on purpose — that is why revert is structural, not
 *  literal: an older version of this script wrote "see patch-headed.mjs".
 *
 *  Note the match stops at the `headed` line and deliberately does NOT span the
 *  `const attempts = [];` that follows, so the replacement below must not
 *  re-emit it either — doing so duplicates the declaration and the module fails
 *  to parse. */
const HEADED_DECL_RE = new RegExp(
  `^ {8}const \\{ executablePath, channel, viewport \\} = this\\.config;\\n` +
    `(?: {8}\\/\\/ LOCAL PATCH: headed[^\\n]*\\n)+` +
    ` {8}const headed = process\\.env\\.${HEADED_ENV} !== '0';\\n`,
  'm',
);
const HEADED_DECL_TO =
  '        const { executablePath, channel, viewport } = this.config;\n';

/** Count non-overlapping literal occurrences, so a duplicated anchor is caught. */
function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = 0; ; ) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

function fail(label, detail) {
  console.error(
    `PATCH FAILED (${label}): ${detail}.\n` +
      `The installed dsh-browser is not the expected shape. No changes written.`,
  );
  process.exit(1);
}

const EDITS = {
  args: {
    label: 'args',
    /** Effect present? (the flag) — decides whether to skip. */
    isApplied: (s) => s.includes(FLAG),
    /** Is our exact block there? — required before reverting. */
    isOurs: (s) => s.includes('LOCAL PATCH: args'),
    apply(src) {
      if (countOccurrences(src, ARGS_FROM) !== 1) {
        fail('args', 'the shipped args line did not appear exactly once');
      }
      return src.replace(ARGS_FROM, ARGS_TO);
    },
    revert(src) {
      if (countOccurrences(src, ARGS_TO) !== 1) {
        fail('args', 'our args block did not appear exactly once');
      }
      return src.replace(ARGS_TO, ARGS_FROM);
    },
  },
  headed: {
    label: 'headed',
    /** Effect present? (the env-driven const) — decides whether to skip. */
    isApplied: (s) => s.includes(`const headed = process.env.${HEADED_ENV}`),
    /** Is our exact block there? — required before reverting. */
    isOurs: (s) => HEADED_DECL_RE.test(s),
    apply(src) {
      if (countOccurrences(src, DECL_FROM) !== 1) {
        fail('headed', 'the launch preamble did not appear exactly once');
      }
      if (countOccurrences(src, HEADLESS_FROM) !== 1) {
        fail('headed', 'the `headless: true,` line did not appear exactly once');
      }
      return src
        .replace(
          DECL_FROM,
          `        const { executablePath, channel, viewport } = this.config;\n` +
            `        // LOCAL PATCH: headed — see scripts/patch-dsh-browser.mjs. ${HEADED_ENV}=0 restores headless.\n` +
            `        const headed = process.env.${HEADED_ENV} !== '0';\n` +
            `        const attempts = [];`,
        )
        .replace(HEADLESS_FROM, HEADLESS_TO);
    },
    revert(src) {
      if (countOccurrences(src, HEADLESS_TO) !== 1) {
        fail('headed', '`headless: !headed,` did not appear exactly once');
      }
      if ((src.match(new RegExp(HEADED_DECL_RE.source, 'gm')) ?? []).length !== 1) {
        fail('headed', 'the `headed` preamble did not match exactly once');
      }
      return src
        .replace(HEADED_DECL_RE, HEADED_DECL_TO)
        .replace(HEADLESS_TO, HEADLESS_FROM);
    },
  },
};

function usage(exitCode = 1) {
  console.error(
    'usage: node scripts/patch-dsh-browser.mjs --profile <name> [--headed] [--verify|--revert]\n' +
      '\n' +
      '  --profile <name>  which profile to patch (e.g. headless, web)\n' +
      '  --headed          also apply the headed edit (omit to leave it alone)\n' +
      '  --verify          prove the edits took effect (launches a browser)\n' +
      '  --revert          undo both edits, back to the shipped behaviour\n',
  );
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
let profile = null;
let mode = '';
let wantHeaded = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--profile') profile = argv[++i];
  else if (a === '--verify' || a === '--revert') mode = a;
  else if (a === '--headed') wantHeaded = true;
  else if (a === '--help' || a === '-h') usage(0);
  else usage();
}
if (!profile) usage();

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const target = join(
  dshHome,
  'profiles',
  profile,
  'node_modules/dsh-browser/lib/browser-manager.js',
);

if (!existsSync(target)) {
  console.error(
    `PATCH FAILED: ${target} does not exist.\n` +
      `Is dsh-browser installed in profile "${profile}"? ` +
      `Try: dsh plugin --profile ${profile} add dsh-browser`,
  );
  process.exit(1);
}

const wanted = wantHeaded ? ['args', 'headed'] : ['args'];
let src = readFileSync(target, 'utf8');

if (mode === '--revert') {
  const reverted = [];
  const skipped = [];
  for (const key of ['args', 'headed']) {
    const edit = EDITS[key];
    if (!edit.isOurs(src)) {
      // Distinguish "already clean" from "present but not ours" — the latter is
      // worth saying out loud, since it means we deliberately did not touch it.
      if (edit.isApplied(src)) skipped.push(key);
      continue;
    }
    src = edit.revert(src);
    reverted.push(key);
  }
  for (const key of skipped) {
    console.log(`  ${key.padEnd(6)} present but not written by this script — left alone`);
  }
  if (!reverted.length) {
    console.log(`nothing to revert — ${profile} is already pristine`);
    process.exit(0);
  }
  writeFileSync(target, src);
  console.log(`reverted ${profile}: ${reverted.join(', ')}`);
  process.exit(0);
}

const applied = [];
for (const key of wanted) {
  const edit = EDITS[key];
  if (edit.isApplied(src)) {
    console.log(`  ${key.padEnd(6)} already in effect`);
    continue;
  }
  src = edit.apply(src);
  applied.push(key);
  console.log(`  ${key.padEnd(6)} applied`);
}

if (applied.length) writeFileSync(target, src);
console.log(
  applied.length
    ? `patched ${profile}: ${applied.join(', ')}`
    : `no change needed for ${profile}`,
);

if (mode !== '--verify') process.exit(0);

// ── verify ────────────────────────────────────────────────────────────────────
// One launch, two assertions: what the PAGE can see (navigator.webdriver) and
// what the PROCESS was started with (--headless, via a ps diff).
console.log(`\nverifying ${profile}: launching through the patched manager…`);

const chromiumProcesses = () => {
  const out = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return new Map(
    out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m) => m && /Chromium|Google Chrome/i.test(m[2]))
      .map((m) => [m[1], m[2]]),
  );
};

// Diff, not a global scan: a machine with Chrome already open would otherwise
// make these checks pass or fail for reasons unrelated to the patch.
const before = chromiumProcesses();

const { BrowserManager } = await import(pathToFileURL(target).href);
const manager = new BrowserManager({});
await manager.launch();
await new Promise((r) => setTimeout(r, 2000)); // let the process tree settle

const page = manager.currentPage;
await page.goto('about:blank');
const webdriver = await page.evaluate(() => navigator.webdriver);

const spawned = [...chromiumProcesses().entries()].filter(([pid]) => !before.has(pid));
const withHeadless = spawned.filter(([, cmd]) => cmd.includes('--headless'));

const headedApplied = EDITS.headed.isApplied(readFileSync(target, 'utf8'));
const failures = [];

console.log(`  chromium already running: ${before.size}`);
console.log(`  spawned by this launch:   ${spawned.length}`);
if (headedApplied) {
  // Only the main process carries the flag, so assert "none of ours", never "all of ours".
  console.log(`  of those, --headless:     ${withHeadless.length}`);
}
console.log(`  navigator.webdriver:      ${webdriver}`);

if (webdriver !== false) {
  failures.push(
    `navigator.webdriver is ${JSON.stringify(webdriver)}, expected false — the args edit did not take.`,
  );
}
if (headedApplied && spawned.length > 0 && withHeadless.length > 0) {
  failures.push(
    `${withHeadless.length} of our processes still carry --headless — the headed edit did not take.`,
  );
}

await manager.close();

if (failures.length) {
  console.error('\nVERIFY FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  '\nOK: navigator.webdriver is false' +
    (headedApplied ? ', and the browser we launched is headed.' : '.'),
);
