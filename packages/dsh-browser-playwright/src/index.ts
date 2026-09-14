import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { BrowserPluginConfig } from './config.js'
import PlaywrightBrowser from './playwright.js'
import { registerBrowserTools } from './tools/index.js'

/** Cordis plugin name, as it appears in a profile patch. */
export const name = 'browser-playwright'

/**
 * `tools` is a hard dependency: without the tool registry there is nothing for
 * this plugin to contribute. Declaring it here means cordis will not load us
 * until the registry exists, instead of letting us register into thin air.
 */
export const inject = ['tools']

/**
 * The consumer half: register the `browser_*` tools.
 *
 * This is a separate plugin, and not part of {@link apply}, because of a cordis
 * rule that is easy to get wrong: reading an *uninjected* service off a context
 * is an ERROR ("cannot get property "browser" without inject"), not
 * `undefined`. `apply` cannot declare `inject: ['browser']`, because the very
 * plugin call that provides `browser` happens inside `apply` — that would be a
 * deadlock. A sibling plugin with its own inject scope resolves it: cordis
 * holds this fiber until both services exist, and then the tool factory can
 * read `ctx.browser` freely.
 */
const browserTools: Plugin.Object = {
  name: 'browser-tools',
  inject: ['tools', 'browser'],
  apply(ctx: Context): void {
    ctx.effect(() => registerBrowserTools(ctx))
  },
}

/**
 * Install the browser capability.
 *
 * Three roles, wired in order:
 *
 *   1. `PlaywrightBrowser` is the *provider*: it registers itself as
 *      `ctx.browser`. Nothing in the tool layer names Playwright, so another
 *      provider can be swapped in without touching it.
 *   2. `browserTools` is the *consumer*: it reads `ctx.browser` and registers
 *      nine `browser_*` tools on `ctx.tools`.
 *   3. `ctx.effect` hands both teardowns to the plugin lifecycle, so unloading
 *      closes every browser context and unregisters every tool.
 */
export function apply(ctx: Context, config: BrowserPluginConfig = {}): void {
  ctx.plugin(PlaywrightBrowser, config)
  ctx.plugin(browserTools)
}

/**
 * Default export so the plugin loads whether a host imports the module
 * namespace or its default binding.
 */
const plugin: Plugin.Object = { name, inject, apply }
export default plugin

// ----------------------------------------------------------------- public API

export { default as PlaywrightBrowser } from './playwright.js'
export { BrowserService, BROWSER_SERVICE_NAME, isBrowserService } from './service.js'
export { resolveConfig, defaultArtifactsDir } from './config.js'
export { createBrowserTools, registerBrowserTools, TOOL_PREFIX, sessionKey } from './tools/index.js'

export type {
  ActionRequest,
  ActionResult,
  BrowserActionKind,
  CloseResult,
  OpenRequest,
  OpenResult,
  ProbeRequest,
  ProbeResult,
  ProbeState,
  ScreenshotRequest,
  ScreenshotResult,
  SnapshotCapture,
} from './service.js'
export type { BrowserPluginConfig, ResolvedBrowserConfig } from './config.js'
