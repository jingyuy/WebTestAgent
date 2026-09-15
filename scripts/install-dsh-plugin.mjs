#!/usr/bin/env node
/**
 * Build the DSH plugin, pack it, and reinstall it into one or more DSH profiles.
 *
 * Why a script: `dsh plugin add` takes a *tarball path*, and pnpm keys its store
 * by that path, so reinstalling the same filename silently reuses the previously
 * cached tarball. We therefore delete the old tarball first and let npm write a
 * fresh one, which changes its content hash and defeats the cache.
 *
 * Usage:
 *   node scripts/install-dsh-plugin.mjs                 # headless + web
 *   node scripts/install-dsh-plugin.mjs headless        # just one
 *   DSH_VERSION=0.1.5-rc.2 node scripts/install-dsh-plugin.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(repoRoot, 'packages', 'dsh-browser-playwright')
const DSH_VERSION = process.env.DSH_VERSION ?? '0.1.5-rc.2'

const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const pkg = read(path.join(pkgDir, 'package.json'))
const flat = (name) => name.replace(/^@/, '').replace('/', '-')
const tarballName = `${flat(pkg.name)}-${pkg.version}.tgz`

const profiles = process.argv.slice(2).length ? process.argv.slice(2) : ['headless', 'web']

/**
 * Whether chromium should run without a visible window, per profile.
 *
 * The plugin ships ONE bundled `cordis.patch.yml`, so it cannot give two
 * profiles different config by itself: `dsh plugin add` points both at the same
 * file. The per-profile layer (`~/.dsh/profiles/<name>/cordis.patch.yml`) is
 * applied *after* every bundle, so it is the only place a difference can live.
 *
 * `web` gets a real window because that profile is the one with a person
 * sitting in front of it — the Web UI. It is not cosmetic: a visible browser is
 * what makes `humanInTheLoop` true by derivation
 * (`config.humanInTheLoop ?? !headless`), which is what lets
 * browser_wait_for_human park a run for that person instead of refusing. The
 * unattended `headless` profile wants the opposite.
 *
 * An unrecognised profile name gets `true`: unattended is the safe assumption,
 * and the failure mode of guessing wrong the other way is a stray window
 * popping up on a machine nobody is watching.
 */
const HEADLESS_BY_PROFILE = { headless: true, web: false }

/** Marker identifying the profile layer as ours, so we never clobber a user's. */
/**
 * Delimiters around the single block this script owns inside a profile's patch
 * layer.
 *
 * A profile's `cordis.patch.yml` belongs to the user — `cordis.yml` says "Edit
 * cordis.patch.yml, not this file" — so a reinstall must not rewrite it
 * wholesale. Fencing our entry lets us replace exactly that entry and leave
 * every other byte alone.
 *
 * An earlier version keyed the decision on a marker comment appearing anywhere
 * in the file, which made the file "ours forever": a row the user appended
 * below our block was silently wiped by the next install. The test that caught
 * it appended a foreign row and re-ran the installer.
 */
const BEGIN = '# >>> managed-block: @webtestagent/dsh-browser-playwright'
const END = '# <<< managed-block: @webtestagent/dsh-browser-playwright'

/** The header dsh writes into a profile layer it has just created. */
const LAYER_HEADER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
].join('\n')

function profilePatchPath(profile) {
  return path.join(process.env.HOME ?? '', '.dsh', 'profiles', profile, 'cordis.patch.yml')
}

/** Our patch entry, fenced, ready to drop into a layer. */
function profileBlock(headless) {
  const window = headless
    ? [
        '# Invisible browser: this profile is the unattended one, so chromium runs',
        '# with no window. Nobody can reach it, which also keeps `humanInTheLoop`',
        '# false — an agent asking for browser_wait_for_human here gets an honest',
        '# refusal instead of a five-minute stall.',
      ]
    : [
        '# Visible browser: this profile is the attended one, so chromium opens a',
        '# real window to watch and click in. A person being able to see it is what',
        '# makes `humanInTheLoop` true, so browser_wait_for_human parks the run for',
        '# you rather than refusing.',
      ]

  return [
    BEGIN,
    ...window,
    '#',
    "# Every key is restated because a `config:` entry REPLACES the row's whole",
    '# config object instead of merging into it (verified with --dump-config).',
    "# These mirror the plugin's own defaults, so this is what the profile",
    '# resolves to anyway; they are here so the effective config is visible in',
    '# this file and not only in code.',
    '',
    '- id: browser-playwright',
    '  config:',
    `    headless: ${headless}`,
    '    timeoutMs: 15000',
    '    idleTimeoutMs: 600000',
    '    recordVideo: true',
    '    screenshots: true',
    END,
  ].join('\n')
}

