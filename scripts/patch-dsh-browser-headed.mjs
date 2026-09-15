#!/usr/bin/env node
/**
 * LOCAL PATCH — make `dsh-browser` open a VISIBLE Chromium window.
 *
 * Why this is a source patch and not configuration:
 *   `BrowserManager.launch()` hardcodes `headless: true` (lib/browser-manager.js),
 *   and the package's `Config` schema declares no `headless` key. Neither the
 *   package's own `cordis.patch.yml` nor a `--patch` overlay can reach it.
 *   Editing the installed file is the only route short of forking the package.
 *
 * Why it matters here:
 *   The `web` profile is the attended one — a person watching (and clicking in)
 *   is the whole point of a visible window. `dsh-browser` is headless-only, so
 *   without this patch the `web` profile silently loses that.
 *
 * Re-runnable and reversible:
 *   node scripts/patch-dsh-browser-headed.mjs --profile web
 *   node scripts/patch-dsh-browser-headed.mjs --profile web --verify
 *   node scripts/patch-dsh-browser-headed.mjs --profile web --revert
 *
 * After patching, `DSH_BROWSER_HEADED=0 dsh --profile web "…"` restores headless
 * for a single run without reverting anything.
 *
 * IMPORTANT: any `pnpm install` (e.g. `dsh plugin add/remove`) replaces this file
 * with the pristine registry copy and silently reverts the patch. Re-run it
 * after touching a profile's dependencies. It is idempotent, so that is free.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MARK = 'LOCAL PATCH: headed';

/** Anchors are exact strings from the shipped dsh-browser@0.1.0 build. A missing
 *  anchor means upstream changed shape — fail loudly rather than patch wrongly. */
const EDIT_FLAG = {
  from: `        const { executablePath, channel, viewport } = this.config;
        const attempts = [];`,
  to: `        const { executablePath, channel, viewport } = this.config;
        // ${MARK} — see scripts/patch-dsh-browser-headed.mjs. DSH_BROWSER_HEADED=0 restores headless.
        const headed = process.env.DSH_BROWSER_HEADED !== '0';
        const attempts = [];`,
};
const EDIT_HEADLESS = {
  from: '                    headless: true,',
  to: '                    headless: !headed,',
};

function usage(exitCode = 1) {
  console.error(
    'usage: node scripts/patch-dsh-browser-headed.mjs --profile <name> [--verify|--revert]\n' +
      '\n' +
      '  --profile <name>  which profile to patch (e.g. web, headless)\n' +
      '  --verify          after patching, prove the launched browser is NOT headless\n' +
      '  --revert          restore the shipped headless behaviour\n',
  );
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
let profile = null;
let mode = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--profile') profile = argv[++i];
  else if (a === '--verify' || a === '--revert') mode = a;
  else if (a === '--help' || a === '-h') usage(0);
  else usage();
}
if (!profile) usage();

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profilesDir = join(dshHome, 'profiles');
const target = join(
  profilesDir,
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

let src = readFileSync(target, 'utf8');
const patched = src.includes(MARK);

if (mode === '--revert') {
  if (!patched) {
    console.log(`nothing to revert — ${profile} is already pristine`);
    process.exit(0);
  }
  src = src
    .replace(EDIT_FLAG.to, EDIT_FLAG.from)
    .replace(EDIT_HEADLESS.to, EDIT_HEADLESS.from);
  writeFileSync(target, src);
  console.log(`reverted ${profile} to shipped headless behaviour`);
  process.exit(0);
}

if (patched) {
  console.log(`already patched: ${profile}`);
} else {
  for (const edit of [EDIT_FLAG, EDIT_HEADLESS]) {
    if (!src.includes(edit.from)) {
      console.error(
        `PATCH FAILED: anchor not found in ${profile} — the installed dsh-browser ` +
          `changed shape (a new version?).\nLooked for:\n${edit.from}\n\nNo changes written.`,
      );
      process.exit(1);
    }
    src = src.replace(edit.from, edit.to);
  }
  writeFileSync(target, src);
  console.log(`patched: ${profile}`);
}

if (mode !== '--verify') process.exit(0);

// ── verify: launch through the patched manager and inspect ONLY the processes
// we caused to appear. Diffing matters: a machine with Chrome already open would
// otherwise make this pass or fail for reasons that have nothing to do with us.
console.log(`\nverifying ${profile}: launching via the patched BrowserManager…`);

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

const before = chromiumProcesses();

const { BrowserManager } = await import(target);
const manager = new BrowserManager({});
await manager.launch();
await new Promise((r) => setTimeout(r, 2000)); // let the process tree settle

const spawned = [...chromiumProcesses().entries()].filter(([pid]) => !before.has(pid));
const withHeadless = spawned.filter(([, cmd]) => cmd.includes('--headless'));

console.log(`chromium processes already running: ${before.size}`);
console.log(`spawned by this launch:             ${spawned.length}`);
console.log(`  of those, with --headless:        ${withHeadless.length}`);

if (spawned.length === 0) {
  console.log('\nINCONCLUSIVE: no new browser process appeared.');
} else if (withHeadless.length === 0) {
  // Only the main process carries the flag, so assert on "none", never on "all".
  console.log('\nOK: the browser WE launched is headed — a window is open on screen.');
} else {
  console.log('\nWARNING: the browser we launched is STILL headless.');
}

await manager.close();
