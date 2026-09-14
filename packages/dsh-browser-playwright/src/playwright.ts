import { chromium, type Browser } from 'playwright'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type BrowserPluginConfig, type ResolvedBrowserConfig } from './config.js'
import { BrowserSession } from './internal/session.js'
import {
  BrowserService,
  type CloseResult,
  type OpenRequest,
  type OpenResult,
  type ScreenshotRequest,
  type ScreenshotResult,
  type SnapshotCapture,
  type ActionRequest,
  type ActionResult,
  type ProbeRequest,
  type ProbeResult,
} from './service.js'

/** Serialises work on one session so parallel tool calls cannot interleave. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

interface SessionEntry {
  session: BrowserSession
  lastUsed: number
  queue: SerialQueue
}

const IDLE_SWEEP_MS = 30_000

/**
 * Playwright provider for {@link BrowserService}.
 *
 * Lifecycle choices:
 *   - the chromium **process** is shared and launched lazily on first use;
 *   - every DSH session gets its own `BrowserContext`, so cookies, localStorage,
 *     and element refs are isolated per conversation;
 *   - a session is disposed after `idleTimeoutMs` without use, and every session
 *     is disposed when the plugin unloads.
 */
export default class PlaywrightBrowser extends BrowserService {
  readonly config: ResolvedBrowserConfig

  private browser: Browser | null = null
  private launching: Promise<Browser> | null = null
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly sweep: NodeJS.Timeout

  constructor(ctx: Context, config: BrowserPluginConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)

    this.sweep = setInterval(() => {
      void this.reapIdle()
    }, IDLE_SWEEP_MS)
    // Never hold the process open just for the idle sweep.
    this.sweep.unref?.()

    // Disposers registered through `ctx.effect` run when this plugin unloads.
    ctx.effect(() => () => this.disposeAll())
  }

  // ---------------------------------------------------------------- lifecycle

  /** Launch chromium on demand, with an actionable message if it is missing. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    if (this.launching) return this.launching

    this.launching = (async () => {
      try {
        const browser = await chromium.launch({
          headless: this.config.headless,
          args: this.config.launchArgs,
          slowMo: this.config.slowMo > 0 ? this.config.slowMo : undefined,
        })
        this.browser = browser
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null
        })
        return browser
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          'Failed to launch chromium for the browser capability. ' +
            'If the browser binary is missing, run `npx playwright install chromium`. ' +
            `Original error: ${detail}`,
        )
      } finally {
        this.launching = null
      }
    })()

    return this.launching
  }

  /** Get (or lazily create) the session entry for `sessionKey`. */
  private async entry(sessionKey: string): Promise<SessionEntry> {
    const existing = this.sessions.get(sessionKey)
    if (existing && !existing.session.isClosed) {
      existing.lastUsed = Date.now()
      return existing
    }

    const browser = await this.ensureBrowser()
    const session = await BrowserSession.create(browser, {
      viewport: this.config.viewport,
      timeoutMs: this.config.timeoutMs,
      ...(this.config.recordVideo ? { videosDir: this.config.videosDir } : {}),
      ...(this.config.screenshots ? { screenshotsDir: this.config.screenshotsDir } : {}),
    })

    const created: SessionEntry = { session, lastUsed: Date.now(), queue: new SerialQueue() }
    this.sessions.set(sessionKey, created)
    return created
  }

  /** Run `fn` against the session, serialised against other calls on it. */
  private async withSession<T>(sessionKey: string, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    const entry = await this.entry(sessionKey)
    return entry.queue.run(() => fn(entry.session))
  }

  private async reapIdle(): Promise<void> {
    if (this.config.idleTimeoutMs <= 0) return
    const cutoff = Date.now() - this.config.idleTimeoutMs
    const stale = [...this.sessions.entries()].filter(([, e]) => e.lastUsed < cutoff)
    for (const [key, entry] of stale) {
      this.sessions.delete(key)
      await entry.session.close().catch(() => undefined)
    }
  }

  // ----------------------------------------------------------------- contract

  override async open(sessionKey: string, request: OpenRequest): Promise<OpenResult> {
    return this.withSession(sessionKey, async (session) => {
      const { url, status } = await session.goto(request.url, {
        ...(request.waitUntil ? { waitUntil: request.waitUntil } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      return { url, status }
    })
  }

  override async snapshot(sessionKey: string): Promise<SnapshotCapture> {
    return this.withSession(sessionKey, (session) => session.snapshot())
  }

  override async act(sessionKey: string, request: ActionRequest): Promise<ActionResult> {
    return this.withSession(sessionKey, (session) => session.act(request))
  }

  override async probe(sessionKey: string, request: ProbeRequest): Promise<ProbeResult> {
    return this.withSession(sessionKey, (session) => session.probe(request))
  }

  override async screenshot(sessionKey: string, request: ScreenshotRequest): Promise<ScreenshotResult> {
    const fullPage = request.fullPage === true
    const path = await this.withSession(sessionKey, (session) =>
      session.screenshot(request.label ?? 'shot', fullPage, request.signal),
    )
    return { path, fullPage }
  }

  override async close(sessionKey: string): Promise<CloseResult> {
    const entry = this.sessions.get(sessionKey)
    if (!entry) return { closed: false }
    this.sessions.delete(sessionKey)
    const result = await entry.session.close()
    return { closed: true, ...(result.videoPath ? { videoPath: result.videoPath } : {}) }
  }

  override liveSessions(): string[] {
    return [...this.sessions.keys()]
  }

  override async disposeAll(): Promise<void> {
    clearInterval(this.sweep)
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((e) => e.session.close().catch(() => undefined)))
    const browser = this.browser
    this.browser = null
    await browser?.close().catch(() => undefined)
  }
}
