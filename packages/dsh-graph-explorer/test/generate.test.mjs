/**
 * The generator's rules, one at a time, against a graph that is written here rather than walked.
 *
 * The split is the same one `commit.test.mjs` makes and for the same reason: the real artifact
 * (`~/tmp/graph-run/graph.json`) can only show the cases it happens to contain, and a rule that only
 * fires on a graph nobody has made yet is a rule nobody has run. So the fixture below is a whole
 * application in miniature — two screens, three steps, a composite capability, a redacted password,
 * a stored session and a collection count — and the rest of the file drives one rule at a time
 * through the pure functions.
 *
 * What this suite is protecting, in order of how much it would hurt to lose:
 *
 *   1. **The spec is a program whose every line came from the graph.** The body is compared
 *      character for character, so a locator that starts reading a different field, an assertion
 *      that quietly stops being emitted, or a matcher that gains a double negation is a failing
 *      test rather than a plausible-looking file.
 *   2. **The three refusals hold.** A storage key is never asserted, an element with no actionable
 *      role is never clicked, and a value the run did not keep is never invented.
 *   3. **The row selector is the capture's own.** The assertion the commit offers exists because a
 *      reading counted rows, so the generated count has to count the same rows.
 *   4. **Ambiguity is refused rather than guessed.** A journey phrase that fits two walks, a
 *      dimension that matches two elements, an argument chosen out of several: each one is reported.
 *
 * No browser, no `dsh`, no temporary directory: a graph is an object and a spec is a string.
 */
import { CAPTURE_EXPRESSION } from '../lib/capture.js';
import { ENV_PREFIX, INTERACTION_BY_ROLE, REDACTED, ROW_SELECTOR, elementsById, envVarFor, generateTest, locatorExpression, renderAssertion, requiresInstruction, selectJourney, statesById } from '../lib/generate.js';

let fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fails++; console.log('FAIL', label, '\n  actual  ', JSON.stringify(actual), '\n  expected', JSON.stringify(expected)); }
  else console.log('ok  ', label);
};

// --- the fixture ----------------------------------------------------------
// An application with a login screen and a project list, walked by three steps. Every shape here is
// one the real commit produces: the elements are declared on the states that show them, the
// transitions carry the arguments the capability was called with, and the candidates the commit
// derived live where the commit puts them.

const element = (id, over = {}) => ({
  id,
  role: 'generic',
  name: null,
  locator: { strategy: 'css', value: `#${id}` },
  semantic: { purpose: id.replace(/^element_/, '') },
  ...over,
});

