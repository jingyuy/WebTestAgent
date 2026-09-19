# Pivot: generate an Application Behavior Model beside the graph

Status: **Phase 0a, 0b, 1, 2, 3 and 4 DONE — the pivot is load-bearing: a spec is generated with
`graph.json` absent from the run directory, and every action in it traces to a `realization[]` step.
Phase 5 next.**
Baseline: plugin `0.1.22`, branch
`fix/graph-explorer-lossless-and-state-entered` (`8738f52`), deployed to the `graph` and
`web` profiles. Work happens on **`feat/application-behavior-model`**, branched off `8738f52`
(not `main`, which is three commits behind on `commit.js`/`generate.js`).

**The milestone all of this is for (D10):** *"I explored an application once, built a semantic model
from it, and generated an integration test from that model without requiring the old low-level
capability graph as the semantic source of truth."* Phases 0–4 are the MVP; 5–6 come after. The
point of stating it this way is that the model has to be **load-bearing**: while `graph_test` reads
`graph.json`, a wrong behaviour name cannot change the spec, and the semantic layer is a second
description rather than a replacement. §5 Phase 4 is in the MVP for that reason.

## 0. Decisions taken

| # | Decision | What it changes in this plan |
| --- | --- | --- |
| **D1** | **Two artifacts.** `graph.json` stays exactly as it is, as a fallback; the ABM is a second document beside it. | §1: the pipeline writes two documents from one evidence log, and the two are **independent readings**, not a projection of each other. The generator returning to the critical path (D10) does not weaken
this: it makes the ABM a consumer of its own document, which is the point. |
| **D2** | **Copy the schemas in-repo and modify them here.** The external schema is no longer authoritative for this project. | §2: a vendored `schemas/` tree, a fork policy, and a validation strategy that does not cost the plugin its zero-dependency `npm test`. §3: `entities` / `state_variables` / `actors` get **real top-level arrays** instead of `metadata.extra`. |
| **D3** | **`composed_of` demoted.** `realization.steps[]` is the default home for a behaviour's mechanics. | §3: P2/P3 rules. `composed_of` survives only for a behaviour genuinely built from other behaviours. |
| **D4** | **A goal-less run keeps its walk as a journey.** The ABM always carries ≥1 journey, with `goal_stated: false` when the run named no goal. No `paths[]` container. | §3: the walk has exactly one home. Rules P7/P11 depending on a journey's presence must be written to hold for a `goal_stated: false` journey. |
| **D5** | **`transitions[]` comes back, re-scoped to the behaviour.** One entry per `(from_state, behaviour, to_state)` — never per tool call. `journeys[].steps[]` references them, the way `journeys[].transitions[]` already does. | §3: an edge is first-class again, so `preconditions[]`/`effects[]` leave `behaviors[]`. **P12 is repaired** (it cannot hold without this — see the note below). |
| **D6** | **The ABM represents unwalked affordances.** `state.affordances[]` — an affordance is offered *by a surface*, so it lives on the state that offers it. | §3: new array + **P13**, which makes "nobody did this" checkable rather than asserted. |
| **D7** | **No `features[]` in the ABM.** Feature grouping stays a `graph.json` layer; the ABM is a behaviour model, not a product map. | §3: "what the ABM deliberately does not gain". §2: `feature.schema.json` is **not** forked. The `feature` protocol argument keeps feeding `graph.json` only. |
| **D8** | **An acceptance number needs a floor under it, and a shared rule needs a test.** "Zero errors" is satisfiable by recording less, "byte-comparable" is not a property of bytes, and "one definition" is an intention until something runs both. | §5: Phase 2's acceptance is four checkable clauses — validity **and** the counts 0.1.22 carried **and** a key-path diff **and** `profileFindings` ≡ `invariantsOf`. Every later phase states its acceptance the same way. |
| **D9** | **Three epistemic levels, preserved and enforced.** A **fact** the collector captured, a **reading** a producer inferred from it, and a **derivation** the model computed from other claims are three different claims, and the document must not let one turn into another over rebuilds. | §3: the levels ride fields that already exist (`evidence[]` roles, `metadata.status` / `producer` / `confidence`) — no parallel mechanism — and **P14/P15** make the relationship a rule instead of a convention. Also true of ABG 0.1, so the rule is shared and D8's drift test covers both. |
| **D10** | **The generator reads the ABM, and that is the milestone.** An integration test written from the semantic model, with `graph.json` not consulted as the semantic source. | §5: Phase 4 is in the MVP, not deferred. A model nothing downstream reads cannot be wrong in a way that matters. |
| **D11** | **An object's level is the minimum of the claims it carries.** One `metadata` block covers several claims — a behaviour's *name* and its *edge*, a state's *identity* and its *reading* — and D9 says those are different claims, so the level of the record is the weakest of them. Derived from `producer` + `composed_of` on the fly; no second field, no `metadata.extra.levels`. | §3: **P14/P15** are the enforcement. The consequence is accepted here rather than discovered later: the three 0.1.22 edges become `inferred`, which makes **P10 reachable on walks that look clean today** — an `inferred` behaviour cannot back a `criticality: critical` journey, so a walk that used to report nothing now reports a warning. That is the rule working, not a regression. |
| **D12** | **The collapse keys on the behaviour's last realisation step.** A behaviour's edge is `(the state it began in, the behaviour, the state its **last** step arrived in)`. The steps before it are `realization[]`, not edges — so a sign-in that types twice and submits is one edge, and a behaviour that really does end where it started is a self-loop by the same rule, with no special case and no second identity for a thing that already has one. | §3: **P12a/P12b gain the sequence form** — a behaviour with no steps of its own (a genuine composite) is accounted for by its members' edges in `composed_of` order. §5 Phase 2: the assembly groups an invocation's calls into **one** edge, the one that ends where the last step landed, instead of one edge per call; `journeys[].steps[]` naming a behaviour therefore means the behaviour completed. §1: what fills that layer in is the **run** — `capabilities[].steps[]`, the field ABG 0.1 already declares as "how to realise the capability in the UI" and 0.2 calls `realization[]`, empty in every run recorded so far. |
| **D13** | **The projection reports the run's vocabulary; the demotion belongs where the realisation was recorded.** A capability the model declared a step of a behaviour is not a behaviour — but only a run that *recorded* the step can say so, and the gate is that record (`capabilities[].steps[]`, which the commit fills in from the `realization_step` log), never `composed_of` alone. On 0.1.22 there is no recorded realisation, so 0b demotes nothing and the baseline keeps its four behaviours. | §5 Phase 1/2: `behaviors[]` holds `login` and not the three step capabilities, so the acceptance clause holds as written. The demotion lands **with** the collapse, because demoting without it makes an existing rule fire (measured: `P12/duplicate_transition`). §3: **P1 keeps its authority over the names that are left** — a mechanism name among the behaviours is still refused; it simply stops being a count of the protocol's output. §7: Phase 3's measure moves to the log (capabilities recorded with no behaviour attached), because that is the number the protocol moves and a projection cannot. |
| **D14** | **`steps[]` and `composed_of` are two claims in 0.1 and one claim in 0.2, so Phase 1 records the realisation *beside* the composition and Phase 2 owes the demotion.** In 0.1 a `capabilityStep` cannot name a capability (`additionalProperties: false`), so a step says *what was done, on what, with what value* and never *whose step it is*: the step-of relation stays `composed_of`. The two fields are therefore not two answers to one question in `graph.json`, and the "beside" clause is forced rather than cautious. In 0.2 they are one question: `behavior.realization[]` carries `purpose` and lives *inside* the behaviour, so containment already says whose step it is — and 0.2's own schema prose calls a non-empty `realization[]` beside a non-empty `composed_of` "two answers to one question". | §5 Phase 2: `behaviors[].realization[]` is folded from `capability.steps[]`, and the behaviour's `composed_of` is then **dropped** (D3's demotion), kept only where the behaviour is genuinely built from other behaviours. A behaviour with both is the one shape P3's restatement was written to stop. Phase 1 does not pre-empt this: `graph.json` is a faithful reading of what the run recorded, and it is Phase 2's assembly that knows the relation has become containment. |
| **D15** | **An affordance is refuted by the walk, so it is checked against the surface it was read from and counted where `graph.json` has no room for it.** The claim names an element by **ID**, and the element has to be one *this state's own readings* declare — not one some other state declared, which is a claim about a different surface. `affordances` is refused without `page_type`, because a claim with no surface outlives the page that supports it and nothing can refute it after that. And because 0.1's `state.schema.json` is `additionalProperties: false`, the claim stays in the log and the commit reports `states.affordances: {recorded, surfaces, retired}`, where `retired` counts the ones a committed step performed — the walk, not the model's memory of the surface, is what settles whether "nobody did this" is true. | §5 Phase 1 (Stage C): `graph_observe` gains `affordances`, `normalizeAffordance` fixes the keys to the schema's own, and the reading is the only moment the claim can be made. §5 Phase 2: the ABM's `state.affordances[]` is assembled from these claims, and P13 compares the two. Rejected and named: checking against the whole element registry (lets a claim about the wrong surface through), accepting the claim without a state (unrefutable), and carrying the claims into `graph.json`'s `metadata.extra` (the document has no field for them, and a claim smuggled into metadata is one the document does not describe). |

**Why D14 is a decision and not a detail.** Phase 1's plan says the realisation is recorded "beside
the composition rather than in place of it", and 0.2's `behavior.realization` doc says a behaviour
with both "has two answers to one question" — read together those two lines look like a contradiction,
and the temptation is to demote in Phase 1 or to narrow the clause. Neither is needed, because the
fields are not the same size. A `capabilityStep` is closed: `action`, `element`, `value`, `arguments`,
`optional`, `description`, `timeout_ms`, and no capability among them. So `cap_login.steps[]` says
*type the email, then click submit* and cannot say that those are steps **of** `login`; that is
`composed_of`, and it is the only place the relation is written down. 0.2 changes the shape by putting
the steps **inside** the behaviour, at which point containment carries what `composed_of` used to and
carrying both would genuinely be two answers. The demotion is therefore not "we now know better than
the pair" — it is the same statement, moved from a reference to a nesting.

**Why D5 is not just a preference — P12 could not hold without it.** The current §3 made a walk step a
*behaviour* (`login`) while P12 demanded "every committed transition appears as exactly one
`journeys[].steps[]` entry". On the real 0.1.22 run that is **3 committed transitions against 1
behaviour-level step**, so the rule fails on the very run it was written to check. It holds today only
because `assembleJourneys` builds `journeys[].transitions[]` per *call* (`commit.js:1183`) — i.e. the
rule was accidentally reading the graph's own granularity, not the ABM's. An edge whose unit is the
behaviour is what makes the rule sound, and collapsing 3 calls into 1 edge is the pivot itself.

**Why D11 is a derivation and not a field.** The alternative — one level per claim, written into the
document — makes the level something an author can write down and get wrong, and leaves the document
with two answers to one question (the status it reports, the level it declares). Computing it from
`producer` + `composed_of` means the *fix* P14 asks for is one line over the same object list the rule
read, so the rule cannot demand something the document has no way to express: the shape is
`LEVEL_CEILING[level]` written onto each `metadata`. The cost is that the level cannot be finer than
the object: a behaviour's name and its realization share a behaviour, so a walked behaviour with an
LLM's name is `inferred` — and that is the conservative answer, because the name is what a generated
test asserts on.

**Why D12 is a derivation and not a second identity.** D5 says one edge per
`(from_state, behaviour, to_state)` and stops there, which leaves the actual question open: when
three calls collapse into one behaviour, *which* state change is the edge? The other answer — keep
every state change as an edge and let the self-loop name itself — would put two edges in the
document for one behaviour applied from one state (`login` leaving `state_login_anonymous` for
`state_login_anonymous`, and for `state_project_list_…`), and then `journeys[].steps[]` naming
`login` no longer says whether the walk arrived. It would also be a second name for a thing that
already has one.

Keying on the last step needs no new field: the destination is whatever the behaviour's **last**
step recorded, and the earlier steps are exactly what `realization[]` is for. Three consequences
follow, and they are why this is written down rather than left to the implementation:

- **An edge's destination is not known until the behaviour stops being extended.** So the assembly
  *derives* it at the end and does not guess early: it groups an invocation's calls and emits the one
  edge whose destination is the last call's, rather than emitting an edge per call and retracting the
  ones that turned out to be steps. The log keeps every call — `graph.json` needs them (D1) — so
  nothing is ever unwritten, and the commit is where the two readings are reconciled, which is what
  the store's append-only shape already assumes. Two invocations of one behaviour between the same
  two states are still one edge (D5's key), walked twice; `journeys[].steps[]` names it twice.
- **A real self-loop needs no special case.** A behaviour whose last step lands where it began is
  `A → A`, decided by the same rule. "Typed and left" against "typed and stayed" is not a property
  of the collapse; it is what the last step's reading says.
- **What makes it safe is a check that already exists.** P12a requires every committed call to be
  accounted for by an edge of a behaviour **whose own edge starts where that call started**. Every
  step of a behaviour starts where the behaviour started, so a collapse satisfies P12a by
  construction — and a behaviour whose steps pass through a third state cannot be collapsed at all:
  that state is a state no edge explains, and the reading taken there is a fact. It is refused,
  which is the right answer, because the walk really did go through it.

One level up, the same rule covers a behaviour with no `realization[]` of its own: a composite's
edge is the span of its **members'** edges in `composed_of` order. That is the third case P12a/P12b
have to carry, because "backed by a committed transition with the same behaviour" is false of a
composite by construction — nobody called `checkout`, they called `add_to_cart` and then `pay`.

**D12 also says where the ABM's behaviour layer is read from, and the honest answer is not the
obvious one.** `graph.json` *can* carry it: ABG 0.1's `capability.steps` is documented as "how to
realise the capability in the UI. Ordered, deterministic. Values may reference input parameters with
`{{param}}` placeholders" — that is 0.2's `realization[]` under a different name, the same
rename-as-translation D2 already does for `state.capabilities` → `state.behaviors`. `lib/abm.js`
already reads it (`stepsOfCapability`, which stamps `extra.derived: 'capability.steps'`). What the
real run does not carry is any *content* in that field: measured on the 0.1.22 walk, all four
committed capabilities have `steps: []`, because the commit puts steps on the **edge** and never
populates the body — and `capability_behaviour` (0.1.21) records the step-of relation as
`composed_of` instead. So Phase 1 does not need a new concept; it needs a field the vendored schema
already declares and the projection already reads to be **filled in**. One thing that fold cannot
carry, though, and it corrects an earlier draft of this note: `capabilityStep` has no field that
names a capability (`additionalProperties: false`; its fields are `action`, `element`, `value`,
`arguments`, `optional`, `description`, `timeout_ms`). A step in `graph.json` can therefore say what
was done and where, and cannot say *whose step it is* — the relation stays `composed_of` on the
capability, which is how 0.1.21 already records it and which the projection already translates to
behaviour ids. So the fold gives the ABM the **steps**; the **step-of relation** was never missing,
and never needed a new field. Until a run records realization, 0b keeps reporting one behaviour per
committed capability — that is what those runs recorded, and P1's three findings are a fact about the
walk, not about the projection. Whether the projection may *act* on that relation is D13.

**Why the projection may not demote on today's document, and where it may (D13).** Phase 1's
acceptance has two halves — `login` with three ordered `realization[]` steps, **and** no top-level
step capability — and on a Phase-1 walk the second half has to mean `behaviors[]` does not contain
`fill_login_email`, which the first half does not produce by itself: the projection makes one
behaviour per committed capability, and D1 keeps the step capability committed so `graph.json` stays
faithful. The tempting fix is to demote it — `cap_login.composed_of` names all three, so a capability
another capability names is a step, not a behaviour — and the tempting part is exactly the problem.
**In 0b the demotion cannot be done without inventing, and that was measured rather than assumed.** A
0.2 `realization[]` step needs an `action` from ABG's enum (`fill`, `click`, …) and an `element`. The
committed 0.1.22 transition carries `action: {capability, arguments, target}` and
`effects: [value_changed]`: the **element is recoverable** (`transition.action.target`), and the
**verb exists nowhere** — the only place it appears is the capability's own name, `fill_login_email`
→ `fill`. A 0b that demoted would take the mechanics from the name P1 refuses, and `stepsOfCapability`
would be carrying a document whose realisation was derived from the defect it reports. A profile that
reads a run's claim and then repairs the run's document is not a profile.

Two further consequences, and the first was measured rather than argued:

- **Demoting without collapsing is refused, by a rule that already exists — so D13 lands with D12,
  which is Phase 2's assembly.** The probe: take 0b's projection of the real 0.1.22 document, apply
  D13's demotion to it by hand (drop the three step behaviours, give `login` the three steps, point
  every edge at `login`), and profile it. **`P12/duplicate_transition` fires** —
  `state_login_anonymous → state_login_anonymous via "behavior_login" is already
  transition_fill_login_email` — because one behaviour applied from one state to the same state is
  one edge (D5) and two edges for one move are two claims about the same walk. The same probe says
  something worth keeping: **P12a stays silent.** The two typing calls are accounted for by the
  `carriedAsStep` clause — a `realization[]` step on the element the call targeted, in a behaviour
  whose own edge starts where the call started — so the collapse needs **no new coverage rule**.
  Those clauses are ordinary 0b code rather than something D12 added; what D12 did was name the
  relation they were always checking.
- **Demoting is not what makes the ABM right — recording is.** Once a run records `action` and
  `element` per step, reading the relation is reading a fact, and the rule needs not even the gate on
  where the document came from: a capability the model declared a step of a behaviour is not a
  behaviour. `capabilities[].steps[]` is the gate only because it is where the commit *puts* that
  record, and on 0.1.22 it is empty on all four capabilities for the measured reason in the paragraph
  above — the commit writes steps on the edge and never fills the body in. So the gate excludes the
  old document automatically, which is what keeps 0b's baseline a baseline.

**And P1 keeps its authority over the names that are left.** After the demotion the ABM's behaviours
are `login` and whatever else a run named as a behaviour, and P1 still refuses a mechanism name among
them. What changes is that it stops being a *measure of the protocol's output*, because the three
capabilities it used to fire on never become behaviours. The protocol's job is to make the run attach
steps to behaviours, and the number that measures it is how many capabilities the run recorded with
**no** behaviour attached — visible in the log, and unmovable by any projection.

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
| Epistemic level | `metadata.status` reports whether **the walk** was observed, and an LLM-inferred behaviour *name* shares that one block — measured: `cap_submit_login` reads `status: verified, confidence: 1` while the name is pure inference | D9: the level is a property of **the claim**, not of the record. A behaviour's name is `inferred` even when its edge is `observed`, and P14 refuses the promotion |
| Consumers | `graph_test` (unchanged today), anything already reading ABG 0.1 | **`graph_test` from Phase 4 (D10)**, plus the PR→test path this pivot exists for |
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
   The `$ref` chain inside `abm/0.2/` is self-contained, so this is a mechanical rewrite of the
   10 files, done once at vendoring time.

### Validation, without costing `npm test` its offline property

The plugin's current stance is deliberate: **`npm test` needs no install** (`README`
"Testing"), which is why the ajv validator lives out-of-repo at `~/tmp/schema-check/`. Bringing
the schemas in-repo must not quietly break that, and gap 8 — *a green commit can write a
schema-invalid graph, twice measured* — must be closed, not just re-homed.

