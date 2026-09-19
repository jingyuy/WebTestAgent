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
 *                     `observation_id` to the evidence it interprets. A reading
 *                     also carries what its surface *offered* and the walk did
 *                     not take (`affordances[]`): the only claim in the log
 *                     about an absence, and one that can only be made while the
 *                     page offering it is still on screen.
 *   capabilities.jsonl  the vocabulary the transitions are phrased in. A capability
 *                       is minted once per name and reused, so "what can this app do"
 *                       is answerable without reading every transition.
 *                       Also where a step of a behaviour is written down
 *                       (`kind: "realization_step"`): which browser action
 *                       realises which step of which behaviour, at which position
 *                       in the walk. A second record kind in the same file rather
 *                       than a sixth file, because a step of a behaviour is a
 *                       claim about the vocabulary — what the behaviour is made
 *                       of — and the commit reads the two together.
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

/**
 * The two readings a recorded step was made from, in the roles the recorder writes them
 * in: the surface as it stood when the action was taken, then the one the action produced.
 *
 * A step is *one action read from two readings*, and this is that sentence as a value.
 * Nothing else about two records of one edge is stable enough to identify a step by: the
 * walk has no other way to tell "I said this again" from "I did it again", and the
 * readings are the browser's own ids rather than anything the model supplied. Two records
 * naming one edge out of one pair of readings are one step stated twice, however far apart
 * in time they were written.
 *
 * `null` for a reading that is not there, so a record with no evidence cannot compare equal
 * to another by accident: a caller compares each reading with the one it is looking for
 * rather than trusting the absence of both.
 */
const stepReadings = (record) => {
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
  const reading = (role) => {
    const reference = evidence.find((ref) => ref?.role === role);
    return typeof reference?.observation === 'string' && reference.observation ? reference.observation : null;
  };
  return [reading('identity'), reading('action')];
};

/**
 * Whether `statement` is `previous` stated again: the same edge out of the same two readings.
 *
 * The rule is here, in one function, because two readers have to agree on it and only one of them
 * was there when it happened. The store asks it as it records, against the walk's last step; the
 * commit asks it of the log, against the record written before this one. Both are asking about the
 * same two facts — the edge id and the pair of the browser's own reading ids — so both get the same
 * answer, and a log written by a version that did not know the rule gives the same answer as one
 * written by this one. That is the point: *what the log says* decides, and the `restatement` field
 * on the record is the recorder's own note about what it did, not the evidence a later commit needs.
 *
 * `before` has to be a real reading. `stepReadings` answers `null` for a reading a record does not
 * have, and two records that both have none must not compare equal — a step with no readings is not
 * a step this question can be asked about at all.
 */
export const isRestatement = (previous, { id, before, after }) => {
  if (!previous) return false;
  if ((previous.transition_id ?? previous.id) !== id) return false;
  if (typeof before !== 'string' || !before) return false;
  const [previousBefore, previousAfter] = stepReadings(previous);
  return previousBefore === before && previousAfter === after;
};

/**
 * Which records of a log are the walk stating a step again — one flag per record, in log order.
 *
 * The walk's last step is always the record written most recently (a step stated again replaces the
 * walk's account of that step rather than adding one), so the step a record was measured against is
 * the record before it in the log. A commit that arrives later has nothing but the log, and this is
 * the log read for that fact.
 *
 * Deriving it rather than trusting the `restatement` field is what lets the commit read a log that
 * this version did not write. The field is what the recorder believed at the time; the records are
 * what happened. A run recorded before the field existed — or before the rule existed, when a
 * corrective re-record was written as a *step* — commits as one step and one walk anyway, because
 * two records naming one edge out of one pair of readings are one step stated twice whenever they
 * were written.
 */
