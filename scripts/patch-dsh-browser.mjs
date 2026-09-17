#!/usr/bin/env node
/**
 * LOCAL PATCH for the installed `dsh-browser` package, per profile.
 *
 * Three independent edits, because `dsh-browser` cannot be configured into any
 * of them:
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
 *   init    (always)  Install every `init.d/*.js` into every new document, before
 *                     the document's own scripts run. Playwright's `addInitScript`
 *                     is the only way to observe a document *loading*: anything a
 *                     plugin installs with `browser_eval` arrives after the
 *                     document has already fetched its own state, so the requests
 *                     that load a page are lost and the empty list is
 *                     indistinguishable from "this page made no requests". The
 *                     profile's `init.d/` is filled from this repo's
 *                     `packages/dsh-graph-explorer/lib/page-hooks.js`.
 *
 * All three are source edits because that is the only route short of forking.
 *
 * Usage:
 *   node scripts/patch-dsh-browser.mjs --profile <name> [--headed] [--verify|--revert]
 *
 *   --profile <name>  which profile to patch (e.g. headless, web)
 *   --headed          also apply the headed edit (omit to leave it alone)
 *   --verify          prove the edits took: launches a browser and checks what the
 *                     page and the process can see, and runs the explorer's own
 *                     capture against a page that fetches while it loads — on a
 *                     page the patch created and on one it did not, side by side
 *   --revert          undo all three edits, back to the shipped behaviour
 *
 *   node scripts/patch-dsh-browser.mjs --profile web --headed
 *   node scripts/patch-dsh-browser.mjs --profile headless
 *
 * Per-run escape hatch for the headed edit, without reverting anything:
 *   DSH_BROWSER_HEADED=0 dsh --profile web "…"
 *
 * IMPORTANT: any `pnpm install` (including `dsh plugin add/remove`) replaces
 * this file with the pristine registry copy and silently reverts every edit.
 * Re-run this script afterwards. It is idempotent, so that is free, and it also
 * re-copies the page hooks, which is what keeps init.d/ from going stale.
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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const FLAG = '--disable-blink-features=AutomationControlled';
const HEADED_ENV = 'DSH_BROWSER_HEADED';

/** Where the page hooks are authored, and where the patched browser looks for them. */
const HOOKS_SOURCE = fileURLToPath(new URL('../packages/dsh-graph-explorer/lib/page-hooks.js', import.meta.url));
const HOOKS_DIR = 'init.d';
const HOOKS_SCRIPT = 'page-hooks.js';

/** Where the explorer's capture expression lives, so --verify runs the real one. */
const CAPTURE_MODULE = new URL('../packages/dsh-graph-explorer/lib/capture.js', import.meta.url);

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

/** The shipped page creation, and the init-script install that follows it. */
const INIT_FROM =
  `                this.currentPage = await this.browser.newPage({\n` +
  `                    viewport: viewport ?? { width: 1280, height: 800 },\n` +
  `                });\n`;
const INIT_TO =
  INIT_FROM +
  `                // LOCAL PATCH: init scripts — see scripts/patch-dsh-browser.mjs.\n` +
  `                // Installed on the page before its first navigation, so they run in EVERY\n` +
  `                // document. Anything a plugin installs through browser_eval is document-scoped,\n` +
  `                // so it dies with the document and a page's own load traffic is never seen.\n` +
  `                // Every .js file in init.d/, in name order. A missing init.d/ is an error\n` +
  `                // rather than a silent no-op: a browser that quietly stops collecting is the\n` +
  `                // failure this patch exists to remove.\n` +
  `                {\n` +
  `                    const { readdirSync } = await import('node:fs');\n` +
  `                    const { fileURLToPath } = await import('node:url');\n` +
  `                    const initDir = new URL('../${HOOKS_DIR}/', import.meta.url);\n` +
  `                    const inits = readdirSync(fileURLToPath(initDir)).filter((name) => name.endsWith('.js')).sort();\n` +
  `                    for (const name of inits) {\n` +
  `                        await this.currentPage.addInitScript({ path: fileURLToPath(new URL(name, initDir)) });\n` +
  `                    }\n` +
  `                }\n`;

/** Prefix of our marker comment. The rest of the line is deliberately not matched:
 *  revert must work on output from an older version of this script, whose comment
 *  said something else. */
const INIT_MARKER = '                // LOCAL PATCH: init scripts';

/** The effect: a page created by the manager gets init scripts. This is what
 *  decides whether to skip, and it does not look for our comment at all — an
 *  upstream `addInitScript` of its own would be an effect we must not touch. */
