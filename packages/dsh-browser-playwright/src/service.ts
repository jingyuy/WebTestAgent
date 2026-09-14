import { Service, type Context } from '@deepseek-ai/cordis'
import type { SnapshotCapture } from './internal/snapshot.js'
import type {
  ActionRequest,
  ActionResult,
  ProbeRequest,
  ProbeResult,
} from './internal/session.js'

export type {
  ActionRequest,
  ActionResult,  ActionTarget,  BrowserActionKind,
  ProbeRequest,
  ProbeResult,
  ProbeState,
} from './internal/session.js'
export type { SnapshotCapture } from './internal/snapshot.js'

/** Name this capability is registered under on `ctx`. */
export const BROWSER_SERVICE_NAME = 'browser'

export interface OpenRequest {
  url: string
  /** Defaults to `domcontentloaded`, then waits for `load` best-effort. */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  timeoutMs?: number
  /** Caller cancellation, forwarded to the provider. */
  signal?: AbortSignal
}

export interface OpenResult {
  /** Final URL after redirects. */
  url: string
  /** HTTP status of the main document, when the transport reported one. */
  status: number | null
}

export interface ScreenshotRequest {
  /** Short label folded into the generated filename. */
  label?: string
  fullPage?: boolean
  /** Caller cancellation, forwarded to the provider. */
  signal?: AbortSignal
}

export interface ScreenshotResult {
  path: string
  fullPage: boolean
}

export interface CloseResult {
  /** Path of the recorded `.webm`, when video recording is enabled. */
  videoPath?: string
  /** Whether a session actually existed and was torn down. */
  closed: boolean
}

/**
 * The browser capability.
 *
 * This is a *service definition*: it declares what any browser provider must
 * offer, without saying how. `@webtestagent/dsh-browser-playwright` ships a
 * Playwright provider, but nothing in this contract mentions Playwright.
 *
 * Every method takes an opaque `sessionKey`. The provider decides what a
 * session is; the tools pass the DSH session (`exec.agent.id`) so concurrent
 * conversations cannot share cookies, storage, or element refs.
 *
 * All methods reject with a `Error` whose message is safe (and useful) to show
 * the model. There is no "silent success".
 */
export abstract class BrowserService extends Service {
  constructor(ctx: Context, name: string = BROWSER_SERVICE_NAME) {
    super(ctx, name)
  }

  /** Navigate the session's page, creating the session on first use. */
  abstract open(sessionKey: string, request: OpenRequest): Promise<OpenResult>

  /**
   * Capture a fresh snapshot and reallocate element refs.
   *
   * Invalidates every ref handed out by the previous snapshot.
   */
  abstract snapshot(sessionKey: string): Promise<SnapshotCapture>

  /** Perform one interaction against a snapshot ref (or a CSS escape hatch). */
  abstract act(sessionKey: string, request: ActionRequest): Promise<ActionResult>

  /** Read back observable state without mutating the page. */
  abstract probe(sessionKey: string, request: ProbeRequest): Promise<ProbeResult>

  /** Persist a PNG of the current viewport (or the full page). */
  abstract screenshot(sessionKey: string, request: ScreenshotRequest): Promise<ScreenshotResult>

  /** Tear the session down and release its context, cookies, and storage. */
  abstract close(sessionKey: string): Promise<CloseResult>

  /** Session keys with a live context, for diagnostics. */
  abstract liveSessions(): string[]

  /** Close every live session. Called on plugin unload. */
  abstract disposeAll(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserService
  }
}

/** Type guard usable from tools that inject `browser` defensively. */
export function isBrowserService(value: unknown): value is BrowserService {
  return value instanceof BrowserService
}