export const restatementsOf = (records) => records.map((record, index) => {
  const [before, after] = stepReadings(record);
  return isRestatement(index ? records[index - 1] : null, {
    id: record?.transition_id ?? record?.id,
    before,
    after,
  });
});

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
  /**
   * One realisation per (behaviour, edge), keyed by both.
   *
   * A step of a behaviour is a step *of that behaviour* — the same edge realised as a
   * step of `login` is one step however many times the edge is walked. So the key is the
   * pair, exactly as `recordTransition` keys an edge by its endpoints: the same edge
   * walked twice is the same step, and a second record for it is the walk moving on
   * rather than a second step appearing.
   */
  const realizationByKey = new Map();
  /**
   * How many affordances the run's readings have claimed.
   *
   * Kept here rather than derived from `stateRecordById` because a reading of a state
   * already seen is a *sighting*, and a sighting's affordance is a claim about the same
   * surface made later — real, and not in the canonical record. Counted only when the
   * record lands, for the reason every other counter here is: a claim the log does not
   * contain is not a claim the run made.
   */
  let affordanceCount = 0;
  const transitionIdByKey = new Map();
  const transitionIds = new Set();
  /**
   * Every step of the walk, in the order the steps were taken. An edge may be walked twice, so
   * the same id can appear twice — but a step *stated* twice is one step holding the walk's
   * latest account of itself, and replaces its entry here rather than adding one. The log keeps
   * both records either way; see `recordTransition`.
   */
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
        realizationByKey.clear();
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
    addState({ observationId, page_type, variant, dimensions, summary, elements, detection, confidence, model_status, affordances }) {
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
        // What the surface offered and the walk did not take. Recorded on the reading rather
        // than as its own line, because it is part of what that reading claimed about that
        // surface — and it is the only claim in the vocabulary that is about an absence, so
        // the reading is the only moment it can be made: the page has to be on screen to be
        // read for what it offers, and the first step that performs one of these refutes it.
        // 0.1's `state.schema.json` is `additionalProperties: false` and declares no such key,
        // so this is a claim the log holds and `graph.json` cannot carry; the commit counts
        // them so their absence from the document is a stated fact rather than a silent drop.
        ...(Array.isArray(affordances) && affordances.length ? { affordances } : {}),
      };
      // Written before it is remembered, and nothing is remembered if it was not
      // written. The order matters for the first sighting in particular: a state read
      // as new whose `kind: "state"` line never landed would be a state the commit
      // only ever sees as a *sighting*, and a sighting of a state with no canonical
      // record is dropped — so it would disappear from the finished graph after the
      // digest had already reported it as recorded.
      const written = { ...record, kind: minted ? 'state' : 'sighting' };
      if (!append(statesPath, written)) return null;
      affordanceCount += Array.isArray(affordances) ? affordances.length : 0;
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
     * Write down that one edge realises one step of one behaviour.
     *
     * `capabilities.jsonl` already says what a behaviour is *composed of* — which
     * capabilities it contains — and that is a claim about capabilities. This records the
     * other half, which is a claim about a browser: the verb the step performs, the
     * element it performs it on, and the value it puts there. The two are not the same
     * question and neither derives the other. A composition is a list of capability ids,
     * and the verb a step performs is not in the id: `cap_login` is `fill_login_email` and
     * the schema's vocabulary starts at `fill`, so a projection asked to expand a
     * behaviour into steps has to be told the verb rather than guess it from a name.
     *
     * Called with the edge already recorded, so the record can name the step it came from
     * and where in the walk that step stands. Both are needed downstream and neither is
     * recoverable later: the walk index is what orders a behaviour's steps, and the
     * transition id is what says which edge — which reading, which states — the step was
     * made of. The transition id is deliberately not minted here; `recordTransition` owns
     * that, and a step naming an edge the log does not have would be the same dangling
     * reference the commit refuses everywhere else.
     *
     * `walk_index` is the newest position of the edge, not the first: a re-walk moves the
     * step, because the walk is where the run is now and the behaviour's edge is its last
     * step's destination (D12). The earlier record stays in the log — nothing here
     * rewrites — and the index holds the current view, which is what a commit reads.
     */
    addRealizationStep(capabilityId, step, { transitionId, walkIndex } = {}) {
      if (!capabilityById.has(capabilityId)) return null;
      const key = JSON.stringify([capabilityId, transitionId ?? null]);
      const existing = realizationByKey.get(key);
      const record = {
        kind: 'realization_step',
        capability_id: capabilityId,
        // The edge this step is, and where the walk had got to when it was made. Both are
        // facts about the run rather than about the step, and both are written here because
        // they are the only link back from a step of a behaviour to the evidence it came
        // from.
        transition_id: transitionId ?? null,
        walk_index: Number.isInteger(walkIndex) ? walkIndex : null,
        ...step,
        first_seen_at: new Date().toISOString(),
      };
      if (!append(capabilitiesPath, record)) return null;
      realizationByKey.set(key, record);
      return { record, repeated: existing !== undefined, first_walk_index: existing?.walk_index ?? null };
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
     *
     * A step stated again is the one thing that is not a step. The record names the edge
     * it moves along and the two readings it was made from, and those readings are the
     * step's evidence: the same edge out of the same pair is one action, and one action is
     * one step — a walk cannot be in the same place twice without moving. So a second
     * statement about it replaces the walk's account of that step, in the position it was
     * taken, and cannot break a chain, because nothing moved. The log keeps both records:
     * the earlier one is the record of what was said the first time, which is what makes
     * "evidence is allowed to be wrong" actionable — a step whose own account was wrong is
     * corrected by stating it again, and the machinery reads the walk's last word about it.
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
      //
      // A step stated again is not a step, so it is measured against nothing: the walk is
      // where it was, and the record's `from_state` is the state that step started from
      // rather than where the run stands. Reading that as a break is what turned one
      // corrected step into a second journey strand.
      //
      // The rule itself is `isRestatement`, which is also what the commit reads the log with.
      // A walk that decided this one way while the commit decided it another is how a
      // correction gets recorded and then ignored.
      const previous = walk.length ? walk[walk.length - 1] : null;
      const restated = isRestatement(previous, { id, before: before_observation, after: after_observation });
      const chain_break = previous && !restated && previous.to_state !== from_state
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
        // Whether this record is the walk stating a step it has already taken, out of the same
        // two readings. It is the only record here that is not a step: it holds the step's
        // position rather than taking one, so a reader that cuts the walk into journeys has to
        // obey this flag the way it obeys `chain_break` — the record is evidence, and what it is
        // evidence *of* is one step that did not move.
        restatement: restated,
      };

      // The walk advances only once the step is in the log, for the same reason the
      // indexes are: a step the commit cannot see must not decide what the next step's
      // chain_break is measured against. A restatement moves nothing — it takes the place of
      // the step it restates, which is the step the walk is already standing on, so the next
      // step is measured against the account the walk now holds and not against the one it
      // replaced.
      if (!append(transitionsPath, { kind: 'transition', ...record, repeated: !minted })) return null;
      if (minted) {
        transitionIdByKey.set(key, id);
        transitionIds.add(id);
      }
      if (restated) walk[walk.length - 1] = record;
      else walk.push(record);
      return { id, minted, chain_break, restatement: restated, record };
    },

    stateCount: () => stateRecordById.size,
    /**
     * How many affordances the readings have claimed so far.
     *
     * Reported in every reading's digest, because the claim it counts is the one that
     * does not exist unless somebody makes it: the graph cannot derive "this surface
     * offers a password reset" from anything it saw, and a walk that never says so is
     * a walk whose model looks complete and proves less. Zero is a number the model has
     * to be able to see, which is the only way it can decide the walk really had
     * nothing untaken rather than that the reading forgot.
     */
    affordanceCount: () => affordanceCount,
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
     *
     * One entry per step: a step the walk stated again holds the latest account of itself here,
     * and the account it replaced is in the log rather than in this list. The list is what the
     * run *is* — where the walk stands and what each step of it changed — and the log is what was
     * said, which is the difference between the two.
     */
    transitions: () => [...walk],
    /**
     * Steps walked, which is not `transitionCount` once an edge is walked twice — and which a
     * restatement does not change at all, because a step said again is the same step.
     */
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
