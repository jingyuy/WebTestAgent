# @webtestagent/dsh-graph-explorer

A DeepSeek Harness bundle that turns a `dsh-browser` exploration into an
append-only evidence log and the beginnings of an application behaviour graph.

This is the **spike**: it proves the three harness seams end-to-end, and it stops
there. It does not yet emit a full `*.graph.json` or validate against the JSON
Schemas — see [Not yet built](#not-yet-built).

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
| Semantic tool | `ctx.tools.register(defineTool({...}))` | `graph_observe` — the only path by which a state reaches the graph |
| Protocol | `ctx.systemPrompt.section({...})` | The act → observe loop the model follows |

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
  evidence/           # one PNG per captured step
```

`observations.jsonl` is append-only and never rewritten, so a later reading
cannot silently alter the evidence it was derived from.

### Provenance

`run.json` answers *could someone reproduce this run?* — what code, what
instruction, what model, what starting point:

```json
{
  "started_at": "2026-09-16T21:49:40.504Z",
  "cwd": "/Users/you/tmp",
  "start_url": "http://127.0.0.1:4173/",
  "instruction": "Open http://127.0.0.1:4173/ and sign in ...",
  "max_steps": null,
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "session_id": "session-dc4d1554-...",
  "agent_preset": null,
  "plugin": { "name": "@webtestagent/dsh-graph-explorer", "version": "0.1.4" }
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

`transition.before_observation` / `after_observation` map onto consecutive
entries of the observation chain: one capture follows every action, so the capture
after step *N* is the capture before step *N+1*.

## Install

**Tarball, not a `link:` directory.** A directory install resolves the real path,
so the plugin's `import '@deepseek-ai/dsh-tools'` starts from the repo — which has
no `node_modules` and no harness packages — and fails to resolve. A tarball is
copied into the profile, where the walk up to `~/.dsh/profiles/node_modules`
finds the same package instances the harness itself uses.

```sh
cd packages/dsh-graph-explorer
npm pack                                     # -> webtestagent-dsh-graph-explorer-0.1.4.tgz
dsh plugin --profile graph add "$PWD"/webtestagent-dsh-graph-explorer-0.1.4.tgz
```

The version in that filename is load-bearing: pnpm keys a `file:` tarball on the
spec string, so re-installing the same path **at the same version** reuses the
cached copy and silently keeps the old code. `--force` does not help. Bump
`version` in `package.json` and repack to actually deploy.

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
    runDirName: graph-run            # where evidence lands (relative to the workspace)
    maxSteps: 12                     # folded into the prompt's step budget
    screenshot: true                 # one PNG per captured step
    maxDigestChars: 14000            # trims the digest before it competes for context
```

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

## What the spike proves, and what it does not

**Proven end-to-end:** evidence is captured around every browser action and
persisted with artifacts on disk; `graph_observe` is visible to the model, callable,
and refuses an unsound state instead of accepting it; the protocol section reaches
the assembled prompt.

**Known gaps, in the order they will bite:**

1. **Initial document loads are not observed.** The network/console hooks are
   installed by `browser_eval`, which is document-scoped, so a full navigation
   discards them and the requests that loaded the new document are lost. Same-document
   (SPA) traffic *is* captured, which is the case `transition.effects[].request`
   needs. Closing the gap requires Playwright's `addInitScript`, i.e. a source patch
   to `dsh-browser`.
2. **`graph_transition` does not exist yet.** The evidence for it is already being
   recorded (the before/after chain), but nothing yet binds a capability and its
   observed effects into a transition.
3. **Nothing validates against the JSON Schemas.** `graph_commit`, the §14 invariant
   checks, and a non-zero exit on violation are the next milestone. Until they exist,
   a run produces evidence and readings, not a graph.
4. **No journey assembly.** The walk is reconstructible from the observation chain
   but is not yet assembled mechanically.