So, two layers:

| Layer | Where | Deps | Runs |
| --- | --- | --- | --- |
| **Structural validator** | `lib/validate.js` (new) | none | always, inside `commitRun`, before `ok` is reported — the gap-8 fix |
| **Full JSON Schema validation** | `test/prove-schema.mjs` (new) | `ajv` + `ajv-formats`, **devDependency, opt-in** | `npm run prove:schema`, and in the verification protocol |

The two layers are not a subset relation, and 0a measured why. Every `$ref` in the ABM is an id
*string*, so `transition_nonexistent` validates cleanly: **the schemas cannot check that a
reference resolves, only that it is spelled like a reference.** `lib/validate.js` is therefore
the only layer that does references at all, which is a stronger reason for it than gap 8 alone,
and it is the layer that gets to run inside `commitRun`.

`lib/validate.js` is not a JSON Schema implementation. It checks the things the schemas state
mechanically **and** the commit is the last chance to catch: every `$ref` id resolves, every
enum membership (`behavior.realization[].action`, `effect.type`, `state.kind`, `metadata.status`),
every required field, and every `pattern`. That is exactly the set the plugin already enforces
piecemeal in `lib/schema.js` (`DETECTION_TYPES`, `EFFECT_REQUIRED`, `CAPABILITY_NAME_PATTERN`, …)
— one table, read by both the recording tools and the commit, is the `CONTROL_ROLES` precedent
applied to validation.

