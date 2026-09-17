# @webtestagent/dsh-graph-explorer

A DeepSeek Harness bundle that turns a `dsh-browser` exploration into an
append-only evidence log and an application behaviour graph.

It records evidence, the model's reading of each state, and each transition — a
capability applied in one state, landing in another — with the machinery's own
account of the step checked against the model's. `graph_commit` then reconciles the
whole run into a `graph.json` that validates against the target JSON Schemas, beside
a `commit_report.json` that says what it committed, what it refused and why. See
[The commit](#the-commit) and
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

## The three seams

| Seam | API | Role |
| --- | --- | --- |
| Recorder | `ctx.on('tools/execute', (exec, next))` | Capture evidence around every browser action that can change the page |
| Semantic tools | `ctx.tools.register(defineTool({...}))` | `graph_observe` and `graph_transition` — the only paths by which a state or an edge reaches the candidate graph |
| Protocol | `ctx.systemPrompt.section({...})` | The act → observe → record loop the model follows |
| Reconciliation | `ctx.tools.register(defineTool({...}))` | `graph_commit` — the only path from candidate records to a committed graph |

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
  commit_report.json  # written by graph_commit, always
```

All four `.jsonl` files are append-only and never rewritten, so a later reading
cannot silently alter the evidence it was derived from. A reading appends a new
state or a sighting of an existing one; a step appends a transition, and walking
the same edge twice appends twice while reusing one transition id.

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
  to warn about.
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
                    commit_report.json            every judgement that produced it
```

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
  `rejected`, and the report keeps them apart.

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

What a journey cannot carry is a goal. A browser session records what was done, never what
was being attempted, so:

- `name` is derived from the endpoints of the walk and says so —
  `Derived walk 1: state_login to state_dashboard (3 step(s))`;
- `criticality` is **omitted rather than guessed**. The schema's `criticality` is a closed
  enum (`smoke | critical | standard | extended`, default `standard`), so writing prose there
  would be a schema violation; the reason goes in `metadata.extra.criticality` and the
  default applies.
- `metadata.status` is `inferred` and `producer` is `importer:dsh-graph-explorer` — not
  `llm:<model>`, because no model judged this, the importer read it off the log;
- `metadata.extra.goal_stated` is `false`, and the graph carries a warning saying that a test
  generator has to supply the goal before a derived journey becomes a test.

Evidence is carried across from the steps and deduplicated by observation and role. It has
to be: the schema's `evidenceRef` points at observations, never at transitions, so a
journey's evidence is the readings its steps rested on.

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
decisions[]   findings[]   invariants[]   notes[]   warnings[]
```

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

## Install

**Tarball, not a `link:` directory.** A directory install resolves the real path,
so the plugin's `import '@deepseek-ai/dsh-tools'` starts from the repo — which has
no `node_modules` and no harness packages — and fails to resolve. A tarball is
copied into the profile, where the walk up to `~/.dsh/profiles/node_modules`
finds the same package instances the harness itself uses.

```sh
cd packages/dsh-graph-explorer
npm pack                                     # -> webtestagent-dsh-graph-explorer-0.1.11.tgz
dsh plugin --profile graph add "$PWD"/webtestagent-dsh-graph-explorer-0.1.11.tgz
```

The version in that filename is load-bearing: pnpm keys a `file:` tarball on the
spec string, so re-installing the same path **at the same version** reuses the
cached copy and silently keeps the old code. `--force` does not help. Bump
`version` in `package.json` and repack to actually deploy.

The installer's own output is not proof of what landed. Verify the artifact, not
the exit code:

```sh
cd ~/.dsh/profiles/graph/node_modules/@webtestagent/dsh-graph-explorer
diff -r <repo>/packages/dsh-graph-explorer/lib ./lib && echo IDENTICAL
```

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

## Why three tools, not ten

A semantic layer usually grows one tool per noun — `observe_state`, `identify_state`,
`save_state`, `find_similar_state`, `record_transition`, `add_capability`,
`query_graph`.
This plugin has three. The merges are deliberate, because each split
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
three exists because removing it would leave a claim that is neither evidence nor
knowledge — a reading nobody saved, an edge judged before it could be compared,
evidence that is not a graph. `graph_observe` and `graph_transition` write candidates;
`graph_commit` is the only writer of the graph.

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
- **No network getter.** Requests come from hooks the capture installs, which is exactly
  why the initial document load of a navigation is not observed.
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

**Known gaps, in the order they will bite:**

1. **Initial document loads are not observed.** The network/console hooks are
   installed by `browser_eval`, which is document-scoped, so a full navigation
   discards them and the requests that loaded the new document are lost. Same-document
   (SPA) traffic *is* captured, which is the case `transition.effects[].request`
   needs. Closing the gap requires Playwright's `addInitScript`, i.e. a source patch
   to `dsh-browser`.
2. **Some rules are judgement, not proof.** `feature_closure` is reported rather than
   enforced (`features` has no source at all, see gap 6), and `reachability` is a warning
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
4. **State ids grow without bound.** Every dimension the model chooses is concatenated
   into the id, so a field value can end up in one, and a derived journey id inherits the
   whole thing:
   `journey_login_anonymous_auth_signed_out_to_login_anonymous_auth_signed_out_form_cre`
   is one real 0.1.12 id (the slug is cut off at a length budget). The dimensions are the
   model's to choose and they are all real, so the fix is a budget (a limit on dimensions,
   or a hash past N) rather than a check — and the same budget wants to apply to derived
   journey ids, which are built from two of them.
5. **Element state can outrank state identity.** The model may treat a filled-in field
   as a new state, which mints a state per value. The schema's `identity` is about the
   page, not the widget, but the tool cannot tell the two apart — it only knows the
   tuple it was handed, and the honest thing is to report the id rather than guess.
6. **`features` has no source.** `application` is now declared in config (see
   [Configuration](#configuration)), but `features` is a judgement about the app's own
   structure rather than something the machinery can observe, so it needs a model-facing
   tool. Optional in the schema, so its absence costs a valid graph rather than a
   committable one — but `graph_commit` has to be able to emit it.
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

## Tests

```sh
npm test        # 4 suites, no browser and no harness
```

The suites drive the plugin's own seams: a fake tools registry, captures as plain
objects. They cover the run store (minting, dedupe, id reuse, `chain_break`, record
shapes), the diff and the cross-check (every warning kind, the one error, malformed
effects, missing captures), the reconciler (a synthesized run committed end to end,
then every rule one at a time — gates, refutation, supersession, ownership, dropped
references, and the filesystem behaviour of a refused and a forced commit), and a
fake-harness integration pass over all three tools' refusal paths.

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

What they cannot check is that a real page looks like the capture claims. That is what
a live run against `demo-app` is for, and both are needed: the diff logic is the piece
whose entire job is being right about a disagreement, so it is exercised directly
rather than only through a browser.

`lib/index.js` imports its dependencies as peers, the way the harness supplies them, so
the suites need them resolvable. `test/run.mjs` searches the usual places (the profile,
the pnpm store, the npx cache) and prints a paste-ready `ln -sfn` if it cannot find
them.
