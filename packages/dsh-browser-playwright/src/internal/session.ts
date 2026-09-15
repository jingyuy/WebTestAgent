import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { type Browser, type BrowserContext, type Locator, type Page, type Video } from 'playwright'
import { RefStore } from './refs.js'
import { captureSnapshot, type SnapshotCapture } from './snapshot.js'
import { detectChallenge, type ChallengeInfo } from './challenge.js'

/** Prefix a scheme when the user types `example.com`. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

/** Collapse whitespace the way the snapshot does, so comparisons line up. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * No-op `__name` helper, injected into every document.
 *
 * Bundlers with `keepNames` enabled (tsx/esbuild, and DSH's own loader) rewrite
 * every compiled function with a `__name(fn, "x")` call. Playwright serialises
 * function source INTO the page, where that helper does not exist, so any
 * `page.evaluate()` fails with "ReferenceError: __name is not defined" — which
 * silently degrades to an empty result. The polyfill must be present in the
 * page before any evaluate-based collector runs, in dev *and* in a build.
 *
 * Exported because a persistent `BrowserContext` is shared by every session, so
 * its owner installs this once, at launch.
 */
export const INIT_SCRIPT_POLYFILL = 'globalThis.__name ||= (fn) => fn;'

// --------------------------------------------------------------------- actions

/** Every mutating capability the browser layer exposes. */
export type BrowserActionKind =
  | 'click'
  | 'fill'
  | 'press'
  | 'select'
  | 'hover'
  | 'check'
  | 'uncheck'
  | 'focus'
  | 'scroll_into_view'

/** How to find the element an action targets. */
export interface ActionTarget {
  /** Snapshot ref (`e3`). Preferred: refs are validated against the generation. */
  ref?: string
  /** Raw CSS selector escape hatch, for when no snapshot ref matches. */
  selector?: string
}

export interface ActionRequest extends ActionTarget {
  kind: BrowserActionKind
  /** Value for `fill` / `select`, or the key for `press`. */
  value?: string
  /** Option label, for `select` by visible text. */
  label?: string
  /** Key name for `press`, e.g. `Enter`. */
  key?: string
  timeoutMs?: number
  force?: boolean
  /** Caller cancellation, forwarded to Playwright. */
  signal?: AbortSignal
}

export interface ActionResult {
  action: BrowserActionKind
  /** Human-readable description of what was acted on, e.g. `button "Sign in" (e7)`. */
  target: string
  /** Which strategy resolved the element. */
  strategy: 'ref' | 'selector'
  /** URL before the action ran. */
  urlBefore: string
  /** URL after the action settled. */
  urlAfter: string
  /** True when the action navigated the page. */
  navigated: boolean
}

// ---------------------------------------------------------------------- probes

/** Element states Playwright can wait for. */
export type ProbeState = 'attached' | 'detached' | 'visible' | 'hidden'

/**
 * One observation request.
 *
 * Supply one condition; `probe` waits for it and reports whether it was
 * reached, so callers never have to poll from the outside.
 */
export interface ProbeRequest extends ActionTarget {
  /** Text to look for anywhere on the page, instead of an element. */
  text?: string
  /** Substring the target's text must contain. */
  contains?: string
  /** Substring the current URL must contain. */
  urlContains?: string
  /** Substring the page title must contain. */
  titleContains?: string
  /** Element state to wait for. Defaults to `visible` for text, else `attached`. */
  state?: ProbeState
  timeoutMs?: number
  /** Caller cancellation, forwarded to Playwright. */
  signal?: AbortSignal
}

/** What was observed, and whether the requested condition was reached. */
export interface ProbeResult {
  /** Whether the requested wait/condition was reached. `null` for a bare read. */
  stateSatisfied: boolean | null
  /** Whether an element matched (i.e. it is attached to the DOM). */
  found: boolean
  strategy: 'ref' | 'selector' | 'text' | 'url' | 'title'
  count: number
  visible: boolean
  enabled: boolean
  /** Trimmed `innerText`, for element and text probes. */
  text: string
  /** Current `value`, for form controls. */
  value: string | null
  /** Only meaningful for checkbox/radio. */
  checked: boolean | null
  /** Resolved accessible role, when known. */
  role: string | null
  /** Resolved accessible name, when known. */
  name: string | null
  url: string
  title: string
  /** True when a wait timed out rather than resolving immediately. */
  timedOut: boolean
}

