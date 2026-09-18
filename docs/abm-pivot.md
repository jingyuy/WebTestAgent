# Pivot: generate an Application Behavior Model beside the graph

Status: **plan, not started.** Baseline: plugin `0.1.22`, branch
`fix/graph-explorer-lossless-and-state-entered` (`8738f52`), deployed to the `graph` and
`web` profiles. Work happens on **`feat/application-behavior-model`**, branched off `8738f52`
(not `main`, which is three commits behind on `commit.js`/`generate.js`).

## 0. Decisions taken

| # | Decision | What it changes in this plan |
| --- | --- | --- |
| **D1** | **Two artifacts.** `graph.json` stays exactly as it is, as a fallback; the ABM is a second document beside it. | §1: the pipeline writes two documents from one evidence log, and the two are **independent readings**, not a projection of each other. §5: Phase 4 (the generator) drops out of the critical path. |
| **D2** | **Copy the schemas in-repo and modify them here.** The external schema is no longer authoritative for this project. | §2: a vendored `schemas/` tree, a fork policy, and a validation strategy that does not cost the plugin its zero-dependency `npm test`. §3: `entities` / `state_variables` / `actors` get **real top-level arrays** instead of `metadata.extra`. |
| **D3** | **`composed_of` demoted.** `realization.steps[]` is the default home for a behaviour's mechanics. | §3: P2/P3 rules. `composed_of` survives only for a behaviour genuinely built from other behaviours. |
| **D4** | **A goal-less run keeps its walk as a journey.** The ABM always carries ≥1 journey, with `goal_stated: false` when the run named no goal. No `paths[]` container. | §3: the walk has exactly one home. Rules P7/P11 depending on a journey's presence must be written to hold for a `goal_stated: false` journey. |

## 1. Two documents, one evidence log

```
        browser_* tools (dsh-browser owns the page)
                  │
                  ▼
   observations.jsonl + evidence/*.png          evidence, immutable, append-only
                  │
                  ▼
   states · capability-steps · transitions      the model's readings, append-only candidate log
                  │
                  ▼
          graph_commit                          the only thing that decides what is knowledge
             ├──────────────┬───────────────────┐
             ▼              ▼                   ▼
      graph.json     application-model.json   commit_report.json
      (fallback,      (the product,            (says what each
       ABG v0.1)       ABM v0.2)               document contains
                                               and what it refused)
```

**The two documents are read from the same logs, not derived from each other.** This is the
point of D1 and it is worth being explicit about, because the tempting shortcut is wrong:

> A `graph.json → application-model.json` projection is **not a fallback**. If the ABM is
> derived from the graph, then a defect in the ABM's reading is also a defect in the graph,
> and there is nothing to fall back *to*. A fallback has to be produced from the evidence
> independently, by machinery that a change in the ABM's vocabulary cannot reach.

The machinery already supports this: `graph_transition` can name a **step capability** and its
**behaviour** in one call (`capability: "submit_login"`, `capability_behaviour: "login"`, added
in 0.1.21/0.1.22), and the store's `addCapability` takes `composed_of` and appends a
`capability_composition` record to `capabilities.jsonl` (`session.js:466`, proven in
`test/session-schema.test.mjs`). So one walk can record:

- the **step** — which is what `graph.json` needs, unchanged, to stay byte-comparable with 0.1.22; and
- the **behaviour with its realisation** — which is what the ABM needs.

Nothing is recorded twice by hand, and neither document is a projection of the other.

| | `graph.json` (fallback) | `application-model.json` (product) |
| --- | --- | --- |
| Schema | vendored ABG `0.1`, **byte-identical to upstream** | forked ABM `0.2` |
| Spine | `states` + `transitions` | `behaviors` |
| Per-element interaction | its own top-level `capability` (`cap_fill_login_email`) | a `step` inside its behaviour's `realization[]` |
| Behaviour composition | `composed_of` over capabilities | `composed_of` over behaviours, demoted (D3) |
| The walk | `transitions[]`, ordered | `journeys[].steps[]`, ordered |
| Actors | `state.identity.variant`, a free string | `actors[]` top-level, referenced by id |
| Entities / state variables | implicit (`data_subject`, effect targets, dimensions) | `entities[]` / `state_variables[]` top-level |
| Consumers | `graph_test` (unchanged), anything already reading ABG 0.1 | the PR→test path this pivot exists for |
| Written when | always, as today | always, same commit |