const INIT_EFFECT_RE = /await this\.currentPage\.addInitScript\(/;

/** The lines of our install, located by its marker and ended by the line that
 *  closes it at the same indent. Returns null when it is not there. */
function findInitBlock(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => line.startsWith(INIT_MARKER));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index >= start && line === '                }');
  if (end === -1) return null;
  return { start, end, lines };
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
  init: {
    label: 'init',
    isApplied: (s) => INIT_EFFECT_RE.test(s),
    /** Ours only if the marker AND the install it introduces are both there. A
     *  marker on its own is a comment, and a comment is not an effect. */
    isOurs: (s) => {
      const block = findInitBlock(s);
      return block !== null && INIT_EFFECT_RE.test(block.lines.slice(block.start, block.end + 1).join('\n'));
    },
    apply(src) {
      if (countOccurrences(src, INIT_FROM) !== 1) {
        fail('init', 'the page creation block did not appear exactly once');
      }
      return src.replace(INIT_FROM, INIT_TO);
    },
    revert(src) {
      const block = findInitBlock(src);
      if (block === null) {
        fail('init', 'our marker comment or the brace that closes it was not found');
      }
      return [...block.lines.slice(0, block.start), ...block.lines.slice(block.end + 1)].join('\n');
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
      '  --verify          prove the edits took: launches a browser, runs the\n' +
      '                    explorer capture on a patched page and an unpatched one\n' +
      '  --revert          undo all three edits, back to the shipped behaviour\n',
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

const wanted = wantHeaded ? ['args', 'init', 'headed'] : ['args', 'init'];
let src = readFileSync(target, 'utf8');

if (mode === '--revert') {
  const reverted = [];
  const skipped = [];
  for (const key of ['args', 'init', 'headed']) {
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
  // The hooks are ours, and they are the half of the init edit that lives
  // outside the patched file. Leaving them behind would be leaving a browser
  // patch in a directory nobody would think to look at.
  if (reverted.includes('init')) {
    const dir = join(dirname(target), '..', HOOKS_DIR);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`  removed ${dir}`);
    }
  }
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

// ── the page hooks the init edit installs ─────────────────────────────────────
// Copied, not referenced: the browser reads what is on disk next to it, and a
// copy that is only written when missing is a copy that goes stale the first time
// the source changes. Written on every run for that reason; file sizes are not a
// reason to trade a stale hook for a fresh one.
const hooksDir = join(dirname(target), '..', HOOKS_DIR);
const hooksTarget = join(hooksDir, HOOKS_SCRIPT);
if (!existsSync(HOOKS_SOURCE)) {
  console.error(
    `PATCH FAILED: ${HOOKS_SOURCE} does not exist.\n` +
      'The init edit installs the explorer\'s page hooks at document start. Without the ' +
      'source there is nothing to install, and a browser that silently installs nothing ' +
      'reports every document as making no requests — the exact false fact this edit exists ' +
      'to remove.',
  );
  process.exit(1);
}
const hooksSource = readFileSync(HOOKS_SOURCE, 'utf8');
mkdirSync(hooksDir, { recursive: true });
const hooksStale = !existsSync(hooksTarget) || readFileSync(hooksTarget, 'utf8') !== hooksSource;
if (hooksStale) writeFileSync(hooksTarget, hooksSource);
console.log(`  ${'hooks'.padEnd(6)} ${hooksStale ? 'installed' : 'already current'} → ${hooksTarget}`);

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

// ── the init edit: the same page, with and without document-start hooks ───────
// One origin, two pages, the explorer's own capture expression run against both:
//   control  a page this patch did not create — the manager installs init scripts
//            on the page it owns, so this one only gets the collector from the eval
//   subject  the manager's own page, created after the hooks were installed
// Both pages fetch their own state while they load, which is the case the init edit
// is about. The control is what makes this a proof instead of a demo: on its own,
// "the request was captured" says nothing about which install captured it — and the
// control is also exactly the state this profile was in before the patch.
const HOOKS_PAGE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Entry</title></head>',
  '<body><h1>Entry</h1>',
  "<script>fetch('/api/session');</script>",
  '</body></html>',
].join('\n');

const server = createServer((request, response) => {
  if (request.url === '/api/session') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"signed_in":false}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(HOOKS_PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

// The same source dsh-browser evaluates, compiled the same way it compiles it.
const { CAPTURE_EXPRESSION } = await import(CAPTURE_MODULE.href);
const runCapture = (target) =>
  target.evaluate(new Function('"use strict"; return (' + CAPTURE_EXPRESSION + ')'));

const control = await manager.browser.newPage();
await control.goto(origin);
const controlCapture = await runCapture(control);
await control.close();

await page.goto(origin);
const subjectCapture = await runCapture(page);

const sawSession = (capture) =>
  (capture?.network ?? []).some((entry) => String(entry.url).includes('/api/session'));
const describe = (capture) =>
  `${capture?.hooks_installed_at ?? '(none)'}, ${(capture?.network ?? []).length} request(s)`;

console.log(`  page the patch created:  ${describe(subjectCapture)}`);
console.log(`  page it did not create:  ${describe(controlCapture)}`);

if (subjectCapture?.hooks_installed_at !== 'document_start') {
  failures.push(
    `the page the patch created reports hooks_installed_at=${JSON.stringify(subjectCapture?.hooks_installed_at ?? null)}, ` +
      'expected "document_start" — the init script did not run before the document. Is init.d empty, ' +
      'or is another addInitScript in the way?',
  );
}
if (!sawSession(subjectCapture)) {
  failures.push(
    `the page the patch created did not record the request that loaded it: ` +
      `${JSON.stringify(subjectCapture?.network ?? [])} — the document fetched /api/session while ` +
      'loading, so a capture that cannot see it is still reporting a page that made no requests.',
  );
}
if (sawSession(controlCapture)) {
  failures.push(
    'the control page recorded a load request even though no init script was installed on it — ' +
      'the comparison proves nothing, so this is not verifying what it claims to.',
  );
}
if (controlCapture?.hooks_installed_at !== 'after_load') {
  failures.push(
    `the control page reports hooks_installed_at=${JSON.stringify(controlCapture?.hooks_installed_at ?? null)}, ` +
      'expected "after_load" — a page this patch did not create should get the hooks only from the ' +
      'capture eval, which is the state gap 1 describes.',
  );
}

server.close();

await manager.close();

if (failures.length) {
  console.error('\nVERIFY FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  '\nOK: navigator.webdriver is false' +
    (headedApplied ? ', the browser we launched is headed, ' : ', ') +
    'and the page it created was watched from its first byte — the hooks were installed\n' +
    'before the document ran, so the request that loaded it is in the evidence.',
);
