#!/usr/bin/env node
/**
 * Runs the three test suites and reports a single verdict.
 *
 * Nothing here needs a browser — the suites drive the plugin's own seams with a fake
 * tools registry, so a capture is just an object. What they cannot check is that the
 * page really looks like the capture says it does; that is what a live run against
 * `demo-app` is for. The division is deliberate: the logic that decides whether two
 * accounts of a step agree is testable in isolation, so it should not depend on a
 * browser to exercise.
 *
 * `index.js` imports its dependencies as peers, the way the harness provides them, so
 * running the suites needs them resolvable from this directory. The preflight below
 * says exactly what is missing instead of failing with a resolver stack trace.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools'];

/**
 * Places the peers actually live, in the order worth looking.
 *
 * The suites import `lib/index.js`, which imports its peers the way the harness supplies
 * them, so a test run needs them resolvable from *this* directory. pnpm's isolated layout
 * keeps a direct dependency out of reach of a package that does not declare it, which is
 * exactly the pinned-plugin case: the peers are present in the install and still not
 * resolvable. Looking them up beats telling the reader to go and find them.
 *
 * `DSH_PEER_ROOT` overrides the search for a checkout that is somewhere else.
 */
const peerRoots = () => {
    const roots = [];
    if (process.env.DSH_PEER_ROOT) roots.push(process.env.DSH_PEER_ROOT);
    let dir = join(here, '..');
    for (let up = 0; up < 4; up++) {
        roots.push(join(dir, 'node_modules'));
        roots.push(join(dir, 'node_modules', '.pnpm', 'node_modules'));
        dir = dirname(dir);
    }
    // The active npx install is the newest one, so it goes first: linking a stale copy of a
    // peer would mean testing against a different harness than the one that will run it.
    const npx = join(homedir(), '.npm', '_npx');
    for (const entry of listByAge(npx, 20)) roots.push(join(npx, entry, 'node_modules'));
    const profiles = join(homedir(), '.dsh', 'profiles');
    for (const profile of listByAge(profiles, 20)) roots.push(join(profiles, profile, 'node_modules'));
    return roots;
};

/** Subdirectories of `dir`, newest first. An unreadable directory is simply not a place. */
const listByAge = (dir, limit) => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => [entry.name, statSync(join(dir, entry.name), { throwIfNoEntry: false })?.mtimeMs ?? 0])
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name]) => name);
    } catch {
        return [];
    }
};

const linkDir = join(here, '..', 'node_modules');
const unresolved = [];

for (const peer of PEERS) {
    if (existsSync(join(linkDir, peer))) continue;
    const found = peerRoots().map((root) => join(root, peer)).find((candidate) => existsSync(candidate));
    unresolved.push([peer, found ?? null]);
}

if (unresolved.length) {
    console.error(`Cannot run the suites: ${unresolved.map(([peer]) => peer).join(', ')} not resolvable from this directory.\n`);
    console.error('These are peers the harness normally supplies. To run the tests, link them:\n');
    console.error(`  mkdir -p node_modules/@deepseek-ai`);
    for (const [peer, found] of unresolved) {
        console.error(found
            ? `  ln -sfn "${found}" node_modules/${peer}`
            : `  ln -sfn "<where the harness keeps it>/node_modules/${peer}" node_modules/${peer}`);
    }
    if (!existsSync(linkDir)) console.error(`\n(run those from this directory — there is no node_modules here yet)`);
    console.error('\nA dsh checkout or the npx cache has them: `find ~/.npm/_npx -maxdepth 5 -type d -name schemastery`');
    process.exit(2);
}

const suites = readdirSync(here).filter((file) => file.endsWith('.test.mjs')).sort();
const failed = [];

for (const suite of suites) {
    const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
    if (result.status !== 0) failed.push(suite);
}

console.log(failed.length
    ? `\n${failed.length}/${suites.length} suites FAILED: ${failed.join(', ')}`
    : `\n${suites.length}/${suites.length} suites passed`);
process.exit(failed.length ? 1 : 0);
