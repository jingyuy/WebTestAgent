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
  viewport?: { width?: number; height?: number }
  /** Base directory for videos and screenshots. */
  artifactsDir?: string
  /** Record a `.webm` per session. Default `true`. */
  recordVideo?: boolean
  /** Allow `browser_screenshot`. Default `true`. */
  screenshots?: boolean
  /** Extra chromium launch args, appended to the defaults. */
  launchArgs?: string[]
}

export interface ResolvedBrowserConfig {
  headless: boolean
  timeoutMs: number
  idleTimeoutMs: number
  slowMo: number
  viewport: { width: number; height: number }
  artifactsDir: string
  videosDir: string
  screenshotsDir: string
  recordVideo: boolean
  screenshots: boolean
  launchArgs: string[]
}

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
export function defaultArtifactsDir(): string {
  const dshHome = process.env.DSH_HOME?.trim()
  const base = dshHome ? dshHome : path.join(process.cwd(), '.dsh-browser-artifacts')
  return path.join(base, 'artifacts', 'browser')
}

/** Absolute-ise a possibly-relative directory against the current working dir. */
function resolveDir(dir: string): string {
  const expanded = dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir
  return path.resolve(expanded)
}

export function resolveConfig(config: BrowserPluginConfig = {}): ResolvedBrowserConfig {
  const artifactsDir = resolveDir(config.artifactsDir?.trim() || defaultArtifactsDir())

  return {
    headless: config.headless !== false,
    timeoutMs: positive(config.timeoutMs, 15_000),
    idleTimeoutMs: nonNegative(config.idleTimeoutMs, 600_000),
    slowMo: nonNegative(config.slowMo, 0),
    viewport: {
      width: positive(config.viewport?.width, 1280),
      height: positive(config.viewport?.height, 800),
    },
    artifactsDir,
    videosDir: path.join(artifactsDir, 'videos'),
    screenshotsDir: path.join(artifactsDir, 'screenshots'),
    recordVideo: config.recordVideo !== false,
    screenshots: config.screenshots !== false,
    launchArgs: Array.isArray(config.launchArgs) ? [...config.launchArgs] : [],
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