const base = () => ({
  schema_version: '1.0.0',
  generated_at: '2026-09-17T21:01:49.686Z',
  generator: { name: '@webtestagent/dsh-graph-explorer', version: '0.1.21' },
  application: { id: 'app_demo', name: 'Demo App', base_url: 'http://127.0.0.1:4173/' },
  states: [
    {
      id: 'state_login',
      name: 'Login',
      identity: { route: '/login' },
      detection: [{ type: 'element_state', element: 'element_sign_in_button', operator: 'equals', expected: 'visible' }],
      elements: [
        element('element_email_input', { role: 'textbox', name: 'Email', locator: { strategy: 'css', value: '#email' } }),
        element('element_password_input', { role: 'textbox', name: 'Password', locator: { strategy: 'css', value: '#password' } }),
        element('element_sign_in_button', { role: 'button', name: 'Sign in', locator: { strategy: 'testid', value: 'sign-in' } }),
      ],
    },
    {
      id: 'state_projects',
      name: 'Projects',
      identity: { route: '/projects', dimensions: { projects: 'non_empty' } },
      detection: [
        { type: 'element_state', element: 'element_logout_button', operator: 'equals', expected: 'visible' },
        { type: 'value', target: 'projects', operator: 'greater_than', expected: 0 },
      ],
      elements: [
        element('element_logout_button', { role: 'button', name: 'Log out', locator: { strategy: 'testid', value: 'logout' } }),
        element('element_current_user', { role: 'generic', locator: { strategy: 'testid', value: 'current-user' } }),
        element('element_project_list', { role: 'list', locator: { strategy: 'testid', value: 'project-list' }, semantic: { purpose: 'project_list' } }),
      ],
    },
  ],
  capabilities: [
    { id: 'cap_fill_login_email', name: 'Fill the email', kind: 'interaction' },
    { id: 'cap_fill_login_password', name: 'Fill the password', kind: 'interaction' },
    { id: 'cap_submit_login', name: 'Submit the form', kind: 'interaction' },
    { id: 'cap_login', name: 'Log in', kind: 'composite', composed_of: ['cap_fill_login_email', 'cap_fill_login_password', 'cap_submit_login'] },
  ],
  transitions: [
    {
      id: 'transition_fill_login_email',
      from_state: 'state_login',
      to_state: 'state_login',
      action: { capability: 'cap_fill_login_email', target: 'element_email_input', arguments: { email: 'test@example.com' } },
      effects: [],
      assertions: [],
      evidence: [{ observation: 'obs_0001', role: 'identity' }, { observation: 'obs_0002', role: 'action' }],
    },
    {
      id: 'transition_fill_login_password',
      from_state: 'state_login',
      to_state: 'state_login',
      action: { capability: 'cap_fill_login_password', target: 'element_password_input', arguments: { password: REDACTED } },
      effects: [],
      assertions: [],
    },
    {
      id: 'transition_login',
      from_state: 'state_login',
      to_state: 'state_projects',
      action: { capability: 'cap_login', target: 'element_sign_in_button', arguments: { email: 'test@example.com', password: REDACTED } },
      effects: [
        { type: 'state_entered', target: 'state_projects' },
        { type: 'storage_changed', target: 'localStorage.demo-state', to: 'set' },
        { type: 'element_destroyed', target: 'element_email_input' },
      ],
      assertions: [{ type: 'element_value', element: 'element_current_user', operator: 'equals', expected: 'test@example.com' }],
      metadata: {
        extra: {
          commit: {
            decision: 'committed',
            candidate_assertions: [
              { assertion: { type: 'state', state: 'state_projects', operator: 'equals' }, basis: 'effect', detail: 'state_entered' },
              { assertion: { type: 'url', operator: 'equals', expected: '/projects' }, basis: 'effect', detail: 'the route the step arrived at' },
              { assertion: { type: 'element_state', element: 'element_logout_button', operator: 'equals', expected: 'visible' }, basis: 'effect', detail: 'the control the step created' },
              { assertion: { type: 'value', target: 'projects', operator: 'greater_than', expected: 0 }, basis: 'dimension', detail: 'the reading counted 2 rows' },
            ],
          },
        },
      },
    },
    // The submission as its own capability. This edge is the same click `transition_login` performs,
    // recorded against the capability that did it rather than against the whole behaviour — which is
    // what the composite's `composed_of` has to be true against. Without it `cap_login` claims a part
    // the walk never performed, and the composite check below says so with
    // `composite_part_never_walked`: the live failure this fixture exists to keep fixed.
    {
      id: 'transition_submit_login',
      from_state: 'state_login',
      to_state: 'state_projects',
      action: { capability: 'cap_submit_login', target: 'element_sign_in_button', arguments: {} },
      effects: [],
      assertions: [],
    },
  ],
  journeys: [
    {
      id: 'journey_login',
      name: 'Sign in to Demo App',
      goal: 'Using the browser tools, open the demo app and sign in as test@example.com.',
      start_state: 'state_login',
      transitions: ['transition_fill_login_email', 'transition_fill_login_password', 'transition_login'],
    },
  ],
});

/** A rendering context, built the way `generateTest` builds it. */
const ctxFor = (graph) => ({ elements: elementsById(graph), states: statesById(graph), requires: new Map() });

/** What an assertion renders as: the lines, or the code of the gap that refused it. */
const rendered = (assertion, graph = base()) => {
  const outcome = renderAssertion(assertion, ctxFor(graph));
  return outcome.lines ? outcome.lines.map((line) => line.text) : [`gap:${outcome.gap.code}`];
};

// --- the constants that must not drift -------------------------------------
// The commit offers a count as an assertion *because a reading counted rows*, and the reading is
// `capture.js`. A selector edited there and not here would leave the generated check counting a
// different set of things than the evidence did — the assertion would still pass, and it would be
// about nothing.
check('the row selector is the one the capture counts rows with', CAPTURE_EXPRESSION.includes(ROW_SELECTOR), true);
check('and the redaction marker is the one the store writes, with this generator\'s own env prefix',
  [REDACTED, ENV_PREFIX], ['[set]', 'TEST_']);

// --- the environment name for a value nobody kept --------------------------
check('a withheld password becomes an environment variable named after its purpose', envVarFor('password_input'), 'TEST_PASSWORD');
check('so does an email', envVarFor('email_input'), 'TEST_EMAIL');
check('a name with no noise token keeps all of it', envVarFor('sign_in_button'), 'TEST_SIGN_IN_BUTTON');
check('a name that is nothing but noise falls back to the noise rather than to nothing', envVarFor('box'), 'TEST_BOX');
check('and no purpose at all still produces a name a caller can set', envVarFor(null), 'TEST_VALUE');

// --- locators, in Playwright's own order -----------------------------------
const locatorOf = (over) => {
  const found = locatorExpression(element('element_thing', over));
  return found ? [found.expression, found.strategy] : null;
};
// The role and the accessible name outrank the test id even when the graph carries both: a test id
// is a hook the application put there for tests, and the role and name is the application saying
// what the control is — which is the thing a rename breaks.
check('a role and an accessible name beat the test id the same element carries',
  locatorOf({ role: 'button', name: 'Log out', locator: { strategy: 'testid', value: 'logout' } }),
  ['page.getByRole("button", { name: "Log out" })', 'role']);
