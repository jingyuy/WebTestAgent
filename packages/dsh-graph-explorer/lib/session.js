/**
 * The append-only store for one exploration run.
 *
 * Three files, three levels of trust, matching the target schema's own framing
 * ("reality -> observation -> interpretation -> graph"):
 *
 *   run.json          provenance. Written once, never rewritten: what code,
 *                     what instruction, what model, what starting point. Unknown
 *                     values stay null rather than being guessed at.
 *   observations.jsonl  machine evidence, one record per captured step. IMMUTABLE:
 *                       nothing is ever rewritten, so a later reading cannot
 *                       silently alter the evidence it was derived from.
 *   states.jsonl      the model's semantic reading, each record bound by
 *                     `observation_id` to the evidence it interprets.
 *
 * Ids are minted here and never derived from a URL, a selector or an array index.
 * `state_*` ids are the one deliberate exception: they are keyed by the *semantic*
 * identity tuple so that the same identity always resolves to the same id, which
 * makes invariant 4 (state identity uniqueness) structural rather than a check.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_DIR_NAME = 'graph-run';

/**
 * The shape a `runDirName` must have: non-empty, relative to the workspace, no
 * `..` segment, no backslash, no NUL.
 *
 * This value is a directory we create and write into, so the one thing it must
 * never be able to do is leave the workspace. `..` is the only way a relative
 * path escapes, and a backslash is the same escape spelled the way Windows
 * spells it — rejected here rather than at the platform, so the rule holds
 * everywhere the plugin runs.
 *
 * Exported as the single source of truth: the config schema declares it, and
 * {@link normalizeRunDirName} enforces it.
 */
export const RUN_DIR_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;

/**
 * Validate and tidy a `runDirName`, or throw explaining exactly what is wrong.
 *
 * A bad value is refused rather than repaired. `path.normalize` would quietly
 * collapse `a/../b` to `b`, which is inside the workspace but is not what anyone
 * wrote — and the same forgiveness applied to `../b` would silently write
 * evidence outside the project. Rewriting a path is how a config typo becomes a
 * surprise on disk, so this only trims the cosmetic `./` prefix and trailing
 * slash, which name the identical directory, and rejects everything else.
 */
export const normalizeRunDirName = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const cleaned = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!cleaned || !RUN_DIR_PATTERN.test(raw)) {
    throw new Error(
      'runDirName ' + JSON.stringify(value) + ' cannot be used: it must be a non-empty path '
      + 'relative to the workspace, with no ".." segment, no backslash and no NUL. It is where '
      + 'the run writes its evidence, so it must not be able to escape the workspace.',
    );
  }
  return cleaned;
};

const slugify = (value) => String(value)
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 40) || 'state';

/**
 * Canonical, order-independent key for a state identity.
 * Any difference in page_type / variant / dimensions is a different state.
 */
export const identityKey = ({ page_type, variant, dimensions }) => {
  const dims = dimensions && typeof dimensions === 'object'
    ? Object.keys(dimensions).sort().map((key) => key + '=' + String(dimensions[key]))
    : [];
  return JSON.stringify([String(page_type ?? ''), variant ? String(variant) : '', dims]);
};

export function createRun({ cwd, runDirName = RUN_DIR_NAME, provenance = {} }) {
  const dir = join(cwd, runDirName);
  const evidenceDir = join(dir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const observationsPath = join(dir, 'observations.jsonl');
  const statesPath = join(dir, 'states.jsonl');

  let observationCount = 0;
  let stepCount = 0;
  const stateIdByKey = new Map();
  const stateRecordById = new Map();

  const append = (path, record) => {
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
    return record;
  };

  // Provenance, written once and never rewritten. Every field answers "could
  // someone reproduce this run?" — what code, what instruction, what model,
  // what starting point. A graph that cannot be tied to those is a claim
  // without a warrant, and the schema's version-coherence invariant cannot be
  // checked at all if the producing versions were never recorded. Fields we
  // genuinely cannot see stay null rather than being guessed at: a null is an
  // honest "unknown", a plausible-looking default is a false fact.
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    started_at: new Date().toISOString(),
    cwd,
    start_url: provenance.startUrl ?? null,
    instruction: provenance.instruction ?? null,
    max_steps: provenance.maxSteps ?? null,
    provider: provenance.provider ?? null,
    model: provenance.model ?? null,
    session_id: provenance.sessionId ?? null,
    agent_preset: provenance.agentPreset ?? null,
    // Resolved from our own manifest at load time, never hardcoded — a literal
    // here silently goes stale the first time the package is bumped, which
    // makes every run.json actively claim the wrong version.
    plugin: provenance.plugin ?? null,
  }, null, 2) + '\n', 'utf8');

  return {
    dir,
    evidenceDir,
    observationsPath,
    statesPath,

    /** Allocate the next machine-evidence record. Immutable once written. */
    addObservation({ tool, toolArgs, phase, capture, error, screenshot }) {
      observationCount += 1;
      const id = 'obs_' + String(observationCount).padStart(4, '0');
      return append(observationsPath, {
        id,
        seq: observationCount,
        recorded_at: new Date().toISOString(),
        tool,
        phase,
        tool_arguments: toolArgs,
        url: capture ? capture.url : null,
        title: capture ? capture.title : null,
        capture: capture ?? null,
        capture_error: error ?? null,
        screenshot: screenshot ?? null,
      });
    },

    /**
     * Bind a semantic reading to evidence. A state is minted on first sight of an
     * identity tuple and reused afterwards, so two observations of the same
     * identity can never produce two state ids.
     */
    addState({ observationId, page_type, variant, dimensions, summary, elements, detection, confidence, model_status }) {
      const key = identityKey({ page_type, variant, dimensions });
      let id = stateIdByKey.get(key);
      const minted = id === undefined;
      if (minted) {
        // The slug is built from the identity tuple — page_type, variant and
        // dimensions — never from a route, a selector or an index. It is derived
        // from meaning so a reviewer can read it, and the numeric suffix is only
        // reached when two genuinely different identities would otherwise collide.
        const dimSlugs = dimensions && typeof dimensions === 'object'
          ? Object.keys(dimensions).sort().map((name) => slugify(name) + '_' + slugify(dimensions[name]))
          : [];
        const base = [slugify(page_type), variant ? slugify(variant) : null, ...dimSlugs]
          .filter(Boolean)
          .join('_');
        let candidate = 'state_' + base;
        let suffix = 2;
        while (stateRecordById.has(candidate)) candidate = 'state_' + base + '_' + suffix++;
        id = candidate;
        stateIdByKey.set(key, id);
      }
      const record = {
        id,
        state_id: id,
        first_seen_at: new Date().toISOString(),
        observation_id: observationId,
        identity: {
          page_type,
          ...(variant ? { variant } : {}),
          ...(dimensions && Object.keys(dimensions).length ? { dimensions } : {}),
        },
        identity_key: key,
        summary: summary ?? null,
        elements: elements ?? [],
        detection: detection ?? [],
        confidence: typeof confidence === 'number' ? confidence : null,
        status: model_status ?? 'observed',
        evidence: minted ? 'first_observation' : 'repeat_observation',
      };
      if (!minted) {
        // Not a new state: record the sighting as a re-confirmation, preserving the
        // original identity record rather than overwriting it.
        return { id, minted, sighting: append(statesPath, { ...record, kind: 'sighting' }) };
      }
      stateRecordById.set(id, record);
      append(statesPath, { ...record, kind: 'state' });
      return { id, minted, record };
    },

    stateCount: () => stateRecordById.size,
    observationCount: () => observationCount,
    nextStep: () => ++stepCount,
  };
}
