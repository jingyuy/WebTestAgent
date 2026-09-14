import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAssertTool } from './assert.js'
import { createInteractionTools } from './interact.js'
import { createObservationTools } from './observe.js'
import { toolContext } from './shared.js'

/**
 * Build every tool this plugin registers, without registering them.
 *
 * Kept separate from {@link registerBrowserTools} so the tool set can be
 * inspected or tested without a live cordis context.
 */
export function createBrowserTools(ctx: Context): ToolDefinition[] {
  const bag = toolContext(ctx)
  return [
    ...createObservationTools(bag),
    ...createInteractionTools(bag),
    createAssertTool(ctx),
  ]
}

/**
 * Register the browser tools on `ctx.tools`.
 *
 * Returns a single disposer that unregisters all of them, so the caller can
 * hand it straight to `ctx.effect` and have the tools disappear with the
 * plugin.
 */
export function registerBrowserTools(ctx: Context): () => void {
  const disposers = createBrowserTools(ctx).map((definition) => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Unloading must not fail because one tool was already gone.
      }
    }
  }
}

export { createAssertTool } from './assert.js'
export { createInteractionTools } from './interact.js'
export { createObservationTools } from './observe.js'
export { TOOL_PREFIX, sessionKey } from './shared.js'
