import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Video } from "playwright";
import { RefStore } from "./refs";
import { captureSnapshot } from "./snapshot";

export interface BrowserSessionOptions {
  headless: boolean;
  /** Directory where a `.webm` recording is written. Omit to disable video. */
  videosDir?: string;
  /** Directory where screenshots are written. Omit to disable screenshots. */
  screenshotsDir?: string;
  slowMo?: number;
  viewport?: { width: number; height: number };
  /** Default per-action timeout. */
  timeoutMs?: number;
}

/** Prefix a scheme when the user types `example.com`. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1")) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

/**
 * One DSH-style session == one BrowserContext == one isolated cookie/storage jar.
 *
 * That isolation is what makes two tests unable to leak auth state into each
 * other later on.
 */
export class BrowserSession {
  readonly refs = new RefStore();
  readonly page: Page;
  lastSnapshot = "";

  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly video: Video | null;
  private readonly screenshotsDir?: string;
  private readonly timeoutMs: number;
  private shotCounter = 0;

  private constructor(browser: Browser, context: BrowserContext, page: Page, options: BrowserSessionOptions) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.screenshotsDir = options.screenshotsDir;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.video = page.video();
    this.page.setDefaultTimeout(this.timeoutMs);
  }

  static async create(options: BrowserSessionOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({
      headless: options.headless,
      slowMo: options.slowMo && options.slowMo > 0 ? options.slowMo : undefined,
    });

    if (options.screenshotsDir) await fs.mkdir(options.screenshotsDir, { recursive: true });
    if (options.videosDir) await fs.mkdir(options.videosDir, { recursive: true });

    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 800 },
      recordVideo: options.videosDir
        ? { dir: options.videosDir, size: { width: 1280, height: 720 } }
        : undefined,
    });

    // tsx/esbuild rewrites every function it compiles with a `__name(fn, "x")`
    // helper (keepNames). Playwright serialises functions into the browser, where
    // that helper does not exist, so `page.evaluate()` would fail with
    // "ReferenceError: __name is not defined". Providing a no-op polyfill in the
    // page context keeps evaluate-based code working in dev and in a build.
    await context.addInitScript({ content: "globalThis.__name ||= (fn) => fn;" });

    const page = await context.newPage();
    return new BrowserSession(browser, context, page, options);
  }

  /** Navigate and wait for the page to be interactive. */
  async goto(url: string): Promise<void> {
    await this.page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
  }

  /** Rebuild the snapshot and invalidate every previous ref. */
  async snapshot(): Promise<string> {
    this.lastSnapshot = await captureSnapshot(this.page, this.refs);
    return this.lastSnapshot;
  }

  async title(): Promise<string> {
    return this.page.title().catch(() => "");
  }

  /**
   * Save a numbered screenshot into the session's screenshots directory.
   * Returns the absolute file path.
   */
  async screenshot(label: string, fullPage = false): Promise<string> {
    if (!this.screenshotsDir) {
      throw new Error("Screenshots are not enabled for this session.");
    }
    this.shotCounter += 1;
    const safe = label.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "shot";
    const name = `${String(this.shotCounter).padStart(3, "0")}-${safe}.png`;
    const file = path.join(this.screenshotsDir, name);
    await this.page.screenshot({ path: file, fullPage });
    return file;
  }

  /**
   * Close the context (which flushes the video) and return the recorded video
   * path, if any.
   */
  async close(): Promise<string | undefined> {
    await this.context.close().catch(() => undefined);
    let videoPath: string | undefined;
    if (this.video) {
      // The recording is only flushed to disk once the context is closed.
      videoPath = await this.video.path().catch(() => undefined);
    }
    await this.browser.close().catch(() => undefined);
    return videoPath;
  }
}
