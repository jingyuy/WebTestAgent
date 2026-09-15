# @webtestagent/dsh-browser-playwright

A Playwright browser capability for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh).
It gives a DSH agent ten tools for driving a real Chromium: navigate, observe the
accessibility tree, interact by stable element ref, *prove* an outcome with a
structured assertion, and — when a site puts up an anti-bot challenge — hand the
browser to a person instead of guessing.

The harness owns the agent loop, session store, LLM transport, tool registry and
Web UI. This package contributes only the browser, so every conversation in the
installed profile gains the capability with no other machinery to maintain.

## Install

```bash
npx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add @webtestagent/dsh-browser-playwright
```

`plugin add` appends the package to the profile's `dsh.profile.bundles`. The
loader then reads this package's `cordis.patch.yml` as one more patch layer,
which inserts the single `browser-playwright` row. Confirm it landed:

```bash
npx @deepseek-ai/dsh@0.1.5-rc.2 --profile web --dump-config
# expect:  - id: browser-playwright
#            name: '@webtestagent/dsh-browser-playwright'
```

Chromium must be present once per machine:

```bash
npx playwright install chromium
```

### Rebuilding into a profile

```bash
npm run install:plugin              # headless + web profiles
npm run install:plugin -- headless  # just one
```

`scripts/install-dsh-plugin.mjs` builds, packs, and reinstalls into each profile,
then greps a known string out of the *installed* `lib/` to confirm the new code
actually landed. That verification matters: pnpm keys its store by the dependency
path, so a stale tarball at the same filename silently reinstalls the old code.
The script deletes the previous `.tgz` before repacking, which is enough — no
version bump required. It always trusts the exit code far less than the artifact.

Prefer the tarball over `dsh plugin add <directory>`. A directory install creates a
`link:` dependency, and Node resolves symlinked packages to their real path, so the
plugin's `@deepseek-ai/cordis` import would resolve to your checkout's copy while
the profile loads the harness's — two module instances of the framework. It happens
to work today, but it is a hazard worth avoiding.

## The ten tools

Every tool that returns to the agent ends with a fresh snapshot, so the agent
never acts on stale element refs.

| Tool | Purpose |
| --- | --- |
| `browser_open` | Navigate and return the page snapshot. |
| `browser_snapshot` | Re-read the page. This is what mints new refs. |
| `browser_wait` | Wait for an element, text, URL or title to reach a state. |
| `browser_wait_for_human` | Hand the browser to a person and block until an anti-bot challenge is cleared. |
| `browser_screenshot` | Save a PNG and return its path. |
| `browser_click` | Click by ref or selector. |
| `browser_fill` | Replace an input's value. |
| `browser_press` | Press a key, globally or on one element. |
| `browser_select` | Choose an `<option>` by value or label. |
| `browser_assert` | Evaluate conditions and return a verdict. |

### Element refs, not selectors

`browser_snapshot` numbers the **interactive** elements it finds — `[e4] textbox
"Email"` — and `browser_*` tools take those refs. Refs remove the most common
browser-automation failure: a selector that silently matches the wrong node.

Refs are invalidated by a fresh snapshot, not by each action. Clearing them on
every click would force a snapshot between every field of a form, so a ref stays
valid until the next snapshot replaces it. Using an unknown ref is a hard error
with a recovery hint listing the refs that do exist — that is a caller bug, not
a page fact, so it must not be reportable as a test failure.

Because the snapshot only numbers interactive elements, a heading or a
paragraph has no ref. `browser_assert` accepts a CSS `selector` for exactly that
case. A selector matches in document order, so on a page that keeps a hidden copy
of an earlier view a bare `h1` can match the hidden one — scope it
(`h1:has-text("Projects")`) or check `state` first.

### `browser_assert` does not throw on failure

A failed assertion is a **successful observation**. If a mismatched condition
threw, the agent could not tell "the page is wrong" apart from "the tool broke",
and would have no reason to report a failure rather than retry.

So `browser_assert` returns a verdict, and the model-facing text begins with the
literal `ASSERTION PASSED` or `ASSERTION FAILED`:

