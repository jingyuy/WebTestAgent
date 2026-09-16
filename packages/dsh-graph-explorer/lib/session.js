/**
 * The append-only store for one exploration run.
 *
 * Five files, matching the target schema's own framing ("reality -> observation ->
 * interpretation -> graph"):
 *
 *   run.json          provenance. Written once, never rewritten: what code, what
 *                     application, what instruction, what model, what starting
 *                     point. Unknown values stay null rather than being guessed at.
 *   observations.jsonl  machine evidence, one record per captured step. IMMUTABLE:
 *                       nothing is ever rewritten, so a later reading cannot
 *                       silently alter the evidence it was derived from.
 *   states.jsonl      the model's semantic reading, each record bound by
 *                     `observation_id` to the evidence it interprets.
 *   capabilities.jsonl  the vocabulary the transitions are phrased in. A capability
 *                       is minted once per name and reused, so "what can this app do"
 *                       is answerable without reading every transition.
 *   transitions.jsonl the edges: a capability applied from one state, landing in
 *                     another. Recorded in the order they were walked, which is the
 *                     only thing that makes a journey reconstructible afterwards.
 *
 * Ids are minted here and never derived from a URL, a selector or an array index.
 * `state_*` and `transition_*` ids are the deliberate exceptions: both are keyed by
 * a *semantic* tuple, so the same identity always resolves to the same id, which makes
 * invariant 4 (state identity uniqueness) structural rather than a check, and keeps a
 * repeated walk from minting a second id for an edge it already recorded.
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
  const capabilitiesPath = join(dir, 'capabilities.jsonl');
  const transitionsPath = join(dir, 'transitions.jsonl');

  let observationCount = 0;
  let stepCount = 0;
  const stateIdByKey = new Map();
  const stateRecordById = new Map();
  /**
   * Which state each observation was read as. This is what lets a transition's
   * endpoints be *derived* instead of typed: if the model had to name its own state
   * ids, a typo would become a dangling reference (invariant 2), and a plausible-
   * looking wrong id would be worse than an error.
   */
  const stateIdByObservation = new Map();
  const capabilityByName = new Map();
  const capabilityById = new Map();
  const transitionIdByKey = new Map();
  const transitionIds = new Set();
  /** Every recorded transition, in walk order. Duplicates kept: a walk may repeat an edge. */
  const walk = [];

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
    // Which application this is about, as declared in config. The one field here
    // the machinery cannot observe, and the one the graph cannot be committed
    // without. Null is the honest "not declared": it makes the commit refuse,
    // which names the setting to supply, whereas an id derived from the start URL
    // would be indistinguishable in the finished graph from a declared one.
    application: provenance.application ?? null,
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
    capabilitiesPath,
    transitionsPath,

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
      // The index is updated on every reading, not only on the first: an observation
      // re-read as its own state must keep pointing at it, and a re-reading that
      // *changes* the answer should win, because the latest reading is the one made
      // against the most complete evidence.
      stateIdByObservation.set(observationId, id);
      if (!minted) {
        // Not a new state: record the sighting as a re-confirmation, preserving the
        // original identity record rather than overwriting it.
        return { id, minted, sighting: append(statesPath, { ...record, kind: 'sighting' }) };
      }
      stateRecordById.set(id, record);
      append(statesPath, { ...record, kind: 'state' });
      return { id, minted, record };
    },

    /** The state an observation was read as, or undefined if it was never read. */
    stateForObservation: (observationId) => stateIdByObservation.get(observationId),

    /**
     * Mint or reuse a capability by NAME.
     *
     * Name is the key, not a slug of the description: capability identity is
     * vocabulary, and the whole point of a capability is that the second, tenth and
     * hundredth use of "log in" is recognisably one behaviour. `kind`, `input` and
     * `output` are only recorded when first seen — a later sighting does not get to
     * silently redefine what an established capability takes and returns.
     */
    addCapability({ name, kind, description, input, output, aliases, notes }) {
      const existing = capabilityByName.get(name);
      if (existing) return { id: existing.id, record: existing, created: false };

      const base = 'cap_' + slugify(name);
      let id = base;
      let suffix = 2;
      while (capabilityById.has(id)) id = base + '_' + suffix++;

      const record = {
        id,
        capability_id: id,
        name,
        capability_kind: kind ?? 'interaction',
        description: description ?? null,
        input: input ?? null,
        output: output ?? null,
        aliases: Array.isArray(aliases) ? aliases : [],
        notes: Array.isArray(notes) ? notes : [],
        first_seen_at: new Date().toISOString(),
      };
      capabilityByName.set(name, record);
      capabilityById.set(id, record);
      append(capabilitiesPath, { kind: 'capability', ...record });
      return { id, record, created: true };
    },

    /**
     * Record an edge: `capability` applied while in `from_state`, landing in
     * `to_state`.
     *
     * Both endpoints are passed in already resolved — this store does not guess what
     * the model meant, and the caller has the observation-to-state index that makes
     * the answer a fact rather than an inference.
     *
     * A repeated walk of the same edge reuses the transition id (no duplicate
     * identities, invariant 1) but is still appended to the walk, because a journey
     * is a sequence of steps and two adds to one cart are two steps.
     */
    recordTransition({
      from_state,
      to_state,
      capability_id,
      capability_name,
      arguments: actionArguments,
      target,
      guard,
      effects,
      apis,
      assertions,
      precondition_list,
      description,
      before_observation,
      after_observation,
      observed_change,
      notes,
    }) {
      const key = JSON.stringify([from_state, to_state, capability_id]);
      let id = transitionIdByKey.get(key);
      const minted = id === undefined;
      if (minted) {
        const base = 'transition_' + slugify(capability_name);
        let candidate = base;
        if (transitionIds.has(candidate)) {
          // The same capability arriving somewhere else is a different edge, so it
          // needs a name a reader can tell apart. Qualifying it with the destination
          // says what distinguishes it; only a third collision falls back to a number.
          const destination = slugify(String(to_state).replace(/^state_/, ''));
          candidate = base + '_' + destination;
          let suffix = 2;
          while (transitionIds.has(candidate)) candidate = base + '_' + destination + '_' + suffix++;
        }
        id = candidate;
        transitionIdByKey.set(key, id);
        transitionIds.add(id);
      }

      // Invariant 5 (a journey is a walk) is checkable here for the first time: the
      // previous step must have ended in the state this one starts from. A break is
      // recorded rather than refused, because re-opening a page mid-run legitimately
      // starts a new strand, and only the model knows which happened.
      const previous = walk.length ? walk[walk.length - 1] : null;
      const chain_break = previous && previous.to_state !== from_state
        ? { previous_transition: previous.id, previous_to_state: previous.to_state, from_state }
        : null;

      const record = {
        id,
        transition_id: id,
        recorded_at: new Date().toISOString(),
        from_state,
        to_state,
        action: {
          capability: capability_id,
          ...(actionArguments && Object.keys(actionArguments).length ? { arguments: actionArguments } : {}),
          ...(target ? { target } : {}),
        },
        guard: guard ?? null,
        effects: effects ?? [],
        apis: apis ?? [],
        assertions: assertions ?? [],
        preconditions: precondition_list ?? [],
        description: description ?? null,
        // What each observation is evidence *for*, which is what the schema's `role`
        // means. The reading before the action is evidence for where the step started;
        // the reading the action itself produced is evidence for the action and for what
        // the action left behind. Labelling the earlier reading "action" claimed that the
        // previous tool call was this transition's action, which it was not.
        evidence: [
          {
            observation: before_observation,
            role: 'identity',
            note: 'the surface as it stood when the action was taken (from_state)',
          },
          {
            observation: after_observation,
            role: 'action',
            note: 'the action itself, and the surface it produced (to_state)',
          },
          {
            observation: after_observation,
            role: 'effect',
            note: 'what the machinery saw change between the two readings',
          },
        ],
        // What the machinery saw change, kept beside what the model said changed.
        // Two independent accounts of one step; agreement between them is the only
        // reason to believe either.
        observed_change: observed_change ?? null,
        notes: notes ?? [],
        chain_break,
      };

      walk.push(record);
      append(transitionsPath, { kind: 'transition', ...record, repeated: !minted });
      return { id, minted, chain_break, record };
    },

    stateCount: () => stateRecordById.size,
    capabilityCount: () => capabilityById.size,
    /** The vocabulary as it stands, which is what a new name is compared against. */
    capabilityNames: () => [...capabilityByName.keys()],
    transitionCount: () => transitionIds.size,
    /** Steps walked, which is not `transitionCount` once an edge is walked twice. */
    walkLength: () => walk.length,
    lastTransition: () => (walk.length ? walk[walk.length - 1] : null),
    observationCount: () => observationCount,
    nextStep: () => ++stepCount,
  };
}
