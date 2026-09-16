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
    // The pattern declares the contract so a config error is caught while the
    // profile is still booting, alongside every other bad setting. The runtime
    // check in `apply` is not a duplicate of it: this declares *what is valid*,
    // that one refuses *what would be written*, and the value reaches the
    // filesystem from a place that can be called without the schema in front.
    runDirName: Schema.string()
        .default(RUN_DIR_NAME)
        .pattern(RUN_DIR_PATTERN)
        .description('Where the run writes its evidence, relative to the workspace. Must not escape it.'),
    maxSteps: Schema.number(),
    screenshot: Schema.boolean().default(true),
    maxDigestChars: Schema.number().default(14000),
});

/**
 * Browser tools whose RESULT can change what is on screen, so evidence must be
 * captured around them. The inspection tools (`get_text`, `get_html`, `eval`) are
 * excluded on purpose: they cannot change the page, and capturing around them
 * would multiply the cost of every look by three.
 */
const OBSERVED_TOOLS = new Set([
    'browser_open',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_select',
    'browser_wait',
]);

/** Assertion kinds the graph schema permits in `detection`. */
const DETECTION_TYPES = new Set([
    'state',
    'url',
    'element_state',
    'element_value',
    'value',
    'api',
    'effect',
    'message',
    'absence',
    'custom',
]);

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

/** Bounded text-diff of two captures: what the action actually changed. */
function diffCaptures(before, after) {
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
    const newMessages = [...afterStatus].filter((item) => !beforeStatus.has(item)).slice(0, 10);
    if (newMessages.length) diff.status = newMessages;
    const newErrors = (after.page_errors ?? []).slice(0, 10);
    if (newErrors.length) diff.page_errors = newErrors;
    const requests = (after.network ?? []).slice(0, 20);
    if (requests.length) diff.requests = requests;
    return Object.keys(diff).length ? diff : null;
}

export function apply(ctx, config) {
    const observeTool = config.observeTool ?? 'graph_observe';
    // Resolved once, so the directory the model is told to read and the
    // directory the run store writes to are the same string by construction.
    // They used to be two independent derivations of the config, which is how a
    // custom runDirName could point the model at a directory that never existed.
    const runDirName = normalizeRunDirName(config.runDirName ?? RUN_DIR_NAME);

    /** Lazily created on the first captured action, so a run needs no explicit start. */
    let run = null;
    /**
     * Re-entrancy guard. Our own captures dispatch `browser_eval` through
     * `ctx.tools.execute`, which re-enters this very waterfall. The capture tools
     * are not in OBSERVED_TOOLS, so recursion cannot actually happen today — but
     * the failure mode is an unbounded loop that hangs the agent, so it is guarded
     * structurally rather than by convention.
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
                },
            };
            return trimDigest(digest, config.maxDigestChars ?? 14000);
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
