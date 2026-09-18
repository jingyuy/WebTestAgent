# Experiment 1 — can a reader who never saw the graph produce the ABM?

**Status:** complete. Ran before any Phase 0 code, per §8 of `docs/abm-pivot.md`.
**Artifacts:** `docs/experiments/abm-01/` — the blind model, the committed graph, and the
comparison script that produced every number below (`node compare.mjs`).

| | |
|---|---|
| Run | `~/tmp/live-graph/graph-run` — plugin 0.1.22, `ok: true`, `gates: []`, 4 observations |
| Instruction | *"…open the Acme demo app at http://127.0.0.1:4173/ and sign in with test@example.com and password123…"* |
| Blind model | `blind-model.json`, sha256 `c170d9e5a475a28a6675786c518cc834589df62446ce839cec993b8d96b28b97` |
| Committed graph | `committed-graph.json` (2 states, 4 capabilities, 3 transitions, 1 feature, 1 journey) |

---

## 1. Method

The blind model was written from **`observations.jsonl` and `run.json.instruction` only**,
plus the ABM's shape as designed in §3 of the plan. `states.jsonl`, `capabilities.jsonl`,
`transitions.jsonl`, `graph.json` and `commit_report.json` were listed as
`deliberately_not_read` in the file's own provenance block.

The file was then **hashed**, and only then was the graph read.

That order is the whole experiment. A reader who has seen `graph.json` cannot un-see its
vocabulary, and the question this pivot turns on is exactly whether an ABM is a *different
reading of the same evidence* or merely the graph's own shape re-spelled. If the blind
read had come back as four flat capabilities, the pivot would be pointless: the model
would be reproducing the defect rather than repairing it.

**Result: it did not.** The blind read produced `sign_in` with three `realization[]` steps
and no `fill_login_email` sibling. The defect this pivot exists for did not reproduce.

---

## 2. Verdict in one line

The pivot is **validated on its main axis and falsified on three of its edges** — the
semantic reader gets the abstraction level right, the journey shape right, and the state
identity exactly right; it over-models storage, invents actor vocabulary, and produced
element references that do not resolve. All three failures are catchable by a rule, which
is the useful outcome.

---

## 3. The comparison

| axis | blind read | committed graph (0.1.22) |
|---|---|---|
| states | 2 | 2 |
| state identity | `login/anonymous/{}`, `project_list/authenticated/{projects: populated}` | **identical, character for character** |
| the walk | 3 actions, 2 self-loops, 1 arrival | 3 actions, 2 self-loops, 1 arrival |
| **top-level names** | **`sign_in` (1)** | **`fill_login_email`, `login`, `fill_login_password`, `submit_login` (4, mixing two levels)** |
| composite kind | 0 | 1 (`cap_login`, confidence 0.5) |
| realization recorded | yes — 3 steps in `behaviors[].realization[]` | never written; `capability.steps[]` is empty |
| declared elements | 14 | 12 |
| elements shared | 12 of 12 matched purposes | 12 of 12 |
| actors | 2 (invented) | **none — no actor structure exists** |
| entities | 2 | none |
| state variables | 3 | none (only per-transition commit rollups) |
| affordances | 5 (unwalked) | none, `unmodelled_routes: []`, `apis: 0` |
| features | none claimed | 1 (`feature_authentication`, derived) |
| journey steps | `journeys[].steps[]` (first-class) | `metadata.extra.steps[]` (derived) |
| journey `actor` | `authenticated_user` | `undefined` |
| journey `criticality` | `critical` | absent (schema default) |

### Both documents collapse the same seven actions — differently

The graph reads seven actions as **four capability records spanning two abstraction
levels**: three step capabilities at confidence 1 and a composite at confidence 0.5 that
is a *sibling* of its own parts. The blind read is **one behaviour of three steps**. That
is the defect, reproduced in the artifact and absent from the reading.

The committed numbers, for the record:

| capability | kind | status | confidence | relation to the others |
|---|---|---|---|---|
| `fill_login_email` | interaction | verified | 1 | — |
| `fill_login_password` | interaction | verified | 1 | — |
| `submit_login` | interaction | verified | 1 | — |
| `login` | **composite** | **inferred** | **0.5** | `metadata.extra.composed_of_names: [fill_login_email, fill_login_password, submit_login]` |

The composite carries `minted_by: "graph_transition (first use of the name)"` and
`metadata.extra.commit: {decision: "inferred", attempts: 0, committed_edges: 0}` — it was
never committed, only inferred, and it sits in the same array as the three parts at half
their confidence.

The cause is structural, not a prompting accident: `graph_transition` mints a capability
per call, so a three-click action unavoidably arrives as three capabilities, and the
composite is a fourth. No amount of instruction fixes this from inside the graph's shape.

