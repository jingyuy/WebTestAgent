import type { Locator, Page } from 'playwright'
import { RefStore } from './refs.js'
import { detectChallenge, type ChallengeInfo } from './challenge.js'

/**
 * Snapshot engine.
 *
 * The single most important component of this plugin: it turns a live DOM into
 * a small, deterministic, model-friendly description of the page, and gives
 * every interactive element a short ref (`e1`, `e2`, ...) that the model can act
 * on without ever inventing a CSS selector.
 *
 * Design rules:
 *   - never send raw HTML to the model
 *   - interactive elements only, plus a compact accessibility outline
 *   - refs are invalidated whenever the page mutates
 *   - an anti-bot challenge is reported as part of the observation, not left
 *     for the model to notice (see `challenge.ts`)
 */

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=\'hidden\'])',
  'select',
  'textarea',
  'summary',
  '[contenteditable=\'\']',
  '[contenteditable=\'true\']',
  '[role=\'button\']',
  '[role=\'link\']',
  '[role=\'checkbox\']',
  '[role=\'radio\']',
  '[role=\'switch\']',
  '[role=\'tab\']',
  '[role=\'menuitem\']',
  '[role=\'option\']',
  '[role=\'textbox\']',
  '[role=\'searchbox\']',
  '[role=\'combobox\']',
  '[role=\'slider\']',
  '[role=\'spinbutton\']',
  '[data-testid]',
].join(',')

/** Roles Playwright's `getByRole` accepts. Anything else falls back to CSS. */
const ROLE_WHITELIST = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
])

/** Roles too generic to identify a unique element by name alone. */
const ROLE_TOO_GENERIC = new Set(['generic', 'none', 'presentation'])

const MAX_ELEMENTS = 150
const MAX_OUTLINE_CHARS = 5_000
const MAX_NAME_CHARS = 90

interface RawElement {
  role: string
  name: string
  tag: string
  type: string | null
  value: string | null
  placeholder: string | null
  checked: boolean | null
  disabled: boolean
  testId: string | null
  cssPath: string
  visible: boolean
  inViewport: boolean
}

/**
 * Runs INSIDE the browser page. Must stay dependency-free and self-contained:
 * Playwright serialises its source across the process boundary.
 *
 * Deliberately does NOT swallow errors locally — a broken collector must not be
 * indistinguishable from "this page has no elements".
 */
