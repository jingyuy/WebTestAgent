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
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import browserPlugin from '../lib/index.js'

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

const server = http.createServer((req, res) => {
  if (req.url === '/done') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Done</title><h1>Welcome back</h1>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE)
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
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`)
}

let callSeq = 0
async function call(name, args = {}) {
  callSeq += 1
  // DSH materializes arguments across a *lossless JSON* boundary and rejects
  // any non-JSON value, `undefined` included. A real model cannot send one, so
  // the harness must not either — drop them rather than paper over the check.
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
  const result = await ctx.get('tools').execute({
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

// ---------------------------------------------------------------- teardown

await ctx.get('browser').disposeAll()
await ctx.stop?.().catch?.(() => {})
server.close()

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