check('a role with no accessible name falls back to what the run recorded',
  locatorOf({ role: 'button', locator: { strategy: 'testid', value: 'logout' } }),
  ['page.getByTestId("logout")', 'testid']);
// The role and name outrank the recorded locator only on a role a user can act on — the same set
// the commit uses to decide what a screen *is* (`CONTROL_ROLES`), so the two rules cannot drift
// apart. A heading or a list is something a screen holds, and `getByRole("generic", …)` is a locator
// that matches everything, so for those the recorded locator is the better one.
check('a role and a name on something a user cannot act on keeps the locator the run recorded',
  locatorOf({ role: 'heading', name: 'Welcome', locator: { strategy: 'testid', value: 'welcome' } }),
  ['page.getByTestId("welcome")', 'testid']);
check('a recorded role locator is used as a role', locatorOf({ locator: { strategy: 'role', value: 'button', name: 'Sign in' } }),
  ['page.getByRole("button", { name: "Sign in" })', 'role']);
check('a label is used as a label', locatorOf({ locator: { strategy: 'label', value: 'Email' } }), ['page.getByLabel("Email")', 'label']);
check('a placeholder is used as a placeholder', locatorOf({ locator: { strategy: 'placeholder', value: 'you@example.com' } }), ['page.getByPlaceholder("you@example.com")', 'placeholder']);
check('text is used as text', locatorOf({ locator: { strategy: 'text', value: 'Sign in' } }), ['page.getByText("Sign in")', 'text']);
check('an id is a css locator', locatorOf({ locator: { strategy: 'id', value: 'email' } }), ['page.locator("#email")', 'id']);
check('an xpath says so', locatorOf({ locator: { strategy: 'xpath', value: '//button' } }), ['page.locator("xpath=//button")', 'xpath']);
check('and a raw css selector is the last resort, which the reason says out loud',
  locatorExpression(element('element_thing', { locator: { strategy: 'css', value: 'form > input' } })).of.includes('last resort'), true);
check('an element with nothing usable has no locator at all', locatorExpression(element('element_thing', { locator: null })), null);
check('and a locator with an empty value is not a locator', locatorExpression(element('element_thing', { locator: { strategy: 'testid', value: '  ' } })), null);
check('the interactions are the browser vocabulary the roles decide',
  [INTERACTION_BY_ROLE.get('textbox'), INTERACTION_BY_ROLE.get('checkbox'), INTERACTION_BY_ROLE.get('combobox'), INTERACTION_BY_ROLE.get('button'), INTERACTION_BY_ROLE.get('heading') ?? null],
  ['fill', 'check', 'selectOption', 'click', null]);

// --- choosing the journey --------------------------------------------------
// Four things are tried in order of how much they prove, and the answer says which one fired. A
// fuzzy match is a guess, and a guess a reader cannot see is indistinguishable from a quotation.
const one = { journeys: [base().journeys[0]] };
check('a graph with no journey is refused with nothing to offer', selectJourney({ journeys: [] }, 'anything'),
  { error: 'the graph has no journeys: nothing in this run was reassembled as a walk through the application. A journey is derived from the committed transitions in walk order, so a run with no committed edge has none.', candidates: [] });
check('the only journey in the graph needs no naming',
  [selectJourney(one, undefined).journey.id, selectJourney(one, undefined).matched_by],
  ['journey_login', 'the only journey in the graph']);
const two = { journeys: [base().journeys[0], { ...base().journeys[0], id: 'journey_signup', name: 'Sign up' }] };
check('several journeys and no name is refused, with the list',
  [selectJourney(two, '   ').candidates.map((entry) => entry.id), selectJourney(two, undefined).error.includes('2 journeys')],
  [['journey_login', 'journey_signup'], true]);
check('an id selects it exactly', selectJourney(two, 'journey_signup').matched_by, 'the journey id journey_signup, exactly');
check('a name selects it exactly, whatever the case', selectJourney(two, 'sign UP').matched_by, 'the journey name "Sign up", exactly');
check('a substring of the id is enough', selectJourney(two, 'login').journey.id, 'journey_login');
check('and the answer says a substring is what it was',
  selectJourney(two, 'login').matched_by.includes('a substring of'), true);
// Two journeys a phrase could mean: refused, because the difference between "the one you asked for"
// and "the one I liked best" is a test that clicks through the wrong walk.
const tied = { journeys: [
  { id: 'journey_a', name: 'Add a product', goal: 'Add a product to the cart.' },
  { id: 'journey_b', name: 'Add a product', goal: 'Add a product to the cart.' },
] };
const tie = selectJourney(tied, 'add a product to the cart and check the badge');
check('a phrase that fits two journeys equally well is refused rather than broken by picking one',
  [tie.error.includes('fits 2 journeys'), tie.candidates.map((entry) => entry.id)],
  [true, ['journey_a', 'journey_b']]);
