/**
 * The graph, written out as a Playwright spec.
 *
 * This is the milestone the graph was built for: everything before it produces a *description* of
 * an application, and this is the first thing that consumes one. The file it writes is not a
 * summary of the graph and not a transcript of the walk — it is a program, and a program that
 * asserts something is a claim about the application, so every line in it has to come from the
 * graph rather than from a generator's taste.
 *
 * The plugin's one rule decides the shape of the whole file: **the machinery captures evidence, the
 * model supplies meaning, and the boundary between them is where a claim becomes checkable.** A
 * transition is the model's account of a step; the reading at the end of that step is what the page
 * did; the state's `detection` and the model's own `assertions` are what the model says must be
 * true; the commit's `candidate_assertions` are what the evidence can be read as saying. So:
 *
 *   - the action comes from the transition (what the walk did, and where),
 *   - the interaction comes from the element's role (what a user can do to it),
 *   - the values come from the transition's arguments (what was typed, or that it was *not* kept),
 *   - the checks come from the transition's assertions and the commit's candidates,
 *   - and anything that cannot be rendered is reported rather than approximated.
 *
 * Three deliberate refusals, because each one is a way a generated test lies:
 *
 *   1. **A storage key is never asserted.** The commit's `STATE_VARIABLE_EFFECTS` files a
 *      `storage_changed` under `persistence`, and this is the reason that distinction exists: a
 *      browser can be asked how many rows a list has and cannot be asked what the application
 *      remembers about a user. A generated `expect` on `localStorage` would be a check nobody can
 *      run, so the key is reported as persistence evidence instead.
 *   2. **An element with no role a browser can act on is not clicked.** The role decides the
 *      interaction; a role this file does not know produces a gap naming it, not a `click` on a
 *      `generic` node — "click something" is the assertion that passes for the wrong reason.
 *   3. **A value the run did not keep is not invented.** The store writes `[set]` where a value was
 *      typed and withheld, and that becomes `process.env.TEST_<THING>` plus a `requires` entry —
 *      the spec says out loud what it needs supplied rather than inventing a password.
 *
 * Locators are chosen the way Playwright's own guidance ranks them: the user-facing locator first
 * (a role and an accessible name, which is what a screen reader and a user both use, and what the
 * page itself told the capture), then the application's test id, then the label, placeholder, text
 * or CSS the run recorded. `getByRole` first and `getByTestId` later is not a preference about
 * syntax — a test id is a hook the application author put there for tests, and a role and name is
 * the application saying what the control *is*, which is the thing a regression actually breaks.
 *
 * @module dsh-graph-explorer/generate
 */
import { CONTROL_ROLES, sameCollectionName } from './commit.js';
import { slugify } from './session.js';

/** Quote a value into the spec, so a value with quotes or newlines cannot break the file. */
const quote = (value) => JSON.stringify(String(value));

/**
 * The collection row selector, character for character the one `capture.js` counts rows with.
 *
 * Not a coincidence and not a copy worth diverging from: the commit offers a count as an assertion
 * *because a reading counted those rows*, so a generated check has to count the same rows or the two
 * counts are about different things. `test/generate.test.mjs` asserts this constant is the substring
 * inside `CAPTURE_EXPRESSION`, because a selector edited in one place and not the other would make
 * the assertion quietly about nothing.
 */
export const ROW_SELECTOR = 'li,tr,dt,dd,[role="listitem"],[role="row"],[role="option"]';

/** How the store writes a value it recorded as typed but did not keep. */
export const REDACTED = '[set]';

/** The environment prefix this generator gives to a value the run did not keep. */
export const ENV_PREFIX = 'TEST_';

/**
 * What a browser can do to an element, by the element's role.
 *
 * Playwright's own vocabulary, not this file's: `fill` types into a field, `check` toggles a
 * control, `selectOption` picks from a list, `click` presses a thing. The role is the page's
 * statement about what a control IS, which is why it decides the interaction and an effect type
 * never does — `value_changed` says something changed and `textbox` says how to change it.
 *
 * A role that is not in here is a role this generator will not act on. `generic`, `list`, `table`
 * and `heading` are all things a screen *has*; none of them is something a user *does*, and a
 * `click` invented for one is the assertion that passes for the wrong reason.
 */
export const INTERACTION_BY_ROLE = new Map([
  ['textbox', 'fill'],
  ['searchbox', 'fill'],
  ['combobox', 'selectOption'],
  ['listbox', 'selectOption'],
  ['checkbox', 'check'],
  ['radio', 'check'],
  ['switch', 'check'],
  ['button', 'click'],
  ['link', 'click'],
  ['menuitem', 'click'],
  ['tab', 'click'],
]);

/**
 * The roles a value is read back from with `toHaveValue` rather than `toHaveText`.
 *
 * A form control is asked what it holds and a piece of content is asked what it says, and using the
 * wrong one is a test that fails on a correct application. Kept beside `INTERACTION_BY_ROLE`
 * because both are the same fact — Playwright's vocabulary for a role — read for two purposes.
 */
const VALUE_BEARING_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton']);

/** The words a value the run did not keep is named after, dropped before the env name is built. */
const ENV_NOISE_TOKENS = new Set(['input', 'field', 'box', 'entry', 'element', 'el', 'text']);

/**
 * The environment variable a withheld value is supplied through.
 *
 * `password_input` becomes `TEST_PASSWORD`: the element's semantic purpose is the model's own name
 * for the thing, the role word is the machinery's (`_input`), and the prefix is this generator's
 * convention — a spec that needs a password has to say so somewhere, and an environment variable is
 * the one place a value can be supplied without being invented. Reported in the result's `requires`
 * so the caller knows the spec cannot run until it is set.
 */
