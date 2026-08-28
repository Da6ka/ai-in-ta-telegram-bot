#!/usr/bin/env node
// Is the live Worker running the code in this checkout?
//
// The naive form of this check -- compare /status's gitSha against main -- is
// wrong, and wrong in the direction that matters: it reports a problem when
// there isn't one. deploy-worker.yml is path-scoped, so a commit that only
// touches docs, prompts or wiki/ ships nothing and leaves gitSha behind main
// on purpose. State commits make that the normal case rather than the rare
// one: the daily briefing pushes state/ back to main every weekday.
//
// So the question is not "does gitSha equal HEAD" but "does gitSha equal the
// last commit that could have triggered a deploy". That is a git incantation
// nobody should have to remember correctly at the moment they are already
// debugging something else, which is what this script is for.
//
// The deploy paths are read out of the workflow rather than copied here.
// GitHub evaluates `paths:` as literal YAML at trigger time, so the workflow
// cannot read them from anywhere else -- it has to be the source, which leaves
// deriving them the only way to have one. A copy would drift, and a drifted
// copy does not fail: it keeps printing a confident verdict computed from the
// wrong set, at the moment someone is debugging something else and is least
// able to question it. If the parse fails this exits 2 rather than guessing.
//
// Usage:  node scripts/check-deployed.mjs [--url <worker-url>]
// Exit 0 when live matches expected, 1 when it does not, 2 when the check
// could not be completed (unreachable Worker, unreadable workflow, no git).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULT_URL = 'https://ai-in-ta-telegram-bot.ai-in-ta-bot.workers.dev'

export const WORKFLOW_PATH = new URL('../.github/workflows/deploy-worker.yml', import.meta.url)

// Pulls the `paths:` filter out of the deploy workflow. Scoped to the block
// under `on.push` so an unrelated list elsewhere in the file cannot pad it, and
// throws rather than returning a partial answer -- an empty or short list would
// silently widen or narrow what counts as a deploy.
export function deployPaths(yaml = readFileSync(WORKFLOW_PATH, 'utf8')) {
  const block = yaml.match(/\n {4}paths:\n((?: {6}- .*\n)+)/)
  if (!block) throw new Error('no `paths:` filter found under on.push in deploy-worker.yml')

  const paths = block[1]
    .split('\n')
    .filter(Boolean)
    .map(line => line.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, '').trim())
    // The workflow globs; `git log -- <dir>` already means everything under it.
    .map(p => p.replace(/\/\*\*$/, ''))
    .filter(Boolean)

  if (!paths.length) throw new Error('`paths:` filter in deploy-worker.yml parsed to nothing')
  return paths
}

const urlFlag = process.argv.indexOf('--url')
const workerUrl = (urlFlag !== -1 ? process.argv[urlFlag + 1] : '') || DEFAULT_URL

function expectedSha(paths) {
  return execFileSync('git', ['log', '-1', '--format=%H', '--', ...paths], {
    encoding: 'utf8',
  }).trim()
}

async function liveStatus(url) {
  const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GET ${url}/status -> ${res.status}`)
  // A bundle predating the endpoint answers the bare uptime reply here, which
  // is itself the answer: whatever is live is older than /status.
  const body = await res.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(
      `/status returned ${JSON.stringify(body.slice(0, 40))}, not JSON -- the live Worker predates the endpoint`,
    )
  }
}

async function main() {
  let paths
  let expected
  try {
    paths = deployPaths()
    expected = expectedSha(paths)
  } catch (err) {
    console.error(`cannot work out what should be deployed: ${err.message}`)
    process.exit(2)
  }

  let status
  try {
    status = await liveStatus(workerUrl)
  } catch (err) {
    console.error(`cannot read the live Worker: ${err.message}`)
    process.exit(2)
  }

  const live = status.gitSha
  const short = s => (typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s)

  console.log(`live      ${short(live)}`)
  console.log(`expected  ${short(expected)}  (last commit touching ${paths.join(', ')})`)
  console.log(`caps      ${JSON.stringify(status.caps)}`)

  if (live === expected) {
    console.log('\nup to date: the live Worker is running this checkout.')
    return
  }

  if (live === 'unknown') {
    console.error('\nthe live Worker was deployed by hand, so it carries no commit stamp.')
    console.error('push to main under the deploy paths to restore it, or accept that it cannot be verified.')
    process.exit(1)
  }

  console.error('\nout of date: the live Worker is NOT running this checkout.')
  console.error('check that deploy-worker.yml succeeded for the expected commit; if it never ran, the')
  console.error('commit may not have touched the deploy paths, in which case this checkout has Worker')
  console.error('changes that were never pushed.')
  process.exit(1)
}

// Only when run as a script. The test imports deployPaths from here, and
// without this guard that import would fetch the live Worker as a side effect
// of loading the module -- a unit test making a network call to production.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
