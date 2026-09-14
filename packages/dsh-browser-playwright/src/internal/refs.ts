import type { Locator } from 'playwright'

/**
 * A single element reference handed to the model, e.g. `e3`.
 *
 * The ref is intentionally NOT a CSS selector: it is an opaque handle that is
 * only valid for the snapshot generation it was created in.
 */
export interface RefEntry {
  ref: string
  role: string
  name: string
  tag: string
  cssPath: string
  testId?: string
  placeholder?: string
  locator: Locator
}

/**
 * Maps short, model-friendly refs (`e1`, `e2`, ...) onto live Playwright
 * locators.
 *
 * Refs are scoped to a *generation*. Any page mutation clears the store and
 * bumps the generation, which is what guarantees the model can never act on a
 * stale element. See `snapshot.ts`.
 */
export class RefStore {
  private readonly entries = new Map<string, RefEntry>()
  private counter = 0
  private gen = 0

  get generation(): number {
    return this.gen
  }

  get size(): number {
    return this.entries.size
  }

  /** Allocate the next ref name WITHOUT registering it. */
  allocate(): string {
    this.counter += 1
    return `e${this.counter}`
  }

  set(entry: RefEntry): void {
    this.entries.set(entry.ref, entry)
  }

  get(ref: string): RefEntry | undefined {
    return this.entries.get(ref)
  }

  /** All refs in the current generation, in snapshot order. */
  all(): RefEntry[] {
    return [...this.entries.values()]
  }

  has(ref: string): boolean {
    return this.entries.has(ref)
  }

  /**
   * Resolve a ref, or throw a model-readable error explaining how to recover.
   */
  require(ref: string): RefEntry {
    const entry = this.entries.get(ref)
    if (!entry) {
      const known = this.entries.size
        ? `Valid refs right now: ${[...this.entries.keys()].join(', ')}.`
        : 'There is no snapshot yet.'
      throw new Error(
        `Unknown element reference "${ref}". ${known} ` +
          'Refs are invalidated after every page change — call browser_snapshot to get fresh refs.',
      )
    }
    return entry
  }

  /** Invalidate every ref and start a new generation. */
  clear(): void {
    this.entries.clear()
    this.counter = 0
    this.gen += 1
  }
}
