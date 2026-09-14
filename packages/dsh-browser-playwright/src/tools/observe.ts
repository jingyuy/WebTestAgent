import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ProbeState } from '../service.js'
import { formatObservation, sessionKey, textOutput, throwIfAborted } from './shared.js'
import type { ToolContextBag } from './shared.js'

/**
 * Observation tools: they tell the model what the page looks like and can move
 * the browser without touching the DOM.
 *
 * Every one of them ends with a FRESH snapshot, because a snapshot invalidates
 * the refs handed out by the previous one. Returning a stale ref list would be
 * worse than returning nothing at all.
 */
export function createObservationTools({ browser }: ToolContextBag): ToolDefinition[] {
  const open = defineTool({
    name: 'browser_open',
    description:
      'Open a URL in the browser and return a snapshot of the resulting page. ' +
      'Call this first. A bare host such as `example.com` is given an https:// scheme; ' +
      '`localhost:3000` is given http://.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Absolute URL, or a bare host such as `example.com` / `localhost:3000`.',
      },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'Navigation readiness to wait for. Defaults to `domcontentloaded`.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Navigation timeout in milliseconds. Defaults to 45000.',
      },
    },
    output: textOutput('The navigation result followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const { url, status } = await browser.open(key, {
        url: args.url,
        ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        signal: exec.signal,
      })

      const capture = await browser.snapshot(key)
      const summary = `Opened ${url} (HTTP ${status ?? 'unknown'}).`
      return formatObservation(summary, capture)
    },
  })

  const snapshot = defineTool({
    name: 'browser_snapshot',
    description:
      'Re-read the current page and return a fresh snapshot with new element refs. ' +
      'Use this when the page changed on its own (a redirect, a timer, a websocket update) ' +
      'or when an action reported that a ref was stale. Everything you learned from the ' +
      'previous snapshot about refs is void afterwards.',
    parameters: {},
    output: textOutput('A fresh page snapshot.'),
    async execute(_args, exec) {
      throwIfAborted(exec)
      const capture = await browser.snapshot(sessionKey(exec))
      return formatObservation(`Re-read the page (${capture.url}).`, capture)
    },
  })

  const wait = defineTool({
    name: 'browser_wait',
    description:
      'Wait until something becomes true, then return a fresh snapshot. Prefer this over ' +
      'guessing at delays: it fails loudly instead of silently, and it reports how long it took. ' +
      'Provide a `ref`, a `selector`, or `text`. ' +
      'Examples: wait for a loading spinner to disappear (`ref` + `state: "hidden"`), ' +
      'wait for a confirmation banner to appear (`text` + `state: "visible"`).',
    parameters: {
      ref: { type: 'string', description: 'Element ref from the latest snapshot.' },
      selector: {
        type: 'string',
        description: 'CSS selector escape hatch, for elements the snapshot did not expose.',
      },
      text: { type: 'string', description: 'Text to wait for, matched anywhere on the page.' },
      state: {
        type: 'string',
        enum: ['attached', 'detached', 'visible', 'hidden'],
        description: 'The state to wait for. Defaults to `visible` for text, `attached` for elements.',
      },
      timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds. Defaults to 15000.' },
    },
    output: textOutput('Whether the condition was reached, followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const timeoutMs = clamp(args.timeoutMs ?? 15_000, 100, 120_000)
      const target = describeTarget(args.ref, args.selector, args.text)
      const defaultState: ProbeState = args.text !== undefined && !args.ref && !args.selector ? 'visible' : 'attached'
      const state: ProbeState = args.state ?? defaultState

      const result = await browser.probe(key, {
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.selector ? { selector: args.selector } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        state,
        timeoutMs,
        signal: exec.signal,
      })

      const satisfied = result.stateSatisfied === true
      const summary = satisfied
        ? `Waited for ${target} to be ${state} — reached.`
        : `Waited ${timeoutMs}ms for ${target} to be ${state} — NOT reached` +
          ` (found=${result.found}, visible=${result.visible}).`

      const capture = await browser.snapshot(key)
      return formatObservation(summary, capture)
    },
  })

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description:
      'Save a PNG of the current viewport (or the whole page) to disk for later human ' +
      'inspection. The image is NOT returned to you — use browser_snapshot to see the page. ' +
      'This does not change the page, so element refs stay valid.',
    parameters: {
      label: { type: 'string', description: 'Short label folded into the filename, e.g. `after-login`.' },
      fullPage: {
        type: 'boolean',
        description: 'Capture the entire scrollable page instead of just the viewport. Defaults to false.',
      },
    },
    output: textOutput('The saved screenshot path.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const { path, fullPage } = await browser.screenshot(key, {
        label: args.label ?? 'shot',
        fullPage: args.fullPage === true,
        signal: exec.signal,
      })
      return `Saved ${fullPage ? 'full-page' : 'viewport'} screenshot to ${path}.`
    },
  })

  return [open, snapshot, wait, screenshot]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function describeTarget(ref?: string, selector?: string, text?: string): string {
  if (ref) return `ref ${ref}`
  if (selector) return `selector ${JSON.stringify(selector)}`
  if (text !== undefined) return `text ${JSON.stringify(text)}`
  return 'the page'
}