const words = { journeys: [{ id: 'journey_cart', name: 'Add to cart', goal: 'Add a product to the cart.' }] };
check('failing every literal match, the words a phrase shares with the journey decide it',
  [words && selectJourney(words, 'add product cart').journey.id, selectJourney(words, 'add product cart').matched_by.includes('3 of 3 words')],
  ['journey_cart', true]);
check('a phrase whose words mean nothing here is refused with everything the graph holds',
  [selectJourney(words, 'delete an invoice').error.includes('nothing in the graph matches'), selectJourney(words, 'delete an invoice').candidates.length],
  [true, 1]);
check('and a phrase with no words in it at all says so', selectJourney(words, 'the of to').error.includes('has no words to match'), true);

// --- one assertion at a time ----------------------------------------------
// The schema's vocabulary and Playwright's do not line up, and every translation below is a decision
// someone had to make: a state is expanded into its own detection, a dimension becomes a count of
// the rows the reading counted, and a form control is asked what it holds rather than what it says.
check('a route is matched as a route, not as a host',
  rendered({ type: 'url', operator: 'equals', expected: '/projects' }),
  ['expect(page).toHaveURL("/projects");']);
check('and its negation is a negated matcher', rendered({ type: 'url', operator: 'not_equals', expected: '/login' }),
  ['expect(page).not.toHaveURL("/login");']);
check('a route assertion with no route is refused',
  rendered({ type: 'url' }), ['gap:url_assertion_has_no_route']);
check('a state assertion is expanded into the way that state recognises itself',
  rendered({ type: 'state', state: 'state_projects' }),
  ['expect(page.getByRole("button", { name: "Log out" })).toBeVisible();',
    `expect(page.getByTestId("project-list").locator(${JSON.stringify(ROW_SELECTOR)})).not.toHaveCount(0);`]);
check('a state the graph does not commit is refused',
  rendered({ type: 'state', state: 'state_nope' }), ['gap:state_assertion_names_no_state']);
check('and a state with no detection cannot say it is that screen',
  rendered({ type: 'state', state: 'state_bare' }, { ...base(), states: [...base().states, { id: 'state_bare', detection: [] }] }),
  ['gap:state_assertion_names_a_state_without_detection']);
check('visible is a matcher', rendered({ type: 'element_state', element: 'element_logout_button', operator: 'equals', expected: 'visible' }),
  ['expect(page.getByRole("button", { name: "Log out" })).toBeVisible();']);
check('hidden is the other one', rendered({ type: 'element_state', element: 'element_logout_button', expected: 'hidden' }),
  ['expect(page.getByRole("button", { name: "Log out" })).toBeHidden();']);
check('enabled and disabled are matchers too', rendered({ type: 'element_state', element: 'element_sign_in_button', expected: 'enabled' }),
  ['expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();']);
// A negation folds into the value rather than becoming `not.toBeHidden()`. Both are true; only one
// of them is read without inverting it in your head.
check('a negated state check reads as the opposite matcher, not as a double negative',
  rendered({ type: 'element_state', element: 'element_logout_button', operator: 'not_equals', expected: 'visible' }),
  ['expect(page.getByRole("button", { name: "Log out" })).toBeHidden();']);
check('absence is its own claim and not a second negation',
  rendered({ type: 'absence', element: 'element_logout_button', operator: 'not_equals', expected: 'visible' }),
  ['expect(page.getByRole("button", { name: "Log out" })).toBeHidden();']);
check('a state Playwright cannot express is refused rather than approximated',
  rendered({ type: 'element_state', element: 'element_logout_button', expected: 'checked' }),
  ['gap:element_state_has_no_matcher']);
check('a form control is asked what it holds', rendered({ type: 'element_value', element: 'element_email_input', operator: 'equals', expected: 'a' }),
  ['expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("a");']);
check('and anything else is asked what it says', rendered({ type: 'element_value', element: 'element_current_user', operator: 'equals', expected: 'test@example.com' }),
  ['expect(page.getByTestId("current-user")).toHaveText("test@example.com");']);
check('contains reads as toContainText on a node that says something',
  rendered({ type: 'message', element: 'element_current_user', operator: 'contains', expected: 'test@' }),
  ['expect(page.getByTestId("current-user")).toContainText("test@");']);
check('and as a negated toHaveValue on a field', rendered({ type: 'element_value', element: 'element_email_input', operator: 'not_contains', expected: 'nope' }),
  ['expect(page.getByRole("textbox", { name: "Email" })).not.toHaveValue("nope");']);
check('an operator the generator does not write is refused rather than invented',
  rendered({ type: 'element_value', element: 'element_email_input', operator: 'greater_than', expected: 1 }),
  ['gap:assertion_operator_has_no_matcher']);