const COLLECT_ELEMENTS = (selector: string) => {
  const MAX = 400

  function clean(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim()
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute('aria-label')
    if (clean(aria)) return clean(aria)

    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => clean(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(' ')
      if (parts) return parts
    }

    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const id = el.getAttribute('id')
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (label && clean(label.textContent)) return clean(label.textContent)
      }
      const wrapping = el.closest('label')
      if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent)

      const placeholder = (el as HTMLInputElement).placeholder
      if (clean(placeholder)) return clean(placeholder)

      const input = el as HTMLInputElement
      if ((input.type === 'submit' || input.type === 'button') && clean(input.value)) {
        return clean(input.value)
      }
      const title = el.getAttribute('title')
      if (clean(title)) return clean(title)
      return ''
    }

    if (clean(el.textContent)) return clean(el.textContent).slice(0, 160)

    const title = el.getAttribute('title')
    if (clean(title)) return clean(title)

    const alt = el.querySelector('img[alt]')?.getAttribute('alt')
    if (clean(alt)) return clean(alt)

    return ''
  }

  function roleOf(el: Element): string {
    const explicitRole = el.getAttribute('role')
    if (explicitRole) return explicitRole.split(/\s+/)[0]

    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'summary') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'option') return 'option'
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      return 'textbox'
    }
    return 'generic'
  }

  function cssPath(el: Element): string {
    const ownId = el.getAttribute('id')
    if (ownId && document.querySelectorAll(`#${CSS.escape(ownId)}`).length === 1) {
      return `#${CSS.escape(ownId)}`
    }

    const parts: string[] = []
    let node: Element | null = el
    let depth = 0

    while (node && depth < 10) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html') break

      const id = node.getAttribute('id')
      if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(id)}`)
        break
      }

      const parent: Element | null = node.parentElement
      if (parent) {
        const current = node
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === current.tagName)
        const index = sameTag.indexOf(current) + 1
        parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
      } else {
        parts.unshift(tag)
      }

      node = node.parentElement
      depth += 1
    }

    return parts.join(' > ')
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    return true
  }

  const seen = new Set<Element>()
  const out: RawElement[] = []

  for (const el of Array.from(document.querySelectorAll(selector))) {
    if (seen.has(el) || out.length >= MAX) continue
    seen.add(el)

    const rect = el.getBoundingClientRect()
    const testId =
      el.getAttribute('data-testid') ??
      el.getAttribute('data-test-id') ??
      el.getAttribute('data-cy')

    out.push({
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      type: (el as HTMLInputElement).type ?? null,
      value: (el as HTMLInputElement).value ?? null,
      placeholder: (el as HTMLInputElement).placeholder ?? null,
      checked: typeof (el as HTMLInputElement).checked === 'boolean' ? (el as HTMLInputElement).checked : null,
      disabled: (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
      testId: testId ?? null,
      cssPath: cssPath(el),
      visible: isVisible(el),
      inViewport:
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < (window.innerHeight || 0) &&
        rect.left < (window.innerWidth || 0),
    })
  }

  return out
}

/**
 * Choose a locator strategy for a snapshot element.
 *
 * Priority: explicit test id -> accessible role + name -> placeholder -> CSS
 * path. Role/name is far more resilient than a CSS path across re-renders.
 */
function buildLocator(page: Page, el: RawElement): Locator {
  if (el.testId) {
    const escaped = el.testId.replace(/"/g, '\\"')
    return page
      .locator(`[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-cy="${escaped}"]`)
      .first()
  }

  if (el.role && el.name && ROLE_WHITELIST.has(el.role) && !ROLE_TOO_GENERIC.has(el.role)) {
    try {
      return page.getByRole(el.role as Parameters<Page['getByRole']>[0], { name: el.name, exact: true }).first()
    } catch {
      /* fall through to css */
    }
  }

  if (el.placeholder) {
    return page.getByPlaceholder(el.placeholder).first()
  }

  return page.locator(el.cssPath).first()
}

function formatElement(ref: string, el: RawElement): string {
  const name = el.name.length > MAX_NAME_CHARS ? `${el.name.slice(0, MAX_NAME_CHARS)}…` : el.name
  const attrs: string[] = []

  if (el.testId) attrs.push(`testid=${el.testId}`)
  if (el.type && el.type !== 'text' && el.type !== 'submit') attrs.push(`type=${el.type}`)
  if (el.placeholder && el.placeholder !== el.name) attrs.push(`placeholder="${el.placeholder}"`)
  if (el.checked !== null && el.type === 'checkbox') attrs.push(el.checked ? 'checked' : 'unchecked')
  if (el.checked !== null && el.type === 'radio') attrs.push(el.checked ? 'selected' : 'not-selected')
  if (el.value && ['select', 'option'].includes(el.tag)) attrs.push(`value="${el.value}"`)
  if (el.disabled) attrs.push('disabled')
  if (!el.visible) attrs.push('not-visible')
  else if (!el.inViewport) attrs.push('offscreen')

  const suffix = attrs.length ? ` [${attrs.join(' ')}]` : ''
  return `[${ref}] ${el.role} "${name}"${suffix}`
}

/** Machine-readable result of one snapshot capture. */
export interface SnapshotCapture {
  /** The exact text handed to the model. */
  text: string
  url: string
  title: string
  /** Number of interactive elements exposed this generation. */
  elementCount: number
  /** Monotonic ref generation; every action bumps it. */
  generation: number
  /** True when the collector itself failed (as opposed to finding nothing). */
  collectorFailed: boolean
  /**
   * Anti-bot challenge state at capture time. A `blocking` challenge means the
   * element list below describes the challenge page, not the site under test.
   */
  challenge: ChallengeInfo
}

/**
 * Context a snapshot needs that is not a property of the page.
 */
export interface SnapshotOptions {
  /**
   * Whether a person can actually reach this browser right now.
   *
   * Decides which remedy the challenge banner offers. It is deliberately
   * distinct from {@link ChallengeInfo.humanSolvable}, which says only that a
   * person *could* solve this kind of challenge: recommending
   * `browser_wait_for_human` to an agent whose provider will refuse that call
   * sends it to a dead end, so the two facts have to be combined here.
   *
   * Defaults to `false` — the pessimistic direction. Advising "report the
   * block" to someone who did have a human available merely under-uses a
   * working tool; advising the tool to someone who does not produces a hard
   * error the agent has to reason its way out of.
   */
  humanInTheLoop?: boolean
}

/**
 * Capture a snapshot of `page`, repopulating `refs` with a fresh generation.
 *
 * A collector failure is reported loudly (never silently downgraded to "no
 * elements"), because that would turn "our code is broken" into a believable
 * observation about the page.
 */
export async function captureSnapshot(
  page: Page,
  refs: RefStore,
  options: SnapshotOptions = {},
): Promise<SnapshotCapture> {
  const url = page.url()
  const title = await page.title().catch(() => '')

  // Any snapshot invalidates the previous refs.
  refs.clear()

  let raw: RawElement[] = []
  let collectorFailed = false
  let collectorError = ''
  try {
    raw = await page.evaluate<RawElement[], string>(COLLECT_ELEMENTS, INTERACTIVE_SELECTOR)
  } catch (error) {
    collectorFailed = true
    collectorError = error instanceof Error ? error.message : String(error)
  }

  const ranked = [...raw].sort((a, b) => Number(b.visible) - Number(a.visible))
  const chosen = ranked.slice(0, MAX_ELEMENTS)

  const lines: string[] = []
  for (const el of chosen) {
    const ref = refs.allocate()
    refs.set({
      ref,
      role: el.role,
      name: el.name,
      tag: el.tag,
      cssPath: el.cssPath,
      ...(el.testId ? { testId: el.testId } : {}),
      ...(el.placeholder ? { placeholder: el.placeholder } : {}),
      locator: buildLocator(page, el),
    })
    lines.push(formatElement(ref, el))
  }

  const challenge = await detectChallenge(page)
  const outline = collectorFailed ? '' : await pageOutline(page)

  const header = [
    `URL: ${url}`,
    `TITLE: ${title || '(none)'}`,
    `REFS: generation ${refs.generation}, ${chosen.length} interactive element(s)`,
  ].join('\n')

  const interactive = collectorFailed
    ? `INTERACTIVE ELEMENTS\n(COLLECTOR FAILED — the element list below is UNRELIABLE)\n${collectorError}`
    : lines.length
      ? `INTERACTIVE ELEMENTS\n${lines.join('\n')}`
      : 'INTERACTIVE ELEMENTS\n(none found — the page may still be loading, or the content is inside an iframe)'

  const parts = [header]
  const banner = challengeBanner(challenge, options.humanInTheLoop === true)
  if (banner) parts.push('', banner)
  parts.push('', interactive)
  if (outline) parts.push('', 'PAGE OUTLINE', outline)

  return {
    text: parts.join('\n'),
    url,
    title,
    elementCount: chosen.length,
    generation: refs.generation,
    collectorFailed,
    challenge,
  }
}

/**
 * The challenge warning that precedes every observation.
 *
 * It leads the snapshot because the rest of the snapshot is worthless while it
 * applies, and an agent that skims has to run into it before the element list.
 * Returns `null` when there is nothing to say, so a normal page stays quiet.
 *
 * `humanInTheLoop` gates the remedy, so this never points the agent at
 * `browser_wait_for_human` when that tool is going to refuse the call.
 */
function challengeBanner(challenge: ChallengeInfo, humanInTheLoop: boolean): string | null {
  const evidence = challenge.evidence.length ? `\n  Evidence: ${challenge.evidence.join('; ')}` : ''

  if (!challenge.scanned) {
    return (
      'CHALLENGE SCAN UNAVAILABLE\n' +
      '  The page could not be read, so an anti-bot challenge CANNOT be ruled out.' +
      evidence
    )
  }

  if (!challenge.detected) return null

  if (challenge.blocking) {
    const remedy = challenge.humanSolvable
      ? humanInTheLoop
        ? 'A person can clear it: call browser_wait_for_human, and continue once it returns.'
        : 'Nobody can clear this here: the browser is headless with the human loop off, so\n' +
          '  browser_wait_for_human will refuse rather than park the run. Report the run as blocked\n' +
          '  by a human-verification challenge; do not keep probing the page for a way through.'
      : 'This kind usually clears by itself: wait it out with browser_wait, then re-read the page.'
    return (
      `CHALLENGE DETECTED — ${challenge.summary}\n` +
      '  This is NOT the page under test. Everything below describes the challenge, not the site,\n' +
      '  and clicking through it does not reveal the real page. Do not report PASS from here.\n' +
      `  ${remedy}` +
      evidence
    )
  }

  return (
    `CAPTCHA WIDGET — ${challenge.summary}\n` +
    '  The page itself is real; this widget sits inside it and may guard the form that uses it.' +
    evidence
  )
}

/** Compact accessibility outline, used as context (not as an action target). */
async function pageOutline(page: Page): Promise<string> {
  const body = page.locator('body')

  try {
    const yaml = await Promise.race([
      body.ariaSnapshot({ timeout: 3_000 }),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 4_000)),
    ])
    if (yaml && yaml.trim()) {
      return yaml.length > MAX_OUTLINE_CHARS ? `${yaml.slice(0, MAX_OUTLINE_CHARS)}\n…(truncated)` : yaml
    }
  } catch {
    /* fall through to innerText */
  }

  const text = await body.innerText().catch(() => '')
  const clean = text.replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return ''
  return clean.length > MAX_OUTLINE_CHARS ? `${clean.slice(0, MAX_OUTLINE_CHARS)}\n…(truncated)` : clean
}