**Cost of D1, stated plainly:** the ABM needs a schema of its own and every rule has to be
expressible twice — once as an ABG check and once as an ABM check — or once in a shared module
used by both. §5 Phase 0 takes the second option.

## 2. The schemas move in-repo (D2)

### Layout

```
packages/dsh-graph-explorer/
  schemas/
    0.1/                                vendored ABG, BYTE-IDENTICAL to upstream
      graph.schema.json common.schema.json application.schema.json
      feature.schema.json capability.schema.json state.schema.json element.schema.json
      transition.schema.json api.schema.json journey.schema.json observation.schema.json
      VENDOR.md                         provenance: source, date, sha256 per file
    abm/0.2/                            the fork
      application-model.schema.json     NEW root document
      common.schema.json                copied; ids/refs/assertions/metadata unchanged
      behavior.schema.json              NEW (capability, re-scoped: the spine)
      state.schema.json                 copied; identity/detection unchanged
      journey.schema.json               MODIFIED: carries the ordered walk
      element.schema.json api.schema.json observation.schema.json feature.schema.json
      application.schema.json           copied; `actors` now populated
```

Three rules, and they are the whole policy:

1. **`0.1/` is never edited.** It validates the fallback, so editing it would invalidate the
   thing D1 exists to preserve. The ABM's fork lives in `abm/0.2/`, and the two trees share the
   files they agree on by copy, not by `$ref` into `0.1/` (a `$ref` across the fork line would
   make a fallback-preserving edit impossible).
2. **`VENDOR.md` records where each file came from, when, and its sha256** — so "is this the
   same as upstream?" is answerable mechanically, and a deliberate divergence is visible as a
   hash mismatch rather than as folklore.
3. **`$id` base changes for the fork** (`https://webtestagent.local/schemas/abm/0.2/…`), because
   a document validated against a local schema should not claim the upstream schema's identity.
   The `$ref` chain inside `abm/0.2/` is self-contained, so this is a mechanical rewrite of ~11
   files, done once at vendoring time.

### Validation, without costing `npm test` its offline property

The plugin's current stance is deliberate: **`npm test` needs no install** (`README`
"Testing"), which is why the ajv validator lives out-of-repo at `~/tmp/schema-check/`. Bringing
the schemas in-repo must not quietly break that, and gap 8 — *a green commit can write a
schema-invalid graph, twice measured* — must be closed, not just re-homed.

So, two layers:

| Layer | Where | Deps | Runs |
| --- | --- | --- | --- |
| **Structural validator** | `lib/validate.js` (new) | none | always, inside `commitRun`, before `ok` is reported — the gap-8 fix |
| **Full JSON Schema validation** | `scripts/validate.mjs` (new) | `ajv` + `ajv-formats`, **devDependency, opt-in** | `npm run validate:schema <file>`, and in the verification protocol |

`lib/validate.js` is not a JSON Schema implementation. It checks the things the schemas state
mechanically **and** the commit is the last chance to catch: every `$ref` id resolves, every
enum membership (`capability.steps[].action`, `effect.type`, `state.kind`, `metadata.status`),
every required field, and every `pattern`. That is exactly the set the plugin already enforces
piecemeal in `lib/schema.js` (`DETECTION_TYPES`, `EFFECT_REQUIRED`, `CAPABILITY_NAME_PATTERN`, …)
— one table, read by both the recording tools and the commit, is the `CONTROL_ROLES` precedent
applied to validation.