**Recommended, stated as a tradeoff:** `ajv` as a devDependency is the honest way to validate
against the real schemas, and `npm test` staying dependency-free is preserved by keeping
`npm run prove:schema` a separate, opt-in script. If you would rather keep the plugin's
`package.json` dependency-free entirely, the alternative is to keep ajv out-of-repo and point
`~/tmp/schema-check/validate.mjs` at the in-repo schemas via `GRAPH_SCHEMA_ID` / `GRAPH_SCHEMA_DIR`
— the schemas are still vendored and versioned here, which is the part D2 actually asks for.

## 3. The ABM document, concretely

```jsonc
{
  "schema_version": "0.2",
  "generator": { "name": "dsh-graph-explorer", "version": "0.1.30" },
  "application": {
    "id": "app_acme-demo", "name": "Acme Demo App", "base_url": "http://127.0.0.1:4173/",
    "actors": [                                             // D2: top-level array, populated
      { "id": "anonymous" },                                // P6: the actor id IS the variant
      { "id": "authenticated", "credentials_ref": "TEST_USER" }   //   vocabulary the states already
    ]                                                        //   use, so the rule fits the measured
                                                             //   evidence instead of rewriting it
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
      "detection": {"type": "value", "element": "element_project_list",
                    "operator": "equals", "expected": "populated"},   // P7: an ELEMENT, not a storage key.
                                                             //   The rule is structural here: the schema's
                                                             //   `allOf` requires `element` for every type
                                                             //   except `route`, which requires `route`,
                                                             //   so no document can state the storage case
                                                             //   P7 exists to refuse
      "evidence": [{"observation": "obs_0004", "role": "effect"}] }
  ],

  "behaviors": [                                            // the vocabulary: what an actor can DO
    {
      "id": "behavior_login",
      "name": "login",                                      // P1: the verb a user would ask for
      "kind": "interaction",
      "actor": "anonymous",
      "input":  { "email": {"type":"string","required":true},
                  "password": {"type":"string","required":true,"format":"password"} },
      "output": { "session": {"type":"object","description":"The session the login produced."} },
                                                             // the key names an entities[].name: the join
                                                             // is by name, the way effects[].target joins
                                                             // to entities (P8), so there is no `entity`
                                                             // keyword to learn
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
      "guard": "the login form accepted the credentials",   // the condition that made it possible.
                                                             //   Omitted when there is none, never null:
                                                             //   `guard` is a string, and an explicit null
                                                             //   would be a second way to say "no guard"
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
          "expected_behavior": "reset_password",             // a hypothesis. Being IN this array is the
                                                             //   whole of the claim that nobody took it,
                                                             //   so there is no `status: unwalked` to set:
                                                             //   metadata.status is bookkeeping, and this
                                                             //   is a statement about the application
          "metadata": { "confidence":0.3, "producer":"llm:deepseek-flash" } }
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
          "metadata": { "confidence":0.3 } },
        { "element": "element_nav_settings", "expected_behavior": "open_settings",  "metadata": { "confidence":0.3 } },
        { "element": "element_logout_button", "expected_behavior": "sign_out",     "metadata": { "confidence":0.3 } },
        { "element": "element_add_project_button", "expected_behavior": "create_project", "metadata": { "confidence":0.3 } }
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
      "goal_stated": true,                                  // D4: false = the tools derived this walk and
                                                             //   nobody asked for the outcome. A derived
                                                             //   journey is still a journey; a reader just
                                                             //   has to be told which kind it is holding
      "actor": "authenticated",
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
| P12 | **Walk preservation (D4 + D5, with D12 for the sequence form), both directions.** *(a)* every transition `graph.json` committed is accounted for in the ABM — as an edge's behaviour, as a `realization[]` step of a behaviour whose own edge starts where that transition started (and that step's element may be named by the transition's `target` **or** by the element the realisation itself records: `lib/protocol.js` never asks the walk for `target`, so reading only that field is a rule no live run can satisfy — measured on 0.1.26, both `fill` calls), or as a member of the composite whose `composed_of` names it, when the composite's edge is the span of its members' edges in order; *(b)* every `transitions[]` entry is backed by ≥1 committed graph transition — the same `from_state`/`to_state`/behaviour, or that in-order sequence of member transitions for a composite; *(c)* the ABM has ≥1 journey (D4) and every `journeys[].steps[]` entry names a `transitions[]` id | `error` — the D1 coherence check |
| P13 | **An affordance is offered, not performed (D6).** Every `state.affordances[].element` is declared in **that same state's** `elements[]`; an affordance whose element *is* the target of a committed `realization[]` step is reported, because the walk itself refutes "nobody did this" | `error` (unresolved element) / `warning` (`affordance_already_walked`) |
| P14 | **No claim outranks its support (D9, D11).** A `verified` claim must be shown by the observations it cites *for that claim*: a behaviour's **name** is not verified by the observation that a click happened, so the name is `inferred` even when its edge is `observed`. Formally, an object's level is the **minimum** over the claims it carries — its own producer's level and its inputs' levels — so no chain of rebuilds, re-projections or re-imports can promote an inference to a fact. Codes: `claim_outranks_its_producer`, `claim_outranks_its_inputs` (a composition inherited a weaker part), `claim_has_no_producer` (a derivation) | `error` |
| P15 | **An inference names itself and its basis (D9).** Every `status: inferred` claim names its `producer` and points at the observations it was inferred *from* (its `evidence[]`, its `composed_of`, or a stated derivation). An inference with no basis is a hallucination and is reported as one. Distinct from P9, which asks that evidence **exist**. Codes: `inference_without_producer`, `inference_without_basis` | `error` |

P1 and P3 are the ones that make this the pivot rather than a rename: P1 refuses the exact names
the 0.1.22 run produced, and P3 stops `composed_of` from being used as a stand-in for realisation.
P12 is the load-bearing one and it is why D5 exists: as written before D5 it could not hold — it
demanded one `journeys[].steps[]` entry per committed transition while §3 made a step a
*behaviour*, which is 1 against the real run's 3. It now checks the same fact in the unit the ABM
actually uses, and it is the pivot stated as a gate: **three committed calls become one edge and
three ordered realization steps, and nothing is allowed to go missing in the collapse.**

**Where that rule stops, and why it had to be said.** A collapse may not hide a *state*, so an
invocation whose steps passed through a state neither of the edge's endpoints names, and which no
step's `state_entered` accounts for, is refused (`collapsed_past_a_state`). The edge's own two
endpoints are where that stops. A call that stays where the walk already stood — a self-loop, which
is what typing into a form is — puts that state in `passed_through`, and that state is the surviving
edge's `from_state`; demanding the behaviour *arrive* there asks for a `state_entered` no honest
step can record, because the walk never entered the state, it was already in it. The 0.1.25 live
sign-in run is the case that measured it: three calls over two states, one behaviour, and a model
withheld for a state the edge itself names. **A rule whose sole satisfaction is a lie is the rule
that was wrong** — the rule was narrowed to the two endpoints and given its own floor (three
checks in `test/abm-commit.test.mjs` and a 30th proof case) rather than deleted, because its real
content — a state the edge does *not* name — is the D12 claim.

**P14/P15 are the rules the project's own doctrine demands, and they fail on today's output.** A
rule nothing enforces is not a rule the schema has, and the schema's `status` enum is currently
advice: measured on the real 0.1.22 walk, `cap_fill_login_email`, `cap_fill_login_password` and
`cap_submit_login` all carry `status: verified, confidence: 1, producer: llm:deepseek-flash` —
per-element interactions the LLM *named*, reported at the confidence of things the collector
*saw*. `cap_login` is honest (`inferred, 0.5`, no evidence); its three members are not. The
vocabulary is right and the object it is attached to is wrong: the status describes the walk, the
name is a reading, and they share one block. Nothing promotes them on purpose — the promotion is
in the **copy**: any tool that reads a document and writes one back carries `verified` forward, and
after a few rebuilds a naming guess is indistinguishable from a capture. That is the failure mode
that makes this matter for PR analysis, where a claimed behaviour is compared against a diff and
reported as fact. So P14 is enforced over **both** documents (D1/D8): `graph.json` commits the same
promotion today, and `invariantsOf()` is where the graph-side half belongs.

**Measured once the rules are in (0b): 9 P14 refusals and no P15 on the 0.1.22 walk** — the three
per-element behaviours, their three edges, both states (all `claim_outranks_its_producer`) and one
derived state variable, `projects`, which the projection computes and nobody signed
(`claim_has_no_producer`). Two things about that count are worth keeping:

- **The edges and the states are refused too, and that is the same defect, less loud.** A `0.95`
  reading of a page presented as `verified` is the naming defect with the volume down: the
  collector saw the page; what it *is* was read. Reporting only the three behaviours would have made
  the rule look like a naming rule.
- **The projection is the mechanism, not only the witness.** `lib/abm.js` re-emits those `metadata`
  blocks verbatim, so before P14 the fork's own tool was the thing carrying `verified` forward. That
  is why the rule is written over *claims* rather than over behaviours: the objects it names include
  the ones the new pipeline had just invented.

And the two objects the walk got right stay untouched, which is what makes the rule usable: the
composite `cap_login` (`inferred, 0.5, producer: llm:deepseek-flash`, its basis its three members)
and the journey (`inferred`, `importer:dsh-graph-explorer`) both pass, so P14 is not a rule that
fires on everything a model touched.

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
- **`graph_test` and the generated spec — the *reading* changed, the shape did not.** It read
  `graph.json` while Phase 4 was being built, so the spec path kept working on day one and reverting
  Phase 4 cost nothing — the fallback doing its job (D1). It now reads the ABM (D10), through the one
  adapter that hands the generator the shape it reads, and the graph is still a single `source`
  argument away: two readings of one run, both available, both reproducible from the committed
  document alone.
- **The `features[]` layer (D7).** `features[]` stays a `graph.json` property. The `feature`
  protocol argument keeps feeding it and `feature_closure` keeps checking it; the ABM ignores it.
  A consumer that needs product grouping reads the fallback — which is what a fallback is for.
- **The lossless-JSON tool boundary** (`test/lossless.mjs`).

## 5. Phases

### Phase 0 — vendor the schemas, and make the ABM derivable offline (1 day)

Two halves, both cheap and both de-risking everything after them.

**0a — vendoring (D2). DONE.** `schemas/0.1/` is byte-identical (`diff -r` clean, sha256s match
upstream) and `VENDOR.md` carries the hashes and the two-directory policy. `schemas/abm/0.2/` is
forked: the new root, the `$id` rewrite, the **behaviour-level `transitions[]`** (D5),
`state.affordances[]` (D6) and the `journeys[].steps[]` / `realization[]` additions — and
**without** `feature.schema.json` (D7).

The fork is proved rather than declared, by `test/prove-schema.mjs` (opt-in ajv, in the style of
`prove-generate.py`): 23 mutations, each the structural half of a recorded decision, **23 refused,
0 survived**. Without ajv it prints `SKIP` and exits 0, so `npm test` stays dependency-free.

Four things 0a settled that the plan had wrong or had not seen:

1. **§3's example did not validate, in five places.** The actor ids (`anonymous_visitor`) did not
   match the state variants (`anonymous`) that P6 joins them to; the detection used the old
   `target` field where the schema now requires `element` or `route`; the affordances carried
   `metadata.status: "unwalked"`, which is not a member of the `metadata` enumeration and does
   not belong there; `guard: null` is not a string; and `output` used an `entity` keyword that
   `argumentValueSpec` does not have. All five are fixed on both sides. Writing the example down
   as an executable fixture is what surfaced them.
2. **`metadata.status` cannot hold `unwalked`.** `metadata` is defined as bookkeeping, "never
   application semantics", and `unwalked` is a statement about the application. Being in
   `state.affordances[]` is the claim; adding an enum member to a shared def would also have made
   `common.schema.json` diverge, which is the one file whose value is that it did not.
3. **The schema cannot check a single reference,** which is measured, not assumed:
   `transition_nonexistent` is a well-formed transition id. Every dangling reference is therefore
   a *schema-valid* document. This is a stronger argument for Phase 2's `lib/validate.js` than
   gap 8 gave — the in-repo layer is not a cheap subset of the ajv layer, it is the only layer
   that can do references at all, and it is the one that has to run inside `commitRun`.
4. **P7 is structural.** The detection `allOf` requires `element` for every type except `route`,
   which requires `route`, so the storage-key case P7 exists to refuse cannot be stated in a
   document at all — a rule the shape enforces is worth more than a rule the profile reports.

**Acceptance (0a): MET.** `npm run prove:schema` validates the 0.1.22 `graph.json` against
`schemas/0.1/` (proving the vendored copy is intact) and
`test/fixtures/abm/example.json` against `schemas/abm/0.2/`. The fixture is §3 made executable,
and it is also the expected shape for 0b.

**0b — the projection, as a *check*, not as the pipeline. DONE.** `lib/abm.js` is pure and writes
nothing: `modelFromCandidates(candidates)` → the ABM shape of §3, and `profileFindings(model,
{candidates})` → P1–P15 as the flat findings `commitRun` already emits (`{rule, code, severity,
scope, subject, detail, basis}`), counted by `summarizeFindings()` for a CLI. This is a **diagnostic
over recorded runs**, never the production path — `commitRun` will build the same document from the
same store, and 0b exists to have something to measure with before any live run.

- `npm test` is **10 suites**; `test/abm.test.mjs` is 97 checks, one per rule plus both directions
  of each ("break exactly this one thing, and exactly this one rule notices"), including one case
  that writes each claim's own ceiling and asserts P14 goes quiet — the floor D8 asks for under the
  rule, since a rule that cannot be satisfied can only be satisfied by recording less.
- `npm run profile:abm` (`test/abm-baseline.mjs`) is the acceptance proof. It is a harness and not
  a suite, because the run it profiles is not in the clone: with no run directory it prints `SKIP`
  and exits 0.
- Fixtures: `artifacts/graph-spike/` (the 0.1.0 run that never committed) and
  `~/tmp/live-graph/graph-run/` (the 0.1.22 sign-in walk). Both are local — `artifacts/` is ignored,
  and a run recorded on a machine is not evidence a clone has — so `profile:abm` takes a directory
  and SKIPs without one.

**Acceptance (0b): MET.** Over the 0.1.22 walk the profile reports
`{total: 15, errors: 12, warnings: 3, failed: true}` — **P1 ×3, on exactly the three motivating
behaviours** (`behavior_fill_login_email`, `behavior_fill_login_password`, `behavior_submit_login`),
P2 ×3 because those three capabilities are steps of `login` and have no `realization[]`, **P14 ×9**
for the level those three are reported at and the edges and states that share the defect (§3), and
**nothing else**: P15 and P3–P13 are silent on the real document, which is the half of the claim that
matters. The proof does not compare against a snapshot — it derives the expected refusals from the
run's own logs, both halves: every committed capability whose leading word is a mechanism verb must
come out refused by P1 (and nothing else may be refused for that reason), and every object whose own
`producer` is a reading (`llm:*`, `importer:*`) while its `status` is `verified` must come out refused
by P14 — so a fixture cannot be made to pass by editing the fixture. P15's silence is asserted the
same way, against the log: every inference this walk made names its producer, so there is nothing for
the rule to report. It also asserts that the projection validates against `schemas/abm/0.2/` (ajv, all
10 schemas, resolved by `test/ajv.mjs`) and that profiling a run does not modify the run it read.

Five things 0b settled that the plan had not seen:

1. **P9 reads a composition as anchored by its parts.** §3's literal wording refuses `cap_login`,
   which carries no `evidence` key at all while the three capabilities it names do — and a
   composition's evidence *is* its parts': the readings of `fill_email → fill_password → submit`
   are the readings of `login`. Anchoring therefore recurses, and it still has teeth: a leaf with no
   evidence is refused, and a member that loses its anchor de-anchors the composite above it (both
   are reported, because both are now unobserved claims). This is a reading of §3, not a relaxation
   of it, and it is the one place the implementation does not follow the table word for word.
2. **The log path is the commit, run again — not a second reading of the same evidence.**
   `candidatesFromRun()` prefers `graph.json`; without it it calls `reconcile()` from `commit.js`
   and projects `graph ?? draft`, carrying the commit's blocking gates as notes. The `.jsonl`
   records are *candidate*-shaped (`semantic_purpose` instead of `semantic`, a raw CSS string
   instead of a locator object, no element id at all), so anything this module normalised by hand
   would have been a divergent second opinion about the same run — and it was: the hand-written
   version produced a document that failed validation on seven counts. It also means a run that
   never committed is profileable, which is precisely the run a profile is for.
3. **A run that declares no application cannot be projected, and is refused in the commit's own
   words.** `modelFromCandidates()` throws naming `application_not_declared` rather than emitting a
   placeholder: `application.id` and `application.name` are required by the schema, a host is not an
   application, and a placeholder would produce a document that passes every shape check while
   naming nothing. Measured on `graph-spike` (which has no `application` in `run.json`): the two
   refusals agree, and `test/abm-baseline.mjs` asserts that they do.
4. **A missing committed log is not a missing walk.** P12 needs the committed transitions to say
   whether an edge was walked; with no log it reports one `info` (`coverage_unchecked`) and skips
   both coverage loops. Refusing every edge instead would turn an absent input into a document full
   of invented moves — the loudest possible false accusation.
5. **0.1's `state.capabilities` is 0.2's `state.behaviors` (D2), and an id that no capability
   declares is dropped with a note**, not carried as a behaviour that does not exist. This is the
   second half of 0a's finding that the schema cannot check a single reference: being unable to
   check it means the *projection* has to, and say so when it does.

**0b is also where 0a's unenforced rules land**, and both families now have an owner: the five
`SHAPE_ONLY` references are P4/P6/P12/P13 (`test/abm.test.mjs` checks each one refuses), and the
five `NOT_STRUCTURAL` judgement rules are P1/P5/P9/P10/P11. `prove-schema.mjs` lists both families
so neither can be quietly forgotten, and `test/ajv.mjs` is now the one place that knows how to find
ajv on this machine (ESM `import()` ignores `NODE_PATH`, which is why the schema proof used to
`SKIP` here while the fork proof passed).

### Phase 1 — behavioural recording

`lib/index.js`, `graph_transition` (index.js:1482).

- New argument: `realization` (the step shape: `{action, element, value}` — plus `purpose` and
  `effects`, which are the behaviour model's and stay in the log — so this is a translation of ABG
  0.1's `capabilityStep` and not a new vocabulary). There is no new `behavior` argument: the
  behaviour this step belongs to is named by **`capability_behaviour`**, which 0.1.21 already has and
  which the call already uses to write `composed_of`. One argument doing one job.
- Rule: when `capability_behaviour` is given, the call **also** appends a realization step to that
  behaviour (via a new `store.addRealizationStep`) **and** keeps minting the step capability as it
  does today, so `graph.json` stays faithful (D1). One call, both documents.
- **D12 shapes what these records have to make derivable.** The assembly has to be able to see *one
  invocation* of a behaviour — which calls were its steps, and in what order — because the behaviour's
  edge is its last step's destination. So a realization record carries the behaviour, its position,
  and the call it came from; the edge itself is not written at recording time. Grouping is over
  consecutive calls in walk order, so a behaviour that appears again later is a second invocation and
  D5's key merges it with the first when the states are the same. The `capability_behaviour` argument
  (0.1.21) already links a step to a behaviour, and today does it by writing `composed_of`; Phase 1
  records the link the ABM reads — `capability.steps`, folded at commit from the `realization_step`
  records — beside the composition rather than in place of it, so `graph.json` keeps the composition
  it has always had.
- `graph_observe` (index.js:1197) gains `affordances` — the elements the reading offers and the walk
  is not exercising (D6). The reading is the only moment an affordance can be recorded, because it is
  a fact about the surface. **Stage C: implemented.** `normalizeAffordance` accepts exactly the keys
  `state.schema.json#/$defs/affordance` declares, minus `evidence` (the reading that made the claim,
  which the commit writes) and `metadata` (bookkeeping — `confidence` in particular is not the
  model's to set: an affordance is a claim about a behaviour nobody performed, so there is nothing
  for the claim to be confident about). The element is refused unless **this state's own readings**
  declare it — a near miss tells the model which state does, because the repair is not the same — and
  `affordances` without `page_type` is refused, because the claim would outlive the page that
  supports it. The claims are appended to `states.jsonl` on the reading, which is the one place the
  counter is honest: a reading of a state already seen is a *sighting*, and a sighting's affordance is
  a claim about the same surface made later. `graph.json` cannot carry them (D15), so the reading's
  digest reports the ones it recorded and `report.states.affordances` counts them, `retired` among
  them.
