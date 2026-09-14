import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BrowserService, ActionTarget, ProbeState } from '../service.js'
import { sessionKey, throwIfAborted } from './shared.js'

/**
 * `browser_assert` is the difference between "I clicked Save" and "the save
 * worked". It is the only tool that produces evidence.
 *
 * Two deliberate choices:
 *
 *   1. A failed assertion is a *successful observation*, so this tool does not
 *      throw. It returns an explicit verdict, which the model must reckon with
 *      instead of being able to mistake a transport error for a failed test.
 *   2. The model-facing text starts with the literal `ASSERTION PASSED` /
 *      `ASSERTION FAILED`, while the canonical value stays structured so hosts
 *      and UIs can read the verdict without parsing prose.
 */

/** One evaluated condition, as reported back to the model. */
interface ConditionOutcome {
  ok: boolean
  message: string
}

export function createAssertTool(ctx: Context): ToolDefinition {
  const browser: BrowserService = ctx.browser

  return defineTool({
    name: 'browser_assert',
    description:
      'Prove that an expected outcome actually happened, before you report any result. ' +
      'Combine any of these conditions in one call; the assertion passes only if ALL of them hold:\n' +
      '- `url_contains`: the current URL contains this text\n' +
      '- `title_contains`: the page title contains this text\n' +
      '- `text`: this text is visible somewhere on the page\n' +
      '- `ref` + `state`: the referenced element is attached/detached/visible/hidden\n' +
      '- `ref` + `text`: the referenced element\'s own text contains this text\n' +
      '- `ref` + `value`: the referenced input\'s current value equals this text\n' +
      '- `ref` + `checked`: the referenced checkbox is checked or not\n' +
      'An element target is required for `state`, `value` and `checked`, and optional for `text`.\n' +
      'Name that element with `ref` when the snapshot numbered it, or with `selector` (CSS) when\n' +
      'it did not: the snapshot only numbers interactive elements, so a heading or a paragraph\n' +
      'needs `selector` (e.g. `h1`, `h1:has-text("Projects")`). A CSS selector matches in document\\n' +
      'order, so on a page that keeps a hidden copy of an earlier view a bare `h1` can match the\\n' +
      'hidden one — scope it with `:has-text()` or check `state` first. Passing a target to `text` scopes\\n' +
      'the search to that element; omitting it searches the whole page. Give `ref` or `selector`,\n' +
      'never both.\n' +
      'Returns ASSERTION PASSED, or ASSERTION FAILED listing exactly which condition failed ' +
      'and what was actually observed. Never report PASS on the strength of an action succeeding — ' +
      'run this first. A false PASS is far worse than a false FAIL.',
    parameters: {
      url_contains: { type: 'string', description: 'Expected substring of the current URL.' },
      title_contains: { type: 'string', description: 'Expected substring of the page title.' },
      text: {
        type: 'string',
        description:
          'Text that must be visible. Page-wide unless `ref` or `selector` scopes it to one element.',
      },
      ref: {
        type: 'string',
        description:
          'Element ref from the latest snapshot. Only interactive elements get refs; use `selector` for headings and static text.',
      },
      selector: {
        type: 'string',
        description:
          'CSS selector for an element the snapshot did not number (e.g. `h1`). Alternative to `ref`; never pass both.',
      },
      state: {
        type: 'string',
        enum: ['attached', 'detached', 'visible', 'hidden'],
        description:
          'Required state of the targeted element. Use `hidden` or `detached` to check something disappeared.',
      },
      value: { type: 'string', description: 'Exact value the targeted input must currently hold.' },
      checked: { type: 'boolean', description: 'Required checked state of the targeted checkbox.' },
      timeoutMs: {
        type: 'number',
        description: 'How long to keep re-checking before failing. Defaults to 5000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: {
            type: 'string',
            enum: ['ASSERTION PASSED', 'ASSERTION FAILED'],
            required: true,
            description: 'The overall verdict.',
          },
          passed: { type: 'boolean', required: true, description: 'True when every condition held.' },
          conditions: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'One `PASS - ...` / `FAIL - ...` line per evaluated condition.',
          },
          failedCount: { type: 'integer', required: true, description: 'Number of failed conditions.' },
          url: { type: 'string', required: true, description: 'URL at the moment of assertion.' },
          title: { type: 'string', required: true, description: 'Page title at the moment of assertion.' },
          snapshot: { type: 'string', required: true, description: 'A fresh page snapshot taken after the assertion.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.verdict}\n${value.conditions.join('\n')}\n\n${value.snapshot}`,
        },
      ],
      presentationMeta: (_args, value) => ({
        verdict: value.verdict,
        passed: value.passed,
        failedCount: value.failedCount,
      }),
    },
    async execute(args, exec) {
      throwIfAborted(exec)
      const key = sessionKey(exec)
      const timeoutMs = clamp(args.timeoutMs ?? 5_000, 100, 60_000)

      const conditions = await evaluate(browser, key, args, timeoutMs, exec)

      if (conditions.length === 0) {
        throw new Error(
          'browser_assert needs at least one condition: url_contains, title_contains, text, ' +
            'state, value, or checked.',
        )
      }

      const failedCount = conditions.filter((c) => !c.ok).length
      const passed = failedCount === 0
      const verdict: 'ASSERTION PASSED' | 'ASSERTION FAILED' = passed
        ? 'ASSERTION PASSED'
        : 'ASSERTION FAILED'

      const capture = await browser.snapshot(key)

      return {
        verdict,
        passed,
        conditions: conditions.map((c) => `${c.ok ? 'PASS' : 'FAIL'} - ${c.message}`),
        failedCount,
        url: capture.url,
        title: capture.title,
        snapshot: capture.text,
      }
    },
  })
}