**Recommended, stated as a tradeoff:** `ajv` as a devDependency is the honest way to validate
against the real schemas, and `npm test` staying dependency-free is preserved by keeping
`npm run validate:schema` a separate, opt-in script. If you would rather keep the plugin's
`package.json` dependency-free entirely, the alternative is to keep ajv out-of-repo and point
`~/tmp/schema-check/validate.mjs` at the in-repo schemas via `GRAPH_SCHEMA_DIR` — the schemas
are still vendored and versioned here, which is the part D2 actually asks for.

## 3. The ABM document, concretely

```jsonc
{
  "schema_version": "0.2",
  "generator": { "name": "dsh-graph-explorer", "version": "0.1.23" },
  "application": {
    "id": "app_acme-demo", "name": "Acme Demo App", "base_url": "http://127.0.0.1:4173/",
    "actors": [                                             // D2: top-level array, populated
      { "id": "anonymous_visitor" },
      { "id": "authenticated_user", "credentials_ref": "TEST_USER" }
    ]
  },

  "entities": [                                             // D2: new, top-level
    { "name": "session", "description": "An authenticated session.",
      "reads": ["element_login_email"], "writes": ["state_project_list"] },
    { "name": "project", "description": "A unit of work owned by a user.",
      "evidence": [{"observation": "obs_0004", "role": "identity"}] }
  ],

  "state_variables": [                                      // D2: new, top-level
    { "name": "projects", "type": "string", "values": ["empty", "populated"],
      "dimension_of": ["state_project_list_authenticated_projects_populated"],
      "detection": {"type": "value", "target": "projects", "operator": "equals", "expected": "populated"},
      "evidence": [{"observation": "obs_0004", "role": "effect"}] }
  ],

  "behaviors": [                                            // the spine
    {
      "id": "behavior_login",
      "name": "login",                                      // the verb a user would ask for
      "kind": "interaction",
      "actor": "anonymous_visitor",
      "preconditions": [{ "kind": "state", "state": "state_login_anonymous" }],
      "input":  { "email": {"type":"string","required":true},
                  "password": {"type":"string","required":true,"format":"password"} },
      "output": { "session": {"type":"entity","entity":"session"} },
      "realization": [                                      // D3: mechanics live HERE
        { "action":"fill",  "element":"element_login_email",    "value":"{{email}}",    "purpose":"enter_credentials" },
        { "action":"fill",  "element":"element_login_password", "value":"{{password}}", "purpose":"enter_credentials" },
        { "action":"click", "element":"element_login_submit",   "purpose":"submit" }
      ],
      "effects": [ { "type":"state_entered", "to":"state_project_list_authenticated_projects_populated", "observed":true },
                   { "type":"storage_changed", "target":"localStorage.session", "observed":true } ],
      "composed_of": [],                                    // D3: empty unless genuinely compositional
      "evidence": [ {"observation":"obs_0002","role":"action"},
                    {"observation":"obs_0003","role":"action"},
                    {"observation":"obs_0004","role":"effect"} ],
      "metadata": { "confidence": 0.9, "status": "verified", "producer": "llm:deepseek-flash" }
    }
  ],

  "states": [ /* unchanged from ABG 0.1: identity{page_type,variant,dimensions}, elements[], detection[] */ ],

  "journeys": [
    {
      "id": "journey_login_and_see_projects",
      "name": "Sign in to Acme and see the projects list",
      "goal": "Sign in as the demo user and reach the project list",
      "goal_stated": true,                                  // D4: false = the name is the run's own instruction
      "actor": "authenticated_user",
      "start_state": "state_login_anonymous",
      "steps": [                                            // the walk, moved here
        { "behavior": "behavior_login", "arguments": {"email":"demo@acme.test"}, "to_state": "state_project_list_authenticated_projects_populated" }
      ],
      "assertions": [ {"type":"url","operator":"matches","expected":"/projects"} ]
    }
  ],

  "observations": [ /* an evidence INDEX, exactly as ABG 0.1: ids, urls, artifact paths */ ]
}
```

### What the ABM drops, and why