- Actors come from **config** beside `application:` in `cordis.patch.yml` — the actor vocabulary
  is a property of the application, not of a walk, and config is where `application` already lives.
  0.1's `application.schema.json` **already declares `actors[]`**, so this is not a new field either:
  Phase 1 populates a field the graph has always had and no run has ever filled in. The reading does
  **not** take an `actor` argument — an earlier draft of this plan had it doing so, and the reason it
  does not is D13's reason in miniature: a per-reading actor answers a question nobody asked, while the
  registry is what a journey's `actor` ("must equal", 0.2) and a state's variant both resolve against.
- `lib/session.js`: `addRealizationStep(capabilityId, step)`, and append-only records
  (`kind: 'realization_step'`), consistent with "a reading appends a new state or a sighting" — and
  **the commit folds those records into `capabilities[].steps[]`**, which is the field the ABM reads
  (`stepsOfCapability`). That fold is what makes the second half of the acceptance below reachable
  without `reconcile()` or `modelFromCandidates()` learning a new concept, and it is an *added* key
  per record, which the D8 key-path clause already allows for.
- Early refusals matching P1/P4/P5/P7/P13 while the page is still on screen, and all of them before
  the first write: an unknown verb, an element that is not an ID this run declared, an unknown key, a
  step effect that does not resolve, `realization` with no behaviour to belong to — and, for Stage C,
  an affordance naming an element this state's own readings did not declare, or given without a
  `page_type` to belong to. The `realization` one is the one that keeps the acceptance honest — a step
  with no behaviour is refused rather than recorded as a step of nothing.

