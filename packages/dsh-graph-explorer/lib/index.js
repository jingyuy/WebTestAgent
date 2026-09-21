/**
 * dsh-graph-explorer
 *
 * Turns a `dsh-browser` exploration into evidence, and the evidence into the
 * beginnings of an application behaviour graph.
 *
 * The division of labour is the whole design:
 *
 *   - the MACHINERY captures what is objectively true (the recorder)
 *   - the MODEL supplies what it means (the graph_* tools)
 *   - the PROMPT binds them into a loop the model actually follows
 *
 * This plugin deliberately does NOT own a browser. `dsh-browser` owns the page;
 * this plugin only observes the calls that drive it and reads the page through
 * `browser_eval`. Mounting a second browser plugin would give two Chromium
 * processes and two `page` objects — the canonical split-brain failure, where
 * the tool that drives the page and the tool that reads it disagree about which
 * page exists. One page, one owner.
 *
 * Three seams, all verified against the installed harness types:
 *
 *   1. `tools/execute`  (around-waterfall) — capture evidence around every
 *      browser action that can change the page.
 *   2. `tools.register` — `graph_observe`, the only path by which a state
 *      reaches the graph.
 *   3. `systemPrompt.section` — the exploration protocol.
 *
 * Plus one observer that is not a seam but a claim about the run itself:
 * `agent/pre-step` supplies the instruction, so `run.json` can say what this
 * exploration was asked to do. A graph with no recorded provenance cannot be
 * reproduced, and cannot be checked against the version-coherence invariant at
 * all.
 *
 * @module dsh-graph-explorer
 */
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphShapeOf } from './abm.js';
import { CAPTURE_EXPRESSION, SETTLE_EXPRESSION } from './capture.js';
import { assertionSurvival, commitRun, CONTROL_ROLES, ELEMENT_TARGET_EFFECTS, elementClaim, elementPresentIn, normalizeLocator, observedApis, persistenceVariablesOf, routeOf, semanticVariablesOf, stateVariablesOf, surfaceIsDisjoint, surfaceOf, unrecordedStateVariables } from './commit.js';
import { generateTest, requiresInstruction } from './generate.js';
import { SECTION_NAME, SECTION_ORDER, protocolText } from './protocol.js';
import { redactCallArguments } from './redaction.js';
import {
    APPLICATION_ID_PATTERN,
    CAPABILITY_KINDS,
    CAPABILITY_NAME_PATTERN,
    DETECTION_TYPES,
    EFFECT_REQUIRED,
    EFFECT_TYPES,
    ELEMENT_PURPOSE_PATTERN,
    LIST_OPERATIONS,
    SEVERITIES,
    STEP_ACTIONS,
    argumentMapProblem,
    normalizeAffordance,
    normalizeApplication,
    normalizeRealizationStep,
    purposeOf,
    vocabularyNotes,
} from './schema.js';
import { createRun, identityKey, normalizeRunDirName, RUN_DIR_NAME, RUN_DIR_PATTERN } from './session.js';

export const name = 'graph-explorer';
export const inject = ['tools', 'systemPrompt'];

/**
 * Our own name and version, read from the installed manifest.
 *
 * Deliberately not a literal. The harness resolves this package by the tarball
 * spec recorded in the profile, so the running code and the manifest on disk
 * can diverge from whatever a maintainer last typed — a hardcoded string
 * records the version someone *believed* was installed, which is the one thing
 * provenance must never do. If the manifest cannot be read, this stays null:
 * an unknown version is recoverable, a wrong one is not.
 */
const self = (() => {
    try {
        const manifest = JSON.parse(
            readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
        );
        return { name: manifest.name ?? null, version: manifest.version ?? null };
    } catch {
        return null;
    }
})();

export const Config = Schema.object({
    observeTool: Schema.string().default('graph_observe'),
    transitionTool: Schema.string().default('graph_transition'),
    commitTool: Schema.string().default('graph_commit'),
    generateTool: Schema.string().default('graph_test'),
    // The pattern declares the contract so a config error is caught while the
    // profile is still booting, alongside every other bad setting. The runtime
    // check in `apply` is not a duplicate of it: this declares *what is valid*,
    // that one refuses *what would be written*, and the value reaches the
    // filesystem from a place that can be called without the schema in front.
    runDirName: Schema.string()
        .default(RUN_DIR_NAME)
        .pattern(RUN_DIR_PATTERN)
        .description('Where the run writes its evidence, relative to the workspace. Must not escape it.'),
    // The one graph field the harness cannot observe. `run.json` records the start URL
    // and the instruction, and a host is where an app is served, not what it is — so
    // the identity is declared here. There is deliberately no fallback: unset leaves
    // `null` in run.json and the commit refuses, naming this setting, while a derived
    // id would sit in the finished graph indistinguishably from a declared one.
    application: Schema.object({
        id: Schema.string()
            .pattern(APPLICATION_ID_PATTERN)
            .description('Stable application id, prefixed: app_acme. Not derivable from the start URL.'),
        name: Schema.string()
            .min(1)
            .description('Human-readable application name, e.g. Acme.'),
        // The actor vocabulary is a property of the APPLICATION, not of a walk: a role that
        // exists is one somebody can sign in as, whether or not this run ever did. So it is
        // declared here, beside the application, and not inferred from the states a walk
        // happened to reach — which is why `credentials_ref` can be stated at all (nothing in
        // a page says which credential a role uses) and why the commit can report a state
        // whose variant names a role nothing declares.
        //
        // The ids are the join: `state.identity.variant` and `journey.actor` already reference
        // them, and `application.schema.json` already declares the array in both document
        // versions — this setting is what finally fills it in.
        actors: Schema.array(Schema.object({
            id: Schema.string()
                .min(1)
                .description('The actor id, which is also the value `state.identity.variant` uses: anonymous, authenticated, admin.'),
            description: Schema.string()
                .description('What this role is, in the user\'s terms.'),
            credentials_ref: Schema.string()
                .description('Name of a credential entry the role signs in with, for example TEST_USER. A reference, never the credential.'),
        }))
            .description('Roles this application can be exercised as. Referenced by `state.identity.variant` and `journey.actor`; declared here because the vocabulary outlives the walk.'),
    })
        .default(null)
        .description('Which application this graph is about. Without it a run still records evidence, but its graph cannot be committed.'),
    maxSteps: Schema.number(),
    screenshot: Schema.boolean().default(true),
    maxDigestChars: Schema.number().default(14000),
});

/**
 * Browser tools whose RESULT can change what is on screen, so evidence must be
 * captured around them.
 *
 * `browser_get_text` and `browser_get_html` are excluded because they genuinely
 * cannot change the page, and capturing around them would multiply the cost of
 * every look by three.
 *
 * `browser_eval` is NOT one of those, however much its name reads like
 * inspection: it runs arbitrary JavaScript in the page, and its own description
 * offers "triggering page logic" as a use. The recorder is itself the proof — it
 * changes the page through `browser_eval` when it installs its network and
 * console hooks. A change made through eval that nobody captured is a hole in
 * the evidence chain: the reading after it would describe a page no observation
 * accounts for, and the transition over that step could not be derived at all.
 */
const OBSERVED_TOOLS = new Set([
    'browser_open',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_wait',
    'browser_eval',
]);

/** Assertion kinds the graph schema permits — see `schema.js` for the source of truth. */

const workspaceCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

/**
 * What to tell the model when the evidence log itself is not keeping up.
 *
 * A store write that did not land is not a detail of the machinery: every id the
 * protocol hands out — `obs_*`, `state_*`, `cap_*`, `transition_*` — is a reference
 * into the log, and a reference the log does not contain cannot be committed. So the
 * recording tools say so plainly instead of minting an id for a record no one will
 * ever read, and they name the path, because the realistic cause is a run directory
 * that was moved or deleted while the agent was still working in it.
 */
const storeFailureMessage = (problem, runDirName, retry) => [
    `The evidence log could not be written (${problem.path}: ${problem.message}), so nothing was recorded.`,
    problem.repair_error
        ? `The run directory ${runDirName}/ could not be recreated either (${problem.repair_error}).`
        : `The run directory ${runDirName}/ was recreated, and the write failed anyway.`,
    retry,
].join(' ');

/**
 * The URL a launching action asked for.
 *
 * Taken from the call's own arguments rather than from the page afterwards,
 * because `run.json` is written once, before the action runs. This records what
 * was requested; the URL actually landed on is in the capture for that step, so
 * a redirect shows up as a difference between the two rather than being hidden.
 */
const requestedUrl = (toolName, toolArgs) => {
    if (toolName !== 'browser_open' && toolName !== 'browser_navigate') return null;
    const url = toolArgs?.url;
    return typeof url === 'string' && url ? url : null;
};

