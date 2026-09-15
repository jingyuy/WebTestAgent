import type { Page } from 'playwright'

/**
 * Challenge detection.
 *
 * Anti-bot interstitials are the one page an agent must never mistake for
 * content under test. A CAPTCHA page is usually a perfectly ordinary document:
 * it has a title, a heading, and a submit button, so an agent will happily
 * click through it and then assert against whatever it landed on — producing a
 * confident, wrong verdict.
 *
 * So detection is not an extra; it is part of observation. Every snapshot runs
 * it, and {@link ChallengeInfo.blocking} propagates into `browser_assert` so a
 * challenge can never turn into an `ASSERTION PASSED`.
 *
 * Two kinds of match are distinguished, because they need different handling:
 *
 *   - **blocking** — the document as a whole is an interstitial (`/sorry/index`,
 *     "Checking your browser", "Verify you are human"). The page is not the
 *     content, nothing under it is trustworthy, and there is nothing to click.
 *     This is what `browser_wait_for_human` waits out.
 *   - a **widget only** — a reCAPTCHA/hCaptcha box embedded *inside* a page that
 *     is otherwise usable (a signup form, often). `detected` is true so the
 *     agent is told, but it is not blocking: the surrounding page is real, and
 *     a test that only touches that page elsewhere should not be derailed.
 */

export type ChallengeVendor =
  | 'recaptcha'
  | 'hcaptcha'
  | 'turnstile'
  | 'cloudflare'
  | 'google-sorry'
  | 'arkose'
  | 'perimeterx'
  | 'akamai'
  | 'amazon'
  | 'generic'

const VENDOR_LABEL: Record<ChallengeVendor, string> = {
  recaptcha: 'Google reCAPTCHA',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  cloudflare: 'Cloudflare bot check',
  'google-sorry': 'Google anti-abuse interstitial',
  arkose: 'Arkose / FunCaptcha',
  perimeterx: 'PerimeterX / HUMAN',
  akamai: 'Akamai Bot Manager',
  amazon: 'Amazon robot check',
  generic: 'human-verification challenge',
}

/** What a challenge scan found. */
export interface ChallengeInfo {
  /** A challenge marker of any kind is present. */
  detected: boolean;
  /**
   * The page *is* the challenge, rather than a page that merely embeds one.
   * Only a blocking challenge is allowed to veto an assertion.
   */
  blocking: boolean;
  /**
   * Whether the scan actually ran. `false` means the detector could not read
   * the page (usually a navigation in flight), which is *not* the same as
   * "clean" — callers that care must not read it that way.
   */
  scanned: boolean;
  /** Best guess at who is asking. `null` when `detected` is false. */
  vendor: ChallengeVendor | null;
  /** One-line description, safe to show the model, e.g. `Google reCAPTCHA`. */
  summary: string;
  /** Exactly what matched, so the verdict is auditable rather than asserted. */
  evidence: string[];
  /**
   * Whether a person could plausibly clear this by hand.
   *
   * `false` for self-clearing interstitials (Cloudflare's "Just a moment…"),
   * where waiting is the right move and a human would be a distraction.
   */
  humanSolvable: boolean;
}

/** The "nothing here" answer, also used when a scan is skipped or fails. */
export function noChallenge(scanned = true, evidence: string[] = []): ChallengeInfo {
  return {
    detected: false,
    blocking: false,
    scanned,
    vendor: null,
    summary: scanned ? 'no challenge detected' : 'challenge scan unavailable',
    evidence,
    humanSolvable: false,
  }
}

// ------------------------------------------------------------------- signals

/** Selectors whose mere presence means a vendor's widget is on the page. */
const WIDGET_SELECTORS: ReadonlyArray<{ selector: string; vendor: ChallengeVendor }> = [
  { selector: 'iframe[src*="recaptcha"]', vendor: 'recaptcha' },
  { selector: '.g-recaptcha', vendor: 'recaptcha' },
  { selector: 'iframe[src*="hcaptcha"]', vendor: 'hcaptcha' },
  { selector: '.h-captcha', vendor: 'hcaptcha' },
  { selector: 'iframe[src*="challenges.cloudflare.com"]', vendor: 'turnstile' },
  { selector: 'iframe[src*="arkoselabs"]', vendor: 'arkose' },
  // Cloudflare's interstitial, not the Turnstile widget.
  { selector: '#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running', vendor: 'cloudflare' },
  // Google's `/sorry/` form.
  { selector: '#captcha-form, #gs_captcha_f, form[action*="sorry"]', vendor: 'google-sorry' },
  { selector: '#px-captcha, #px-overlay', vendor: 'perimeterx' },
  { selector: '#sec-overlay, #sec-container, #sec-overlay-container', vendor: 'akamai' },
  { selector: '#amzn-captcha-form, form[action*="validateCaptcha"]', vendor: 'amazon' },
]

/**
 * URL rules. Deliberately restricted to landmarks used by the vendors
 * themselves, so a test of one's *own* `/captcha-demo` route is not mistaken
 * for an interstitial.
 */
const URL_RULES: ReadonlyArray<{ pattern: RegExp; vendor: ChallengeVendor }> = [
  { pattern: /\/sorry\/(index|v2)?/i, vendor: 'google-sorry' },
  { pattern: /\/cdn-cgi\/challenge-platform/i, vendor: 'cloudflare' },
  { pattern: /\/errors\/validateCaptcha/i, vendor: 'amazon' },
]