**Acceptance:** a scripted walk on `demo-app` produces, from one set of calls, a `graph.json`
whose `capabilities[]` matches 0.1.22's shape **and** an ABM whose `behaviors[]` contains `login`
with three `realization[]` entries and no top-level step capability. The document half is covered by
`test/realization.test.mjs` (the committed graph is validated against the vendored 0.1 schema, so the
`steps[]` fold is checked in the schema's own terms, and the same suite drives Stage C: the affordance
on the login reading, the refusals it earns, and the assertion that `graph.json` does not contain it);
the ABM half waits on Phase 2's assembly.
Revert-proven in `test/prove-abm.py` — written, 11 mutations, all 11 refused (`python3 test/prove-abm.py`),
and it is the Phase-1 half of the protocol below: the fold, the two spellings, the four affordance
rules and the actor registry.

**The clause has a second reading, and D13 decides it: the projection does, on a recorded
realisation.** A capability the model declared a step of a behaviour is not a behaviour, so
`behaviors[]` holds `login` with its three steps and **not** the three step capabilities. The
condition is that the run recorded the realisation — an appended `realization_step` naming the
behaviour, carrying the `action` and `element` the run observed, which the commit folds into
`capabilities[].steps[]`. On 0.1.22 that field is empty on all four capabilities, so 0b keeps its
four behaviours and P1's three findings, and **the demotion cannot be earned by recording less**:
remove the records and the step capabilities come back. Two clauses of this acceptance therefore move
together with Phase 2's assembly, and the probe under §0 D13 says why — demoting without D12's
collapse fires `P12/duplicate_transition` on the second typing self-loop. The failure mode worth
stating: if either clause is dropped, the acceptance is met by a projection that never saw a
realisation.

### Phase 2 — the commit writes both documents

`lib/commit.js`, `reconcile()` (commit.js:1379).

- Assemble `behaviors[]` (with `realization[]` ordered by walk order), **`transitions[]` collapsed to
  one edge per `(from_state, behaviour, to_state)`** (D5), `entities[]`, `state_variables[]`,
  `actors[]`, and `journeys[].steps[]` referencing those edges.
- Add P1–P15 to `invariantsOf()` (commit.js:3351), sharing one definition with Phase 0b's
  `profileFindings` so the diagnostic and the gate cannot drift.
- Emit the D4 fallback journey (the run's own walk, `goal_stated: false`, `criticality`
  omitted) whenever no step claimed a `journey_name`, so P12c always has a journey to check.
- **Run `lib/validate.js` over both documents before reporting `ok`** — this closes README gap 8
  and is the reason it cannot stay open any longer: an ABM with a `realization[].action` outside
  the enum is precisely the class of defect that has already shipped twice.
- `commit_report.json` gains a per-document section (`documents: { graph: {…}, model: {…} }`)
  so "which document is short, and why" is answerable without reading two files.

**Acceptance:** on the Phase-1 walk — all four clauses, and the fourth is the one that keeps the first
three honest (D8):

1. `graph.json` is **schema-VALID** against `schemas/0.1/`, and its **key paths are unchanged from
   0.1.22**: the same top-level keys, the same per-record key sets modulo the fields Phase 1 adds, and
   no key 0.1.22 carries going missing. That diff *is* what "byte-comparable in shape" means — the
   bytes cannot match (`generated_at`, ids, record order), so the check is a diff of key paths and it
   is run as one, not eyeballed.
2. `application-model.json` is **schema-VALID** against `schemas/abm/0.2/`.
3. **The floor.** Both documents still carry what the 0.1.22 walk carried — 4 capabilities, 2 states,
   3 transitions, 1 journey in `graph.json` — and the ABM carries `login` with **three ordered
   `realization[]` steps** and no top-level step capability. Clause 4 alone is satisfiable by
   recording less: an empty document is schema-valid and has no findings, so the error count needs a
   floor under it or the acceptance can be earned by shrinking the walk.
4. **Zero `error`-severity findings in both, and the drift test**: profile the committed ABM through
   Phase 0b's `profileFindings` *and* through `invariantsOf()` in `commit.js`, and assert the two
   findings lists are identical. "Sharing one definition so they cannot drift" is an intention until
   something runs both; this is the same doctrine 0b was built on.

Note that this criterion is a function of a Phase-1 artifact: it is evaluated against the walk
`test/realization.test.mjs` records — a scripted three-step walk through the real tools, committed
through the real commit — and not against anything 0b can currently write.

**DONE.** `lib/validate.js` (both documents, closed gap 8), the ABM assembly in `reconcile()` with
P1–P15 in `invariantsOf()` sharing one definition with 0b's `profileFindings`, the D4 fallback, the
two-document `commitRun` with its `documents` section, and `test/abm-commit.test.mjs` as the
acceptance test (all four clauses, green; `npm test` is 12 suites). The work found five things the
plan had not anticipated, and each is now a rule with a test:

- **The model's steps have to come from the log, not from `graph.json`.** `capabilityStep` is closed
  on purpose (`additionalProperties: false`) and has no key for a step's `purpose` or its `effects`,
  so the graph's `steps[]` is a *narrower projection* of the same record. The model reads the
  `realization_step` records in `capabilities.jsonl` instead. A fact the fallback document cannot
  hold is not a fact the model loses — that is the whole argument for two documents (D1), and it was
  one commit away from being violated in the other direction.
- **D12 reaches further than the edge.** The collapsed edge starts where the *invocation* started,
  not where its last call did: carrying the last call's `from_state` claimed the behaviour began
  wherever its final step began, which lost the state the walk was standing in when it was asked for
  the behaviour. P12's `committed_transition_not_carried` fired on the projection's own defect.
- **An effect is recorded as a `semantic_purpose` and has to enter the model as an id.** The graph's
  effect target is resolved at commit time; the model's steps are read from the log, so the
  resolution has to happen in the projection too. Without it the document named the same control two
  ways — by id on the step, by purpose on its effect — and P4 refused it.
- **A state is not blamed for a control it does not offer.** P13 was keyed on the state a call was
  *recorded from*, so a control declared by the surface that actually offers it was reported as an
  affordance already walked. An affordance is a claim about a surface, so the claim is filed on the
  surfaces that declare the control, never on the one the walk happened to be standing in.
- **D4's fallback is unreachable through the commit.** The commit always reassembles a journey for
  the walk it recorded, so a journeyless document only ever reaches the projection from a caller who
  hands it one of its own — which is what the baseline profiler does. It is exercised there, by
  calling the projection directly, because otherwise its only reachable path would be one no suite
  ever takes, and a rule no suite takes is a rule nothing holds.

`test/prove-abm.py` grew the six Phase-2 cases that hold these rules down — the collapse, the
log-sourced steps, the effect resolution, the fallback journey, the model write, and the validation
gate — each of which must leave the acceptance suite red when removed. All 17 cases are caught.

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
mid-run. Measure: **every capability the run records has a behaviour attached** — a log-level count
(`capability_behaviour` absent), not P1's count in the finished ABM. P1 cannot measure this phase: by
D13 the projection demotes the step capabilities, so they never become behaviours and the ABM's P1
findings are about the names that *are* behaviours. The log is where the protocol's output is visible,
and a projection cannot move it.

**DONE.** `lib/protocol.js` rewritten (240 → 306 lines), with two artifacts this phase owes and
neither of which existed before: `test/protocol.test.mjs`, an offline suite that pins the text, and
`test/protocol-coverage.mjs` (`npm run profile:protocol`), the log-level acceptance as a harness.
`npm test` is **13 suites** after the rewrite, and **14** after the deploy that followed it added
`test/package.test.mjs` — a suite for a rule about the *package* rather than the code, because the
first defect that a deployed 0.1.24 had and no suite in the tree could see was a `files` entry. It is
**15** now, after 0.1.34 added `test/restatement.test.mjs`.

What the rewrite did, in the phase's own terms:

- **The prologue is new, and it is the phase.** The procedure used to open with `act → observe →
  record`; it now opens with *understand the application before you walk it*, five questions — what
  application this is, which actor and what it remembers, what the behaviours are, what would prove
  each one, and only then the walk. **No tool records the answer to any of them**, which is exactly
  why it has to be in the prompt: a walk is evidence, and evidence gathered before you know what the
  product is *for* is a transcript with no question behind it.
- **The old composite clause is *gone*, not overridden.** The 0.1.18 text offered two homes for an
  action and asked the model to choose; the rewrite offers one. `capability_kind: composite` no longer
  appears anywhere in the section, and the suite asserts its absence — a protocol that still contains
  the old instruction is a protocol whose rule depends on which sentence was read last.
- **D5 is stated as three definitions and one worked number**: a **step** is one interaction with one
  control, a **behaviour** is what a user asks for by that name, an **edge** is one behaviour applied
  between two states — so *a sign-in performed with three calls is three steps, one behaviour and one
  edge*, and the edge is recorded once, when the behaviour completes, starting where the behaviour was
  asked for rather than where its last step happened to start.