/** The model-facing text of a user message, if it has any. */
const messageText = (message) => {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return null;
    const text = blocks
        .filter((block) => block && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    return text || null;
};

/**
 * Everything the agent can tell us about itself. Each getter is read
 * defensively: these live on the live agent, and a provenance lookup must never
 * be the reason a browser action fails.
 */
const agentProvenance = (exec) => {
    try {
        const options = exec?.agent?.options;
        const header = exec?.agent?.session?.header;
        return {
            provider: options?.provider ?? null,
            model: options?.model ?? null,
            sessionId: header?.id ?? null,
            agentPreset: header?.agentPreset ?? null,
        };
    } catch {
        return {};
    }
};

/** Names of the interactive elements a capture saw, for cheap appearance diffs. */
const elementNames = (capture) => (capture?.interactive ?? [])
    .map((item) => (item.name ? item.role + ':' + item.name : item.role + ':' + item.selector))
    .filter(Boolean);

/**
 * The mutable part of each interactive element, keyed exactly like `elementNames`.
 *
 * An element's *identity* is its role and name; its *state* is the value inside it,
 * whether it is checked, and whether it is disabled. The capture has always recorded
 * those, but the diff never looked at them — so filling in a field, which is the entire
 * content of a form step, came back as "nothing changed" and was blamed on a raced
 * capture. That is a false diagnosis of a real step, and it sends the model hunting for
 * a race that is not there.
 */
const elementStates = (capture) => {
    const states = new Map();
    for (const item of capture?.interactive ?? []) {
        const key = item.name ? item.role + ':' + item.name : item.role + ':' + item.selector;
        if (!key) continue;
        const bits = [];
        if (item.value !== undefined) bits.push('value=' + JSON.stringify(item.value));
        if (item.checked !== undefined) bits.push('checked=' + (item.checked === true));
        if (item.disabled === true) bits.push('disabled');
        states.set(key, bits.join(' '));
    }
    return states;
};

/**
 * Application storage, which is state the page owns and a step can change by itself.
 *
 * Only changed keys are reported, and a removed key reports as `null` so that "unset"
 * and "set to the empty string" stay distinguishable. Bounded to five keys: this is a
 * hint for the model, not a dump.
 */
const diffStorage = (before, after) => {
    const was = before?.storage ?? {};
    const now = after?.storage ?? {};
    const changed = {};
    for (const [key, value] of Object.entries(now)) {
        if (was[key] !== value) changed[key] = value;
    }
    for (const key of Object.keys(was)) {
        if (!(key in now)) changed[key] = null;
    }
    const entries = Object.entries(changed);
    return entries.length ? Object.fromEntries(entries.slice(0, 5)) : null;
};

/**
 * Bounded text-diff of two captures: what the action actually changed.
 *
 * Exported (with `crossCheckEffects`) so the machinery's side of the comparison can be
 * tested against captures directly, without a browser and without a harness.
 */
export function diffCaptures(before, after) {
    if (!before || !after) return null;
    const beforeNames = new Set(elementNames(before));
    const afterNames = new Set(elementNames(after));
    const beforeStatus = new Set((before.status ?? []).map((item) => item.text));
    const afterStatus = new Set((after.status ?? []).map((item) => item.text));
    const diff = {};
    if (before.url !== after.url) diff.url = [before.url, after.url];
    if (before.title !== after.title) diff.title = [before.title, after.title];
    const appeared = [...afterNames].filter((item) => !beforeNames.has(item)).slice(0, 20);
    const disappeared = [...beforeNames].filter((item) => !afterNames.has(item)).slice(0, 20);
    if (appeared.length) diff.appeared = appeared;
    if (disappeared.length) diff.disappeared = disappeared;
    const beforeStates = elementStates(before);
    const changed = [];
    for (const [key, state] of elementStates(after)) {
        // An element that is not in the before capture did not change, it appeared.
        if (!beforeStates.has(key)) continue;
        const was = beforeStates.get(key);
        if (was === state) continue;
        changed.push(`${key}: ${was || '(none)'} → ${state || '(none)'}`);
    }
    if (changed.length) diff.changed = changed.slice(0, 20);
    const storage = diffStorage(before, after);
    if (storage) diff.storage = storage;
    const newMessages = [...afterStatus].filter((item) => !beforeStatus.has(item)).slice(0, 10);
    if (newMessages.length) diff.status = newMessages;
    const newErrors = (after.page_errors ?? []).slice(0, 10);
    if (newErrors.length) diff.page_errors = newErrors;
    const requests = (after.network ?? []).slice(0, 20);
    if (requests.length) diff.requests = requests;
    return Object.keys(diff).length ? diff : null;
}

/** The user-facing messages a capture saw, as plain strings. */
const statusTexts = (capture) => (capture?.status ?? [])
    .map((entry) => entry?.text)
    .filter((text) => typeof text === 'string' && text);

/**
 * The controls in a list of `role:name` appearances.
 *
 * A diff lists appearances by `role:name`, and a list that grew adds plain text nodes rather than
 * controls. `CONTROL_ROLES` lives in `commit.js` with the rest of the vocabulary two sides share,
 * because that is the same question `surfaceOf` asks of a whole capture.
 */
const controls = (entries) => (entries ?? [])
    .filter((entry) => CONTROL_ROLES.has(String(entry).split(':')[0]));

/**
 * What to say when the two captures of a step are identical.
 *
 * This used to have to hedge — "either this really is a self-loop, or the capture raced
 * the page's own update" — because the machinery had no way to tell the two apart, and
 * they call for opposite responses: a self-loop is a finding to record, while a raced
 * capture is a reading to throw away and take again.
 *
 * The after-action capture now waits for the page to stop moving and reports what it
 * saw while it waited, so the note can say which one it is holding. The hedge survives
 * only for records written before that, where it remains the truth about them.
 */
const unmovedNote = (settle) => {
    const common = 'Nothing in the captured surface changed between the two steps — no URL, title, element, value, '
        + 'checked state, message, storage or request difference.';
    if (!settle) {
        return `${common} Either this really is a self-loop, or the capture raced the page's own update (a late `
            + 'render, an animation, a debounced request).';
    }
    if (settle.error) {
        return `${common} The page was also asked whether it had stopped moving, and did not answer: ${settle.error}. `
            + 'This reading is therefore not known to be a settled one — read the page again before deriving anything '
            + 'from this step.';
    }
    if (settle.timed_out) {
        return `${common} The page was still moving when it was read: it was watched for ${settle.waited_ms}ms after `
            + `the action, never went ${settle.quiet_ms}ms without a change (cap ${settle.budget_ms}ms), and `
            + `${settle.in_flight ?? 0} request(s) were still open. The reading describes a page mid-update, so this `
            + 'step is not yet a finding — wait for it to finish and record the transition again.';
    }
    if (settle.watched === false) {
        return `${common} The page could not be watched for changes (this document has no MutationObserver), so the `
            + `wait says only that ${settle.waited_ms}ms passed rather than that the page was done. Treat this reading `
            + 'as unconfirmed.';
    }
    return `${common} This is not a race: the page was watched for ${settle.waited_ms}ms after the action, and `
        + ((settle.changes ?? 0) > 0
            ? `it had moved and then held still for ${settle.quiet_ms}ms. The step left the surface as it was: `
            : 'nothing moved in it at all. A page whose next update is scheduled beyond that window announces '
                + 'nothing and cannot be waited for, so if you expected this step to change the page, wait for the '
                + 'change explicitly and read again; on this evidence the step left the surface as it was: ')
        + 'record it as a self-loop, or as an action with no visible effect on this page.';
};

/**
 * The names the graph can already resolve: the purposes it has declared, the states it can
 * name, and what it knows about each element.
 *
 * `graph_observe` and `graph_transition` both have to answer "does this name exist yet?" — a
 * detection that names an element, an effect whose target has to become an element id — and
 * the answer has to be the one the *commit* will reach, because a name the commit cannot
 * resolve is content the graph silently loses. The commit builds its registry from the
 * readings that survived to be written; a tool can only build its from what the store holds
 * plus whatever the call in hand declares, which is the honest limit of asking early. So this
 * is deliberately weaker than the commit's registry: a refusal made here is a claim the commit
 * would also have refused to carry, and the commit still reports drops it can see and the tool
 * could not.
 *
 * `elements` (the call in hand) takes precedence over the recorded declarations, because the
 * model restating an element is its latest word about it.
 */
const registryFrom = (states, elements) => {
    const declarations = new Map();
    for (const element of [...(states ?? []).flatMap((record) => record?.elements ?? []), ...(elements ?? [])]) {
        const purpose = element?.semantic_purpose;
        // Only purposes the commit would accept as an element id. One that is not snake_case is
        // dropped at commit (`element_dropped`), so a reference to it is dropped too — refused
        // here instead, where the name is still the model's to fix.
        if (typeof purpose !== 'string' || !ELEMENT_PURPOSE_PATTERN.test(purpose)) continue;
        // In the shape the commit gives a declaration — role, name, and a *normalized* locator —
        // because `elementPresentIn` reads those three fields, and a check that asked them of the
        // raw record would answer a different question than the commit does.
        declarations.set(purpose, {
            ...element,
            role: typeof element.role === 'string' ? element.role : null,
            name: typeof element.name === 'string' ? element.name : null,
            locator: normalizeLocator(element.locator),
        });
    }
    const stateIds = new Map();
    for (const record of states ?? []) {
        if (record?.state_id) stateIds.set(record.state_id, record.state_id);
        if (record?.id && record.id !== record.state_id) stateIds.set(record.id, record.state_id);
    }
    return {
        declarations,
        stateIds,
        elementIdByPurpose: new Map([...declarations.keys()].map((purpose) => [purpose, 'element_' + purpose])),
    };
};

/** The registry in the shape `normalizeAssertion` expects, plus the route this reading was taken at. */
const referenceContext = (registry, url) => ({
    stateIds: registry.stateIds,
    elementIdByPurpose: registry.elementIdByPurpose,
    route: routeOf(url ?? ''),
});

/**
 * The element a claim is about: the purpose it resolves to, and what to quote back.
 *
 * A model writes the target as a bare purpose (`"email_input"`) or as the object form the tool's
 * own "a state with no detection cannot be asserted" refusal invites
 * (`{semantic_purpose: "email_input"}`), and both resolve — `purposeOf` is the one resolver the
 * tool and the commit share, which is the point of it. `label` is the resolved purpose when
 * there is one and the value as written when there is not, so a message about a target that
 * resolves to nothing echoes what the model actually wrote rather than `null`.
 */
const claimTarget = (entry) => {
    const raw = entry && typeof entry === 'object' ? (entry.element !== undefined ? entry.element : entry.target) : undefined;
    const purpose = purposeOf(raw);
    return { purpose, label: purpose ?? raw ?? null };
};

const listOf = (values, limit = 15) => (values.length
    ? `${values.slice(0, limit).join(', ')}${values.length > limit ? ', …' : ''}`
    : null);

/**
 * The capture's own entry for an element the model declared, matched the way the commit matches
 * it — role and accessible name. Returns `null` when the claim cannot be checked against this
 * reading, which is the honest answer rather than a pass.
 */
const readingOf = (registry, purpose, capture) => {
    const declaration = registry.declarations.get(purpose);
    if (!declaration?.role || !declaration?.name) return null;
    return (capture?.interactive ?? []).find((item) => item && item.role === declaration.role && item.name === declaration.name) ?? null;
};

/** A detection entry, described without echoing the values in it (which may be a credential). */
const describeDetection = (entry) => {
    if (!entry || typeof entry !== 'object') return JSON.stringify(entry ?? null);
    const { label } = claimTarget(entry);
    const field = entry.element !== undefined ? 'element' : 'target';
    return `{type: ${JSON.stringify(entry.type ?? null)}${label === null || label === undefined ? '' : `, ${field}: ${JSON.stringify(label)}`}}`;
};

/**
 * What to say about a detection entry the commit would have dropped, and what to write instead.
 *
 * Every one of these is a message the model could not have received before: the entry is
 * accepted by the tool, and the commit — which is where the rule lives — only sees it once the
 * page it describes is closed. So the wording is not an apology but the missing half of the
 * instruction: what the tool took, and what it should have been given.
 */
const detectionRemedy = (entry, reason, registry) => {
    const { label } = claimTarget(entry);
    const declared = listOf([...registry.declarations.keys()]);
    const list = declared
        ? `The elements declared so far are: ${declared}.`
        : 'No element has been declared yet, so nothing can be checked about one: declare the elements you act on in '
            + 'this reading\'s `elements`, each with a `semantic_purpose`.';
    switch (reason) {
        case 'element_reference_does_not_resolve':
            return `it names ${JSON.stringify(label ?? null)}, which is not the semantic_purpose of any element this run has `
                + `declared, so the entry would be dropped and the state would carry no check on that element at all. ${list}`;
        case 'element_assertion_has_nothing_to_check':
            return `it resolves ${JSON.stringify(label ?? null)}, but says nothing to check about it. The expected condition `
                + 'goes in `operator`, or in `value`/`expected` — for a state word write '
                + `{"type":${JSON.stringify(entry.type)},"target":${JSON.stringify(label ?? 'purpose')},"operator":"visible"} `
                + '(visible, hidden, enabled, disabled), and for a value '
                + `{"type":${JSON.stringify(entry.type)},"target":${JSON.stringify(label ?? 'purpose')},"value":"…"}. `
                + 'A key the tool does not recognise is not a condition, so the entry would be dropped and the graph '
                + 'would claim less about this state than you recorded.';
        case 'state_assertion_names_no_state': {
            const named = entry.state !== undefined ? entry.state
                : (entry.value !== undefined ? entry.value : entry.target);
            const ids = listOf([...registry.stateIds.values()]);
            return `it names the state ${JSON.stringify(named ?? null)}, which is not a state id this run has recorded. `
                + (ids ? `The states it has are: ${ids}.` : 'It has recorded none yet.');
        }
        case 'url_assertion_without_a_url':
            return 'it is a url detection with no address, and this reading has no URL to pin it to. Give it the '
                + 'address you are looking at.';
        case 'empty_assertion':
            return 'it is an empty string, which asserts nothing.';
        case 'unknown_assertion_type':
            return `its type is not one of: ${[...DETECTION_TYPES].join(', ')}.`;
        default:
            return 'it is neither a string description nor an object with a `type`, which is all a detection entry can be.';
    }
};

/**
 * Refuse a detection entry the commit would drop, while the page that would prove it is still on
 * screen.
 *
 * This is the asymmetry the tool had: `graph_transition` checked its effects against the schema
 * before recording them, and `graph_observe` checked only that each entry had a `type`. So
 * `{"type":"element_state","target":"sign_in_button","state":"visible"}` — an entry whose
 * condition is in a key nothing reads — was accepted, written to the log, and dropped by the
 * commit minutes later, with the correction arriving when there was nothing left to correct.
 * The rule was never missing; only the moment to state it was.
 */
const refuseDroppedDetections = (detection, registry, url) => {
    const context = referenceContext(registry, url);
    for (const entry of detection ?? []) {
        const problem = assertionSurvival(entry, context);
        if (!problem) continue;
        // A bare `{type: "url"}` is pinned to the route its readings were taken at, which the
        // commit derives from the captures. With no route in hand there is nothing to pin it to
        // and nothing to judge, so this one is left to the commit rather than refused over a gap
        // in the machinery.
        if (problem.reason === 'url_assertion_without_a_url' && !context.route) continue;
        throw new Error(
            `detection ${describeDetection(entry)} would not survive the commit: ${detectionRemedy(entry, problem.reason, registry)} `
            + 'Nothing was recorded, so fix the entry and call again — the page has not moved, and no action has to be repeated.',
        );
    }
};

/**
 * A detection that asserts a value the reading cannot show, where the value is one no reading
 * ever could.
 *
 * A masked value is the one case that is refused rather than reported: a password field is
 * captured as `[set]` (`capture.js`), deliberately — the graph is a durable artefact and a
 * credential in it outlives the run — so a literal written against one can never hold, in this
 * reading or any other. Left to the commit it becomes an `info` finding and the graph keeps an
 * assertion that fails on arrival, which is the worst kind: it looks like a passing graph.
 */
const maskedValueRefusal = (detection, registry, capture) => {
    for (const entry of detection ?? []) {
        if (!entry || typeof entry !== 'object' || entry.type !== 'element_value') continue;
        const expected = entry.value !== undefined ? entry.value : entry.expected;
        if (typeof expected !== 'string' || !expected) continue;
        const { purpose } = claimTarget(entry);
        const seen = readingOf(registry, purpose, capture);
        if (seen?.value !== '[set]') continue;
        return `detection expects ${JSON.stringify(purpose)} to hold a value, but the reading records "[set]": that is the `
            + 'collector\'s mask on a password field, not the page\'s content, so no literal can match it — and a literal '
            + 'here would write the credential into the graph. Assert what a reading can show: '
            + `{"type":"element_value","target":${JSON.stringify(purpose ?? 'purpose')},"operator":"exists"} for "the field holds `
            + 'something", or an `element_state` check that the field or the form is there.';
    }
    return null;
};

/**
 * A detection this reading's own capture refutes, refused before the reading is written.
 *
 * `graph_observe` binds a reading to the capture in hand, and the commit checks every detection
 * against every reading bound to that state — so a claim this capture contradicts can never
 * become true: the evidence that refutes it is already on disk and immutable. Left to the commit
 * it is `detection_refuted_by_evidence` (an error), the entry is dropped, and a state whose only
 * detection was that entry is refused outright with `state_without_detection` — a whole walk lost
 * to one reading, at a point where the correction has nothing left to act on.
 *
 * The common cause is not a typo. A click authenticated the session, the model read the page it
 * landed on, and then named the state it had been on before: the reading is bound to a capture of
 * a different screen, its detection is refuted by its own evidence, and the state it was meant to
 * describe is left with nothing. The tool cannot tell that from an element that is genuinely not
 * on this page, so the refusal names both readings of the situation — and says what the capture
 * *does* show, which is the one thing that lets the model recognise the page it is actually on.
 */
const refutedDetectionRefusal = (detection, registry, capture) => {
    if (!capture) return null;
    for (const entry of detection ?? []) {
        const claim = elementClaim(entry);
        if (!claim) continue;
        const declaration = registry.declarations.get(claim.purpose);
        if (!declaration) continue;
        const present = elementPresentIn(capture, declaration);
        if (present === null) continue;
        const refuted = claim.want === 'present' ? present === false : present === true;
        if (!refuted) continue;
        const tail = 'Nothing was recorded, so fix the entry and call again — the page has not moved, and no action has to be '
            + 'repeated. A claim a reading refutes can never be true later: the commit checks every detection against every '
            + 'reading bound to the state, so this one would arrive as `detection_refuted_by_evidence` (an error), the entry '
            + 'would be dropped, and a state left with no detection is refused outright (`state_without_detection`).';
        if (claim.want === 'present' && !(declaration.role && declaration.name) && !declaration.locator) {
            return `detection ${describeDetection(entry)} cannot be checked against any reading: it claims `
                + `${JSON.stringify(claim.purpose)} is there, and what this run has recorded for that element says nothing about `
                + 'how to find it on a page — no `role` together with `name`, and no `locator`. Give the element both in this '
                + `reading's \`elements\`, the way the capture describes it. ${tail}`;
        }
        const shown = listOf((capture.interactive ?? []).slice(0, 8).map((item) => `${item.role}:${item.name}`), 8);
        const advice = claim.want === 'present'
            ? 'If the page has moved past the state you named, read it as the state it now is — two states have to be told apart '
                + 'by their identity, not by one of them carrying the other\'s proof; if the element is simply not on this page, '
                + 'this reading cannot be a reading of that state. '
            : 'An `absence` claim says the element is gone, and this capture has it: either this is not the state you named, or the '
                + 'element is not absent here yet. ';
        return `detection ${describeDetection(entry)} is refuted by the reading it is written on: it claims `
            + `${JSON.stringify(claim.purpose)} ${claim.want === 'present' ? 'is there' : 'is gone'}, and the capture of this step `
            + `(${routeOf(capture.url ?? '')}) shows the opposite. `
            + (shown ? `That capture's interactive surface is: ${shown}. ` : 'That capture has no interactive elements at all. ')
            + advice
            + tail;
    }
    return null;
};

/**
 * A reading whose controls have nothing in common with the readings already bound to the state it
 * names.
 *
 * This is the hole `refutedDetectionRefusal` leaves, and it is the one a live sign-in run fell
 * through. That check asks whether the claims in this reading hold for this page; this one asks
 * whether the page is the state at all — and it is the only one of the two that can be asked when
 * the detection names no element. A state whose detection is a bare route assertion is refuted by
 * nothing on a single-page application, so an action that moves the screen without moving the URL
 * can bind a reading to the state it had just left, and the binding cannot be withdrawn: evidence
 * is append-only, and the commit reads every reading bound to a state as evidence for it.
 *
 * The tool can see this and the model cannot — the model is looking at one page at a time, and the
 * tool is holding both readings. What the tool does *not* have is the answer: which of the two
 * readings is the wrong one is a judgement about identity, and identity is the model's. So the
 * refusal puts both surfaces side by side and stops there. The escape hatch is deliberate: an
 * application really can show two different sets of controls under one identity, and the model's
 * remedy for that is a `dimensions` entry, which changes the identity and mints a state of its own.
 */
const surfaceMismatchRefusal = ({ stateId, surface, others }) => {
    if (!surfaceIsDisjoint(surface, others)) return null;
    const theirs = [...new Set(others.flat())].sort();
    return `this reading's controls have nothing in common with the readings already bound to state ${stateId}: this page `
        + `offers ${listOf(surface, 6)}, and those readings offer ${listOf(theirs, 6)}. A state's readings are all readings of `
        + 'one screen, so one of these bindings is wrong — most often a reading named with the state the action had just left, '
        + 'which was accepted because an identity is your judgement and this is the first evidence against it. If the page '
        + 'really is the screen you named, give it a `dimensions` entry that tells the two apart and it becomes a state of its '
        + 'own; otherwise read it as the state it now is. '
        + 'Nothing was recorded, so fix the entry and call again — the page has not moved, and no action has to be repeated. '
        + 'A binding cannot be withdrawn once it is made: the commit reads every reading bound to a state as evidence for it, '
        + 'and would carry on with a state that two different screens are readings of.';
};

/**
 * The claims in a reading that the reading itself does not bear out.
 *
 * Where a contradiction is a summary rather than a mistake (`filled` for a field the capture
 * records as `test@example.com`), it is reported and not refused: deciding which was meant is
 * judgement, and judgement is the model's — the same conclusion the commit reaches, where this
 * is an `info` finding and the entry is carried as written. The kinds here are the commit's own
 * finding codes, so a model that ignores one meets the same name in the report.
 */
const valueMismatchNotes = (detection, registry, capture) => {
    const notes = [];
    for (const entry of detection ?? []) {
        if (!entry || typeof entry !== 'object' || entry.type !== 'element_value') continue;
        const expected = entry.value !== undefined ? entry.value : entry.expected;
        if (typeof expected !== 'string' || !expected) continue;
        const { purpose } = claimTarget(entry);
        const seen = readingOf(registry, purpose, capture);
        if (!seen || typeof seen.value !== 'string' || seen.value === expected) continue;
        notes.push({
            kind: 'detection_value_not_in_evidence',
            detail: `detection expects ${JSON.stringify(purpose)} to hold ${JSON.stringify(expected)}, while this reading `
                + `recorded ${JSON.stringify(seen.value)}. Carried as written — it may be a summary rather than a literal, `
                + 'in which case say so in the entry\'s `description` and put the literal in `evidence` — but a generator '
                + 'would turn it into an assertion that fails.',
        });
    }
    return notes;
};

/**
 * The state variables the walk has moved, and whether the states it recorded hold them.
 *
 * The commit makes this judgement per edge, which is the right place for the *record*; this is the
 * same judgement asked of the run so far, because the digest is where the model can still act on
 * it. A step that changed a collection changed something the screen is showing, so the graph has
 * exactly one way to hold it which is not a state per value: a dimension on the state's identity,
 * pinned by a `value` assertion in its detection. Reported as names rather than as a verdict,
 * because whether the fact *is* what makes the state a different situation is the model's
 * judgement.
 *
 * A storage key is the other case and gets the other advice. It is real evidence — the run's proof
 * that the step changed something the application *remembers* — but it is not an observable: no
 * browser can be asked what the application remembers about a user, so a `value` assertion over a
 * storage key is a check nothing can evaluate. Asking for it as a dimension would be asking for a
 * test that cannot be written, which is what the two lists below are here to prevent: the
 * `unrecorded` list is the semantic half only, and the remembered half is named separately.
 *
 * `null` when the walk has moved no variable at all, so a digest for a run that never touched one
 * does not carry a field that means nothing.
 */
const stateVariableRollup = (store) => {
    const effects = store.transitions().flatMap((record) => (Array.isArray(record.effects) ? record.effects : []));
    const moved = stateVariablesOf(effects);
    if (!moved.length) return null;
    const identities = store.states().map((record) => record.identity ?? {});
    const semantic = semanticVariablesOf(effects);
    const unrecorded = unrecordedStateVariables(effects, identities);
    return {
        moved: moved.map((variable) => variable.name),
        // By name, and over the semantic half: the unrecorded list was computed from a second
        // reading of the effects, so its entries are equal as values and not as objects, and a
        // storage key is not "recorded" merely by not being asked for as a dimension — it was
        // never a candidate. A variable can therefore be absent from both lists, and the
        // `persistence` list is where it appears instead.
        recorded: semantic
            .filter((variable) => !unrecorded.some((entry) => entry.name === variable.name))
            .map((variable) => variable.name),
        unrecorded: unrecorded.map((variable) => variable.name),
        persistence: persistenceVariablesOf(effects).map((variable) => variable.name),
    };
};

/**
 * A caution for a state identity minted out of element state.
 *
 * Whether two readings are two states is the model's judgement — the schema says so, and this
 * checks the schema's vocabulary rather than its judgement — so this is a report and not a
 * refusal. What the machinery knows that the model does not is *what the step changed*: the
 * model is looking at one page at a time, and the diff is the one place the run can see that the
 * only difference between this reading and the previous one is what the fields hold.
 *
 * That matters because a value the user typed is element state, not a fact about the
 * application, and because a state identity cannot be withdrawn: once minted it is a state the
 * graph carries, so an identity invented from a form's progress reports a two-screen app as
 * however many keystrokes it took to fill in.
 */
const elementStateIdentityNote = ({ minted, previousState, change }) => {
    if (!minted || !previousState || !change) return null;
    const keys = Object.keys(change);
    const moved = Array.isArray(change.changed) ? change.changed : [];
    if (keys.length !== 1 || keys[0] !== 'changed' || !moved.length) return null;
    if (!moved.every((entry) => String(entry).includes('value='))) return null;
    return {
        kind: 'identity_read_from_element_state',
        detail: `A new identity was minted, and the only thing that changed between this reading and the previous one is `
            + `what the fields hold (${moved.slice(0, 2).join('; ')}). A value the user has typed is element state, not a fact `
            + `about the application: if the two readings are the same page with different input, they are one state, and this `
            + `step is a self-loop on ${previousState} with a \`value_changed\` effect rather than a transition into a state of `
            + 'its own. An identity cannot be withdrawn once recorded, so the graph now has both — read the page as the state '
            + 'you already recorded for the steps that remain, and keep the rest of the walk to states the app is in rather '
            + 'than states the user is passing through.',
    };
};

/**
 * Put the model's account of a step next to the machinery's account of it.
 *
 * This is the whole reason a transition is recorded by a tool rather than written
 * by the model: the effects are a *claim*, the capture is a *fact*, and the value is
 * in them being separable. Neither is treated as authoritative — the model can see
 * what a DOM diff cannot (that a value changed inside an input, that a message is a
 * response to a rejected coupon), and the capture can see what the model cannot (that
 * the URL did not actually change).
 *
 * `errors` are self-contradictions inside one record, which are refused: the effect
 * says the graph entered one state while `to_state` says another, and no amount of
 * evidence makes that true.
 *
 * `warnings` are disagreements, which are reported and recorded. A warning that fires
 * wrongly costs a sentence of the model's attention; a silent disagreement becomes a
 * graph assertion with nothing behind it.
 *
 * Exported (with `diffCaptures`) so the cross-check can be tested against captures
 * directly, without a browser and without a harness: this is the one piece of the tool
 * whose whole job is being right about a disagreement, so it should not be the one
 * piece that is only exercised by a live run.
 */
export function crossCheckEffects({ effects, before, after, fromState, toState, observedChange, settle }) {
    const errors = [];
    const warnings = [];
    const seenMessages = new Set([...statusTexts(before), ...statusTexts(after)]);
    const urlChanged = Boolean(before && after && before.url !== after.url);

    for (const effect of effects ?? []) {
        if (!effect || typeof effect !== 'object') continue;

        if (effect.type === 'state_entered' && effect.to && effect.to !== toState) {
            errors.push(
                `effect state_entered says the app entered ${JSON.stringify(effect.to)} while to_state is `
                + `${JSON.stringify(toState)}. A transition cannot end in two places. to_state is read from the `
                + 'evidence — it is the state this step\'s own reading was recorded in — so it is the effect\'s `to` '
                + 'that has to change: it is that state id, not the page_type and not the variant.',
            );
        }

        if ((effect.type === 'navigation' || effect.type === 'url_changed') && effect.observed === true && !urlChanged) {
            warnings.push({
                kind: 'claimed_navigation_not_observed',
                effect: effect.type,
                detail: `The effect is marked observed, but the URL was unchanged between the two captures (${before?.url ?? 'unknown'}).`,
            });
        }

        if (effect.type === 'message' && effect.message && !seenMessages.has(effect.message)) {
            warnings.push({
                kind: 'claimed_message_not_seen',
                message: effect.message,
                detail: 'No capture in this step carried that text. Quote the app\'s own words, or drop the effect.',
            });
        }

        if (effect.type === 'request' && !(after?.network ?? []).length) {
            warnings.push({
                kind: 'claimed_request_not_observed',
                detail: 'No request was seen in this step. Legitimate for a request that loaded a whole new document (those are not observed yet), but not for a same-document action.',
            });
        }
    }

    const claimsNavigation = (effects ?? []).some(
        (effect) => effect && (effect.type === 'navigation' || effect.type === 'url_changed'),
    );
    if (urlChanged && !claimsNavigation) {
        warnings.push({
            kind: 'unclaimed_url_change',
            detail: `The URL changed to ${after.url} but no navigation or url_changed effect was recorded.`,
        });
    }

    if (observedChange === null) {
        warnings.push({
            kind: 'no_observed_change',
            detail: unmovedNote(settle),
        });
    }

    // A state id is bound to the reading that was made in it, so the same id must describe
    // both ends of a self-loop. Two readings that share no controls are not one state, and
    // the usual cause is a reading taken late: the model reads the page after its own next
    // action, then every endpoint that follows is shifted by one.
    if (fromState && toState && fromState === toState) {
        const arrived = controls(observedChange?.appeared);
        const left = controls(observedChange?.disappeared);
        if (arrived.length && left.length) {
            warnings.push({
                kind: 'self_loop_but_controls_changed',
                detail: `This step starts and ends in ${toState}, but the two readings share no interactive surface: `
                    + `${arrived.length} control(s) appeared and ${left.length} disappeared (${left.slice(0, 3).join(', ')} → `
                    + `${arrived.slice(0, 3).join(', ')}). Two readings that look like different screens are not one state, so `
                    + 'either the state identity does not hold for both, or one reading was taken at a different moment than its '
                    + 'transition. Read the page as soon as its own action is done, and check that the source reading is the state '
                    + 'the action was taken in.',
            });
        }
    }

    return { errors, warnings };
}

export function apply(ctx, config) {
    const observeTool = config.observeTool ?? 'graph_observe';
    const transitionTool = config.transitionTool ?? 'graph_transition';
    const commitTool = config.commitTool ?? 'graph_commit';
    const generateTool = config.generateTool ?? 'graph_test';
    // Resolved once, so the directory the model is told to read and the
    // directory the run store writes to are the same string by construction.
    // They used to be two independent derivations of the config, which is how a
    // custom runDirName could point the model at a directory that never existed.
    const runDirName = normalizeRunDirName(config.runDirName ?? RUN_DIR_NAME);
    // Normalized once, so the value the run store writes is already known to be usable:
    // a bad declaration is refused while the profile is booting, with a message naming
    // what to write, instead of surfacing as a schema path at commit time.
    const application = normalizeApplication(config.application);

    /** Lazily created on the first captured action, so a run needs no explicit start. */
    let run = null;
    /**
     * Re-entrancy guard. Our own captures dispatch `browser_eval` through
     * `ctx.tools.execute`, which re-enters this very waterfall — and `browser_eval`
     * is itself in OBSERVED_TOOLS, so without this guard every capture would
     * capture its own capture, forever. The failure mode is an unbounded loop that
     * hangs the agent, so it is guarded structurally rather than by convention.
     */
    let capturing = false;
    let dispatchSeq = 0;
    /**
     * The two captures the semantic layer needs: the one the model is being asked
     * to interpret, and the one before it, from which the action's effect is
     * derived. `transition.before_observation` / `after_observation` map onto
     * consecutive entries of the chain these produce.
     */
    let latestObservation = null;
    let previousCapture = null;
    /**
     * The observation *before* `latestObservation`. A transition is only derivable
     * from a pair of steps, and this is the far side of the pair: it is where the
     * `from_state` comes from, resolved through the state the model read it as.
     */
    let previousObservation = null;
    /**
     * Set when the evidence log lost a step that is still in memory: the run
     * directory was missing and had to be recreated, so the records it held are not
     * in the log any more. A transition's `before` is a *reference into the log*, so
     * one that points at a lost step is refused rather than recorded — and the
     * refusal says this rather than claiming, as the no-previous-step message does,
     * that the run has only just begun.
     */
    let walkHole = null;

    /**
     * What `graph_observe` could see about the claims in a reading, kept until the step that
     * produced it is recorded.
     *
     * The reading is where the claim is made, and the step is where it is *used* — so the note
     * belongs in both places. In the digest it is the correction the model can still act on; on
     * the edge it is a finding the commit carries into the report, where a reader who arrives
     * after the browser is closed can see why the graph has a state the application is never in.
     * Keyed by the reading, so a note cannot land on a step it is not about.
     */
    const readingNotes = new Map();

    /**
     * What each reading offered to act on, keyed by the reading.
     *
     * Kept for the same reason `readingNotes` is: the question it answers is asked at the *next*
     * reading, about the state this one was bound to, and by then the capture is gone. Only the
     * surface is kept — values, storage and network belong to no later question, and the whole
     * capture lives in the run log for a reader who wants it.
     */
    const surfaceByObservation = new Map();

    /**
     * The turn's instruction, captured from `agent/pre-step` before the step's
     * first tool call. The run store is created on first capture — after this —
     * so by then the instruction is known. It is held here rather than looked up
     * from the session later because the header deliberately does not carry it.
     */
    let instruction = null;

    const warn = (message, error) => {
        try {
            ctx.logger?.warn?.(`[graph-explorer] ${message}`, error);
        } catch { /* logging must never break the run */ }
    };

    const ensureRun = (exec, toolName, toolArgs) => {
        if (run) return run;
        const cwd = workspaceCwd(exec);
        run = createRun({
            cwd,
            runDirName,
            provenance: {
                startUrl: requestedUrl(toolName, toolArgs),
                instruction,
                application,
                maxSteps: config.maxSteps ?? null,
                plugin: self,
                ...agentProvenance(exec),
            },
            // The store is created from inside the recorder, so nothing it does here
            // may throw: `run.json` is written through the same guarded path as every
            // other record, and an unwritable workspace is reported as a store problem
            // to be named at the first attempt to record, not as an exception that
            // fails the browser action that happened to be first.
            onStoreError: (problem) => {
                if (problem.kind === 'recreated') {
                    warn(
                        `${problem.message}: ${problem.path} — records made before this point are only in the`
                        + ' directory that was moved or deleted',
                    );
                } else {
                    warn(`store write failed: ${problem.path} — ${problem.message}`);
                }
            },
        });
        warn(`run started: ${run.dir}`);
        return run;
    };

    /** Dispatch a tool on behalf of the agent, marked as a nested sub-dispatch. */
    const dispatch = async (exec, name, args) => {
        capturing = true;
        try {
            return await ctx.tools.execute({
                callId: `graph-explorer-${++dispatchSeq}`,
                name,
                arguments: args,
                agent: exec.agent,
                parent: exec.token,
                signal: exec.signal,
            });
        } finally {
            capturing = false;
        }
    };

    /**
     * Ask the page to stop moving, and hand back what it said about its own timing.
     *
     * This exists because of a failure the recorder was built to catch and did not:
     * the action resolves, the collector reads the page a few milliseconds later, and
     * a client-rendered page that paints its result any time after that is read as the
     * page the action was taken *on* rather than the page it produced. The step then
     * reads as a self-loop, and every reading after it belongs to the step before its
     * own — the walk is shifted by one from there on.
     *
     * The wait happens inside the document, because only the page knows whether it has
     * stopped: "nothing has changed for N ms" is the honest rule, where a fixed sleep is
     * a guess that is too slow for a static page and too fast for a slow one. The page
     * watches its own mutations and its own in-flight requests (the network hooks are
     * what make the second half possible), and the timing it reports is recorded beside
     * the reading it was taken for.
     *
     * Never throws, for the same reason `capture` does not: a page that cannot answer
     * must still produce a reading, and a failed settle is recorded as a failed settle
     * rather than passed off as a quiet page.
     */
    const settlePage = async (exec) => {
        try {
            const result = await dispatch(exec, 'browser_eval', { expression: SETTLE_EXPRESSION });
            if (result.isError) return { error: result.error?.message ?? 'browser_eval failed' };
            const value = result.value;
            return value && typeof value === 'object' ? value : { error: 'the page did not report its timing' };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    };

    /**
     * Read the page. Never throws: a broken observation must degrade into a
     * recorded failure, never into a broken browser action. The failure IS
     * recorded, because a silently missing observation is exactly the false-pass
     * this tooling exists to remove.
     *
     * That includes the store itself. Writing the record can fail for reasons that
     * have nothing to do with the page — most realistically the run directory being
     * moved or deleted while the agent is still working in it — and when it does the
     * observation is dropped (the store returns null) and named in the log. What it
     * must not do is escape here, because a browser action that worked would then be
     * reported to the model as a failure, and the model would retry it against a page
     * that had already moved on.
     *
     * The reading is taken after the page has been given the chance to stop moving
     * (`settlePage`), and what the page said about its own timing travels with the
     * record it was taken for.
     */
    const capture = async (exec, { tool, toolArgs, screenshotPath, actionIndex }) => {
        const store = ensureRun(exec);
        let settle = null;
        let captureValue = null;
        let captureError = null;
        try {
            // The wait comes first, so the reading that follows describes a page that
            // has stopped. Both are wrapped together, but a settle failure is not a
            // capture failure: it is recorded as its own fact and the reading is taken
            // anyway.
            settle = await settlePage(exec);
            if (settle.error) warn(`the page did not report its timing after ${tool}`, settle.error);
            const result = await dispatch(exec, 'browser_eval', { expression: CAPTURE_EXPRESSION });
            if (result.isError) {
                captureError = result.error?.message ?? 'browser_eval failed';
            } else {
                captureValue = result.value ?? null;
            }
        } catch (error) {
            captureError = error instanceof Error ? error.message : String(error);
        }

        let screenshot = null;
        if (screenshotPath && captureValue) {
            try {
                const result = await dispatch(exec, 'browser_screenshot', { path: screenshotPath });
                if (!result.isError) screenshot = screenshotPath;
            } catch (error) {
                warn('screenshot failed', error);
            }
        }

        let observation = null;
        const repairs = store.recreations();
        // The call's own arguments are the second copy of a value the page withheld, and the
        // one the mask in `capture.js` does not cover: the element is written as `[set]`, and
        // the call that set it as the literal. So the value is taken back out here, where the
        // call and the reading that says the field withheld its value are both in hand — and
        // *before* the reading is appended, so the step whose value it was never lands while
        // the value is still in the run's provenance record. See `redaction.js` for the test
        // and `session.js#withholdValue` for the ordering.
        const supplied = redactCallArguments(tool, toolArgs, captureValue);
        if (supplied.withheld) store.withholdValue(supplied.value);
        try {
            observation = store.addObservation({
                tool,
                toolArgs: supplied.arguments,
                phase: 'after',
                // Which step this reading was taken after. The reading is evidence for
                // that action, and without the link the raw log says only that the
                // reading exists — which is how a reading taken *before* a step ends up
                // carrying that step's id in the graph.
                actionIndex,
                capture: captureValue,
                settle,
                error: captureError,
                screenshot,
            });
        } catch (error) {
            // The store does not throw, so this is the belt to that braces: the
            // recorder runs inside the agent's own tool waterfall, where an exception
            // replaces a result the browser already produced.
            warn('could not write the observation', error);
        }

        // Only a *written* observation becomes the pair the semantic layer reads: a
        // reference in a transition has to resolve to a line the log actually has, so
        // a dropped observation must leave the chain where it was rather than advance
        // it to a record that does not exist.
        if (captureValue && observation) {
            if (store.recreations() !== repairs) {
                // This write is the one that had to rebuild the run directory, so the
                // step before it — and everything the store remembered about the walk
                // so far — is no longer in the log the commit will read. The chain stops
                // here instead of pointing at evidence that is gone.
                walkHole = `the run directory had to be recreated while step ${observation.id} was being written`;
                previousObservation = null;
                previousCapture = null;
            } else {
                previousObservation = latestObservation;
                previousCapture = latestObservation?.capture ?? null;
            }
            latestObservation = observation;
            // The surface of this reading, for the next one to be compared against: the run has to
            // be able to answer "is this page the state I already recorded?" about a capture it is
            // no longer holding.
            surfaceByObservation.set(observation.id, surfaceOf(captureValue));
        }
        return observation;
    };

    // ---------------------------------------------------------------------
    // Seam 1 — the recorder
    // ---------------------------------------------------------------------
    // `tools/execute` is an around-waterfall: `(exec, next)`. Only `exec.signal`
    // may be changed by a wrapper; everything else must be treated as read-only.
    ctx.on('tools/execute', async (exec, next) => {
        if (capturing || !OBSERVED_TOOLS.has(exec.name)) return next();

        const store = ensureRun(exec, exec.name, exec.arguments);
        const step = store.nextStep();
        const screenshotPath = config.screenshot === false
            ? null
            : join(store.evidenceDir, `step-${String(step).padStart(3, '0')}-${exec.name.replace(/^browser_/, '')}.png`);

        let result;
        try {
            result = await next();
        } catch (error) {
            // The action itself failed. The page may still have changed, so the
            // evidence is still worth having — then the error propagates untouched.
            await capture(exec, { tool: exec.name, toolArgs: exec.arguments, screenshotPath, actionIndex: step });
            throw error;
        }

        await capture(exec, { tool: exec.name, toolArgs: exec.arguments, screenshotPath, actionIndex: step });
        return result;
    }, 'graph-explorer: evidence capture');

    // ---------------------------------------------------------------------
    // Provenance — the instruction
    // ---------------------------------------------------------------------
    // `agent/pre-step` is a waterfall carrying the accepted user batch for the
    // step about to run. This only reads it and passes the decision through
    // untouched: an observer that can alter the loop it observes is a liability.
    ctx.on('agent/pre-step', async (payload, next) => {
        try {
            if (!instruction) {
                const messages = Array.isArray(payload?.messages) ? payload.messages : [];
                for (const message of messages) {
                    const text = messageText(message);
                    if (text) {
                        instruction = text;
                        break;
                    }
                }
            }
        } catch (error) {
            warn('could not read the instruction for provenance', error);
        }
        return next();
    }, 'graph-explorer: capture the instruction');

    // ---------------------------------------------------------------------
    // Seam 3 — the protocol
    // ---------------------------------------------------------------------
    // Duplicate section names throw, so the name is namespaced. The order sits
    // between the deployment persona (0) and the plan policy (500), clear of the
    // harness-owned tool bands (1000-2900).
    ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: protocolText({
            observeTool,
            transitionTool,
            commitTool,
            generateTool,
            runDirName,
            maxSteps: config.maxSteps ?? null,
        }),
    });

    // ---------------------------------------------------------------------
    // Seam 2 — the semantic tool
    // ---------------------------------------------------------------------
    ctx.tools.register(defineTool({
        name: observeTool,
        description: 'Record what the current page MEANS as a graph state, and return the evidence digest for it. '
            + 'Call this after every browser action: it is the only way a state reaches the graph. '
            + 'Omit all arguments to only read the digest without recording.',
        parameters: {
            page_type: { type: 'string', description: 'Coarse semantic kind of the page (home, login, project_list, settings, error, ...)' },
            variant: { type: 'string', description: 'Actor/session variant when it changes what the page offers (anonymous, authenticated, admin)' },
            dimensions: {
                type: 'object',
                additionalProperties: true,
                description: 'Discriminating facts that separate states sharing a route, e.g. {"projects":"empty"}. '
                    + 'A dimension is a fact about the application. A form with a value in it is the same state as the '
                    + 'form without it: element state is not identity, and filling a field is a value_changed effect on '
                    + 'a self-loop.',
            },
            summary: { type: 'string', description: 'One sentence describing this state from the user\'s point of view' },
            elements: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'Elements a test would act on: {semantic_purpose, role, name, locator, ...}. semantic_purpose is the identity.',
            },
            detection: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'How a test proves it is in this state: {type: url|element_state|element_value|message|absence|..., ...}. '
                    + 'The condition goes in `operator` or `value`/`expected`; an element must resolve to a semantic_purpose a '
                    + 'state has declared. Refused rather than recorded if it would be dropped at commit.',
            },
            affordances: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'What this surface OFFERS and the walk is not exercising: '
                    + '[{element: "element_<semantic_purpose>", expected_behavior: "reset_password"}]. The element must be one THIS '
                    + 'reading declares in `elements`. Record it here or not at all: a reading is the only moment a surface can be '
                    + 'read for what it offers, and the first step that performs one of these refutes it. Not a claim about '
                    + 'coverage — say nothing rather than listing what you did not get round to.',
            },
            confidence: { type: 'number', description: '0..1 confidence in this reading' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const store = ensureRun(exec);
            const problem = store.writeProblem();
            if (problem) {
                throw new Error(storeFailureMessage(
                    problem,
                    runDirName,
                    'Nothing was recorded. The page is still where it is, so once the workspace is writable again '
                    + 'this reading can be made straight away — no action has to be repeated for it.',
                ));
            }
            const latest = latestObservation;
            if (!latest) {
                throw new Error(
                    'No evidence has been captured yet, so there is nothing to interpret. '
                    + 'Drive the page with a browser_* tool first (browser_open is usually the one you want).',
                );
            }

            // The step's own diff, computed once. The digest reports it, and the notes below
            // are what the machinery can see about the claims this reading was given *in the
            // light of it* — computing it twice would be the place a claim and its evidence
            // drifted apart.
            const change = diffCaptures(previousCapture, latest.capture);
            const previousState = previousObservation ? store.stateForObservation(previousObservation.id) : null;
            const notes = [];

            let state = null;
            if (args.affordances !== undefined && !args.page_type) {
                // An affordance is a fact about a surface, and it is the surface reading — not the
                // capture — that names one. Accepting it without `page_type` would mean holding it
                // until some later reading, which is the one thing this claim cannot survive: the
                // page it was read from is gone by then, and nothing could refute it.
                throw new Error(
                    'affordances were given without page_type, so there is no surface for them to belong to. An affordance is '
                    + 'what a surface offers: name the state it was read from — `page_type`, and `variant`/`dimensions` if this '
                    + 'surface is a variant of one — and the reading and its affordances are recorded together. Nothing was '
                    + 'recorded, and the page has not moved, so call again with the state named.',
                );
            }
            if (args.page_type) {
                if (!Array.isArray(args.detection) || args.detection.length === 0) {
                    throw new Error(
                        `State "${args.page_type}" was rejected: it has no detection. `
                        + 'A state that cannot be asserted cannot appear in a generated test. '
                        + 'Add at least one detection entry, e.g. {"type":"url","operator":"matches","expected":"/projects"} '
                        + 'or {"type":"element_state","target":{"semantic_purpose":"projects_empty_notice"},"operator":"exists"}.',
                    );
                }
                const badType = args.detection.find((entry) => entry && !DETECTION_TYPES.has(entry.type));
                if (badType) {
                    throw new Error(
                        `detection entry has type ${JSON.stringify(badType.type)}, which is not one of: `
                        + [...DETECTION_TYPES].join(', ') + '. Fix the entry and call again.',
                    );
                }
                const badElement = (args.elements ?? []).find((element) => !element?.semantic_purpose);
                if (badElement) {
                    throw new Error(
                        'Every element needs a semantic_purpose: it is the identity a generated test will use, '
                        + 'and a CSS locator is evidence, not identity. Add semantic_purpose and call again.',
                    );
                }
                // What the graph can resolve a name against, as it stands: the purposes the
                // recorded states declared, plus the ones this reading declares. Built before
                // anything is written, so a refused reading leaves no trace.
                const registry = registryFrom(store.states(), args.elements);
                const stateKey = identityKey({ page_type: args.page_type, variant: args.variant, dimensions: args.dimensions });
                const alreadyRead = store.states().find((record) => record.identity_key === stateKey);
                // --- what this surface offers and the walk is not taking --------
                // The one claim in the vocabulary that is about an absence, checked here for the
                // reason every other check in this tool is: this is the only moment the surface
                // that offers it is on screen, and the reading is what makes the claim falsifiable.
                //
                // P13 in the small: an affordance is offered BY a surface, so its element has to be
                // one this state declares — and "this state" is the union of its readings, because
                // the commit unions them: a repeat reading that restates fewer elements is not a
                // smaller state. (The store's index holds canonical records only, so an element
                // first declared by a repeat reading is invisible here; `registryFrom` has the same
                // limit, and it is the honest one — a tool can only know what the store holds.)
                const offerable = new Set([...(args.elements ?? []), ...(alreadyRead?.elements ?? [])]
                    .map((element) => element?.semantic_purpose)
                    .filter((purpose) => typeof purpose === 'string' && ELEMENT_PURPOSE_PATTERN.test(purpose))
                    .map((purpose) => `element_${purpose}`));
                const affordances = args.affordances === undefined ? [] : args.affordances;
                if (!Array.isArray(affordances)) {
                    throw new Error(
                        `affordances must be an array of {element, expected_behavior} entries; got `
                        + `${JSON.stringify(affordances)}. One entry is one control this surface offers and the walk is not `
                        + 'taking, so a single object would be a list of one — and the list is the claim. Nothing was recorded.',
                    );
                }
                const recordedAffordances = affordances.map((entry) => normalizeAffordance(entry));
                for (const affordance of recordedAffordances) {
                    if (offerable.has(affordance.element)) continue;
                    // The two ways this happens are worth telling apart, because the repair is not
                    // the same: an element this state never declared needs declaring on this
                    // reading, while an element another state declared is a claim about the wrong
                    // surface — and only the first is a mistake about the id form.
                    const declaredElsewhere = store.states()
                        .filter((record) => record.identity_key !== stateKey)
                        .some((record) => (record.elements ?? [])
                            .some((element) => element?.semantic_purpose && `element_${element.semantic_purpose}` === affordance.element));
                    const asPurpose = registry.elementIdByPurpose.has(affordance.element)
                        ? `\`${affordance.element}\` is a declared purpose and the id form is \`${registry.elementIdByPurpose.get(affordance.element)}\`.`
                        : '';
                    throw new Error(
                        `State "${args.page_type}" was rejected: its affordances name ${JSON.stringify(affordance.element)}, which `
                        + 'this state\'s own elements do not declare. An affordance is offered BY a surface, so it anchors to an '
                        + `element of the surface it was read from, and this reading declares: ${listOf([...offerable]) || 'none'}. `
                        + (declaredElsewhere
                            ? 'That element is declared on another state, which is the other way this goes wrong: the control belongs '
                                + 'to a different surface, so either read the state that offers it, or declare the element here as well '
                                + 'if this surface really has it too. '
                            : asPurpose ? `${asPurpose} ` : '')
                        + 'Nothing was recorded, and the page has not moved, so add the element to this reading\'s `elements` with '
                        + 'the same semantic_purpose — an element the walk acts on later has to be declared here for the same '
                        + 'reason — and call again.',
                    );
                }
                // A detection is a claim, and a claim the commit cannot resolve or cannot
                // evaluate is a claim the graph loses. Refused here, while the page that would
                // give the model a better one is still on screen.
                refuseDroppedDetections(args.detection, registry, latest.capture?.url);
                const masked = maskedValueRefusal(args.detection, registry, latest.capture);
                if (masked) {
                    throw new Error(`State "${args.page_type}" was rejected: ${masked} Nothing was recorded, so fix the `
                        + 'entry and call again.');
                }
                // Before asking whether the claims in this reading hold, ask whether the page is
                // the state at all. They are different questions, and this is the one that can be
                // asked when the other cannot: a detection that names no element is refuted by
                // nothing, so a reading bound to the state it has just left is visible only in
                // the surfaces — and only while the tool still has both of them.
                // (`alreadyRead` is derived further up, with the affordances, which have to ask
                // the same question — which state is this reading about — one step earlier.)
                const surfaceClash = alreadyRead
                    ? surfaceMismatchRefusal({
                        stateId: alreadyRead.state_id,
                        surface: surfaceOf(latest.capture),
                        others: store.observationsForState(alreadyRead.state_id)
                            .map((id) => surfaceByObservation.get(id))
                            .filter(Boolean),
                    })
                    : null;
                if (surfaceClash) {
                    throw new Error(`State "${args.page_type}" was rejected: ${surfaceClash}`);
                }
                // The other half of asking early: not "could the graph carry this claim?" but "is
                // it true of the page in hand?". A claim this reading's own capture refutes is
                // refuted forever, because the reading it would be bound to is immutable.
                const refuted = refutedDetectionRefusal(args.detection, registry, latest.capture);
                if (refuted) {
                    throw new Error(`State "${args.page_type}" was rejected: ${refuted}`);
                }
                const recorded = store.addState({
                    observationId: latest.id,
                    page_type: args.page_type,
                    variant: args.variant,
                    dimensions: args.dimensions,
                    summary: args.summary,
                    elements: args.elements,
                    detection: args.detection,
                    confidence: args.confidence,
                    model_status: 'observed',
                    affordances: recordedAffordances,
                });
                if (!recorded) {
                    // The reading was refused rather than half-kept: an id handed back
                    // for a record the log does not contain is a reference that cannot
                    // be committed, and the model would go on to write transitions
                    // against it.
                    throw new Error(storeFailureMessage(
                        store.writeProblem() ?? { path: store.statesPath, message: 'the write failed' },
                        runDirName,
                        'Nothing was recorded, so call this again once the workspace is writable: the page is still '
                        + 'showing what it showed, and no browser action has to be repeated.',
                    ));
                }
                state = {
                    state_id: recorded.id,
                    new: recorded.minted,
                    note: recorded.minted
                        ? 'Minted a new state for this identity.'
                        : 'This identity was already recorded — reused the existing state id instead of minting a duplicate.',
                    // Reported because these are the only claims in the reading that `graph.json`
                    // has no room for: 0.1's `state.schema.json` is `additionalProperties: false`
                    // and declares no `affordances`, so they live in the log and reach the
                    // application model at commit. Saying so here is the difference between a
                    // claim that was recorded and one the model believes was.
                    ...(recordedAffordances.length
                        ? { affordances: recordedAffordances.map((affordance) => affordance.element) }
                        : {}),
                };
                // What the reading itself says about the claims it was given. Both of these were
                // previously invisible until the commit, by which time the page was gone: a
                // value the capture contradicts, and an identity minted out of a form's progress.
                notes.push(...valueMismatchNotes(args.detection, registry, latest.capture));
                const identity = elementStateIdentityNote({ minted: recorded.minted, previousState, change });
                if (identity) notes.push(identity);
                // Held for the transition that records this step, so the same note reaches the
                // commit report and not only the model's next digest.
                if (notes.length) readingNotes.set(latest.id, notes);
            }

            const digest = {
                evidence: {
                    observation_id: latest.id,
                    evidence_index: store.observationsPath,
                    screenshot: latest.screenshot ?? null,
                    captured_for: latest.tool,
                },
                page: latest.capture
                    ? {
                        url: latest.capture.url,
                        title: latest.capture.title,
                        headings: (latest.capture.headings ?? []).map((heading) => heading.text).filter(Boolean),
                    }
                    : null,
                capture_error: latest.capture_error ?? null,
                // What the page said about its own timing when this reading was taken:
                // how long it was watched after the action, whether it was still moving
                // at the end, and how many of its own requests were still open. Reported
                // here as well as in the evidence record, because a reading taken on a
                // page that never went quiet is a different claim from one taken on a
                // page that had, and the model is the one that has to know which it got.
                settle: latest.settle ?? null,
                // Whether the collector was watching before this document ran its own
                // scripts. It qualifies the lists below: an empty `network` is a fact —
                // "this document made no requests" — only when this says `document_start`.
                // Otherwise we arrived after the document had already started, so the
                // empty list means "we looked too late", which is not the same claim.
                hooks_installed_at: latest.capture?.hooks_installed_at ?? null,
                // The run's first observation has no previous capture to diff against, and
                // that is the one step where "what this capture saw" and "what changed"
                // are the same question: how the run began. The requests the entry
                // document loaded with are reported here rather than left in the evidence
                // log, because the entry state is read at this step.
                entry_document: previousCapture || !latest.capture ? null : {
                    url: latest.capture.url,
                    title: latest.capture.title,
                    hooks_installed_at: latest.capture.hooks_installed_at ?? null,
                    requests: latest.capture.network ?? [],
                    note: 'First observation of the run: the requests this document loaded with, '
                        + 'before any action was taken.',
                },
                changed_since_previous_observation: change,
                // What the machinery can see about the claims in this reading, said while the
                // page that would bear them out is still on screen. Reported here rather than
                // left to the commit because a claim that does not hold is only *known* to not
                // hold while the evidence that refutes it is the current page: the correction
                // costs one call now, and nothing at all later.
                reading_notes: notes,
                status: latest.capture?.status ?? [],
                interactive: latest.capture?.interactive ?? [],
                // The endpoints this reading's own requests went to, with the id each one has in
                // the graph. They are here for the same reason the element ids are: a claim about
                // a request can only be checked against the evidence if the claim names the id
                // the evidence produced, and the `apis` argument of `graph_transition` takes these
                // ids. Nothing here is inferred from a URL pattern — an entry is a call the page
                // actually made while this reading was being taken.
                apis: observedApis(latest.capture?.network).map((api) => ({
                    id: api.id,
                    method: api.method,
                    path: api.path,
                    ...(api.statuses.length ? { status: api.statuses.length === 1 ? api.statuses[0] : api.statuses } : {}),
                    ...(api.failed ? { failed: true } : {}),
                })),
                storage: latest.capture?.storage ?? {},
                // The key names the page's storage carries that `storage` above does not. A cookie
                // name is often the only thing that tells a signed-in screen from the form that
                // gets you there, and these are two thirds of what `state.metadata.extra.observable`
                // is made of — so the model naming a state can see the same evidence the commit
                // will compare states on. Names only, never values: see capture.js.
                session_storage_keys: latest.capture?.session_storage_keys ?? [],
                cookie_names: latest.capture?.cookie_names ?? [],
                console: latest.capture?.console ?? [],
                page_errors: latest.capture?.page_errors ?? [],
                graph: {
                    state,
                    states_recorded: store.stateCount(),
                    observations_recorded: store.observationCount(),
                    capabilities_recorded: store.capabilityCount(),
                    transitions_recorded: store.transitionCount(),
                    steps_walked: store.walkLength(),
                    // The state variables the walk has moved so far, and whether the states it has
                    // recorded hold them. Said here as well as in the commit report because this is
                    // where a state gets named: a fact the application remembers is the one thing
                    // that has to be a dimension on the state it produces, and by the time the
                    // commit says so the page where it mattered is gone.
                    state_variables: stateVariableRollup(store),
                    // What the surfaces read so far have offered and the walk has not taken,
                    // counted across every reading — sightings included, because a second reading
                    // of a surface sees the same controls. A count rather than a list, because the
                    // question is "is this reading the one that finally said what the page
                    // offers?"; the per-reading answer is on `state.affordances` above, and the
                    // claims themselves are in `states.jsonl` — `graph.json` has no room for them.
                    affordances_recorded: store.affordanceCount(),
                    // The two vocabularies the machinery cannot see for itself: what the run has
                    // called the product features and the journeys. Both are the model's words, and
                    // a second name for a thing it already named is the failure mode — so the names
                    // in play are reported where the model is looking.
                    features_claimed: store.featureNames(),
                    journeys_named: store.journeyNames(),
                    // Steps the log does not have, because a write failed at some point
                    // and the run got past it. Non-zero means the counters above are not
                    // the whole story of what was done to this page, and the graph will
                    // be missing those steps — reported so the model can say so in its
                    // hand-off instead of presenting a short walk as a complete one.
                    unwritten_records: store.writeFailures(),
                    // A different loss, and not inferable from the one above: the run
                    // directory had to be rebuilt, so records that *were* written are in
                    // the directory that moved away rather than in this log. Each one
                    // means the log begins again somewhere inside the run, and the graph
                    // assembled from it is the part of the run after that point.
                    directory_recreations: store.recreations(),
                },
            };
            return trimDigest(digest, config.maxDigestChars ?? 14000);
        },
    }));

    // ---------------------------------------------------------------------
    // Seam 2b — the transition
    // ---------------------------------------------------------------------
    // A transition is the only place the model's reading and the machinery's record
    // are forced to sit in the same object, so it is the only place a disagreement
    // between them can be caught while the page is still open. Both endpoints are
    // DERIVED from evidence rather than accepted as arguments: a state id typed by
    // the model would be a dangling reference waiting to happen, and the run already
    // knows the answer.
    ctx.tools.register(defineTool({
        name: transitionTool,
        description: 'Record the transition one browser action produced: which capability was applied, '
            + 'from which state, into which state. Call this after graph_observe has recorded the state the '
            + 'action landed in. The from_state and to_state are derived from evidence — you do not pass them. '
            + `Returns the machine-observed change for the step beside your claimed effects, so you can see `
            + 'whether they agree. Omitting every argument only reports where the walk currently stands.',
        parameters: {
            capability: {
                type: 'string',
                description: 'snake_case verb phrase naming the behaviour, e.g. login, add_product_to_cart, '
                    + 'apply_coupon. Reuse the exact name you used before for the same behaviour — the vocabulary '
                    + 'is the point of a capability.',
            },
            capability_kind: {
                type: 'string',
                description: 'interaction | navigation | query | setup (login/seed) | composite. Recorded on first use.',
            },
            capability_input: {
                type: 'object',
                additionalProperties: true,
                description: 'Parameter type map, recorded on first use: {"coupon_code":{"type":"string","required":true}}. '
                    + 'Each value is a primitive type name (string|number|integer|boolean|object|array|any) or an object whose '
                    + '`type` is one of those — the schema allows no other key. This is the capability\'s parameters, NOT the '
                    + 'concrete values used this time. It is also where a step\'s "{{param}}" template is declared: a '
                    + 'behaviour\'s input is read from the inputs of the capabilities it is composed of, so declare the '
                    + 'parameter on the capability that is the step, and a template nothing declares is refused '
                    + '(`unbound_parameter`) — which withholds the model. Write the literal value instead if you would '
                    + 'rather not declare it.',
            },
            capability_output: {
                type: 'object',
                additionalProperties: true,
                description: 'What the capability yields, e.g. {"discount":"number"} or {"discount":{"type":"number"}}. Same '
                    + 'value-spec shape as capability_input. Recorded on first use.',
            },
            capability_composed_of: {
                type: 'array',
                items: { type: 'string' },
                description: 'For a behaviour built out of others: the snake_case names of the capabilities it contains, in the '
                    + 'order a test would perform them, e.g. ["fill_email","fill_password"] for `login`. Each name must already '
                    + 'be in the vocabulary — record the steps first, then the behaviour that contains them — and a capability '
                    + 'may not contain itself. Pass `capability_kind: "composite"` with it: the schema\'s own word for "built '
                    + 'from other capabilities" is `composite`, and a composition without it is recorded and reported as one. '
                    + 'The primitive steps are recorded as transitions of their own, as usual; this only says which '
                    + 'behaviours add up to this one.',
            },
            capability_behaviour: {
                type: 'string',
                description: 'For a step that is PART of a behaviour: the snake_case name of the behaviour this step is a '
                    + 'step of, e.g. "login" for the step that submits the form. This is how an action becomes a step of a '
                    + 'composite instead of a capability nothing contains: the step is appended to that behaviour\'s '
                    + '`composed_of`, and the behaviour is created as `composite` if the vocabulary does not have it yet. '
                    + 'Use it on the step that does the work, in the same call: name the behaviour and perform it at once, '
                    + 'rather than afterwards from memory. Record the behaviour\'s own completion as a separate step of it '
                    + 'when it has one (`login` contains the submit, and the submit is a step of `login`). A behaviour '
                    + 'cannot be a step of itself.',
            },
            realization: {
                type: 'object',
                additionalProperties: true,
                description: 'How the browser performs THIS step, as one step of the behaviour named by '
                    + '`capability_behaviour`: {action, element, value, purpose, arguments, effects, optional, timeout_ms, '
                    + 'description}. `action` is required and is one of the schema\'s own verbs: '
                    + `${[...STEP_ACTIONS].join(', ')}. \`element\` is element_<semantic_purpose>, the same id \`target\` takes — and it `
                    + 'is the id the edge is recorded acting on, so a call that performs a step does not have to pass `target` as '
                    + 'well; `value` is a string — the literal the page was given, or "{{param}}" bound to the behaviour\'s '
                    + 'input, and a template is a parameter the call has to declare with `capability_input` on the '
                    + 'capability it records, because a template nothing declares is refused (`unbound_parameter`) and '
                    + 'withholds the model; `purpose` '
                    + 'is the step\'s part in the behaviour in the behaviour\'s own words (enter_credentials, submit), which '
                    + 'is what survives an element being renamed; `effects` is the same effect list as the transition\'s, '
                    + 'scoped to this step, because a multi-step behaviour lands its state only on its last step and without '
                    + 'them the only way to say which step did the work is to re-read the observations. Refused without '
                    + '`capability_behaviour`: a step that is a step of nothing is not a step. Recorded in '
                    + '`capabilities.jsonl` beside the composition, and it is what the graph writes as the capability\'s '
                    + '`steps[]` (capability.schema.json#/$defs/capabilityStep) — the ordered list a generator expands a '
                    + 'behaviour with. `purpose` and `effects` are the behaviour model\'s, not the graph\'s: the schema has '
                    + 'no room for them in `steps[]`, so they stay in the log.',
            },
            journey_name: {
                type: 'string',
                description: 'What the walk this step belongs to is a journey TOWARDS, in the user\'s own words, e.g. '
                    + '"Sign in and see the project list". A journey is derived from the walk order, so this is the one '
                    + 'thing about it the machinery cannot see: without a claim the journey keeps the whole run instruction '
                    + 'as its name and goal, which a test generator then has to rewrite. State it once, on any step of the '
                    + 'walk (the last is the natural place) — the walk\'s latest claim names the whole walk.',
            },
            feature: {
                type: 'string',
                description: 'The product feature this step is part of, e.g. "authentication" or "project_management". '
                    + 'Features have no machine source — nothing in a page says what a product is for — so the words are '
                    + 'yours, and the commit assembles `features[]` from the capabilities, states, transitions and journeys '
                    + 'that claim one. Reuse the exact words on every step of the same feature: the name is the key.',
            },
            arguments: {
                type: 'object',
                additionalProperties: true,
                description: 'The concrete values this action was given, e.g. {"coupon_code":"SAVE10"}. They are read against '
                    + 'THIS transition\'s own evidence — each one is looked for among this transition\'s effects and this step\'s '
                    + 'observation — so a value the page reports back belongs in the step\'s `value` (a `value_changed` effect is '
                    + 'where it appears), and an argument on the edge that merely followed the fill is a claim nothing the click did '
                    + 'reports and refuses the model (`unobserved_argument`). The rule is per edge: the fill\'s value goes on the fill.',
            },
            target: {
                type: 'string',
                description: 'The element acted on, as element_<semantic_purpose>: the control the capability was applied to. Omit '
                    + 'it when the call has a `realization` — a step\'s `element` is the same id, it is where this walk states '
                    + 'which control the verb acted on, and the edge is recorded with it. Passing both is allowed only when they '
                    + 'name the same element: two different controls in one call is refused rather than guessed.',
            },
            guard: {
                type: 'string',
                description: 'Human-readable condition that must hold for this transition, e.g. cart.item_count > 0.',
            },
            effects: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'What changed. Each entry is {type, ...}: navigation/url_changed/state_entered need `to`; '
                    + 'value_changed/visibility_changed need `target` and `to`; message needs `message`; request needs '
                    + '`api`; storage_changed/validation_error/list_changed/element_created/element_destroyed need `target`. '
                    + 'state_entered\'s `to` is the state id the step arrived in — the `state_id` the tool reported for this '
                    + 'step\'s own reading — not the page_type or the variant. navigation/url_changed\'s `to` is the URL. '
                    + 'An element-shaped target (value_changed, visibility_changed, element_created, element_destroyed, '
                    + 'validation_error) is the element\'s semantic_purpose — `email_input`, not `login.email` and not a '
                    + 'selector: an effect that does not resolve to a declared element is dropped at commit, so it is '
                    + 'refused here. A non-element target (storage_changed, list_changed) is a semantic path or key. '
                    + 'Set "observed": true only for what the evidence actually shows.',
            },
            apis: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ids of the API calls this transition triggers, as api_<name>.',
            },
            assertions: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description: 'Checks that should hold after this step when a test is generated: {type, target, operator, expected}.',
            },
            preconditions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags or ids that must already hold, e.g. user_authenticated.',
            },
            description: { type: 'string', description: 'One sentence describing this transition.' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const store = ensureRun(exec);

            // Read-only report. `capability` is the one argument that means "record
            // something", so OMITTING it is a request to look rather than a mistake —
            // and it is the only way to ask where the walk stands after a chain break.
            // Supplying it and getting it wrong is still refused below: the two cases
            // are told apart by absence, not by validity.
            if (args.capability === undefined) {
                const last = store.lastTransition();
                const ignored = Object.keys(args).filter((key) => args[key] !== undefined);
                const failure = store.writeProblem();
                const unwritten = store.writeFailures();
                const recreations = store.recreations();
                return {
                    recorded: false,
                    note: ignored.length
                        ? `No capability was given, so nothing was recorded — these arguments were read and ignored: `
                            + `${ignored.join(', ')}. Pass \`capability\` to record a transition.`
                        : 'No arguments were given, so nothing was recorded. This is the state of the walk.',
                    // Reported here as well as in the digest: this call is where a
                    // model looks after a chain break, and a run whose log is not
                    // keeping up has to say so there rather than let it conclude that
                    // it simply never acted.
                    ...(failure || unwritten || recreations
                        ? {
                            store: {
                                unwritten_records: unwritten,
                                directory_recreations: recreations,
                                last_write_failure: failure ? `${failure.path}: ${failure.message}` : null,
                            },
                        }
                        : {}),
                    walk: {
                        steps_walked: store.walkLength(),
                        transitions_recorded: store.transitionCount(),
                        states_recorded: store.stateCount(),
                        capabilities_recorded: store.capabilityCount(),
                        observations_recorded: store.observationCount(),
                        last_step: last
                            ? {
                                transition_id: last.id,
                                from_state: last.from_state,
                                to_state: last.to_state,
                                capability: last.action?.capability ?? null,
                                chain_break: last.chain_break,
                            }
                            : null,
                    },
                    vocabulary: store.capabilityNames(),
                    // Features and journeys are vocabulary too, and the same argument applies:
                    // the second use of a name has to be the same name. Reported here so a model
                    // can pick up the wording it already used rather than invent a second one.
                    features: store.featureNames(),
                    journeys: store.journeyNames(),
                };
            }

            // Recording is refused while the log is not keeping up, and refused before
            // anything is read from the chain: the store's memory only ever contains
            // what the log contains, so what is in it now is a *shorter* walk than the
            // model remembers having made, and writing against it would produce a graph
            // whose steps are missing without saying so.
            const problem = store.writeProblem();
            if (problem) {
                throw new Error(storeFailureMessage(
                    problem,
                    runDirName,
                    'Nothing was recorded. Once the workspace is writable again, carry on from here: the walk in the '
                    + 'log is what it is, and the next step you record will be chained to it.',
                ));
            }

            const after = latestObservation;
            if (!after) {
                throw new Error(
                    'No evidence has been captured yet, so there is no transition to record. '
                    + 'Drive the page with a browser_* tool first, then read the result with '
                    + `\`${observeTool}\`.`,
                );
            }
            if (!after.capture) {
                throw new Error(
                    `Step ${after.id} could not be read (${after.capture_error ?? 'the capture failed'}), so neither end of `
                    + 'a transition can be established for it. Record what is on screen now by acting once more and '
                    + `calling \`${observeTool}\`, or leave this step out of the graph.`,
                );
            }

            const before = previousObservation;
            if (!before) {
                throw new Error(walkHole
                    ? `There is no longer any step before this one: ${walkHole}, so the record of it is in the directory `
                        + 'that was moved or deleted rather than in the log the graph is assembled from. A transition '
                        + 'needs both ends to be evidence, and nothing was recorded. Act once more and read the state '
                        + `again with \`${observeTool}\` — the next step will start a new strand of the walk, and the `
                        + 'digest and the commit report both say the log lost ground.'
                    : 'There is no step before this one, so there is no transition: the first browser action establishes '
                        + 'the entry state rather than moving between states. Record it with '
                        + `\`${observeTool}\` and act again.`);
            }

            const toState = store.stateForObservation(after.id);
            if (!toState) {
                throw new Error(
                    `No state has been read for step ${after.id} (${after.tool}), so this transition has no destination. `
                    + `Call \`${observeTool}\` first — the reading has to happen while the page still shows it.`,
                );
            }

            const fromState = store.stateForObservation(before.id);
            if (!fromState) {
                throw new Error(
                    `No state was ever read for step ${before.id} (${before.tool}), so this transition has no source, and `
                    + 'that cannot be repaired now: a reading has to be made while its page is still on screen. Skip this '
                    + `transition and call \`${observeTool}\` after every action from here on, including the first.`,
                );
            }

            // --- capability -------------------------------------------------
            const capabilityName = typeof args.capability === 'string' ? args.capability.trim() : '';
            if (!CAPABILITY_NAME_PATTERN.test(capabilityName)) {
                throw new Error(
                    `capability ${JSON.stringify(args.capability)} is not usable: the schema requires a lowercase `
                    + 'snake_case verb phrase starting with a letter, e.g. login, add_product_to_cart, apply_coupon. '
                    + 'Name the behaviour, not the element you clicked.',
                );
            }
            if (args.capability_kind !== undefined && !CAPABILITY_KINDS.has(args.capability_kind)) {
                throw new Error(
                    `capability_kind ${JSON.stringify(args.capability_kind)} is not one of: `
                    + `${[...CAPABILITY_KINDS].join(', ')}. Pick the closest and call again.`,
                );
            }

            const notes = vocabularyNotes(capabilityName, store.capabilityNames());
            // A composition is written in names and stored as ids, because the schema closes
            // `composed_of` to `capabilityId` and the model thinks in behaviours. Every name has to
            // resolve NOW: the alternative is writing a reference to a behaviour nothing has
            // recorded, which the commit would have to drop — losing the whole point of the
            // declaration. The steps come first, so this is a same-run fact, not a lookup.
            const composedNames = (Array.isArray(args.capability_composed_of) ? args.capability_composed_of : [])
                .map((name) => (typeof name === 'string' ? name.trim() : ''))
                .filter(Boolean);
            for (const step of composedNames) {
                if (!CAPABILITY_NAME_PATTERN.test(step)) {
                    throw new Error(
                        `capability_composed_of entry ${JSON.stringify(step)} is not a capability name: use the same lowercase `
                        + 'snake_case verb phrase you passed as `capability` when you recorded that step, e.g. fill_email.',
                    );
                }
            }
            if (composedNames.includes(capabilityName)) {
                throw new Error(
                    `capability_composed_of names ${capabilityName}, which is the capability being recorded. A behaviour cannot be `
                    + 'built from itself: name the steps it is made of, and record the step that completes it as this transition. '
                    + 'Nothing was recorded.',
                );
            }
            const unresolvedSteps = composedNames.filter((step) => !store.capabilityIdFor(step));
            if (unresolvedSteps.length) {
                const known = listOf(store.capabilityNames());
                throw new Error(
                    `capability_composed_of names ${listOf(unresolvedSteps)}, and no capability in this run has that name yet, so the `
                    + 'reference would be dropped when the graph is committed. Record the step as its own transition first — the '
                    + 'capability is created by the `capability` argument of that call — and then record the behaviour that contains '
                    + `it. ${known ? `The vocabulary so far: ${known}.` : 'Nothing has been recorded as a capability yet.'} `
                    + 'Nothing was recorded and the page has not moved, so call again with the step names as they were recorded.',
                );
            }
            // The capability's signature is free-form JSON the schema closes: its values are
            // `argumentValueSpec`s, not JSON Schema, and both maps set `additionalProperties:
            // false`. Nothing between this call and the committed document looks at it again —
            // the commit's rules are identity, evidence and dangling references — so an
            // unrecognized key here produces an INVALID graph that is still reported as
            // committed. Refused before the capability is written, so a corrected call writes it
            // once, as the first sighting.
            for (const [label, value] of [['capability_input', args.capability_input], ['capability_output', args.capability_output]]) {
                const problem = argumentMapProblem(label, value);
                if (problem) throw new Error(`${problem} Nothing was recorded, so fix it and call again.`);
            }
            // Derived up here rather than with the rest of the behaviour handling below, because the
            // realisation has to be checked before anything is written: a realisation is a step *of*
            // a behaviour, so the two are either both acceptable or both refused, and a call that
            // recorded the capability and only then refused the step would have claimed a name it
            // never performed.
            const behaviourName = typeof args.capability_behaviour === 'string' ? args.capability_behaviour.trim() : '';
            // --- the realisation: how this step is performed ------------------
            // The one argument that describes the browser rather than the application, and it is
            // required to have a behaviour to belong to. A realisation is not a second name for the
            // step — it is the verb, the element and the value, which are the three things a test
            // generator needs and the three things a capability id cannot be read for.
            if (args.realization !== undefined && !behaviourName) {
                throw new Error(
                    'realization was given without capability_behaviour, so the step describes a behaviour that was not named. '
                    + 'A realisation says HOW a behaviour is performed, step by step, so it needs the behaviour it is a step of: '
                    + 'pass `capability_behaviour` naming it — the same behaviour the other steps of this walk named — and the two '
                    + 'are recorded together, in this call. Nothing was recorded, so call again with both.',
                );
            }
            // Thrown rather than repaired, for the reason every other argument here is: the value
            // would be written to the log as the run\'s account of what the browser did, and a step
            // with an invented verb is an account of something that did not happen.
            const realizationStep = args.realization === undefined ? null : normalizeRealizationStep(args.realization);
            // --- the realisation's own references ---------------------------
            // Checked here, before the first write, because `capability.schema.json` types a step's
            // element as an element ID and not as a purpose: the near miss is a purpose with the id
            // prefix added by hand or a purpose left bare, and both produce a step whose element
            // resolves to nothing. `fill` on nothing is not a step a generator can perform, and a
            // realisation that loses its steps is the exact outcome Phase 1 exists to prevent — so
            // this is a refusal, and it has to come before the capability is created or a refused
            // step would have claimed a name it never performed.
            //
            // The spellings differ, and it is the whole reason this check names both: `target` and
            // an element-shaped effect take the bare `semantic_purpose` (`email_input`), because
            // those are the model's shorthand for the control it means, while a step takes the id
            // `element_email_input`, because a step is a reference to a declared element.
            const known = registryFrom(store.states(), []);
            // The ids, not the keys: `elementIdByPurpose` is keyed by the purpose a state declares
            // (`email_input`) and maps to the id the commit mints for it (`element_email_input`),
            // and a step is written in the second form. Reading `.has()` off the map is the mistake
            // that would refuse every valid step and accept every invalid one — which is why this
            // is a set of the values and why the message below lists them.
            const declaredElementIds = new Set(known.elementIdByPurpose.values());
            if (realizationStep?.element !== undefined && !declaredElementIds.has(realizationStep.element)) {
                const declaredIds = listOf([...declaredElementIds]);
                // The near miss is the case worth a longer answer: the element IS declared and the
                // model wrote it the way every other argument in the tool wants it. Naming the id it
                // should have written is a longer refusal and a shorter repair. (A bare purpose
                // normally fails the id pattern first, in `normalizeRealizationStep`; this branch is
                // for the ones that happen to be shaped like an id.)
                const asPurpose = known.elementIdByPurpose.has(realizationStep.element)
                    ? `\`${realizationStep.element}\` is declared, and a step takes the ID rather than the purpose: write `
                        + `\`${known.elementIdByPurpose.get(realizationStep.element)}\`.`
                    : `A step's element is an element ID — \`element_<semantic_purpose>\`. ${declaredIds
                        ? `The elements declared so far are: ${declaredIds}.`
                        : 'No element has been declared yet: the state you read after the action is where its elements belong.'}`;
                throw new Error(
                    `realization.element ${JSON.stringify(realizationStep.element)} is not the id of any element this run has `
                    + `declared, so the step would name a control nothing can resolve. ${asPurpose} A step's element is an `
                    + 'element ID because the step refers to a declared element rather than restating it — the same form the '
                    + 'transition\'s `target` takes, and the form `capability.schema.json` types `element` as. The one place the '
                    + 'bare purpose belongs is an element-shaped effect\'s `target`. A step that acts on the page rather than on a '
                    + 'control (`goto`, `wait`, `wait_for`) has no element to name: drop `element` rather than inventing one. '
                    + 'Nothing was recorded, and the page has not moved, so fix it and call again.',
                );
            }
            // --- the control this edge acted on -----------------------------
            // A transition's `target` and a step's `element` name the same thing: the control the
            // capability was applied to. The walk states it on the step, because that is where the
            // verb and its object belong — and reading only `args.target` is how every live run
            // recorded an edge that acted on nothing. Measured on the 0.1.26 sign-in walk: three
            // `graph_transition` calls, each with a `realization.element`, and all three committed
            // transitions with `action.target: null`. Two consumers read that field and only that
            // field — the generator, which reported `step_targets_no_element` for every step and
            // wrote a spec that could not perform the sign-in it was generated from, and the
            // application model's `committed_transition_not_carried` — so a field the protocol
            // never asks the walk to write was deciding what both of them could say.
            //
            // Nothing is invented by taking it from the step: the element was checked against the
            // elements this run has declared, in the paragraph above, and it is the id
            // `transition.schema.json#/properties/action/properties/target` types `target` as. What
            // the machinery supplied rather than wrote is said out loud below (`targetNote`),
            // because a value no call passed is not a value the model gave.
            //
            // Both checks and the note belong here, above the first write: a refused disagreement
            // must leave no capability behind, and `addCapability` is the next thing to happen.
            const stepElement = typeof realizationStep?.element === 'string' ? realizationStep.element : null;
            if (stepElement && typeof args.target === 'string' && args.target !== stepElement) {
                throw new Error(
                    `target ${JSON.stringify(args.target)} and realization.element ${JSON.stringify(stepElement)} are two `
                    + 'different controls, and this edge acted on one of them. They are one element id in two places: the '
                    + 'transition\'s `target` is the control the capability was applied to, and a step\'s `element` is the '
                    + 'control its verb acted on. Drop `target`: the step already names the control, and the edge is recorded '
                    + 'with it. Nothing was recorded, so call again.',
                );
            }
            const actionTarget = typeof args.target === 'string' ? args.target : stepElement;
            const targetNote = actionTarget && typeof args.target !== 'string'
                ? {
                    kind: 'target_from_realization',
                    detail: `the edge was recorded acting on ${actionTarget}, taken from realization.element: this walk states `
                        + 'the control on the step, and the transition\'s target is the same element id — so the two cannot be '
                        + 'read as two claims. Pass `target` yourself when the edge acts on a control its step does not name.',
                }
                : null;
            // The step-scoped effects use the transition's vocabularies, because they are the same
            // effects: `transition.schema.json#/$defs/effect` is what the behaviour model types them
            // as. Checked here rather than at the commit because the commit does not project them —
            // they are the behaviour model's and the graph has no room for them — so nothing
            // downstream would notice: a step effect that resolved to nothing would sit in the log
            // for the rest of the run, describing work that no step did.
            for (const effect of realizationStep?.effects ?? []) {
                const type = effect?.type;
                if (!EFFECT_TYPES.has(type)) {
                    throw new Error(
                        `realization.effects entry has type ${JSON.stringify(type)}, which is not one of: ${[...EFFECT_TYPES].join(', ')}. `
                        + 'A step effect is the same effect a transition carries, scoped to this step.',
                    );
                }
                const missing = EFFECT_REQUIRED.get(type).filter((field) => effect[field] === undefined);
                if (missing.length) {
                    throw new Error(
                        `realization.effects entry of type ${JSON.stringify(type)} is missing ${missing.join(', ')}. It is what says `
                        + 'which step of a multi-step behaviour landed the state, so it has to be as complete as a transition\'s.',
                    );
                }
                if (ELEMENT_TARGET_EFFECTS.has(type) && !known.declarations.has(String(effect.target))) {
                    throw new Error(
                        `realization.effects entry of type ${JSON.stringify(type)} targets ${JSON.stringify(effect.target)}, which is `
                        + 'not the semantic_purpose of any element this run has declared. An element-shaped effect names the element '
                        + 'itself, exactly as it does on the transition. Nothing was recorded, so fix the target and call again.',
                    );
                }
                if (effect.severity !== undefined && !SEVERITIES.has(effect.severity)) {
                    throw new Error(
                        `realization.effects entry has severity ${JSON.stringify(effect.severity)}, which is not one of: ${[...SEVERITIES].join(', ')}.`,
                    );
                }
                if (effect.operation !== undefined && !LIST_OPERATIONS.has(effect.operation)) {
                    throw new Error(
                        `realization.effects entry has operation ${JSON.stringify(effect.operation)}, which is not one of: ${[...LIST_OPERATIONS].join(', ')}.`,
                    );
                }
            }
            const capability = store.addCapability({
                name: capabilityName,
                kind: args.capability_kind,
                description: args.description,
                input: args.capability_input,
                output: args.capability_output,
                composed_of: composedNames.map((step) => store.capabilityIdFor(step)),
                notes,
            });
            if (!capability) {
                // The name is still unclaimed, so the call is repeatable as it stands —
                // and it has to be, because a transition is keyed by the capability id
                // and the log has to have the capability it references.
                throw new Error(storeFailureMessage(
                    store.writeProblem() ?? { path: store.capabilitiesPath, message: 'the write failed' },
                    runDirName,
                    'Nothing was recorded. Call again once the workspace is writable: the capability is not in the '
                    + 'vocabulary yet, so the same call will create it.',
                ));
            }

            // --- the behaviour this step is a step of -----------------------
            // A composite is only ever as good as the step it is missing: a run that fills two
            // fields, names `login` as the behaviour of the fill steps, and then submits without
            // saying the submit *is* `login` leaves the behaviour with no submission in it, and
            // a generator expanding `login` performs two keystrokes and asserts an outcome
            // nothing produced. The fix is a step-of relation, and the only moment it can be
            // recorded is the call that performs the step, because that is the only moment the
            // action and its name are both in hand.
            //
            // Appended rather than declared: `composed_of` names the step's own capability id,
            // which exists as of the line above, and `addCapability` files a later non-empty
            // composition as its own record. The behaviour is created as `composite` when the
            // vocabulary does not have it, because a behaviour with steps is a composite by
            // definition — the schema's own word for it.
            //
            // (`behaviourName` is derived further up, with the realisation: the two are refused
            // or accepted together, and the refusal has to happen before the first write.)
            let behaviour = null;
            if (behaviourName) {
                if (!CAPABILITY_NAME_PATTERN.test(behaviourName)) {
                    throw new Error(
                        `capability_behaviour ${JSON.stringify(args.capability_behaviour)} is not usable: it is a capability `
                        + 'name, so it has to be the same lowercase snake_case verb phrase you would pass as `capability`, e.g. '
                        + 'login. Nothing was recorded, so fix the name and call again.',
                    );
                }
                if (behaviourName === capabilityName) {
                    throw new Error(
                        `capability_behaviour names ${capabilityName}, which is the capability being recorded, so the behaviour `
                        + 'would contain itself as its own step. If this step is meant to be the whole of a capability, record it '
                        + 'as that capability and drop the argument; if the behaviour is wider than this step, name the wider '
                        + 'behaviour. Nothing was recorded.',
                    );
                }
                if (composedNames.includes(behaviourName)) {
                    throw new Error(
                        `capability_behaviour names ${behaviourName}, which capability_composed_of also names as a step of `
                        + `${capabilityName} — the two together would make ${behaviourName} contain ${capabilityName} and `
                        + `${capabilityName} contain ${behaviourName}, and a composite that contains itself in a loop cannot be `
                        + 'expanded into a test. Name the behaviour this step belongs to, or drop one of the two. Nothing was recorded.',
                    );
                }
                behaviour = store.addCapability({
                    name: behaviourName,
                    kind: 'composite',
                    // The behaviour's own description is the model's to write; nothing here invents
                    // one. `notes` is empty because the vocabulary notes for the *step's* name do not
                    // apply to the behaviour's.
                    composed_of: [capability.id],
                    notes: [],
                });
                if (!behaviour) {
                    throw new Error(storeFailureMessage(
                        store.writeProblem() ?? { path: store.capabilitiesPath, message: 'the write failed' },
                        runDirName,
                        `Nothing was recorded — but \`${capabilityName}\` was. Call again once the workspace is writable: the `
                        + 'same call records the step and attaches it to the behaviour.',
                    ));
                }
            }
            // The step's walk, named in the user's words when the model gave them. Validated for
            // length only: a journey name is prose, and the machinery has no better spelling of it
            // than the model does. Kept on the step record so the commit can attribute the claim to
            // the walk the step is part of.
            const journeyName = typeof args.journey_name === 'string' ? args.journey_name.trim() : '';
            if (journeyName.length > 160) {
                throw new Error(
                    'journey_name is longer than 160 characters, which is a paragraph rather than a name. Name the walk as a '
                    + 'user would say it — "Sign in and see the project list" — and nothing was recorded, so call again.',
                );
            }
            const featureName = typeof args.feature === 'string' ? args.feature.trim() : '';
            if (featureName.length > 80) {
                throw new Error(
                    'feature is longer than 80 characters, which is a description rather than a name. Name the product feature '
                    + 'as a noun phrase — "authentication", "project management" — and nothing was recorded, so call again.',
                );
            }

            // --- the transition's own references ----------------------------
            if (args.target !== undefined && !/^element[-_][A-Za-z0-9._:-]+$/.test(String(args.target))) {
                throw new Error(
                    `target ${JSON.stringify(args.target)} is not an element id. Use element_<semantic_purpose> — the same `
                    + 'purpose you gave the element when you observed its state.',
                );
            }
            for (const api of args.apis ?? []) {
                if (!/^api[-_][A-Za-z0-9._:-]+$/.test(String(api))) {
                    throw new Error(
                        `api ${JSON.stringify(api)} is not an api id. Use api_<name> (the schema prefix is required), `
                        + 'so the reference can resolve when the graph is assembled.',
                    );
                }
            }

            // --- effects ----------------------------------------------------
            // `known` is the element registry, for the checks that ask whether a name a step uses
            // is one this run has declared: an element-shaped effect that does not resolve is
            // dropped at commit (`element_target_does_not_resolve`), and a realisation step that
            // does not resolve is dropped here. The model writes semantic paths where an element is
            // meant — `login.email` reads like a field of the login capability — and losing the
            // effect means losing the whole content of a form-fill step from the graph.
            const effects = Array.isArray(args.effects) ? args.effects : [];
            for (const effect of effects) {
                const type = effect?.type;
                if (!EFFECT_TYPES.has(type)) {
                    throw new Error(
                        `effect type ${JSON.stringify(type)} is not one of: ${[...EFFECT_TYPES].join(', ')}. `
                        + 'Pick the kind that matches what actually changed.',
                    );
                }
                const missing = EFFECT_REQUIRED.get(type).filter((field) => effect[field] === undefined);
                if (missing.length) {
                    throw new Error(
                        `effect ${JSON.stringify(type)} is missing ${missing.join(', ')}. `
                        + 'The schema requires it, and an effect without it cannot be asserted in a generated test.',
                    );
                }
                if (ELEMENT_TARGET_EFFECTS.has(type) && !known.declarations.has(String(effect.target))) {
                    const declared = listOf([...known.declarations.keys()]);
                    throw new Error(
                        `effect ${JSON.stringify(type)} target ${JSON.stringify(effect.target)} is not the `
                        + `semantic_purpose of any element this run has declared, so the effect would be dropped when the `
                        + `graph is committed and this step would read as having changed nothing. ${declared
                            ? `The elements declared so far are: ${declared}.`
                            : 'No element has been declared yet: the state you read after the action is where its elements belong.'} `
                        + 'An element-shaped effect names the element itself, not a path within it — a `value_changed` on '
                        + 'the email field names that field\'s `semantic_purpose`, exactly as you wrote it when you observed '
                        + 'the state. Nothing was recorded, and the page has not moved, so fix the target and call again.',
                    );
                }
                if (effect.severity !== undefined && !SEVERITIES.has(effect.severity)) {
                    throw new Error(
                        `effect severity ${JSON.stringify(effect.severity)} is not one of: ${[...SEVERITIES].join(', ')}.`,
                    );
                }
                if (effect.operation !== undefined && !LIST_OPERATIONS.has(effect.operation)) {
                    throw new Error(
                        `effect operation ${JSON.stringify(effect.operation)} is not one of: ${[...LIST_OPERATIONS].join(', ')}.`,
                    );
                }
            }
            for (const assertion of args.assertions ?? []) {
                // The short form (a bare assertion name) is legal, so only the object
                // form has a type to check.
                if (assertion && typeof assertion === 'object' && !DETECTION_TYPES.has(assertion.type)) {
                    throw new Error(
                        `assertion type ${JSON.stringify(assertion.type)} is not one of: ${[...DETECTION_TYPES].join(', ')}.`,
                    );
                }
            }

            // --- the machine's own account of the step ----------------------
            const beforeCapture = before.capture ?? null;
            const observedChange = diffCaptures(beforeCapture, after.capture);
            const { errors, warnings } = crossCheckEffects({
                effects,
                before: beforeCapture,
                after: after.capture,
                fromState,
                toState,
                observedChange,
                // How the reading at the end of this step was taken. A capture that
                // waited for the page to stop moving is what tells the no-change warning
                // below the difference between a self-loop and a missed render.
                settle: after.settle ?? null,
            });
            if (!beforeCapture) {
                warnings.push({
                    kind: 'previous_step_not_read',
                    detail: `Step ${before.id} has no capture of its own, so there is nothing to compare this step against.`,
                });
            }
            if (errors.length) {
                throw new Error(`${errors.join(' ')} Nothing was recorded.`);
            }

            const recorded = store.recordTransition({
                from_state: fromState,
                to_state: toState,
                capability_id: capability.id,
                capability_name: capabilityName,
                arguments: args.arguments,
                target: actionTarget,
                guard: args.guard,
                effects,
                apis: args.apis,
                assertions: args.assertions,
                precondition_list: args.preconditions,
                description: args.description,
                journey_name: journeyName,
                feature: featureName,
                // The reading the action produced carries the action's own id, so the step can
                // name it. `after` is that reading: the capture at the end of the step is what
                // the action produced, and `before` is the reading the step started from.
                action_id: after.action_id ?? null,
                before_observation: before.id,
                after_observation: after.id,
                observed_change: observedChange,
                // The step's own disagreements with the evidence, plus whatever the reading at
                // the end of it said about its claims. Both are the machinery's account of the
                // step, so they travel together — and the commit turns the kinds into findings
                // with the same severities either way (`NOTE_SEVERITY`). The third is the one
                // note that is neither: the control the edge was recorded acting on, when the
                // step is what named it. `info`, because nothing was inferred — the same id, from
                // the place the walk states it.
                notes: [...warnings, ...(readingNotes.get(after.id) ?? []), ...(targetNote ? [targetNote] : [])],
            });
            if (!recorded) {
                // Refused rather than half-kept: the capability above is already in the
                // log, but the step is not, so the walk has not moved and the same call
                // records it once the workspace is writable again.
                throw new Error(storeFailureMessage(
                    store.writeProblem() ?? { path: store.transitionsPath, message: 'the write failed' },
                    runDirName,
                    `Nothing was recorded — but the capability \`${capabilityName}\` was, so the walk is still one step `
                    + 'behind this one. Call again once the workspace is writable: the same call will record the step.',
                ));
            }

            // --- the realisation, written against the edge it is made of -----
            // After the transition, because a step names the edge it came from and an edge id is
            // minted by `recordTransition`; a step naming an edge the log does not have would be the
            // same dangling reference the commit refuses everywhere else. A step of a behaviour is a
            // step *of that behaviour*, so it is filed under the behaviour (`capability_behaviour`),
            // not under the capability of this edge — `composed_of` already says the behaviour
            // contains this capability, and repeating it here would say the same thing in ids where
            // the point is to say it in verbs.
            //
            // A failure here is REPORTED rather than thrown, which is the one place in this tool
            // where a store failure is not fatal, and it is deliberate. The browser action happened
            // and its edge is recorded; the realisation is a second statement about an edge that
            // already exists, and throwing would tell the model that the step it just took was lost
            // when it was not. The store's own rule is that a store failure never breaks the action
            // it is recording — and by the time this line runs, the action's record is safe.
            let realization = null;
            if (realizationStep) {
                const step = store.addRealizationStep(behaviour.id, realizationStep, {
                    transitionId: recorded.id,
                    // The position of this edge in the walk. It is what orders a behaviour's steps,
                    // and it is read from the store rather than counted here because a repeated edge
                    // reuses its id and moves to the end of the walk.
                    walkIndex: store.walkLength() - 1,
                });
                realization = step
                    ? {
                        behaviour: { capability_id: behaviour.id, name: behaviourName },
                        step: step.record,
                        repeated: step.repeated,
                        position: step.record.walk_index,
                        note: recorded.restatement
                            ? 'This edge is already a step of this behaviour, and the walk has just stated it again out of the same '
                                + 'two readings: the step keeps its position, and the account of it the walk holds is the one recorded now.'
                            : step.repeated
                                ? 'This edge was already a step of this behaviour, so the step was re-recorded at its new walk position: '
                                    + 'a behaviour\'s steps are performed in the order they were performed, and the newest position is where '
                                    + 'the walk is now.'
                                : 'Recorded as this step of the behaviour — the verb, the element and the value the browser used, beside the '
                                    + 'composition that says which capabilities the behaviour contains.',
                    }
                    : {
                        behaviour: { capability_id: behaviour.id, name: behaviourName },
                        step: null,
                        repeated: false,
                        position: null,
                        note: `The step was recorded, but its realisation was NOT — ${(store.writeProblem() ?? { path: store.capabilitiesPath }).path} `
                            + 'could not be written. The behaviour therefore has no verb for this edge, and a generator expanding it will '
                            + 'replay nothing for this step. The page has already moved, so there is nothing to re-attempt: say so in the '
                            + 'run, or record the walk again once the workspace is writable.',
                    };
            }

            return {
                transition: {
                    transition_id: recorded.id,
                    new: recorded.minted,
                    from_state: fromState,
                    to_state: toState,
                    name: capabilityName,
                    capability_id: capability.id,
                    derived_from: { before: before.id, after: after.id },
                    // The control this edge acted on, and where the id came from. Reported because the
                    // walk states it on the step and the edge is where the document keeps it: a model
                    // that cannot see it carried has no way to tell an edge that acts on the control
                    // from one that acts on nothing.
                    target: actionTarget ?? null,
                    target_note: targetNote ? targetNote.detail : null,
                    // Whether this call was the walk stating a step it had already taken, out of the
                    // same two readings. A restatement is not a step: it takes the place of the one
                    // it restates, which is why it reports no `chain_break` — the walk did not move.
                    // The model has to be able to see that its correction was taken, because the
                    // alternative reading of a silent success is that it recorded the step twice.
                    restatement: recorded.restatement === true,
                    note: recorded.restatement
                        ? 'The walk had already taken this step, out of these same two readings, and has now stated it again: this '
                            + 'replaces the account the walk held of that step — which is still in `transitions.jsonl`, the log being '
                            + 'append-only — and the walk has not moved.'
                        : recorded.minted
                            ? 'Recorded a new edge.'
                            : 'This edge was already recorded — reused its id and appended the step to the walk.',
                    // The reading the action produced, and the reading it started from. Named here
                    // because a step is only attributable to a reading if the caller can see which
                    // reading that is: `action_id` is the reading's own id, written on it when it
                    // was taken.
                    evidence: {
                        action_id: after.action_id ?? null,
                        produced_by: after.id,
                        started_from: before.id,
                    },
                    ...(journeyName ? { journey_name: journeyName } : {}),
                },
                capability: {
                    capability_id: capability.id,
                    name: capabilityName,
                    kind: capability.record.capability_kind,
                    new: capability.created,
                    composed_of: composedNames.map((step) => ({
                        capability_id: store.capabilityIdFor(step),
                        name: step,
                    })),
                    composed_of_added: capability.composition_added ?? [],
                    composed_of_note: composedNames.length
                        ? capability.record.capability_kind === 'composite'
                            ? `${composedNames.length} step(s) recorded as what this behaviour is built from.`
                            : 'The composition was recorded, but the capability is not kind `composite`. If it is built from other '
                                + 'capabilities, say so: call again with `capability_kind: "composite"` — the kind is what tells a '
                                + 'generator the behaviour expands into the steps rather than being one action.'
                        : null,
                    vocabulary_notes: notes,
                    note: notes.length
                        ? 'The vocabulary already has a name close to this one — see vocabulary_notes. Nothing was renamed for you.'
                        : 'No near-duplicate capability name in this run or in the schema vocabulary.',
                },
                ...(behaviour
                    ? {
                        behaviour: {
                            capability_id: behaviour.id,
                            name: behaviourName,
                            kind: behaviour.record.capability_kind,
                            new: behaviour.created,
                            composed_of: behaviour.record.composed_of ?? [],
                            composed_of_added: behaviour.composition_added ?? [],
                            note: behaviour.created
                                ? `\`${behaviourName}\` was created as a composite with \`${capabilityName}\` as its first step. Record the rest of its steps with the same argument, and any step of it that has not been walked is missing from the graph.`
                                : `\`${capabilityName}\` was attached to \`${behaviourName}\`, which already existed.`,
                        },
                    }
                    : {}),
                // The realisation is reported even when it failed, and `realization.step === null`
                // is that failure — a model that only saw `recorded: true` and no realisation would
                // conclude the behaviour is performable when nothing says how.
                ...(realization ? { realization } : {}),
                ...(featureName ? { feature: featureName } : {}),
                chain_break: recorded.chain_break,
                chain_break_note: recorded.chain_break
                    ? `This step starts at ${fromState} but the previous step ended at ${recorded.chain_break.previous_to_state}, so the walk is not contiguous from here. Correct if that was not deliberate.`
                    : null,
                // The model's account and the machinery's account, side by side.
                observed_change: observedChange,
                claimed_effects: effects.length,
                disagreements: warnings,
                graph: {
                    states_recorded: store.stateCount(),
                    capabilities_recorded: store.capabilityCount(),
                    transitions_recorded: store.transitionCount(),
                    steps_walked: store.walkLength(),
                    observations_recorded: store.observationCount(),
                    features_claimed: store.featureNames().length,
                    journeys_named: store.journeyNames().length,
                    unwritten_records: store.writeFailures(),
                    directory_recreations: store.recreations(),
                },
            };
        },
    }));

    // ---------------------------------------------------------------------
    // Seam 3 — the commit, where evidence becomes a graph
    // ---------------------------------------------------------------------
    // Exploration is allowed to be wrong; this is where the run decides what
    // becomes knowledge. Nothing before this point could *retract* anything —
    // every capture, every state reading and every transition candidate is
    // append-only, which is what makes them evidence — so the reconciliation
    // happens here, against the whole run at once, and lands in two files: the
    // graph, and a report of every judgement that produced it.
    //
    // The one thing this tool deliberately does NOT do is repair the logs. It
    // reads them, judges them, and writes the verdict beside them; a rejected
    // candidate stays in `transitions.jsonl` exactly as the walk recorded it, so
    // the same run can be re-judged differently later without re-walking.
    ctx.tools.register(defineTool({
        name: commitTool,
        description: 'Reconcile the run into a behaviour model. This is the LAST step: it reads the raw evidence '
            + '(observations, states, capabilities, transitions), decides which candidates hold, checks the '
            + 'result, and writes application-model.json plus commit_report.json. The 0.1 graph is assembled '
            + 'and validated as the commit\'s own check and is *not* written — it is a way of judging the run, '
            + 'not a document the run produces. It never edits the raw logs, and it refuses to write a model '
            + 'whose rules are violated — read the report instead of assuming success.',
        parameters: {
            run_dir: {
                type: 'string',
                description: 'Directory to commit, relative to the workspace root. Omit to commit the run this '
                    + 'session has been recording. Only needed to re-commit an earlier run.',
            },
            force: {
                type: 'boolean',
                description: 'Return the assembled graph even when blocking rules fired, with the violations listed '
                    + 'in its warnings. Only for inspecting the near-miss; it does not make the graph correct, and '
                    + 'since the graph is not written it changes nothing on disk.',
            },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const cwd = workspaceCwd(exec);
            // Deliberately not `ensureRun`: committing creates nothing. The run this session is
            // recording is the obvious target, and failing that, the directory the session would
            // have written to — which is how a later session commits a run it did not record. A
            // commit that started an empty run in order to reject it would leave a directory
            // behind that looks like an exploration nobody performed.
            const dir = args.run_dir
                ? (isAbsolute(args.run_dir) ? args.run_dir : resolve(cwd, args.run_dir))
                : (run?.dir ?? join(cwd, runDirName));
            if (!existsSync(join(dir, 'run.json'))) {
                throw new Error(
                    `${dir} is not an exploration run: it has no run.json. `
                    + (run
                        ? 'Pass run_dir to commit a run recorded earlier.'
                        : `This session has recorded nothing yet, so there is nothing to reconcile — drive the page with a `
                            + `browser_* tool and read the states with ${observeTool} first, or pass run_dir pointing at a `
                            + `run an earlier exploration wrote (the default is ${runDirName} under the workspace root).`),
                );
            }

            const { graph, model, report, modelPath, reportPath } = commitRun({
                dir,
                command: `${self?.name ?? 'dsh-graph-explorer'} ${self?.version ?? 'unknown'} ${commitTool}`,
                force: args.force === true,
            });

            const severityCount = (severity) => report.findings.filter((finding) => finding.severity === severity).length;
            return {
                committed: report.ok,
                // There is no graph path any more (0.1.38) and the key stays, so a caller written against
                // 0.1.37 gets the same shape and a truthful answer: the graph is assembled, validated and
                // judged as this commit's own check and nothing is written for it. What such a caller
                // actually wants is `graph_valid` — whether the reconciled document validates — because
                // `graph_path` being `null` no longer distinguishes "the commit was blocked" from
                // "the graph is not a document a run produces".
                graph_path: null,
                graph_valid: report.documents?.graph?.valid ?? null,
                // `graph` is present only when `force` was asked for, and that is the whole of what
                // `force` still means: it used to be "write the document anyway", and there is
                // nothing left to write, so what it buys is the document itself. Absent rather than
                // `null` when it was not asked for, because `null` is the answer `graph_valid` and
                // `documents.graph` already give about a document that was withheld, and a caller
                // reading this field must not mistake "you did not ask" for "it was refused".
                ...(args.force === true && graph ? { graph } : {}),
                report_path: reportPath,
                // One document is written, and the model is not a rewrite of the graph and the graph is
                // not a view of the model (D1): the model is the reading of the run that keeps what a step
                // was *walked with*, and the graph is the check. `model_path` is `null` whenever the
                // model was withheld — the profile found an error in it, the schema refused it, the
                // commit was blocked, or the projection declined to assemble one — and that is a fact
                // about the run the caller has to be able to read without opening the report.
                model_path: modelPath ?? null,
                model: report.documents?.model ?? null,
                run_dir: dir,
                application: report.application,
                counts: {
                    states: report.states,
                    capabilities: report.capabilities.committed,
                    // The vocabulary is not the only thing in `capabilities.jsonl` any more, and a
                    // model finishing a run has to be able to tell "the run never said how this
                    // behaviour is performed" from "it said, and the steps are in the graph". Both
                    // numbers, because `recorded` counts the log and `projected` counts what
                    // reached the document, and the interesting case is the two disagreeing.
                    realization: report.capabilities.realization,
                    transitions: report.transitions,
                    observations: report.observations.records,
                    elements: report.elements,
                    // The one part of the graph the machinery found rather than the model read: the
                    // endpoints the run's own request log shows. Reported because a model writing
                    // its hand-off should not have to remember which ids exist.
                    apis: report.apis,
                    // Journeys are reported here rather than left to the report file, because the
                    // goal is the one thing about a journey the model can still supply: a walk
                    // whose instruction could not be attributed needs a hand-written goal, and
                    // that is a finding about this commit, not a detail in a file.
                    journeys: report.journeys,
                    // Features are deliberately *not* in this answer. They belong to the 0.1 graph's
                    // vocabulary, the ABM has no `features[]` (D6, D7), and the graph is no longer
                    // written — so a count here would name a concept the model reading this answer
                    // cannot put anywhere. The report still keeps the accounting.
                },
                // The graph's own index of what it is: a model reporting on the run needs
                // these without reading the file, because they are what it must explain.
                warnings: {
                    errors: severityCount('error'),
                    warnings: severityCount('warning'),
                    notes: severityCount('info'),
                    detail: report.findings,
                },
                invariants: report.invariants.map((result) => ({
                    code: result.code,
                    // Which document the rule is about. The list is one list on purpose — "is this
                    // commit's output sound" is one question — and the tag is what keeps the graph's
                    // thirteen rules and the model's seventeen readable apart in one answer.
                    document: result.document ?? 'graph',
                    ok: result.ok,
                    severity: result.severity,
                    detail: result.detail,
                })),
                // This is the tool's declared output (`{type: 'json'}`), so it has to be lossless
                // for *any* report the commit can produce. The framework rejects the whole call
                // when a value does not survive a JSON round-trip, and its error names no field —
                // a report row that omitted a key failed `graph_commit` outright with nothing to
                // read. `?? null` says these fields are nullable here, where the promise is made,
                // rather than in every reader.
                decisions: report.decisions.map((decision) => ({
                    transition_id: decision.transition_id ?? null,
                    decision: decision.decision,
                    capability: decision.capability ?? null,
                    from_state: decision.from_state ?? null,
                    to_state: decision.to_state ?? null,
                    rejection_reason: decision.rejection_reason ?? null,
                    warnings: (decision.findings ?? decision.warnings ?? []).map((finding) => finding.code),
                })),
                blocked_by: report.blocking,
                // The commit's answer has three shapes, not two, and the third is the one a caller is
                // most likely to misread: `committed: true` with `model_path: null` is a run whose
                // edges all held and whose projection still could not be written (a profile error, or
                // the schema). Saying "the model is at null" there would be worse than saying nothing.
                next: report.ok
                    ? (modelPath
                        ? `The application model is at ${modelPath}. It is built from ${report.transitions.committed} committed edge(s); `
                            + `${report.transitions.rejected} candidate(s) were refused and ${report.transitions.superseded} superseded. `
                            + 'The 0.1 graph was assembled and validated as this commit\'s own check and is not written — nothing refers to a graph.json. '
                            + 'Report the model and the findings — a warning in warnings[] is a fact about the run, not a failure to paper over.'
                        : `No model was written, and no blocking rule fired: the commit held and the projection did not. `
                            + `The model section of the report says which rule withheld it (${(report.documents?.model?.blockers ?? []).map((blocker) => blocker.code).join(', ') || 'see blockers'}). `
                            + 'Report that rather than the run — the walk is sound and the document it should have produced is the thing to fix.')
                    : `No model was written. ${report.blocking.length} blocking rule(s) fired; each one is a fact the run `
                        + 'does not settle, and the model is projected from the document those rules judged, so it is refused '
                        + 'with it. Resolve them and commit again — the raw evidence is unchanged, so a fix here is a '
                        + 'config fix or another walk, never an edit to the logs. The 0.1 graph was assembled and judged '
                        + 'as this commit\'s own check and is not written either.',
            };
        },
    }));

    // ---------------------------------------------------------------------
    // Seam 4 — the generator, where the model becomes a program
    // ---------------------------------------------------------------------
    // Everything before this point is an account: the walk recorded what it saw, and the
    // commit decided what of it holds. This is where the account is spent — a spec a person
    // can run without reading any of the rest.
    //
    // It reads the behaviour model first and the committed graph after it, and the order is
    // the pivot: the model is the document that keeps what a step was *walked with*, and the
    // graph's transition shape is a projection that carries `arguments` and no `value`. A
    // live 0.1.30 run is the measurement behind that ordering — its model recorded the email
    // on the step and its graph could not hold it, so a generator reading the graph wrote a
    // "sign in" test that never typed the email. Both documents are still readable here,
    // which is what makes the two renderings comparable on one run.
    //
    // The guarantee that replaces "the graph is its only input" is stronger and is checked:
    // the model's journey turns are expanded into the calls its `realization[]` recorded, and
    // an action no realization step stands behind is refused rather than written. It writes
    // one file and never edits its input: a test is a claim about the application, and both
    // documents are the record of what the application was found to do.
    //
    // Refusing is a normal outcome. A journey the document does not name, a step whose target
    // has no usable locator, a value the run recorded as `[set]` but never kept, an action
    // with no reading under it — each one stops that line of the spec and comes back as a gap
    // with its own code, because the alternative is a spec that looks complete and passes for
    // the wrong reason.
    ctx.tools.register(defineTool({
        name: generateTool,
        description: 'Generate a Playwright spec for one journey, from the run\'s behaviour model. This is the LAST '
            + 'step, after the commit: it reads application-model.json and writes a runnable .spec.ts beside it, '
            + 'plus a list of the steps it refused to turn into code. Every action traces to a realization[] step — '
            + 'the reading the machinery took — and a step with no reading under it is refused. Read the spec, then '
            + 'the gaps — a gap names what the document would have to say for the generated test to check it.',
        parameters: {
            journey: {
                type: 'string',
                description: 'Which journey to generate a test for, by id, by name, or by distinctive words from either '
                    + '("sign in to the demo app"). Omit when the run has exactly one journey. A near-miss is refused '
                    + 'rather than guessed at, and the candidates come back with it.',
            },
            run_dir: {
                type: 'string',
                description: 'Directory holding the committed application-model.json, relative to the workspace root. '
                    + 'Omit to use the run this session committed.',
            },
            source: {
                type: 'string',
                description: 'Which document to write the spec from: "model" (the default when the run has one) or '
                    + '"graph". The model keeps the values a step was walked with, so a fill can be generated from it; '
                    + 'the graph is the projection that drops them. A commit writes no graph.json any more, so "graph" '
                    + 'is a legacy reading — it needs a document left by a commit before 0.1.38, or a hand-written one.',
            },
            name: {
                type: 'string',
                description: 'Test title, overriding the journey name. Give one when the journey name is a description '
                    + 'rather than a title.',
            },
            base_url: {
                type: 'string',
                description: 'Base URL the spec assumes, overriding the graph\'s application.base_url. The spec navigates '
                    + 'by route, so this is what Playwright\'s use.baseURL has to be set to for it to run.',
            },
            write: {
                type: 'boolean',
                description: 'Write the spec to generated/<journey>.spec.ts beside the document. Default true; set false '
                    + 'to read it without leaving a file behind.',
            },
        },
        output: {
            schema: { type: 'json' },
            // Two blocks rather than one JSON body: the spec is the point, and burying it in escaped
            // newlines inside a JSON string is how a reader ends up trusting the summary instead of
            // the code. The summary is repeated without it, so nothing is lost by not serializing it.
            render: (_args, value) => {
                const { spec, ...summary } = value;
                return [
                    { type: 'text', text: typeof spec === 'string' ? spec : `No spec was generated: ${value.error}` },
                    { type: 'text', text: JSON.stringify(summary, null, 2) },
                ];
            },
        },
        async execute(args, exec) {
            const cwd = workspaceCwd(exec);
            // Same resolution as the commit, on purpose: the graph this generates from is the one
            // that commit wrote, and the obvious target is the run this session has been recording.
            // Nothing is created here — generating from a graph that does not exist is a
            // misremembered path, and a tool that helpfully made an empty directory would turn that
            // into a directory that looks like a committed run.
            const dir = args.run_dir
                ? (isAbsolute(args.run_dir) ? args.run_dir : resolve(cwd, args.run_dir))
                : (run?.dir ?? join(cwd, runDirName));
            // The pivot, and the one line that makes it real: the spec is written from the behaviour
            // *model*, and `graph.json` is no longer its only possible input.
            //
            // It used to read the graph and nothing else, and that was argued for here on two
            // grounds — a spec reproducible from `graph.json` alone, and a generator that cannot
            // quietly disagree with the graph because the graph is its only input. Both were good
            // arguments and both are spent deliberately. A live 0.1.30 run is what spent them: the
            // model recorded the email as the step's `value`, the graph's transition shape carries
            // `arguments` and has no `value`, so the generated spec dropped the sign-in step with a
            // blocking `step_has_no_value_to_type` and produced a "sign in" test that never signs
            // in. A document the model writes and the generator cannot read is the pivot *described*
            // rather than performed.
            //
            // What replaces the old guarantee is a stronger one, and it is checked rather than
            // asserted: the model is handed to the generator through `graphShapeOf`, each journey
            // turn is expanded into the calls the behaviour's `realization[]` recorded, and the
            // generator *refuses* an action no realization step stands behind. So a spec is
            // reproducible from `application-model.json`, and every line of it traces to a reading
            // the machinery took.
            //
            // `graph.json` is still read, and it is read as a legacy document since 0.1.38: the
            // commit no longer writes one, so `source: "graph"` needs a directory a 0.1.37-or-earlier
            // commit wrote, or a document written by hand. It survives as a reading for two reasons
            // — the runs already on disk, and the comparison the two renderings make possible on
            // one run — and not because a run still produces one.
            const modelPath = join(dir, 'application-model.json');
            const graphPath = join(dir, 'graph.json');
            const source = args.source ?? (existsSync(modelPath) ? 'model' : 'graph');
            if (source === 'model' && !existsSync(modelPath)) {
                throw new Error(
                    `${dir} has no application-model.json, so there is no behaviour model to generate a test from. `
                    + (existsSync(graphPath)
                        ? `The graph is there: pass source: "graph" to generate from it, or re-commit the run to write `
                            + 'the model — the model is what keeps the values a step was walked with.'
                        : `Pass run_dir to generate from a run recorded earlier (the default is ${runDirName} under the `
                            + 'workspace root), or walk the application first. A run has a model only when it has been '
                            + 'committed and the model passed every rule the commit has.'),
                );
            }
            if (source === 'graph' && !existsSync(graphPath)) {
                throw new Error(
                    `${dir} has no graph.json, so there is no graph to generate a test from. `
                    + (existsSync(join(dir, 'run.json'))
                        ? `A commit no longer writes one (0.1.38): the graph is assembled as the commit's own check on `
                            + `the run and application-model.json is what it produces, so call ${commitTool} and generate `
                            + 'from the model. Pass source: "graph" only for a directory a 0.1.37-or-earlier commit wrote.'
                        : `Pass run_dir to generate from a run recorded earlier (the default is ${runDirName} under the `
                            + 'workspace root), or walk the application first.'),
                );
            }
            const documentPath = source === 'model' ? modelPath : graphPath;
            const read = JSON.parse(readFileSync(documentPath, 'utf8'));
            const graph = source === 'model' ? graphShapeOf(read) : read;
            const result = generateTest(graph, {
                journey: args.journey,
                name: args.name,
                baseUrl: args.base_url,
            });

            // Two different failures arrive in the same field, so they are separated here rather
            // than in the generator: `spec === null` is "this graph has no such journey", which is a
            // question about the *request* and is answered with the journeys that do exist. A spec
            // that was produced but carries error-severity gaps is a question about the *graph*, and
            // the honest answer to that is the spec, plus a count of what it could not render — the
            // file is written either way, because a spec that says in its own header how much of the
            // walk it drops is a ledger, and hiding it would leave the gaps as the only record.
            if (result.spec === null) {
                // Deliberately not an exception: a journey that could not be identified is answered
                // with the journeys that exist, which is the information needed to call this again.
                // Throwing would return the same text as an error, and the caller would still have
                // to read a list out of it.
                return {
                    ok: false,
                    error: result.error,
                    candidates: result.candidates ?? [],
                    source,
                    document_path: documentPath,
                    graph_path: existsSync(graphPath) ? graphPath : null,
                    run_dir: dir,
                    spec_path: null,
                    next: `Nothing was written. ${result.candidates?.length
                        ? 'Name the journey by id, or by the words of its goal, and call again.'
                        : 'A graph with no journey has nothing to generate: journeys are what the commit derives from the '
                            + 'transitions the walk performed, so a run with no committed transition has none.'}`,
                };
            }

            let specPath = null;
            if (args.write !== false) {
                const outDir = join(dir, 'generated');
                mkdirSync(outDir, { recursive: true });
                specPath = join(outDir, result.filename);
                writeFileSync(specPath, result.spec, 'utf8');
            }

            return {
                ok: result.ok,
                error: null,
                run_dir: dir,
                // Which document the spec was written from, and where it is. The spec is
                // reproducible from that one file — and where both exist, generating from each in
                // turn is how the two readings are compared rather than assumed equal.
                source,
                document_path: documentPath,
                graph_path: existsSync(graphPath) ? graphPath : null,
                spec_path: specPath,
                filename: result.filename,
                test_name: result.test_name,
                // Why this journey was chosen, when the caller named it loosely. A fuzzy match is a
                // guess, and a guess that is not reported is indistinguishable from an exact one.
                matched_by: result.matched_by,
                journey: result.journey,
                application: result.application,
                counts: result.counts,
                // The spec is returned whole, and the file is a copy of this string — so a caller that
                // does not write can still read exactly what would have been written.
                spec: result.spec,
                steps: result.steps,
                assertions: result.assertions,
                requires: result.requires,
                gaps: result.gaps,
                next: (specPath ? `The spec is at ${specPath}. ` : 'Nothing was written (write: false). ')
                    + `${result.counts.actions} of ${result.counts.transitions} step(s) became an action and `
                    + `${result.counts.assertions} check(s) were written; ${result.counts.gaps} gap(s), `
                    + `${result.counts.blocking_gaps} of them blocking. `
                    + (result.ok
                        ? ''
                        : 'This spec is not ok: it drops the step(s) the document could not turn into an action, so it '
                            + 'would pass without performing them. Read the gaps, fix what they name, and generate '
                            + 'again before treating it as a test. ')
                    + (result.requires.length
                        // `requires` holds records, not variable names, and the names have to be read off
                        // them — the sentence itself is the generator's, where a suite can see it.
                        ? requiresInstruction(result.requires)
                        : '')
                    + 'Run it with Playwright (npx playwright test), with use.baseURL set to the application. '
                    + 'A gap is not a failure of the generator: it is a step the graph could not turn into code, and '
                    + 'what it names is what the graph would have to say for the generated test to check it.',
            };
        },
    }));
}

/**
 * The digest is the model's view of the page, so it competes for context with
 * everything else. Trim the bulkiest, least decision-relevant parts first rather
 * than letting one heavy page evict the conversation.
 */
function trimDigest(digest, maxChars) {
    let rendered = JSON.stringify(digest);
    if (rendered.length <= maxChars) return digest;
    if (digest.interactive.length > 25) {
        digest.interactive = digest.interactive.slice(0, 25);
        digest.interactive_truncated = true;
        rendered = JSON.stringify(digest);
    }
    if (rendered.length > maxChars && Object.keys(digest.storage).length) {
        digest.storage = {};
        digest.storage_omitted = true;
        rendered = JSON.stringify(digest);
    }
    if (rendered.length > maxChars && (digest.session_storage_keys.length || digest.cookie_names.length)) {
        digest.session_storage_keys = [];
        digest.cookie_names = [];
        digest.storage_keys_omitted = true;
        rendered = JSON.stringify(digest);
    }
    while (rendered.length > maxChars && digest.interactive.length > 5) {
        digest.interactive = digest.interactive.slice(0, Math.floor(digest.interactive.length / 2));
        digest.interactive_truncated = true;
        rendered = JSON.stringify(digest);
    }
    return digest;
}
