/**
 * Offline end-to-end harness for the DSH plugin.
 *
 * It boots a real cordis composition (system prompt + tool registry), loads the
 * plugin exactly the way DSH does, and drives the tools through
 * `ctx.tools.execute()` — so schema validation, argument parsing, the registry
 * pipeline, and the tool bodies are all exercised, not stubbed.
 *
 * Run against the BUILT output (`lib/`), because that is what ships.
 *
 *     npm run build:plugin && node packages/dsh-browser-playwright/test/e2e.mjs
 */
import http from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import browserPlugin, { classifyChallenge } from '../lib/index.js'

// ----------------------------------------------------------------- fixtures

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture Home</title></head>
<body>
  <h1>Sign in</h1>
  <form id="login">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" placeholder="Email address">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" placeholder="Password">
    <label><input id="remember" type="checkbox"> Remember me</label>
    <button type="submit">Sign in</button>
  </form>
  <div id="spinner">Loading…</div>
  <div id="late" style="display:none">Deferred banner</div>
  <script>
    setTimeout(() => { document.getElementById('late').style.display = 'block' }, 300)
    setTimeout(() => { document.getElementById('spinner')?.remove() }, 700)
    document.getElementById('login').addEventListener('submit', (event) => {
      event.preventDefault()
      document.querySelector('h1').textContent = 'Welcome back'
      history.pushState({}, '', '/done')
    })
  </script>
</body>
</html>`

// A stand-in for an anti-bot interstitial. The `iframe` points at *this* server
// (the path merely contains "recaptcha"), so the fixture stays offline while
// still tripping the same selector a real reCAPTCHA widget would.
const CHALLENGE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Verify you are human</title></head>
<body>
  <h1>Verify you are human</h1>
  <p>Please verify you are human to continue.</p>
  <iframe src="/recaptcha/api2/anchor?k=test" title="reCAPTCHA" width="300" height="80"></iframe>
  <button type="submit">Submit</button>
  <script>
    // Stands in for a person solving the challenge: the interstitial gives way
    // to the real page, late enough that the assertions meant to see the
    // challenge run first. The title has to change too — a real interstitial
    // hands the document over, and a stale challenge title is still a
    // challenge signal.
    setTimeout(() => {
      document.title = 'Real page'
      document.querySelector('iframe')?.remove()
      document.querySelector('h1').textContent = 'Real page'
      document.querySelector('p').textContent = 'Signed in as ada'
    }, 5000)
  </script>
</body>
</html>`

// Writes state that only a *persistent* profile can keep.
const MARK_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Marked</title></head>
<body>
  <h1>Marked</h1>
  <p>storage written</p>
  <script>localStorage.setItem('wta_profile', 'round-1')</script>
</body>
</html>`

// Reports whatever the browser still remembers, as addressable text.
const ECHO_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Echo</title></head>
<body>
  <h1>Echo</h1>
  <p id="echo">pending</p>
  <script>
    document.getElementById('echo').textContent =
      'cookie=' + document.cookie + '|ls=' + (localStorage.getItem('wta_profile') || 'none')
  </script>
</body>
</html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const html = (body, headers = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers })
    res.end(body)
  }

  if (url.pathname === '/done') return html('<!doctype html><title>Done</title><h1>Welcome back</h1>')
  if (url.pathname === '/challenge') return html(CHALLENGE_PAGE)
  if (url.pathname === '/mark') {
    // `Max-Age` is load-bearing: Chromium keeps a session cookie in memory
    // only, so a persistent profile will *not* restore one on restart. Only a
    // cookie with an expiry reaches the profile's cookie DB.
    return html(MARK_PAGE, { 'set-cookie': 'wta_profile=round-1; Path=/; Max-Age=86400' })
  }
  if (url.pathname === '/echo') return html(ECHO_PAGE)
  if (url.pathname.startsWith('/recaptcha')) return html('<!doctype html><title>anchor</title>')
  return html(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// ------------------------------------------------------------- composition

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(browserPlugin, { headless: true, recordVideo: true })

const registered = ctx.get('tools').schemas().map((s) => s.name).sort()
console.log(`registered tools (${registered.length}): ${registered.join(', ')}\n`)

// ----------------------------------------------------------------- helpers

let failures = 0
let skips = 0
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function skip(label, detail = '') {
  skips += 1
  console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ''}`)
}

