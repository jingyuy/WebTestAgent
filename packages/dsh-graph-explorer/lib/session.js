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
 *
 * Two rules keep the log and the in-memory indexes from ever disagreeing:
 *
 * 1. **The memory never runs ahead of the log.** Every mutating method writes its
 *    record first and only then updates the maps, and returns `null` when the write
 *    did not happen. A state whose `kind: "state"` line never landed but which the
 *    index remembers would be read by the commit as a *sighting* of a state with no
 *    canonical record — a state that silently disappears from the finished graph.
 * 2. **A store failure is never allowed to break the browser action it is
 *    recording.** Writing can fail for reasons that have nothing to do with the run:
 *    the directory can be deleted or moved while the agent is still working in it,
 *    and `appendFileSync` cannot recreate a parent that is gone. So a missing
 *    directory is repaired and the write retried, and a failure that cannot be
 *    repaired is reported — never thrown.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * The shared id slug: lowercase, `_`-separated, ≤40 characters.
 *
 * Exported because `graph_commit` mints element ids the same way (`element_` + the
 * purpose) and a second implementation of the same convention is a second chance for
 * the two to disagree about what an id for the same thing looks like.
 */
export const slugify = (value) => String(value)
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

export function createRun({ cwd, runDirName = RUN_DIR_NAME, provenance = {}, onStoreError = null }) {
  const dir = join(cwd, runDirName);
  const evidenceDir = join(dir, 'evidence');
  // Creating the run's own directory is not a repair, so it is done here rather
  // than left to the first write: writing at run start is what *starts* the run,
  // and reporting "the directory was missing" about a directory that was never
  // there yet would be a false alarm on every healthy run. A failure is swallowed
  // because the write below reports it properly, with the reason.
  try {
    mkdirSync(evidenceDir, { recursive: true });
  } catch { /* reported by the run.json write, which heals first */ }

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

  /**
   * What went wrong with the store, and whether it is still going wrong.
   *
   * `lastWriteProblem` is cleared by a write that succeeds, because the question the
   * caller asks is "is the log keeping up right now?", not "has this run ever
   * stumbled" — a store that has recovered should not refuse the next reading. The
   * running total is kept separately and never cleared, because a successful write
   * cannot un-lose an earlier record: the digest reports the count so a graph with a
   * gap in it says so instead of looking merely short.
   */
  let lastWriteProblem = null;
  let totalWriteFailures = 0;
  let recreations = 0;
  let repairing = false;

  const describe = (error) => (error instanceof Error ? error.message : String(error));

  const report = (problem) => {
    try {
      onStoreError?.(problem);
    } catch {
      // Reporting a store problem must not become a store problem.
    }
  };

  /**
   * Put back what a vanished run directory took with it.
   *
   * Deleting or moving the directory mid-run is the realistic case: the agent is
   * still working and `appendFileSync` has no parent to write into. Recreating it is
   * the whole remedy, plus `run.json`, which is the one record nothing else can
   * reconstruct — written back verbatim, `started_at` included, because this is the
   * same run and not a new one. Records made before this point are gone from the new
   * directory (they are in the old one, if it was moved rather than deleted), so what
   * the store remembered about them is dropped too and the repair is announced rather
   * than performed silently.
   */
  const heal = (trigger) => {
    if (repairing) return { ok: false, reason: 'a repair is already in progress' };
    repairing = true;
    try {
      const gone = !existsSync(dir);
      mkdirSync(evidenceDir, { recursive: true });
      // `run.json` is the one record nothing else can reconstruct, so a directory
      // without it is not a run directory and the file is written back from this
      // run's own provenance either way. It is announced even when the directory
      // itself survived, because a file appearing that the run did not just write is
      // exactly the kind of thing that should not happen quietly.
      const manifestMissing = !existsSync(join(dir, 'run.json'));
      if (manifestMissing) writeFileSync(join(dir, 'run.json'), runRecordText, 'utf8');
      if (gone) recreations += 1;
      if (gone) {
        // The log the commit will read begins at this point, so nothing may be
        // remembered that was written into the directory that went away. Clearing is not
        // tidiness: an index that survived would answer `addState` with "already seen"
        // for a state whose canonical record is gone, and a repeat is written as a
        // *sighting* — and a sighting of a state with no canonical record is dropped by
        // the commit, so the state would disappear from the finished graph after the
        // digest had already counted it.
        //
        // The counters are deliberately NOT reset: an id the digest has already reported
        // must never come back attached to a different record, so it stays `obs_0007`
        // even though the log now begins with it.
        stateIdByKey.clear();
        stateRecordById.clear();
        stateIdByObservation.clear();
        capabilityByName.clear();
        capabilityById.clear();
        transitionIdByKey.clear();
        transitionIds.clear();
        walk.length = 0;
      }
      if (gone || manifestMissing) {
        report({
          kind: 'recreated',
          path: dir,
          message: gone
            ? 'the run directory was missing and has been recreated, with run.json restored'
            : 'run.json was missing and has been written back from this run\'s own provenance',
          at: new Date().toISOString(),
          trigger,
        });
      }
      return { ok: true, recreated: gone };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    } finally {
      repairing = false;
    }
  };

  /**
   * The one place this store touches the disk. Returns whether the bytes landed, and
   * never throws: a record that cannot be written is a fact about the run, not a
   * reason to break the browser action that produced it.
   */
  const write = (path, contents, { append = true } = {}) => {
    const put = () => (append ? appendFileSync(path, contents, 'utf8') : writeFileSync(path, contents, 'utf8'));
    const attempt = () => {
      put();
      lastWriteProblem = null;
      return true;
    };
    try {
      return attempt();
    } catch (firstError) {
      // A missing parent is the repairable case, and the likely one. Anything the
      // repair cannot fix (the path is a file, the volume is read-only) is reported
      // once, with the reason the repair failed, and the run carries on without
      // pretending the record exists.
      const repaired = heal(`writing ${path}: ${describe(firstError)}`);
      let error = firstError;
      if (repaired.ok) {
        try {
          return attempt();
        } catch (retryError) {
          error = retryError;
        }
      }
      totalWriteFailures += 1;
      lastWriteProblem = {
        path,
        message: describe(error),
        at: new Date().toISOString(),
        repaired: repaired.ok,
        repair_error: repaired.ok ? null : repaired.reason,
      };
      report({ kind: 'unwritten', ...lastWriteProblem, trigger: `writing ${path}` });
      return false;
    }
  };

  /** Append one record. `false` means it is not in the log, so callers must not keep it. */
  const append = (path, record) => write(path, JSON.stringify(record) + '\n');

  // Provenance, written once and never rewritten. Every field answers "could
  // someone reproduce this run?" — what code, what instruction, what model,
  // what starting point. A graph that cannot be tied to those is a claim
  // without a warrant, and the schema's version-coherence invariant cannot be
  // checked at all if the producing versions were never recorded. Fields we
  // genuinely cannot see stay null rather than being guessed at: a null is an
  // honest "unknown", a plausible-looking default is a false fact.
  const runRecordText = JSON.stringify({
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
  }, null, 2) + '\n';
  // Through the same path as every other write: a workspace that cannot be written
  // to is a run that cannot record anything, and that is a fact to report at the
  // first step rather than an exception thrown out of a browser action.
  write(join(dir, 'run.json'), runRecordText, { append: false });

  return {
    dir,
    evidenceDir,
    observationsPath,
    statesPath,
    capabilitiesPath,
    transitionsPath,

    /**
     * The most recent write that did not land, or null if the log is keeping up. A
     * non-null answer means the run's evidence is incomplete *right now*, so the tools
     * that record refuse rather than hand the model a reading whose evidence the log
     * does not contain.
     */
    writeProblem: () => lastWriteProblem,
    /** How many records this run failed to write, ever. Sticky: a gap is a gap. */
    writeFailures: () => totalWriteFailures,
    /** How many times a vanished run directory had to be recreated. */
    recreations: () => recreations,

    /** Allocate the next machine-evidence record. Immutable once written. */
    addObservation({ tool, toolArgs, phase, actionIndex, capture, error, screenshot, settle }) {
      const seq = observationCount + 1;
      const id = 'obs_' + String(seq).padStart(4, '0');
      // A reading is taken *of* something, and the schema's own vocabulary for that is
      // `evidenceRef.role` ('identity' | 'action' | 'effect' | …). This is the same fact
      // written on the raw record, because the record is what a reader who has only
      // observations.jsonl sees: `action_id` says which step this reading was taken after,
      // so every reading is attributable to a step rather than to the run as a whole. The
      // `after` phase is what capture() writes — the reading is taken once the action has
      // been performed — and the step number is the one the action consumed, not a new one.
      const actionId = Number.isInteger(actionIndex) && actionIndex > 0
        ? 'action_' + String(actionIndex).padStart(4, '0')
        : null;
      const record = {
        id,
        seq,
        recorded_at: new Date().toISOString(),
        tool,
        phase,
        tool_arguments: toolArgs,
        ...(actionId ? { action_id: actionId, action_index: actionIndex, observation_role: 'after_action' } : {}),
        url: capture ? capture.url : null,
        title: capture ? capture.title : null,
        capture: capture ?? null,
        capture_error: error ?? null,
        // How the reading was taken, from the page's own account of itself: whether it
        // ever stopped moving, how long it was watched, and what it was still waiting
        // for. This is what makes a raced step distinguishable from a self-loop when
        // the two captures look identical — without it, "nothing changed" is a claim
        // the record cannot support, and the cross-check has to hedge about which of
        // the two it is looking at.
        settle: settle ?? null,
        screenshot: screenshot ?? null,
      };
      // The count moves only when the record does, so a step that could not be
      // written does not burn its id: the next one lands in the log under the id this
      // one would have had, and the log stays contiguous. The failure itself is
      // reported instead (see `writeFailures`), which is the honest account of it —
      // an unmade record is not evidence, so it has no place in the evidence log.
      if (!append(observationsPath, record)) return null;
      observationCount = seq;
      return record;
    },

    /**
     * Bind a semantic reading to evidence. A state is minted on first sight of an
     * identity tuple and reused afterwards, so two observations of the same
     * identity can never produce two state ids.
     */
    addState({ observationId, page_type, variant, dimensions, summary, elements, detection, confidence, model_status }) {
      const key = identityKey({ page_type, variant, dimensions });
      const existing = stateIdByKey.get(key);
      const minted = existing === undefined;
      let id = existing;
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
      // Written before it is remembered, and nothing is remembered if it was not
      // written. The order matters for the first sighting in particular: a state read
      // as new whose `kind: "state"` line never landed would be a state the commit
      // only ever sees as a *sighting*, and a sighting of a state with no canonical
      // record is dropped — so it would disappear from the finished graph after the
      // digest had already reported it as recorded.
      const written = { ...record, kind: minted ? 'state' : 'sighting' };
      if (!append(statesPath, written)) return null;
      stateIdByKey.set(key, id);
      if (minted) stateRecordById.set(id, record);
      // The index is updated on every reading, not only on the first: an observation
      // re-read as its own state must keep pointing at it, and a re-reading that
      // *changes* the answer should win, because the latest reading is the one made
      // against the most complete evidence.
      stateIdByObservation.set(observationId, id);
      if (!minted) {
        // Not a new state: record the sighting as a re-confirmation, preserving the
        // original identity record rather than overwriting it.
        return { id, minted, sighting: written };
      }
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
     *
     * `composed_of` is the exception, and it is a deliberate one: which steps a
     * behaviour was built from is usually only visible AFTER they have been walked, so
     * the model often has the composition in hand on a later call than the one that
     * named the behaviour. A later non-empty composition is therefore appended as its
     * own record — `kind: 'capability_composition'`, naming the capability it belongs
     * to — rather than written into the first one. The log is append-only for the same
     * reason the rest of it is: a claim that arrived later is a second claim, not a
     * revision of the first, and the commit is where they are reconciled.
     */
    addCapability({ name, kind, description, input, output, aliases, notes, composed_of }) {
      const composition = Array.isArray(composed_of) ? composed_of.filter((id) => typeof id === 'string' && id) : [];
      const existing = capabilityByName.get(name);
      if (existing) {
        const known = new Set(Array.isArray(existing.composed_of) ? existing.composed_of : []);
        const added = composition.filter((id) => !known.has(id));
        // A later declaration that only says `composite` is still news: the kind is what
        // makes the schema's prose true of the object, and a capability named before its
        // structure was understood would otherwise never be able to become a composite.
        const kindUpgrade = kind === 'composite' && existing.capability_kind !== 'composite' ? 'composite' : null;
        if (!added.length && !kindUpgrade) return { id: existing.id, record: existing, created: false, composition_added: [] };
        const record = {
          ...existing,
          composed_of: [...known, ...added],
          ...(kindUpgrade ? { capability_kind: kindUpgrade } : {}),
        };
        const written = {
          kind: 'capability_composition',
          capability_id: existing.id,
          name,
          composed_of: record.composed_of,
          added,
          ...(kindUpgrade ? { capability_kind: kindUpgrade } : {}),
          first_seen_at: new Date().toISOString(),
        };
        if (!append(capabilitiesPath, written)) return null;
        // The index holds the merged view, so a second call with the same composition is a
        // no-op and a call that adds a step appends only what is new.
        capabilityByName.set(name, record);
        capabilityById.set(existing.id, record);
        return { id: existing.id, record, created: false, composition_added: added };
      }

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
        composed_of: composition,
        aliases: Array.isArray(aliases) ? aliases : [],
        notes: Array.isArray(notes) ? notes : [],
        first_seen_at: new Date().toISOString(),
      };
      // Written before it is remembered. A capability the vocabulary already
      // remembers but the log does not have would be handed back to the model as
      // `created: false` — an id for a behaviour the finished graph has never heard
      // of, and a transition referencing it would dangle.
      if (!append(capabilitiesPath, { kind: 'capability', ...record })) return null;
      capabilityByName.set(name, record);
      capabilityById.set(id, record);
      return { id, record, created: true, composition_added: composition };
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
      journey_name,
      feature,
      action_id,
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
        // The step's own name, when the model gave it one. A journey named by the run's
        // instruction is a run, not a walk, and the name is a claim like any other: it is
        // written beside the step it came from so the commit can attribute it to the walk
        // that step is part of, and so a reader of the log can see where it came from.
        journey_name: typeof journey_name === 'string' && journey_name.trim() ? journey_name.trim() : null,
        // The feature this step is part of, by the model's own words. Features have no
        // machine source (nothing in a page says what a product is for), so the model
        // supplies the vocabulary and the commit assembles the graph's `features[]` from
        // the entities that claim one.
        feature: typeof feature === 'string' && feature.trim() ? feature.trim() : null,
        // Which action this step *was*, by the reading's own id. The reading the action
        // produced carries it; keeping it on the step is what lets the graph say which
        // reading documents the step, rather than only which reading came after it.
        action_id: typeof action_id === 'string' && action_id ? action_id : null,
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

      // The walk advances only once the step is in the log, for the same reason the
      // indexes are: a step the commit cannot see must not decide what the next step's
      // chain_break is measured against.
      if (!append(transitionsPath, { kind: 'transition', ...record, repeated: !minted })) return null;
      if (minted) {
        transitionIdByKey.set(key, id);
        transitionIds.add(id);
      }
      walk.push(record);
      return { id, minted, chain_break, record };
    },

    stateCount: () => stateRecordById.size,
    /**
     * Every reading bound to a state, in the order they were made.
     *
     * `states()` carries one record per identity, so it names the reading a state was first seen
     * in and says nothing about the readings after it — and those later readings are evidence for
     * the same state, which is the whole reason the store records them. Derived from the index
     * rather than kept beside it, so a rebuilt run directory cannot leave a second index to
     * forget to clear.
     */
    observationsForState: (stateId) => [...stateIdByObservation.entries()]
      .filter(([, id]) => id === stateId)
      .map(([observationId]) => observationId),
    /**
     * Every state record this run has written, in the order they were first seen.
     *
     * A state record is not only an identity: it is also the run's element declarations, and
     * the declaration is the only thing a reference can be resolved against. A tool that has
     * to answer "does this name exist yet?" — a detection naming an element, an effect whose
     * target must become an element id — needs the records, not the count.
     */
    states: () => [...stateRecordById.values()],
    capabilityCount: () => capabilityById.size,
    /** The vocabulary as it stands, which is what a new name is compared against. */
    capabilityNames: () => [...capabilityByName.keys()],
    /**
     * The id a capability name already has, or `null`.
     *
     * `composed_of` is written in names — the model thinks in behaviours, not in ids — and the
     * schema requires the ids. Resolving here means a composite that names a behaviour nothing
     * has recorded is refused while the model can still record the step, instead of being
     * written as a reference the commit would have to drop.
     */
    capabilityIdFor: (name) => capabilityByName.get(name)?.id ?? null,
    transitionCount: () => transitionIds.size,
    /**
     * The steps this run has walked, in order, as they were recorded.
     *
     * `transitionCount` counts edges and `walkLength` counts steps, and neither answers the
     * question the digest asks about a step: what did it *change*. The effects are the only place
     * the run says that, and a variable moved three steps ago is still a variable the graph has to
     * be able to hold — so the records are exposed rather than only the counters.
     */
    transitions: () => [...walk],
    /** Steps walked, which is not `transitionCount` once an edge is walked twice. */
    walkLength: () => walk.length,
    /**
     * The feature names the run has claimed, in the order they were first used.
     *
     * A feature is vocabulary, like a capability name and unlike a state: the same words
     * used on two steps are one feature, and the commit's job is to decide which entities
     * belong to it. Exposed so a tool can answer "what have you called things" — the
     * question that keeps a run from recording `login` and `sign in` as two features.
     */
    featureNames: () => [...new Set(walk.map((record) => record.feature).filter(Boolean))],
    /** The journey names the run has claimed, in the order they were first used. */
    journeyNames: () => [...new Set(walk.map((record) => record.journey_name).filter(Boolean))],
    lastTransition: () => (walk.length ? walk[walk.length - 1] : null),
    observationCount: () => observationCount,
    nextStep: () => ++stepCount,
  };
}