const TITLE_RULES: ReadonlyArray<{ pattern: RegExp; vendor: ChallengeVendor }> = [
  { pattern: /just a moment/i, vendor: 'cloudflare' },
  { pattern: /attention required/i, vendor: 'cloudflare' },
  { pattern: /checking your browser/i, vendor: 'cloudflare' },
  { pattern: /access to this page has been denied/i, vendor: 'perimeterx' },
  { pattern: /robot check/i, vendor: 'amazon' },
  { pattern: /verify you are human|verify you are a human|are you a robot/i, vendor: 'generic' },
  { pattern: /security check/i, vendor: 'generic' },
]

/**
 * Body-text phrases.
 *
 * Phrased as the person would read them, not as bare words like "captcha":
 * a page under test can legitimately contain the word, and a detector that
 * cries wolf is worse than none, because the agent learns to ignore it.
 */
const TEXT_RULES: ReadonlyArray<{ pattern: RegExp; vendor: ChallengeVendor }> = [
  { pattern: /unusual traffic/i, vendor: 'google-sorry' },
  { pattern: /automated queries/i, vendor: 'google-sorry' },
  { pattern: /checking your browser/i, vendor: 'cloudflare' },
  { pattern: /enable javascript and cookies to continue/i, vendor: 'cloudflare' },
  { pattern: /needs to review the security of your connection/i, vendor: 'cloudflare' },
  { pattern: /press and hold/i, vendor: 'perimeterx' },
  { pattern: /type the characters you see/i, vendor: 'amazon' },
  { pattern: /we just need to make sure/i, vendor: 'amazon' },
  { pattern: /i'?m not a robot|i am not a robot/i, vendor: 'generic' },
  { pattern: /verify you are (a )?human|prove you are (a )?human/i, vendor: 'generic' },
  { pattern: /confirm you are (a )?human|are you a robot/i, vendor: 'generic' },
  { pattern: /complete the security check/i, vendor: 'generic' },
  { pattern: /please verify you are a human/i, vendor: 'generic' },
]

// ------------------------------------------------------------------- scanner

/** Signals read out of the page in one round trip. */
interface RawSignals {
  url: string
  title: string
  text: string
  widgets: string[]
}

/**
 * Runs INSIDE the page. Self-contained and dependency-free: Playwright
 * serialises its source across the process boundary.
 *
 * Note it uses no named function declarations, so it does not even need the
 * `__name` polyfill — but the polyfill is installed for the snapshot collector
 * anyway, and a detector that works for the wrong reason is a trap.
 */
const READ_SIGNALS = (probes: string[]) => {
  const text = (document.body ? document.body.innerText : '') || ''
  const widgets: string[] = []
  for (const selector of probes) {
    try {
      if (document.querySelector(selector)) widgets.push(selector)
    } catch {
      /* an invalid selector must never break the scan */
    }
  }
  return {
    url: location.href,
    title: document.title || '',
    text: text.replace(/\s+/g, ' ').trim().slice(0, 20_000),
    widgets,
  }
}

/** Turn raw signals into a verdict. Pure, so it can be tested without a browser. */
export function classifyChallenge(raw: RawSignals): ChallengeInfo {
  const evidence: string[] = []
  const votes: ChallengeVendor[] = []

  for (const rule of URL_RULES) {
    if (rule.pattern.test(raw.url)) {
      evidence.push(`url matches ${rule.pattern}`)
      votes.push(rule.vendor)
    }
  }
  for (const rule of TITLE_RULES) {
    if (rule.pattern.test(raw.title)) {
      evidence.push(`title matches ${rule.pattern}`)
      votes.push(rule.vendor)
    }
  }
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(raw.text)) {
      evidence.push(`page text matches ${rule.pattern}`)
      votes.push(rule.vendor)
    }
  }

  const blocking = votes.length > 0

  const widgetVotes: ChallengeVendor[] = []
  for (const probe of WIDGET_SELECTORS) {
    if (raw.widgets.includes(probe.selector)) {
      evidence.push(`present: ${probe.selector}`)
      widgetVotes.push(probe.vendor)
    }
  }

  if (!blocking && widgetVotes.length === 0) return noChallenge(true, [])

  // An interstitial vote outranks a widget vote: if the page itself is the
  // challenge, who supplied the widget is the more specific answer.
  const vendor = votes[0] ?? widgetVotes[0] ?? 'generic'
  const label = VENDOR_LABEL[vendor]
  const summary = blocking
    ? `${label} is blocking the page (the document is an interstitial, not the content under test)`
    : `${label} widget embedded in the page (the surrounding page is real)`

  // A Cloudflare "Just a moment…" interstitial resolves itself; a person adds
  // nothing. Anything showing an actual puzzle is a different story.
  const selfClearing = blocking && vendor === 'cloudflare' && widgetVotes.length === 0

  return {
    detected: true,
    blocking,
    scanned: true,
    vendor,
    summary,
    evidence,
    humanSolvable: !selfClearing,
  }
}

/**
 * Look for an anti-bot challenge on `page`.
 *
 * Read-only and cheap enough to run on every snapshot.
 */
export async function detectChallenge(page: Page): Promise<ChallengeInfo> {
  const probes = WIDGET_SELECTORS.map((probe) => probe.selector)
  let raw: RawSignals
  try {
    raw = await page.evaluate<RawSignals, string[]>(READ_SIGNALS, probes)
  } catch (error) {
    // Not "no challenge": we could not look. Say so rather than imply clean.
    const detail = error instanceof Error ? error.message : String(error)
    return noChallenge(false, [`challenge scan failed: ${detail}`])
  }
  return classifyChallenge(raw)
}