check('an assertion naming nothing the graph declares is refused, and says which sort of nothing it was',
  [rendered({ type: 'element_value', element: 'element_ghost', operator: 'equals', expected: 'x' }),
    rendered({ type: 'element_state', element: 'element_ghost', expected: 'visible' })],
  [['gap:value_assertion_targets_no_element'], ['gap:assertion_names_no_element']]);
check('so is one expecting nothing comparable',
  rendered({ type: 'element_value', element: 'element_current_user', operator: 'equals', expected: null }),
  ['gap:assertion_expected_nothing_comparable']);
check('the wire cannot be asserted from a page, and the gap says what to assert instead',
  [rendered({ type: 'api', operator: 'equals', expected: 'x' })[0].startsWith('gap:assertion_type_not_renderable'), renderAssertion({ type: 'api' }, ctxFor(base())).gap.detail.includes('assert the surface')],
  [true, true]);
check('an effect assertion is about the graph, not the page',
  renderAssertion({ type: 'effect' }, ctxFor(base())).gap.detail.includes('describes the graph'), true);
check('and a custom assertion is code this generator does not have',
  renderAssertion({ type: 'custom' }, ctxFor(base())).gap.detail.includes('write it by hand'), true);

// A dimension is the one assertion the machinery found rather than the model wrote, and its shape
// comes from the reading: `capture.js` counted the rows, so the check counts the same rows, found by
// the commit's own tolerant rule (`projects` and `project_list` are one collection).
check('a dimension becomes a count of the rows the reading counted',
  rendered({ type: 'value', target: 'projects', operator: 'greater_than', expected: 0 }),
  [`expect(page.getByTestId("project-list").locator(${JSON.stringify(ROW_SELECTOR)})).not.toHaveCount(0);`]);
check('an exact count is written exactly', rendered({ type: 'value', target: 'projects', operator: 'equals', expected: 3 }),
  [`expect(page.getByTestId("project-list").locator(${JSON.stringify(ROW_SELECTOR)})).toHaveCount(3);`]);
check('a comparison Playwright cannot make on a count is refused',
  rendered({ type: 'value', target: 'projects', operator: 'less_than', expected: 3 }),
  ['gap:dimension_operator_has_no_matcher']);
check('and a count that is not a number is not a count',
  rendered({ type: 'value', target: 'projects', operator: 'equals', expected: '3' }),
  ['gap:dimension_count_is_not_a_number']);
check('a dimension no collection is named after is refused, with what to declare instead',
  [rendered({ type: 'value', target: 'invoices', operator: 'equals', expected: 1 }), renderAssertion({ type: 'value', target: 'invoices' }, ctxFor(base())).gap.detail.includes('Declare the collection')],
  [['gap:dimension_maps_to_no_element'], true]);
check('and one that matches two elements is refused rather than counted on the wrong one',
  rendered({ type: 'value', target: 'projects', operator: 'equals', expected: 1 },
    { ...base(), states: base().states.map((state) => (state.id === 'state_projects'
      ? { ...state, elements: [...state.elements, element('element_projects_table', { semantic: { purpose: 'projects_table' } })] }
      : state)) }),
  ['gap:dimension_could_be_more_than_one_element']);

// --- the whole spec -------------------------------------------------------
// Compared line for line, because a generated test is a claim about an application and a claim nobody
// reads is the wrong kind of file to be producing.
const result = generateTest(base(), { journey: 'sign in to Demo App' });
const expectedBody = [
  'test("Sign in to Demo App", async ({ page }) => {',
  '  await page.goto("/login");',
  '',
  '  await page.getByRole("textbox", { name: "Email" }).fill("test@example.com");',
  '',
  '  await page.getByRole("textbox", { name: "Password" }).fill(process.env.TEST_PASSWORD!);',
  '',
  '  await page.getByRole("button", { name: "Sign in" }).click();',
  '  await expect(page).toHaveURL("/projects");',
  '  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();',
  `  await expect(page.getByTestId("project-list").locator(${JSON.stringify(ROW_SELECTOR)})).not.toHaveCount(0);`,
  '  await expect(page.getByTestId("current-user")).toHaveText("test@example.com");',
  '});',
  '',
].join('\n');
check('the spec opens on the route the journey starts at, and carries only what the graph supports',
  result.spec.slice(result.spec.indexOf('test(')), expectedBody);
check('it is ok, because every step became an action and nothing blocking was reported',
  [result.ok, result.counts, result.gaps.map((gap) => gap.code)],
  [true,
    { transitions: 3, actions: 3, assertions: 4, gaps: 2, blocking_gaps: 0 },
    ['arguments_ignored_for_this_interaction', 'persistence_evidence_not_asserted']]);
check('the token that was typed is written; the one that was withheld is read from the environment',
  [result.requires.map((entry) => entry.env), result.steps[1].value],
  [['TEST_PASSWORD'], 'process.env.TEST_PASSWORD!']);