- **The `realization` record is now the instruction, not an inference.** One call passes `capability`
  (the interaction), `capability_behaviour` (the behaviour it serves) and `realization` (the verb, the
  element, the value and the step's `purpose`) together, because that is the only moment the action and
  its meaning are both in hand. A call with no `capability_behaviour` claims to *be* a behaviour —
  right for `apply_coupon`, wrong for a single keystroke.
- **D6's affordance bullet**: recording one is the only way the model can say what the application
  *can* do and this walk did **not**, it is a claim about a surface so it cannot be made later, and
  the bullet deliberately never mentions `confidence` — the tool refuses that key by name.
- **The grounding paragraph** ends the rules: a behaviour is a reading rather than a fact, so it
  carries the evidence that made you think so, and one with no evidence behind it is a hallucination
  the profile reports as one.
- **All 15 refusal sentences survive verbatim.** Each encodes a failure mode paid for in a live run,
  and a rewrite that reflows the paragraphs around them is precisely the edit that drops one, so they
  are asserted one by one rather than by a count.

What the two artifacts hold down, and why the measure is where it is:

- `test/protocol.test.mjs` pins **73 claims** and is offline and dependency-free like the rest of
  `npm test`: the section's name and order (150), the rendered text equal to `protocolText(...)` for
  the live config, each rule above, the seam between the loop and the tools — **every argument
  `graph_observe` and `graph_transition` declare is either named in the loop or on the one spelled-out
  exemption list**, with a guard that a rename cannot silently widen the list — and the substitutions
  themselves (renamed tools do not leave their old names behind). Its matchers collapse whitespace,
  because the section is wrapped prose: a needle written on one line otherwise asserts the wrapping
  rather than the sentence.
- `test/protocol-coverage.mjs` is the acceptance, and it reads the **log**, for D13's reason. Four
  verdicts: no capability recorded with no behaviour attached; every step of every behaviour is
  recorded as a realisation; every realisation names the browser action and the step's purpose; every
  edge resolves to a capability the run recorded. It is a harness and not a suite — absent a run
  directory it prints `SKIP` and exits 0 — and **a verdict with nothing to check prints `n/a` and is
  left out of the tally**, because a green result is evidence of a positive and never of a negative.
  It is deliberately *not* in `npm test`: it fails by design on any pre-Phase-3 run.
- Measured on the two baselines this machine had, and this is the honest state of the evidence: the
  0.1.22 dial-in run records **3 capabilities, 0 behaviours, 0 realisations**, every one of them a
  behaviour in its own right (`fill_login_email`, `fill_login_password`, `login`) — verdict 1 fails;
  and the later `/login` run records **4 capabilities, 1 behaviour, 3 steps, 0 realisations** —
  verdict 1 passes, verdict 2 fails at `login: 0/3 steps realised`. **No live run on this machine had
  ever written a `realization_step` record**, because the record kind postdates all of them.
- **The decisive number arrived with the 0.1.26 run of 2026-09-18**, and it is the log's own count:
  **4 capabilities (1 behaviour, 3 steps, 0 unattached), 3 realisations (3 described — verbs `fill`,
  `fill`, `click`), 3 edges, `login 3/3 steps realised`**, and all four verdicts `ok`. `ACCEPTED`,
  and the measure is where D13 put it, so the acceptance is **met on 0.1.26** rather than inherited
  from the two baselines above. What that run's log shows the walk doing: `graph_transition` called
  three times, each naming `capability_kind: interaction` with `capability_behaviour: login` and a
  `realization` — nothing recorded as a behaviour in its own right, which is the phase's whole
  claim, reached without the protocol being re-read mid-run.
- **The same live run withheld the application model, and the two causes are the next phase's first
  work rather than Phase 3's.** It committed a valid `graph.json` and refused the model three times:
  `P5/unobserved_argument` on `transition_submit_login` (the walk wrote
  `arguments.password = "password123"`; the evidence says `[set]`, and P5 skips only `[set]`), and
  `P12/committed_transition_not_carried` twice, for the two `fill` self-loops. Both are true of that
  log. Both are also the machinery reading its own input wrong, and in a way a live run is the only
  thing that could have shown:
  - **The `P12` pair is a recorder defect.** `lib/protocol.js` tells the walk to put the acted
    element in `realization.element` and never once names `target`; `action.target` is taken from
    `args.target` alone (`index.js` → `session.js#recordTransition`, whose `action` is literally
    `{capability, arguments?, target?}`), so **every** transition of every live run carries a
    capability and no element — measured, all three transitions of the 0.1.26 `graph.json` have
    `action.target: null`. Two consumers read that field and only that field: `generate.js`'s
    `const element = transition?.action?.target …`, which is why that run's spec is *0 of 3 steps
    became an action* with three `step_targets_no_element` gaps and performs no sign-in at all; and
    `abm.js`'s `carriedAsStep`, whose third disjunct is **dead** precisely when the walk obeys the
    protocol. P12(a) as written in the table below is therefore not what the code does: the code
    asks for a spelling the protocol never asks the walk for.
  - **Both were fixed in 0.1.28, at the recorder rather than at the rule.** A transition's `target`
    and a step's `element` name the same control — one is where the document keeps it, the other is
    where the walk states it — so the element is taken from the step, under three conditions: it must
    be an id the run has already declared (the check that was already there), a call that states a
    *different* `target` is **refused rather than guessed** (`target ... and realization.element ...
    are two different controls`), and the derivation is reported as a note at `info`
    (`target_from_realization`) because a value no call passed is not a value the model gave. The
    refusal sits **above the first write**, so a refused disagreement leaves no capability behind —
    that placement was got wrong once and `realization.test.mjs`'s "every refusal above wrote nothing
    at all" caught it. P12 was **not** loosened: `step_targets_no_element` and `committed_transition_
    not_carried` still refuse an edge that acts on nothing. The protocol was corrected too — it now
    says the `[set]` convention out loud, which is `P5`'s prose gap closed — and the fact that a
    redaction has to be typed back as `"[set]"` and not as `"***"` is stated where the walk reads it.
- **The first live run on the fixed recorder is 0.1.27, and that is where the defect is settled.** Three
  `graph_transition` calls, each naming its element on the `realization` and **none** passing
  `target` (the transcript reads `transition target= null | step element= element_email_input`), and
  all three committed edges name the control: `transition_fill_login_email` →
  `element_email_input`, `transition_fill_login_password` → `element_password_input`,
  `transition_submit_login` → `element_sign_in_button`. `commit_report.json` has `blocking: []`,
  `documents.model.written: true, valid: true`, `P5 ok`, `P12 ok`, `P13 ok`, and three findings of
  `code: target_from_realization`, `severity: info`, `basis: recorder_note` — one per edge. On the
  same walk 0.1.26 committed `action.target: null` three times and withheld the model for it; the
  protocol and the two descriptions that named `target` are what changed, and **the rule that refused
  the old runs is unchanged** — it simply has something to read now. `profile:protocol` on that
  directory is `ACCEPTED` (`4 capabilities (1 behaviours, 3 steps, 0 unattached)`, `3 realisations (3
  described)`, `3 edges`, `login 3/3 steps realised`, four `ok` verdicts).
- **And that spec was then run for real, which no earlier phase had ever done.** The 0.1.27 run's
  `application-model.json` is written (43,604 bytes) and its generated spec performs the walk it was
  generated from: `await page.goto("/")`, `Email.fill("test@example.com")`,
  `Password.fill(process.env.TEST_PASSWORD!)`, `Sign in.click()`, three assertions, header
  *3 of 3 step(s) became an action; 3 check(s) were written, from 3 the graph supports*. In a
  throwaway Playwright project pointed at the demo app: `TEST_PASSWORD=password123 npx playwright
  test` → **`1 passed (1.7s)`**. A test the machinery wrote, from a model the machinery built, out of
  a log the walk recorded, signed in. That is the strongest evidence in this document, and it is
  worth exactly what it costs: **one run, one journey, one spec** — evidence of a positive. The
  0.1.26 spec of the *same* walk asserted the two destination states and performed no sign-in at all,
  which is the regression the recorder fix repairs.
- **The 0.1.28 run repeated the recorder result on a different walk and found a *seventh* defect,
  which is the same class again and is why this is recorded rather than claimed done.** Its edges
  name their controls (`element_email_input`, `element_password_input`, `element_login_button`) with
  the walk still passing no `target`, and `target_from_realization` fires three more times at `info`;
  `profile:protocol` is `ACCEPTED` a second time. But `documents.model.written` is **`false`**, and
  the blocker is new: `P5/unbound_parameter` twice — *"realization[0] binds {{email}}, which is not a
  declared input of \"login\" (declared: none)."* The walk wrote `{{email}}` and `{{password}}` into
  the steps' `value`, and **no capability in that run declares an `input` at all**. The protocol
  offers the template (*"`value` is a literal or a `\"<param>\"` template bound to the behaviour's
  input"*) and **never once says that writing one obliges you to declare the parameter**: the tool
  description documents `capability_input`, the section the walk is given as its orders does not
  mention it at all. So the walk is offered a spelling and not told what it costs — the `target`
  defect exactly, one field over — and `P5` then refuses the document the walk was asked to produce.
  Note that the machinery's own rescue (`inputOf`, which unions the inputs of the capabilities a
  behaviour is `composed_of`) **cannot** fire here: it reads a composition Phase 2 folds into
  `realization[]` and drops, and there is nothing to union anyway. **Fixed in 0.1.29, and it is a
  protocol fix, not a rule fix**: P5 is right, and the model it withheld is a correct refusal of a
  walk that was told half of a convention. The section now carries the half it was missing — a
  template is a parameter the walk has to declare, the declaration goes on the capability that *is*
  the step because a behaviour's input is read from the inputs of the capabilities it is composed
  of, the refusal costs the whole model rather than the one step, and writing the literal the page
  was given is the way out. The wrong spelling went with it: the section used to offer
  `<param>`, `placeholdersIn` reads double braces, and a walk that obeyed the section would have
  typed the stand-in into the field as a literal.
- **The eighth defect came from the next live run — 0.1.29 — and it is one log read two ways.** That
  walk re-recorded one edge to correct a mistake it had made, which the log keeps correctly as two
  `realization_step` records for one `capability_id`/`transition_id` pair: the log is append-only and
  nothing rewrites it. The commit's own assembly folds the pair and keeps the newest walk (*"one edge
  is one step however many times it was walked"*, its own comment); the behaviour profile's reader did
  not. So one run had **two readings of one behaviour**: the shipped model performed the click once,
  and the profile performed it **twice**, naming a different `storage_changed` target each time
  (`acme-demo-state` and `localStorage.acme-demo-state`). How many times a behaviour clicked is not a
  cosmetic difference, and this reader is the one a person reads the run back with. **Fixed in
  0.1.30** by moving the rule into `keyedRealizationSteps`, in the module both readers import —
  which is where a rule two readers have to agree on belongs, and it is the same collapse the
  seventh defect's run needed one field over.
