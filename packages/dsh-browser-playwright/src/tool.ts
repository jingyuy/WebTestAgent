/**
 * The tool half of the plugin, published as its own subpath.
 *
 * `@webtestagent/dsh-browser-playwright/tool` is useful on its own: a host that
 * already provides *some* `BrowserService` can register the tools against it
 * without pulling in the Playwright provider.
 */
export {
  createBrowserTools,
  registerBrowserTools,
  createAssertTool,
  createInteractionTools,
  createObservationTools,
  TOOL_PREFIX,
  sessionKey,
} from './tools/index.js'