export interface SessionOptions {
  /** `null` uses the real window size instead of a fixed viewport. */
  viewport: { width: number; height: number } | null
  videosDir?: string
  screenshotsDir?: string
  timeoutMs: number
  /**
   * Whether a person can reach this browser, which decides whether the
   * snapshot's challenge advice may point at `browser_wait_for_human`.
   */
  humanInTheLoop: boolean
}

// --------------------------------------------------------------------- session

/**
 * One DSH session maps onto one page: either a fresh `BrowserContext` (the
 * isolated default) or one tab inside the deployment's shared persistent
 * profile. The chromium process is shared either way, so concurrent
 * conversations cannot leak auth state into each other *in isolated mode* and
 * do not each pay for a browser in either mode.
 *
 * `ownsContext` is what makes the two modes interchangeable: closing an
 * isolated session tears its context down, whereas closing a session inside a
 * persistent profile closes only its tab, leaving the cookies and storage the
 * profile exists to accumulate.
 */
export class BrowserSession {
  readonly refs = new RefStore()
  readonly page: Page

  private readonly context: BrowserContext
  private readonly video: Video | null
  private readonly options: SessionOptions
  private readonly ownsContext: boolean
  private shotCounter = 0
  private closed = false

  private constructor(context: BrowserContext, page: Page, options: SessionOptions, ownsContext: boolean) {
    this.context = context
    this.page = page
    this.options = options
    this.ownsContext = ownsContext
    this.video = page.video()
    this.page.setDefaultTimeout(options.timeoutMs)
  }

  /** Create an isolated context inside an already-running browser. */
  static async create(browser: Browser, options: SessionOptions): Promise<BrowserSession> {
    if (options.screenshotsDir) await fs.mkdir(options.screenshotsDir, { recursive: true })
    if (options.videosDir) await fs.mkdir(options.videosDir, { recursive: true })

    const context = await browser.newContext({
      viewport: options.viewport,
      ...(options.videosDir
        ? { recordVideo: { dir: options.videosDir, size: { width: 1280, height: 720 } } }
        : {}),
    })

    // Bundlers with `keepNames` enabled (tsx/esbuild, and DSH's own loader)
    // rewrite every compiled function with a `__name(fn, "x")` helper.
    // Playwright serialises function source INTO the page, where that helper
    // does not exist, so `page.evaluate(() => ...)` fails with
    // "ReferenceError: __name is not defined". A no-op polyfill injected into
    // every document keeps evaluate-based code (the snapshot and challenge
    // collectors) working both in dev and in a build.
    await context.addInitScript({ content: INIT_SCRIPT_POLYFILL })

    const page = await context.newPage()
    return new BrowserSession(context, page, options, true)
  }

  /**
   * Wrap a page that lives in a context somebody else owns — the shared
   * persistent profile. Installing {@link INIT_SCRIPT_POLYFILL} is the owner's
   * job here, because a persistent context outlives any one session and the
   * script only has to be added once.
   */
  static attach(context: BrowserContext, page: Page, options: SessionOptions): BrowserSession {
    return new BrowserSession(context, page, options, false)
  }

  get isClosed(): boolean {
    return this.closed
  }

  get currentUrl(): string {
    return this.page.url()
  }

  // -------------------------------------------------------------- navigation

  /** Navigate and wait for the page to be interactive. */
  async goto(
    url: string,
    opts: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<{ url: string; status: number | null }> {
    const target = normalizeUrl(url)
    const waitUntil = opts.waitUntil ?? 'domcontentloaded'
    const response = await this.page.goto(target, {
      waitUntil,
      timeout: opts.timeoutMs ?? 45_000,
      signal: opts.signal,
    })
    if (waitUntil === 'load' || waitUntil === 'domcontentloaded') {
      await this.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined)
    }
    return { url: this.page.url(), status: response ? response.status() : null }
  }

  /** Rebuild the snapshot and invalidate every previous ref. */
  async snapshot(): Promise<SnapshotCapture> {
    return captureSnapshot(this.page, this.refs, { humanInTheLoop: this.options.humanInTheLoop })
  }