// Later phases compose their own contexts; the tool driver follows whichever
// one is current, so `call()` needs no context argument.
let activeCtx = ctx

let callSeq = 0
async function call(name, args = {}) {
  callSeq += 1
  // DSH materializes arguments across a *lossless JSON* boundary and rejects
  // any non-JSON value, `undefined` included. A real model cannot send one, so
  // the harness must not either — drop them rather than paper over the check.
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
  const result = await activeCtx.get('tools').execute({
    callId: `e2e-${callSeq}`,
    name,
    arguments: clean,
    signal: new AbortController().signal,
  })
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { isError: result.isError === true, text, raw: result }
}

/** Compose a context the same way DSH does, with a given plugin config. */
async function boot(config) {
  const booted = new Context()
  await booted.plugin(SystemPrompt)
  await booted.plugin(ToolRuntime)
  await booted.plugin(browserPlugin, config)
  return booted
}

/** Map `[e4] textbox "Email address"` lines to `{ 'Email address': 'e4' }`. */
function refsByName(snapshotText) {
  const map = {}
  const pattern = /\[(e\d+)\]\s+(\w[\w-]*)\s+"([^"]*)"/g
  let match
  while ((match = pattern.exec(snapshotText)) !== null) {
    const [, ref, role, name] = match
    if (!(name in map)) map[name] = ref
    map[`${role}:${name}`] = ref
  }
  return map
}

// ------------------------------------------------------------------- tests

check('all ten browser tools are registered', registered.length === 10 && registered.every((n) => n.startsWith('browser_')), registered.join(','))
check('the human-in-the-loop tool is registered', registered.includes('browser_wait_for_human'))

const opened = await call('browser_open', { url: base })
check('browser_open succeeds', !opened.isError, opened.isError ? opened.text : '')
check('snapshot names the page', opened.text.includes('Sign in'))
check('snapshot exposes element refs', /\[e\d+\]/.test(opened.text))
check(
  'collector did not fail (the __name polyfill works)',
  !opened.text.includes('COLLECTOR FAILED'),
)

let refs = refsByName(opened.text)
check('found the email field', !!refs['Email'], JSON.stringify(refs))

const filled = await call('browser_fill', { ref: refs['Email'], value: 'ada@example.com' })
check('browser_fill succeeds', !filled.isError, filled.isError ? filled.text : '')
refs = refsByName(filled.text)

const valueCheck = await call('browser_assert', {
  ref: refs['Email'],
  value: 'ada@example.com',
})
check('assert value equals what was filled', !valueCheck.isError && valueCheck.text.startsWith('ASSERTION PASSED'), valueCheck.text.split('\n')[0])

const textPass = await call('browser_assert', { text: 'Sign in' })
check(
  'assert visible page text passes',
  !textPass.isError && textPass.text.startsWith('ASSERTION PASSED'),
  textPass.text.split('\n')[0],
)

const textFail = await call('browser_assert', { text: 'No such copy anywhere' })
check(
  'assert missing text FAILS without throwing',
  !textFail.isError && textFail.text.startsWith('ASSERTION FAILED'),
  textFail.text.split('\n')[0],
)

const missingUrl = await call('browser_assert', { url_contains: '/nope', timeoutMs: 800 })
check(
  'assert wrong URL FAILS without throwing',
  !missingUrl.isError && missingUrl.text.startsWith('ASSERTION FAILED'),
  missingUrl.text.split('\n')[0],
)
check(
  'failed assertion reports what was actually observed',
  missingUrl.text.includes('FAIL -') && missingUrl.text.includes(base),
)

const check1 = await call('browser_assert', { ref: refs['Remember me'], checked: false })
check(
  'assert unchecked passes',
  !check1.isError && check1.text.startsWith('ASSERTION PASSED'),
  check1.text.split('\n')[0],
)

const wrongCheck = await call('browser_assert', { ref: refs['Remember me'], checked: true })
check(
  'assert wrong checked state FAILS without throwing',
  !wrongCheck.isError && wrongCheck.text.startsWith('ASSERTION FAILED'),
  wrongCheck.text.split('\n')[0],
)

const staleRef = await call('browser_assert', { ref: 'e999', state: 'visible', timeoutMs: 300 })
check('unknown ref is a hard error (caller bug, not a page fact)', staleRef.isError)
check('unknown ref error explains how to recover', /snapshot|ref/i.test(staleRef.text))

