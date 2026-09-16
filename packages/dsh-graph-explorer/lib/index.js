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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_EXPRESSION } from './capture.js';
import { SECTION_NAME, SECTION_ORDER, protocolText } from './protocol.js';
import {
    APPLICATION_ID_PATTERN,
    CAPABILITY_KINDS,
    CAPABILITY_NAME_PATTERN,
    DETECTION_TYPES,
    EFFECT_REQUIRED,
    EFFECT_TYPES,
    LIST_OPERATIONS,
    SEVERITIES,
    normalizeApplication,
    vocabularyNotes,
} from './schema.js';
import { createRun, normalizeRunDirName, RUN_DIR_NAME, RUN_DIR_PATTERN } from './session.js';

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
 * The roles that make an element something you can act on.
 *
 * A diff lists appearances by `role:name`, and a list that grew adds plain text nodes rather
 * than controls. Keeping only controls is what separates "the same screen with one more
 * item in it" — a legitimate effect on a stable state — from "a different screen", which is
 * a state identity that does not hold.
 */
const CONTROL_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'switch',
    'menuitem', 'tab', 'searchbox',
]);

const controls = (entries) => (entries ?? [])
    .filter((entry) => CONTROL_ROLES.has(String(entry).split(':')[0]));

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
export function crossCheckEffects({ effects, before, after, fromState, toState, observedChange }) {
    const errors = [];
    const warnings = [];
    const seenMessages = new Set([...statusTexts(before), ...statusTexts(after)]);
    const urlChanged = Boolean(before && after && before.url !== after.url);

    for (const effect of effects ?? []) {
        if (!effect || typeof effect !== 'object') continue;

        if (effect.type === 'state_entered' && effect.to && effect.to !== toState) {
            errors.push(
                `effect state_entered says the app entered ${JSON.stringify(effect.to)} while to_state is `
                + `${JSON.stringify(toState)}. A transition cannot end in two places — fix whichever of the two is wrong.`,
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
            detail: 'Nothing in the captured surface changed between the two steps — no URL, title, element, value, checked state, message, storage or request difference. Either this really is a self-loop, or the capture raced the page\'s own update (a late render, an animation, a debounced request).',
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
     * Read the page. Never throws: a broken observation must degrade into a
     * recorded failure, never into a broken browser action. The failure IS
     * recorded, because a silently missing observation is exactly the false-pass
     * this tooling exists to remove.
     */
    const capture = async (exec, { tool, toolArgs, screenshotPath }) => {
        const store = ensureRun(exec);
        let captureValue = null;
        let captureError = null;
        try {
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

        const observation = store.addObservation({
            tool,
            toolArgs,
            phase: 'after',
            capture: captureValue,
            error: captureError,
            screenshot,
        });
        if (captureValue) {
            previousObservation = latestObservation;
            previousCapture = latestObservation?.capture ?? null;
            latestObservation = observation;
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
            await capture(exec, { tool: exec.name, toolArgs: exec.arguments, screenshotPath });
            throw error;
        }

        await capture(exec, { tool: exec.name, toolArgs: exec.arguments, screenshotPath });
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
                description: 'Discriminating facts that separate states sharing a route, e.g. {"projects":"empty"}',
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
                description: 'How a test proves it is in this state: {type: url|element_state|element_value|message|absence|..., ...}',
            },
            confidence: { type: 'number', description: '0..1 confidence in this reading' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
            const store = ensureRun(exec);
            const latest = latestObservation;
            if (!latest) {
                throw new Error(
                    'No evidence has been captured yet, so there is nothing to interpret. '
                    + 'Drive the page with a browser_* tool first (browser_open is usually the one you want).',
                );
            }

            let state = null;
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
                });
                state = {
                    state_id: recorded.id,
                    new: recorded.minted,
                    note: recorded.minted
                        ? 'Minted a new state for this identity.'
                        : 'This identity was already recorded — reused the existing state id instead of minting a duplicate.',
                };
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
                changed_since_previous_observation: diffCaptures(previousCapture, latest.capture),
                status: latest.capture?.status ?? [],
                interactive: latest.capture?.interactive ?? [],
                storage: latest.capture?.storage ?? {},
                console: latest.capture?.console ?? [],
                page_errors: latest.capture?.page_errors ?? [],
                graph: {
                    state,
                    states_recorded: store.stateCount(),
                    observations_recorded: store.observationCount(),
                    capabilities_recorded: store.capabilityCount(),
                    transitions_recorded: store.transitionCount(),
                    steps_walked: store.walkLength(),
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
                    + 'This is the capability\'s parameters, NOT the concrete values used this time.',
            },
            capability_output: {
                type: 'object',
                additionalProperties: true,
                description: 'What the capability yields, e.g. {"discount":"number"}. Recorded on first use.',
            },
            arguments: {
                type: 'object',
                additionalProperties: true,
                description: 'The concrete values used for THIS transition, e.g. {"coupon_code":"SAVE10"}.',
            },
            target: {
                type: 'string',
                description: 'The element acted on, as element_<semantic_purpose>, when the capability is not bound to one element.',
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
                return {
                    recorded: false,
                    note: ignored.length
                        ? `No capability was given, so nothing was recorded — these arguments were read and ignored: `
                            + `${ignored.join(', ')}. Pass \`capability\` to record a transition.`
                        : 'No arguments were given, so nothing was recorded. This is the state of the walk.',
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
                };
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
                throw new Error(
                    'There is no step before this one, so there is no transition: the first browser action establishes '
                    + 'the entry state rather than moving between states. Record it with '
                    + `\`${observeTool}\` and act again.`,
                );
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
            const capability = store.addCapability({
                name: capabilityName,
                kind: args.capability_kind,
                description: args.description,
                input: args.capability_input,
                output: args.capability_output,
                notes,
            });

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
                target: args.target,
                guard: args.guard,
                effects,
                apis: args.apis,
                assertions: args.assertions,
                precondition_list: args.preconditions,
                description: args.description,
                before_observation: before.id,
                after_observation: after.id,
                observed_change: observedChange,
                notes: warnings,
            });

            return {
                transition: {
                    transition_id: recorded.id,
                    new: recorded.minted,
                    from_state: fromState,
                    to_state: toState,
                    name: capabilityName,
                    capability_id: capability.id,
                    derived_from: { before: before.id, after: after.id },
                    note: recorded.minted
                        ? 'Recorded a new edge.'
                        : 'This edge was already recorded — reused its id and appended the step to the walk.',
                },
                capability: {
                    capability_id: capability.id,
                    name: capabilityName,
                    kind: capability.record.capability_kind,
                    new: capability.created,
                    vocabulary_notes: notes,
                    note: notes.length
                        ? 'The vocabulary already has a name close to this one — see vocabulary_notes. Nothing was renamed for you.'
                        : 'No near-duplicate capability name in this run or in the schema vocabulary.',
                },
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
                },
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
    while (rendered.length > maxChars && digest.interactive.length > 5) {
        digest.interactive = digest.interactive.slice(0, Math.floor(digest.interactive.length / 2));
        digest.interactive_truncated = true;
        rendered = JSON.stringify(digest);
    }
    return digest;
}