**A second, quieter defect:** `composed_of_names` holds **names**, while
`feature_authentication.capabilities` and every other reference in the document holds
**ids** (`cap_fill_login_email`). The graph is not internally consistent about whether a
reference is a name or an id, which is precisely why P3 has to pin it down — the ABM
should use ids uniformly.

---

## 4. Where the blind read was wrong

Each of these is a rule the plan must state, and each was found by the graph being better
than the reading.

### 4.1 The realization did not resolve — and my own P4 catches it

I declared `semantic_purpose: "email_input"` on the element but referenced
`element_login_email` in the realization. Three references dangle: `element_login_email`,
`element_login_password`, `element_login_submit`.

**The graph is right.** Its ids are convention-derived from the purpose
(`element_email_input` ↔ `semantic.purpose: "email_input"`) and all 12 resolve; its two
`effect_targets_resolved` findings record exactly this repair happening for real
(`email_input → element_email_input`, `password_input → element_password_input`).

**Consequence for the plan:** Phase 1 must **derive** a realization's element reference
from the state's declared element, not accept an id the model typed. A model that can
type an element id can type a dangling one, and P4 would then be checking the reader's
spelling rather than the model's coherence.

### 4.2 I invented actors

I wrote `anonymous_visitor` and `authenticated_user`, and attached `credentials_ref:
TEST_USER` to the second. **Nothing in the evidence names either.** The run has one actor
— the agent driving the browser — and the only "who" present is `variant: anonymous` /
`authenticated` on the state identity.

But the graph is not innocent here either: it has **no actor structure at all**.
`journeys[0].actor` is `undefined`; there is no `actors[]`; the string `authenticated`
exists only as a state variant. So the graph cannot say *who a journey is for* beyond
which variant it started in, and my instinct to add the axis was right even though my
vocabulary was not.

**Consequence for the plan:** P6 must require an actor id to be **traceable** — to a
state `variant`, or to an observation — and `actor.credentials_ref` is legitimate
precisely because *where the credential comes from* is a fact the evidence does carry
(`test@example.com` was typed) even when the actor's name is the model's own word.

### 4.3 I over-decomposed storage

I read the `localStorage.acme-demo-state` payload and declared three state variables:
`session`, `projects`, `notification_frequency`.

Two of the three are fine — `session` is readable from `element_current_user` and
`projects` from the project list. The third is not. `notification_frequency` has no
element that displays it, so its only check would be an assertion over a storage key.

The graph's machinery reached the same place independently and **warned about it**:
`state_variables` on `transition_submit_login` records
`moved: [localStorage.acme-demo-state]`, `persistence: [localStorage.acme-demo-state]`,
and the accompanying finding explains that storage is deliberately not offered as a
dimension because *"no browser can be asked what the application remembers about a user,
so a value assertion over a storage key is a check nothing can evaluate."*

**The graph is right and my model would have produced an unevaluable test.**

**Consequence for the plan:** P7's `detection` must read an **element or a route**. A
storage-only fact is evidence, never a dimension. Note the asymmetry this creates: the
same key can be a variable when an element renders it and a non-variable when nothing
does, so the rule must be about the *check*, not the key.

### 4.4 Two containers the plan has no home for

I invented `self_loops[]` and `affordances[]`. See §6 — these are gaps in §3, not
mistakes in the reading.

### 4.5 I asserted what the graph correctly declined

I wrote `criticality: critical`; the graph leaves `criticality` to the schema default.
I also named a journey goal where the graph's journey carries the run's instruction.
Confidence floor and criticality are the two places where a one-run walk is thinnest, and
the graph's existing invariants (`confidence_floor`) already refuse to let a 0.5-confidence
composite drive a critical test. **The graph is right; P10 already covers it.**

---

## 5. What the committed graph structurally cannot say

This is the positive case for the ABM, and it is stronger than the abstraction defect.

**The affordance finding.** `obs_0001` and `obs_0004` between them display five controls
the walk never used: *Projects*, *Settings*, *Log out*, *Add project*, *Forgot password*.
`graph.json` records **none of them**. Its coverage vocabulary is about routes —
`visited_routes: ["/"]`, `unmodelled_routes: []` — and this is a single-page app whose
`url` and `title` are **byte-identical across all four observations** and whose three
section headings are present in every one. The walk's only real transition is
`localStorage`.

So the graph reports "0 unmodelled routes" about an application that offers five
un-pressed controls. **The observation graph can only describe what you did; it
structurally cannot report what you could have done.** A model that says *"five things
were offered and not performed"* is not a nicer rendering of `unmodelled_routes: []` —
it is a different statement, and it is the one a test generator needs in order to know
where the untested surface is.

This is arguably a **stronger** argument for the pivot than the capability defect,
because the capability defect is a bug that could in principle be fixed inside the graph
(collapse the composite into its parts), whereas this is a boundary of what an
observation log is able to express.

