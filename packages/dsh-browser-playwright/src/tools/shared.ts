import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BrowserService, SnapshotCapture } from '../service.js'

/** Prefix every tool this plugin owns, so its surface is obvious to the model. */
export const TOOL_PREFIX = 'browser_'

/**
 * Which DSH session a tool call belongs to.
 *
 * Tools are global (registered once), but a browser session must not be: two
 * conversations running in parallel must never share cookies, storage, or
 * element refs. `exec.agent` is the DSH session identity, so it is the key.
 */
export function sessionKey(exec: ToolRunContext): string {
  return exec.agent?.id ?? 'default'
}

/** Fail fast (with an honest message) when the caller cancelled the call. */
export function throwIfAborted(exec: ToolRunContext): void {
  if (exec.signal.aborted) {
    throw new Error('Browser call cancelled by the caller before it completed.')
  }
}

/**
 * A short, order-independent suffix describing how much of the page the model
 * can currently see. Repeated in every observation so the model can notice that
 * it is acting on a stale generation.
 */
export function snapshotHeader(capture: SnapshotCapture): string {
  return `snapshot generation ${capture.generation}, ${capture.elementCount} interactive element(s) on ${capture.url}`
}

/** One observation, exactly as the model should read it. */
export function formatObservation(summary: string, capture: SnapshotCapture): string {
  return `${summary}\n\n${capture.text}`
}

export interface ToolContextBag {
  ctx: Context
  browser: BrowserService
}

/** Build the injected context bag every browser tool factory needs. */
export function toolContext(ctx: Context): ToolContextBag {
  return { ctx, browser: ctx.browser }
}

/** Reusable `{ type: 'string' }` canonical output that renders verbatim. */
export function textOutput(description: string) {
  return {
    schema: { type: 'string', description } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

export type BrowserToolDefinition = ToolDefinition

export { defineTool }

