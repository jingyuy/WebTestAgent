# Vendored schemas

Two schema sets live here, and the difference between them is the whole point.

| Directory | What it is | Policy |
| --- | --- | --- |
| `0.1/` | The **Application Behavior Graph** schemas, copied byte-identical from the normative source. | **Never edited.** Not a "mostly the same" copy — an exact one, so it can validate the fallback artifact (`graph.json`) and so any divergence is a deliberate, visible act rather than drift. |
| `abm/0.2/` | The **Application Behavior Model** fork. | Edited freely. `schema_version: "0.2"` — deliberately distinct from the graph's `"0.1"`. |

## Why `0.1/` is vendored at all

The plugin used to have no dependency on these schemas: nothing between a tool call and
`graph.json` checked the document's shape, and README gap 8 records the consequence — a green
`graph_commit` twice wrote a schema-**invalid** `graph.json`. Vendoring the normative set makes
the fallback's contract part of this repo instead of a convention held in someone's head.

`VENDOR.md` carries the hashes so that "byte-identical" is checkable rather than asserted:

```sh
shasum -a 256 packages/dsh-graph-explorer/schemas/0.1/*.schema.json
```

## Source

`~/IntegrationTestGenerator/schemas/*.schema.json` (draft 2020-12, every document
`additionalProperties: false`).

## Hashes at vendoring time

| File | sha256 |
| --- | --- |
| `api.schema.json` | `ee186e3646bb52a21fe7e234adf08b42da1117f6c71614116847beec63da6151` |
| `application.schema.json` | `2debc0276be419dfe48369c7815cd15c5f732a628e283c423501dea442550faa` |
| `capability.schema.json` | `5f3bb7b21f0137f9dbc79634da5bae08ec01f702aefdf4c3cf7f868c436c7ee2` |
| `common.schema.json` | `8a6050527e7b4c42fda252e7cf57e4c9e310c4ab2d9466bba52e58a8995b6f8f` |
| `element.schema.json` | `3a851d5593dfd95d5c96269e5461ea045ece410650b3aea3b3dc9e4e7ce09696` |
| `feature.schema.json` | `7acfff285fc37f50569cd22209e32af8696dcc42f742bf4dff9995a96a71f0b2` |
| `graph.schema.json` | `7ccfe94382de4f2798fd2854706e83921d279aa368ae6d3d82ebce9ff7ed8075` |
| `journey.schema.json` | `88829d7aa28a416df2955f112e4be1b68b065fbbd5764f04df6ca1f7bb68b9f7` |
| `observation.schema.json` | `7a5caa50beb63dd0b2c51812bf940672cfe7e03c39c058615187a5ea7e559f84` |
| `state.schema.json` | `cf6d5f77f054b40e3f3db937b16c2f14cb3254f63b5e5c7891cab84fa0075c8b` |
| `transition.schema.json` | `8998df96bda689bfde9fe27f5c70d99e0b3c1669c57524d9fdf51426e1aebeb4` |

All 11 files, 53370 bytes total. `diff -r` against the source is clean.

## The `abm/0.2/` fork, and what it does not touch

`abm/0.2/` keeps every `$defs` name and every field name it can, so a reader who knows one
document can read the other. It changes the spine and adds the representational gaps the graph
could not fill:

* a **new root** (`application-model.schema.json`) — `behaviors[]` + `transitions[]` instead of
  flat `capabilities[]`;
* `behavior.schema.json` — `capability.schema.json` re-scoped, so `realization[]` is the home for
  mechanics and `preconditions[]`/`effects[]` are not the behaviour's;
* `transition.schema.json` — `capability` becomes `behavior`, and one edge is one
  `(from_state, behaviour, to_state)`;
* `state.schema.json` — gains `affordances[]`;
* `journey.schema.json` — `steps[]` references `transitions[]` in order;
* `common.schema.json`, `element`/`api`/`observation`/`application` — copied, with `actors[]`
  populated rather than merely declared.

`feature.schema.json` is **not** forked. Feature grouping stays a `graph.json` layer: the ABM is a
behaviour model, not a product map. The `feature` argument on `graph_transition` keeps feeding
`graph.json` only.

### The ten files, and how far each one moved

Every `$id` is rewritten from `https://integration-test-generator.local/schemas/0.1/` to
`https://webtestagent.local/schemas/abm/0.2/`. Every `$ref` is relative, so it resolves inside the
fork and never reaches back out to the normative set.

