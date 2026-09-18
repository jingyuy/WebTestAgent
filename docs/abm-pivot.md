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
| **D5** | **`transitions[]` comes back, re-scoped to the behaviour.** One entry per `(from_state, behaviour, to_state)` — never per tool call. `journeys[].steps[]` references them, the way `journeys[].transitions[]` already does. | §3: an edge is first-class again, so `preconditions[]`/`effects[]` leave `behaviors[]`. **P12 is repaired** (it cannot hold without this — see the note below). |
| **D6** | **The ABM represents unwalked affordances.** `state.affordances[]` — an affordance is offered *by a surface*, so it lives on the state that offers it. | §3: new array + **P13**, which makes "nobody did this" checkable rather than asserted. |
| **D7** | **No `features[]` in the ABM.** Feature grouping stays a `graph.json` layer; the ABM is a behaviour model, not a product map. | §3: "what the ABM deliberately does not gain". §2: `feature.schema.json` is **not** forked. The `feature` protocol argument keeps feeding `graph.json` only. |

**Why D5 is not just a preference — P12 could not hold without it.** The current §3 made a walk step a
*behaviour* (`login`) while P12 demanded "every committed transition appears as exactly one
`journeys[].steps[]` entry". On the real 0.1.22 run that is **3 committed transitions against 1
behaviour-level step**, so the rule fails on the very run it was written to check. It holds today only
because `assembleJourneys` builds `journeys[].transitions[]` per *call* (`commit.js:1183`) — i.e. the
rule was accidentally reading the graph's own granularity, not the ABM's. An edge whose unit is the
behaviour is what makes the rule sound, and collapsing 3 calls into 1 edge is the pivot itself.

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
| Spine | `states` + `transitions` | `behaviors` + `transitions` |
| Per-element interaction | its own top-level `capability` (`cap_fill_login_email`) | a `step` inside its behaviour's `realization[]` |
| Behaviour composition | `composed_of` over capabilities | `composed_of` over behaviours, demoted (D3) |
| The edge set | `transitions[]`, **one per tool call** (3 for one sign-in) | `transitions[]`, **one per (from, behaviour, to)** (1 for one sign-in) — D5 |
| The walk | `journeys[].transitions[]`, derived by `assembleJourneys` | `journeys[].steps[]`, referencing `transitions[]` and carrying the call's `arguments` |
| Unwalked affordances | nothing — `coverage.unmodelled_routes` is a *route* statement, and an SPA has one route | `state.affordances[]` (D6), so "offered but never performed" is representable at all |
| Product features | `features[]`, assembled from the `feature` argument | **none** — D7 |
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
      transition.schema.json            MODIFIED (D5): `capability` → `behavior`, one edge per behaviour
      state.schema.json                 MODIFIED (D6): gains `affordances[]`
      journey.schema.json               MODIFIED: `steps[]` references `transitions[]`, ordered
      element.schema.json api.schema.json observation.schema.json application.schema.json
                                        copied; `actors` now populated
      (feature.schema.json NOT forked — D7)
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
      "reads":  ["element_email_input", "element_password_input"],
      "writes": ["localStorage.acme-demo-state"] },
    { "name": "project", "description": "A unit of work owned by a user.",
      "reads":  ["element_project_list", "element_project_name_input"],
      "writes": ["element_project_list"],
      "evidence": [{"observation": "obs_0004", "role": "identity"}] }
  ],

  "state_variables": [                                      // D2: new, top-level
    { "name": "projects", "type": "string", "values": ["empty", "populated"],
      "dimension_of": ["state_project_list_authenticated_projects_populated"],
      "detection": {"type": "value", "target": "element_project_list",
                    "operator": "equals", "expected": "populated"},   // P7: an ELEMENT, not a storage key
      "evidence": [{"observation": "obs_0004", "role": "effect"}] }
  ],

  "behaviors": [                                            // the vocabulary: what an actor can DO
    {
      "id": "behavior_login",
      "name": "login",                                      // P1: the verb a user would ask for
      "kind": "interaction",
      "actor": "anonymous_visitor",
      "input":  { "email": {"type":"string","required":true},
                  "password": {"type":"string","required":true,"format":"password"} },
      "output": { "session": {"type":"entity","entity":"session"} },
      "realization": [                                      // D3: mechanics live HERE
                                                             // D5: a step carries its OWN local effect
        { "action":"fill",  "element":"element_email_input",    "value":"{{email}}",    "purpose":"enter_credentials",
          "effects":[{"type":"value_changed","target":"element_email_input","to":"test@example.com","observed":true}] },
        { "action":"fill",  "element":"element_password_input", "value":"{{password}}", "purpose":"enter_credentials",
          "effects":[{"type":"value_changed","target":"element_password_input","to":"[set]","observed":true}] },
        { "action":"click", "element":"element_login_button",   "purpose":"submit" }
      ],
      "composed_of": [],                                    // D3: empty unless genuinely compositional
      // D5: no `preconditions[]`/`effects[]` here — those are the EDGE's, see transitions[] below
      "evidence": [ {"observation":"obs_0002","role":"action"},
                    {"observation":"obs_0003","role":"action"},
                    {"observation":"obs_0004","role":"effect"} ],
      "metadata": { "confidence": 0.9, "status": "verified", "producer": "llm:deepseek-flash" }
    }
  ],

  "transitions": [                                          // D5: one edge per (from, behaviour, to)
    {
      "id": "transition_login",                              // 3 committed graph transitions → this ONE
      "from_state": "state_login_anonymous",
      "behavior": "behavior_login",                         // the behaviour, never the step
      "to_state": "state_project_list_authenticated_projects_populated",
      "guard": null,                                        // the condition that made it possible, if any
      "effects": [                                          // what the APPLICATION changed
        {"type":"state_entered","to":"state_project_list_authenticated_projects_populated","observed":true},
        {"type":"storage_changed","target":"localStorage.acme-demo-state","observed":true}
      ],
      "apis": [],                                           // Phase 5 resolves these from the request log
      "evidence": [                                         // the per-EDGE three-role binding
        {"observation":"obs_0001","role":"identity"},       //   the surface it started from
        {"observation":"obs_0004","role":"action"},         //   the action itself
        {"observation":"obs_0004","role":"effect"}          //   what changed between the readings
      ],
      "metadata": { "confidence": 0.9, "status": "verified" }
    }
  ],

  "states": [  // as ABG 0.1 — identity{page_type,variant,dimensions}, elements[], detection[] — PLUS:
    {
      "id": "state_login_anonymous",
      "identity": { "route":"/", "page_type":"login", "variant":"anonymous" },
      "elements": [ /* element_email_input, element_password_input, element_remember_checkbox,
                        element_login_button, element_forgot_password_link */ ],
      "detection": [ /* as ABG 0.1 */ ],
      "affordances": [                                      // D6: offered here, never performed
        { "element": "element_forgot_password_link",         // must be one of THIS state's elements
          "expected_behavior": "reset_password",             // a hypothesis, and `unwalked` says so
          "metadata": { "status":"unwalked", "confidence":0.3, "producer":"llm:deepseek-flash" } }
      ]
    },
    {
      "id": "state_project_list_authenticated_projects_populated",
      "identity": { "route":"/", "page_type":"project_list", "variant":"authenticated",
                    "dimensions": { "projects": "populated" } },
      "elements": [ /* element_nav_projects, element_nav_settings, element_current_user,
                        element_logout_button, element_project_name_input,
                        element_add_project_button, element_project_list */ ],
      "detection": [ /* as ABG 0.1, incl. the `projects` value assertion */ ],
      "affordances": [                                      // these four are in the capture and
        { "element": "element_nav_projects",                 //   in no committed realization step
          "expected_behavior": "list_projects",
          "metadata": { "status":"unwalked", "confidence":0.3 } },
        { "element": "element_nav_settings", "expected_behavior": "open_settings",  "metadata": { "status":"unwalked", "confidence":0.3 } },
        { "element": "element_logout_button", "expected_behavior": "sign_out",     "metadata": { "status":"unwalked", "confidence":0.3 } },
        { "element": "element_add_project_button", "expected_behavior": "create_project", "metadata": { "status":"unwalked", "confidence":0.3 } }
      ]
    }
  ],

  "journeys": [
    {
      "id": "journey_login_and_see_projects",
      "name": "Sign in to Acme and see the projects list",
      "goal": "Sign in as the demo user and reach the project list",   // NEVER the raw instruction:
                                                             // the instruction carries the credential,
                                                             // and this document is meant to be read
      "goal_stated": true,                                  // D4: false = the name is the run's own instruction
      "actor": "authenticated_user",
      "start_state": "state_login_anonymous",
      "steps": [                                            // the walk: ORDER over transitions[]
        { "transition": "transition_login", "arguments": {"email":"test@example.com"} }
      ],
      "assertions": [ {"type":"url","operator":"matches","expected":"/projects"} ]
    }
  ],

  "observations": [ /* an evidence INDEX, exactly as ABG 0.1: ids, urls, artifact paths */ ]
}
```

### What the ABM drops, what it re-scopes, and what it refuses to gain

| graph.json | ABM | Why |
| --- | --- | --- |
| flat `capabilities[]` mixing behaviours and steps | **dropped** → behaviours in `behaviors[]`, mechanics in `behaviors[].realization[]` | That mix *is* the defect this pivot exists to fix — measured in the 0.1.22 run: `cap_login` beside `cap_fill_login_email`, `cap_fill_login_password`, `cap_submit_login` |
| `transitions[]`, one per tool call | **re-scoped** → one per `(from_state, behaviour, to_state)`, with `journeys[].steps[]` referencing it | D5. The edge is real knowledge (`guard`, per-edge `evidence` roles, the from→to *pairing*) that a behaviour cannot carry without implying a cross-product. It also gives P12 a sound unit |
| element `composed_of` chains for mechanics | **dropped** → `realization[]` | D3 |
| `features[]` | **deliberately not carried** | D7. A product map is a different document's job; the ABM stays a behaviour model |
| — | **gained:** `state.affordances[]` | D6. `coverage.unmodelled_routes` is a *route* statement, and an SPA has one route, so the graph cannot express "this control was offered and never pressed" at all |

Nothing is lost that a consumer needs: the edge set is `transitions[]`, the walk's order is
`journeys[].steps[]`, the mechanics are `realization[]`, and every state still carries `detection[]`.

**D4 — the walk always has a home, restated for D5.** D4 was originally argued from preservation:
with `transitions[]` gone, a goal-less run would have had no walk recorded anywhere. D5 restores
`transitions[]`, so that specific loss is repaired — but D4 stands, for a reason that survives it:
`transitions[]` is an edge *set*, and a set has no order and no purpose. **The walk's order and the
walk's point live only in `journeys[]`.** So the ABM still contains **at least one journey**,
assembled the way `assembleJourneys` already does (`commit.js:1183`), with:

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
| P4 | Every `realization[].element` **and every element-shaped `effects[].target`** (`value_changed`, `visibility_changed`, `element_created`, `element_destroyed`, `validation_error`) resolves to a declared element **id** — and a realization's element is **derived from the state's declaration, never accepted as typed by the model** | `error` (ABG invariant 3) |
| P5 | Every `{{param}}` in a `realization[].value` binds to a declared `input` or to a `journeys[].steps[].arguments` key; every concrete value the model records (a step's effect `to`, an edge's `arguments`) was **observed**, and a redacted field is recorded as the honest `[set]` rather than omitted | `error` (extends `withheldByEvidence`, generate.js:345) |
| P6 | Every `state.identity.variant` and `journeys[].actor` names an `actors[].id`, and that id is **traceable** to a state variant or an observation | `warning` |
| P7 | Every entry in `identity.dimensions` is declared in `state_variables[]`, each declaration carries a `detection`, and **that `detection` reads an element or a route** — a check over a storage key is a dimension-shaped claim nothing can evaluate | `error` (today a protocol rule only; the graph's own `persistence_evidence_recorded` note already refuses the storage case) |
| P8 | Every `transitions[].effects[].target` that is a semantic path belongs to a declared `entities[].name`, or to `localStorage`/`sessionStorage`/`cookie` | `warning` |
| P9 | Every behaviour carries ≥1 `evidence[]` entry, every `transitions[]` entry carries the three evidence roles (`identity`/`action`/`effect`), and every evidence id resolves | `error` — the anti-hallucination rule |
| P10 | Objects with `metadata.confidence < 0.5` or `status: inferred` cannot back a `criticality: critical` journey | `warning` (ABG invariant 12) |
| P11 | Every behaviour is the `behavior` of ≥1 `transitions[]` entry, or a member of a walkable behaviour's `composed_of` — a behaviour no edge can perform is a vocabulary entry, not a behaviour | `warning` (supersedes the draft's "every behaviour in a journey") |
| P12 | **Walk preservation (D4 + D5), both directions.** *(a)* every transition `graph.json` committed is accounted for in the ABM — as an edge's behaviour, or as a `realization[]` step of a behaviour whose own edge starts where that transition started; *(b)* every `transitions[]` entry is backed by ≥1 committed graph transition with the same `from_state`/`to_state`/behaviour; *(c)* the ABM has ≥1 journey (D4) and every `journeys[].steps[]` entry names a `transitions[]` id | `error` — the D1 coherence check |
| P13 | **An affordance is offered, not performed (D6).** Every `state.affordances[].element` is declared in **that same state's** `elements[]`; an affordance whose element *is* the target of a committed `realization[]` step is reported, because the walk itself refutes "nobody did this" | `error` (unresolved element) / `warning` (`affordance_already_walked`) |

P1 and P3 are the ones that make this the pivot rather than a rename: P1 refuses the exact names
the 0.1.22 run produced, and P3 stops `composed_of` from being used as a stand-in for realisation.
P12 is the load-bearing one and it is why D5 exists: as written before D5 it could not hold — it
demanded one `journeys[].steps[]` entry per committed transition while §3 made a step a
*behaviour*, which is 1 against the real run's 3. It now checks the same fact in the unit the ABM
actually uses, and it is the pivot stated as a gate: **three committed calls become one edge and
three ordered realization steps, and nothing is allowed to go missing in the collapse.**

One deliberate asymmetry: an edge that no journey walks is reported the way `reachability`
already is (`warning`), because a walk that avoided a behaviour is not evidence it cannot be
performed. The error severities above apply only where the two documents must agree exactly.

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
- **The `features[]` layer (D7).** `features[]` stays a `graph.json` property. The `feature`
  protocol argument keeps feeding it and `feature_closure` keeps checking it; the ABM ignores it.
  A consumer that needs product grouping reads the fallback — which is what a fallback is for.
- **The lossless-JSON tool boundary** (`test/lossless.mjs`).

## 5. Phases

### Phase 0 — vendor the schemas, and make the ABM derivable offline (1 day)

Two halves, both cheap and both de-risking everything after them.

**0a — vendoring (D2).** Copy `~/IntegrationTestGenerator/schemas/*.schema.json` to
`schemas/0.1/` byte-identical, write `VENDOR.md` with sha256s, and fork `schemas/abm/0.2/` with
the new root, the `$id` rewrite, the **behaviour-level `transitions[]`** (D5), `state.affordances[]`
(D6) and the `journeys[].steps[]` / `realization[]` additions — and **without** `feature.schema.json`
(D7).
Add `scripts/validate.mjs` (opt-in ajv) and point the verification protocol at it.

**0b — the projection, as a *check*, not as the pipeline.** `lib/abm.js`, pure, no writes:
`modelFromCandidates({observations, states, capabilities, transitions, instruction})` → the ABM
shape of §3, plus `profileFindings(model)` implementing P1–P13. This is a **diagnostic over
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
- `graph_observe` (index.js:1197) gains `actor`, validated against the run's actor registry, and
  `affordances` — the elements the reading offers and the walk is not exercising (D6). The reading
  is the only moment an affordance can be recorded, because it is a fact about the surface.
- Actors come from **config** beside `application:` in `cordis.patch.yml` — the actor vocabulary
  is a property of the application, not of a walk, and config is where `application` already lives.
- `lib/session.js`: `addRealizationStep(capabilityId, step)`, `actors()`, and append-only records
  (`kind: 'realization_step'`), consistent with "a reading appends a new state or a sighting".
- Early refusals matching P1/P4/P5/P7/P13 while the page is still on screen.

**Acceptance:** a scripted walk on `demo-app` produces, from one set of calls, a `graph.json`
whose `capabilities[]` matches 0.1.22's shape **and** an ABM whose `behaviors[]` contains `login`
with three `realization[]` entries and no top-level step capability. Covered by
`test/tools.test.mjs`; revert-proven in `test/prove-abm.py`.

### Phase 2 — the commit writes both documents

`lib/commit.js`, `reconcile()` (commit.js:1379).

- Assemble `behaviors[]` (with `realization[]` ordered by walk order), **`transitions[]` collapsed to
  one edge per `(from_state, behaviour, to_state)`** (D5), `entities[]`, `state_variables[]`,
  `actors[]`, and `journeys[].steps[]` referencing those edges.
- Add P1–P13 to `invariantsOf()` (commit.js:3351), sharing one definition with Phase 0b's
  `profileFindings` so the diagnostic and the gate cannot drift.
- Emit the D4 fallback journey (the run's own walk, `goal_stated: false`, `criticality`
  omitted) whenever no step claimed a `journey_name`, so P12c always has a journey to check.
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
- State the D5 distinction in the tool's own words: a **step** is one interaction, a **behaviour**
  is what a user asks for, and an **edge** is one behaviour applied between two states — so three
  calls in one sign-in are one edge, and the edge is recorded once, when the behaviour completes.
- Add the D6 sentence: a control the reading offers and the walk does not use is an **affordance**,
  and recording it is the only way the model can say what the application can do but this walk did not.
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
| **Two documents drift** | They are independent by design (D1), which is exactly what lets them disagree | Both from one store, one commit, one `commit_report.json` section each; **P12a/P12b** check the edge set in both directions, so neither document can quietly lose or invent an edge. |
| **The walk loses its order or its point** (D4, restated for D5) | `transitions[]` is a *set*: it has no order and no purpose, so only `journeys[].steps[]` says what the walk was and what it was for | `reconcile()` always emits the fallback journey (`goal_stated: false`); **P12c** fails the commit if it ever stops doing so. |
| **The collapse hides which step landed the state** (D5) | Three calls become one edge, and `realization[]` keeps the order but does not mark which action moved the application | The edge's `evidence` carries the `action` role, which names the observation of that step — in the 0.1.22 run, `obs_0004`, the submit click. So the causal step is *recoverable from evidence* rather than asserted. |
| **Affordances become a wish list** (D6) | D6 rewards naming what a walk did not do, and a model that wants to look thorough can invent them | P13 requires the element to be declared in *that state's own* `elements[]`, so every affordance is anchored in the capture; `unwalked` is refuted by any committed realization step on the same element; `confidence` reported at 0.3, never argued up. |
| **Fork rot** (D2) | The vendored schema is now a copy, and copies drift from upstream silently | `VENDOR.md` sha256s + `0.1/` never being edited makes the divergence deliberate and checkable. |
| **`npm test` loses its offline property** (D2) | `ajv` is the natural validator and the plugin has deliberately no deps | `lib/validate.js` (no deps) is the gate; ajv is opt-in via `npm run validate:schema` only. |
| **A behaviour-first reading is not stabilisable** — two runs name one behaviour two ways | Already observed: `vocabulary_notes` fires on `add_to_cart` vs `add_item_to_cart` | The existing convergence path plus the schema's own vocabulary list. **Measure inter-run name stability; do not assume it.** |
| **Losing the walk** | `assembleJourneys` derives journeys from ordered `transitions.jsonl` | Transitions stay in the log and in `graph.json`; the ABM carries the same edges in `transitions[]` and the same order in `journeys[].steps[]`. |
| **A greener-looking run that proves less** | Every change makes refusals *more* likely, which reads as regression | Track refusal counts and per-document findings across runs. Fewer findings after a rule change is a **finding**, not a win, until the rule is shown to still fire (§7.2). |

## 7. Verification protocol

Each of these is load-bearing, not ceremony:

1. `npm test` — currently 9 suites; every phase adds a suite or a case, never only a claim.
   `test/run.mjs` auto-discovers `*.test.mjs`.
2. **Revert-proof each new rule**: break the rule in the source, confirm the suite fails *with
   the diagnostic you expect*, restore, confirm green. `test/prove-generate.py` is the template;
   add `test/prove-abm.py`. Break the *rule*, not a clause the code already treats as equivalent
   (removing `cutParameter &&` proved nothing — behaviourally identical).
   **P12 gets this treatment explicitly, and for a measured reason.** Before D5 the rule demanded
   one `journeys[].steps[]` entry per committed transition, and §3 made a step a behaviour: the
   real 0.1.22 run has **3 committed transitions and 1 behaviour-level step**, so a naive test
   would have passed for the wrong reason (it read the graph's per-call steps). The revert-proof
   must therefore use the run's own numbers — `3` committed transitions, `1` edge, `1` step —
   which are recorded in `docs/experiments/abm-01/compare-output.txt`. Break P12a, P12b and P12c
   separately and confirm each names a different missing object.
3. **Validate both documents** with `npm run validate:schema` after every live run. Gap 8 means a
   green commit can still write an invalid document — measured twice.
4. **Read the generated artifacts.** Both 0.1.22 defects were found by reading the spec, not the
   graph. Read `application-model.json`'s `behaviors[]` and say which paths the run did *not*
   exercise; a green run is evidence of a positive and never of a negative.
5. Deploy with a **version bump** (`0.1.23`), **pack last**, `diff -r lib` / `diff -r test` /
   `diff -r schemas` IDENTICAL, then re-run `scripts/patch-dsh-browser.mjs --profile {graph,web} --verify`.

## 8. Do this first — **DONE**

The proposal's own closing experiment. It was run before any code was written, and it did its
job: it **validated the pivot on its main axis and falsified three of its edges**. The full
record is `docs/abm-experiment-1.md`; the frozen artifacts and the reproducible diff are
`docs/experiments/abm-01/`.

What it asked, kept here so the record is self-contained:

1. Take `~/tmp/live-graph/graph-run/` (the 0.1.22 sign-in walk) — a real run whose
   `capabilities[]` contains the four-name abstraction-mixing defect.
2. Hand an LLM only `observations.jsonl` + `run.json.instruction` + §3's shape — **not**
   `states.jsonl`, `capabilities.jsonl` or `transitions.jsonl`.
3. Ask for the ABM of §3.
4. Diff it against the committed `graph.json`.

**Result.** The blind read (`blind-model.json`, sha256 `c170d9e5…`, hashed before the graph was
opened) produced **one behaviour `login` with three ordered `realization[]` steps and no
`fill_login_email` sibling**; both states matched the graph's identity character for character,
and the walk matched action for action. It was wrong in three ways, and each became a rule:
realization element references must be **derived** (P4), actor vocabulary must be **traceable**
(P6), and a dimension's `detection` must read an element or a route (P7).

It also surfaced **D5, D6 and D7** — the edge had to come back at the behaviour's unit (D5),
the five controls the capture shows and the graph cannot name had to become affordances (D6), and
`features[]` had to stay out (D7). And it found a **secret leak that outlives the run**
(`password123` in `journeys[0].goal`, which quotes the instruction): §3's `goal` must be redacted
or stored as a reference.

**Why the sequencing held.** The experiment was run *before* Phase 0a/0b because 0b implements
§3's shape and P1–P13, and D5 changes that shape materially — the rule set and the document's
edge unit had to be right before there was anything to implement. The plan revision below is
that reordering, not a delay.