check('and the requirement says which element withheld it and why it could not be written down',
  [result.requires[0].element, result.requires[0].purpose, result.requires[0].reason.includes('instead of inventing one')],
  ['element_password_input', 'password_input', true]);
check('every step names the transition it came from and the reading that witnessed it',
  result.steps.map((step) => [step.transition, step.interaction, step.locator !== null]),
  [['transition_fill_login_email', 'fill', true], ['transition_fill_login_password', 'fill', true], ['transition_login', 'click', true]]);
check('the interaction says which role decided it',
  result.steps[2].interaction_basis, 'the role "button" of element_sign_in_button');
check('the arrival state is checked the way the graph says that screen is recognised',
  result.assertions.filter((entry) => entry.source === 'the arrival state').map((entry) => entry.line),
  ['expect(page).toHaveURL("/projects");',
    'expect(page.getByRole("button", { name: "Log out" })).toBeVisible();',
    `expect(page.getByTestId("project-list").locator(${JSON.stringify(ROW_SELECTOR)})).not.toHaveCount(0);`]);
check('and the model\'s own claim about the step is written too, attributed to the walk rather than to the machinery',
  result.assertions.filter((entry) => entry.source === "the model's assertion").map((entry) => entry.of),
  ['element_current_user says something, so the spec reads its text']);
// The commit's own candidates repeat what the arrival block already says, and the duplicate is
// reported as a duplicate instead of being written twice. The `state` candidate is not even
// considered: the arrival block says the same thing with the route as well.
check('a candidate the arrival block already wrote is dropped, and says what it duplicated',
  result.assertions.filter((entry) => entry.omitted_from_spec).map((entry) => [entry.source, entry.basis, entry.duplicate_of !== null]),
  [['the evidence', 'effect', true], ['the evidence', 'effect', true], ['the evidence', 'dimension', true]]);
check('and the checks the graph supports are counted once each', result.counts.assertions, 4);
check('the file is named after the journey, as a TypeScript spec', result.filename, 'journey_login.spec.ts');
check('and the header says what the file is and which walk it came from',
  [result.spec.includes('Generated from a committed graph'), result.spec.includes(' * Journey:     journey_login'), result.spec.includes('http://127.0.0.1:4173/')],
  [true, true, true]);

// --- the three refusals ---------------------------------------------------
// 1. A storage key is evidence, not an observable. The browser can be asked how many rows a list
//    shows; it cannot be asked what the application remembers about a user.
check('a stored key is reported as persistence and never asserted',
  [result.spec.includes('localStorage'), result.gaps.find((gap) => gap.code === 'persistence_evidence_not_asserted').severity,
    result.gaps.find((gap) => gap.code === 'persistence_evidence_not_asserted').detail.includes('localStorage.demo-state')],
  [false, 'info', true]);

// 2. An element with no actionable role is not clicked. `heading` is something a screen has.
const heading = () => {
  const graph = base();
  graph.states[0].elements.push(element('element_heading', { role: 'heading', name: 'Welcome' }));
  graph.transitions[2].action.target = 'element_heading';
  return graph;
};
const headingResult = generateTest(heading(), { journey: 'journey_login' });
check('an element a browser cannot act on is refused, not clicked',
  [headingResult.ok, headingResult.gaps.filter((gap) => gap.code === 'role_has_no_interaction').map((gap) => [gap.transition, gap.element]),
    headingResult.spec.includes('element_heading') || headingResult.spec.includes('heading')],
  [false, [['transition_login', 'element_heading']], false]);
check('and the gap names what to declare instead',
  headingResult.gaps.find((gap) => gap.code === 'role_has_no_interaction').detail.includes('say what a user does to this element'), true);

// 3. A value the run did not keep is not invented. There is no password in the spec, only the name of
//    the variable it has to come from — and if the store had written the value, it would be here.
check('nothing in the spec is a password', /password123|hunter2/.test(result.spec), false);
const kept = base();
kept.transitions[1].action.arguments.password = 'password123';
const keptResult = generateTest(kept, { journey: 'journey_login' });
check('but a value the run did keep is written, because the walk did supply it',
  [keptResult.spec.includes('password123'), keptResult.requires.length], [true, 0]);

// The live 0.1.21 walk, which is where this rule came from: the store wrote `[set]` for the password
// into the field's own effect — the recorder read the field back and that is what it found — while
// the model wrote `"[redacted]"` into `arguments` as its own way of saying "a value was typed here".
// The spec was generated from the model's words, and so it filled the password box with the literal
// string `[redacted]`: a test that fails for a reason that has nothing to do with the application.
// The reading is the party that observed the value, so the reading wins, and the disagreement is
// reported because `graph.json` still carries the argument and a reader is entitled to know.
const disagreed = base();
disagreed.transitions[1].action.arguments.password = '[redacted]';
disagreed.transitions[1].effects = [{ type: 'value_changed', target: 'password_input', to: REDACTED, observed: true }];
const disagreedResult = generateTest(disagreed, { journey: 'journey_login' });
check('an argument that disagrees with the step\'s own reading is not what the spec types',
  [disagreedResult.spec.includes('[redacted]'), disagreedResult.steps[1].value, disagreedResult.requires.map((entry) => entry.env)],
  [false, 'process.env.TEST_PASSWORD!', ['TEST_PASSWORD']]);