| Dropped from graph.json | Why | Where it went |
| --- | --- | --- |
| flat `capabilities[]` mixing behaviours and steps | That mix *is* the defect this pivot exists to fix — measured in the 0.1.22 run: `cap_login` beside `cap_fill_login_email`, `cap_fill_login_password`, `cap_submit_login` | behaviours in `behaviors[]`, steps in `behaviors[].realization[]` |
| `transitions[]` as a top-level array | A transition is "one behaviour applied between two states" — a *walk* fact, and a walk is what a journey is | `journeys[].steps[]` (ordered), with `effects[]` on the behaviour |
| element `composed_of` chains for mechanics | D3 | `realization[]` |

Nothing is lost that a consumer needs: a walk still exists as an ordered sequence, every step
still names a behaviour and an arrival state, and every arrival state still carries `detection[]`.

**D4 — the walk always has a home.** With `transitions[]` gone from the ABM, a run that reached
no goal would have no walk recorded at all, and "the steps exist nowhere" is a worse outcome than
"the journey has no goal". So the ABM always contains **at least one journey**, assembled the way
`assembleJourneys` already does (`commit.js:1183`), with:

- `goal_stated: false` when no step claimed a `journey_name`, and the run's instruction kept as
  the journey's `goal` (as today) — the flag is what tells a consumer "this name is a sentence a
  person typed, not a title", so nothing downstream has to parse prose to find out;
- `criticality` **omitted**, not guessed: a goal-less walk is not automatically `critical`, and
  inventing that word would let it back the invariant-12 confidence rule.

A run that found no goal then says so in one field instead of losing its steps. `paths[]` as a
second walk container is rejected — two containers for one fact is two things to keep in sync,
and the only reason to want it was to avoid a journey with no goal, which the flag handles.

Consequence for the rules below: anything that reads a journey must hold for a `goal_stated:
false` one, since the rule runs last — **P6** (actor), **P9** (evidence) and **P12** (walk
preservation) must all pass on the fallback journey too, or every goal-less run fails its own
commit. P12 makes the guarantee checkable rather than conventional: without it, D4 is a promise
that `reconcile()` happens to keep, and a later refactor could drop the fallback journey and
still commit a green ABM whose steps exist nowhere.

### Profile rules

Each becomes a gate or a finding in `reconcile()`, with the existing flat-`findings` shape and a
`scope`, and each is enforced **twice**: once over the ABM (a gate) and once as an early refusal
in the recording tools where that is possible (the 0.1.16/0.1.17 precedent — a claim is
correctable while the page is still on screen).