**Secondary:** the graph has no `actors[]`, no `entities[]`, no `state_variables[]` as
document structure. The knowledge exists — the machinery computes state-variable rollups
per transition — but it is a per-transition side-effect, never a document-level
vocabulary a reader or a generator can consult.

**One place the graph is ahead:** `features[]`. `feature_authentication` is real — claimed
through `graph_transition`'s `feature` argument, derived into capabilities, states,
transitions, journeys and endpoints. §3's ABM has no `features[]`, so the pivot as
designed would **lose** this layer.

---

## 6. Gaps in the plan this experiment exposed

### D5 — where do self-loops live?

The two `value_changed` effects (the email and password fills) go from a state to itself.
The graph keeps them as top-level `transitions[]`. The ABM drops `transitions[]` (D1/D4)
and moved only the *walk* into `journeys[].steps[]`, so **nothing in §3 has a home for a
self-loop**. My `self_loops[]` was a workaround, not a design.

**Recommendation:** give `behaviors[].realization[]` steps an optional `effects[]`, so a
fill step carries the `value_changed` it causes. This is the smallest change that keeps
the effects attached to the step that produced them rather than to a container that only
exists to hold them. It changes the shape of P2/P5 and needs a decision.

### D6 — does the ABM represent affordances?

My five `affordances[]` entries are the experiment's strongest single result (§5). The
plan must either adopt a `affordances[]` array (top-level, or under each state, since an
affordance is *offered by* a state) or **explicitly reject it** in writing. Silence here
means Phase 1 has no instruction about the one thing the graph most visibly cannot do.

**Recommendation:** adopt it, scoped to a state (`state.affordances[]`), because an
affordance is only meaningful relative to the surface that offers it — which is also how
the evidence presents it.

### D7 — does the ABM keep `features[]`?

The graph has a feature layer; §3's ABM does not. Keep, demote, or drop — but decide
explicitly rather than by omission.

---

## 7. Separate finding: the instruction, and its password, are in the artifacts

Not a consequence of the pivot — pre-existing in 0.1.22, found while reading the graph
for this experiment. **Nothing was changed.**

The literal `password123` occurs in:

| artifact | count | where |
|---|---|---|
| `run.json` | 1 | the instruction |
| `observations.jsonl` | 1 | `obs_0003` `tool_arguments.text` — **the evidence layer, unredacted** |
| `graph.json` | 4 | `journeys[0].goal`, `journeys[0].metadata.extra.run_instruction`, `observations[2].metadata.extra.tool_arguments.text`, `observations[2].metadata.extra.linkage.action.arguments.text` |
| `commit_report.json` | 2 | |
| `generated/*.spec.ts` | 1 | header comment only |
| `states.jsonl`, `capabilities.jsonl`, `transitions.jsonl` | **0** | the model layer is clean |

The capture layer **does** redact correctly — the page hook records the password field's
value as `[set]` — and the generated spec's *code* is safe
(`.fill(process.env.TEST_PASSWORD!)`). So the 0.1.22 redaction fix held on the code path
and **not** on the prose path: the leak travels through `journeys[].goal`, which is
populated from the run instruction verbatim.

**This bears directly on the ABM.** §3 gives `journeys[].goal_stated` and a `goal` field.
If `goal` continues to be sourced from the instruction, the ABM inherits the leak on day
one, and it will be *worse* — a behaviour model that quotes the instruction is a document
whose whole purpose is to be read and shared. **`goal` must be either redacted or stored
as a reference to the run rather than as a literal.** Worth deciding alongside D5–D7.

---

## 8. What changes in the plan

1. **§3 gains a home for step effects** (D5) — `realization[].effects[]`, pending decision.
2. **§3 gains or explicitly rejects affordances** (D6) — pending decision.
3. **§3 must decide `features[]`** (D7) — pending decision.
4. **New rule after P4:** a realization's element reference is *derived* from the
   declared element, never accepted from the model (§4.1).
5. **P6 strengthens:** an actor id must be traceable to a variant or an observation;
   `credentials_ref` stays (§4.2).
6. **P7 strengthens:** a `detection` must read an element or a route — a storage-only
   check is not a dimension (§4.3). This is the rule the graph's own warning already
   describes, so adopting it means adopting the machinery's reasoning, not contradicting it.
7. **§3's `goal` must not quote the instruction** (§7).
8. **Phase 1's acceptance test is now concrete:** the same run, re-read through the ABM,
   must produce one behaviour named `sign_in` with three resolution steps, two
   self-loops' worth of effects attached to steps, five affordances, and no
   `fill_login_email` sibling. `blind-model.json` is the fixture.

The experiment does not change Phases 0a/0b, and it does not change D1–D4. It adds three
decisions (D5–D7) and sharpens three rules.