// The snapshot only numbers *interactive* elements, so a heading has no ref.
// `selector` is the escape hatch; a real model run asked for exactly this.
const heading = await call('browser_assert', { selector: 'h1', text: 'Sign in', timeoutMs: 3_000 })
check(
  'assert can target a non-interactive element by selector',
  !heading.isError && heading.text.startsWith('ASSERTION PASSED'),
  heading.text.split('\n')[0],
)

const headingState = await call('browser_assert', { selector: 'h1', state: 'visible', timeoutMs: 3_000 })
check(
  'assert applies state to a selector target',
  !headingState.isError && headingState.text.startsWith('ASSERTION PASSED'),
  headingState.text.split('\n')[0],
)

const headingWrong = await call('browser_assert', { selector: 'h1', text: 'Not the heading', timeoutMs: 300 })
check(
  'wrong selector text FAILS without throwing',
  !headingWrong.isError && headingWrong.text.startsWith('ASSERTION FAILED'),
  headingWrong.text.split('\n')[0],
)

const bothTargets = await call('browser_assert', { ref: refs['Email'], selector: 'h1', state: 'visible' })
check(
  'ref plus selector together is a hard error',
  bothTargets.isError && /either/i.test(bothTargets.text),
  bothTargets.text.split('\n')[0],
)

const waited = await call('browser_wait', { text: 'Deferred banner', timeoutMs: 5_000 })
check('browser_wait resolves a late element', !waited.isError && waited.text.includes('reached'), waited.text.split('\n')[0])

const hidden = await call('browser_wait', { text: 'Loading', state: 'hidden', timeoutMs: 5_000 })
check('browser_wait observes a disappearing element', !hidden.isError && hidden.text.includes('reached'), hidden.text.split('\n')[0])

const clicked = await call('browser_click', { ref: refs['Sign in'] })
check('browser_click succeeds', !clicked.isError, clicked.isError ? clicked.text : '')
check('click notice reports navigation', clicked.text.includes('navigated to'))

const urlPass = await call('browser_assert', { url_contains: '/done', timeoutMs: 3_000 })
check(
  'assert URL after navigation passes',
  !urlPass.isError && urlPass.text.startsWith('ASSERTION PASSED'),
  urlPass.text.split('\n')[0],
)

const afterNav = refsByName(urlPass.text)
check('snapshot after navigation is fresh', !!afterNav['Welcome back'] || urlPass.text.includes('Welcome back'))

const shot = await call('browser_screenshot', { label: 'after-login' })
check('browser_screenshot succeeds', !shot.isError, shot.isError ? shot.text : '')
const shotPath = shot.text.replace(/^Saved (?:full-page|viewport) screenshot to /, '').replace(/\.\s*$/, '')
check('screenshot file exists on disk', existsSync(shotPath) && shotPath.endsWith('.png'), shotPath)

const closed = await ctx.get('browser').close('default')
check('close returns a video path', typeof closed.videoPath === 'string' && existsSync(closed.videoPath), closed.videoPath)

// ------------------------------------------- stage 1 control: isolated mode
//
// The default must stay a throwaway context. Proving that here means the
// persistent phases below are actually testing persistence, not a leftover.

const defaultBrowser = ctx.get('browser')
check('isolated mode is the default', defaultBrowser.config.persistent === false)
check('the default viewport is the fixed one', defaultBrowser.config.viewport?.width === 1280, JSON.stringify(defaultBrowser.config.viewport))
check('human-in-the-loop is off when the window is invisible', defaultBrowser.humanInTheLoop === false)

await call('browser_open', { url: `${base}/echo` })
const cleanSlate = await call('browser_assert', { selector: '#echo', text: 'ls=none', timeoutMs: 3_000 })
check(
  'an isolated context starts with no stored state',
  !cleanSlate.isError && cleanSlate.text.startsWith('ASSERTION PASSED'),
  cleanSlate.text.split('\n')[0],
)

// ----------------------------------------- stage 2: the pure classifier
//
// No browser needed, so this is the cheapest place to pin the rules.

