// The one thing scripts/check-deployed.mjs cannot get wrong quietly.
//
// It answers "is the live Worker running this checkout" by comparing the
// deployed commit against the last commit that touched the paths
// deploy-worker.yml deploys on. Those paths live in two files. If they drift,
// the script keeps printing a confident verdict computed from the wrong set --
// the exact failure it exists to prevent, arriving at the moment someone is
// already debugging something else and least able to question it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEPLOY_PATHS } from '../scripts/check-deployed.mjs'

test('check-deployed paths match the deploy workflow trigger', () => {
  const wf = readFileSync('.github/workflows/deploy-worker.yml', 'utf8')

  // Narrow to the `paths:` block under `on.push` before collecting entries, so
  // an unrelated list elsewhere in the workflow can't pad the comparison.
  const block = wf.match(/\n {4}paths:\n((?: {6}- .*\n)+)/)
  assert.ok(block, 'no `paths:` filter found under on.push in deploy-worker.yml')

  const declared = block[1]
    .split('\n')
    .filter(Boolean)
    .map(line => line.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, ''))
    // The workflow globs; the script hands bare paths to `git log -- `, which
    // treats a directory as everything under it. Compare on the same footing.
    .map(p => p.replace(/\/\*\*$/, ''))

  assert.deepEqual(
    [...declared].sort(),
    [...DEPLOY_PATHS].sort(),
    'deploy-worker.yml and scripts/check-deployed.mjs disagree about what a deploy covers',
  )
})