/**
 * Pin this profile's browser defaults, touching only our own fenced block.
 *
 * Three cases, in order: no file (create it), our block already present
 * (replace just that span), or a pristine `[]` layer (swap the empty array for
 * our block). Anything else means entries we did not write sit in the layer, so
 * our block is appended below them rather than replacing them. Once the file
 * holds anything of the user's it is never rewritten wholesale.
 */
function writeProfilePatch(profile) {
  const file = profilePatchPath(profile)
  const headless = HEADLESS_BY_PROFILE[profile] ?? true
  const block = profileBlock(headless)

  if (!existsSync(file)) {
    writeFileSync(file, `${LAYER_HEADER}\n\n${block}\n`)
    console.log(`   ${profile}: created cordis.patch.yml with headless: ${headless}`)
    return
  }

  const current = readFileSync(file, 'utf8')
  const start = current.indexOf(BEGIN)
  const end = current.indexOf(END)

  if (start !== -1 && end > start) {
    const next = current.slice(0, start) + block + current.slice(end + END.length)
    if (next === current) {
      console.log(`   ${profile}: already pinned at headless: ${headless}`)
      return
    }
    writeFileSync(file, next)
    console.log(`   ${profile}: updated our block to headless: ${headless}`)
    return
  }

  // No block of ours. A pristine layer is `[]` (comments aside), which is ours
  // to fill; replace just that array so any surrounding comments survive.
  const entries = current.replace(/^[ \t]*#.*$/gm, '').trim()
  const emptyAt = current.split('\n').findIndex((line) => line.trim() === '[]')
  if (entries === '[]' && emptyAt !== -1) {
    const lines = current.split('\n')
    lines.splice(emptyAt, 1, block)
    writeFileSync(file, lines.join('\n'))
    console.log(`   ${profile}: pinned headless: ${headless}`)
    return
  }

  const separator = current.endsWith('\n') ? '' : '\n'
  writeFileSync(file, `${current}${separator}\n${block}\n`)
  console.log(`   ${profile}: appended headless: ${headless} below your existing entries`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options })
  if (result.error) throw result.error
  return result.status ?? 1
}

function dsh(args, options = {}) {
  // Boot from a directory without a .env: dsh refuses to start if one sets
  // DEEPSEEK_BASE_URL, and the repo's .env legitimately does.
  return run('npx', ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, ...args], {
    cwd: tmpdir(),
    ...options,
  })
}

console.log(`\n▸ building ${pkg.name}@${pkg.version}`)
if (run('npm', ['run', 'build:plugin'], { cwd: repoRoot }) !== 0) {
  console.error('\nBuild failed.')
  process.exit(1)
}

console.log('\n▸ packing')
for (const entry of readdirSync(pkgDir)) {
  if (entry.endsWith('.tgz')) rmSync(path.join(pkgDir, entry))
}
if (run('npm', ['pack'], { cwd: pkgDir, stdio: 'ignore' }) !== 0) {
  console.error('\nPack failed.')
  process.exit(1)
}

const tarball = path.join(pkgDir, tarballName)
if (!existsSync(tarball)) {
  console.error(`\nExpected ${tarballName}, found: ${readdirSync(pkgDir).filter((f) => f.endsWith('.tgz'))}`)
  process.exit(1)
}

for (const profile of profiles) {
  console.log(`\n▸ installing into profile "${profile}"`)
  // Remove first: `add` on an existing dependency can be a no-op for pnpm.
  dsh(['plugin', `--profile`, profile, 'remove', pkg.name], { stdio: 'ignore' })
  if (dsh(['plugin', '--profile', profile, 'add', tarball]) !== 0) {
    console.error(`   failed for profile "${profile}"`)
    process.exit(1)
  }
  writeProfilePatch(profile)
}

console.log('\n▸ verifying the installed copies')
const marker = 'a page that keeps a hidden copy'
let failed = false
for (const profile of profiles) {
  const installed = path.join(
    process.env.HOME ?? '',
    '.dsh',
    'profiles',
    profile,
    'node_modules',
    ...pkg.name.split('/'),
  )
  const assertPath = path.join(installed, 'lib', 'tools', 'assert.js')
  if (!existsSync(assertPath)) {
    console.error(`   ${profile}: NOT INSTALLED (${assertPath})`)
    failed = true
    continue
  }
  const current = readFileSync(assertPath, 'utf8').includes(marker)
  console.log(`   ${profile}: ${current ? 'current' : 'STALE — rebuild did not reach the profile'}`)
  if (!current) failed = true
}

console.log(failed ? '\nDone, but verification failed.\n' : `\nDone. ${pkg.name}@${pkg.version} is live in: ${profiles.join(', ')}\n`)
process.exit(failed ? 1 : 0)
