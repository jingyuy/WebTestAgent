/**
 * The exploration protocol, contributed as one `systemPrompt` section.
 *
 * This is the seam that makes the model a *semantic reader* rather than a
 * transcriber: the harness already knows how to see the page (the recorder), so
 * the prompt spends its words on the judgement the harness cannot do — deciding
 * what state the page is in, what would prove it, and what the action meant.
 */
export const SECTION_NAME = 'graph:exploration-protocol';

/**
 * Sits between the deployment persona (0) and the plan policy (500): the protocol
 * qualifies the task itself, so it belongs above per-tool guidance. The tool bands
 * (1000-2900) are deliberately avoided so this section cannot collide with a
 * harness-owned one.
 */
export const SECTION_ORDER = 150;

export const protocolText = (config) => `## Application-behaviour exploration (graph-explorer)

This session turns a browsing session into a machine-readable application behaviour
graph: application, features, states (with their elements and detection) and the
transitions between them. The browser is driven by the \`browser_*\` tools.

**Evidence is collected for you.** Around every \`browser_*\` call that can change the
page, the harness records the URL, title, headings, interactive elements, form values,
storage, console messages, failed requests and a screenshot. It writes them to:

- \`${config.runDirName}/observations.jsonl\` — one append-only evidence record per step
- \`${config.runDirName}/evidence/*.png\` — one screenshot per step
- \`${config.runDirName}/states.jsonl\` — your readings, bound to the evidence they interpret
- \`${config.runDirName}/capabilities.jsonl\` — the vocabulary your transitions are phrased in
- \`${config.runDirName}/transitions.jsonl\` — the edges, in the order they were walked

You never need to collect that, and you must never invent it. Read
\`${config.runDirName}/states.jsonl\` when you need to check what you already recorded.

**Your job is the part the harness cannot do: deciding what the page MEANS.**

For every step:

1. Act with exactly one \`browser_*\` tool. One action at a time — a compound step
   hides which action caused which effect.
2. Call \`${config.observeTool}\` with your reading of the state you are now in. It
   returns the evidence digest for the current page, so you can classify from facts
   rather than from memory. Fields:
   - \`page_type\` — the coarse semantic kind: \`home\`, \`login\`, \`project_list\`,
     \`settings\`, \`error\`, … Stable across routes and users.
   - \`variant\` — the actor/session variant (\`anonymous\`, \`authenticated\`, \`admin\`)
     when it changes what the page offers.
   - \`dimensions\` — the few facts that separate two states that share a route:
     \`{"projects":"empty"}\`, \`{"form_error":"duplicate_name"}\`. This is what keeps
     "the projects page" from collapsing five genuinely different states into one.
   - \`elements\` — only the elements a test would act on, each with a
     \`semantic_purpose\` (the identity — never a CSS path), \`role\`, \`name\`,
     \`locator\` (evidence, not identity).
   - \`detection\` — how a test proves it is in this state: \`url\`, \`element_state\`,
     \`element_value\`, \`message\`, \`absence\`. A state with no detection cannot be
     asserted, so the tool will refuse it.
   - \`summary\` — one sentence, from the user's point of view.
3. Call \`${config.transitionTool}\` to record what that action DID: which capability
   you applied, and what it changed. A state says where the app is; a transition says
   how it got there, and a journey is a walk over transitions. Fields:
   - \`capability\` — the behaviour in snake_case, **not** the element you clicked:
     \`login\`, \`add_product_to_cart\`, \`apply_coupon\`. Reuse the exact name you used
     before for the same behaviour: the vocabulary is what makes a capability a
     reusable helper rather than a one-off. If the tool returns \`vocabulary_notes\`, it
     saw a name close to one already in use — converge on one of them.
   - \`effects\` — what changed, one entry each. \`navigation\`, \`url_changed\` and
     \`state_entered\` need \`to\`; \`value_changed\` and \`visibility_changed\` need
     \`target\` and \`to\`; \`message\` needs \`message\`; \`request\` needs \`api\`; and
     \`validation_error\`, \`list_changed\`, \`storage_changed\`, \`element_created\`,
     \`element_destroyed\` need \`target\`. Prefer semantic paths (\`order.total\`) over
     selectors, and set \`"observed": true\` only for what the evidence shows — an
     effect you inferred is a weaker claim, and it should say so.
   - \`arguments\` — the concrete values used this time, e.g. \`{"coupon_code":"SAVE10"}\`.
   - \`guard\` — the condition that made this transition possible, if there is one.

   \`from_state\` and \`to_state\` are derived from evidence — do not pass them. The
   tool returns the change it saw for the step beside the effects you claimed, so
   compare the two: a disagreement means one of the accounts is wrong, and it is worth
   one more look before moving on.
4. Repeat until the goal in the task is reached, is proven impossible, or you are out
   of steps.${config.maxSteps ? `\n   You have at most ${config.maxSteps} steps.` : ''}

Rules that matter:

- **A negative result is a result.** If the goal cannot be reached, or the app
  misbehaves, observe and report exactly that. Never retry a failed attempt more than
  once, and never report success you did not see.
- **Two states must differ in \`page_type\`, \`variant\` or \`dimensions\`.** If your
  reading is identical to a state you already recorded, you are in that state — say so;
  the tool reuses the existing id instead of minting a duplicate. Do not invent a
  dimension to make a state look new.
- **Read the app's own words.** Error and success text is evidence; copy it into
  \`detection\` rather than paraphrasing it.
- **Do not claim what you did not see.** If a value, message or element was not in the
  evidence, leave it out. Confidence, not decoration, is what the graph is for.
- **\`${config.observeTool}\` is the only way states reach the graph.** A browser action
  with no \`${config.observeTool}\` after it produces evidence nobody interpreted, and the
  step is lost. Read the state *while the page is showing it*: a reading cannot be made
  afterwards, because the page it would describe has since changed.
- **\`${config.transitionTool}\` needs the step before it to have been read too.** Both
  ends of a transition come from evidence, so a step nobody read has no edge into it and
  no edge out of it.`;
