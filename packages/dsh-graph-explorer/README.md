# @webtestagent/dsh-graph-explorer

A DeepSeek Harness bundle that turns a `dsh-browser` exploration into an
append-only evidence log and an application behaviour graph.

It records evidence, the model's reading of each state, and each transition — a
capability applied in one state, landing in another — with the machinery's own
account of the step checked against the model's. It does not yet emit a full
`*.graph.json` or validate against the JSON Schemas; see
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
| Semantic tools | `ctx.tools.register(defineTool({...}))` | `graph_observe` and `graph_transition` — the only paths by which a state or an edge reaches the graph |
| Protocol | `ctx.systemPrompt.section({...})` | The act → observe → record loop the model follows |

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
  "plugin": { "name": "@webtestagent/dsh-graph-explorer", "version": "0.1.10" }
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

## Install

**Tarball, not a `link:` directory.** A directory install resolves the real path,
so the plugin's `import '@deepseek-ai/dsh-tools'` starts from the repo — which has
no `node_modules` and no harness packages — and fails to resolve. A tarball is
copied into the profile, where the walk up to `~/.dsh/profiles/node_modules`
finds the same package instances the harness itself uses.

```sh
cd packages/dsh-graph-explorer
npm pack                                     # -> webtestagent-dsh-graph-explorer-0.1.10.tgz
dsh plugin --profile graph add "$PWD"/webtestagent-dsh-graph-explorer-0.1.10.tgz
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

## Why two tools, not ten

A semantic layer usually grows one tool per noun — `observe_state`, `identify_state`,
`save_state`, `find_similar_state`, `record_transition`, `add_capability`,
`query_graph`. This plugin has two. The merges are deliberate, because each split
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

**Known gaps, in the order they will bite:**

1. **Initial document loads are not observed.** The network/console hooks are
   installed by `browser_eval`, which is document-scoped, so a full navigation
   discards them and the requests that loaded the new document are lost. Same-document
   (SPA) traffic *is* captured, which is the case `transition.effects[].request`
   needs. Closing the gap requires Playwright's `addInitScript`, i.e. a source patch
   to `dsh-browser`.
2. **Nothing validates against the JSON Schemas.** `graph_commit`, the §14 invariant
   checks, and a non-zero exit on violation are the next milestone. Until they exist,
   a run produces evidence, readings and edges — not a graph.
3. **No journey assembly.** The walk is reconstructible from the observation chain
   but is not yet assembled mechanically. It should be, since it is mechanical:
   `journey.transitions[]` is an ordered list of ids and the walk already is one.
4. **State ids grow without bound.** Every dimension the model chooses is concatenated
   into the id, so a field value can end up in one:
   `state_project_list_authenticated_form_error_duplicate_name_panel_none_projects_seeded`.
   The dimensions are the model's to choose and they are all real, so the fix is a
   budget (a limit on dimensions, or a hash past N) rather than a check.
5. **Element state can outrank state identity.** The model may treat a filled-in field
   as a new state, which mints a state per value. The schema's `identity` is about the
   page, not the widget, but the tool cannot tell the two apart — it only knows the
   tuple it was handed, and the honest thing is to report the id rather than guess.
6. **`features` has no source.** `application` is now declared in config (see
   [Configuration](#configuration)), but `features` is a judgement about the app's own
   structure rather than something the machinery can observe, so it needs a model-facing
   tool. Optional in the schema, so its absence costs a valid graph rather than a
   committable one — but `graph_commit` has to be able to emit it.

## Tests

```sh
npm test        # 3 suites, no browser and no harness
```

The suites drive the plugin's own seams: a fake tools registry, captures as plain
objects. They cover the run store (minting, dedupe, id reuse, `chain_break`, record
shapes), the diff and the cross-check (every warning kind, the one error, malformed
effects, missing captures), and a fake-harness integration pass over both tools'
refusal paths.

What they cannot check is that a real page looks like the capture claims. That is what
a live run against `demo-app` is for, and both are needed: the diff logic is the piece
whose entire job is being right about a disagreement, so it is exercised directly
rather than only through a browser.

`lib/index.js` imports its dependencies as peers, the way the harness supplies them, so
the suites need them resolvable. `test/run.mjs` searches the usual places (the profile,
the pnpm store, the npx cache) and prints a paste-ready `ln -sfn` if it cannot find
them.
