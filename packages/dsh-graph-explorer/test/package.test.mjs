/**
 * The manifest decides what the artifact contains, so the manifest is part of the code.
 *
 * `lib/validate.js` resolves `../schemas/` against its own URL and reads the schema set
 * from there at commit time. That path is outside `lib/`, so `files` has to name it —
 * and `files` did not: `[... 'lib', 'test', 'cordis.patch.yml', 'README.md']` shipped the
 * reader and not the directory it reads. Nothing noticed, because every suite runs in the
 * source tree, where `schemas/` is present whether or not it is published. `npm test` was
 * green on a package whose `graph_commit` would have answered
 * `the schema set could not be read` and written neither document.
 *
 * A hand-kept list of paths to publish is a second copy of the imports, and copies drift.
 * So this derives the list instead: every path any module resolves against `import.meta.url`
 * and outside its own directory must be covered by `files`. A new read is a new failure
 * until the manifest names it, and the read that exists today cannot be removed without
 * this check failing on its own extraction, which is what keeps the check from going quiet.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const files = manifest.files ?? [];

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label, '=', JSON.stringify(actual));
};

// --- what the modules read ------------------------------------------------
// `new URL('…', import.meta.url)` with a relative path is the only way this package
// reaches outside its own directory, and `../` is what makes it a packaging question:
// a path inside `lib/` ships with `lib`. Matched as text, because the point is to find
// reads the manifest cannot see, and an import graph would miss the ones built from a
// string. `no such read` is asserted below: a rename of this pattern must fail here
// rather than silently empty the list.
const READ_PATTERN = /new URL\(\s*'(\.\.\/[^']*)'\s*,\s*import\.meta\.url\s*\)/g;
const READS = [];
for (const entry of readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.js'))) {
  const source = readFileSync(join(root, 'lib', entry), 'utf8');
  for (const [, target] of source.matchAll(READ_PATTERN)) {
    READS.push({ from: `lib/${entry}`, target, absolute: resolve(root, 'lib', target) });
  }
}
READS.sort((a, b) => a.absolute.localeCompare(b.absolute));
check('the scan finds the reads it is meant to find', READS.length > 0, true);
check('every read is inside the package', READS.filter((read) => !read.absolute.startsWith(root + sep)).map((read) => read.target), []);

// npm always ships these whatever `files` says, so they need no entry.
const ALWAYS = new Set(['package.json', 'README.md', 'LICENSE', 'LICENCE']);
const covered = (absolute) => {
  const rel = relative(root, absolute).split(sep).join('/');
  if (ALWAYS.has(rel)) return true;
  return files.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
};

check('every read outside lib/ is published', READS.filter((read) => !covered(read.absolute)).map((read) => `${read.from} reads ${read.target} and files does not name it`), []);
check('the schema set is one of them', READS.some((read) => read.target === '../schemas/'), true);
const schemaFiles = readdirSync(join(root, 'schemas'), { recursive: true }).map(String).filter((name) => name.endsWith('.schema.json'));
check('and the directory it names is not empty', schemaFiles.length > 0, true);

// --- what the manifest promises ------------------------------------------
// An entry that is not there publishes nothing and hides a typo; the entry that covers
// the schema set is walked, so a schema added under a new name is still shipped.
const expand = (entry) => {
  const target = join(root, entry);
  if (!statSync(target).isDirectory()) return [entry];
  return readdirSync(target, { withFileTypes: true })
    .flatMap((child) => expand(join(entry, child.name)));
};
const published = [];
for (const entry of files) {
  if (!existsSync(join(root, entry))) {
    fails++;
    console.log('FAIL', `files names ${entry}, which does not exist in the package`);
    continue;
  }
  published.push(...expand(entry));
}
const shippedSchemas = published.map(String).filter((name) => name.split(sep).join('/').startsWith('schemas/') && name.endsWith('.schema.json'));
check('every schema in the package is covered by the manifest', shippedSchemas.length, schemaFiles.length);
check('the entry points are published', [
  [manifest.main, covered(resolve(root, manifest.main))],
  [manifest.exports['./cordis.patch.yml'], covered(resolve(root, manifest.exports['./cordis.patch.yml']))],
  [manifest.dsh.bundle.patch, covered(resolve(root, manifest.dsh.bundle.patch))],
], [[manifest.main, true], ['./cordis.patch.yml', true], ['./cordis.patch.yml', true]]);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
