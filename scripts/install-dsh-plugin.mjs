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
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs'
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
