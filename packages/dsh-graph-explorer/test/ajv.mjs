/**
 * ajv, when this machine happens to have it.
 *
 * The plugin ships with no dependencies, and `npm test` has to keep working in a clone with
 * nothing installed. So the schema checks are not tests: they are proofs a maintainer runs, and
 * they SKIP with a reason when ajv cannot be found rather than failing a suite that has no way to
 * be green in a fresh clone.
 *
 * Finding it is the fiddly part, and it is fiddly for a real reason: ajv is not in this package's
 * `node_modules`, it is in whatever directory the maintainer installed it in, and ESM `import()`
 * does not honour `NODE_PATH`. So this resolves the *path* with a `createRequire` rooted at each
 * candidate directory and then imports that path — which is the only portable way to name a
 * package that is not a dependency of the thing importing it.
 *
 * Roots, in order: `ABM_AJV_ROOT`, `NODE_PATH`, this package, the workspace root, and
 * `~/tmp/schema-check` (where this maintainer keeps it). Each is tried as a project directory and
 * as a `node_modules` directory, because those are the two things a person means by "where ajv is".
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const roots = [
  process.env.ABM_AJV_ROOT,
  ...(process.env.NODE_PATH ?? '').split(':'),
  join(HERE, '..'),
  join(HERE, '..', '..', '..'),
  join(process.env.HOME ?? '', 'tmp/schema-check'),
].filter((root) => root);

const bases = roots.flatMap((root) => [join(root, 'index.js'), join(root, '..', 'index.js')]);

/** `{Ajv2020, addFormats, root}` — or null, which is a SKIP and never a failure. */
export async function loadAjv() {
  for (const base of bases) {
    try {
      const require = createRequire(base);
      const Ajv2020 = (await import(pathToFileURL(require.resolve('ajv/dist/2020.js')).href)).default;
      const addFormats = (await import(pathToFileURL(require.resolve('ajv-formats')).href)).default;
      return { Ajv2020, addFormats, root: dirname(base) };
    } catch {
      // Keep looking: the next root may be the one that has it.
    }
  }
  return null;
}