export const envVarFor = (purpose) => {
  const tokens = String(purpose ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept = tokens.filter((token) => !ENV_NOISE_TOKENS.has(token));
  const base = (kept.length ? kept : tokens).join('_') || 'value';
  return ENV_PREFIX + base.toUpperCase();
};

/**
 * How a locator becomes a Playwright expression, or `null` when there is nothing usable in it.
 *
 * The order is Playwright's own ranking and the reason is in the module comment: role and accessible
 * name first, because that is the application saying what the control is; the test id next, because
 * it is stable but says nothing about the user; then label, placeholder, text, alt text and title,
 * which are second-hand descriptions of the same thing; then the raw CSS, id or XPath the run
 * recorded, which is the most brittle and the last resort.
 *
 * `strategy` is what was actually used, and `of` is why — both reported, because a locator is a
 * decision and a decision that cannot be read back is one nobody can review.
 */
export function locatorExpression(element) {
  const locator = element?.locator ?? null;
  const strategy = typeof locator?.strategy === 'string' ? locator.strategy : null;
  const value = typeof locator?.value === 'string' ? locator.value.trim() : '';
  const role = typeof element?.role === 'string' ? element.role.trim() : '';
  const name = typeof element?.name === 'string' ? element.name.trim() : '';

  // The element the graph declares with a role a user can act on and the accessible name the page
  // gave it. This outranks the recorded locator on purpose: `element_logout_button` carries both a
  // test id and the role/name pair, and the pair is the thing that stops being true when the button
  // is renamed to "Sign out" — which is a regression worth failing on.
  if (role && name && CONTROL_ROLES.has(role)) {
    return {
      expression: `page.getByRole(${quote(role)}, { name: ${quote(name)} })`,
      strategy: 'role',
      of: `the element's role and accessible name (${role} ${quote(name)}), which the reading recorded`,
    };
  }
  if (strategy === 'role' && value) {
    const accessible = typeof locator.name === 'string' && locator.name.trim() ? `, { name: ${quote(locator.name)} }` : '';
    return { expression: `page.getByRole(${quote(value)}${accessible})`, strategy: 'role', of: 'the role locator the run recorded' };
  }
  if (strategy === 'testid' && value) {
    return { expression: `page.getByTestId(${quote(value)})`, strategy: 'testid', of: "the application's test id" };
  }
  const byText = {
    label: 'getByLabel',
    placeholder: 'getByPlaceholder',
    text: 'getByText',
    alt: 'getByAltText',
    title: 'getByTitle',
  }[strategy];
  if (byText && value) {
    return { expression: `page.${byText}(${quote(value)})`, strategy, of: `the ${strategy} the run recorded` };
  }
  if (strategy === 'id' && value) {
    return { expression: `page.locator(${quote('#' + value)})`, strategy: 'id', of: 'the element id the run recorded' };
  }
  if (strategy === 'xpath' && value) {
    return { expression: `page.locator(${quote('xpath=' + value)})`, strategy: 'xpath', of: 'the XPath the run recorded' };
  }
  if ((strategy === 'css' || strategy === 'name' || strategy === 'href') && value) {
    return { expression: `page.locator(${quote(value)})`, strategy, of: `the ${strategy} the run recorded, which is the last resort rather than the first` };
  }
  return null;
}

/** Every element the graph declares, by id, across every state — a step may target another state's. */
export const elementsById = (graph) => {
  const byId = new Map();
  for (const state of graph?.states ?? []) {
    for (const element of state?.elements ?? []) {
      if (element && typeof element.id === 'string' && !byId.has(element.id)) byId.set(element.id, element);
    }
  }
  return byId;
};

/** Every transition the graph commits, by id. */
export const transitionsById = (graph) => {
  const byId = new Map();
  for (const transition of graph?.transitions ?? []) {
    if (transition && typeof transition.id === 'string') byId.set(transition.id, transition);
  }
  return byId;
};

/** Every state the graph commits, by id. */
export const statesById = (graph) => {
  const byId = new Map();
  for (const state of graph?.states ?? []) {
    if (state && typeof state.id === 'string') byId.set(state.id, state);
  }
  return byId;
};

/** The words a journey is looked up by: its id, its name, its goal, lowercased and split. */
const tokensOf = (text) => String(text ?? '')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((token) => token.length > 1);

/** Words that carry no information about *which* walk is meant. */
const LOOKUP_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'in', 'on', 'is', 'it', 'its', 'with']);

/**
 * Which journey the request means, and how it was found.
 *
 * The request arrives as a phrase — *"the Sign in to Acme Demo App journey"* — and the graph holds
 * ids and the run's own sentence. Exact matching would fail on almost every request a person
 * actually makes, so four things are tried in order of how much they prove: the id, the name, a
 * substring, and finally the words the phrase shares with the journey's id, name and goal.
 *
 * `matched_by` is returned rather than kept private, for the same reason `name_source_kind` exists
 * upstream: a fuzzy match is a guess, and someone reading the generated test is entitled to know
 * which journey was chosen and on what basis. A guess that is wrong is visible in the result and in
 * the spec's header, rather than being a test that clicks through the wrong walk.
 *
 * Several equally good candidates are refused rather than broken by picking one, and nothing at all
 * matching is refused with the list, because the honest answer to "which walk?" is the list.
 */
