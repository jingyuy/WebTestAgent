import * as fs from 'node:fs/promises'
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_LAUNCH_ARGS,
  resolveConfig,
  type BrowserPluginConfig,
  type ResolvedBrowserConfig,
} from './config.js'
import { BrowserSession, INIT_SCRIPT_POLYFILL, type SessionOptions } from './internal/session.js'
import {
  BrowserService,
  type ChallengeInfo,
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
  type WaitForHumanRequest,
  type WaitForHumanResult,
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
 * Two lifecycle modes, chosen by the `persistent` config option:
 *
 *   **isolated** (default) — one shared chromium *process*; every DSH session
 *   gets its own `BrowserContext`, so cookies, localStorage and element refs
 *   cannot leak between conversations. Launched lazily on first use.
 *
 *   **persistent** — one on-disk profile, driven through
 *   `launchPersistentContext`. Cookies, storage, service workers and
 *   extensions survive the process, which is what lets a site recognise the
 *   browser as a returning person instead of a fresh machine. Every session
 *   gets its own *tab* in that one context: sessions no longer isolate cookies
 *   (that is the point), but they still isolate pages and refs.
 *
 * In both modes a session is disposed after `idleTimeoutMs` without use, and
 * every session is disposed when the plugin unloads.
 */
export default class PlaywrightBrowser extends BrowserService {
  readonly config: ResolvedBrowserConfig

  private browser: Browser | null = null
  private profile: BrowserContext | null = null
  private launchingBrowser: Promise<Browser> | null = null
  private launchingProfile: Promise<BrowserContext> | null = null
  private readonly sessions = new Map<string, SessionEntry>()
  /** Untouched tabs of the persistent context, kept for reuse. */
  private readonly parkedPages: Page[] = []
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

  get humanInTheLoop(): boolean {
    return this.config.humanInTheLoop
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * The chromium arguments this provider always uses.
   *
   * `ignoreDefaultArgs` drops `--enable-automation`, the loudest "a robot is
   * driving" flag chromium can carry. Playwright adds it by default, and
   * passing a different value would not undo it — the flag has to be removed.
   */
  private launchOptions(): LaunchOptions {
    return {
      headless: this.config.headless,
      args: [...DEFAULT_LAUNCH_ARGS, ...this.config.launchArgs],
      ignoreDefaultArgs: ['--enable-automation'],
      ...(this.config.channel ? { channel: this.config.channel } : {}),
      ...(this.config.slowMo > 0 ? { slowMo: this.config.slowMo } : {}),
    }
  }

  /**
   * Context-level options shared by both modes.
   *
   * `viewport: null` is a deliberate realism choice for the persistent profile:
   * a fixed, non-standard viewport is trivially fingerprintable, so the real
   * window size is used unless the user asked for a specific one.
   */
  private contextOptions(): {
    viewport: { width: number; height: number } | null
    locale?: string
    timezoneId?: string
  } {
    return {
      viewport: this.config.viewport,
      ...(this.config.locale ? { locale: this.config.locale } : {}),
      ...(this.config.timezoneId ? { timezoneId: this.config.timezoneId } : {}),
    }
  }

  /** Launch chromium on demand, with an actionable message if it is missing. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    if (this.launchingBrowser) return this.launchingBrowser

    this.launchingBrowser = (async () => {
      try {
        const browser = await chromium.launch(this.launchOptions())
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
        this.launchingBrowser = null
      }
    })()

    return this.launchingBrowser
  }

  /**
   * Launch the persistent profile on demand.
   *
   * Everything a site learns about this browser — cookies, storage, the
   * challenge it already passed — accumulates in `userDataDir` and outlives the
   * process. That is the whole reason this mode exists.
   */
  private async ensureProfile(): Promise<BrowserContext> {
    if (this.profile) return this.profile
    if (this.launchingProfile) return this.launchingProfile

    this.launchingProfile = (async () => {
      try {
        await fs.mkdir(this.config.userDataDir, { recursive: true })
        await fs.mkdir(this.config.videosDir, { recursive: true })
        await fs.mkdir(this.config.screenshotsDir, { recursive: true })

        const context = await chromium.launchPersistentContext(this.config.userDataDir, {
          ...this.launchOptions(),
          ...this.contextOptions(),
          ...(this.config.recordVideo
            ? { recordVideo: { dir: this.config.videosDir, size: { width: 1280, height: 720 } } }
            : {}),
        })

        // A persistent context outlives any one session, so the evaluate
        // polyfill is installed here, once, rather than per session.
        await context.addInitScript({ content: INIT_SCRIPT_POLYFILL })

        context.on('close', () => {
          if (this.profile === context) this.profile = null
        })

        // A browser always starts with one tab. Park it for the first session
        // instead of leaving a stray blank window beside the run.
        for (const page of context.pages()) {
          if (page.url() === 'about:blank') this.parkedPages.push(page)
        }

        this.profile = context
        return context
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Failed to open the persistent browser profile at ${this.config.userDataDir}. ` +
            'If the browser binary is missing, run `npx playwright install chromium`. ' +
            'If the directory is locked, another chromium is still using this profile — ' +
            'close it, or point `userDataDir` somewhere else. ' +
            `Original error: ${detail}`,
        )
      } finally {
        this.launchingProfile = null
      }
    })()

    return this.launchingProfile
  }

  /** Session plumbing that does not depend on which mode is in play. */
  private sessionOptions(): SessionOptions {
    return {
      viewport: this.config.viewport,
      timeoutMs: this.config.timeoutMs,
      humanInTheLoop: this.config.humanInTheLoop,
      ...(this.config.recordVideo ? { videosDir: this.config.videosDir } : {}),
      ...(this.config.screenshots ? { screenshotsDir: this.config.screenshotsDir } : {}),
    }
  }

  /** A tab from the profile, reusing a parked one when there is one. */
  private async takePage(context: BrowserContext): Promise<Page> {
    while (this.parkedPages.length > 0) {
      const page = this.parkedPages.pop() as Page
      if (!page.isClosed()) return page
    }
    return context.newPage()
  }

  private async createSession(): Promise<BrowserSession> {
    if (!this.config.persistent) {
      return BrowserSession.create(await this.ensureBrowser(), this.sessionOptions())
    }
    const context = await this.ensureProfile()
    return BrowserSession.attach(context, await this.takePage(context), this.sessionOptions())
  }

  /** Get (or lazily create) the session entry for `sessionKey`. */
  private async entry(sessionKey: string): Promise<SessionEntry> {
    const existing = this.sessions.get(sessionKey)
    if (existing && !existing.session.isClosed) {
      existing.lastUsed = Date.now()
      return existing
    }

    const session = await this.createSession()
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

  override async detectChallenge(sessionKey: string): Promise<ChallengeInfo> {
    return this.withSession(sessionKey, (session) => session.detectChallenge())
  }

  /**
   * Park the agent while a person clears a challenge in the browser window.
   *
   * Refusing up front when nobody can see the browser is the important part: an
   * agent that blocks for five minutes on a headless challenge has learned
   * nothing and reported even less. The refusal is a caller mistake, so it
   * throws with the way out rather than returning a quiet failure.
   */
  override async waitForHuman(sessionKey: string, request: WaitForHumanRequest): Promise<WaitForHumanResult> {
    if (!this.config.humanInTheLoop) {
      throw new Error(
        'browser_wait_for_human cannot help here: this browser is headless, so no person can see or ' +
          'reach it. Run with `headless: false` to show a real window, or set the plugin config ' +
          '`humanInTheLoop: true` if a human can reach this headless browser out of band (a remote ' +
          'viewer or a CDP session). Otherwise the only honest moves are browser_snapshot to re-read ' +
          'the page, browser_wait if the challenge clears itself, or reporting the block.',
      )
    }

    const entry = await this.entry(sessionKey)
    return entry.queue.run(() =>
      entry.session.waitForHuman(request, () => {
        // A person is looking at this session right now. The idle sweep must not
        // reap it out from under them while they work.
        entry.lastUsed = Date.now()
      }),
    )
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

    this.parkedPages.length = 0

    // Closing the persistent context is what flushes the profile to disk, so it
    // must happen before the process goes away.
    const profile = this.profile
    this.profile = null
    await profile?.close().catch(() => undefined)

    const browser = this.browser
    this.browser = null
    await browser?.close().catch(() => undefined)
  }
}
