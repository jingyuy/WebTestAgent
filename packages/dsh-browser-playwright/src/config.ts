import * as os from 'node:os'
import * as path from 'node:path'

/**
 * User-facing plugin config, as written in `cordis.patch.yml`.
 *
 * Every field is optional so the plugin loads with an empty config.
 */
export interface BrowserPluginConfig {
  /** Run chromium without a visible window. Default `true`. */
  headless?: boolean
  /** Per-action timeout. Default `15000`. */
  timeoutMs?: number
  /**
   * Close a session after this long without any browser tool call.
   * Default `600000` (10 minutes). `0` disables idle disposal.
   */
  idleTimeoutMs?: number
  /** Slow every Playwright action by this many ms, to watch a run. Default `0`. */
  slowMo?: number
  /**
   * Fixed viewport. Leave unset for the default `1280x800`, or for the real
   * window size when `persistent` is on (see {@link ResolvedBrowserConfig.viewport}).
   */
  viewport?: { width?: number; height?: number }
  /** Base directory for videos and screenshots. */
  artifactsDir?: string
  /** Record a `.webm` per session. Default `true`. */
  recordVideo?: boolean
  /** Allow `browser_screenshot`. Default `true`. */
  screenshots?: boolean
  /** Extra chromium launch args, appended to the defaults. */
  launchArgs?: string[]

  /**
   * Drive a real, on-disk Chromium profile instead of a throwaway one.
   *
   * Default `false`. When `true` the browser keeps its cookies, `localStorage`,
   * IndexedDB, service workers and installed extensions in {@link userDataDir}
   * between runs, and the sessions of one deployment share a single
   * `BrowserContext` (each session gets its own *tab*). That is what makes the
   * browser look like a returning person rather than a fresh machine: a site
   * that already trusts this profile does not re-issue its challenge.
   *
   * The trade-off is stated plainly: sessions no longer get isolated cookie
   * jars, so a login performed in one conversation is visible to the next.
   */
  persistent?: boolean
  /**
   * Directory for the persistent profile. Defaults to `profile/` next to the
   * artifacts dir. Ignored unless {@link persistent} is set.
   */
  userDataDir?: string
  /**
   * Browser channel, e.g. `chrome` to drive an installed Google Chrome rather
   * than the bundled Chromium build. Default: the bundled build.
   */
  channel?: string
  /** Context locale, e.g. `en-GB`. Default: the browser's own. */
  locale?: string
  /** IANA time zone, e.g. `Europe/London`. Default: the host's. */
  timezoneId?: string
  /**
   * Allow `browser_wait_for_human` to pause the run for a person.
   *
   * Default: `true` when the browser is visible (`headless: false`), else
   * `false`. Set it explicitly to `true` for a headless browser that a human
   * can still reach out-of-band (a remote viewer, a CDP session).
   */
  humanInTheLoop?: boolean
}

export interface ResolvedBrowserConfig {
  headless: boolean
  timeoutMs: number
  idleTimeoutMs: number
  slowMo: number
  /**
   * `null` means "no fixed viewport": the page uses the real window size.
   *
   * A fixed, non-standard viewport is one of the cheapest ways a site can spot
   * automation, so the persistent profile defaults to the real window size.
   * An explicit `viewport` in the config always wins, in both modes.
   */
  viewport: { width: number; height: number } | null
  artifactsDir: string
  videosDir: string
  screenshotsDir: string
  recordVideo: boolean
  screenshots: boolean
  launchArgs: string[]
  persistent: boolean
  userDataDir: string
  channel?: string
  locale?: string
  timezoneId?: string
  humanInTheLoop: boolean
}

/**
 * Chromium args this plugin always passes.
 *
 * `--disable-blink-features=AutomationControlled` is the standard first step
 * toward a browser that behaves like a person's: without it, Chromium exposes
 * the automation control that a great many anti-bot systems fingerprint on.
 * `--enable-automation` is *removed* separately, via `ignoreDefaultArgs` in the
 * provider, because passing it again would not undo it.
 */
export const DEFAULT_LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled']

/**
 * Where artifacts land when the user does not say.
 *
 * Honors `$DSH_HOME` when a deployment exports it. Note that the stock CLI
 * does *not*: verified against `dsh@0.1.5-rc.2`, `DSH_HOME` is unset even
 * though the harness keeps its own state in `~/.dsh`. So the normal path is
 * the per-project `.dsh-browser-artifacts` fallback, which is the more useful
 * default anyway — a video belongs next to the run that produced it, not in a
 * shared home directory.
 */
/** Directory the artifacts tree and the browser profile both hang off. */
function baseDir(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  return dshHome ? dshHome : path.join(process.cwd(), '.dsh-browser-artifacts')
}

export function defaultArtifactsDir(): string {
  return path.join(baseDir(), 'artifacts', 'browser')
}

/**
 * Where the persistent profile lives when the user does not say.
 *
 * Deliberately *not* inside the artifacts directory: artifacts are per-run
 * evidence a housekeeping script may reasonably delete, whereas the profile is
 * accumulated trust that is expensive to rebuild (and impossible to rebuild
 * when the whole point of the profile is getting past a challenge).
 */
export function defaultProfileDir(): string {
  return path.join(baseDir(), 'profiles', 'chromium')
}

/** Absolute-ise a possibly-relative directory against the current working dir. */
function resolveDir(dir: string): string {
  const expanded = dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir
  return path.resolve(expanded)
}

export function resolveConfig(config: BrowserPluginConfig = {}): ResolvedBrowserConfig {
  const artifactsDir = resolveDir(config.artifactsDir?.trim() || defaultArtifactsDir())
  const persistent = config.persistent === true
  const headless = config.headless !== false
  const explicitViewport = config.viewport?.width !== undefined || config.viewport?.height !== undefined

  return {
    headless,
    timeoutMs: positive(config.timeoutMs, 15_000),
    idleTimeoutMs: nonNegative(config.idleTimeoutMs, 600_000),
    slowMo: nonNegative(config.slowMo, 0),
    viewport: explicitViewport
      ? {
          width: positive(config.viewport?.width, 1280),
          height: positive(config.viewport?.height, 800),
        }
      : persistent
        ? null
        : { width: 1280, height: 800 },
    artifactsDir,
    videosDir: path.join(artifactsDir, 'videos'),
    screenshotsDir: path.join(artifactsDir, 'screenshots'),
    recordVideo: config.recordVideo !== false,
    screenshots: config.screenshots !== false,
    launchArgs: Array.isArray(config.launchArgs) ? [...config.launchArgs] : [],
    persistent,
    userDataDir: resolveDir(config.userDataDir?.trim() || defaultProfileDir()),
    ...(config.channel?.trim() ? { channel: config.channel.trim() } : {}),
    ...(config.locale?.trim() ? { locale: config.locale.trim() } : {}),
    ...(config.timezoneId?.trim() ? { timezoneId: config.timezoneId.trim() } : {}),
    humanInTheLoop: config.humanInTheLoop ?? !headless,
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