const cloudflare = classifyChallenge({
  url: 'https://www.example.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1',
  title: 'Just a moment...',
  text: 'Checking your browser before accessing example.com. Enable JavaScript and cookies to continue.',
  widgets: [],
})
check('a Cloudflare interstitial is detected', cloudflare.detected, JSON.stringify(cloudflare.evidence))
check('a Cloudflare interstitial is recognised by vendor', cloudflare.vendor === 'cloudflare', cloudflare.vendor)
check('a Cloudflare interstitial blocks assertions', cloudflare.blocking === true, cloudflare.summary)
check('a self-clearing interstitial is not offered to a human', cloudflare.humanSolvable === false, String(cloudflare.humanSolvable))

const widgetOnly = classifyChallenge({
  url: 'https://www.example.com/signup',
  title: 'Sign up',
  text: 'Create your account',
  widgets: ['iframe[src*="recaptcha"]'],
})
check('an embedded captcha widget is detected', widgetOnly.detected, JSON.stringify(widgetOnly.evidence))
check('an embedded captcha widget does not block the page', widgetOnly.blocking === false, widgetOnly.summary)

const innocent = classifyChallenge({
  url: 'http://127.0.0.1/captcha-demo',
  title: 'Captcha demo',
  text: 'This page renders a captcha so you can see one.',
  widgets: [],
})
check('a page that merely mentions "captcha" is not a challenge', innocent.detected === false, JSON.stringify(innocent.evidence))

// -------------------------- stage 3: nobody is watching, so the wait refuses

const denied = await call('browser_wait_for_human', { timeoutMs: 5_000 })
check('browser_wait_for_human refuses a headless browser', denied.isError === true, denied.text.split('\n')[0])
check(
  'the refusal names the ways out',
  /humanInTheLoop/.test(denied.text) && /headless/.test(denied.text),
  denied.text.split('\n').slice(0, 2).join(' | '),
)

// The refusal above must not be something the snapshot invited. `humanSolvable`
// is a fact about the challenge; whether a person is reachable is a separate
// fact, and the banner has to combine them or it walks the agent into the error
// it just produced.
await call('browser_open', { url: `${base}/challenge` })
const headlessBanner = await call('browser_snapshot', {})
check(
  'a headless snapshot still flags the challenge',
  headlessBanner.text.includes('CHALLENGE DETECTED'),
  headlessBanner.text.split('\n').slice(0, 3).join(' | '),
)
check(
  'the banner does NOT recommend the human tool when no person can reach the browser',
  !/call browser_wait_for_human/.test(headlessBanner.text),
  (headlessBanner.text.match(/.*browser_wait_for_human.*/)?.[0] ?? 'no mention').trim(),
)
check(
  'the banner says to report the block instead',
  /report the run as blocked/i.test(headlessBanner.text),
)

// --------------------- stages 1 + 3: a real profile, a real person, a real wait

const profileDir = mkdtempSync(path.join(tmpdir(), 'wta-profile-'))
/** Persistent + visible: the composition stages 1 and 3 are actually for. */
const liveConfig = {
  headless: false,
  persistent: true,
  userDataDir: profileDir,
  recordVideo: false,
  screenshots: false,
}

let persistent = null
try {
  persistent = await boot(liveConfig)
  activeCtx = persistent
  // The window opens lazily, so this is where a headless CI box fails.
  await call('browser_open', { url: base })
} catch (error) {
  persistent = null
}