check('and the disagreement is reported rather than quietly resolved',
  disagreedResult.gaps.filter((gap) => gap.code === 'argument_disagrees_with_the_reading')
    .map((gap) => [gap.severity, gap.transition, gap.element, gap.detail.includes('"password_input"')]),
  [['warning', 'transition_fill_login_password', 'element_password_input', true]]);
// The instruction a run is left with, and the defect a live 0.1.27 run found in it: `requires` holds
// records rather than names, so the list joined into a sentence read *Set [object Object] before
// running it* — an instruction no one can follow, in the one sentence a person has to act on before
// the spec will run at all.
check('the value the spec needs is named as the variable to export, not as the record that describes it',
  [requiresInstruction(disagreedResult.requires).includes('[object Object]'),
    requiresInstruction(disagreedResult.requires).includes('Set TEST_PASSWORD before running it'),
    requiresInstruction(disagreedResult.requires).includes('typed into element_password_input'),
    requiresInstruction(keptResult.requires)],
  [false, true, true, '']);
check('and the step says which of the two it believed',
  disagreedResult.steps[1].value_of.includes('the argument it carried was ignored'), true);
check('while a reading that names the element by id is matched too', (() => {
  const byId = base();
  byId.transitions[1].action.arguments.password = '***';
  byId.transitions[1].effects = [{ type: 'value_changed', target: 'element_password_input', to: REDACTED }];
  return generateTest(byId, { journey: 'journey_login' }).steps[1].value;
})(), 'process.env.TEST_PASSWORD!');
check('and an argument equal to the reading is left alone, with nothing to report', (() => {
  const agreed = base();
  agreed.transitions[1].effects = [{ type: 'value_changed', target: 'password_input', to: REDACTED }];
  const outcome = generateTest(agreed, { journey: 'journey_login' });
  return [outcome.gaps.some((gap) => gap.code === 'argument_disagrees_with_the_reading'), outcome.steps[1].value];
})(), [false, 'process.env.TEST_PASSWORD!']);
check('and a reading of a *different* field does not override this step\'s argument', (() => {
  const other = base();
  other.transitions[1].action.arguments.password = '[redacted]';
  other.transitions[1].effects = [{ type: 'value_changed', target: 'email_input', to: REDACTED }];
  const outcome = generateTest(other, { journey: 'journey_login' });
  return [outcome.steps[1].value, outcome.gaps.some((gap) => gap.code === 'argument_disagrees_with_the_reading')];
})(), ['"[redacted]"', false]);

// --- the rest of the refusals --------------------------------------------
const mutate = (change) => {
  const graph = base();
  change(graph);
  return generateTest(graph, { journey: 'journey_login' });
};
const gapCodes = (outcome) => outcome.gaps.map((gap) => gap.code).sort();
check('a step whose target the graph does not declare is refused, not guessed at',
  (() => {
    const outcome = mutate((graph) => { delete graph.transitions[2].action.target; });
    return [outcome.ok, gapCodes(outcome).includes('step_targets_no_element')];
  })(), [false, true]);
check('an element with neither a role nor a locator is refused, with both read back',
  (() => {
    const outcome = mutate((graph) => { graph.states[0].elements[2] = element('element_sign_in_button', { role: null, locator: null }); });
    const gap = outcome.gaps.find((entry) => entry.code === 'element_has_no_usable_locator');
    return [gapCodes(outcome), gap.detail.includes('role "none", locator "null"'), outcome.ok];
  })(), [['element_has_no_usable_locator', 'persistence_evidence_not_asserted'], true, false]);
check('a step naming a transition the graph does not commit is left out and reported',
  (() => {
    const outcome = mutate((graph) => { graph.journeys[0].transitions = ['transition_ghost']; });
    return [outcome.spec.includes('transition_ghost'), gapCodes(outcome)];
  })(), [false, ['transition_not_in_graph']]);
check('a journey with no steps at all is refused as a journey with nothing to generate',
  gapCodes(mutate((graph) => { graph.journeys[0].transitions = []; })), ['journey_has_no_transitions']);
check('a walk that starts somewhere the graph pins to no route still generates, and says so',
  (() => {
    const outcome = mutate((graph) => { graph.states[0].identity = {}; });
    return [outcome.spec.includes('await page.goto("/")'), gapCodes(outcome).includes('start_state_has_no_route')];
  })(), [true, true]);