export function selectJourney(graph, wanted) {
  const journeys = Array.isArray(graph?.journeys) ? graph.journeys : [];
  const summary = (journey) => ({ id: journey.id, name: journey.name ?? null, goal: journey.goal ?? null, transitions: (journey.transitions ?? []).length });
  if (journeys.length === 0) {
    return {
      error: 'the graph has no journeys: nothing in this run was reassembled as a walk through the application. A journey is derived from the committed transitions in walk order, so a run with no committed edge has none.',
      candidates: [],
    };
  }
  const phrase = String(wanted ?? '').trim();
  if (!phrase) {
    if (journeys.length === 1) return { journey: journeys[0], matched_by: 'the only journey in the graph' };
    return {
      error: `the graph holds ${journeys.length} journeys and the request named none of them. Name one by id, by name, or by the words it shares with the walk.`,
      candidates: journeys.map(summary),
    };
  }

  const lower = phrase.toLowerCase();
  const exactId = journeys.filter((journey) => String(journey.id).toLowerCase() === lower);
  if (exactId.length === 1) return { journey: exactId[0], matched_by: `the journey id ${exactId[0].id}, exactly` };
  const exactName = journeys.filter((journey) => String(journey.name ?? '').trim().toLowerCase() === lower);
  if (exactName.length === 1) return { journey: exactName[0], matched_by: `the journey name ${JSON.stringify(exactName[0].name)}, exactly` };

  const contains = journeys.filter((journey) => [journey.id, journey.name, journey.goal]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(lower)));
  if (contains.length === 1) return { journey: contains[0], matched_by: `a substring of ${JSON.stringify(phrase)} against the journey's id, name or goal` };
  if (contains.length > 1) {
    return {
      error: `${JSON.stringify(phrase)} matches ${contains.length} journeys. Say which one by id or by a longer phrase — the candidates are in this result.`,
      candidates: contains.map(summary),
    };
  }

  // Nothing matched literally, so the request was a description rather than a quotation. Scored by
  // how many of the phrase's content words appear in the journey's own words, with the id's words
  // counting too because a journey id is built from the two states it connects.
  const wanted2 = tokensOf(phrase).filter((token) => !LOOKUP_STOPWORDS.has(token));
  if (wanted2.length === 0) {
    return { error: `${JSON.stringify(phrase)} has no words to match a journey on. Name a journey by id or by a phrase it contains.`, candidates: journeys.map(summary) };
  }
  const scored = journeys
    .map((journey) => {
      const words = new Set(tokensOf([journey.id, journey.name, journey.goal].filter(Boolean).join(' ')));
      const hits = wanted2.filter((token) => words.has(token)).length;
      return { journey, hits, score: hits / wanted2.length };
    })
    .sort((left, right) => right.score - left.score || right.hits - left.hits);
  const best = scored[0];
  if (!best || best.hits === 0) {
    return {
      error: `nothing in the graph matches ${JSON.stringify(phrase)}. The journeys this run holds are in this result — name one by id, or explore and commit the walk first.`,
      candidates: journeys.map(summary),
    };
  }
  const tied = scored.filter((entry) => entry.score === best.score && entry.hits === best.hits);
  if (tied.length > 1) {
    return {
      error: `${JSON.stringify(phrase)} fits ${tied.length} journeys equally well (${tied.map((entry) => entry.journey.id).join(', ')}). Name one by id.`,
      candidates: tied.map((entry) => summary(entry.journey)),
    };
  }
  return {
    journey: best.journey,
    matched_by: `${best.hits} of ${wanted2.length} words in ${JSON.stringify(phrase)} occur in the journey's id, name or goal (${wanted2.filter((token) => new Set(tokensOf([best.journey.id, best.journey.name, best.journey.goal].filter(Boolean).join(' '))).has(token)).join(', ')})`,
  };
}

/**
 * The value a step supplies, as an expression, or why it cannot be written.
 *
 * A value the run recorded as `[set]` is a value the store deliberately withheld. It becomes
 * `process.env.TEST_<PURPOSE>!` and a `requires` entry, which is the whole difference between a spec
 * that says what it needs and one that contains an invented password. Every other value is carried
 * through as written, quoted, so a value containing a quote cannot break the file.
 */