```
ASSERTION FAILED
PASS - URL contains "/done" (actual: http://127.0.0.1:4123/done)
FAIL - Element `h1` text does NOT contain "Projects" (actual: "Sign in to Acme")
```

It throws only for caller mistakes: no conditions supplied, an unknown ref, or
`ref` and `selector` together.

The canonical value is structured, so a host or UI can read the verdict without
parsing prose:

```ts
{
  verdict: 'ASSERTION PASSED' | 'ASSERTION FAILED'
  passed: boolean
  conditions: string[]      // one "PASS - …" / "FAIL - …" line each
  failedCount: number
  url: string
  title: string
  snapshot: string
}
```

`presentationMeta` exposes `{ verdict, passed, failedCount }`.

## Anti-bot challenges

A CAPTCHA page is an ordinary document: a title, a heading, a submit button. An
agent that has been told to test a site will click through it, land somewhere
unexpected, and assert against whatever it finds — producing a confident, wrong
verdict. Detection therefore is not a separate check the agent has to remember;
it is part of observation, and it lands in every snapshot:

```
URL: https://www.google.com/sorry/index?continue=…
TITLE: Sorry...
REFS: generation 3, 2 interactive element(s)

CHALLENGE DETECTED — Google anti-abuse interstitial is blocking the page (the document is an interstitial, not the content under test)
  This is NOT the page under test. Everything below describes the challenge, not the site,
  and clicking through it does not reveal the real page. Do not report PASS from here.
  A person can clear it: call browser_wait_for_human, and continue once it returns.
  Evidence: url matches /\/sorry\/(index|v2)?/i; page text matches /unusual traffic/i
```

Two kinds of match are distinguished, because they need different handling:

- **blocking** — the document *is* the interstitial (`/sorry/index`, Cloudflare's
  `/cdn-cgi/challenge-platform`, "Verify you are human"). The page is not the
  content, and `browser_assert` refuses to return `ASSERTION PASSED` while one is
  on screen, whatever the conditions said. This is what `browser_wait_for_human`
  waits out.
- **widget only** — a reCAPTCHA box embedded in a page that is otherwise real (a
  signup form, often). `detected` is true so the agent is told, but it does not
  veto an assertion: the surrounding page is genuine, and a test that only
  touches that page elsewhere should not be derailed.