- **The tenth defect is the seventh one's twin, from the same run, and it is a placement.** The
  section's `arguments` bullet invited *"the concrete values used this time"* and never said **whose**
  values they are. So the walk filled the email, then put `{"email":"test@example.com"}` on the click
  that followed — a field that accepts a value, on the edge where the walk happened to be standing —
  and `P5/unobserved_argument` refused the model: no effect of a click reports the email. The rule is
  right, and the bullet even names the refusal; what was missing is that the rule is **per edge** —
  each argument is read against *this* transition's effects and *this* step's own observation — so a
  walk holding a value and offered two fields that take one was given no way to choose. **Fixed in
  0.1.30, in prose**: the section and the `graph_transition` schema now say that a value is read
  against the edge it was given to, that a value the page reports back belongs in the step's `value`
  (a `value_changed` effect is where it appears), and that the rule is per edge, so the fill's value
  goes on the fill.
- **The third thing that run exposed is open, and deliberately not fixed here.** Refused once, the
  walk tried to correct itself by re-recording the edge: the finding did not clear — the raw
  transition record carrying the argument still stands — and the re-record **split a second, one-step
  journey strand** with a chain break. So a wrong `arguments` cannot be retracted by re-recording,
  while the protocol's own commit step tells the walk that *"evidence is allowed to be wrong"*. That
  is a machine instruction that cannot be acted on, which is a defect by the same argument as the
  seventh and the tenth. But its fix is a question about commit semantics — does a re-recorded edge
  replace its arguments or union them? — rather than a sentence, and guessing at commit semantics
  under a deadline is how the seventh defect happened. It is written down and left open — and it was
  answered in **0.1.34** by the run that raised it; see the bullet at the end of this section.
