# @webtestagent/dsh-graph-explorer

A DeepSeek Harness bundle that turns a `dsh-browser` exploration into an
append-only evidence log and an application behaviour graph.

It records evidence, the model's reading of each state, and each transition — a
capability applied in one state, landing in another — with the machinery's own
account of the step checked against the model's. `graph_commit` then reconciles the
whole run into a `graph.json` that validates against the target JSON Schemas, beside
a `commit_report.json` that says what it committed, what it refused and why, and
reads the same run a *second* time as an `application-model.json`: what the
application can be asked to do, in the words a person would ask for it (see
[The two documents](#the-two-documents)). `graph_test` turns that document into a
Playwright spec for one of its journeys, reading the model by default and the graph
when the other reading is asked for `source: "graph"`. See
[The commit](#the-commit),
[Generating a test](#generating-a-test) and
[What this proves, and what it does not](#what-this-proves-and-what-it-does-not).

## The design in one line

> The machinery captures evidence, the model supplies meaning, the tool boundary
> binds them.

`dsh-browser` owns the page. This plugin never opens a browser. It observes the
calls that drive the page, reads the page through `browser_eval`, and gives the
model one place to say what the page *means*.

Why not let the model write the observation log itself? Because a log is only as
reliable as the model's diligence on the step where it was busy, and a missing
observation is invisible in the output — the exact false-pass this tooling exists
to remove.

Why not a second browser plugin? Two plugins mean two Chromium processes and two
`page` objects: the tool that drives the page and the observer that reads it
disagree about which page exists, and the observer reports a blank page forever.
One page, one owner. Never mount both.

## The seams

| Seam | API | Role |
| --- | --- | --- |
| Recorder | `ctx.on('tools/execute', (exec, next))` | Capture evidence around every browser action that can change the page |
| Semantic tools | `ctx.tools.register(defineTool({...}))` | `graph_observe` and `graph_transition` — the only paths by which a state or an edge reaches the candidate graph |
| Protocol | `ctx.systemPrompt.section({...})` | The behaviour-first loop the model follows: understand the application, name its actors and behaviours, then walk it — and record each action as a step of the behaviour it serves |
| Reconciliation | `ctx.tools.register(defineTool({...}))` | `graph_commit` — the only path from candidate records to a committed graph |
| Generation | `ctx.tools.register(defineTool({...}))` | `graph_test` — the committed document is its only input, so a spec is reproducible from `application-model.json` (or from `graph.json`, when the other reading is named) |

`tools/execute` is an around-waterfall. The wrapper only ever reads `exec` and
returns the real result — a wrapper that changed or dropped a result would
silently rewrite the agent's view of the world, and a wrapper that threw would
break the browser action it was observing. Capture failures are therefore caught
*and recorded*, never swallowed: an observation with a `capture_error` is visible,
a missing observation is not.

Our own captures dispatch `browser_eval` / `browser_screenshot` through the same
waterfall, so a module-level `capturing` guard blocks re-entry. The failure mode
is an unbounded loop that hangs the agent, so it is guarded structurally rather
than by convention.

## Output

Written under `<workspace>/<runDirName>` (default `graph-run`):

```
graph-run/
  run.json            # provenance, written once
  observations.jsonl  # machine evidence, one record per captured step. IMMUTABLE.
  states.jsonl        # the model's semantic reading, bound by observation_id
  capabilities.jsonl  # the vocabulary of things the app can be asked to do
  transitions.jsonl   # one record per walked step, endpoints derived from the readings
  evidence/           # one PNG per captured step
  graph.json          # written by graph_commit, only when the rules are satisfied
  application-model.json  # the same run read as an application behaviour model
  commit_report.json  # written by graph_commit, always
  <journey>.spec.ts   # written by graph_test, from the committed model (or the graph)
```

`application-model.json` is not a second format for the graph and it is not derived from
it: both are readings of the one run — the graph is what the machinery did, the model is
what the application offers — and each is assembled from the same log (see
[The two documents](#the-two-documents)). It is written only when all three of these hold:
the projection assembled it, the profile found no `error` in it, and it validates against
`schemas/abm/0.2/application-model.schema.json`. `graph.json` is written under exactly the
conditions it always was, plus validity, and the two verdicts are separate — a model the
schemas refuse never takes the fallback document away with it.

All four `.jsonl` files are append-only and never rewritten, so a later reading
cannot silently alter the evidence it was derived from. A reading appends a new
state or a sighting of an existing one; a step appends a transition, and walking
the same edge twice appends twice while reusing one transition id.

A run directory is **reused, not claimed**. Starting a second run in a directory that
already has a log appends to it, and `run.json` is rewritten for the newer run, so the
two runs share one evidence log and their ids collide — which the commit catches at the
expiry, as `unique_ids`. Clear or rename the directory *before* a run; see
[When the directory goes away](#when-the-directory-goes-away) for the one case where
touching it is survivable, and why doing so is still a loss.

### When the directory goes away

`graph-run/` is an ordinary directory in someone's workspace, and a run can outlive its
own output: it is deleted or moved aside mid-run, or the workspace is simply not
writable. The store's job is to survive that without ever becoming the reason a browser
action is reported as failed. Three rules:

- **A write never throws.** A record that cannot be written is a fact about the run, not an
  error in the page. The action it describes has already happened; failing it would send the
  model back to a page that has moved on.
- **A missing directory is repaired, not fatal.** The next write recreates `graph-run/` (and
  `evidence/`), then retries. `run.json` is written back *verbatim* — `started_at` and all —
  because this is the same run and not a new one, and that is also what is restored when only
  `run.json` was lost.
- **Nothing is remembered that is not in the log.** Every record is written before the index
  is updated, and a refused record returns `null` instead of an id: a state that failed to
  write is minted on the next attempt rather than mistaken for a re-sighting of a state the
  log has never seen. When the log itself was lost, the index is emptied with it — states,
  vocabulary and walk all start again — while the sequence keeps counting up, so `obs_0007`
  never comes back attached to a different step.

The two losses are reported separately in the digest, because they are different facts and
neither is inferable from the other: `graph.unwritten_records` counts records a write
refused, `graph.directory_recreations` counts times the log had to be rebuilt. Non-zero
`unwritten_records` means the walk is short by steps that were never logged;
`directory_recreations` means the log *begins* part-way through the run. What the store does
not do is pretend either hole is closed: a transition whose `before` step is no longer in
the log is refused with that reason rather than recorded with a reference the commit cannot
resolve, and while a write is still failing the recording tools refuse and name the path
rather than hand out ids nothing will read.

What it cannot do is make a repaired log whole (see [gap 9](#known-gaps-in-the-order-they-will-bite)).
So the operational rule stands: clear or rename `graph-run/` **before** a run, not during
one — and in a long-lived profile, not between two tasks either, since the `web` profile is a
server whose plugin instance (and its store) outlive any single task.

### The reading waits for the page

Evidence for a step is collected *after* the action, and an action having resolved is not the
same thing as a page having finished. A client-rendered app paints its dashboard 150ms after
the click that caused it; a collector that reads 3ms later records the screen the action was
taken **on**, not the screen it produced. The step then reads as a self-loop, the state the
model classifies belongs to the wrong action, and every reading after it belongs to the step
before its own — the whole walk is shifted by one, from a single missed render.

So the collector asks the page to stop moving first, inside the document, where the only
honest rule is available: *nothing has changed for N ms*. A fixed sleep is a guess that is at
once too slow for a static page and too fast for a slow one.

| The page, after the action | What the reading waits for |
| --- | --- |
| moved while it was watched | 250ms of quiet |
| has not moved at all | 1000ms of idle — the apparent no-op is exactly what a raced capture produces, so that is the claim worth being slow about |
| has a request of its own still open | until the request lands and the page renders its result (the page hooks are what make this visible) |
| never goes quiet | 3s, then the reading is taken anyway and reported as `settle.timed_out` |

`settle` travels with the reading rather than staying in the collector: it is a field on the
evidence record (`observations.jsonl`), a field in the digest, and the thing that resolves the
transition's `no_observed_change` warning. That warning used to hedge — *either this really is
a self-loop, or the capture raced the page's own update* — because from outside the page the
two are indistinguishable, and they call for opposite responses: a self-loop is a finding to
record, a raced capture is a reading to throw away. With the page's own account of its timing
in hand, the warning says which one it is looking at, and keeps the hedge only for records
written before it could tell.

The cost is latency on every observed action: ≥250ms when the page moved, ≥1000ms when it did
not. The limit is honest rather than hidden — a render scheduled for 2000ms announces nothing,
so the idle window closes first and the reading is taken — but the reading then carries
`changes: 0, timed_out: false`, and the transition says the page never moved while it was
watched. Nothing is claimed that was not seen; what the quiet window cannot see is a page
whose next update was never announced, which is why the note names that case and says to wait
for the change explicitly if one was expected.

### A claim is checked where it is made

The commit is the only writer of the graph, and it is where the rules live — but it runs when
the walk is over, and by then the page each claim was about is gone. A claim the commit would
refuse, or drop, arriving at the end of a run is the worst of both worlds: the tool took it,
the graph does not have it, and the correction has nothing left to correct. So the two
recording tools now ask the commit's own questions while the page is still on screen, and
refuse *before* they record anything.

| Written | Refused at the reading, with |
| --- | --- |
| `{"type": "element_state", "target": "sign_in_button", "state": "visible"}` | the condition belongs in `operator`, and the refusal says so |
| a `detection` on an element no state has declared | the purposes the run *has* declared |
| a literal value against a field the capture masks (`[set]`) | the collector's mask, and the `{"operator": "exists"}` form that says the same thing honestly |
| a detection the capture of that very reading contradicts — a claim about a screen the action has already left | what the capture *does* show, so the page in hand is recognisable |
| a reading whose controls have nothing in common with the readings already bound to the state it names — a mislabel no claim ever contradicted | both screens side by side, and the `dimensions` entry that would make it a state of its own instead |
| an effect (`value_changed`, `visibility_changed`, `element_created`, `element_destroyed`, `validation_error`) whose target is a path (`login.email`) | `semantic_purpose` — the effect names the element itself, not a path within it |
| a `capability_input` / `capability_output` the schema closes (`{"type":"string","sensitive":true}`) | the offending key and the ten keys the schema allows |

Refusing is the right answer only where the commit would drop or refuse the entry — or, in the
refuted case, where the commit grades it `error` and then finds the state unassertable, which is
the one outcome worse than a wrong reading: a walk that drove the application correctly, and a
document that will not exist. That case also cannot be answered with a note, because the reading
the claim would be bound to is **already written and immutable**: the refutation is permanent, so
the claim can never become true later, and telling the model about it at commit time would be
telling it about a correction it can no longer make. Where the commit *reports*, by contrast, the
reading reports too, with the commit's own finding code so the two names cannot drift: a value
assertion whose text no captured element carries is recorded as written and noted
`detection_value_not_in_evidence`, and a state minted out of a form's progress — the
only difference from the state before it being `value_changed` on a field — is noted
`identity_read_from_element_state`. Both notes travel **twice**, and that is deliberate: once in
`graph_observe`'s digest, where the reading is made and a model can still act on them, and once
on the transition that records the step, which is what the commit reads when the graph is
assembled. A note that only the digest carried would be a note the graph never learned.

Two rules decide which is which. **A masked value is impossible, a mismatched one is a
judgement.** `[set]` can never equal what the model wrote, so accepting the claim would put a
cell in the graph that is vacuous at best; `filled` against `test@example.com` is the model's
account of the page, and the capture is free to disagree. And **a note is never an error**:
`identity_read_from_element_state` means the two endpoints the edge names still hold — what is
doubtful is the extra identity, not the edge — so the graph commits with the doubt in its
`warnings[]` rather than being blocked by it.

The surface refusal is the newest of them, and it is refused for the reason the refuted one is:
a refused reading records nothing, so the page has not moved and no action has to be repeated,
whereas accepting it binds a reading to a state it is not of — permanently, since evidence is
append-only. It is also the only one of these questions that can be asked when the reading makes
no claim at all. A detection is checked against the capture of the reading that carries it, so a
mislabel is caught only when the detection happens to name the surface it contradicts, and a
state whose detection is a bare route assertion is contradicted by nothing. The controls are then
the only evidence there is, and they need no claim: values, messages, counts and storage all
change within one state — that is what makes them effects — while the controls are what the state
*is*, so two readings of one state are two readings of one screen and readings that share no
control are not. The commit asks the same question of the whole log and **reports** it
(`state_readings_share_no_surface`, `warning`), because by then both readings are evidence and
only the model can say which of them was misnamed.

### Provenance

`run.json` answers *could someone reproduce this run?* — what code, what
instruction, what model, what starting point:

```json
{
  "started_at": "2026-09-16T21:49:40.504Z",
  "cwd": "/Users/you/tmp",
  "start_url": "http://127.0.0.1:4173/",
  "instruction": "Open http://127.0.0.1:4173/ and sign in ...",
  "application": { "id": "app_acme", "name": "Acme" },
  "max_steps": null,
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "session_id": "session-dc4d1554-...",
  "agent_preset": null,
  "plugin": { "name": "@webtestagent/dsh-graph-explorer", "version": "0.1.12" }
}
```

Three rules hold here, and they are the whole point of the file:

- **The version is read from our own manifest, never hardcoded.** A literal
  records the version someone *believed* was installed, and goes stale the first
  time the package is bumped — which makes `run.json` actively assert a false
  fact. If the manifest cannot be read, the field is `null`: an unknown version
  is recoverable, a wrong one is not.
- **Unknown stays `null`.** `agent_preset` is `null` until a profile mounts
  `@deepseek-ai/dsh-agent-presets`, and `start_url` is `null` if the run began
  with something other than `browser_open` / `browser_navigate`. A
  plausible-looking default would be a false fact; a null is an honest unknown.
- **`start_url` is the URL that was *requested*, taken from the call's own
  arguments.** The URL actually landed on is the `url` field of that step's
  observation, so a redirect shows up as a difference between the two rather
  than being hidden.

The instruction comes from `agent/pre-step`, which carries the accepted user
batch for the step about to run. That listener reads and passes the decision
through untouched: an observer that can alter the loop it observes is a
liability.

State ids are keyed by the **semantic identity tuple** (`page_type`, `variant`,
`dimensions`), so the same identity always resolves to the same id and two states
can never collide — the identity-uniqueness invariant holds by construction
rather than by a check. The slug is built from that tuple, never from a URL, a
selector or an array index.

The two observations a transition rests on are consecutive entries of the chain:
one capture follows every action, so the capture after step *N* is the capture
before step *N+1*.

Each transition also carries its own evidence list, because an edge cannot be
recovered from one reading: it needs the state the action was taken in and the
surface the action produced.

```json
"evidence": [
  { "observation": "obs_0004", "role": "identity", "note": "the surface as it stood when the action was taken (from_state)" },
  { "observation": "obs_0005", "role": "action",   "note": "the action itself, and the surface it produced (to_state)" },
  { "observation": "obs_0005", "role": "effect",   "note": "what the machinery saw change between the two readings" }
]
```

`role` means what the schema says it means — what the observation is evidence
*for*. Labelling the earlier reading `action` asserted that the *previous* tool
call was this transition's action, which it was not.

## Recording a transition

A transition is the one thing that cannot be recovered from a single reading: it
needs the state the action was taken in, the state the action produced, and an
account of what changed between them. `graph_transition` takes the model's account
of the change and derives the rest.

**Endpoints are derived, never supplied.** `from_state` is the state read for the
capture before this step, `to_state` the state read for this step's own capture.
Both come from the observation-to-state index, so a model that misremembers where
it was cannot invent an edge. If either reading is missing the call is refused,
with the reason: a reading has to be made while its page is still on screen, and
that cannot be done retroactively.

**The two accounts of a step are compared, and both are kept.** The model's
`effects` are a claim; the capture is a fact; neither is authoritative. The record
holds `observed_change` beside `effects`, and the tool result shows them side by
side. The model can see what a DOM diff cannot (that a message is the app refusing
a duplicate, that a name came from the server); the capture can see what the model
cannot (that the URL never actually changed). Disagreements come back as
`disagreements[]` and are written into the record's `notes`, so the graph carries
the doubt instead of erasing it.

The two kinds of disagreement are treated differently:

- **Errors refuse the call and nothing is recorded.** They are self-contradictions
  inside one record — an effect claiming `state_entered: X` while `to_state` is `Y`.
  No amount of evidence makes that true, so there is nothing to record and nothing
  to warn about. `to_state` is the derived one, so `X` is the effect that has to change,
  and it has to be a **state id**: the `page_type` a reading used (`project_list`) and its
  `variant` (`authenticated`) are names for what a state *means*, not names for the state
  itself, and the graph's own reference check would leave a `state_entered` pointing at
  either of them dangling. Two live runs wrote exactly those two fields in turn, which is
  the going rate for a parameter the docs left undefined; both corrected it on the next
  attempt once the refusal named the state id it had derived.
- **Warnings are reported and recorded**: a claimed `message` no capture carried, a
  claimed navigation across an unchanged URL, an unclaimed URL change, a claimed
  request nobody saw, a step where nothing observable changed, and a self-loop whose
  two readings share no interactive surface at all — which is what a reading taken at
  the wrong moment looks like, and the failure that silently shifts every endpoint
  after it.

The comparison looks at everything the capture records, not just the text: an input's
value, a checkbox's checked state, whether a control is disabled, and application
storage. It has to. Most of what a form step does lives in a field's value, so a diff
that ignored values reported every step of a form as "nothing changed" and blamed a
raced capture for it — a wrong explanation of a step that was fine.

`chain_break` is the invariant-5 check, and it is recorded rather than refused: if the
previous step ended somewhere other than where this one starts, the walk has a
discontinuity. Re-opening a page mid-run legitimately starts a new strand, and only the
model knows which happened.

**A step's own account is corrected by stating the step again.** A step is the edge it
moved along plus the two readings it was made from, and that pair is what identifies it:
calling `graph_transition` again for the step you have *just* taken — the same capability,
the same two readings — is the walk saying that one step again. No step is added, the
walk does not move, and the later statement **replaces** what the walk says about that
step, which is how a value attached to the wrong edge, or a target misread, stops being
the walk's account of a step. The timing is not decoration: a statement made after the
next action is a different step rather than a correction of this one, because the readings
are what identify it. The earlier statement stays in `transitions.jsonl` — the log is
append-only, and the mistake beside the correction is what makes the exception an
exception rather than a retraction — and the report lists it as `superseded` beside the
one that stands. It also cannot break the chain it is standing on: a restatement names
the state its step *started* from, which is never where the walk stands, so reading it as
an ordinary step would report a discontinuity that never happened on the step that is
being corrected.

Both readers of that rule — the store as it records, and the commit reading a log — ask
the same exported function rather than each holding half of it, and **the commit derives
which records are restatements from the log rather than trusting the `restatement` field
on them**. The field is the recorder's note about what it believed at the time; the log is
the evidence. A run recorded before the rule existed wrote the correction as an ordinary
step, with no field on it at all, and a commit that needed the field would commit that run
exactly as the version that had the defect did.

Calling `graph_transition` with **no capability** is the read-only report: where the
walk stands, what the vocabulary is, and — for any other argument that was supplied —
a note naming what was read and ignored. The absence of a capability is the signal, so a
half-formed call reports where it is instead of either recording something unintended or
failing with a complaint about an unusable name.

A transition id names an **edge**, not a visit: `(from_state, to_state, capability)`
maps to one id, and walking it again appends another step with `repeated: true`. That
keeps identity-uniqueness true by construction while leaving "we added two products"
intact as two steps.

## The commit

> Exploration is allowed to be wrong; `graph_commit` is where the run decides what
> becomes knowledge.

Everything above this line is *evidence*, and evidence is append-only for a reason: a
capture is a fact about what the page did, a reading is what the model made of it, and a
transition candidate is a claim about the step. None of them can be retracted by
appending more of them, and none of them should be edited after the fact — an edited log
is not evidence, it is a story.

That leaves the question of what the run *knows*, which is a different question from what
it recorded. `graph_commit` answers it, once, against the whole run at a time. This is
where the exploratory logs become a graph, and it is a reconciliation step rather than a
blind append:

```
raw evidence        observations.jsonl          append-only, never rewritten
                    states.jsonl                 candidates: every reading
                    capabilities.jsonl
                    transitions.jsonl
        │
        │  graph_commit — read all of it, judge each candidate, write both files
        ▼
committed graph     graph.json                    only what survived the rules
                    application-model.json        the same run, read as an app's behaviour
                    commit_report.json            every judgement that produced it
```

The two documents are written by the same pass and neither is derived from the other. The
same run read one way is what the machinery did; read the other way it is what the
application offers — which is what "two readings of one run" means here (see
[The two documents](#the-two-documents)).

**It never repairs the raw logs.** A refused edge stays in `transitions.jsonl` exactly as
the walk recorded it; a refuted detection stays in `states.jsonl` exactly as the model
wrote it. The commit only decides what *enters the graph*. So the same run can be judged
differently later — after a config fix, a new rule, or a second walk — without re-walking
and without pretending the earlier reading never happened.

**A refusal is a decision, not an error.** The tool returns `committed: false` and the
blocking rules; it does not throw and it does not clean up. An agent that treated a
blocked commit as a crash would lose the report, and the report is the product of that
run: it is the thing that says *which* rule fired and *which* candidate caused it. The
only inputs that raise are a directory that is not a run at all and a corrupt log, and
even then nothing is written.

**`ok` describes the document; finding severity describes the candidate.** This
distinction carries most of the design:

| | what it is about | what it means | effect |
| --- | --- | --- | --- |
| `report.blocking[]` (gates, error) | the document | a rule the graph cannot satisfy | `graph.json` is not written |
| `findings[]` with `severity: error` | one candidate or one element | that candidate is wrong | the edge is refused, the graph still commits |
| `findings[]` with `severity: warning` | one candidate | doubt the run carries | committed, with the doubt recorded |
| `findings[]` with `severity: info` | one translation | the commit changed the shape of what it was given | committed as translated |

The two are separate on purpose. A single bad edge is not a reason to withhold an entire
graph — it is a reason to withhold *that edge*, and to say so where the model will read
it. Conflating them produces the worst of both: a graph that is thrown away over one
refusal, or a refusal that gets committed with a shrug.

### What blocks a graph

A gate fires on the document, not on a candidate:

- **`application_not_declared`** — `application: {id, name}` is required by the schema and
  cannot be observed (see [Configuration](#configuration)), so an unset one is a config
  fix, not something a second walk could discover.
- **`state_page_type_not_usable`** — a reading whose `page_type` cannot be a schema id.
  Identity is required, so a state without a usable one is uncommittable.
- **`state_without_detection`** — every state must carry at least one assertion that
  identifies it, or the graph has a state nothing can recognise.
- **`state_identity_collision`** — two committed states with the same id. `graph_observe`
  makes this impossible by construction, so it means the logs were edited.
- **`nothing_to_commit`** — records exist but no state was ever read for any of them. This
  is the gate that catches the most common way a run goes wrong: an agent that drives the
  page, records transitions, and never calls `graph_observe`. The logs look non-empty, so
  an "is there anything here" check would pass; there is nothing to reconcile, because a
  transition's endpoints come from readings.

### What is judged instead

Per candidate, and recorded in `report.decisions[]`:

- **Evidence refutation.** `detection_refuted_by_evidence` (error): a state claims its
  detection assertion held, and the capture bound to that very reading disproves it. This
  is the check that makes `detection` a *predicate checked against evidence* rather than
  three bullets the model typed — a claim about a page it can no longer see, verified
  against a page it captured. `detection_value_not_in_evidence` (warning) is the softer
  version: a text or value claim no captured element carries.
- **Translation, reported.** A bare `{"type": "url"}` detection has no value to compare, so
  it is pinned to the route derived from the state's own captures and reported as
  `detection_url_pinned_to_route` (info). The alternative — dropping it — would leave a
  state with no detection and turn a missing value into a blocked graph.
- **Element declaration ownership.** An element id is globally unique across states
  (§14.1), so exactly one state *owns* each element and the other states that declare it
  are `also_declared_in`. That is a `warning` (`element_declared_in_several_states`), not an
  error: the inventory is shared, the identity is not. `element_not_seen_in_evidence`
  records an element no capture ever showed. `elements` is an **inventory**, `detection` is
  a **predicate** — reading them as the same kind of claim is how a duplicated inventory
  becomes a false identity.
- **Reference resolution.** The model writes shorthand (`{target: 'logout'}`, purposes,
  capability names, observation ids); the schema wants ids. Every translation is either
  resolved (`effect_targets_resolved`, `element_aliased_to_id`) or dropped with a named
  reason (`assertions_dropped`, `effects_dropped`, `api_references_dropped`, with details
  like `element_target_does_not_resolve`, `state_assertion_without_a_state_endpoint`). A
  dropped reference is never silent: it would make the graph assert less than the run did,
  which is indistinguishable from a run that found less.
- **Supersede.** A transition id names an edge, so several candidates can share one — a
  self-loop then a clean re-walk, say. The best candidate is committed and the others are
  `superseded` with `candidates: N` and the reason, never deleted. Prefer a candidate with
  endpoint evidence and no self-contradiction; `superseded` is not the same verdict as
  `rejected`, and the report keeps them apart. A **restatement** is superseded with its own
  reason, because it is not merely a repeat: between two statements of one step the later
  one is the one the walk means, and the report says which of the two it is keeping and
  why.

### Journeys are derived, not decided

`graph.schema.json` has a `journeys[]` array and `journey.schema.json` holds `start_state`,
so a graph has always been able to say where a walk begins and which steps it is made of.
Until 0.1.12 nothing assembled one, which is why `reachability` had no entry state to flood
from.

The assembly is mechanical and stays mechanical. `transitions.jsonl` is already an ordered
list of walks — one record per step, in the order the steps were taken — so the commit reads
it back and starts a journey at the first step, appending ids while each step starts where
the one before it ended. Three things cut a run in two:

- **the walk jumped** — a step that starts at state C while the previous step ended at state
  B. Both states exist and both edges are committed; what is missing is the link between
  them, and calling the two steps one walk would invent the move that connects them.
- **the edge was not committed** — the candidate was refused (or superseded), so there is no
  edge to walk.
- **the edge does not join two committed states** — an endpoint state was gated out (no
  detection, a colliding identity), so the step has nowhere to land in *this* graph.

Every cut is recorded rather than hidden: `report.journeys.breaks` carries the reason and
the two ends, and a step repeating an earlier id is marked `repeat_of_earlier_step` in
`metadata.extra.steps[]`, because a walk that signs in twice is two steps and one edge.

What a journey cannot carry from its walk alone is a goal: a browser session records what was
done, never what was being attempted. There is exactly one place in the run where intent was
written down, and that is `run.json` — the instruction the host supplied, captured from the
harness's `agent/pre-step` before the first action — so that is what the commit quotes:

- `name` comes from three sources, in the order of how much they say: **the model's own
  `journey_name`** if a step claimed one — the model walked it and is the only party who saw
  what it was for — then the run's stated goal, then the endpoints. The goal is *shortened*
  rather than copied, because `goal` is already the whole sentence and `name` is a handle for
  a list of walks: the first clause, cut at its first comma or connective, with any URL or
  email cut first (a cut at the first colon stops inside `http:`, which is how a name becomes
  `open the Acme demo app at http`), and a trailing connector dropped only when a parameter
  is what was cut — because `open the demo app at` has lost the thing the `at` pointed at,
  while `open the demo app and sign in` has not. If whatever survives is longer than a
  title it is clipped at a word boundary with an ellipsis. `name_from` records which of the
  three applied, in a sentence, and `name_stated` says whether a person's words are in it at
  all — a name is the one field a reader takes at face value. The endpoints are the name only
  when nothing was ever stated: they say where a walk went and nothing about what it was.
- the restriction on the goal is unchanged, and still the point: the instruction names the
  run, not each of its journeys, so a walk that broke into three strands has three walks and
  one instruction, and giving all three the same name would attribute a goal nobody stated
  to two of them. `goal_source` carries which of the two applied.
- `criticality` is **omitted rather than guessed**. The schema's `criticality` is a closed
  enum (`smoke | critical | standard | extended`, default `standard`), so writing prose there
  would be a schema violation; the reason goes in `metadata.extra.criticality` and the
  default applies.
- `metadata.status` is `inferred` and `producer` is `importer:dsh-graph-explorer` — not
  `llm:<model>`, because no model judged this, the importer read it off the log;
- `metadata.extra.run_instruction` carries the instruction verbatim, `goal_stated` says whether
  this journey's name is that instruction, and when there was no instruction to quote the graph
  carries a warning saying that `graph_test` has no goal to put on the test it generates, so a
  derived journey's `test("Derived walk 1: …")` is what the spec will be filed under. An empty
  instruction is not a goal, and neither is one the host never sent: the field is omitted and the
  warning stands, because "the run was asked to do nothing" and "nobody said what the run was for"
  are the same graph.

Evidence is carried across from the steps and deduplicated by observation and role. It has
to be: the schema's `evidenceRef` points at observations, never at transitions, so a
journey's evidence is the readings its steps rested on.

### The two documents

`graph.json` and `application-model.json` are two readings of one run, not two versions of
one file, and the distinction is the point of the model rather than a detail of how it is
assembled. The graph answers *what did this walk do*: a capability applied in one state,
landing in another, with the calls it took to get there named on the edge. The model
answers *what can this application be asked to do*, in the words a person would ask for it
— one behaviour per thing a user wants, its `realization[]` the steps it is performed by,
its parameters the ones the steps bind, and the edges the surfaces it is offered from.

Nothing derives one from the other. Both are projected from the same log, which is why a
fact the graph cannot hold is not a fact the model loses: a step's `purpose` and its
`effects` have no key in `capabilityStep` (`additionalProperties: false`, and the shape is
deliberately narrower), so the model's steps are read from the `realization_step` records
themselves rather than from the graph's projection of them.

Three things read the model, and each is a way for it to be wrong out loud rather than
quietly:

- the **schemas** in `schemas/abm/0.2/`, which every document is checked against before it
  is written;
- the **profile** (`P1`–`P15`), whose `error` findings withhold the file — a document
  nothing downstream reads cannot be wrong in a way that matters, so the file is only
  written when the profile has nothing to say about it;
- **`test/abm-commit.test.mjs`**, which commits a real walk through the real tools and
  checks the four things the model owes: the fallback document is unchanged in shape, the
  model validates and is written, the floor 0.1.22 carried is still carried, and the
  commit's own model rules are the *same definition* as the standalone profile — asserted
  by asking both the same question about the same walk, not by reading the source.

**A collapse may not hide a state the edge itself names.** `P12`'s collapse check
(`collapsed_past_a_state`) refuses an edge whose `collapsed.passed_through` names a state that no
step of the behaviour accounts for: a state the walk entered between the edge's own two ends is a
reading nothing in the document explains. It skips the edge's own `from_state` and `to_state`, and
that skip is a fix the 0.1.25 live sign-in walk paid for — the demo application's form is on the
page the walk begins on, so both fills are self-loops and the three calls collapse into one edge
`state_home_anonymous → state_home_authenticated` that "passes through" the state it *starts* from.
The rule asked the behaviour to record arriving at a state the walk never left, and the only effect
that could satisfy it was a false one, so the run withheld `application-model.json` rather than
write it. A rule whose sole satisfaction is a lie is the rule that was wrong.

The phase-by-phase design, including what each phase is still allowed not to do, is in
[`docs/abm-pivot.md`](../../docs/abm-pivot.md).

### The report

`commit_report.json` is the run's own account of the commit, written even when the commit
is refused:

```
generated_at  command  run_dir  application  start_url  instruction  version
ok  blocking[]  gates[]
states{committed, candidates, deduplicated, readings}
capabilities{committed, candidates}   transitions{candidates, distinct, committed, rejected, superseded}
journeys{assembled, walked, unusable_steps, breaks, entry_states}
observations{records, carried}        elements{declared, conflicts, shared}
documents{graph{name, schema, checked, valid, written, errors}, model{…}}
decisions[]   findings[]   invariants[]   notes[]   warnings[]
```

`documents` is the per-document verdict, and it exists so "which document is short, and
why" is answerable without opening two files: `checked` separates *wrong* from *not
there* (`valid: null` is the third answer), `written` says whether the file is on disk, and
`errors` is the schema's own list. `invariants[]` carries a `document` field for the same
reason: the graph's §14 rules and the model's `P1`–`P15` are in one array, each finding
saying which document it is about. `blocking[]` stays about `graph.json` — that is the
document the run was for — so a model rule firing cannot block the graph; it withholds the
model, which is reported in `documents.model.blockers[]`.

`decisions[]` is per candidate (`commit` / `reject` / `supersede`, with the reason);
`findings[]` is flat and carries its `scope`, so a dropped assertion on a *committed* edge
is as visible as one on a refused edge — the earlier shape hid them inside
`decisions[].warnings`, which is exactly where nobody looks; `invariants[]` is §14
(`identity_unique`, `reference_integrity`, `journey_is_a_walk`, `reachability`,
`feature_closure`, `version_coherence`, …), each with a severity and only some of them
blocking;
`observations{records, carried}` says how many raw records travelled into the graph as
evidence refs; `notes[]` carries the recorder's own warnings, graded by
`NOTE_SEVERITY`, so `self_loop_but_controls_changed` — read at the wrong moment, the
failure that silently shifts every endpoint after it — arrives as an error rather than as
a line in a list of warnings.

**`force` writes the assembled document with its refusal in `warnings[]`.** It is for
inspecting a near-miss: `graph.json` is written from the same draft the rules judged, and
every blocker is echoed into the graph's own `warnings` (which the schema types as an
array of strings) so a forced document cannot be mistaken for a clean one. `report.ok`
stays `false`. A forced commit is not a way to commit; it is a way to look.

### Committing without an agent

The reconciliation is a pure function over files, so the tool is a thin wrapper:

```sh
node lib/commit.js ~/tmp/graph-run          # human-readable summary, exit 0 ok / 1 blocked / 2 usage
node lib/commit.js ~/tmp/graph-run --json   # the report
```

Consequence worth knowing: `graph_commit` with no `run_dir` targets the run *this session*
recorded, and failing that the run directory the session would have written to. It does
**not** create one. A commit that started an empty run in order to reject it would leave
a directory behind that looks like an exploration nobody performed.

**Independently validated.** The graph is checked against the normative schemas in
`IntegrationTestGenerator/schemas`, and the validator deliberately lives **outside this
repo** (`~/tmp/schema-check/`), so a fresh clone's `npm test` needs no install:

```sh
cd ~/tmp/schema-check && node validate.mjs ~/tmp/commit-probe/graph.json
GRAPH_SCHEMA_DIR=/path/to/schemas node validate.mjs <graph.json>   # schema dir override
```

It is `ajv` + `ajv-formats` (`Ajv2020`, `strict: false`, draft 2020-12), and it is the
reason the report's own findings can be trusted to mean what the schema means: the plugin
enforces the parts of the target format it can judge, and the validator catches the parts
it got wrong. Both are needed — the plugin can be wrong about the schema, and the schema
cannot see the run.

## Generating a test

`graph_test` reads a committed `application-model.json` — or a `graph.json`, if that is all
the run has — and writes one Playwright spec for one of its journeys. The document is its
**only** input: not the logs, not the run, not this session. So the spec is reproducible —
delete the run directory, keep the committed document, and the same call returns the same
bytes — and the only things that vary between two calls are which journey was named and which
of the two readings of the run was asked for.

```jsonc
{ "journey": "Sign in to Acme Demo App", "run_dir": "graph-run" }
{ "journey": "Sign in to Acme Demo App", "run_dir": "graph-run", "source": "graph" }
```

`source` is `model` by default when the run has a model, and `graph` forces the other
reading of the same run. The result always says which one it was (`source`), where the
document came from (`document_path`) and where the other one is (`graph_path`, or `null`),
so a comparison is two calls and a diff rather than a guess about what was read. Asking for
a document the run does not have is refused by name — the tool that reads the graph does not
quietly answer for the model, because *which* document a spec came from is a claim about the
spec.

`journey` takes an id, a name, or a description. With exactly one journey in the graph it
can be omitted; with several, the tool **refuses and lists them** rather than picking one,
because a spec that clicks through the wrong walk passes for the wrong reason. The search
is id → name → substring → shared words, and `matched_by` says which one fired, so a fuzzy
match is visible in the result rather than hidden in a hunch.

```ts
/**
 * Generated from a committed graph — not written by hand.
 * ...
 */
test("Sign in to Acme Demo App", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("textbox", { name: "Email" }).fill("test@example.com");
  await page.getByRole("textbox", { name: "Password" }).fill(process.env.TEST_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("current-user")).toHaveText("test@example.com");
});
```

**The model is read for its `realization[]`, and that is the difference in the file.** A
model's move carries no `arguments`: the walk recorded the value on the step it typed it on,
and the generator reads it there — `'the value this step recorded as typed into
element_email_input (realization[0] of behavior_fill_login_email)'` — so the typed value, the
control it went into and the step are one object and there is nothing to match up. The
`arguments` a graph carries are the same claim *by name*, and a name has to be matched
against an element to be used. So the model is preferred where both exist, and the graph is
what made the older behaviour work on day one (D1).

**A value that is a reference is read from the environment; a value that is a value is
quoted.** Two values are references, and they are one fact recorded by two parties. `[set]` is
the *capture's* word for "a value was typed here and this run may not keep it". `{{param}}` is
the *schema's*, and it is the only other thing a step's `value` may be: `normalizeRealizationStep`
refuses a non-string with *"a literal the step types, or a `{{param}}` template bound to the
behaviour's `input`"*. Both become `process.env.TEST_<PURPOSE>!` and a `requires[]` entry, and
only a value that **is** the whole template counts — `"user-{{n}}@example.com"` is a string with
braces in it, and naming an environment variable after a fragment would be a secret nobody can
supply. A live 0.1.32 run is why the second spelling has a rule at all: its walk recorded
`value: "{{password}}"` with `password` declared on the capability, and the generator quoted it.
The rule is asked of the **value** and not of the document it arrived in, so a graph's
`arguments` holding a template resolves the same way — the older document is never the less safe
one. And the same test narrows `argument_disagrees_with_the_reading`: a step that binds the
parameter *and* carries a withheld reading has said one thing twice, so neither is reported
against the other; only a literal where the reading says "withheld" is a disagreement.

**A model step with no `realization[]` behind it is refused rather than written**
(`action_has_no_realization`, naming the behaviour and the element): a spec written from the
model acts on what a reading recorded, so an action with no reading under it is not a line
this tool writes. This is the one place the two renderings are allowed to differ, and it is
the acceptance sentence of the pivot as a rule — every action in a spec written from the
model traces to a `realization[]` step — rather than a claim a reader has to check.

A model's journey names **moves** (`journeys[].steps[]`) where a graph's names the
**calls** it stepped through (`journeys[].transitions[]`), and one move becomes the calls it
was made of before the generator sees it: the behaviour is named once, on the call that
ended the move, because one performance is one claim — and an arrival can only be asserted on
that last call, since the calls in between neither arrive nor leave. Read the model and you
are reading one edge per move; read a spec generated from it and you are reading the calls,
which is the only shape a browser can be told to perform.

**And the file says which of the two it is**, in its first line and in the line that records
where the document came from — `Generated from a committed behaviour model` and `Model:`
where the graph reading says `graph`. That line is the one claim in the artifact nothing
downstream can check, and it is the claim a reader uses to reason about the rest of the file:
a spec from the model cannot contain an action with no reading under it, and one from the graph
can.

A model cannot yet say which of two invocations of one behaviour typed which value —
`realization[]` is one list per behaviour — so a spec generated from a walk that performed
one move twice renders both turns with the values the log kept and reports
`invocation_values_not_distinguished` **once per edge**, with the `walk_index` to go and read
the other one. That is the known limit, reported where it bites rather than left for a reader
to notice.

Three things about that file are decisions rather than transcription.

**The spec follows the walk, not the claim.** Lines come from transitions — what the run
did — and the checks come from `state.detection`, the model's own answer to "how do I know
I am on this screen". A capability declared `composite` over behaviours whose steps act on
other elements is reported (`composite_step_targets_a_different_element`) and the transition
is written anyway: the composition is a claim about the application, and a test is a record
of what happened.

**It refuses three things, and says so where the refusal is.** A storage key is never
asserted — no browser can be asked what the application remembers, so the evidence that a
session survives is reported and the check is left to whoever writes the reload test. An
element with no actionable role is never clicked: a heading is something a screen *has*, and
saying what a user does to it is the model's job, not the generator's. And a value the run
did not keep is never invented — `[set]` in the store becomes `process.env.TEST_PASSWORD!`
and a `requires[]` entry naming the element it came from, which is the whole difference
between a spec that says what it needs and one that contains a made-up password.

**Every line carries its provenance, in the result if not in the file.** `steps[]` names the
transition, the capability, the element, the locator and the readings that produced each
action; `assertions[]` says whether a check came from the walk, from the graph's own
detection, or from a candidate the commit derived — and a candidate that repeats a line the
arrival block already wrote is reported as a duplicate rather than written twice. `gaps[]` is
everything the graph implies and the spec cannot say, each in one actionable sentence,
because a gap is the model's next exploration.

**`ok` is not "a file was written".** A spec with a blocking gap is written *and* is not ok:
it drops the step the graph could not turn into an action, so it would pass without
performing it. Read the gaps before treating the file as a test.

The generator is a pure function (`lib/generate.js`) with a thin tool wrapper around it, so
its rules are tested one at a time against hand-written graphs: locator ranking, journey
selection and its refusals, every assertion type and every operator, the row-count
translation of a dimension, and the whole body of a spec compared character for character.

## Install

**Tarball, not a `link:` directory.** A directory install resolves the real path,
so the plugin's `import '@deepseek-ai/dsh-tools'` starts from the repo — which has
no `node_modules` and no harness packages — and fails to resolve. A tarball is
copied into the profile, where the walk up to `~/.dsh/profiles/node_modules`
finds the same package instances the harness itself uses.

```sh
cd packages/dsh-graph-explorer
npm pack                                     # -> webtestagent-dsh-graph-explorer-0.1.22.tgz
dsh plugin --profile graph add "$PWD"/webtestagent-dsh-graph-explorer-0.1.22.tgz
```

The version in that filename is load-bearing: pnpm keys a `file:` tarball on the
spec string, so re-installing the same path **at the same version** reuses the
cached copy and silently keeps the old code. `--force` does not help, and neither
does deleting the installed directory first — the copy is served from the store,
not from `node_modules`. Bump `version` in `package.json` and repack to actually
deploy. That is how 0.1.22 came about: the two fixes the 0.1.21 live run found
were packed and installed at 0.1.21, the profile kept 0.1.21's `generate.js`, and
`grep -c withheldByEvidence` on the *installed* file returned `0`.

The installer's own output is not proof of what landed. Verify the artifact, not
the exit code:

```sh
cd ~/.dsh/profiles/graph/node_modules/@webtestagent/dsh-graph-explorer
diff -r <repo>/packages/dsh-graph-explorer/lib ./lib && echo IDENTICAL
diff -r <repo>/packages/dsh-graph-explorer/test ./test && echo IDENTICAL
```

Then **re-run the browser patcher** for that profile:

```sh
node <repo>/scripts/patch-dsh-browser.mjs --profile graph --verify
```

`dsh plugin add` runs a `pnpm install` in the profile, which restores pristine copies of every
other dependency — `dsh-browser` included — so it undoes all three edits and deletes
`init.d/page-hooks.js` with the rest of the package directory. The plugin keeps working after
that, because `browser_eval` still installs the hooks; what is lost silently is document-start
timing, and with it the requests an entry document loaded with (gap 1). Re-running the patcher is
what puts it back, and `--verify` is what tells you it is back.

`dsh plugin` shells out to a bare `dsh` and a bare `pnpm`, so both must be on
`PATH`.

The bundle declares `@deepseek-ai/cordis` as an *optional* peer. Nothing in this
plugin imports it; it is a declaration of the host contract, kept optional so an
unresolvable peer can never turn a plugin install into a hard failure.

## Configuration

```yml
- id: graph-explorer
  name: '@webtestagent/dsh-graph-explorer'
  config:
    observeTool: graph_observe       # rename the semantic tool
    transitionTool: graph_transition # rename the transition tool
    commitTool: graph_commit         # rename the reconciliation tool
    generateTool: graph_test         # rename the spec generator
    runDirName: graph-run            # where evidence lands (relative to the workspace)
    application:                     # which application this graph is about
      id: app_acme                   # stable, prefixed; not derived from the URL
      name: Acme                     # human-readable
    maxSteps: 12                     # folded into the prompt's step budget
    screenshot: true                 # one PNG per captured step
    maxDigestChars: 14000            # trims the digest before it competes for context
```

`application` is the one field of the graph the machinery cannot observe. `run.json`
records the start URL and the instruction, and neither of those names an application:
a host is where an app is *served*, not what it *is*. That is why the schema carries
`application.id` beside `base_url` and adds an `environments` map — the identity has to
outlive the address, or walking the same app on staging silently becomes a second
application.

So it is declared, and there is deliberately **no fallback**:

- unset leaves `null` in `run.json`, and the commit refuses, naming the setting to
  supply. That is recoverable.
- an id derived from the start URL would not be. It would sit in the finished graph
  indistinguishable from a declared one, and nothing downstream could tell them apart.

`id` must be prefixed (`app_acme` / `app-acme`) and `name` non-empty — the two required
fields of `application.schema.json`. Anything else is refused rather than repaired,
including an unrecognized key: the schema sets `additionalProperties: false`, so a key
it does not list is a typo, and a value silently dropped is the same class of falsehood
as a guessed default. As with `runDirName`, the config **schema** catches a bad `id`
while the profile is booting, and `apply()` **normalizes once** so that what reaches
`run.json` is already known to be usable.

`runDirName` must be a path relative to the workspace, and it **must not be able
to escape it**: no leading `/`, no `..` segment, no backslash, no NUL. Nested
paths (`out/graph`) are fine; a leading `./` and a trailing `/` are trimmed
because they name the identical directory.

This is refused rather than repaired, in two places, for two different reasons:

- the config **schema** carries the pattern, so a bad value is reported as a
  config error while the profile is still booting, next to every other setting;
- `apply()` **normalizes once**, so the directory the prompt tells the model to
  read and the directory the run store writes to are the same string by
  construction. They had become two independent derivations of the config: the
  prompt interpolated the configured name, while `createRun` ignored it and
  hardcoded `graph-run`. So a custom `runDirName` produced a prompt that named a
  directory nothing ever wrote to, and a `run started:` log line (built from the
  config) that confirmed the name the writer had just discarded.

`path.normalize` is deliberately not used: it silently collapses `a/../b` to
`b`, and the same forgiveness applied to `../b` would quietly write evidence
outside the project. A rewritten path is how a config typo becomes a surprise on
disk.

## Why four tools, not ten

A semantic layer usually grows one tool per noun — `observe_state`, `identify_state`,
`save_state`, `find_similar_state`, `record_transition`, `add_capability`,
`query_graph`, `generate_test`.
This plugin has four. The merges are deliberate, because each split
creates a state the graph can be left in that has no meaning:

| Split in two | The half-recorded state it allows |
| --- | --- |
| `identify_state` / `save_state` | a reading that was identified but never saved — a state the model believes it recorded |
| `save_state` / `find_similar_state` | a second id for a state that already has one, which is how a graph becomes a list of URLs |
| `add_capability` / `record_transition` | an edge phrased in a vocabulary nothing else uses |
| `observe_state` as a model call | evidence that exists only where the model remembered to ask for it |

So `graph_observe` identifies, finds the duplicate and saves, in one call — and the
identity tuple it keys on makes duplicate state ids impossible *by construction*
rather than by convention. `graph_transition` mints or reuses the capability by name
as part of recording the edge. And the observation is not a tool at all: the recorder
takes it around every page-changing call, so the evidence exists whether or not anyone
asks for it. The direction of every merge is the same — a boundary that can be called
half-way leaves a half-recorded graph behind, and the failure is silent.

**Reading the graph back is not a tool.** It is reading a file: the profile mounts
filesystem tools, and `graph_transition` with no arguments reports where the walk
stands and what the vocabulary is. A `query_graph` tool would duplicate `read_file`
over data the model can already open. The moment to add one is when a run gets large
enough that reading `states.jsonl` costs more than a compact projection would — not
before, and never instead of the file, which is the evidence.

**And the third tool is not a fourth merge target, it is a boundary.** It would be
easy to fold the reconciliation into `graph_transition`: judge the edge as it is
recorded and write it into the graph directly. That would make every candidate
knowledge the instant it was claimed, which is the one thing the design refuses —
there would be no point at which a claim could be withdrawn, so the append-only logs
would be a formality and a misread page would be in the graph with nothing to compare
it against. Keeping the commit separate is what makes "exploration is allowed to be
wrong" a property of the system rather than an aspiration: the walk is free to be
sloppy because the commit is where sloppiness gets caught, and the commit can be strict
because it judges the whole run at once instead of one step at a time.

**The tool count is not the goal; the number of half-recorded states is.** Each of the
four exists because removing it would leave a claim that is neither evidence nor
knowledge — a reading nobody saved, an edge judged before it could be compared,
evidence that is not a graph, a test that is not derived from anything.
`graph_observe` and `graph_transition` write candidates; `graph_commit` is the only
writer of the graph; `graph_test` writes one file and never touches the graph.

**`graph_test` is a tool and not a mode of the commit**, although it could be one.
Generating is the only step in the chain whose input is a *finished* artifact — the walk
is over, the graph is on disk, and nothing it does can change either. So it takes a path,
is run again, and returns the same spec: its input is one file, which is the thing the
run itself is not. It is also the only step whose *normal* outcome is a refusal: "that
journey is not in this graph" and "this spec drops a step the graph could not make an
action out of" are answers rather than errors, and a mode folded into the commit would
have to give them in the commit's own report, where a reader looking for a test would not
think to look.

**What the browser does not provide.** `dsh-browser` is 12 tools (`open`, `navigate`,
`click`, `type`, `select`, `wait`, `screenshot`, `get_text`, `get_html`, `eval`,
`close`, `install`) and this plugin does not add to them. Three things a design usually
assumes are therefore absent, and here is what stands in for each:

- **No accessibility tree.** `page.accessibility.snapshot()` belongs to Playwright, and
  reaching it means a source patch to `dsh-browser`, which owns the page. So the capture
  computes role and accessible name in the page instead — from `role`, `aria-label`,
  `aria-labelledby`, `labels`, `placeholder`, `alt`, `title`. That is enough for elements
  to be addressed as `role:name`, the way an accessibility tree addresses them, and it is
  an approximation of one rather than the same thing.
- **No network getter.** Requests come from hooks this plugin installs into the page. There is
  no API to ask the browser what it fetched and no way to attach to a request that has already
  been made, and installing the hooks *before* a document runs needs an init script that
  `dsh-browser` cannot be configured with — so a local source patch supplies one, and the
  capture reports which way it got them (see gap 1 below).
- **No general key press.** `browser_type` presses Enter when `submit` is set, and that is
  the only key reachable. Escape, Tab and the arrow keys are not, so a flow that needs to
  dismiss a dialog or drive a keyboard-only widget cannot be walked at all. That bounds
  which transitions a run can discover, and it is worth knowing before reading a thin
  graph as a thin application.

**One tool that reads like inspection is not.** `browser_eval` runs arbitrary JavaScript
in the page and its own description offers "triggering page logic" as a use, so it is
captured around like a click. That is not a precaution: the recorder itself changes the
page through `browser_eval` when it installs its hooks. Read the state after an eval
exactly as after a click — or the step becomes evidence nobody interpreted, and the
transition over it cannot be derived at all.

## What this proves, and what it does not

**Proven end-to-end:** evidence is captured around every browser action and persisted
with artifacts on disk; `graph_observe` and `graph_transition` are visible to the model,
callable, and refuse unsound input instead of accepting it; the protocol section reaches
the assembled prompt; and a live run against `demo-app` produced 5 states, 6
capabilities and 6 transitions, reusing one transition id for a re-walked edge and
reporting a misplaced reading as a `chain_break` instead of letting it pass.

**Proven on the recorded run, 0.1.10.** A real run's eleven state records (four readings, seven
sightings) commit to four states and two edges, and the resulting `graph.json` validates
against the normative schemas with no errors — with one candidate refused (a self-loop whose
two readings share no interactive surface, arriving as an error rather than a warning), three
elements attributed to the single state that saw them first, two detections dropped because
one of the state's own raced readings refutes them, and two assertions dropped for naming
something the graph does not declare. Re-committed under 0.1.12 it also yields a journey:
`transition_logout` then `transition_login`, a sign-out and sign-in round trip walked from
`state_dashboard_authenticated_auth_signed_in` — the first time a recorded walk became a
`journey` rather than only a transition log.

**Proven by a live agent run, 0.1.11.** A sign-in walk against `demo-app` called `graph_commit`
as its own last step and committed 6 states, 4 capabilities and 7 edges from 9 readings;
the graph validates. The run's defects landed in the report rather than in the graph, which
is the point: a dashboard state whose `current_user` / `project_list` detection was refuted
by one of its own raced readings (`detection_refuted_by_evidence`, error) was committed
*without* that detection instead of failing the whole document; effects naming semantic
paths (`login.email`) that resolve to no element id were dropped with the reason; and the
committed graph carries every one of those findings in its own `warnings[]`, so a reader of
`graph.json` alone learns what the run doubted. Two things that run made obvious are next:
`element_target_does_not_resolve` is too blunt for a dotted target with a resolvable
suffix, and `element_declared_in_several_states` repeats itself once per element per state
family, which a shared form turns into a wall of near-identical warnings.

**Proven by a live agent run, 0.1.12.** A 9-action sign-in / sign-out / sign-in walk
committed `ok: true` with no blocking gates, and the graph validates — 4 states, 3
capabilities (`enter_credentials`, `login`, `logout`) and 4 edges from 5 distinct transition
ids (1 refused as `self_loop_but_controls_changed`, 2 superseded), plus **one 6-step journey
and one honest break**: the second sign-in's `login` edge was refused because its capture
raced the page's own update, so the walk was cut there and reported as
`unusable_steps: 1` rather than being stitched together. `journey_is_a_walk` passed at error
severity (`1 journey(s) walk 6 step(s), and every step starts where the one before it
ended.`) and `reachability` passed from a *real derived entry state* — which is the check
this file used to list as impossible. The journey is an honest round trip: the fifth and
sixth steps are marked `repeat_of_earlier_step`, because a walk that signs in twice is six
steps and four edges.

The same run is also the clearest demonstration of why a bad reading is reported rather than
repaired: the harness captured the hidden login form as `visible: true` twice, so
`transition_login` carried `no_observed_change`, a `detection` on the dashboard state was
`detection_refuted_by_evidence`, and one edge was refused outright. None of that stopped the
graph committing, and all of it is in the graph's own `warnings[]`.

**Proven by a live agent run, 0.1.13.** Two documents, each fetching while it is still parsing,
served from a scratch app. The step that opened the first page recorded **both of that
document's own requests** — `GET /api/session` and `GET /api/projects`, each `200` — in
`obs_0001`, and the step that followed the Settings link recorded that second document's own
`GET /api/session`. Neither is a same-document SPA call and neither is an effect of the action
the step took: they are what the document loaded *with*, which is what gap 1 was about. That run
also demonstrates the next gap, from the other side: the graph it committed is schema-**INVALID**,
because the model wrote `"output": {"page": "settings"}` — a value where the schema requires an
`argumentValueSpec` — and neither the tool's own hint (see gap 8) nor the commit caught it.

**Proven by a live agent run, 0.1.17.** The same four-action sign-in walk against `demo-app`, and
the first run whose every claim survived the commit: `ok: true`, no gates, 2 states, 3
capabilities and 3 edges — the two fills as **self-loops** on the login state (`value_changed` on
the field it filled), and one `login` edge into
`state_project_list_authenticated_projects_one` carrying `state_entered`,
`storage_changed:localStorage.acme-demo-state`, `element_destroyed:sign_in_button` and
`element_created:add_project_button`. Four readings became two states, because the two keystroke
sightings deduplicated onto the state they were already in: gap 5's lesson applied by the model
rather than by a check. The graph validates against the normative schemas, and its only findings
are three `effect_targets_resolved` notes at `info`, where an effect named `email_input` and the
graph carries `element_email_input`.

**Proven by a live agent run, 0.1.19.** The same sign-in walk, on the release that specifies what
`state_entered`'s `to` is. `ok: true`, no gates, no refused edge, 2 states, 3 capabilities and 3
edges; the graph validates against the normative schemas; and its findings are three
`effect_targets_resolved` and three `element_declared_in_several_states`, all at `info`. The edge
carries `state_entered: state_project_list_authenticated_projects_seeded` — the state id, written
correctly on the **first** attempt, where the two runs before this one wrote a `page_type` and a
`variant` in that position and were refused. That is what the fix was for, and it is the whole of
the evidence for it: one run cannot show a negative, so the argument rests on the two 0.1.18 runs
that got it wrong and the specification that was missing.

The run does **not** exercise the other half of 0.1.19, and it is worth being explicit about why:
this walk never repeated an edge, so it produced no `superseded` decision — the row that failed
`graph_commit` outright in 0.1.18. That path was closed by reproduction rather than by a walk:
`test/tools.test.mjs` walks one edge twice and asserts the tool still returns, and reverting the
fix makes it fail with `$.decisions[0].rejection_reason is undefined`. A live run reaches a
re-walk only when a model chooses to repeat a step, which is ordinary but not obligatory, and
which is why the class of defect was invisible until a run happened to do it.

It was the third attempt at that walk, and the two before it are why the reading tools refuse.
The 0.1.15 run's report named nine findings — two detections dropped for having nothing to check,
two effects dropped for naming a path, a masked-value assertion, a state minted out of a
keystroke — and every one of them arrived at the commit, where the page each claim was about was
gone. 0.1.16 moved those questions to where the claim is made (see
[A claim is checked where it is made](#a-claim-is-checked-where-it-is-made)). The 0.1.16 run then
found the case that move left open, and it is the nastiest shape this failure takes: the click
authenticated the session, the reading that followed named the *login* state and carried the login
form's detection, and the capture of that very reading showed the dashboard. `graph_observe` took
it — an identity is the model's judgement, and a reading is allowed to be wrong — and the state
was bound to a reading that refuted its own detection. Evidence is append-only, so the refutation
was permanent: the commit graded it `error`, dropped the detection, found the state unassertable
and refused the document. A walk that drove the application correctly, and a run with nothing to
show for it. 0.1.17 asks that question at the reading as well, *before* it writes: a claim this
reading's own capture contradicts is refused, with the page that is actually in hand quoted back,
and since nothing was recorded the model simply reads again — no action has to be repeated.

**Proven by a live agent run, 0.1.20.** The sign-in walk again, and the run the review that
produced 0.1.21 was written from: `ok: true`, 2 states, 3 capabilities, 3 edges, 1 journey,
`features: []`, 7 warnings, and one assertion on the whole graph — the `login` edge's own
`current_user` check. The journey's `goal` is the instruction quoted and its `name` is that
instruction, which is the defect item 4 of the review named: a name is a handle and the run's
instruction is a sentence, so the walk was named after the operator's prompt. The graph
validates, and what it does not say is the point of the release: nothing in it claims a
feature, nothing names the walk, and the composite `login` absorbs the submitting click
without saying so.

**Proven by a live agent run, 0.1.21.** The same sign-in walk, asked for the new content and
then for the test. The graph: 2 states, 4 capabilities, 3 edges, **1 feature**
(`authentication`, claimed on every step), and a composite that now contains the interaction
that finishes it — `login.composed_of = [fill_login_email, fill_login_password,
submit_login]`, with `submit_login` recorded as its own capability *and* as the last step of
`login` in one call, which is the shape item 1 and item 2 of the review ask for and the
shape `composite_part_never_walked` reports from. `journey_name` claimed on the submit step
gives the walk its own name, `Sign in to Acme and see the projects list`, while `goal` keeps
the whole instruction; the commit reports 6 `info` notes, no warnings, and `graph_test`
generates `ok: true` with no blocking gap — 3 of 3 steps became an action.

Three things only a real run could have produced, and all three are in the record: the first
two changed the code, in 0.1.22 (see gap 14), and the third needed no change.

- **The generated spec filled the password box with the literal string `[redacted]`.** The
  store had written `[set]` — the recorder read the field back and that is what it found —
  but the model transcribed its own placeholder into `arguments`, so the generator, which
  believed the argument, wrote a test that fails for a reason that has nothing to do with the
  application. The reading is the party that observed the value, so the reading now wins, and
  the disagreement is a warning rather than a silent repair
  (`argument_disagrees_with_the_reading`). This is refusal 3 rewritten as a rule with a
  counterexample behind it, and it is the reason there is a 0.1.22: the run that found it
  found it in a spec this plugin had already written.
- **The journey's `goal` was `Open http://127.0.0.1:4173/ in the browser, sign in with the
  credentials the page shows, and`** — a quotation of the instruction that stops mid-sentence
  on the conjunction it needed. The rule said "the first sentence"; the code took the first
  *line*, and this instruction is hard-wrapped, so the goal ended at the margin. 0.1.20's
  instruction happened to be one line. A line break is not punctuation, and it no longer
  counts as one.
- **The first generation was blocked, and the block was right.** `collection_has_no_usable_locator`:
  the `projects` dimension could only resolve to `element_project_item`, a row with no
  locator a browser can act on, so the count check had nothing to count. Declaring the
  container the evidence already showed fixed it. What remains is a warning this release
  deliberately leaves in place: the dimension name matched two elements, so the count check
  was dropped rather than guessed at, and the spec carries one check where the graph had two
  candidates.

**That run's own graph, regenerated under 0.1.22.** The spec now reads
`fill(process.env.TEST_PASSWORD!)` where 0.1.21 wrote `fill("[redacted]")`; the gaps are
`argument_disagrees_with_the_reading` and `dimension_could_be_more_than_one_element` at
`warning` and `persistence_evidence_not_asserted` at `info`; selection reports `matched_by` as
`the journey name "Sign in to Acme and see the projects list", exactly`; and
`goalFromInstruction` on that 9-line instruction returns `Open http://127.0.0.1:4173/ in the
browser, sign in with the credentials the page shows, and record what you find.` — the sentence,
where the recorded graph has the margin.

**Known gaps, in the order they will bite:**

1. **Closed in 0.1.13: a document is observed from its first byte.** The hooks used to be
   installed by `browser_eval`, which is document-scoped, so a full navigation discarded them and
   the requests that loaded the new document were lost — for the first navigation of a run, that
   meant the entry point itself. They are now installed before the document runs. One file,
   `lib/page-hooks.js`, is the collector either way: the local `dsh-browser` patch
   (`scripts/patch-dsh-browser.mjs` in the repo root) copies it into the profile's `init.d/`,
   and the patched browser installs it on every new page with `addInitScript`; `browser_eval`
   still embeds the same bytes, as the fallback for a document the patch did not reach and as
   the re-installer after a navigation. Two consequences worth knowing:
   - **A request is recorded when it starts, not when it completes.** The request that loads a
     document is usually still in flight when that document settles, so waiting for completion
     would file it under the *next* step, where it reads as an effect of whatever action came
     next — a worse falsehood than not recording it.
   - **The capture reports `hooks_installed_at`** (`document_start` or `after_load`), and the
     first observation of a run reports the `entry_document` — its URL, its title, its timing,
     and the requests it loaded with. Without the marker, "this document made no requests" and
     "we started watching after it had already run" are the same empty list.
   The patch is what makes this real, and it is required rather than optional: `dsh-browser`'s
   `Config` has no key for an init script. Unpatched, the hooks still arrive by eval, and both
   the marker and the empty list say so honestly instead of claiming the document was quiet.
2. **Some rules are judgement, not proof.** `feature_closure` is reported rather than
   enforced (and since 0.1.21 `features` has a source at all — see gap 6), and
   `reachability` is a warning
   as well — but for a different and narrower reason now. Since 0.1.12 it floods from the
   derived journey start states, so it is a real check that *passes* on a real walk (the
   0.1.12 live run above); it stays a warning because a walk that avoided a state is not
   evidence that the state is unreachable. It reports three things separately: states not
   reachable from an entry, states with no outgoing edge and no walk ending there
   (stranded), and where the walks stop — the last being where a sample ends, not where the
   application does.
3. **A journey is a walk, not a goal.** Assembly is mechanical and now done (see
   [Journeys are derived, not decided](#journeys-are-derived-not-decided)), so this gap is
   only half closed: `journeys[]` carries the order the steps were taken and a `name`
   derived from the endpoints, but nothing in a browser session says *what was being
   attempted*, so `metadata.extra.goal_stated` is `false` and `criticality` is left to the
   schema default. Closing the other half needs a model that says what it was trying to do,
   i.e. a `goal` on the journey rather than a derived name.
4. **State ids grow without bound, and two long ones can collide.** Every dimension the
   model chooses is concatenated
   into the id, so a field value can end up in one, and a derived journey id inherits the
   whole thing:
   `journey_login_anonymous_auth_signed_out_to_login_anonymous_auth_signed_out_form_cre`
   is one real 0.1.12 id (the slug is cut off at a length budget). The dimensions are the
   model's to choose and they are all real, so the fix is a budget (a limit on dimensions,
   or a hash past N) rather than a check — and the same budget wants to apply to derived
   journey ids, which are built from two of them. The budget that exists is `slugify`'s
   40-character cut, and it is a cut rather than a distinguishing device: two identities
   that agree for forty characters get the same id, which the store then treats as one
   state. 0.1.21 gave the symptom a second surface rather than a fix — the generated spec is
   filed under the journey's id, so the 0.1.21 sign-in walk named its file
   `journey_login_anonymous_to_project_list_.spec.ts` (cut mid-word, with the separator the
   cut landed on still on the end), and a second journey differing only past the cut would
   overwrite the first. Trimming that trailing separator is not a fix either: it would make
   `slugify('a…a b')` and `slugify('a…a')` the same id, which is the collision the cut is
   already risking, arrived at deliberately.
5. **Closed in 0.1.16: element state can outrank state identity.** The half the machinery can
   do without making a judgement call is the half that was missing — not *is this a state?*
   but *what changed?*. The note names the previous state, the step's `value_changed` effect,
   and the self-loop that was meant instead: `identity_read_from_element_state`, carried by
   `graph_observe` in the reading's `reading_notes` **and** on the edge that records the step,
   so the commit reports it (`warning`) and a reader of the run learns it too. The protocol
   now says the same thing where the model reads it — *"a form with a value in it is the same
   state as the form without it"* — and the `dimensions` parameter description asks what the
   application would say, not what the user typed. What is still the model's call is whether
   the two readings really are one page; the note declines to make it, and reports instead.
6. **Closed in 0.1.21: `features` has a source.** `application` is declared in config (see
   [Configuration](#configuration)), and `features` was the other judgement about the app's
   own structure that nothing could observe — the 0.1.20 live runs committed
   `features: []` however many pages they walked. It is now a `feature` argument on
   `graph_transition`: the words a step names, reused verbatim, and the commit assembles
   `features[]` from the capabilities, states, transitions and journeys that claim one,
   with the provenance in `metadata` (the schema's `feature` object has no field for it and
   `additionalProperties: false`). Optional in the schema still, so a run that names no
   feature commits a valid graph with none — but the protocol now asks for the words, and
   the parameter description says why they are the model's to supply. What remains open is
   not the source but the *shape*: whether the set a run names for one application is
   discriminating enough to be useful is a judgement no check here can make, which is why
   `feature_closure` is still a report.
7. **Closed in 0.1.12: there *is* an entry state.** This file used to claim that
   `graph.schema.json` has no field saying where a journey starts, and that the fix belonged
   in the schema. That was wrong, and the check it excused was worse than useless: it
   reported *every* state in a committed graph as unreachable. `graph.schema.json` has a
   `journeys[]` array, and `journey.schema.json#start_state` is the entry state —
   *"State the journey assumes as a starting point. Derived from the first transition when
   omitted."* The missing piece was never the schema, it was the plugin: nothing assembled a
   journey from the walk it had already recorded. It does now, so `journey_is_a_walk` and
   `reachability` are both real checks against a real entry state. What remains is only the
   limitation in gap 2 — an entry state derived from a sample answers *what this walk
   reached*, not *what the application can reach*.
8. **Closed in 0.1.16: `capability_output` is checked, and its hint is right.** Found by the 0.1.13
   live run above, which committed an invalid graph and reported `ok: true`. The tool's parameter
   was `{type:'object', additionalProperties:true}` and its description read *"What the capability
   yields, e.g. `{"discount":"number"}`"* — but `capability.schema.json#/properties/output` is an
   `argumentValueSpec` map, so the correct form is `{"discount":{"type":"number"}}`. A model
   following the hint wrote a value where a spec belongs, and nothing between the tool call and
   `graph.json` checked it. Both halves are fixed: the hints and the parameter descriptions show
   both forms, and `graph_transition` now validates `capability_input` and `capability_output`
   against the same rule the schema uses — a bare type name from the closed set, or an object
   whose keys are the ten the schema allows (`additionalProperties: false`, which is exactly why
   `{"password":{"type":"string","sensitive":true}}` was accepted here and refused there). The
   refusal names the offending key and the ten that are legal, and it fires **before**
   `store.addCapability`, so the vocabulary never learns a signature the schema would refuse.
   *Closed in the ABM pivot:* the half that was still open was the general one — the **assembled
   document** was not validated against the normative schemas before the result was called `ok`.
   Both documents are now checked before anything is written (`lib/validate.js`, and the `documents`
   section of the report — see [The two documents](#the-two-documents)). A document that does not
   validate is never written, not even under `force`, and it never leaves `report.ok` true: the
   graph's failure is a `graph_does_not_validate` blocker, the model's is a `model_does_not_validate`
   entry in `documents.model.blockers[]`. That is the class rather than the field, which is what the
   0.1.16 fix could not be — a projection with a `realization[].action` outside the enum is exactly
   the kind of defect that shipped twice.
9. **A repaired log is the tail of the run, and nothing says so on disk.** Found while
   closing the store's write path (0.1.14): when `graph-run/` is deleted mid-run, the store
   recreates it and carries on, which is right — but the new log holds only what came after
   the repair, while the restored `run.json` still describes the whole run. `graph_commit`
   reads that tail and has no way to know it is a tail, so the graph it commits can be the
   second half of a walk looking exactly like a complete one. The digest reports
   `directory_recreations` and a model following the protocol can say so, but nothing in the
   files carries it and no gate blocks it. Two candidate fixes, and the choice is a policy
   call rather than a coding one: refuse to continue after a recreation (the option the store
   deliberately did **not** take, because it turns a recoverable interruption into a dead
   run), or record a log epoch the commit can see — which needs a decision about whether a
   multi-epoch run is refused or committed with the break in its warnings, and would put a
   fact in `run.json` that its "written once, never rewritten" rule currently forbids.
10. **Mostly closed in 0.1.18: a reading whose controls share nothing with its state's other
   readings is refused where it is made.** Found by the 0.1.16 live run, and only half closed by
   the refusal that run bought: a detection is checked against the capture of *its own* reading,
   so a claim the page contradicts is caught — but a reading whose detection is a `url` assertion
   on a single-page application holds at every reading, and `variant` and `dimensions` are the
   model's words, never compared to the page at all. An action that moved the screen without
   moving the URL could therefore still bind a reading to the state it had just left, and evidence
   being append-only, the binding could not be withdrawn. The invariant it needed is the reading's
   **interactive surface**: values, messages, counts and storage all change within one state —
   that is what makes them effects — while the controls are what the state *is*. `graph_observe`
   compares the controls of the reading being made against the controls of every reading already
   bound to the identity it names, and refuses when the two have nothing in common, quoting both
   surfaces and naming the `dimensions` entry that would make it a state of its own instead. Which
   reading is the wrong one is still the model's judgement; what the machinery contributes is that
   it can *see* two screens where the model is looking at one. The residual is the bluntness, and
   it is deliberate: *how much* may two screens differ and still be one state is the application's
   answer, not the machinery's, so the rule fires only on "nothing in common at all" and two
   readings that share a single control go unremarked — a partial surface change is still
   unaudited, and a threshold that could tell such a case apart would be invented here rather than
   in the application. The commit keeps the same finding as a backstop, for a log written before
   this rule or a reading whose surface was empty when it was made.
11. **Closed in 0.1.19: a tool's return value is checked for lossless JSON, and the check names no
   field.** Found by the 0.1.18 live runs above, as `tool "graph_commit" returned invalid output:
   value is not lossless JSON` — the whole tool call, refused, with nothing in it to read. The
   harness walks a `{type:'json'}` tool's raw return value (not the rendered text: `JSON.stringify`
   would have dropped the offending field silently and hidden this) and refuses the call when any
   part of it would not survive a round-trip. `undefined` is what a value usually is when that
   happens, and there is no path named in the error, so the model's only recourse is to retry the
   call that just failed. The trigger here was narrow and entirely ordinary: walking an edge twice
   makes two candidates for one transition, the loser is a `superseded` decision, and the row for it
   was pushed without `rejection_reason`/`rejection_basis` while the winner's row carried them as
   explicit nulls — so the projection copied absent fields into a row every reader has to
   special-case, and `undefined` travelled into the tool's return. The fix is on both sides of the
   promise: the reconciler pushes every row of the one `decisions[]` table with the one shape, and
   the projection coerces each nullable field at the point where the tool declares what it returns.
   That second half is not a licence to hide reconciler bugs — a report with a null in it is worse
   than a report with the truth in it, and the null is exactly what would hide one. Which is why the
   table's *shape* is asserted where the table is built, in `commit.test.mjs`, and not here: what the
   projection promises is the narrower thing it can promise, that a report the reconciler did produce
   arrives at all. The alternative on offer was no report.
   The class of bug is not closed — nothing validates a tool's output *shape* before the harness
   does — but the seam that hid it is: `test/lossless.mjs` states the harness's rule as a list of
   offending paths, and the suites now walk a re-walked edge through the tool and assert the call
   still returns.
12. **Closed in 0.1.20: six seams between what a walk recorded and what a graph can carry.** All
   six were found by reading the two live runs above against the normative schemas, and they share
   one shape: a fact the machinery already had was dropped at a boundary, so the loss surfaced in
   `graph.json` as a graph that was *wrong* rather than as a refusal that was not. Each closure is
   small. The list is here because the next reader will want to know which part of each is still a
   judgement call rather than a check.
   - **The run's instruction is captured.** `journeys[].goal` was always absent because nothing ever
     read the intent off the harness. It arrives on `agent/pre-step` before the first action, it is
     written to `run.json` once, and the commit quotes it (see
     [Journeys are derived, not decided](#journeys-are-derived-not-decided)). What remains the
     model's is which journeys the one instruction names — until a run is asked to do several
     things, it is the run's name and not each strand's.
   - **A state's fingerprint comes from its own readings, and the pair rule is asked of that.**
     `identity` is the model's word for what a state is; the fingerprint is what the readings say it
     *looks* like (`routes`, `surface_size`, `forms`, `storage_keys`, `session_storage_keys`,
     `cookie_names`), carried as `metadata.extra.observable`. Two committed states with equal
     fingerprints are reported by `state_indistinguishable_from_another` — a `warning`, never a gate,
     because whether two screens *are* one state is the application's answer. The digest also offers
     the key names a page carries without showing them, since those are part of what tells two
     screens apart and no screenshot shows them.
   - **A composite capability says what it is built from.** `capability_composed_of` takes the
     *names* of the behaviours a composite is made of, resolves them against the vocabulary that
     already exists, and lands as `composed_of` on the capability itself. A later call merges onto
     the capability rather than writing a second one beside it, and the kind travels with it, which
     is what tells a generator to expand a behaviour rather than treat it as a single action.
   - **An element several states declared is reconciled by the evidence.** Element ids are unique
     across all states (`§14.1`), and a purpose declared twice used to be settled by arrival order —
     which is not evidence. It is now settled by which declaring state's own reading shows the
     element, and the tri-state is what carries the meaning: a reading that *refutes* the declaration
     ranks below one that is silent about it, and silence ranks below a reading that shows it. So a
     state that saw the element keeps it over a state that merely did not look, and only a state the
     evidence refutes is reported (`element_declaration_refuted_by_its_reading`). What is still the
     model's: which reading is the wrong one when both are silent.
   - **A variable a step moved is reported, and so is a dimension nothing can read.** The schema has
     no `variables` and no `predicates`, so the only way to hold a value the application remembers —
     a cart count, a filter, a draft — without exploding into one state per value is
     `identity.dimensions` (the word) plus a `value` assertion in `detection` (what reads it). The
     digest's `state_variables` names the variables the walk's own effects moved, which is the moment
     the question can be answered, while the page that shows the change is still in hand. The commit
     reports `state_variable_not_in_state_identity` for a variable neither endpoint records as a
     dimension, and `state_dimension_not_asserted` for a dimension no detection entry can read. Both
     are `info`, and both are that way round on purpose: a graph is allowed to be less discerning
     than it could be, and only the model knows whether the difference deserves a word.
   - **What a reading called is in the graph.** The endpoints of a step came from the model's `apis`
     argument or from nothing at all, so a walk could claim no endpoints while its own request log
     showed three. They are now derived from the capture at each end and recorded separately from
     what was declared — `apis` on the edge is the union, `apis_declared` and `apis_observed` say who
     claimed what — and the report counts the endpoints no step referenced, because an endpoint the
     run called and the graph never mentions is a behaviour the graph cannot generate.
13. **Closed in 0.1.21: the graph can be turned into a test, and the two halves of the run
   that only a model can supply now have somewhere to go.** Item 12 closed six seams in what a
   walk *records*; this closes the seam on the far side — a graph that is complete and
   correct is still not a test, and the step from one to the other is where a third of the
   review's findings lived. `graph_test` generates a Playwright spec from `graph.json`
   alone (see [Generating a test](#generating-a-test)), which forced four rules out into the
   open that were previously implicit: **locator ranking** (role and accessible name over the
   test id over the raw selector, with a non-control role falling back to what the run
   recorded, because `getByRole("generic", …)` matches everything); **journey selection**,
   which refuses an ambiguity instead of resolving it, with `matched_by` saying how it chose; a
   **dimension asserted as a count of the rows the reading counted** (`li,tr,…` — the same
   selector `capture.js` counts with, so the generated check counts the same things the
   evidence did); and a **refusal list** that is not the error list — a storage key, a
   non-actionable element, an invented value.

   The same release teaches the protocol the content the review asked for and the machinery
   could not produce: `journey_name` (without it a journey keeps the run's whole instruction
   as its name and goal, which *is* the 0.1.20 bug — the generator then has to shorten a
   sentence back into a title, and `journeyNameFromGoal` does it by cutting at the first
   parameter and trimming only the connectors that cut left dangling), `feature`, and the one
   composite rule whose absence was visible in the live graph — a composite that absorbs the
   interaction that finishes it. `login` recorded as `composed_of: [fill_login_email,
   fill_login_password]` with the submitting click folded into it is a claim the walk does not
   support, so the protocol now says to record the click as its own capability **and** a step
   of the behaviour in the same call (`capability_behaviour: "login"`), and the generator
   reports the mismatch when a graph says otherwise. Two of the review's nine items were
   content rather than machinery — `cap_submit_login` existing, and `cap_login.composed_of`
   naming it — and the 0.1.21 live run produced both, on the first attempt, with `feature`,
   `journey_name` and the composite step supplied in the same call as the click; see
   [What this proves, and what it does not](#what-this-proves-and-what-it-does-not). The
   protocol was the fix: no check could have derived `submit_login` from a walk that recorded
   the click as `login`, and a run that still does not produce it now ends in a warning
   naming the missing step instead of a test that clicks a form and checks nothing about it.
14. **Closed in 0.1.22: the two things the 0.1.21 live run found, found by reading the spec it
   generated.** Item 13 shipped a generator and a protocol; the run then produced a graph that
   was right and a spec that was wrong, which is the only way this pair of defects could be
   found, because both of them are the *same shape*: something else the model wrote, believed
   instead of the machinery's own reading.

   **The argument is not the value.** The capture reads a field before and after an action and
   files the second reading, so a password the store redacted appears in the step's effects as
   `to: "[set]"` no matter what the model typed into `arguments`. `[set]` means *the recorder
   saw a value and is not keeping it*, and a model that writes `"[redacted]"` or `"***"` or
   anything else into `arguments` has not kept it either — it has written a placeholder, and a
   spec built from the model's words fills the box with that placeholder. So when the two
   disagree, the reading wins: the value becomes `process.env.TEST_<PURPOSE>` like any other
   withheld value, and the step carries a `warning` naming both sides
   (`argument_disagrees_with_the_reading`). It fires on the *disagreement* rather than on the
   redaction, so a run that writes `[set]` into the argument — or writes nothing — stays
   silent, and the graph is left exactly as the model committed it: this is a rule about what
   a spec may assert, not a correction of the graph. `withheldByEvidence` resolves the effect
   to the element by id or by collection name, so an effect targeting `password_input` and an
   element whose purpose is `password` still match.

   **A line break is not punctuation.** `goalFromInstruction` took the first *line* of the
   instruction, and the 0.1.21 task was hard-wrapped, so the journey's goal ended `… the
   credentials the page shows, and`. 0.1.20's instruction was one line, which is why the rule
   looked correct for a release. It now joins the lines first and takes the first *sentence*,
   still cutting at a parameter and still clipping at a word boundary with an ellipsis.

   Both are pinned. `test/generate.test.mjs` has six checks on the reading-over-argument
   rule (the override, the report, what the step says it believed, the id-shaped match, the
   silent case, and an effect on a *different* field, which must not override anything), and
   `test/commit.test.mjs` has one on a wrapped sentence and one on a goal that is clipped
   rather than left a fragment. `test/prove-generate.py` breaks each rule in the source and
   requires the suite to fail — nine rules, including these two.

15. **Superseded, not closed: the `composite` reading item 13 taught.** Item 13's fix was content
   in the protocol, and it worked — the 0.1.21 run produced `submit_login` as a behaviour *and* as
   a step, which is what the graph needs. What the later runs showed is that asking the model to
   choose between two kinds of capability is a question with no wrong answer and therefore no
   stable one: the dial-in run recorded a three-call sign-in as three capabilities in a row, all
   of them "a behaviour". The direction this repo is moving in replaces the question rather than
   answering it again — an interaction is a *step* unless a user would ask for it by name, and the
   behaviour it serves is named on the same call (`capability_behaviour`) — so the
   `capability_kind: composite` clause is **gone from the protocol**, and `composed_of` is for a
   behaviour genuinely built out of other behaviours. The generator rules above are unaffected:
   `composite_part_never_walked` and `composite_step_targets_a_different_element` are about what a
   document says, and both still fire. See [`docs/abm-pivot.md`](../../docs/abm-pivot.md), which is
   the plan these changes are being made under; the item is marked superseded rather than closed
   because its *symptom* — a model that names mechanism where the product has a word — is the thing
   the new protocol is meant to remove, and a live run under it is still owed.

## Tests

```sh
npm test        # 15 suites, no browser and no harness
```

The protocol gets a suite of its own, `test/protocol.test.mjs`, because the section is the only
place a behaviour-first reading can be *asked* for — no tool schema can require one, since the tool
that records a step takes the same call whichever reading it came from. It renders the section the
way `apply()` does and pins **79** claims: the section's name and order (150), the rendered text
equal to `protocolText(...)` for the live config, the reading that comes before the walk, the
step/behaviour/edge definitions, the absent composite clause it replaced, the affordance bullet's
deliberately missing `confidence`, all fifteen refusal sentences **verbatim one by one**, the
absence of any `{{…}}` in the text (a section is a prompt template, so an unregistered variable in
one is a boot failure rather than prose), and the
seam to the tools — every argument `graph_observe` and `graph_transition` declare is either named in
the loop or on one spelled-out exemption list, which is itself guarded against a rename silently
widening it. Its matchers collapse whitespace: the section is wrapped prose, so a needle written on
one line otherwise asserts the wrapping instead of the sentence.

`test/package.test.mjs` is about the **package** rather than the code, and it earns its place from
the first defect that reached a deployed profile and no suite in this tree could see: `files` did
not name `schemas/`, so 0.1.24 shipped the reader and not the directory it reads, and a deployed
`graph_commit` would have answered *the schema set could not be read* and written **neither**
document — reported as a bad document rather than a bad package. Every suite here runs in the source
tree, where `schemas/` is present whether or not it is published, so the suite **derives** the list
instead of trusting a second hand-kept copy of it: it scans `lib/*.js` for the paths the module
reads relative to itself, requires every read that leaves `lib/` to be covered by `files`, walks
every `files` entry to check it exists, and checks that `main`, the `cordis.patch.yml` export and
the `dsh.bundle.patch` contribution point are all published. A read of a new directory therefore
fails until the manifest names it.

Two harnesses are opt-in, never part of `npm test`, and the reason is the same in both cases — they
need a run directory this repo does not ship:

| Script | What it answers |
| --- | --- |
| `npm run prove:schema` | Validates a committed document against the normative schemas with `ajv` (outside the repo, so `npm test` stays dependency-free) |
| `npm run profile:abm` | Profiles a real run's projection and refuses it for the reason the pivot exists |
| `npm run profile:protocol` | The Phase-3 acceptance: reads a run's **log** and answers the four questions it can answer there |

`profile:protocol` measures the log rather than the document for a reason worth stating: the
projection *demotes* a capability that is a step of a behaviour, so a step never becomes a behaviour
in `application-model.json` and a rule about the behaviours in the model has nothing to count there.
Its four verdicts are: no capability recorded with no behaviour attached; every step of every
behaviour recorded as a realisation; every realisation naming the browser action and the step's
purpose; and every edge resolving to a capability the run recorded. **A verdict with nothing to
check prints `n/a` and is left out of the tally** — a green result is evidence of a positive and
never of a negative — so a run with no realisations in it reports that fact rather than passing.

**The acceptance on live evidence, 2026-09-18 (0.1.26):** `4 capabilities (1 behaviours, 3 steps, 0
unattached)`, `3 realisations (3 described — verbs fill, fill, click)`, `3 edges`, `login 3/3 steps
realised`, all four verdicts `ok` — `ACCEPTED`. The two things that run also showed, both of them
about the *abm* rather than the protocol and both left standing rather than papered over: it
committed a valid `graph.json` and **withheld the application model**, for an unobserved argument
(`P5`) and for two committed calls the collapse did not carry (`P12`). The `P12` pair is a recorder
defect that a live run was the only way to find — this section tells the walk to put the acted
element in `realization.element` and never names `target`, while `action.target` is what both
`graph_test` and the ABM read, so every transition of every live run says it acted on nothing and
the generated spec cannot perform the walk. That was **fixed in 0.1.27**: a `graph_transition` call
whose step names an element is recorded acting on it, a call whose `target` and whose step name two
different controls is refused above the first write, and where the id came from is reported as
`target_from_realization` at `info` — because a step's `element` and a transition's `target` are one
element id in two places, and `info` says nothing was inferred. The protocol now says so, and says
what a redacted field is recorded as (`"[set]"`), which is the `P5` convention the rule enforced and
the prose never stated.

**And then the corrected spec was run, which nothing up to 0.1.27 had ever done.** That live sign-in
walk recorded all three edges acting on their controls (`element_email_input`,
`element_password_input`, `element_sign_in_button`) while the transcript shows the walk never passed
`target` — the value is the recorder's — committed `blocking: []` with
`documents.model.written: true, valid: true` and three `target_from_realization` notes at `info`,
wrote its `application-model.json`, and passed `protocol-coverage`'s four verdicts. The generated
spec then performed the walk: `goto("/")`, `Email.fill("test@example.com")`,
`Password.fill(process.env.TEST_PASSWORD!)`, `Sign in.click()`, three assertions. Run under real
Playwright against the demo app: **`1 passed (1.7s)`**. One run, one journey, one spec — evidence of
a positive, and the first time this project's output has been shown to *do* anything.

**A 0.1.28 run on a different walk then found the next one, in the same class.** Its edges name
their controls too (`target_from_realization` three more times, `protocol-coverage` `ACCEPTED`
again), but its `application-model.json` is **withheld**, and the blocker is new: `P5` /
`unbound_parameter`, twice — *"realization[0] binds {{email}}, which is not a declared input of
\"login\" (declared: none)."* The walk wrote `{{email}}` and `{{password}}` into the steps' values
and **no capability in that run declares an input**. This section offers the template — *"`value` is
a literal or a `\"<param>\"` template bound to the behaviour's input"* — and never says that writing
one obliges you to declare the parameter: `capability_input` is documented on the tool, not in the
orders the walk reads first. So the walk was offered a spelling and not told what it costs, `P5`
correctly refused the document, and the fix is a sentence here rather than a weaker rule — **fixed in
0.1.29**: the section now says that a template is a parameter the walk has to declare, where the
declaration goes and why that is where, that the refusal costs the whole model rather than the step,
and that writing the literal the page was given is the way out. It also stops printing a spelling the
machinery does not read — `placeholdersIn` matches double braces, so the `<param>` the section used
to offer would have been typed into the field verbatim.

**A sixth defect came out of that same run, and it is in the one sentence a person has to act on.**
The instruction above the spec read *"Set [object Object] before running it"*: `requires` holds
records (`{env, element, purpose, reason}` — the reason is what a person reads before exporting a
secret), and the list was interpolated into the sentence instead of the names being read off it.
Fixed in 0.1.28 by moving the sentence into `lib/generate.js` as `requiresInstruction(requires)`,
where a suite can see it — `generateTest`'s return carries no `next`, so the tool-level sentence was
unpinnable until it moved. Prose that no suite can see is prose that rots.

**The 0.1.29 run is where that seventh fix was proved, and where the next two defects came from.**
Its behaviour takes `{email, password}` as its input with **no input declared anywhere in the run** —
the union rescue read them off `cap_fill_login_email` and `cap_fill_login_password`, which is exactly
what the new sentence tells a walk to depend on — the walk wrote `{{email}}` and `{{password}}` in the
double braces the section now names, and there is **no `unbound_parameter` at all**. Under 0.1.28
that same walk shape produced two blockers; under 0.1.29 it produced none, and the fix is the
sentence. What withheld the model this time was a *different* refusal, and a fair one: the walk
filled the email and then put `{"email":"test@example.com"}` on the **click** that followed, and
`P5/unobserved_argument` refused the document, because no effect of a click reports the email. The
rule is right — what the section had never said is that it is **per edge** (each argument is read
against *this* transition's effects and *this* step's own observation), so a walk holding a value and
offered two fields that take one had no way to choose. Fixed in 0.1.30, in prose, in the section and
in the `graph_transition` schema.

**And the same run had one log read two ways.** Its walk re-recorded an edge to correct itself, which
the log keeps correctly as two `realization_step` records for one `capability_id`/`transition_id`
pair. The commit's own assembly folds the pair and keeps the newest walk; the behaviour profile's
reader did not — so the shipped model performed the click once and the profile performed it **twice**,
naming a different `storage_changed` target each time (`acme-demo-state` and
`localStorage.acme-demo-state`). Also fixed in 0.1.30, by moving the rule into one function both
readers import.

What that run did *not* settle is whether a wrong `arguments` can be retracted: re-recording the edge
did not clear the finding, and it split a second one-step journey strand. The protocol's commit step
tells the walk that evidence is allowed to be wrong, so this is a machine instruction that cannot be
acted on — a defect by the same argument as the two above. It was left open rather than guessed at,
and it is the question the last story in this section answers — with that run's own log as the
witness.

**The 0.1.30 run then wrote the model — the first live run whose `application-model.json` is both
written and valid — and found the defect that says most about where the pivot still is.** Its walk
recorded the email as the step's `value`, the spelling the section asks for; the graph's transition
shape carries `arguments` and has no `value`, so `transition_fill_email`'s action is
`{"capability": "cap_fill_email", "target": "element_email_input"}` with the email nowhere in it. The
generated spec dropped that step with a blocking `step_has_no_value_to_type`, correctly refusing to
invent a value — and the result would not sign in, while the next step's password generated fine
because the walk had put that one in `arguments`. A document the model writes that the generator
cannot read is the pivot described rather than performed, and the reason is stated in the acceptance
sentence of Phase 4: the spec is to be written from `realization[]`, which keeps the `value`.

**Reading that model rather than the prose about it found one more defect, and in the document the
pivot exists to produce.** `application-model.json`'s `journeys[0].steps` named
`transition_submit_login` **three times** while the very same edge's
`metadata.extra.collapsed.invocations` said `1` and its `collapsed.calls` listed the three calls the
behaviour was made of. The projection remapped each *call* of the invocation onto the edge that
absorbed it, and every one of them became a turn of the walk — so the document told its reader the
behaviour had been performed three times, one line above the field that said once. A turn of a
journey is a **move**, a move is an **invocation**, and the calls an invocation was made of are the
behaviour's own `realization[]`, which the document already carries; naming them again as turns is a
second place to say one thing, which is the shape D5 exists to prevent, reached from the other side.
Fixed in 0.1.31, keyed on the invocation rather than the call — because the other direction is a
rule too, and it is the one that bites the other way: a walk that signs in, leaves and signs in again
performed two moves, and keying on the behaviour alone would collapse them into one turn while
`invocations` said two. The same disagreement, opposite sign. `graph.json` had it right all along —
its `journey.transitions` lists the three *calls* — which is worth saying, because the graph is
supposed to be the lossy one.

**The next live run was of the released version, and it found one more — in the one place the
acceptance sentence does not reach.** 0.1.32 was packed, deployed to both profiles and walked against
the demo app. The walk recorded the password step the way the orders tell it to,
`{action: "fill", element: "element_password_input", value: "{{password}}"}` with `password` declared
on the capability, and the generator read that `value` as *the* value and quoted it:

```ts
await page.getByRole("textbox", { name: "Password" }).fill("{{password}}");
```

Every action still traced to a `realization[]` step — the acceptance held — and the *value* was
wrong, with the document right. `[set]` and `{{param}}` are the same fact recorded by two parties,
and only the first had a rule under it: the fixture was written with `[set]`, which is the spelling
the earlier runs happened to produce, so the rule looked tested and half the vocabulary was never
exercised. **A rule whose fixture only ever spells it one of the two ways the schema allows is a rule
tested against the runs that have already happened.** Fixed in 0.1.33, with a case for each spelling
and three mutations to prove they bite: a value that *is* a `{{param}}` template becomes
`process.env.TEST_<PARAM>!` plus a `requires[]` entry, in either document, and only a whole value
counts.

**And the same run read the other way is the pivot's argument, on one log.** The graph reading of that
walk drops the email step with a blocking `step_has_no_value_to_type`: the walk put the email on the
step's `realization` **and** on the effect the capture read back, while the graph's `arguments` never
carried it, so the graph has no value to type and says so rather than inventing one. The model
reading writes all three actions, from the value the walk recorded. That is D1 in the direction the
pivot intends — the graph is the lossy projection, the model keeps what the walk recorded — and it is
why both documents are still written on every commit.

**The question that run left open is answered in 0.1.34, and its answer is that a step is a pair.**
A step is identified by the edge it moved along *and* the two readings it was made from, so stating
one step again — the same capability, the same two readings, before the next action — is the walk
saying that step again: no step is added, the walk does not move, and the later statement is the one
the walk means. That is what makes a wrong `arguments` retractable at all, and it needs no new tool
and no retraction verb: the walk says the step twice and the second account stands. The first stays
in `transitions.jsonl`, because the log is append-only and a mistake beside its correction is what
makes the exception an exception; the report lists it as `superseded`, with a reason that says the
step was *stated again* rather than merely repeated. It also cannot cut the walk it is standing on:
a restatement names the state its step started from, which is never where the walk stands, so
reading it as an ordinary step reported a discontinuity that never happened — and that is what turned
one corrected step into a second one-step journey.

**The fix is proved on the run that found the defect, and proving it that way is what caught the real
bug.** The 0.1.29 log was replayed through the new commit; the first replay *did not take the
correction*. The rule was in the recorder, the record carried the recorder's own `restatement` field,
and the commit still read the two statements as two steps and refused the model exactly as 0.1.29 had
— because the commit's reader is stateless and the log was written before the rule existed, so there
was no field on it to trust. **A written field is a note, not evidence.** The rule now lives in one
exported function that both readers ask, and the commit derives which records are restatements from
the records themselves: one edge, one pair of readings. Replayed again, the same log gives three
committed edges, `superseded: 1` with the restatement reason, one journey, no breaks, no errors, and
`application-model.json` written — the run that produced the defect, commuting under the rule written
to answer it.

**And reading that replay's model rather than its report found one more, one document further along.**
The corrected edge carried no `arguments` and the journey step naming it still did: the projection
remaps an absorbed call onto the edge that carries it, and it was keeping the *call's* values on the
*turn*. A turn is a turn of the edge it names, so a turn saying the invocation carried an `email`
while that edge carries none is the same claim the graph had just refused, arriving through the
journey — two documents disagreeing about one edge, which is the defect the pivot is against. The
turn's `arguments` are now the turn's edge's arguments, and nothing is lost with them: the value is on
the call's own edge, where the walk recorded it, and the model's `realization[]` still carries the
parameter a spec is generated from.

**A fresh live walk under 0.1.34 was made, and the honest reading of it is that it does not exercise
the fixed path.** `~/tmp/live-034` is 0.1.29's own task, run against the *deployed* 0.1.34: `ok: true`,
no gates, `candidates: 3, distinct: 3, committed: 3, rejected: 0`, **`superseded: 0`**, one journey
assembled and three steps walked with no breaks, eight `info` findings and not one rule finding, both
documents written and schema-valid, one behaviour with three realisations, one edge and one journey
turn — and a spec generated from it. But `transitions.jsonl` holds three records, three is all there
are, and all three carry `restatement: false`: **the walk never stated a step again, so this run cannot
be offered as evidence that the restatement path works live.** A live run is evidence of a positive,
never of a negative, and the earlier form of this same honesty is the 0.1.19 note — *the live walk
never repeated an edge.* What the run does show is the rule that made a correction unnecessary: each
value landed on the call that typed it, `email` on the email fill's own edge, `[set]` on the password
fill's, nothing at all on the submit edge — where 0.1.29 put an `email` on the submit edge and needed a
second statement to take it off. Whether a *live* correction happens is a property of the task rather
than of the rule: the demo app's success path clears the password field, so a pre-submit re-observe
differs from its own reading and nothing forces a restatement; what forces one is the refusal — sign in
with a wrong password, read *Invalid email or password.*, correct it, submit again. Recorded as such
rather than chased.

**The fix was then read by the artifact that ships it, not by the working tree.** The 0.1.29 log,
untouched and written by a version that knew nothing of the rule, was re-committed through the package
installed in a profile — `~/.dsh/profiles/graph/node_modules/@webtestagent/dsh-graph-explorer`, whose
`version` is `0.1.34`: four records become three committed edges with `superseded: 1`, the reason reads
*"the walk stated this step again out of the same two readings; one step has one account, and the later
one is the walk's"*, the journey has three walked steps and **0 breaks**, and P5 reports **nothing**.
The residue was then named exactly rather than waved at: `test@example.com` does survive in the model —
in the goal prose, the observation metadata, a state description, the reading an effect points at and
`transition_fill_login_email.action.arguments.email`, which is *that call's own value* — while the
retracted claim, `transition_submit_login.arguments.email`, is in neither document. A replay that had
dropped the value everywhere would look like a stronger proof and would be a weaker one.

Every rule in every suite is checked the way the other suites' rules are: by breaking it and reading
the failure. `test/prove-abm.py` is that file for this work — 61 mutations, all 61 refused, the tree
restored byte-identically and `15/15 suites passed` reprinted afterwards. It distinguishes *BROKEN*
from **SURVIVED** from **INVALID**, because a case whose edit does not parse fails every suite for a
reason that is not the rule and would otherwise look like a proof.

**The adapter's five rules are refused the same way, and one of the five found its own gap.**
`graphShapeOf` is the one function that must agree with two readers, so it is where a rule can be
written correctly and tested wrongly: the case for the once-per-edge report **survived** the first
time it was run, because the test marked one call of the move and the rule is about the second —
the dedupe was never exercised. The test now gives all three calls the same `collapsed` record,
which is what the adapter actually hands over, and the mutation is refused. A mutation that survives
is not a mutation to delete; it is a test that was not testing what it said.

**The prover was then read against the source, which found the one rule that had no case under it.**
`{{param}}` is read in three places — the recorder's diff, the generator's value handling and the
projection's `isPlaceholder` — and two of the three had a mutation under them. The third did not:
`const isPlaceholder = (value) => false;` left **all fifteen suites green**. A rule read in three
places and tested in two looks tested from either end, and that is the gap a shared rule invites: the
fixture that exercises it through a *realisation* proves the projection reads the rule, not that it
reads it where an edge's `arguments` are judged. Two cases now hold it down — a whole template on an
edge is a reference rather than a value the run failed to read back, and a value that merely *contains*
a template is not a reference at all — bringing `test/prove-abm.py` to 61 cases, all 61 refused. **That
is a change to `test/` and not to `lib/`, and it still moves the version to 0.1.35**, because a
version number that names two different byte sets is a version number that cannot be checked: the
first attempt to redeploy the new tests under `0.1.34` was accepted as "already installed" and left the
profile holding the old file, which is the mechanism working as designed. The deployed runtime bytes
are unchanged by this release; the proof harness is not, and both are in the tarball.

The suites drive the plugin's own seams: a fake tools registry, captures as plain
objects. They cover the run store (minting, dedupe, id reuse, `chain_break`, record
shapes), the diff and the cross-check (every warning kind, the one error, malformed
effects, missing captures), the reconciler (a synthesized run committed end to end,
then every rule one at a time — gates, refutation, supersession, ownership, dropped
references, state variables and unasserted dimensions, and the filesystem behaviour of a
refused and a forced commit), and a fake-harness integration pass over all four tools'
refusal paths, including the digest's own account of what the walk moved.

The journey rules get the same treatment, and they need it more than most: the assembler
*cannot* produce a broken walk — it cuts one instead — so `journeys[]` reaching the graph
malformed means the logs were edited, which is exactly what `invariantsOf` is fed
directly to check. The suite builds walk-shaped graphs by hand and asserts that a jump is an
error naming both ends, that a step the graph does not have is a dangling reference, that a
`start_state` disagreeing with the first step is refused, and that a graph whose states are
reachable only from a walk that does not exist is warned about rather than passed. Then the
assembler itself: two steps that do not join become two journeys, a repeated edge stays a
separate step, and a step whose edge was never committed cuts the walk into a recorded
break.

The store's behaviour when the workspace stops cooperating is a suite of its own,
`test/store-writes.test.mjs`, because it is the one place the tooling can turn into the
problem it exists to remove. It deletes the run directory mid-run and asserts both halves of
the rule: the write does not throw, the directory and `run.json` come back (byte-for-byte,
`started_at` included), the record lands, the sequence is not recycled, and the index is
emptied of what the log lost. Then it makes the repair itself impossible — a file where the
directory was — and asserts the other half: every record returns `null`, nothing refused is
remembered (no state, no vocabulary, no advanced walk), the sequence is not burned, the
failure is counted, and a later success clears the *current* problem while leaving the count
of unwritten records alone, because a gap is a gap.

The generator gets its own suite, `test/generate.test.mjs`, over a graph written by hand — two
states, four transitions, a composite capability, a redacted password, a declared
`candidate_assertions` list — because a spec is a program whose every line has to have come from
somewhere in the graph, and "it produced a file" is not a claim anything can be checked against.
The suite pins the whole body of a generated spec character for character, then takes one rule at a
time: the summary counts, the `requires[]` entry a withheld value produces, the three refusals (a
storage key is not asserted, a role a browser cannot act on is not clicked, a value the run did not
keep is not invented), the duplicate detection that stops a candidate repeating a line the arrival
block already wrote, the row-count translation of a dimension, every assertion type and every
operator, the journey search with its refusals and its `matched_by`, and the live-run case where an
argument disagreed with the step's own reading. A graph in, a string out, and no browser or harness
anywhere in it.

Every rule in that suite was checked the way the other suites' rules are — by breaking it and
reading the failure. `test/prove-generate.py` reverts sixteen of them one at a time and every one
makes the suite fail, naming the expectation that caught it: the dimension's resolution through
`sameCollectionName`, the role-and-name ranking, the withheld-value path, the folded negation, the
undeclared target, the arrival state's own detection, the argument-versus-reading rule, the matching
of a reading to the field it was read from, and `journeyNameFromGoal`'s dangling connector — plus
Phase 4's seven: the realization beating the transcription, the model step with no realization being
refused rather than written, the once-per-edge report, the header naming the document it was
written from, and the three that came out of the 0.1.32 live run — a template being read from the
environment, only a whole value being a template, and the same predicate narrowing the disagreement
warning. The
first attempt at that last one proved nothing and is the reason the file is worth reading: removing
the `cutParameter &&` gate is *behaviourally* identical, because a connector can only dangle when a
parameter was cut, so the proof breaks the rule instead — a connector set that includes the `in` of
"sign in" — and the suite catches it. It runs on `python3`, changes nothing that survives, and
prints `after restoring: 15/15 suites passed` when it is done.

The race between an action and the reading taken after it gets a suite that reproduces it,
`test/settle.test.mjs`, because it is the one failure the recorder was built to catch and
did not. A fake page is driven by real timers and a real `MutationObserver` class: the
Login click schedules its dashboard 150ms later, exactly as the demo app does, and the
collector is walked through a sign-in. The assertions are about the seam rather than the
message — the page is asked to settle **before** it is read, once per action; the reading
bound to the `browser_click` is the dashboard (`Projects` / `Settings` / `Log out`), not the
sign-in form it was taken on; the observation carries `settle` and the digest reports it;
the transition is `sign_in → dashboard` over the right pair of observations with no
disagreements; and a page that never moves is waited for rather than read through, while a
page whose *own* request is still open is held until that request lands and renders. Written
before the code that satisfies it, it failed first with `["capture", "capture"]` and a
reading of `["button:Login"]` — the recorded defect, reproduced on demand.

The claims a reading carries get their own suite, `test/detection.test.mjs`, for the reason
the claims exist at all: `tools/execute` accepts a detection, `graph_observe` writes it, and
`graph_commit` — which is where the rule about it lives — only sees it once the page it
describes is closed. Every case in the suite is a finding from the live 0.1.15 sign-in walk,
and the shape they share is the whole argument for the checks: the tool took a claim that the
commit later refused or dropped, and the correction arrived with nothing left to correct. So
the suite asserts the question asked early — a detection whose condition sits in a key nothing
reads is refused **naming `operator`**; a reference to an element no state declared is refused
naming the purposes that are declared; an element-shaped effect targeting `login.email` is
refused, and the same effect targeting `email_input` is recorded; a capability signature with a
key the schema closes (`sensitive`) is refused, and the corrected call is the capability's first
sighting — and then asks the commit the same questions about a graph it committed from a
recorded run, asserting no `detection_dropped` and no `effects_dropped` at all, that the object
form the protocol invites (`{semantic_purpose: …}`) resolves to an element id, and that the value
the capture contradicts is carried as written with the severity the commit gives it (`info`).
The last case is the one that cost the 0.1.16 live run its graph, and it is the one a model
reaches by being right about the page and wrong about the step: the click authenticated the
session, and the reading that followed named the screen the click had left. It asserts all three
shapes of that refusal — a claim the capture refutes read as itself, an `absence` claim that has
the element, a declaration that never located one and so answers the same way to every capture —
and then that the corrected walk commits with the dashboard as a state of its own, the login
state's own detection intact and no `detection_refuted_by_evidence` anywhere.

That mislabelled reading is now refused earlier and for a blunter reason — its controls have
nothing in common with the controls of the readings already bound to `state_login` — so the suite
asserts that refusal's own shape too: both surfaces quoted, the `dimensions` escape hatch named,
and nothing written to `states.jsonl`, which is what makes re-reading instead of re-walking the
right answer. Then the other side of the rule, which is what keeps it from being noise: a second
reading of the same screen that has merely grown a control is accepted, reuses the state, and is
noted about nothing. The commit-side half gets its smallest inputs in `commit.test.mjs`, where the
log can be written by hand: two readings that share no control at all are reported
`state_readings_share_no_surface` at `warning` with the document still committing, two that share
a single control are left alone, and a reading that lists no control refutes nothing.

One suite is about a seam the plugin does not own: what a tool returns. A tool that declares JSON
output gets its raw return value walked by the harness for anything that would not survive a
round-trip, and a value that does not — `undefined` being the usual one — fails **the whole call**,
with an error naming neither the field nor the reason (`value is not lossless JSON`). A model on
the other end sees a tool that stopped working, retries it, and gets the same nothing back.
`test/lossless.mjs` writes that rule down as the list of offending paths rather than a boolean, so a
failure reads as a diagnosis instead of a verdict; `commit.test.mjs` asserts the report and the graph
survive the round-trip and that every `decisions[]` row carries the same keys; and `tools.test.mjs`
walks one edge twice — the re-walk that produces a superseded candidate, which is where this was
live — and asserts the tool still returns JSON. That last case is the reproduction, and it was
confirmed by reverting the fix: it fails with `$.decisions[0].rejection_reason is undefined`.

What they cannot check is that a real page looks like the capture claims. That is what
a live run against a browser is for, and both are needed: the diff logic is the piece
whose entire job is being right about a disagreement, so it is exercised directly
rather than only through a browser.

The page hooks get the same treatment for the same reason — they decide whether a request
is seen at all, and the ways to get that wrong are silent. `test/page-hooks.test.mjs` runs
the real hook file and the real capture expression in a faked page, and asserts that a
request is recorded when it *starts* (so a document's own boot request is in the evidence of
the step that loaded it), that a response arriving later fills in the status, that a failed
request carries its reason, that an XHR is recorded on `send` and completed on `loadend`,
that `console.warn` still reaches the real console, that installing twice wraps nothing
twice, and that `hooks_installed_at` distinguishes the two arrivals. It also asserts the two
characters that would break the embedding — a backtick or a `${` anywhere in `page-hooks.js`,
comments included, since the file is spliced into a template literal.

The browser half of the same question is the patcher's `--verify`, which is the only place the
`document_start` claim can be checked against a real browser: it serves a page that fetches
while parsing, opens it **twice** — once through the patched manager and once through a page
the patch never touched — and fails unless the patched page reports `document_start` with that
request recorded and the control reports `after_load` with none.

`lib/index.js` imports its dependencies as peers, the way the harness supplies them, so
the suites need them resolvable. `test/run.mjs` searches the usual places (the profile,
the pnpm store, the npx cache) and prints a paste-ready `ln -sfn` if it cannot find
them.