  // --------------------------------------------------------------- challenge

  /** Is the current page an automated-traffic challenge rather than content? */
  async detectChallenge(): Promise<ChallengeInfo> {
    return detectChallenge(this.page)
  }

  /**
   * Block until the challenge on screen is gone, or the deadline passes.
   *
   * This is the human half of the loop: the agent cannot clear a CAPTCHA, so it
   * hands the wheel to a person watching the browser window and waits. Every
   * poll re-runs the same detector the snapshot uses, so "cleared" means
   * exactly what the next snapshot will report — there is no second definition
   * of done that could disagree with the observation the agent sees next.
   *
   * The loop never throws on timeout: "the challenge is still there" is an
   * observation about the page, and the caller needs it as much as the success
   * case. Only a caller mistake (a cancellation) ends the wait as an error.
   *
   * `onTick` fires once per poll so the owner can keep a session alive that
   * would otherwise be reaped as idle *while a person is looking at it*.
   */
  async waitForHuman(
    request: { timeoutMs: number; pollMs: number; signal?: AbortSignal },
    onTick?: () => void,
  ): Promise<{ cleared: boolean; alreadyClear: boolean; waitedMs: number; challenge: ChallengeInfo }> {
    const startedAt = Date.now()
    const deadline = startedAt + request.timeoutMs

    let challenge = await this.detectChallenge()
    const alreadyClear = !challenge.detected
    if (alreadyClear) {
      return { cleared: true, alreadyClear, waitedMs: 0, challenge }
    }

    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        throw new Error('browser_wait_for_human was cancelled by the caller while waiting for a person.')
      }
      onTick?.()
      await delay(Math.min(request.pollMs, Math.max(deadline - Date.now(), 0)))
      challenge = await this.detectChallenge()
      if (!challenge.detected) {
        return { cleared: true, alreadyClear: false, waitedMs: Date.now() - startedAt, challenge }
      }
    }

    return { cleared: false, alreadyClear: false, waitedMs: Date.now() - startedAt, challenge }
  }

  // ----------------------------------------------------------------- actions

  /**
   * Resolve an action target to a live locator.
   *
   * Refs are validated against the current generation, so acting on a stale ref
   * fails with a message that explains how to recover.
   */
  resolve(
    target: ActionTarget,
    refLabel = '',
  ): { locator: Locator; description: string; strategy: 'ref' | 'selector' } {
    if (target.ref) {
      const entry = this.refs.require(target.ref)
      const name = entry.name ? ` "${entry.name}"` : ''
      return { locator: entry.locator, description: `${entry.role}${name} (${entry.ref})`, strategy: 'ref' }
    }

    if (target.selector) {
      return {
        locator: this.page.locator(target.selector).first(),
        description: `selector ${JSON.stringify(target.selector)}`,
        strategy: 'selector',
      }
    }

    throw new Error(
      `Missing element reference${refLabel ? ` for ${refLabel}` : ''}: pass either "ref" ` +
        '(from the latest browser_snapshot) or "selector" as an escape hatch.',
    )
  }

  /** Perform one interaction, then notice any navigation it caused. */
  async act(request: ActionRequest): Promise<ActionResult> {
    const timeout = request.timeoutMs ?? this.options.timeoutMs
    const force = request.force === true
    const signal = request.signal
    const urlBefore = this.page.url()

    // `press` may legitimately target the page rather than an element, for
    // global shortcuts such as Escape or Tab.
    if (request.kind === 'press' && !request.ref && !request.selector) {
      const key = request.key ?? request.value
      if (!key) throw new Error('browser_press requires "key".')
      await this.page.keyboard.press(key)
      return this.settle('press', `page keyboard (${key})`, 'selector', urlBefore)
    }

    const { locator, description, strategy } = this.resolve(request, request.kind)

    // Best effort: bring the element into view first. Playwright also
    // auto-scrolls, but doing it up front keeps the recorded video readable and
    // avoids flaky clicks under sticky headers.
    await locator.scrollIntoViewIfNeeded({ timeout: Math.min(timeout, 5_000) }).catch(() => undefined)

    switch (request.kind) {
      case 'click':
        await locator.click({ timeout, force, signal })
        break
      case 'hover':
        await locator.hover({ timeout, force, signal })
        break
      case 'fill': {
        if (request.value === undefined) throw new Error('browser_fill requires "value".')
        await locator.fill(request.value, { timeout, force, signal })
        break
      }
      case 'press': {
        const key = request.key ?? request.value
        if (!key) throw new Error('browser_press requires "key".')
        await locator.press(key, { timeout, signal })
        break
      }
      case 'select': {
        if (request.value === undefined && request.label === undefined) {
          throw new Error('browser_select requires either "value" or "label".')
        }
        await locator.selectOption(
          request.value !== undefined ? { value: request.value } : { label: request.label as string },
          { timeout, force, signal },
        )
        break
      }
      case 'check':
        await locator.check({ timeout, force, signal })
        break
      case 'uncheck':
        await locator.uncheck({ timeout, force, signal })
        break
      case 'focus':
        await locator.focus({ timeout, signal })
        break
      case 'scroll_into_view':
        await locator.scrollIntoViewIfNeeded({ timeout, signal })
        break
    }

    // NB: refs are deliberately NOT cleared here. Refs live until the next
    // snapshot; clearing them on every action would force a snapshot between
    // each field of a form fill.
    return this.settle(request.kind, description, strategy, urlBefore)
  }

  /**
   * Finish an action: notice navigation and let the new document settle, so the
   * snapshot the caller takes next sees the destination page rather than a
   * half-torn-down one.
   */
  private async settle(
    action: BrowserActionKind,
    target: string,
    strategy: 'ref' | 'selector',
    urlBefore: string,
  ): Promise<ActionResult> {
    const urlAfter = this.page.url()
    const navigated = urlAfter !== urlBefore
    if (navigated) {
      await this.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined)
    }
    return { action, target, strategy, urlBefore, urlAfter, navigated }
  }

  // ------------------------------------------------------------------ probes

  /**
   * Observe the page, waiting for the requested condition.
   *
   * A missing element is an *observation*, not a failure, so this never throws
   * for one. Only genuinely broken input (an unknown ref, or no condition at
   * all) rejects — those are bugs in the caller, not facts about the page.
   */
  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const timeout = request.timeoutMs ?? 2_000
    const signal = request.signal

    if (request.urlContains !== undefined) {
      return this.probeUrl(request.urlContains, timeout, signal)
    }
    if (request.titleContains !== undefined) {
      return this.probeTitle(request.titleContains, timeout, signal)
    }

    const isTextOnly = request.text !== undefined && !request.ref && !request.selector
    if (!isTextOnly && !request.ref && !request.selector) {
      throw new Error('A probe needs one of: ref, selector, text, urlContains, or titleContains.')
    }

    const waitState: ProbeState = request.state ?? (isTextOnly ? 'visible' : 'attached')
    const locator = isTextOnly
      ? this.page.getByText(request.text as string, { exact: false }).first()
      : this.resolve(request, 'probe').locator
    const strategy: ProbeResult['strategy'] = isTextOnly ? 'text' : request.ref ? 'ref' : 'selector'
    const entry = request.ref ? this.refs.get(request.ref) : undefined

    // Let Playwright do the waiting: it re-evaluates the condition on DOM
    // mutations, which polling from the outside cannot match.
    let timedOut = false
    try {
      await locator.waitFor({ state: waitState, timeout, signal })
    } catch {
      timedOut = true
    }

    // `contains` is the one condition Playwright cannot wait for, so it is
    // polled against the same deadline.
    const containsSatisfied =
      request.contains === undefined
        ? true
        : timedOut
          ? false
          : await this.waitForText(locator, request.contains, Date.now() + timeout, signal)

    // `detached`/`hidden` succeeding means the element is gone by definition;
    // an `attached`/`visible` wait succeeding means it is present.
    const found = timedOut
      ? await locator
          .count()
          .then((n) => n > 0)
          .catch(() => false)
      : waitState === 'attached' || waitState === 'visible'
    const visible = found ? await locator.isVisible().catch(() => false) : false
    const enabled = found ? await locator.isEnabled().catch(() => false) : false
    const text = found ? normalizeText((await locator.innerText().catch(() => '')) || '') : ''
    const value = found
      ? await locator
          .inputValue()
          .then((v) => v)
          .catch(() => null)
      : null
    const checked = found
      ? await locator
          .isChecked()
          .then((v) => v)
          .catch(() => null)
      : null
    const count = await locator.count().catch(() => 0)

    return {
      stateSatisfied:
        request.state !== undefined || request.contains !== undefined
          ? !timedOut && containsSatisfied
          : null,
      found,
      strategy,
      count,
      visible,
      enabled,
      text,
      value,
      checked,
      role: entry?.role ?? null,
      name: entry?.name ?? null,
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      timedOut,
    }
  }

  /** Poll an element's text until it contains `expected`, or the deadline passes. */
  private async waitForText(
    locator: Locator,
    expected: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const wanted = normalizeText(expected)
    for (;;) {
      const text = normalizeText((await locator.innerText().catch(() => '')) || '')
      if (text.includes(wanted)) return true
      if (Date.now() >= deadline || signal?.aborted) return false
      await delay(Math.min(200, Math.max(deadline - Date.now(), 0)))
    }
  }

  /** Wait for the URL to contain `expected`. */
  private async probeUrl(expected: string, timeout: number, signal?: AbortSignal): Promise<ProbeResult> {
    let satisfied = true
    try {
      await this.page.waitForURL((url) => url.toString().includes(expected), { timeout, signal })
    } catch {
      satisfied = false
    }
    const url = this.page.url()
    return {
      stateSatisfied: satisfied,
      found: satisfied,
      strategy: 'url',
      count: satisfied ? 1 : 0,
      visible: false,
      enabled: false,
      text: url,
      value: null,
      checked: null,
      role: null,
      name: null,
      url,
      title: await this.page.title().catch(() => ''),
      timedOut: !satisfied,
    }
  }

  /** Poll the title until it contains `expected`. Playwright has no primitive for this. */
  private async probeTitle(expected: string, timeout: number, signal?: AbortSignal): Promise<ProbeResult> {
    const deadline = Date.now() + timeout
    const wanted = normalizeText(expected)
    let title = await this.page.title().catch(() => '')
    let satisfied = normalizeText(title).includes(wanted)
    while (!satisfied && !signal?.aborted && Date.now() < deadline) {
      await delay(Math.min(200, Math.max(deadline - Date.now(), 0)))
      title = await this.page.title().catch(() => '')
      satisfied = normalizeText(title).includes(wanted)
    }
    return {
      stateSatisfied: satisfied,
      found: satisfied,
      strategy: 'title',
      count: satisfied ? 1 : 0,
      visible: false,
      enabled: false,
      text: title,
      value: null,
      checked: null,
      role: null,
      name: null,
      url: this.page.url(),
      title,
      timedOut: !satisfied,
    }
  }

  // --------------------------------------------------------------- artifacts

  /** Save a numbered screenshot into the session's screenshots directory. */
  async screenshot(label: string, fullPage = false, signal?: AbortSignal): Promise<string> {
    if (!this.options.screenshotsDir) {
      throw new Error('Screenshots are not enabled: set the plugin config option "screenshots".')
    }
    this.shotCounter += 1
    const safe =
      label
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'shot'
    const name = `${String(this.shotCounter).padStart(3, '0')}-${safe}.png`
    const file = path.join(this.options.screenshotsDir, name)
    await this.page.screenshot({ path: file, fullPage, signal })
    return file
  }

  // ---------------------------------------------------------------- teardown

  /**
   * Tear this session's page down and return the recorded video path.
   *
   * An owned context is closed outright (which flushes the video). A page that
   * lives in a shared persistent profile closes only itself — the profile, and
   * everything it has accumulated, outlives the session by design.
   *
   * The recording is only written to disk once its context or page closes, so
   * the video path must be read AFTER that — and the file must never be deleted
   * here, or the artifact is lost.
   */
  async close(): Promise<{ videoPath?: string }> {
    if (this.closed) return {}
    this.closed = true
    this.refs.clear()
    if (this.ownsContext) {
      await this.context.close().catch(() => undefined)
    } else {
      await this.page.close().catch(() => undefined)
    }
    let videoPath: string | undefined
    if (this.video) {
      videoPath = await this.video.path().catch(() => undefined)
    }
    return videoPath ? { videoPath } : {}
  }
}
