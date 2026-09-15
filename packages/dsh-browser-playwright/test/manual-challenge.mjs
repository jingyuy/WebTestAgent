/**
 * Hands-on harness for the human-in-the-loop path.
 *
 * The e2e suite proves the loop with a *fake* person (the fixture clears itself
 * on a 5s timer), which is what makes it runnable in CI. This script is the
 * other half: it puts a real challenge in front of a real window and waits for
 * a real click, so you can watch the whole sequence happen.
 *
 *   node test/manual-challenge.mjs
 *   node test/manual-challenge.mjs https://your-staging-site.example/login
 *
 * With no argument it serves a local stand-in challenge page. A real
 * interstitial is not something you can summon on demand, so this gives you a
 * deterministic one to practise on and to debug the detector against.
 */
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import browserPlugin from '../lib/index.js'

const target = process.argv[2]

// ----------------------------------------------------------------- the fixture

/** A challenge only a person can clear: no timer, you have to click. */
const CHALLENGE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Verify you are human</title></head>
<body style="font:16px system-ui;padding:3rem;text-align:center">
  <h1>Verify you are human</h1>
  <p>Please verify you are human to continue.</p>
  <iframe src="/recaptcha/api2/anchor?k=demo" title="reCAPTCHA" width="300" height="80"
          style="border:1px solid #ccc"></iframe>
  <p><button id="solve" style="font-size:1.1rem;padding:.6rem 1.4rem">
    I am a human — let me through
  </button></p>
  <script>
    // What a solved challenge looks like: the interstitial hands the document
    // over to the real page. The title must change too — a page still titled
    // "Verify you are human" is still a challenge, and should be reported as one.
    document.getElementById('solve').addEventListener('click', () => {
      document.title = 'Account'
      document.querySelector('iframe').remove()
      document.querySelector('h1').textContent = 'Your account'
      document.querySelector('p').textContent = 'Signed in as ada@example.com'
    })
  </script>
</body>
</html>`

let server
async function serveFixture() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/html' })
    if (url.pathname.startsWith('/recaptcha')) return res.end('<!doctype html><title>anchor</title>')
    res.end(CHALLENGE_PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}/`
}

// ------------------------------------------------------------------- the tools

let seq = 0
async function call(ctx, name, args = {}) {
  seq += 1
  // DSH's argument boundary is lossless JSON and rejects `undefined`, so a
  // harness must strip absent keys exactly as a real model's tool call would.
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
  const result = await ctx.get('tools').execute({
    callId: `manual-${seq}`,
    name,
    arguments: clean,
    signal: new AbortController().signal,
  })
  const text = (result.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return { isError: result.isError === true, text }
}

function heading(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`)
}

// -------------------------------------------------------------------- the run

const url = target ?? (await serveFixture())
const profileDir = mkdtempSync(path.join(tmpdir(), 'wta-manual-'))

heading(`Chrome will open shortly. Target: ${url}`)
console.log(
  'This boots the plugin the way a hands-on session would: a real window, a\n' +
    'real on-disk profile. Let it open, then follow along below.\n',
)

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(browserPlugin, {
  headless: false, // you have to be able to see it
  persistent: true, // ...and it has to remember, or there is no point
  userDataDir: profileDir,
  recordVideo: false,
  screenshots: false,
})

try {
  // 1. Observe. The challenge banner is part of every snapshot, not a separate
  //    check the agent has to remember to run.
  const opened = await call(ctx, 'browser_open', { url })
  heading('1. browser_open')
  console.log(opened.text)

  const detected = await ctx.get('browser').detectChallenge('default')
  heading('2. detectChallenge() — structured, for a host or UI')
  console.log(JSON.stringify(detected, null, 2))

  // 2. Show the veto. The page genuinely contains the text "Verify you are
  //    human", so an honest assertion would pass — which is exactly the trap.
  //    A challenge page must never yield ASSERTION PASSED.
  const trapped = await call(ctx, 'browser_assert', { text: 'Verify you are human' })
  heading('3. browser_assert against the challenge page — refuses to pass')
  console.log(trapped.text)

  // 3. Hand over to you. This is the part the e2e suite fakes.
  if (detected.detected) {
    heading('4. browser_wait_for_human — YOUR TURN')
    console.log('   Go to the Chromium window and click "I am a human — let me through".')
    console.log('   Nothing else will happen until you do. (5 minute limit.)\n')

    const startedAt = Date.now()
    const waited = await call(ctx, 'browser_wait_for_human', {
      timeoutMs: 300_000,
      pollMs: 1_000,
    })
    console.log(`   waited ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`)
    console.log(waited.text)
  } else {
    heading('4. browser_wait_for_human — skipped')
    console.log('   No blocking challenge was detected, so there is nothing to clear.')
    console.log('   The tool would have returned "Nothing to wait for" immediately.\n')
  }

  // 4. Continue. The run resumes on the real page — this is the assertion the
  //    challenge was standing in the way of.
  const resumed = await call(ctx, 'browser_assert', { text: 'Signed in as ada@example.com' })
  heading('5. The assertion the challenge was blocking')
  console.log(resumed.text)

  // 5. Confirm the profile is real, not just a session.
  const stored = await ctx.get('browser')
  heading('6. Profile state')
  console.log(`userDataDir: ${stored.config.userDataDir}`)
  console.log(`persistent:  ${stored.config.persistent}`)
  console.log(`viewport:    ${JSON.stringify(stored.config.viewport)} (null = the real window size)`)
  console.log(`human loop:  ${stored.humanInTheLoop}`)
  console.log('\nCookies and localStorage written on this page live in that directory.')
  console.log('Re-run with the same userDataDir and the site sees a returning person.')
} finally {
  await ctx.get('browser').disposeAll().catch(() => {})
  await ctx.stop?.().catch?.(() => {})
  server?.close()
}

console.log('\nDone.')
process.exit(0)