- **A sixth defect came from the same live run, and it is a deploy-only class of its own.** The
  sentence that tells a person what to export before the spec will run read *"Set [object Object]
  before running it"*: `requires` holds records (`{env, element, purpose, reason}` — the reason is
  what a person reads before exporting a secret), and the list was interpolated into the sentence
  instead of the variable names being read off it. A machine-written instruction that cannot be
  acted on is a defect, and it was in the one sentence a person has to act on before the spec runs.
  Fixed in 0.1.28 by moving the sentence into `lib/generate.js` as `requiresInstruction(requires)` —
  **a function rather than a line in a tool wrapper, because the tool wrapper's output no suite can
  see**: `generateTest` returns no `next` key (that is the `graph_test` seam's), so the first version
  of this fix was unpinnable and the check that pinned it failed with a `TypeError`. Prose that no
  suite can see is prose that rots.
- **Two more defects were found by *deploying*, not by any suite, and they are why
  `test/package.test.mjs` exists.** A deployed 0.1.24 shipped the reader and not the directory it
  reads (`files` did not name `schemas/`), so `graph_commit` answered *the schema set could not be
  read* and wrote **neither** document; and the same version could not boot at all, because a
  `systemPrompt` section is a prompt template and `{{param}}` in its prose is an unregistered
  variable (`dsh: UNKNOWN: unknown prompt variable "{{param}}" in section
  "graph:exploration-protocol"`). Both are rules about the *package*, so the guard is a suite about
  the package: it derives the list of self-relative reads out of `lib/*.js` and requires every one
  that leaves `lib/` to be covered by `files`. Four of `prove-abm.py`'s cases hold them down. The
  third such defect is above: the `[set]` convention the protocol withheld (a walk that records the
  password it typed is refused **correctly** — the rule was right and the text the walk was given was
  not complete), and the fourth is the `[object Object]` instruction, which no suite could see at all
  until the sentence moved out of the tool wrapper and into `generate.js`.
- `test/prove-abm.py` gained the **nine** Phase-3 cases that hold the rewrite down: the reading
  before the walk, the step-is-the-default sentence, the behaviour definition, the once-per-behaviour
  edge, the affordance's missing `confidence`, the hallucination sentence, a kept refusal sentence, an
  argument added to a recording tool, and — the case that matters most after a rewrite — **the old
  composite clause put back**, which must fail. The harness now distinguishes *BROKEN* from
  **SURVIVED** from **INVALID** (a case whose edit does not parse fails every suite for a reason that
  is not the rule, and counting it would let a badly written case look like a proof); all **59 cases
  are caught, 0 survived, 0 invalid, 0 skipped**, and the tree restores to 15/15. (The nine are this
  phase's; Phase 4 added the adapter's rules, and 0.1.34 added the restatement rule, the commit's
  derivation of it from the log, and the collapse's argument provenance.)
- **The open question is answered (0.1.34), and the answer is that a step is a pair.** *Does a
  re-recorded edge replace its arguments or union them?* Neither, because the question assumed the
  re-record is an edge: a step is identified by the edge it moved along **and the two readings it was
  made from**, so a second statement of the same step out of the same readings is the walk saying one
  step again — no step is added, the walk does not move, and the later statement replaces what the
  walk says about that step. Re-recording is not a retraction verb the walk may use whenever it likes
  either: a statement made after the next action is a different step, because the readings are what
  identify it. The earlier statement stays in `transitions.jsonl` (append-only), the report lists it
  as `superseded` with a reason that says *stated again*, and the corrected edge carries no
  `arguments` — the value the walk typed was never lost, because it was recorded on the call that
  typed it and on that call's `realization`, not smuggled onto the edge that was wrong.
  **The fix is proved on the run that found the defect, which is the part worth keeping.** 0.1.29's
  own `graph-run` replayed through the new commit takes the correction: three committed edges,
  `superseded: 1` with the restatement reason, one journey, no breaks, no errors, and
  `application-model.json` written. That replay is also what found the real bug in the first fix: the
  recorder knew the rule and the commit did not, because the commit's reader is stateless and the log
  was written before the rule existed — **a written field is a note, not evidence**. The rule now
  lives in one exported function that both readers ask, and the commit derives which records are
  restatements from the records themselves. Reading the replayed model rather than its report found
  one more: the corrected edge had no `arguments` while the journey step naming it still did, because
  the projection remapped an absorbed call onto the invocation's edge and kept the *call's* values on
  the *turn*. A turn's `arguments` are now the arguments of the edge the turn names.

### Phase 4 — the model generates the test (D10) — **DONE**

`generate.js` (`graph_test`), `lib/abm.js` (`graphShapeOf`) and `lib/index.js` (which document the
tool opens). Before this phase the generator matched `composed_of` against committed transitions
(`generate.js:570`) and the semantic layer could not reach the artifact at all.

**Acceptance — the MVP milestone, and it is the same sentence as the one at the top:** a spec is
generated with `graph.json` **absent from the run directory**, and every action in the spec traces
to a `realization[]` step. Two documents read from one log, and the test written from the second.

**Met, and met twice.** On the 0.1.30 live walk, read in memory from its own model: 3 steps of 3
became actions, 0 blocking gaps, the email typed from `realization[0].value`. And on a fixture with
**`graph.json` deleted** (`~/tmp/accept-031`, the live-030 run minus the graph, minus the model,
re-projected from the logs alone): `source: logs | caps: 4 | transitions: 3`, one journey turn, the
realization `[["fill","element_email_input","test@example.com"],["fill","element_password_input",
"[set]"],["click","element_sign_in_button",null]]`, **3 of 3 actions, 0 blocking gaps**, and only
`dimension_could_be_more_than_one_element` left as a gap — the run's own known limit, reported by
the model's own rules rather than by the graph's. The acceptance sentence is therefore a fact about
a directory, not about a session.

**Met a third time, and the third is the one that counts — against the *packed, deployed* build, not
the source tree.** `~/tmp/live-032/probe-acceptance.mjs` imports `commitRun`, `candidatesFromRun`,
`modelFromCandidates`, `graphShapeOf` and `generateTest` from the files installed in a profile and
runs the 0.1.32 walk's log directory two ways:

| Leg | What it reads | Result |
| --- | --- | --- |
| A/full | the logs, **and** `commitRun` writes both documents | `ok: true`, no blockers, model written and valid, graph written |
| A/full → model | `source: application-model.json` | actions **3/3**, assertions 3, **blocking gaps 0**, each step naming its `realization[]` step |
| A/full → graph | `source: undefined`, the fallback | actions **2/3**, blocking gaps 1, `step_has_no_value_to_type` — the email is in the model's `value` and not in the graph's `arguments` |
| B/logs | the logs alone, graph **deleted** from the directory | `caps 4`, `transitions 3`, actions **3/3**, blocking gaps 0 |

`graph.json absent from the run directory: true` on leg B, and the model reading satisfies the
sentence on both legs while the graph reading reports exactly what it lost. That is D10 measured on
the artifact a deployed profile hands a user, and it is also D1 stated as a *difference*: the graph
reading is not broken, it is lossy and says where.

**The adapter is the whole of it, and it is D5 read backwards.** The model keeps one edge per move;
the generator acts on controls, one call at a time. `graphShapeOf(model)` hands the generator the
calls the move was made of — ids from `collapsed.calls` when the two lists are the same length,
otherwise synthesized — starting each call where the invocation started and landing the arrival
**only on the last one** (the calls in between neither arrive nor leave, so no spec can be made to
assert an arrival in the middle of a half-performed behaviour), naming the behaviour **once**, on
that last call, and carrying the recorded `value` on the step's `realization` rather than copying it
into an `arguments` entry the walk never wrote. The journey expands through the same map, which is
the previous window's fix reached from the other side: a journey that named a move twice performs
its three calls twice, and one `realization[]` per behaviour cannot tell the two apart — reported as
`invocation_values_not_distinguished`, **once per edge**, with the `walk_index` to go and read the
other walk in the log.

**Two defects, both found by writing the tests rather than by reading the code.** The first is in
the adapter's no-realization branch: it pushed the *model-shaped* edge where the generator reads
`transition.action.target`, so a behaviour nobody recorded the steps of would have been reported as
a step with no element instead of as an action with no reading under it — the wrong report about the
right fact, and the entire reason that branch exists is which report a reader gets. In the same
commit as the test, per D8. The second is in the artifact's own first line: a spec generated from
the model still said *"Generated from a committed graph"* — the one claim inside the file that
nothing downstream can check, and the claim a reader uses to reason about the rest of it (a spec
from the model cannot contain an action with no reading under it; one from the graph can). The
header now names the document and the words match the refusal's.

**One mutation survived, and the test was what was wrong.** The once-per-edge report had a case
that marked **one** call of the move, so the dedupe was never exercised and removing it left the
suite green. The test now gives all three calls the same `collapsed` record — what the adapter
actually hands over — and the mutation is refused. A survivor is not a case to delete: it is a test
that was not testing what it said it was.

**And the readings are two calls, not two code paths.** `graph_test` takes `source` (`model` by
default when the run has a model, `graph` to force the other reading), refuses by name when the
document asked for is missing — the graph reader does not quietly answer for the model — and returns
`source`, `document_path` and `graph_path` so a comparison of the two readings of one run is a diff
of two results rather than a guess about what was read. A graph-shaped document and a model-shaped
document are each offered to the one generator in *its* shape; that translation is the adapter's
entire job, and it is the reason a test that wrote a model's journey as `transitions[]` generated
nothing at all — the adapter maps `journeys[].steps[]`, because that is what a model has.

**Why it mattered at all, in one line of the 0.1.30 run.** That walk was the first to have its model
written and valid on a live run, and its generated spec then dropped its first step with a blocking
gap, `step_has_no_value_to_type`: `transition_fill_email`'s action is
`{"capability": "cap_fill_email", "target": "element_email_input"}` and the email is **not in it
anywhere**, while the next step's `{"password": "[set]"}` is. The walk had recorded the email as the
step's `value` — the spelling the section's own `realization.value` bullet asks for, *"the literal
the page was given"* — and the graph's transition shape carries `arguments` and has no `value` key,
so the value went into the graph and came out of it gone. The generator did the right thing with
what it had; the point is that **a document the model writes and the generator cannot read is the
pivot described rather than performed.**

**And the 0.1.32 live run found the third defect, in the one place the acceptance sentence does not
reach.** The sentence asks that every action in the spec trace to a `realization[]` step — and on
that run every action *did*, while the spec was still wrong:

```ts
await page.getByRole("textbox", { name: "Password" }).fill("{{password}}");
```

The walk recorded the password step as `{action: "fill", element: "element_password_input",
value: "{{password}}"}` with `password` declared on the capability — the spelling the protocol's own
bullet offers — and the generator read that `value` as *the* value and quoted it. `[set]` and
`{{param}}` are one fact recorded by two parties, and only the first had a rule: `valueExpression`
knew `REDACTED`, the schema's second spelling was recognised only by a private predicate inside
`abm.js` that the generator never consulted, and the fixture had been written with `[set]` — the
spelling the earlier runs happened to produce. **The rule looked tested because the fixture only ever
spoke one of the two vocabularies the schema allows**, which is the same failure mode as the 0.1.31
survivor one level up: not a test that missed a branch, but a vocabulary that only ever got exercised
in one direction. Fixed in 0.1.33, and the fix is a *place* rather than a patch — `templateParameter`
is exported from `schema.js`, the module both layers already import, so the projection reads it for
P5, the generator reads it to know a `value` is a reference, and `isReference` (`REDACTED`, or a whole
value that is a template) narrows `argument_disagrees_with_the_reading`, so a step that binds the
parameter *and* carries a withheld reading is not reported as disagreeing with itself.

Three properties of the fix are the ones the new cases hold down: the rule is asked of the **value**,
not of the document it arrived in (a graph's `arguments` holding a template resolves the same way, so
neither reading is the less safe one); only a **whole** value is a reference (the substitution takes
one argument, so `"user-{{n}}@example.com"` is a string with braces in it, and naming an environment
variable after a fragment would be a secret nobody can supply); and the two spellings **name one
variable** (`{{password}}` and `[set]` on the same element both become `process.env.TEST_PASSWORD!`,
which is why the test asserts the three env names are *equal* rather than merely present).

The point is not that the ABM is nicer. It is that **a model nothing downstream reads cannot be
wrong in a way that matters**: while the spec came from the graph, P1–P15 were an opinion about a
file, and the pivot had added a description instead of replacing one. From here they are load-bearing
— and the two readings of one run are still both available, which is what makes the claim checkable
rather than merely stated.

### Phase 5 — actors become schema-native

Phase 1 puts `actor` on the reading and resolves the vocabulary from config beside `application:`,
which is all P6 needs. This phase makes actors first-class: actor-scoped behaviours and affordances,
`application.actors[]` widened beyond `{id, description}` if a policy needs it, and actors that are
**discovered** by the walk (signing in as someone else) rather than only declared in config.

### Phase 6 — evidence beyond the browser

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
| **Inference hardens into fact over rebuilds** (D9) | Measured, not hypothetical: `cap_submit_login` reports `status: verified, confidence: 1` today although its name is an LLM reading, and any tool that re-emits the document copies that forward. After a few rebuilds a naming guess is indistinguishable from a capture — and a PR analysis would then report it as code fact | P14 (a claim may not outrank the observations supporting *that claim*; by D11 an object's level is the **minimum** over the claims it carries) and P15 (an inference names its producer and its basis). Enforced over **both** documents, since `graph.json` has the same defect today |
| **Two documents drift** | They are independent by design (D1), which is exactly what lets them disagree | Both from one store, one commit, one `commit_report.json` section each; **P12a/P12b** check the edge set in both directions, so neither document can quietly lose or invent an edge. |
| **The walk loses its order or its point** (D4, restated for D5) | `transitions[]` is a *set*: it has no order and no purpose, so only `journeys[].steps[]` says what the walk was and what it was for | `reconcile()` always emits the fallback journey (`goal_stated: false`); **P12c** fails the commit if it ever stops doing so. |
| **The collapse hides which step landed the state** (D5, D12) | Three calls become one edge, and `realization[]` keeps the order but does not mark which action moved the application | D12 decides the *collision* — the edge ends where the last step landed, so the earlier self-loops are not edges at all — and the edge's `evidence` carries the `action` role, which names the observation of that step: in the 0.1.22 run, `obs_0004`, the submit click. So the causal step is *recoverable from evidence* rather than asserted, and P12a refuses a collapse that would hide a state the walk actually entered. |
| **Affordances become a wish list** (D6) | D6 rewards naming what a walk did not do, and a model that wants to look thorough can invent them | P13 requires the element to be declared in *that state's own* `elements[]`, so every affordance is anchored in the capture; the claim is refuted by any committed realization step on the same element; `confidence` reported at 0.3, never argued up. |
| **Fork rot** (D2) | The vendored schema is now a copy, and copies drift from upstream silently | `VENDOR.md` sha256s + `0.1/` never being edited makes the divergence deliberate and checkable. |
| **`npm test` loses its offline property** (D2) | `ajv` is the natural validator and the plugin has deliberately no deps | `lib/validate.js` (no deps) is the gate; ajv is opt-in via `npm run prove:schema` only, and that script exits 0 with `SKIP` when ajv is absent. |
| **A behaviour-first reading is not stabilisable** — two runs name one behaviour two ways | Already observed: `vocabulary_notes` fires on `add_to_cart` vs `add_item_to_cart` | The existing convergence path plus the schema's own vocabulary list. **Measure inter-run name stability; do not assume it.** |
| **Losing the walk** | `assembleJourneys` derives journeys from ordered `transitions.jsonl` | Transitions stay in the log and in `graph.json`; the ABM carries the same edges in `transitions[]` and the same order in `journeys[].steps[]`. |
| **A greener-looking run that proves less** | Every change makes refusals *more* likely, which reads as regression | Track refusal counts and per-document findings across runs. Fewer findings after a rule change is a **finding**, not a win, until the rule is shown to still fire (§7.2). |

## 7. Verification protocol

Each of these is load-bearing, not ceremony:

1. `npm test` — currently **15** suites (0a/0b added `test/abm.test.mjs`, Phase 1 added
   `test/realization.test.mjs`, Phase 2 added `test/abm-commit.test.mjs`, Phase 3 added
   `test/protocol.test.mjs`, the first deploy after it added `test/package.test.mjs`, and 0.1.34
   added `test/restatement.test.mjs`); every phase adds a suite
   or a case, never only a claim.
   `test/run.mjs` auto-discovers `*.test.mjs`.
2. **Revert-proof each new rule**: break the rule in the source, confirm the suite fails *with
   the diagnostic you expect*, restore, confirm green. `test/prove-generate.py` is the template and
   `test/prove-abm.py` is the running instance (59 mutations, all 59 refused; 17 through Phase 2, 9
   more for Phase 3, and 33 for the defects the deploy and the live runs found — four from the two
   early deploys, three from the recorder defect, one from the instruction sentence, five from the
   value template the walk was never told how to declare, three from the arguments placement the
   walk was never told the rule of, one from the two readings of one log, two from the turn of a
   journey that was counted per call rather than per invocation, and five from the model read back
   into the shape the generator reads, plus the nine 0.1.34 added for the answer to the open
   question — the recorder's recognition of a restatement, the readings being half of what identifies
   a step, two records with no readings not comparing equal, the three commit rules that read that
   recognition (ranking, the superseded reason, the restatement's place in the walk), the commit
   deriving it from the log rather than the field, the protocol sentence, and the turn's arguments
   being the turn's edge's); break the *rule*, not a clause the code already treats as
   equivalent (removing `cutParameter &&` proved nothing — behaviourally identical).
   **The template has grown with the instance and now has a total of its own**: 16 generate cases
   (9 from the generator's first suite, 4 from Phase 4, and 3 for the 0.1.32 live run's references —
   one per spelling of the rule plus one for the guard that reads it in the disagreement check),
   every one refused, and the count is the thing to keep honest: a rule with no case under it is a
   rule whose fixture happened to speak the other vocabulary.
   **P12 gets this treatment explicitly, and for a measured reason.** Before D5 the rule demanded
   one `journeys[].steps[]` entry per committed transition, and §3 made a step a behaviour: the
   real 0.1.22 run has **3 committed transitions and 1 behaviour-level step**, so a naive test
   would have passed for the wrong reason (it read the graph's per-call steps). The revert-proof
   must therefore use the run's own numbers — `3` committed transitions, `1` edge, `1` step —
   which are recorded in `docs/experiments/abm-01/compare-output.txt`. Break P12a, P12b and P12c
   separately and confirm each names a different missing object.
3. **Validate both documents** with `npm run prove:schema` after every live run, plus
   `lib/validate.js` inside the commit itself. Gap 8 means a
   green commit can still write an invalid document — measured twice.
4. **Read the generated artifacts.** Both 0.1.22 defects were found by reading the spec, not the
   graph. Read `application-model.json`'s `behaviors[]` and say which paths the run did *not*
   exercise; a green run is evidence of a positive and never of a negative.
5. Deploy with a **version bump** (the phase's own number: `0.1.26` when Phase 3 was accepted), **pack last**, `diff -r lib` / `diff -r test` /
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
§3's shape and P1–P15, and D5 changes that shape materially — the rule set and the document's
edge unit had to be right before there was anything to implement. The plan revision below is
that reordering, not a delay.