| File | State |
| --- | --- |
| `application-model.schema.json` | **new root.** `schema_version` pattern `^0\.2…$`, so a `graph.json` cannot pass as a model and a model cannot pass as a `graph.json`. Adds `entities[]` and `state_variables[]` as real arrays. |
| `behavior.schema.json` | **new.** `capability` re-scoped: `realization[]` replaces `steps[]` as the home for mechanics, each step may carry its own `effects[]` and a `purpose`, and there is no behaviour-level `preconditions[]`/`effects[]`/`element`. |
| `transition.schema.json` | **edited.** `action.capability` → top-level `behavior`; `from_state` is one concrete `stateId` (no wildcard, no list); `guard`/`effects[]`/`apis[]`/`evidence[]` unchanged. |
| `state.schema.json` | **edited.** `capabilities[]` → `behaviors[]`; gains `affordances[]`. |
| `journey.schema.json` | **edited.** `required` is `["id","name","goal_stated","steps"]`; `transitions[]` → `steps[]` of `{$defs.journeyStep}`; gains `goal_stated`. |
| `common.schema.json` | **copied.** Only the `$id` line differs from the normative file, so every shared `$defs` name still means what it meant. |
| `application.schema.json` | **copied, one added requirement.** `actors` is `required` with `minItems: 1`. See below. |
| `element.schema.json` | **copied.** Unchanged but for `$id`. |
| `observation.schema.json` | **copied, one vocabulary fix.** `action.capability` → `action.behavior`. See below. |
| `api.schema.json` | **copied.** Unchanged but for `$id`. |

### Three decisions the fork had to make, and why they went the way they did

**`behaviorId` lives in `behavior.schema.json`, not in `common.schema.json`.** The upstream
`capabilityId` pattern (`^cap(?:ability)?[-_]…`) rejects `behavior_login`, and widening it would
let a document that has no capabilities keep minting `cap_` ids. Putting the new def in `common`
would have meant editing the one file whose value is that it was not edited, so it sits with the
concept it names.

**`application.actors` is required, and `observation.action.capability` became `behavior`.** Both
are divergences inside "copied" files, and both pass the same test: without them the ABM's own
vocabulary would be unnameable. P6 needs an actor vocabulary to resolve `state.identity.variant`
and `journeys[].actor` against; an observation whose `action` cannot name a behaviour cannot be
the `action`-role evidence for an edge. `capabilityId` and `precondition.capability` are left
alone and unused — an ABM expresses a precondition with `state` or `journey`, since a
behaviour-level precondition is just the state the behaviour requires. Leaving them means
`common.schema.json` stays verifiable against its upstream hash.

**`state.affordances[]` has no status field.** An explicit `status: "unwalked"` was the first
design, and it does not survive contact with `common.schema.json`'s own contract: `metadata` is
"provenance and bookkeeping only, never application semantics", and `metadata.status`'
enumeration is `draft|inferred|verified|stale|deprecated`. `unwalked` is a statement about the
application, not about the producer, so it belongs to neither. Being *in* `state.affordances[]`
is the whole of the claim, `metadata.confidence` carries the strength of it, and there is no
second place to keep in sync.

### The schema cannot check a reference, and that is measured

`test/prove-schema.mjs` is the fork's evidence, in the style of `prove-generate.py`: a table of
mutations, each the structural half of a recorded decision (D2, D4, D5, D6, D7, P1, P2, P4, P6,
P7, P8, P13), each of which the schema **must refuse**. A mutation that comes back valid is
reported `SURVIVED`, because a rule nothing enforces is not a rule the schema has.

```
23 mutation(s) the schema must refuse: 23 refused, 0 survived.
```

It also measures the blind spot rather than asserting it. `transition_nonexistent` is a
perfectly well-formed transition id: the pattern checks the spelling, never the presence. A
dangling reference is therefore *never* a schema failure, which is why `lib/validate.js` has to
exist as a separate referential layer in Phase 2 instead of leaning on the schema. Five mutations
of that family are asserted to be **accepted**; if one is ever refused, the script says so and
the note is stale.

Run it with ajv, which is deliberately not a dependency:

```sh
npm i -D ajv ajv-formats && npm run prove:schema
# or reuse an installed copy:
NODE_PATH=/path/to/node_modules npm run prove:schema
# and optionally re-check the vendored 0.1 against a recorded run:
GRAPH_JSON=~/tmp/live-graph/graph-run/graph.json npm run prove:schema
```

Without ajv it prints `SKIP` and exits 0, so `npm test` keeps working in a clone with nothing
installed. `test/run.mjs` only discovers `*.test.mjs`, so the proof is never swept into the suite.

### The fixture

`test/fixtures/abm/example.json` is the document `docs/abm-pivot.md` §3 describes, with the
comment elisions resolved into real objects. It exists so that §3 can be validated rather than
read — the plan's example was checked against the schemas and did not survive first contact, in
five places, all of which are now fixed on both sides. It is also the expected shape Phase 0b's
`modelFromCandidates` has to produce.

