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
// Usage:  node scripts/check-deployed.mjs [--url <worker-url>]
// Exit 0 when live matches expected, 1 when it does not, 2 when the check
// could not be completed (unreachable Worker, not a git checkout).

import { execFileSync } from 'node:child_process'

const DEFAULT_URL = 'https://ai-in-ta-telegram-bot.ai-in-ta-bot.workers.dev'

// Must stay in step with the `paths:` filter in
// .github/workflows/deploy-worker.yml. test/check-deployed.test.mjs reads both
// and fails if they drift -- the failure mode otherwise is silent and this
// script's whole value is being trustworthy when something else is broken.
export const DEPLOY_PATHS = ['worker', 'shared', '.github/workflows/deploy-worker.yml']

const urlFlag = process.argv.indexOf('--url')
const workerUrl = (urlFlag !== -1 ? process.argv[urlFlag + 1] : '') || DEFAULT_URL

function expectedSha() {
  return execFileSync('git', ['log', '-1', '--format=%H', '--', ...DEPLOY_PATHS], {
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
    throw new Error(`/status returned ${JSON.stringify(body.slice(0, 40))}, not JSON -- the live Worker predates the endpoint`)
  }
}

async function main() {
  let expected
  try {
    expected = expectedSha()
  } catch (err) {
    console.error(`cannot read git history: ${err.message}`)
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
  const short = (s) => (typeof s === 'string' && /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : s)

  console.log(`live      ${short(live)}`)
  console.log(`expected  ${short(expected)}  (last commit touching ${DEPLOY_PATHS.join(', ')})`)
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

await main()