if (!persistent) {
  skip('the persistent + headed phases', 'this environment cannot open a Chromium window')
} else {
  const live = persistent.get('browser')
  check('persistent mode is on', live.config.persistent === true)
  check('the profile lives where it was asked to', live.config.userDataDir === profileDir, live.config.userDataDir)
  check('persistent mode uses the real window size', live.config.viewport === null, JSON.stringify(live.config.viewport))
  check('a visible browser enables the human loop', live.humanInTheLoop === true)

  // -- the profile keeps what a session leaves behind
  const marked = await call('browser_open', { url: `${base}/mark` })
  check('the profile records state', !marked.isError && marked.text.includes('Marked'), marked.isError ? marked.text : '')
  await call('browser_open', { url: `${base}/echo` })
  const sameRun = await call('browser_assert', { selector: '#echo', text: 'ls=round-1', timeoutMs: 3_000 })
  check(
    'state written in the profile is readable in the same session',
    !sameRun.isError && sameRun.text.startsWith('ASSERTION PASSED'),
    sameRun.text.split('\n')[1] ?? sameRun.text.split('\n')[0],
  )

  // -- a challenge is surfaced, and vetoes an assertion that would "pass"
  const challenged = await call('browser_open', { url: `${base}/challenge` })
  check('an interstitial loads', !challenged.isError && challenged.text.includes('CHALLENGE DETECTED'), challenged.text.split('\n').slice(0, 4).join(' | '))
  check('the snapshot still shows the page underneath', challenged.text.includes('Submit'), '')
  // The counterpart to the headless check: with a window on screen and the
  // human loop on, the advice must stay actionable.
  check(
    'the banner DOES recommend the human tool when a person is present',
    /call browser_wait_for_human/.test(challenged.text),
    (challenged.text.match(/.*browser_wait_for_human.*/)?.[0] ?? 'no mention').trim(),
  )

  const detected = await live.detectChallenge('default')
  check('detectChallenge agrees with the snapshot', detected.detected && detected.blocking === true, JSON.stringify({ vendor: detected.vendor, blocking: detected.blocking }))
  check('the challenge carries its evidence', detected.evidence.length > 0, detected.evidence.join(' | '))
  check('this challenge is offered to a human', detected.humanSolvable === true, String(detected.humanSolvable))

  const wouldPass = await call('browser_assert', { text: 'Please verify you are human', timeoutMs: 3_000 })
  check(
    'an assertion cannot PASS off a challenge page',
    !wouldPass.isError && wouldPass.text.startsWith('ASSERTION FAILED'),
    wouldPass.text.split('\n')[0],
  )
  check(
    'the failed verdict says why it was overridden',
    /challenge/i.test(wouldPass.text),
  )

  // -- handing the browser to a person, and continuing afterwards
  const startedAt = Date.now()
  const human = await call('browser_wait_for_human', { timeoutMs: 25_000, pollMs: 250 })
  const elapsed = Date.now() - startedAt
  check('browser_wait_for_human returns without error', !human.isError, human.isError ? human.text : '')
  check('it reports the challenge as cleared', /person cleared the challenge/i.test(human.text), human.text.split('\n')[0])
  check('it did not report the challenge as still there', !/STILL there/i.test(human.text))
  check('it really waited for the page to change', elapsed > 2_000, `${elapsed}ms`)
  check('the snapshot it returns is the real page', human.text.includes('Real page'), '')
  check('the cleared page no longer looks like a challenge', !human.text.includes('CHALLENGE DETECTED'))
  check('the challenge is gone from the detector too', (await live.detectChallenge('default')).detected === false)

  const again = await call('browser_wait_for_human', { timeoutMs: 5_000 })
  check(
    'waiting with nothing to wait for returns immediately and says so',
    !again.isError && /nothing to wait for/i.test(again.text),
    again.text.split('\n')[0],
  )

  // -- stage 1's real claim: the profile outlives the process
  await live.disposeAll()
  activeCtx = ctx

  const rebooted = await boot(liveConfig)
  activeCtx = rebooted
  try {
    await call('browser_open', { url: `${base}/echo` })
    const survives = await call('browser_assert', { selector: '#echo', text: 'ls=round-1', timeoutMs: 5_000 })
    check(
      'the profile survives a restart with no live browser',
      !survives.isError && survives.text.startsWith('ASSERTION PASSED'),
      survives.text.split('\n').slice(0, 2).join(' | '),
    )
    const cookie = await call('browser_assert', { selector: '#echo', text: 'wta_profile=round-1', timeoutMs: 5_000 })
    check(
      'cookies survive a restart too',
      !cookie.isError && cookie.text.startsWith('ASSERTION PASSED'),
      cookie.text.split('\n')[0],
    )
  } finally {
    await rebooted.get('browser').disposeAll()
    activeCtx = ctx
  }
}

rmSync(profileDir, { recursive: true, force: true })

// ---------------------------------------------------------------- teardown

await ctx.get('browser').disposeAll()
await ctx.stop?.().catch?.(() => {})
server.close()

const verdict =
  failures > 0
    ? `${failures} CHECK(S) FAILED`
    : skips > 0
      ? `ALL CHECKS PASSED (${skips} phase(s) skipped)`
      : 'ALL CHECKS PASSED'
console.log(`\n${verdict}`)
process.exit(failures === 0 ? 0 : 1)