| # | Rule | Severity |
| --- | --- | --- |
| P1 | Every `behaviors[].name` is a verb phrase a user would ask for; `<verb>_<page>_<element>` (`fill_login_email`) is refused | `error` |
| P2 | Every behaviour has `realization[]`, **or** a non-empty `composed_of`, **or** is `kind: navigation`/`query` | `warning` |
| P3 | `composed_of` may only name **behaviours**, and each must be realised by ≥1 committed step (the existing `composite_part_never_walked` idea, restated over behaviours) | `error` |
| P4 | Every `realization[].element` resolves to an element declared in some state | `error` (ABG invariant 3) |
| P5 | Every `realization[].value` that is a literal was **observed**; every `{{param}}` binds to a declared `input` | `error` (extends `withheldByEvidence`, generate.js:345) |
| P6 | Every `state.identity.variant` and `journeys[].actor` names an `actors[].id` | `warning` |
| P7 | Every entry in `identity.dimensions` is declared in `state_variables[]`, and each declaration has a `detection` | `error` (today a protocol rule only) |
| P8 | Every `effects[].target` that is a semantic path belongs to a declared `entities[].name`, or to `localStorage`/`sessionStorage`/`cookie` | `warning` |
| P9 | Every behaviour carries ≥1 `evidence[]` entry, and every evidence id resolves | `error` — the anti-hallucination rule |
| P10 | Objects with `metadata.confidence < 0.5` or `status: inferred` cannot back a `criticality: critical` journey | `warning` (ABG invariant 12) |
| P11 | Every behaviour is reachable from some journey's `steps[]`, or from a walkable behaviour's `composed_of` — a behaviour nothing can perform is a vocabulary entry, not a behaviour | `warning` (supersedes the draft's "every behaviour in a journey") |
| P12 | The ABM has **≥1 journey** (D4), and every committed transition appears as exactly one `journeys[].steps[]` entry | `error` — the walk-preservation rule, and the D1 coherence check |

P1 and P3 are the ones that make this the pivot rather than a rename: P1 refuses the exact names
the 0.1.22 run produced, and P3 stops `composed_of` from being used as a stand-in for realisation.
P12 is what stops D4 from being a promise: it is the same check from both directions at once —
on the ABM (is there a walk?) and across the two documents (does it match `graph.json`'s
transitions?).

## 4. What does not change

Most of the system, and it should not be re-litigated:

- **Evidence collection.** `capture.js`, `page-hooks.js`, `settlePage`, document-start install,
  the patcher's three edits. The ABM needs *more* of this, not less.
- **The store.** `createRun` / `addObservation` / `addState` / `addCapability` /
  `recordTransition`, write-then-remember, heal-on-failure, append-only, `obs_0007` never
  returning. The ABM adds records (behaviour, realization step, entity, state variable); it does
  not change how a record is written.
- **Every refusal.** `refuseDroppedDetections`, `maskedValueRefusal`, `refutedDetectionRefusal`,
  `surfaceMismatchRefusal`, `valueMismatchNotes`, `elementStateIdentityNote`. The proposal's §4
  ("the danger is semantic hallucination") is already answered by machinery that exists and is
  live-proven; the ABM makes it *more* load-bearing, so it must not be weakened.
- **The commitment model.** "Exploration is allowed to be wrong; the commit decides what becomes
  knowledge." The ABM is a second thing to commit, not a second relationship to evidence.
- **`graph_test` and the generated spec.** It reads `graph.json`, which is unchanged, so the
  spec path keeps working on day one. Whether an ABM-native generator is better is a later
  question, not a prerequisite.
- **The lossless-JSON tool boundary** (`test/lossless.mjs`).

## 5. Phases

### Phase 0 — vendor the schemas, and make the ABM derivable offline (1 day)

Two halves, both cheap and both de-risking everything after them.

**0a — vendoring (D2).** Copy `~/IntegrationTestGenerator/schemas/*.schema.json` to
`schemas/0.1/` byte-identical, write `VENDOR.md` with sha256s, and fork `schemas/abm/0.2/` with
the new root, the `$id` rewrite, and the `journeys[].steps[]` / `realization[]` additions.
Add `scripts/validate.mjs` (opt-in ajv) and point the verification protocol at it.

**0b — the projection, as a *check*, not as the pipeline.** `lib/abm.js`, pure, no writes:
`modelFromCandidates({observations, states, capabilities, transitions, instruction})` → the ABM
shape of §3, plus `profileFindings(model)` implementing P1–P12. This is a **diagnostic over
recorded runs**, never the production path — `commitRun` will build the same document from the
same store, and Phase 0b exists to have something to measure with before any live run.

- Fixtures: `artifacts/graph-spike/` (12 observations / 11 readings, 0.1.0) and
  `~/tmp/live-graph/graph-run/` (the 0.1.22 sign-in walk).
- New suite `test/abm.test.mjs`.
- **Acceptance:** running `profileFindings` over the real 0.1.22 `graph.json` reports
  `fill_login_email` / `fill_login_password` / `submit_login` as **P1 violations**. That is the
  motivating defect, quantified, against real output, before a single line of the plugin changes.
- **Acceptance (0a):** `npm run validate:schema` validates both the 0.1.22 `graph.json` against
  `schemas/0.1/` (must pass — proving the vendored copy is intact) and a hand-written ABM sample
  against `schemas/abm/0.2/`.

### Phase 1 — behavioural recording

`lib/index.js`, `graph_transition` (index.js:1482).

- New arguments: `behavior` (the behaviour this step belongs to) and `realization` (the step
  shape: `{action, element, value}`).
- Rule: when `behavior` is given, the call **also** appends a realization step to that behaviour
  (via a new `store.addRealizationStep`) **and** keeps minting the step capability as it does
  today, so `graph.json` stays faithful (D1). One call, both documents.
- `graph_observe` (index.js:1197) gains `actor`, validated against the run's actor registry.
- Actors come from **config** beside `application:` in `cordis.patch.yml` — the actor vocabulary
  is a property of the application, not of a walk, and config is where `application` already lives.
- `lib/session.js`: `addRealizationStep(capabilityId, step)`, `actors()`, and append-only records
  (`kind: 'realization_step'`), consistent with "a reading appends a new state or a sighting".
- Early refusals matching P1/P4/P5 while the page is still on screen.

**Acceptance:** a scripted walk on `demo-app` produces, from one set of calls, a `graph.json`
whose `capabilities[]` matches 0.1.22's shape **and** an ABM whose `behaviors[]` contains `login`
with three `realization[]` entries and no top-level step capability. Covered by
`test/tools.test.mjs`; revert-proven in `test/prove-abm.py`.

### Phase 2 — the commit writes both documents

`lib/commit.js`, `reconcile()` (commit.js:1379).

- Assemble `behaviors[]` (with `realization[]` ordered by walk order), `entities[]`,
  `state_variables[]`, `actors[]`, and `journeys[].steps[]`.
- Add P1–P12 to `invariantsOf()` (commit.js:3351), sharing one definition with Phase 0b's
  `profileFindings` so the diagnostic and the gate cannot drift.
- Emit the D4 fallback journey (the run's own walk, `goal_stated: false`, `criticality`
  omitted) whenever no step claimed a `journey_name`, so P12 always has a journey to check.
- **Run `lib/validate.js` over both documents before reporting `ok`** — this closes README gap 8
  and is the reason it cannot stay open any longer: an ABM with a `realization[].action` outside
  the enum is precisely the class of defect that has already shipped twice.
- `commit_report.json` gains a per-document section (`documents: { graph: {…}, model: {…} }`)
  so "which document is short, and why" is answerable without reading two files.

**Acceptance:** on the Phase-1 walk, `graph.json` is **schema-VALID** against `schemas/0.1/` and
byte-comparable in shape with 0.1.22; `application-model.json` is **schema-VALID** against
`schemas/abm/0.2/`; zero `error`-severity findings in both.

### Phase 3 — the protocol

`lib/protocol.js` (240 lines, one `systemPrompt` section at order 150). This is where the pivot
is actually *made*, because no tool schema can force a behaviour-first reading.

- Reorder the procedure to **understand → name actors/entities/state variables → infer
  behaviours → validate → walk** (it is `act → observe → record` today).
- Replace the 0.1.18 composite-vs-step clause: `realization[]` is the default home for a step;
  a per-element interaction is a capability only if a user would ask for it by that name.
- Add the grounding paragraph: a behaviour with no evidence is a hallucination, and
  `confidence` is the honest report of how well grounded it is.
- Keep every existing refusal sentence verbatim — they encode failure modes found in live runs.

**Acceptance:** a live run names behaviours, not elements, without the protocol being re-read
mid-run. Measure: P1 violations = 0 in the committed ABM.

### Phase 4 — deferred, not dropped

`graph_test` keeps reading `graph.json`, so the spec path is untouched by the pivot. An
ABM-native generator (reading `realization[]` directly rather than matching `composed_of`
against committed transitions, `generate.js:570`) becomes worth doing once the ABM has survived
real runs — its own phase, with its own acceptance, rather than a bet taken now.

### Phase 5 — multi-source grounding

The proposal's §10. Cheap first slice, because the evidence already exists: `observations.jsonl`
carries every request with method/path/status (`observedApis`, commit.js:149), and the ABM's
`entities[]`/`effects[].request` can resolve to real `api_*` entries — `api.schema.json` exists
and `apis[]` is near-empty today. Optional second slice: cross-check a behaviour's
`realization[]` against a repository when one is declared, which is where `source_mappings[]` and
`feature.owners` start paying for themselves and what makes the eventual PR→test path work.

Keep it **evidence-adding, never evidence-replacing**: a code-derived claim is `observed: false`
and lowers `confidence`, which is what the schema's `effect.observed` already means.

## 6. Risks

| Risk | Why it is real here | Mitigation |
| --- | --- | --- |
| **Semantic hallucination** — `create_project` inferred from a `[Create]` button | The pivot pushes inference earlier, when less is known | P9 (evidence required), P5 (a literal value must have been observed), plus the existing refusal set. `confidence` reported, never invented. |
| **Two documents drift** | They are independent by design (D1), which is exactly what lets them disagree | Both from one store, one commit, one `commit_report.json` section each; **P12** asserts that every committed transition is exactly one `journeys[].steps[]` entry, in both directions. |
| **The walk is homeless** (D4) | `transitions[]` is gone from the ABM, so a goal-less run would have nowhere to put its steps | `reconcile()` always emits the fallback journey; **P12** fails the commit if it ever stops doing so. |
| **Fork rot** (D2) | The vendored schema is now a copy, and copies drift from upstream silently | `VENDOR.md` sha256s + `0.1/` never being edited makes the divergence deliberate and checkable. |
| **`npm test` loses its offline property** (D2) | `ajv` is the natural validator and the plugin has deliberately no deps | `lib/validate.js` (no deps) is the gate; ajv is opt-in via `npm run validate:schema` only. |
| **A behaviour-first reading is not stabilisable** — two runs name one behaviour two ways | Already observed: `vocabulary_notes` fires on `add_to_cart` vs `add_item_to_cart` | The existing convergence path plus the schema's own vocabulary list. **Measure inter-run name stability; do not assume it.** |
| **Losing the walk** | `assembleJourneys` derives journeys from ordered `transitions.jsonl` | Transitions stay in the log and in `graph.json`; the ABM carries the same walk in `journeys[].steps[]` (D4). |
| **A greener-looking run that proves less** | Every change makes refusals *more* likely, which reads as regression | Track refusal counts and per-document findings across runs. Fewer findings after a rule change is a **finding**, not a win, until the rule is shown to still fire (§7.2). |

## 7. Verification protocol

Each of these is load-bearing, not ceremony:

1. `npm test` — currently 9 suites; every phase adds a suite or a case, never only a claim.
   `test/run.mjs` auto-discovers `*.test.mjs`.
2. **Revert-proof each new rule**: break the rule in the source, confirm the suite fails *with
   the diagnostic you expect*, restore, confirm green. `test/prove-generate.py` is the template;
   add `test/prove-abm.py`. Break the *rule*, not a clause the code already treats as equivalent
   (removing `cutParameter &&` proved nothing — behaviourally identical).
3. **Validate both documents** with `npm run validate:schema` after every live run. Gap 8 means a
   green commit can still write an invalid document — measured twice.
4. **Read the generated artifacts.** Both 0.1.22 defects were found by reading the spec, not the
   graph. Read `application-model.json`'s `behaviors[]` and say which paths the run did *not*
   exercise; a green run is evidence of a positive and never of a negative.
5. Deploy with a **version bump** (`0.1.23`), **pack last**, `diff -r lib` / `diff -r test` /
   `diff -r schemas` IDENTICAL, then re-run `scripts/patch-dsh-browser.mjs --profile {graph,web} --verify`.

## 8. Do this first

The proposal's own closing experiment, and it is still the right first step — now it can be run
against *both* documents:

1. Take `~/tmp/live-graph/graph-run/` (the 0.1.22 sign-in walk) — a real run whose
   `capabilities[]` contains the four-name abstraction-mixing defect.
2. Hand an LLM only `observations.jsonl` + `run.json.instruction` + §3's shape — **not**
   `states.jsonl`, `capabilities.jsonl` or `transitions.jsonl`.
3. Ask for the ABM of §3.
4. Diff it against the committed `graph.json`.

If it produces `login` with `realization[]`, grounded evidence and no `fill_login_email`
sibling, the pivot is validated and Phases 1–3 are execution. If it cannot, the failure names
exactly what the tool boundary must ask for *while the page is on screen* — which is the design
input for Phase 1. Either answer is worth more than the rest of this plan.
