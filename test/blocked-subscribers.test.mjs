// Unit tests for the runner half of the 403 prune: deciding what counts as
// permanently unreachable, and queueing it without clobbering a concurrent
// writer. The Worker half (draining the queue) is covered in
// test/worker.behavior.test.mjs (L1-L6).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPermanentlyUnreachable, recordBlocked, BLOCKED_PENDING_KEY } from '../shared/blocked-subscribers.mjs'

const CREDS = { accountId: 'acct', apiToken: 'tok', namespaceId: 'ns' }

test('isPermanentlyUnreachable', async (t) => {
  await t.test('403 (blocked / deactivated) is permanent', () => {
    assert.equal(isPermanentlyUnreachable(403), true)
  })
  await t.test('retryable and ambiguous statuses are not', () => {
    // 429/5xx are transient; 400 ("chat not found") is terminal but too broad
    // a net to unsubscribe on — see the module comment.
    for (const s of [429, 500, 502, 400, 404, 200]) {
      assert.equal(isPermanentlyUnreachable(s), false, `status ${s}`)
    }
  })
})

test('recordBlocked', async (t) => {
  function fakeKv(initial) {
    const state = { value: initial, puts: [] }
    const fetchImpl = async (url, opts = {}) => {
      assert.ok(url.includes(BLOCKED_PENDING_KEY), 'writes to the pending key')
      if (!opts.method) {
        return state.value === null
          ? { ok: false, status: 404, text: async () => 'not found' }
          : { ok: true, status: 200, text: async () => state.value }
      }
      state.value = opts.body
      state.puts.push(opts.body)
      return { ok: true, status: 200, text: async () => '' }
    }
    return { state, fetchImpl }
  }

  await t.test('B1 writes ids when the key does not exist yet', async () => {
    const { state, fetchImpl } = fakeKv(null)
    const r = await recordBlocked(['442556665'], { ...CREDS, fetchImpl })
    assert.deepEqual(r.recorded, ['442556665'])
    assert.deepEqual(JSON.parse(state.value), ['442556665'])
  })

  await t.test('B2 merges with what is already queued, rather than overwriting', async () => {
    // The daily send and a broadcast can both hit the same blocked user before
    // the Worker drains the queue; a plain PUT would lose the earlier writer.
    const { state, fetchImpl } = fakeKv(JSON.stringify(['111']))
    await recordBlocked(['222'], { ...CREDS, fetchImpl })
    assert.deepEqual(JSON.parse(state.value).sort(), ['111', '222'])
  })

  await t.test('B3 deduplicates within and across writes', async () => {
    const { state, fetchImpl } = fakeKv(JSON.stringify(['111']))
    await recordBlocked(['111', '111', '222'], { ...CREDS, fetchImpl })
    assert.deepEqual(JSON.parse(state.value).sort(), ['111', '222'])
  })

  await t.test('B4 an empty list is a no-op — no KV write at all', async () => {
    const { state, fetchImpl } = fakeKv(null)
    const r = await recordBlocked([], { ...CREDS, fetchImpl })
    assert.deepEqual(r.recorded, [])
    assert.equal(state.puts.length, 0)
  })

  await t.test('B5 a corrupt existing value is replaced, not fatal', async () => {
    const { state, fetchImpl } = fakeKv('not json')
    await recordBlocked(['222'], { ...CREDS, fetchImpl })
    assert.deepEqual(JSON.parse(state.value), ['222'])
  })

  await t.test('B6 missing credentials degrade quietly instead of throwing', async () => {
    // Queuing is best-effort: the send already succeeded for everyone
    // reachable, and a misconfigured runner must not fail the job over it.
    const r = await recordBlocked(['222'], { accountId: '', apiToken: '', namespaceId: '' })
    assert.deepEqual(r.recorded, [])
  })
})
