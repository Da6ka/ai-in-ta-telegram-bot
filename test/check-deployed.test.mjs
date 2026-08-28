// scripts/check-deployed.mjs derives the deploy paths from deploy-worker.yml
// instead of keeping a copy, so there is nothing left to drift. What can still
// break is the parse: GitHub evaluates `paths:` as literal YAML, so the
// workflow has to stay the source, and a reformat there could quietly change
// what the script extracts.
//
// A silently wrong path list is the dangerous outcome -- the script would keep
// printing a confident verdict computed from the wrong set, at the moment
// someone is debugging something else and least able to question it. So these
// pin the extraction against the real workflow, and pin that a parse it cannot
// trust raises rather than degrades.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deployPaths, WORKFLOW_PATH } from '../scripts/check-deployed.mjs'

test('deployPaths reads the real workflow', () => {
  const paths = deployPaths()
  assert.ok(paths.length >= 2, 'expected several deploy paths, got ' + JSON.stringify(paths))
  // worker/ is the whole point of the workflow; if it ever falls out of the
  // extraction the script would report "up to date" for a Worker change that
  // never shipped -- the failure this file exists to prevent.
  assert.ok(paths.includes('worker'), 'worker/ must be among the deploy paths')
  assert.ok(paths.includes('shared'), 'shared/ must be among the deploy paths')
  // Globs stripped: the script hands these to `git log -- `, which already
  // treats a directory as everything beneath it.
  assert.equal(paths.some(p => p.includes('*')), false, 'globs should be stripped')
})

test('deployPaths covers every path the workflow declares', () => {
  const yaml = readFileSync(WORKFLOW_PATH, 'utf8')
  const declared = [...yaml.matchAll(/^ {6}- '([^']+)'$/gm)].map(m => m[1].replace(/\/\*\*$/, ''))
  assert.deepEqual(deployPaths().sort(), [...new Set(declared)].sort())
})

test('deployPaths raises rather than guessing when it cannot parse', () => {
  assert.throws(() => deployPaths('on:\n  push:\n    branches: [main]\n'), /no `paths:` filter/)
  assert.throws(() => deployPaths('\n    paths:\n      - \n'), /parsed to nothing/)
})