Phrases are matched as a person would read them ("unusual traffic", "checking
your browser"), never as bare words like *captcha* — a page under test can
legitimately contain the word, and a detector that cries wolf is worse than none,
because the agent learns to ignore it. The full signal set is in
`src/internal/challenge.ts`; `classifyChallenge()` is pure, so it is testable
without a browser.

The remedy in the banner depends on one thing the challenge itself cannot tell
you: whether a person can actually reach the browser. A challenge a human *could*
solve, met by a headless provider with the human loop off, is reported as a block
to report — not as an invitation to call `browser_wait_for_human`, which would
refuse. `humanSolvable` describes the challenge; the banner combines it with
`humanInTheLoop` before advising. Advising the tool anyway would contradict the
refusal it produces, and leave the agent to reconcile two messages on its own.

### `browser_wait_for_human`

```ts
// README excerpt — the tool's real description is longer.
browser_wait_for_human({ timeoutMs: 300000 })
```

The agent cannot clear a challenge, so it does not try: it parks the run while a
person solves it in the visible window, then re-checks with the *same* detector
the snapshot uses, so "cleared" means exactly what the next snapshot will report.
There is no second definition of done that could disagree with what the agent
sees next.

Three deliberate choices:

- **It refuses to run when nobody can see the browser.** A headless wait is a
  five-minute dead end that teaches the agent nothing, so `humanInTheLoop`
  defaults to `!headless` and the tool throws — naming both ways out — instead of
  blocking. Set `humanInTheLoop: true` explicitly when a human can reach a
  headless browser out of band (a remote viewer, a CDP session). The snapshot
  knows this setting and will not send the agent here in the first place.
- **A timeout is an observation, not an exception.** "The challenge is still
  there" comes back with the evidence attached, like a failed assertion. Throwing
  would deny the agent the fact it most needs.
- **It cannot be used as a general wait.** Calling it with no challenge returns
  immediately and says so, so a misreading of the previous snapshot costs one
  step instead of a timeout.

The wait loop re-touches the session on every poll, so the idle sweep cannot reap
a session out from under the person who is looking at it.

## Configuration

Set under the row's `config:`. All keys are optional.

> **Restate the whole object when overriding from a later patch layer.** A patch
> that matches a row assigns each key it mentions, so `config:` **replaces** the
> row's config wholesale rather than merging into it. Overriding only
> `persistent: true` from a `--patch` file silently drops `headless`,
> `timeoutMs`, `recordVideo` and the rest back to the plugin's own defaults —
> verified with `--dump-config`. The plugin's defaults happen to be sensible, so
> nothing breaks; the values the row *looked* like it had just stop applying.

| Key | Default | Meaning |
| --- | --- | --- |
| `headless` | `true` | Hide the Chromium window. |
| `timeoutMs` | `15000` | Per-action timeout. |
| `idleTimeoutMs` | `600000` | Drop a session after this long idle. `0` disables the sweep. Artifacts are kept either way. |
| `slowMo` | `0` | Delay each Playwright action, for watching a run. |
| `viewport` | `1280x800` | `{ width, height }`. With `persistent`, unset means the *real window size*. |
| `artifactsDir` | see below | Where screenshots and videos go. `~` is expanded. |
| `recordVideo` | `true` | Record a `.webm` per session; the path is returned on close. |
| `screenshots` | `true` | Permit `browser_screenshot` to write PNGs. |
| `launchArgs` | `[]` | Extra Chromium arguments. |
| `persistent` | `false` | Drive a real on-disk profile instead of a throwaway one. See below. |
| `userDataDir` | `<base>/profiles/chromium` | Profile directory. Only used with `persistent`. |
| `channel` | bundled Chromium | e.g. `chrome`, to drive an installed Google Chrome. |
| `locale` | the browser's | Fixed context locale, e.g. `en-GB`. |
| `timezoneId` | the host's | Fixed IANA time zone, e.g. `Europe/London`. |
| `humanInTheLoop` | `!headless` | Allow `browser_wait_for_human` to pause the run for a person. |

The default artifacts directory is `$DSH_HOME/artifacts/browser` when a
deployment exports `DSH_HOME`, otherwise `<cwd>/.dsh-browser-artifacts/artifacts/browser`.
Note that the stock CLI does **not** export `DSH_HOME` (verified on
`0.1.5-rc.2`), so the per-project path is the normal case — which is the more
useful default anyway: a video belongs next to the run that produced it.

### Sessions

By default one `BrowserContext` per DSH session, keyed by `agent.id`, over a
single shared Chromium process, so concurrent conversations cannot leak cookies
into each other. Each context is serialized through its own queue. Contexts idle
past `idleTimeoutMs` are closed; the browser process is untouched.

### The persistent profile

`persistent: true` swaps that for a real on-disk profile, driven through
`launchPersistentContext`. Cookies, `localStorage`, service workers and installed
extensions accumulate in `userDataDir` and survive the process, so a site sees a
returning person rather than a fresh machine. Every session gets its own **tab**
in the one context.

The trade-offs are real and worth stating: sessions no longer get isolated cookie
jars (a login in one conversation is visible to the next — that *is* the point),
and closing a session closes its tab rather than the profile. Two other defaults
flip, both for realism: the viewport becomes the real window size instead of a
fixed `1280x800`, and `--enable-automation` is dropped from Chromium's arguments
while `--disable-blink-features=AutomationControlled` is added. The profile lives
outside the artifacts tree, because artifacts are evidence a housekeeping script
may delete and the profile is accumulated trust that cannot be rebuilt.

```yaml
- id: browser-playwright
  name: '@webtestagent/dsh-browser-playwright'
  config:
    persistent: true
    headless: false          # a real window, which is what a person needs
    channel: chrome          # the identity a person actually browses with
```

## Architecture

Three roles, because a capability, its provider, and its tools have different
lifecycles and different consumers:

| Module | Role |
| --- | --- |
| `/service` | `BrowserService`, the abstract capability, declared on `ctx.browser`. It is a contract, not a plugin — cordis can only instantiate modules that export a plugin. |
| `/playwright` | `PlaywrightBrowser`, the default provider. Mount a different subclass to swap the engine. |
| `/tool` | The ten `ToolDefinition`s, plus `registerBrowserTools`. |
| `/` | The bundle: mounts the provider, then registers the tools. |

### Two cordis details this package depends on

Both were found the hard way, and both fail **silently** if you get them wrong.

1. **A tool half that reads a service must be its own fiber.** Cordis throws
   `cannot get property "browser" without inject` when you read an uninjected
   service — it does not return `undefined`. `apply()` mounts the provider and
   therefore cannot declare `inject: ['browser']` for a service it provides
   itself; that would deadlock. So the tools live in a sibling plugin that
   injects `['tools', 'browser']`:

   ```ts
   const browserTools: Plugin.Object = {
     name: 'browser-tools',
     inject: ['tools', 'browser'],
     apply(ctx) {
       ctx.effect(() => registerBrowserTools(ctx))
     },
   }
   ```

2. **An ES module namespace is not a valid plugin.** Cordis accepts a function,
   a class, or an object with an `apply` method; `isApplicable` checks
   `typeof object.apply === 'function'`. Passing `import * as mod` is accepted
   without complaint and does *nothing* — no throw, no tools. The default export
   must therefore be a real plugin object.

### Mounting by hand

To use the tools against a browser provider you already run, skip the bundle:

```ts
import { PlaywrightBrowser } from '@webtestagent/dsh-browser-playwright/playwright'
import { registerBrowserTools } from '@webtestagent/dsh-browser-playwright/tool'

export const inject = ['tools']
export function apply(ctx: Context, config = {}) {
  ctx.plugin(PlaywrightBrowser, config)
  ctx.effect(() => registerBrowserTools(ctx))
}
```

Await the plugin calls when load order matters: the returned fiber is
`PromiseLike`, and awaiting it is what makes registration deterministic.

## Driving the web UI

The `web` profile needs an extra overlay before the browser can drive it, because
its `directory-picker` row is `@deepseek-ai/dsh-host-directory-picker-auto`, which
resolves to a **native operating-system folder dialog**. A native dialog is outside
the page, so automation can neither see nor dismiss it, and the UI refuses to accept
a prompt until a workspace exists.

```bash
npx @deepseek-ai/dsh@0.1.5-rc.2 --profile web \
  --patch ./dsh/web-browse-picker.patch.yml --no-open --port 3099
```

That overlay disables the `auto` row and inserts **two** new ones:

```yaml
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-ui-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

The second row is easy to miss and its absence is invisible: `-auto` has no client
half, and a default `web` profile loads no `dsh-client-ui-directory-picker-*` client
at all. Swap only the host row and the client half is never served, so "Choose
workspace" toggles its `aria-expanded` and renders nothing — no console error, no
failed request, nothing to debug.

### Cordis patch semantics this depends on

Read from `dsh-app-boot`'s `applyEntryPatches`, which is shared by mounting and by
`--dump-config`, so a dump can never drift from what boots. A patch that matches
nothing warns and is skipped. Layer order is: bundle layers → the profile's own
`cordis.patch.yml` → `--patch` overlays.

```js
const { id, insert, name, ...overrides } = patch
```

- **`name` is a guard, not a setter.** A non-insert patch whose `name` does not equal
the target row's name is skipped with a warning. It asserts you are patching the row
you think you are. **A row cannot be re-pointed at a different module** — which is
why the overlay above inserts rather than reassigns.
- `overrides` are assigned **key by key** (`target[key] = value`), so a `config:` key
replaces the row's *entire* config object. Every key the row owns must be restated.
- `insert` with an `id` requires the target to be a group; without an `id` it appends
to the top level. Inserted rows are indexed, so a later patch in the same list can
target one.
- `entry.disabled` is honoured by the loader, so `disabled: true` is how a row is
turned off.

`--dump-config` annotates provenance, which is the fastest way to confirm an overlay
applied:

```
# == @deepseek-ai/dsh-web-app, patched by ./dsh/web-browse-picker.patch.yml
- id: directory-picker
  disabled: true
```

With the overlay applied, the picker renders in-page: a breadcrumb, a directory
list, *New folder*, *Show hidden files*, and *Open*. A real agent run through the UI
is then the same code path as any other DSH session.

## Tests

```bash
npm run test:e2e
```

An offline, self-contained harness. It serves its own fixture pages on an
ephemeral port, composes a real cordis context with the real `ToolRuntime`, and
runs 70 checks covering registration, snapshots, refs, every assertion outcome,
the selector escape hatch, navigation, screenshots and video. No network and no
LLM.

It then goes past the isolated default, because the newer features cannot be
tested where they do not apply:

- a set of pure `classifyChallenge()` cases, hand-built from the signal shape a
  page produces — a Cloudflare interstitial, a real page that merely embeds a
  reCAPTCHA widget, and a real page that only mentions the word *captcha*;
- a **persistent, visible** context booted against a temp profile, which loads a
  fixture interstitial, checks that `browser_assert` refuses to pass off it,
  hands the browser to a "person" (the fixture solving itself on a timer), and
  confirms the run continues on the real page afterwards;
- a restart with the same profile directory, which is the only way to prove the
  profile outlived the process rather than just the session.

The last two phases need a visible Chromium window, so they open one. If the
environment cannot (a headless CI box), the harness prints `SKIP` for that phase
and still exits non-zero only for real failures.

### Watching the human-in-the-loop path by hand

```bash
npm run manual:challenge                          # a local stand-in challenge
npm run manual:challenge -- https://your-site/login   # a real one
```

From the repo root, `npm run manual:plugin` is the same thing.

The e2e suite proves the loop with a *fake* person: the fixture clears itself on
a 5s timer, which is what makes it runnable unattended. This script is the other
half — it opens a real window and waits for a real click. It serves a challenge
with no timer and prints each step as it goes:

1. the `browser_open` snapshot, challenge banner and all;
2. the structured `detectChallenge()` result;
3. an assertion that *should* pass (the page really does contain the text) and
   correctly returns `ASSERTION FAILED` anyway;
4. `browser_wait_for_human`, which blocks until you solve it in the window;
5. the assertion the challenge was blocking, which now passes.

A real interstitial is not something you can summon on demand, so the local
fixture is the useful default: deterministic, and it lets you debug the detector
against a known-good page. Pass a URL to point it at something real.

Four regressions it exists to catch:

- **`__name` in the page.** `tsx`/esbuild/DSH's loader emit `__name(fn, "…")`
  around every compiled function for name preservation. Playwright serializes
  that source into the page, where the helper does not exist, so *every*
  `page.evaluate()` fails. The fix is an init script installed before any page
  is created:

  ```ts
  await context.addInitScript({ content: 'globalThis.__name ||= (fn) => fn;' })
  ```

  The harness asserts the collector did not fail, which is what proves this
  polyfill is in place.

- **Swallowed collection errors.** An early `.catch(() => [])` turned "the
  collector is broken" into "the page has no elements". Snapshot collection now
  reports `collectorFailed`, and the snapshot says so in the text the agent
  reads, so observation failures are loud.

Two more, from writing the fixture itself — both are properties of Chromium that
the tests only look like they cover if you get them wrong:

- **A cleared interstitial replaces the title, not just the body.** A fixture
  that swaps its body back to the real page while leaving `<title>Verify you are
  human</title>` in place is still a challenge, and should be: the detector reads
  the document the browser is actually showing. A real interstitial hands the
  document over.
- **A cookie only survives a restart if it has an expiry.** Chromium keeps a
  session cookie in memory, so a persistent profile does *not* restore one. The
  fixture sets `Max-Age`, because that is the difference between a cookie and a
  promise.

## License

MIT