/** Build and evaluate every condition the model supplied. */
async function evaluate(
  browser: BrowserService,
  key: string,
  args: {
    url_contains?: string
    title_contains?: string
    text?: string
    ref?: string
    selector?: string
    state?: ProbeState
    value?: string
    checked?: boolean
  },
  timeoutMs: number,
  exec: ToolRunContext,
): Promise<ConditionOutcome[]> {
  const results: ConditionOutcome[] = []
  const signal = exec.signal
  // Resolve the element target up front so a caller mistake (both `ref` and
  // `selector`) fails before any probe runs.
  const target = resolveTarget(args)

  if (args.url_contains !== undefined) {
    const expected = args.url_contains
    const result = await browser.probe(key, { urlContains: expected, timeoutMs, signal })
    const ok = result.stateSatisfied === true
    results.push({
      ok,
      message: ok
        ? `URL contains ${JSON.stringify(expected)} (actual: ${result.url})`
        : `URL does NOT contain ${JSON.stringify(expected)} (actual: ${result.url})`,
    })
  }

  if (args.title_contains !== undefined) {
    const expected = args.title_contains
    const result = await browser.probe(key, { titleContains: expected, timeoutMs, signal })
    const ok = result.stateSatisfied === true
    results.push({
      ok,
      message: ok
        ? `Title contains ${JSON.stringify(expected)} (actual: ${JSON.stringify(result.title)})`
        : `Title does NOT contain ${JSON.stringify(expected)} (actual: ${JSON.stringify(result.title)})`,
    })
  }

  if (target && args.state) {
    const result = await browser.probe(key, { ...target, state: args.state, timeoutMs, signal })
    const ok = result.stateSatisfied === true
    const label = describeTarget(target, result.role, result.name)
    results.push({
      ok,
      message: ok
        ? `Element ${label} is ${args.state}`
        : `Element ${label} is NOT ${args.state}` +
          ` (found=${result.found}, visible=${result.visible})`,
    })
  }

  if (target && args.text !== undefined) {
    const expected = args.text
    const result = await browser.probe(key, { ...target, contains: expected, timeoutMs, signal })
    const ok = result.stateSatisfied === true
    const label = describeTarget(target, result.role, result.name)
    results.push({
      ok,
      message: ok
        ? `Element ${label} text contains ${JSON.stringify(expected)} (actual: ${JSON.stringify(truncate(result.text))})`
        : `Element ${label} text does NOT contain ${JSON.stringify(expected)}` +
          ` (actual: ${JSON.stringify(truncate(result.text))})`,
    })
  }

  if (target && args.value !== undefined) {
    const result = await browser.probe(key, { ...target, timeoutMs, signal })
    const actual = result.value
    const ok = actual === args.value
    const label = describeTarget(target, result.role, result.name)
    results.push({
      ok,
      message: ok
        ? `Element ${label} value is ${JSON.stringify(args.value)}`
        : `Element ${label} value is ${JSON.stringify(actual)}, expected ${JSON.stringify(args.value)}`,
    })
  }

  if (target && args.checked !== undefined) {
    const result = await browser.probe(key, { ...target, timeoutMs, signal })
    const actual = result.checked
    const ok = actual === args.checked
    const label = describeTarget(target, result.role, result.name)
    results.push({
      ok,
      message: ok
        ? `Element ${label} is ${args.checked ? 'checked' : 'unchecked'}`
        : `Element ${label} is ${actual === null ? 'not a checkbox' : actual ? 'checked' : 'unchecked'}, ` +
          `expected ${args.checked ? 'checked' : 'unchecked'}`,
    })
  }

  // Page-wide text check. A target scopes `text` and is handled above; a bare
  // `text` means "somewhere on the page".
  if (args.text !== undefined && !target) {
    const expected = args.text
    const result = await browser.probe(key, { text: expected, state: 'visible', timeoutMs, signal })
    const ok = result.stateSatisfied === true
    results.push({
      ok,
      message: ok
        ? `Page shows text ${JSON.stringify(expected)}`
        : `Page does NOT show text ${JSON.stringify(expected)} (found=${result.found}, visible=${result.visible})`,
    })
  }

  return results
}

/**
 * Reduce `ref` / `selector` to the single target the probe layer takes.
 * They are alternatives, not a conjunction — accepting both would silently
 * ignore one of them.
 */
function resolveTarget(args: { ref?: string; selector?: string }): ActionTarget | null {
  if (args.ref && args.selector) {
    throw new Error(
      'browser_assert takes either `ref` or `selector`, not both — they are two ways to name the same element.',
    )
  }
  if (args.ref) return { ref: args.ref }
  if (args.selector) return { selector: args.selector }
  return null
}

/** Prefer the accessible name for a ref; fall back to the selector itself. */
function describeTarget(target: ActionTarget, role: string | null, name: string | null): string {
  if (target.selector) return `\`${target.selector}\``
  return describeRef(target.ref!, role, name)
}

function describeRef(ref: string, role: string | null, name: string | null): string {
  const label = name ? ` (${role ?? 'element'} ${JSON.stringify(name)})` : ''
  return `${ref}${label}`
}

function truncate(value: string): string {
  return value.length > 160 ? `${value.slice(0, 160)}…` : value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
