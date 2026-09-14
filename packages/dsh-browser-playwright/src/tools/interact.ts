import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ActionRequest, BrowserService } from '../service.js'
import { formatObservation, sessionKey, textOutput, throwIfAborted } from './shared.js'
import type { ToolContextBag } from './shared.js'

/**
 * Interaction tools.
 *
 * Two rules hold for all of them:
 *
 *   1. A ref from the latest snapshot is the normal way to name a target; a CSS
 *      `selector` is an escape hatch for elements the snapshot did not expose.
 *   2. Every call ends with a fresh snapshot, because a ref is only valid for
 *      the generation it came from.
 *
 * Refs are validated by the browser session rather than the tool, so an unknown
 * ref produces the recovery hint the model needs.
 */
export function createInteractionTools({ browser }: ToolContextBag): ToolDefinition[] {
  /** Args shared by every element-targeted action. */
  const targetParameters = {
    ref: {
      type: 'string' as const,
      description: 'Element ref from the latest snapshot, e.g. `e4`. Preferred over `selector`.',
    },
    selector: {
      type: 'string' as const,
      description: 'CSS selector escape hatch, for elements the snapshot did not expose.',
    },
    timeoutMs: {
      type: 'number' as const,
      description: 'Action timeout in milliseconds. Defaults to 15000.',
    },
  }

  const forceParameter = {
    force: {
      type: 'boolean' as const,
      description:
        'Act even if the element is covered or fails Playwright\'s actionability checks. ' +
        'Only use this after verifying you really have the right element.',
    },
  }

  /** Turn tool args into a service request, dropping anything not supplied. */
  const toRequest = (
    kind: ActionRequest['kind'],
    args: {
      ref?: string
      selector?: string
      timeoutMs?: number
      value?: string
      label?: string
      key?: string
      force?: boolean
    },
    signal: AbortSignal,
  ): ActionRequest => ({
    kind,
    ...(args.ref ? { ref: args.ref } : {}),
    ...(args.selector ? { selector: args.selector } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.value !== undefined ? { value: args.value } : {}),
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.key !== undefined ? { key: args.key } : {}),
    ...(args.force !== undefined ? { force: args.force } : {}),
    signal,
  })

  const click = defineTool({
    name: 'browser_click',
    description:
      'Click an element (this also works for checkboxes and radio buttons). ' +
      'Returns a fresh snapshot of the resulting page. Clicking may navigate; when it does, ' +
      'the new page is allowed to finish loading before the snapshot is taken. ' +
      'A click that succeeded proves nothing about the outcome — follow it with browser_assert.',
    parameters: { ...targetParameters, ...forceParameter },
    output: textOutput('A confirmation followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const result = await browser.act(key, toRequest('click', args, exec.signal))
      return report(browser, key, `Clicked ${result.target}.`, result.navigated, result.urlAfter)
    },
  })

  const fill = defineTool({
    name: 'browser_fill',
    description:
      'Replace the contents of an input, textarea, or contenteditable element. ' +
      'Sets the value directly (not key by key) and fires the input/change events a framework ' +
      'listens for. Use browser_press with `Enter` to submit, or click the submit button. ' +
      'Returns a fresh snapshot.',
    parameters: {
      ...targetParameters,
      ...forceParameter,
      value: {
        type: 'string',
        required: true,
        description: 'The text to put in the field. Pass an empty string to clear it.',
      },
    },
    output: textOutput('A confirmation followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const result = await browser.act(key, toRequest('fill', args, exec.signal))
      return report(
        browser,
        key,
        `Filled ${result.target} with ${JSON.stringify(args.value)}.`,
        result.navigated,
        result.urlAfter,
      )
    },
  })

  const press = defineTool({
    name: 'browser_press',
    description:
      'Press a key. With a `ref` or `selector` the key goes to that element (e.g. `Enter` in a ' +
      'search box); with neither, it goes to the page (e.g. `Escape` to dismiss a dialog). ' +
      'Returns a fresh snapshot.',
    parameters: {
      ...targetParameters,
      key: {
        type: 'string',
        required: true,
        description: 'Key or chord to press, e.g. `Enter`, `Tab`, `Escape`, `Control+A`.',
      },
    },
    output: textOutput('A confirmation followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const result = await browser.act(key, toRequest('press', args, exec.signal))
      return report(
        browser,
        key,
        `Pressed ${JSON.stringify(args.key)} on ${result.target}.`,
        result.navigated,
        result.urlAfter,
      )
    },
  })

  const select = defineTool({
    name: 'browser_select',
    description:
      'Choose an option in a <select> dropdown, by the option\'s `value` or its visible `label`. ' +
      'Provide exactly one of the two. Returns a fresh snapshot.',
    parameters: {
      ...targetParameters,
      ...forceParameter,
      value: { type: 'string', description: 'The option\'s value attribute.' },
      label: { type: 'string', description: 'The option\'s visible text.' },
    },
    output: textOutput('A confirmation followed by a fresh page snapshot.'),
    async execute(args, exec) {
      throwIfAborted(exec)
      if (args.value === undefined && args.label === undefined) {
        throw new Error('browser_select needs either "value" or "label".')
      }
      const key = sessionKey(exec)
      const result = await browser.act(key, toRequest('select', args, exec.signal))
      const chosen =
        args.value !== undefined
          ? `value ${JSON.stringify(args.value)}`
          : `label ${JSON.stringify(args.label)}`
      return report(browser, key, `Selected ${chosen} in ${result.target}.`, result.navigated, result.urlAfter)
    },
  })

  return [click, fill, press, select]
}

/** Confirm the action, note navigation, then attach the authoritative snapshot. */
async function report(
  browser: BrowserService,
  key: string,
  summary: string,
  navigated: boolean,
  urlAfter: string,
): Promise<string> {
  const capture = await browser.snapshot(key)
  const suffix = navigated ? ` The page navigated to ${urlAfter}.` : ''
  return formatObservation(`${summary}${suffix}`, capture)
}