check('arriving in a state the graph does not commit is reported, because the spec cannot check it',
  (() => {
    const outcome = mutate((graph) => { graph.transitions[2].to_state = 'state_ghost'; });
    return [outcome.ok, gapCodes(outcome).includes('arrival_state_is_not_in_the_graph')];
  })(), [false, true]);
check('and arriving in a state with no detection is a warning, not a silent gap',
  (() => {
    const outcome = mutate((graph) => { graph.states[1].detection = []; });
    return [outcome.ok, gapCodes(outcome).includes('arrival_state_has_no_detection')];
  })(), [true, true]);
check('two arguments and none named after the element is a choice the spec owns up to',
  (() => {
    const outcome = mutate((graph) => {
      graph.transitions[0].action.arguments = { user: 'a', secret: 'b' };
      graph.states[0].elements[0].semantic = { purpose: 'account_identifier' };
    });
    return [outcome.spec.includes('.fill("a")'), outcome.gaps.find((gap) => gap.code === 'argument_chosen_of_several').severity];
  })(), [true, 'warning']);
check('an argument named after the element is not a guess',
  (() => {
    const outcome = mutate((graph) => { graph.transitions[0].action.arguments = { email: 'test@example.com', password: REDACTED }; });
    return [outcome.spec.includes('.fill("test@example.com")'), outcome.counts.gaps];
  })(), [true, 2]);
check('a value that is not a scalar cannot be typed',
  (() => {
    const outcome = mutate((graph) => { graph.transitions[0].action.arguments = { email: { nested: true } }; });
    return [gapCodes(outcome).includes('argument_is_not_a_scalar'), outcome.spec.includes('getByRole("textbox", { name: "Email" })')];
  })(), [true, false]);
check('typing with nothing to type is refused, because focusing a field is not a test of a form',
  (() => {
    const outcome = mutate((graph) => { graph.transitions[0].action.arguments = {}; });
    return [gapCodes(outcome).includes('step_has_no_value_to_type'), outcome.spec.includes('element_email_input')];
  })(), [true, false]);
check('arguments on a click are kept in the graph and reported as not written',
  generateTest(base(), { journey: 'journey_login' }).gaps.find((gap) => gap.code === 'arguments_ignored_for_this_interaction').severity, 'info');

// --- what a composite claim costs ----------------------------------------
// A capability composed of others is a claim about how a behaviour is built. The spec follows the
// walk — the transition, which is what actually happened — and the composition is checked against
// the steps the walk performed, never expanded in place of them.
check('a composite whose parts were all walked adds nothing to the spec',
  generateTest(base(), { journey: 'journey_login' }).gaps.filter((gap) => gap.code.startsWith('composite_')), []);
check('a composite naming a capability no transition performed is reported',
  (() => {
    const graph = base();
    graph.transitions = graph.transitions.filter((transition) => transition.id !== 'transition_fill_login_password');
    graph.journeys[0].transitions = ['transition_fill_login_email', 'transition_login'];
    const outcome = generateTest(graph, { journey: 'journey_login' });
    return [outcome.gaps.filter((gap) => gap.code === 'composite_part_never_walked').map((gap) => gap.detail.includes('cap_fill_login_password')), outcome.ok];
  })(), [[true], true]);
// The live failure this rule was written for: a composite that absorbed the submission, so the claim
// and the walk disagree about which element a step acted on. The warning says which is which.
check('and a composite whose parts act on other elements is reported as a mismatch with the walk',
  (() => {
    const graph = base();
    graph.capabilities[3].composed_of = ['cap_fill_login_email', 'cap_fill_login_password'];
    const outcome = generateTest(graph, { journey: 'journey_login' });
    const gap = outcome.gaps.find((entry) => entry.code === 'composite_step_targets_a_different_element');
    return [gap.severity, gap.detail.includes('element_sign_in_button'), gap.detail.includes('the walk is missing the step')];
  })(), ['warning', true, true]);

// --- the result has to survive being returned ---------------------------------
// `graph_test` declares `{type: 'json'}` as its output and the framework rejects a value that does
// not survive a round trip, naming no field. Asserting it here means the tool cannot fail that way.
check('the whole result is JSON, with no value that a round trip loses',
  (() => {
    const roundTripped = JSON.parse(JSON.stringify(result));
    return [roundTripped.counts, Object.keys(roundTripped).sort()];
  })(),
  [{ transitions: 3, actions: 3, assertions: 4, gaps: 2, blocking_gaps: 0 },
    ['application', 'assertions', 'counts', 'filename', 'gaps', 'journey', 'matched_by', 'ok', 'requires', 'spec', 'steps', 'test_name']]);

/** Every key path in the result that came back as `undefined`, which JSON drops silently. */
const undefinedPaths = (value, path = '') => {
  if (value === undefined) return [path];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => undefinedPaths(entry, path ? `${path}.${key}` : key));
};
check('and none of it is a key that would vanish in the round trip', undefinedPaths(result), []);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
