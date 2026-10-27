// check-dispatch-once.mjs decides whether broadcast.yml and on-demand-briefing.yml
// do real work or skip a duplicate dispatch (#28). It runs here for real against
// the in-memory KV in fixtures/fake-kv-fetch.mjs, and the two workflows are
// checked for the wiring that makes the guard effective: the guard step comes
// before the work, and broadcast serializes copies of one dispatch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve('scripts/check-dispatch-once.mjs')
const PRELOAD = resolve('test/fixtures/fake-kv-fetch.mjs')

function runGuard({ dispatchId, seed = {}, creds = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-once-'))
  const out = join(dir, 'kv.json')
  const ghOutput = join(dir, 'github_output')
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: ghOutput, FAKE_KV_SEED: JSON.stringify(seed), FAKE_KV_PUTS: out }
  if (dispatchId) env.DISPATCH_ID = dispatchId
  if (creds) Object.assign(env, { CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', CF_KV_NAMESPACE_ID: 'n' })
  const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT], { cwd: dir, encoding: 'utf8', env })
  let output = ''
  try { output = readFileSync(ghOutput, 'utf8') } catch {}
  return { status: r.status, stderr: r.stderr, output, kv: JSON.parse(readFileSync(out, 'utf8')) }
}

test('a first-seen dispatch_id proceeds and is recorded', () => {
  const r = runGuard({ dispatchId: 'abc-123' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /^duplicate=false$/m)
  assert.deepEqual(r.kv.puts, ['dispatch_seen:abc-123'])
})

test('a dispatch_id already recorded is reported as a duplicate and not written again', () => {
  const r = runGuard({ dispatchId: 'abc-123', seed: { 'dispatch_seen:abc-123': '2026-10-25T00:00:00Z' } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /^duplicate=true$/m)
  assert.deepEqual(r.kv.puts, [])
})

test('a different dispatch_id is not blocked by someone else\'s record', () => {
  const r = runGuard({ dispatchId: 'def-456', seed: { 'dispatch_seen:abc-123': 'x' } })
  assert.match(r.output, /^duplicate=false$/m)
})

test('no dispatch_id (manual dispatch) proceeds without touching KV', () => {
  const r = runGuard({ creds: false })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /^duplicate=false$/m)
  assert.deepEqual(r.kv.puts, [])
})

test('a dispatch_id without Cloudflare credentials fails loudly instead of letting a duplicate through', () => {
  const r = runGuard({ dispatchId: 'abc-123', creds: false })
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.output, /duplicate=false/)
})

const wf = (name) => readFileSync(resolve('.github/workflows', name), 'utf8')

for (const name of ['broadcast.yml', 'on-demand-briefing.yml']) {
  test(`${name} runs the dispatch guard before any work and gates the work on it`, () => {
    const text = wf(name)
    const guard = text.indexOf('node scripts/check-dispatch-once.mjs')
    assert.ok(guard > 0, 'guard step missing')
    assert.match(text, /id: dispatch_guard/)
    const gated = [...text.matchAll(/steps\.dispatch_guard\.outputs\.duplicate != 'true'/g)]
    assert.ok(gated.length >= 1, 'no step is gated on the guard')
    assert.ok(text.indexOf("steps.dispatch_guard.outputs.duplicate != 'true'") > guard, 'work is gated before the guard runs')
  })
}

test('broadcast.yml groups runs by dispatch_id, never one shared group, and never cancels', () => {
  const text = wf('broadcast.yml')
  const group = text.match(/^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m)
  assert.ok(group, 'concurrency block missing')
  assert.match(group[1], /client_payload\.dispatch_id/)
  assert.match(group[1], /github\.run_id/, 'a manual dispatch needs a fallback that never queues behind another run')
  assert.equal(group[2].trim(), 'false')
})
