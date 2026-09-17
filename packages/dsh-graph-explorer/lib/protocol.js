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
transitions between them — and, from that graph, a Playwright test for one of its
journeys. The browser is driven by the \`browser_*\` tools.

**Evidence is collected for you.** Around every \`browser_*\` call that can change the
page, the harness records the URL, title, headings, interactive elements, form values,
storage, console messages, failed requests and a screenshot. It writes them to:

- \`${config.runDirName}/observations.jsonl\` — one append-only evidence record per step
- \`${config.runDirName}/evidence/*.png\` — one screenshot per step
- \`${config.runDirName}/states.jsonl\` — your readings, bound to the evidence they interpret
- \`${config.runDirName}/capabilities.jsonl\` — the vocabulary your transitions are phrased in
- \`${config.runDirName}/transitions.jsonl\` — the edges, in the order they were walked

The recording is taken after the page has been given a chance to stop moving: it waits
for the document to go quiet, and for the requests the page itself started, before it
reads. The digest reports how that wait went under \`settle\`, and the wait is bounded
(3s). If \`settle.timed_out\` is true the page was still busy when it was read — wait for
it and read again rather than treating that reading as final.

You never need to collect that, and you must never invent it. Read
\`${config.runDirName}/states.jsonl\` when you need to check what you already recorded.

**Your job is the part the harness cannot do: deciding what the page MEANS.**

The first action of a run is a step, not a transition. Nothing came before it, so there is
no state for it to have moved between — read the state it arrived in with
\`${config.observeTool}\`, and record transitions from the second action onward. The tool
refuses the first one rather than inventing an entry state for it.

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
     A dimension is a fact about the *application*: what it holds, what it refuses,
     which record is open. Element state is not a dimension — a form with a value in
     it is the same state as the form without it, and filling it is a \`value_changed\`
     effect on a self-loop rather than a transition into a state of its own. Ask what
     the app would say at that moment: \`{"form_error":"duplicate_name"}\` is the app
     answering; \`{"email":"filled"}\` is you having typed.

     A dimension has two halves and a state needs both: the word, here, and a \`value\`
     assertion in \`detection\` that reads it. The digest's \`state_variables\` names the
     variables your own steps moved that no state records this way — a step that changes
     only what the app remembers (a cart count, a filter, a draft) is a real difference,
     and this is where it goes, so the graph can hold it without giving the screen a
     state of its own.
   - \`elements\` — only the elements a test would act on, each with a
     \`semantic_purpose\` (the identity — never a CSS path), \`role\`, \`name\`,
     \`locator\` (evidence, not identity).
   - \`detection\` — how a test proves it is in this state: \`url\`, \`element_state\`,
     \`element_value\`, \`message\`, \`absence\`. A state with no detection cannot be
     asserted, so the tool will refuse it. Every state needs one, and the state a walk
     *lands* in needs it most: the generated test asserts each arrival with the arrival
     state's own detection, so a state with none costs the spec that check — the test
     reaches the screen and says nothing about having got there. The condition goes in
     \`operator\` — or in
     \`value\`/\`expected\` — never in a key of your own: for a state word write
     \`{"type":"element_state","target":"sign_in_button","operator":"visible"}\`, and for
     a value \`{"type":"element_value","target":"email_input","value":"test@example.com"}\`.
     A dimension is asserted the same way, with the name you gave the dimension:
     \`{"type":"value","target":"projects","operator":"equals","expected":"empty"}\` — one
     name, so the graph's word for the difference and the test's check for it are one thing.
     An element in a detection resolves against the \`semantic_purpose\` a state has
     declared, so declare the element in the reading that first sees it. A detection is
     checked against the capture of the very reading that carries it: a claim the page
     contradicts is refused, so name the screen the page is on *now* — after an action
     that moved it, a detection describing the screen you left is refuted by your own
     evidence, and the tool will not record the reading.
   - \`summary\` — one sentence, from the user's point of view.
3. Call \`${config.transitionTool}\` to record what that action DID: which capability
   you applied, and what it changed. A state says where the app is; a transition says
   how it got there, and a journey is a walk over transitions. Fields:
   - \`capability\` — the behaviour in snake_case, **not** the element you clicked:
     \`login\`, \`add_product_to_cart\`, \`apply_coupon\`. Reuse the exact name you used
     before for the same behaviour: the vocabulary is what makes a capability a
     reusable helper rather than a one-off. If the tool returns \`vocabulary_notes\`, it
     saw a name close to one already in use — converge on one of them.

     One of those notes means the opposite, and the difference is the difference
     between a behaviour and a step. A **composite** is the behaviour a user would ask
     for (\`login\`); a **step** is one interaction that serves it
     (\`fill_login_email\`), and a composite contains its steps. So \`login\`
     overlapping \`fill_login_email\` is the shape a composite and its sub-capability
     are supposed to have, not a collision: record both, with
     \`capability_kind: composite\` on the one that is the behaviour and the step's own
     kind on the other, and do not rename the composite after one of its steps —
     \`login\` renamed to \`fill_login_email\` is the whole sign-in reported as one
     keystroke. Converge when the two names are two ways of saying *one* behaviour:
     \`add_to_cart\` and \`add_item_to_cart\` are one capability, and so are \`search\`
     and \`search_product\`. When the note offers a name from the schema's vocabulary for
     a behaviour you recognise, that name wins — the vocabulary is the list the graph is
     being converged onto.

     A composite that absorbs the interaction that finishes it is the failure this is
     written against: \`login\` recorded as a composite over \`fill_login_email\` and
     \`fill_login_password\`, with the click that submits the form folded into it. The
     click is a capability of its own *and* a step of \`login\`, so record it in the same
     call that performs it — \`capability: "submit_login"\` with
     \`capability_behaviour: "login"\` — and the step is appended to \`login\`'s
     \`composed_of\`, in the order they are performed:
     \`["fill_login_email", "fill_login_password", "submit_login"]\`. A composite whose
     steps do not include the one that does the work is a claim the walk does not
     support, and the generator reports the mismatch instead of writing a test from it.
   - \`effects\` — what changed, one entry each. \`navigation\`, \`url_changed\` and
     \`state_entered\` need \`to\`; \`value_changed\` and \`visibility_changed\` need
     \`target\` and \`to\`; \`message\` needs \`message\`; \`request\` needs \`api\`; and
     \`validation_error\`, \`list_changed\`, \`storage_changed\`, \`element_created\`,
     \`element_destroyed\` need \`target\`. What \`target\` is depends on the effect:
     for the element-shaped ones (\`value_changed\`, \`visibility_changed\`,
     \`element_created\`, \`element_destroyed\`, \`validation_error\`) it is the
     element's \`semantic_purpose\` — \`email_input\`, not \`login.email\` and not a
     selector, and the tool refuses a target no state has declared; for the rest
     (\`storage_changed\`, \`list_changed\`) it is a semantic path or key
     (\`localStorage.draft\`, \`order.items\`). What \`to\` is depends on the effect too:
     for \`value_changed\` and \`visibility_changed\` it is what the element moved to
     (\`"test@example.com"\`, \`"absent"\`); for \`state_entered\` it is the **state id**
     the reading ended in — the \`state_id\` the tool reported for this step's own
     reading (\`state_project_list_authenticated_signed_in\`), never the \`page_type\`
     (\`project_list\`) or the \`variant\` (\`authenticated\`), neither of which is a
     state. The step's \`to_state\` is derived from evidence — it is where the action
     actually landed — so the effect's \`to\` is that same id, and the tool refuses the
     step when the two disagree rather than guess which one you meant.
     Set \`"observed": true\` only for what the evidence shows — an effect you
     inferred is a weaker claim, and it should say so.
   - \`arguments\` — the concrete values used this time, e.g. \`{"coupon_code":"SAVE10"}\`.
   - \`guard\` — the condition that made this transition possible, if there is one.
   - \`journey_name\` — what the walk is a journey *towards*, in the user's own words:
     \`"Sign in and see the project list"\`. A journey is derived from walk order, so this
     is the one thing about it the machinery cannot see. Without a claim the journey
     keeps the run's whole instruction as its name and goal — *"using the browser tools,
     open the app at http://… and sign in as …"* — which is a sentence a person asked,
     not a title, and nothing downstream can shorten it back into the journey. State it
     once, on any step of the walk; the latest claim names the whole walk.
   - \`feature\` — the product feature this step is part of (\`"authentication"\`,
     \`"project_management"\`). Nothing in a page says what a product is *for*, so these
     words are yours and they are the only source \`features[]\` has: a run that claims no
     feature commits an empty \`features[]\`, however many pages it walked. Reuse the exact
     words on every step of the same feature — the name is the key.

   \`from_state\` and \`to_state\` are derived from evidence — do not pass them. The
   tool returns the change it saw for the step beside the effects you claimed, so
   compare the two: a disagreement means one of the accounts is wrong, and it is worth
   one more look before moving on.
4. Repeat until the goal in the task is reached, is proven impossible, or you are out
   of steps.${config.maxSteps ? `\n   You have at most ${config.maxSteps} steps.` : ''}
5. Call \`${config.commitTool}\` when the walk is over. This is where the run becomes a
   graph. Everything you did until now is *evidence*, and evidence is allowed to be
   wrong — a reading can be reinterpreted, a step can turn out to belong to a different
   transition, an edge can turn out to be a duplicate. The commit is the only step that
   reads the whole run at once and decides what is knowledge: it writes
   \`graph.json\` next to a \`commit_report.json\` that says what it committed, what it
   refused and why. Nothing you record is retracted by it — the raw logs stay exactly
   as written.
6. Call \`${config.generateTool}\` to turn the committed graph into a Playwright spec, and read
   what it reports. It is the last thing a run does, and it changes nothing: the graph is
   its only input, so the spec is reproducible from \`graph.json\` alone — the run is not
   the thing being tested. Name the journey by id, by name, or by the words it is a
   journey towards; with exactly one journey in the graph you need not name it, and with
   several the tool refuses rather than picking one, because a spec that clicks through
   the wrong walk is worse than no spec. Then read its \`gaps[]\` — everything the graph
   implies and the spec cannot say, each with a sentence naming what to record. A spec
   with a blocking gap is still written and is *not ok*: it drops the step it could not
   turn into an action, so it would pass without performing it. Fix what the gaps name
   and generate again.

Rules that matter:

- **A negative result is a result.** If the goal cannot be reached, or the app
  misbehaves, observe and report exactly that. Never retry a failed attempt more than
  once, and never report success you did not see.
- **Let the commit refuse.** If \`${config.commitTool}\` reports \`committed: false\` or
  refuses an edge, that is the run working: it means the evidence does not settle
  something, and the report names it. Report those findings as findings — never
  re-record a step differently just to make the commit pass, and never describe the
  run as cleaner than its report says it was. A refused edge that you explain is worth
  more than a graph that hides it.
- **Two states must differ in \`page_type\`, \`variant\` or \`dimensions\`.** If your
  reading is identical to a state you already recorded, you are in that state — say so;
  the tool reuses the existing id instead of minting a duplicate. Do not invent a
  dimension to make a state look new, and do not build one out of what the user has
  typed or clicked: a walk that mints a state per keystroke reports a two-screen app as
  a dozen states. When a step only put something into a field, it is a self-loop on the
  state you were already in.
- **Read the app's own words.** Error and success text is evidence; copy it into
  \`detection\` rather than paraphrasing it.
- **Never write a credential into the graph.** A password field's value is captured as
  \`[set]\` — the collector never records the secret — so a detection asserting one can
  never hold: assert that the field holds something (\`operator: "exists"\`) or that the
  form is gone.
- **Do not claim what you did not see.** If a value, message or element was not in the
  evidence, leave it out. Confidence, not decoration, is what the graph is for.
- **\`${config.observeTool}\` is the only way states reach the graph.** A browser action
  with no \`${config.observeTool}\` after it produces evidence nobody interpreted, and the
  step is lost. Read the state *while the page is showing it*: a reading cannot be made
  afterwards, because the page it would describe has since changed.
- **\`browser_eval\` is an action, not a look.** It runs arbitrary JavaScript in the
  page, so it can change as much as a click can. Read the state after one exactly as you
  would after a click. Prefer \`browser_get_text\` / \`browser_get_html\` when all you want
  is to read something: those are not actions, and they cost nothing to your evidence chain.
- **A reading taken before an action is not evidence of that action.** When a step moves
  the page it has two readings: the one it started from and the one it produced. Only the
  second documents the step — the first is the step's *input*, and the graph records it as
  the step's linkage rather than as evidence of it. So read after acting, not only before:
  a step whose "after" reading is also its "before" reading has no evidence that it did
  anything at all.
- **\`${config.transitionTool}\` needs the step before it to have been read too.** Both
  ends of a transition come from evidence, so a step nobody read has no edge into it and
  no edge out of it.`;