function valueExpression(raw, element, ctx) {
  const purpose = element?.semantic?.purpose ?? element?.id ?? null;
  if (typeof raw === 'string' && raw === REDACTED) {
    const name = envVarFor(purpose);
    ctx.requires.set(name, {
      env: name,
      element: element?.id ?? null,
      purpose,
      reason: `the run recorded that a value was typed into ${element?.id ?? 'this element'} but not what it was (the store writes ${quote(REDACTED)}), so the spec reads it from the environment instead of inventing one`,
    });
    return `process.env.${name}!`;
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return JSON.stringify(raw);
  return null;
}

/**
 * The instruction a run is left with when the spec needs a value the store did not keep.
 *
 * `requires` holds records rather than names — `{env, element, purpose, reason}`, because the reason is
 * what a person reads before exporting a secret — so the names have to be read off them. The list
 * itself joined into a sentence instead reads *Set [object Object] before running it*: an instruction
 * no one can follow, in the one sentence a person has to act on before the spec will run at all. A
 * live 0.1.27 run was told exactly that.
 *
 * A function rather than a line in the tool's wrapper, because a sentence about the spec belongs with
 * the generator — and because prose that no suite can see is prose that rots.
 */
export function requiresInstruction(requires) {
    if (!requires.length) return '';
    const names = requires.map((entry) => entry.env).join(', ');
    const elements = requires.map((entry) => entry.element ?? entry.purpose).join(', ');
    return `Set ${names} before running it: the walk recorded that a value was typed into ${elements} `
        + 'but not what it was, so the spec reads it from the environment rather than inventing one. ';
}

/**
 * Whether the machinery's own reading of this step says the value was withheld.
 *
 * `[set]` is written by the *capture*, not by the model: the recorder reads the field before and
 * after the action and files the second reading, so a password that the store redacted appears in
 * the step's effects as `to: "[set]"` whatever the model wrote down as the argument. When the two
 * disagree the argument is the party that is wrong about the value — a model that writes
 * `"[redacted]"` or `"***"` into `arguments` has not kept the value either, and a spec built from
 * its words fills the field with the literal string `[redacted]`, which is a test that fails for a
 * reason that has nothing to do with the application.
 *
 * So the evidence is preferred, and the disagreement is reported rather than quietly resolved: the
 * graph still carries the argument, and a reader of `graph.json` is entitled to know the generator
 * did not believe it.
 */
function withheldByEvidence(transition, element) {
  const purpose = element?.semantic?.purpose ?? null;
  for (const effect of transition?.effects ?? []) {
    if (!effect || effect.type !== 'value_changed' || effect.to !== REDACTED) continue;
    const target = String(effect.target ?? '');
    if (!target) return { target: null };
    if (target === element?.id) return { target };
    if (purpose && sameCollectionName(target, purpose)) return { target };
  }
  return null;
}

/**
 * Which argument of a step is the value it typed, and why.
 *
 * A capability declares its inputs and the transition carries the arguments it was called with.
 * When there is exactly one, it is the value — no judgement to make. When there are several, the
 * argument whose name belongs to the element is taken (`email` for `email_input`), and if none does,
 * the step is written with the first and the choice is reported: picking a value for the wrong field
 * is a test that types a password into an email box and fails for a reason nobody can read.
 */
function argumentFor(transition, element, declared) {
  const entries = Object.entries(transition?.action?.arguments ?? {});
  if (entries.length === 0) return { value: undefined, of: null };
  if (entries.length === 1) return { value: entries[0][1], of: `the only argument the step carried (${entries[0][0]})` };
  const purpose = String(element?.semantic?.purpose ?? '');
  const named = entries.find(([key]) => sameCollectionName(key, purpose));
  if (named) return { value: named[1], of: `the argument named ${JSON.stringify(named[0])}, which is the element's own purpose (${JSON.stringify(purpose)})` };
  return {
    value: entries[0][1],
    of: `the first of ${entries.length} arguments (${entries.map(([key]) => key).join(', ')}), because none of them is named after ${JSON.stringify(purpose)}`,
    ambiguous: entries.map(([key]) => key),
  };
}

/**
 * The spec for one journey, plus everything a reader needs to judge it.
 *
 * Pure: it takes a graph and returns text. Writing the file is the tool's job (`graph_test` in
 * `index.js`), because a generator that wrote files could not be tested without a temporary
 * directory and an effect that belongs at the tool boundary would be hidden inside a judgement.
 *
 * The result reports four kinds of thing about the spec instead of leaving them to be inferred:
 *
 *   - `steps[]`, with the transition, the capability, the element, the locator and the readings each
 *     action came from, so a reviewer can trace a line back to an observation;
 *   - `assertions[]`, each with what put it there (`the model's assertion`, `the state's detection`,
 *     `the evidence the commit read a candidate from`);
 *   - `requires[]`, the values the spec needs from the environment;
 *   - `gaps[]`, everything the graph implies and the spec cannot say, each with an actionable
 *     sentence — these are the model's next exploration, and the reason `ok` is not the same as
 *     "a file was written".
 */
export function generateTest(graph, options = {}) {
  const gaps = [];
  const note = (gap) => { gaps.push(gap); };
  const ctx = { requires: new Map() };
  const states = statesById(graph);
  const elements = elementsById(graph);
  const transitions = transitionsById(graph);
  const capabilities = new Map((graph?.capabilities ?? []).filter((entry) => entry && typeof entry.id === 'string').map((entry) => [entry.id, entry]));

  const selected = selectJourney(graph, options.journey);
  if (selected.error) return { ok: false, spec: null, error: selected.error, candidates: selected.candidates, gaps: [], steps: [], assertions: [], requires: [] };
  const journey = selected.journey;

  const startState = journey.start_state ? states.get(journey.start_state) ?? null : null;
  const route = startState?.identity?.route ?? null;
  if (!route) {
    note({
      code: 'start_state_has_no_route',
      severity: 'warning',
      detail: `journey ${journey.id} starts at ${journey.start_state ?? 'no state'}, which the graph pins to no route. The spec opens "/" — if the application is not served at the root, pass the route or record it by reading the page before the first action.`,
    });
  }

  const testName = typeof options.name === 'string' && options.name.trim()
    ? options.name.trim()
    : String(journey.name ?? journey.id).trim().replace(/[.\s]+$/, '');
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim()
    ? options.baseUrl.trim()
    : (typeof graph?.application?.base_url === 'string' ? graph.application.base_url : null);

  // --- the walk, one transition at a time ------------------------------------------------

  const lines = [];
  const steps = [];
  const assertions = [];
  const emittedAssertions = new Set();
  let previousState = journey.start_state ?? null;
  const transitionIds = Array.isArray(journey.transitions) ? journey.transitions : [];
  if (transitionIds.length === 0) {
    note({
      code: 'journey_has_no_transitions',
      severity: 'error',
      detail: `journey ${journey.id} holds no transitions, so there is nothing to generate. A journey is the committed edges in walk order — commit a walk that moved between two states.`,
    });
  }

  for (const [index, transitionId] of transitionIds.entries()) {
    const transition = transitions.get(transitionId);
    if (!transition) {
      note({
        code: 'transition_not_in_graph',
        severity: 'error',
        detail: `step ${index + 1} of ${journey.id} names ${transitionId}, which is not a transition this graph commits. The step was left out of the spec: a step with no record is a step nobody can say the walk performed.`,
        transition: transitionId,
      });
      continue;
    }
    const stepLines = [];
    const element = transition?.action?.target ? elements.get(transition.action.target) ?? null : null;
    const capability = transition?.action?.capability ? capabilities.get(transition.action.capability) ?? null : null;
    const action = { code: null, value: null, valueOf: null, locator: null };
    const role = typeof element?.role === 'string' ? element.role : '';

    const locator = element ? locatorExpression(element) : null;
    if (!element) {
      note({
        code: 'step_targets_no_element',
        severity: 'error',
        detail: `step ${index + 1} (${transitionId}) carries no element the graph declares as its target, so the spec cannot say what was acted on. Record the element's purpose on the transition (\`target\`) and read the state it belongs to.`,
        transition: transitionId,
      });
    } else if (!locator) {
      note({
        code: 'element_has_no_usable_locator',
        severity: 'error',
        detail: `${element.id} is declared without a locator the spec can use (role ${quote(role || 'none')}, locator ${quote(JSON.stringify(element.locator ?? null))}). Read the element again and declare a locator — a strategy and a value, or a role and an accessible name.`,
        transition: transitionId,
        element: element.id,
      });
    } else {
      action.locator = locator;
    }

    const method = INTERACTION_BY_ROLE.get(role) ?? null;
    if (element && locator && !method) {
      note({
        code: 'role_has_no_interaction',
        severity: 'error',
        detail: `${element.id} has role ${quote(role || 'none')}, which is not a role a browser acts on. The spec cannot invent one: say what a user does to this element (a textbox, a button, a checkbox, a link) and the interaction follows from the role.`,
        transition: transitionId,
        element: element.id,
      });
    } else if (element && locator) {
      action.code = method;
      if (method === 'fill' || method === 'selectOption') {
        let chosen = argumentFor(transition, element, capability);
        // The reading beats the transcription. A step whose own effect says the value was withheld
        // was a value the run never kept, whatever the argument says it was (see
        // `withheldByEvidence`), so the withheld value is what the spec is built from — and the
        // fact that the two disagree is a warning, because the graph is the artifact that is wrong.
        const withheld = withheldByEvidence(transition, element);
        if (withheld && !(typeof chosen.value === 'string' && chosen.value === REDACTED)) {
          note({
            code: 'argument_disagrees_with_the_reading',
            severity: 'warning',
            detail: `step ${index + 1} (${transitionId}) carries ${JSON.stringify(chosen.value)} as the value for ${element.id}, and the reading the same step produced says the value was withheld (${quote(REDACTED)} in the ${withheld.target === null ? 'effect' : `effect on ${quote(withheld.target)}`}). The spec is built from the reading — it reads process.env.${envVarFor(element.semantic?.purpose ?? element.id)} instead — because filling a field with the word the model used to mean "a value was typed here" is a test that fails for a reason nothing to do with the application.`,
            transition: transitionId,
            element: element.id,
          });
          chosen = {
            value: REDACTED,
            of: `the step's own reading, which says the value was typed but not kept (${quote(REDACTED)}) — the argument it carried was ignored`,
          };
        }
        if (chosen.value === undefined) {
          note({
            code: 'step_has_no_value_to_type',
            severity: 'error',
            detail: `step ${index + 1} (${transitionId}) types into ${element.id} and the transition carries no argument to type. Record the argument the capability was called with — a fill with nothing in it checks that the field can be focused, not that the form works.`,
            transition: transitionId,
            element: element.id,
          });
          action.code = null;
        } else {
          const expression = valueExpression(chosen.value, element, ctx);
          if (expression === null) {
            note({
              code: 'argument_is_not_a_scalar',
              severity: 'error',
              detail: `step ${index + 1} (${transitionId}) carries ${JSON.stringify(chosen.value)} as the value for ${element.id}, which is not a string, number or boolean. A spec can only type a scalar.`,
              transition: transitionId,
              element: element.id,
            });
            action.code = null;
          } else {
            action.value = expression;
            action.valueOf = chosen.of;
            if (chosen.ambiguous) {
              note({
                code: 'argument_chosen_of_several',
                severity: 'warning',
                detail: `step ${index + 1} (${transitionId}) carried ${chosen.ambiguous.length} arguments (${chosen.ambiguous.join(', ')}) and none of them is named after ${JSON.stringify(element.semantic?.purpose ?? element.id)}, so the first was used. Name the argument after the element it fills and the choice stops being a guess.`,
                transition: transitionId,
                element: element.id,
              });
            }
          }
        }
      } else if (Object.keys(transition?.action?.arguments ?? {}).length) {
        note({
          code: 'arguments_ignored_for_this_interaction',
          severity: 'info',
          detail: `step ${index + 1} (${transitionId}) carries ${Object.keys(transition.action.arguments).join(', ')} and the interaction is ${method}, which takes no value. The arguments are kept in the graph and are not written into the spec.`,
          transition: transitionId,
          element: element.id,
        });
      }
    }

    // The composite check. A capability declared as `composed_of` other capabilities is a claim
    // about how the behaviour is built, and a step that uses it as one action is only faithful to
    // the graph if the parts are also steps of *this* action. When no part's own transition targets
    // the step's target, the composition names something else — which is what a composite that
    // absorbed two field fills into a submit looks like from here.
    if (capability && capability.kind === 'composite' && Array.isArray(capability.composed_of) && capability.composed_of.length) {
      const parts = capability.composed_of.map((id) => capabilities.get(id)).filter(Boolean);
      const partTargets = new Set(parts.flatMap((part) => (graph?.transitions ?? [])
        .filter((entry) => entry?.action?.capability === part.id && entry.action.target)
        .map((entry) => entry.action.target)));
      const unmatched = parts.filter((part) => !(graph?.transitions ?? []).some((entry) => entry?.action?.capability === part.id));
      if (unmatched.length) {
        note({
          code: 'composite_part_never_walked',
          severity: 'warning',
          detail: `${capability.id} is composed of ${unmatched.map((part) => part.id).join(', ')}, and no committed transition performs ${unmatched.length > 1 ? 'them' : 'it'}. The spec writes the step as one ${action.code ?? 'action'} on ${element?.id ?? 'its target'}, which is what the walk did; the composition is a claim the walk never produced evidence for.`,
          transition: transitionId,
          element: element?.id ?? null,
        });
      } else if (element && !partTargets.has(element.id)) {
        note({
          code: 'composite_step_targets_a_different_element',
          severity: 'warning',
          detail: `${capability.id} is composed of ${parts.map((part) => part.id).join(', ')}, and those steps act on ${[...partTargets].map((id) => id ?? 'nothing').join(', ')} — not on ${element.id}, which is what this step acts on. The spec follows the walk (the transition) rather than the composition; if ${capability.id} really is ${parts.map((part) => part.name ?? part.id).join(' then ')}, the walk is missing the step that acts on ${element.id} and ${capability.id} should be composed of that.`,
          transition: transitionId,
          element: element.id,
        });
      }
    }

    // --- the action line -------------------------------------------------------------------
    if (action.code && action.locator) {
      const call = action.value !== null
        ? `${action.locator.expression}.${action.code}(${action.value});`
        : `${action.locator.expression}.${action.code}();`;
      stepLines.push(`  await ${call}`);
    }

    // --- what the step claims, and what the evidence supports ------------------------------
    //
    // Three sources, in this order, and the order is a decision: the state the step arrived in,
    // then the model's own assertions about the step, then everything else the machinery read a
    // candidate from. A reader going down the generated test sees "we are here", then "the model
    // said this", then "the evidence says that" — which is the commit's own account of where a
    // claim came from, in the order it would be defended.
    const commit = transition?.metadata?.extra?.commit ?? {};
    const candidates = Array.isArray(commit.candidate_assertions) ? commit.candidate_assertions : [];
    // A `state` candidate is the commit reading `state_entered` off the step's own effects, and it
    // says the same thing the arrival block below says from `state.detection` — which is the more
    // complete of the two, because it carries the state's route as well. Skipped here rather than
    // emitted and deduped: a duplicate that exists only to be dropped is noise in `assertions[]`,
    // and the candidate's evidence is still in the graph for anyone reading the commit's report.
    const evidenceCandidates = candidates.filter((candidate) => candidate?.assertion?.type !== 'state');
    const modelAssertions = Array.isArray(transition.assertions) ? transition.assertions : [];
    const arrived = transition.to_state !== previousState;

    /**
     * Render one assertion and queue its line, or explain why it cannot be rendered.
     *
     * `source` and `basis` both travel with the line: `source` says which of the three lists it came
     * from, `basis` says what the commit read it from (`effect`, `dimension`, …). A generated check
     * whose provenance is a mystery is a check nobody can delete when the application legitimately
     * changes.
     */
    const render = (assertion, source, basis, detail) => {
      const outcome = renderAssertion(assertion, { states, elements, route, arrived, previousState });
      if (outcome.gap) {
        note({ ...outcome.gap, transition: transitionId, element: outcome.element ?? null });
        return;
      }
      for (const line of outcome.lines) {
        const key = line.text;
        if (emittedAssertions.has(key)) {
          assertions.push({
            line: line.text,
            source,
            basis,
            detail,
            of: line.of,
            duplicate_of: emittedAssertions.has(key) ? assertions.find((entry) => entry.line === key)?.of ?? null : null,
            omitted_from_spec: true,
          });
          continue;
        }
        emittedAssertions.add(key);
        stepLines.push(`  await ${line.text}`);
        assertions.push({ line: line.text, source, basis, detail, of: line.of, omitted_from_spec: false });
      }
    };

    // The state the step arrived in, checked by the way the graph says that screen is recognised.
    //
    // Deliberately *not* driven by the candidates. A candidate is the commit reading the evidence,
    // and the evidence only supports a `state` assertion when the step's own effects claim
    // `state_entered`; but a test that walks to a screen has to check it is there whatever the
    // effects say, and `state.detection` is the model's own answer to "how do I know I am here".
    // Tying this to the candidates made a generated test that reached a screen and asserted nothing
    // about it whenever the walk had not said so in an effect — which is exactly the case the
    // signal was for. When a `state` candidate does exist its lines come out identical and are
    // dropped as duplicates, so the two paths cannot disagree.
    if (arrived) {
      const named = states.get(transition.to_state);
      if (!named) {
        note({
          code: 'arrival_state_is_not_in_the_graph',
          severity: 'error',
          detail: `step ${index + 1} (${transitionId}) arrives in ${transition.to_state}, which is not a state this graph commits, so the spec cannot check that it got there.`,
          transition: transitionId,
        });
      } else {
        const before = previousState ? states.get(previousState) ?? null : null;
        const beforeRoute = before?.identity?.route ?? route;
        if (named.identity?.route && named.identity.route !== beforeRoute) {
          render(
            { type: 'url', operator: 'equals', expected: named.identity.route, description: `the route ${named.id} is pinned to` },
            'the arrival state',
            'state',
            `step ${index + 1} arrived in ${named.id}, which the graph pins to ${named.identity.route}`,
          );
        }
        const detection = Array.isArray(named.detection) ? named.detection : [];
        if (detection.length === 0) {
          note({
            code: 'arrival_state_has_no_detection',
            severity: 'warning',
            detail: `step ${index + 1} arrives in ${named.id}, which declares no detection, so the spec cannot check that the walk got there. Give the state a detection — an element that is only on that screen — and the generated test will assert it.`,
            transition: transitionId,
          });
        }
        for (const entry of detection) render(entry, 'the arrival state', 'state detection', `${named.id} declares it as how the screen is recognised`);
      }
    }
    for (const assertion of modelAssertions) {
      render(assertion, "the model's assertion", 'model', `the walk claimed it on ${transitionId}`);
    }
    for (const candidate of evidenceCandidates) {
      render(candidate.assertion, 'the evidence', candidate.basis ?? null, candidate.detail ?? null);
    }

    // A `storage_changed` effect is the run's proof that the session survives a reload, and it is
    // *not* an assertion: no browser can be asked what the application remembers. Reported so the
    // reader knows the evidence exists and what it is for.
    const persistence = (transition.effects ?? [])
      .filter((effect) => effect?.type === 'storage_changed' && typeof effect.target === 'string')
      .map((effect) => effect.target);
    if (persistence.length) {
      note({
        code: 'persistence_evidence_not_asserted',
        severity: 'info',
        detail: `${transitionId} shows the application wrote ${persistence.join(', ')}. A browser cannot be asked what a key holds, so the spec does not check it: the evidence is that this state survives a reload, which a test asserts by reloading and re-checking the state's detection.`,
        transition: transitionId,
      });
    }

    steps.push({
      index: index + 1,
      transition: transitionId,
      from_state: transition.from_state ?? null,
      to_state: transition.to_state ?? null,
      capability: transition?.action?.capability ?? null,
      capability_kind: capability?.kind ?? null,
      element: element?.id ?? null,
      // What the action was, and what decided it: the role is why the method is a `fill` and not a
      // `click`, and the locator's own `of` says why it reads the way it does.
      interaction: action.code,
      interaction_basis: element ? `the role ${quote(role || 'none')} of ${element.id}` : null,
      locator: action.locator?.expression ?? null,
      locator_of: action.locator?.of ?? null,
      value: action.value,
      value_of: action.valueOf,
      lines: stepLines.map((line) => line.trim()),
      readings: (transition.evidence ?? [])
        .filter((ref) => ref && typeof ref.observation === 'string')
        .map((ref) => ({ observation: ref.observation, role: ref.role ?? null })),
      committed: commit.decision ?? null,
    });
    previousState = transition.to_state ?? previousState;
  }

  // --- the file ---------------------------------------------------------------------------

  const header = [
    '/**',
    ' * Generated from a committed graph — not written by hand.',
    ' *',
    ` * Application: ${graph?.application?.name ?? 'unknown'}${graph?.application?.id ? ` (${graph.application.id})` : ''}`,
    ` * Journey:     ${journey.id}${journey.goal ? ` — ${JSON.stringify(journey.goal)}` : ''}`,
    ` * Graph:       generated ${graph?.generated_at ?? 'at an unrecorded time'} by ${graph?.generator?.name ?? 'an unknown generator'} ${graph?.generator?.version ?? ''}`.trimEnd(),
    ` * Base URL:    ${baseUrl ?? 'not recorded'} — the spec navigates by route, so set \`use.baseURL\` to this.`,
    ` * Readings:    ${[...new Set(steps.flatMap((step) => step.readings.map((reading) => reading.observation)))].join(', ') || 'none'}`,
    ' *',
    ` * ${steps.filter((step) => step.interaction).length} of ${transitionIds.length} step(s) became an action; ${assertions.filter((entry) => !entry.omitted_from_spec).length} check(s) were written, from ${assertions.length} the graph supports.`,
    ...(gaps.length ? [` * ${gaps.length} gap(s) were reported by the generator: see the tool result, not this file.`] : []),
    ' */',
  ];

  const body = [
    'import { test, expect } from "@playwright/test";',
    '',
    ...header,
    `test(${JSON.stringify(testName)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(route ?? '/')});`,
  ];
  for (const step of steps) {
    if (step.lines.length === 0) continue;
    body.push('');
    for (const line of step.lines) body.push(`  ${line}`);
  }
  body.push('});');

  const errorCount = gaps.filter((gap) => gap.severity === 'error').length;
  return {
    ok: errorCount === 0,
    spec: body.join('\n') + '\n',
    filename: `${slugify(journey.id)}.spec.ts`,
    test_name: testName,
    matched_by: selected.matched_by,
    journey: {
      id: journey.id,
      name: journey.name ?? null,
      goal: journey.goal ?? null,
      start_state: journey.start_state ?? null,
      transitions: transitionIds,
    },
    application: {
      id: graph?.application?.id ?? null,
      name: graph?.application?.name ?? null,
      base_url: baseUrl,
      route: route ?? '/',
    },
    steps,
    assertions,
    requires: [...ctx.requires.values()],
    gaps,
    counts: {
      transitions: transitionIds.length,
      actions: steps.filter((step) => step.interaction).length,
      assertions: assertions.filter((entry) => !entry.omitted_from_spec).length,
      gaps: gaps.length,
      blocking_gaps: errorCount,
    },
  };
}

/**
 * One assertion of the graph, as one or more `expect` calls, or a gap saying why not.
 *
 * Every branch here is a translation from the schema's closed vocabulary into Playwright's, and the
 * two do not line up: the schema says `{type: element_state, operator: equals, expected: "visible"}`
 * and Playwright says `toBeVisible()`. The translations are the point of this function and each one
 * is deliberate:
 *
 *   - `visible`/`hidden`/`enabled`/`disabled` are matchers, not values, so `expected` picks the
 *     matcher and `operator` picks its negation;
 *   - a form control is read with `toHaveValue` and anything else with `toHaveText`, because a
 *     textbox holds a value and a generic node says something;
 *   - a dimension (`{type: value, target: projects, operator: greater_than}`) is a count on the
 *     collection the dimension names, which is only writable because `capture.js` counts rows — and
 *     the element is found with the commit's own `sameCollectionName`, so the generator and the
 *     commit agree about which collection a dimension means;
 *   - `url` is matched as a route, not as a host: the same graph is committed against staging and
 *     production, and `http://127.0.0.1:4173/` is true of one machine.
 *
 * A `state` assertion expands into the named state's route and detection, because that is what a
 * state assertion means: "the page is this screen". Rendering it as anything else — a marker
 * attribute, a title — would be the generator inventing the application's own signal.
 */
export function renderAssertion(assertion, ctx) {
  const type = assertion?.type;
  const operator = typeof assertion?.operator === 'string' ? assertion.operator : 'equals';
  const negated = operator === 'not_equals' || operator === 'not_contains';
  const not = negated ? 'not.' : '';
  const element = assertion?.element ? ctx.elements.get(assertion.element) ?? null : null;
  const locator = element ? locatorExpression(element) : null;
  const expected = assertion?.expected;

  const elementLine = (matcher, of) => {
    if (!element) return { gap: { code: 'assertion_names_no_element', severity: 'error', detail: `an assertion of type ${quote(type)} names ${quote(String(assertion?.element ?? assertion?.target ?? ''))} and no state in this graph declares it. The check was left out: an assertion on nothing is a test that cannot fail.` } };
    if (!locator) return { gap: { code: 'assertion_element_has_no_usable_locator', severity: 'error', detail: `${element.id} is asserted and carries no locator the spec can use (${JSON.stringify(element.locator ?? null)}). Read the element again and give it a strategy and a value, or a role and an accessible name.` }, element: element.id };
    return { lines: [{ text: `expect(${locator.expression}).${matcher};`, of }] };
  };

  if (type === 'url') {
    const route = typeof expected === 'string' ? expected : (typeof assertion.target === 'string' ? assertion.target : null);
    if (!route) return { gap: { code: 'url_assertion_has_no_route', severity: 'error', detail: 'a `url` assertion carries no route to check. Record the route on the assertion (`expected`), or the state it belongs to.' } };
    return { lines: [{ text: `expect(page).${operator === 'not_equals' ? 'not.' : ''}toHaveURL(${JSON.stringify(route)});`, of: 'the route the graph pins this screen to' }] };
  }

  if (type === 'state') {
    const named = ctx.states.get(assertion.state);
    if (!named) return { gap: { code: 'state_assertion_names_no_state', severity: 'error', detail: `a \`state\` assertion names ${quote(String(assertion.state ?? ''))}, which this graph does not commit.` } };
    const detection = Array.isArray(named.detection) ? named.detection : [];
    if (detection.length === 0) {
      return { gap: { code: 'state_assertion_names_a_state_without_detection', severity: 'warning', detail: `${named.id} is asserted and declares no detection, so there is nothing the spec can check to know the screen is this one.` }, element: named.id };
    }
    const lines = [];
    for (const entry of detection) {
      const outcome = renderAssertion(entry, ctx);
      if (outcome.gap) return outcome;
      lines.push(...outcome.lines.map((line) => ({ ...line, of: `${named.id} recognises itself by it (${line.of})` })));
    }
    return { lines };
  }

  if (type === 'element_state' || type === 'absence') {
    // The state the check wants, reduced to one of the four matchers Playwright has. A negation is
    // folded into the value rather than written as `not.`: `not.toBeHidden()` and `toBeVisible()`
    // are the same claim, and the second one is the one a person reads without inverting it first.
    // `absence` is its own claim — the graph says the element is gone on this screen — so an
    // operator on it is not a second negation.
    const OPPOSITE = { visible: 'hidden', hidden: 'visible', enabled: 'disabled', disabled: 'enabled' };
    const wanted = typeof expected === 'string' ? expected : 'visible';
    const want = type === 'absence' ? 'hidden' : (negated ? OPPOSITE[wanted] ?? wanted : wanted);
    const matcher = {
      visible: 'toBeVisible()',
      hidden: 'toBeHidden()',
      enabled: 'toBeEnabled()',
      disabled: 'toBeDisabled()',
    }[want];
    if (!matcher) {
      return { gap: { code: 'element_state_has_no_matcher', severity: 'error', detail: `an assertion wants ${element?.id ?? 'an element'} to be ${quote(String(want))}, and Playwright has no matcher for that. Use visible, hidden, enabled or disabled.` }, element: element?.id };
    }
    return elementLine(matcher, type === 'absence' ? 'the graph says it is gone on this screen' : `the graph says ${quote(String(want))} is how it is checked`);
  }

  if (type === 'element_value' || type === 'value' || type === 'message') {
    // A dimension: the target is a name the state's identity uses, not an element, so the element is
    // the collection on the arrival state whose purpose names it — matched with the commit's own
    // tolerant rule, because `projects` and `project_list` are two spellings of one collection.
    if (type === 'value' && !element) {
      const named = String(assertion.target ?? '');
      const collections = [...ctx.elements.values()].filter((entry) => sameCollectionName(entry.semantic?.purpose ?? '', named) || sameCollectionName(entry.id, named));
      if (collections.length === 0) {
        return { gap: { code: 'dimension_maps_to_no_element', severity: 'warning', detail: `the dimension ${quote(named)} is asserted as a count and no element in this graph could be the collection it names. Declare the collection as an element with a semantic purpose — the reading counted its rows, so the test could too.` } };
      }
      if (collections.length > 1) {
        return { gap: { code: 'dimension_could_be_more_than_one_element', severity: 'warning', detail: `the dimension ${quote(named)} could be ${collections.map((entry) => entry.id).join(' or ')}, and a count of one is not a check of the other. Name the dimension after the element it means.` } };
      }
      const collection = collections[0];
      const collectionLocator = locatorExpression(collection);
      if (!collectionLocator) {
        return { gap: { code: 'collection_has_no_usable_locator', severity: 'error', detail: `${collection.id} holds the rows ${quote(named)} counts and carries no locator the spec can use.` }, element: collection.id };
      }
      const count = typeof expected === 'number' ? expected : null;
      if (count === null) {
        return { gap: { code: 'dimension_count_is_not_a_number', severity: 'error', detail: `${quote(named)} is asserted as ${quote(operator)} ${JSON.stringify(expected ?? null)}, which is not a number to count to.` }, element: collection.id };
      }
      const matcher = operator === 'equals' ? `toHaveCount(${count})` : operator === 'greater_than' ? `not.toHaveCount(${count})` : null;
      if (!matcher) {
        return { gap: { code: 'dimension_operator_has_no_matcher', severity: 'warning', detail: `${quote(named)} is asserted as ${quote(operator)} ${count}; Playwright counts rows exactly, so the spec can check equals or greater_than and not ${quote(operator)}.` }, element: collection.id };
      }
      return {
        lines: [{
          text: `expect(${collectionLocator.expression}.locator(${JSON.stringify(ROW_SELECTOR)})).${matcher};`,
          of: `${named} is a dimension of the state and ${collection.id} holds its rows, which the reading counted the same way`,
        }],
      };
    }

    const value = valueExpression(expected, element, ctx);
    if (value === null) {
      return { gap: { code: 'assertion_expected_nothing_comparable', severity: 'warning', detail: `an assertion of type ${quote(type)} on ${element?.id ?? quote(String(assertion.target ?? ''))} expects ${JSON.stringify(expected ?? null)}, which is not a value a spec can compare against.` }, element: element?.id };
    }
    // A form control is asked what it holds; anything else is asked what it says. Getting this
    // backwards is a test that fails on a correct application.
    const readsValue = VALUE_BEARING_ROLES.has(String(element?.role ?? ''));
    const matcher = {
      contains: readsValue ? 'toHaveValue' : 'toContainText',
      not_contains: readsValue ? 'not.toHaveValue' : 'not.toContainText',
      equals: readsValue ? 'toHaveValue' : 'toHaveText',
      not_equals: readsValue ? 'not.toHaveValue' : 'not.toHaveText',
    }[operator];
    if (!matcher) {
      return { gap: { code: 'assertion_operator_has_no_matcher', severity: 'warning', detail: `an assertion on ${element?.id ?? 'an element'} uses ${quote(operator)}, which the generated spec does not write. equals, not_equals, contains and not_contains are rendered; anything else would be a comparison the generator invented.` }, element: element?.id };
    }
    if (!element) {
      return { gap: { code: 'value_assertion_targets_no_element', severity: 'warning', detail: `an assertion expects ${JSON.stringify(expected ?? null)} and names ${quote(String(assertion.target ?? ''))}, which is not an element this graph declares. A generated check needs something to check.` } };
    }
    return elementLine(`${matcher}(${value})`, readsValue ? `${element.id} holds a value, so the spec reads it back` : `${element.id} says something, so the spec reads its text`);
  }

  // The schema's remaining types are honest about what they are, and none of them is a `expect`:
  // an `api` assertion is about the wire, an `effect` assertion is about the graph's own model, and
  // a `custom` assertion is code this generator does not have.
  const advice = {
    api: 'a browser cannot assert the wire — assert the surface the call produced, or check the API in its own test',
    effect: 'an `effect` assertion describes the graph, not the page; assert the element or the value the effect moved',
    custom: 'a `custom` assertion is code the generator does not have; write it by hand where it belongs',
  }[type] ?? `Playwright has no rendering for an assertion of type ${quote(String(type))}`;
  return { gap: { code: 'assertion_type_not_renderable', severity: 'warning', detail: `${advice}.` } };
}
