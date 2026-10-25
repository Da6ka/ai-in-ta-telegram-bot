// sync-kv.mjs must keep CI's briefing counters out of `usage_stats`: that blob
// holds the per-user data /forgetme erases, and a CI write could undo an erasure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve('scripts/sync-kv.mjs')
const PRELOAD = resolve('test/fixtures/fake-kv-fetch.mjs')
const BRIEFING = '# Daily AI Recruitment Briefing - 25 Oct 2026\n\n- [One](https://a.example/1) item\n- [Two](https://b.example/2) item\n- [Three](https://c.example/3) item\n'

function runSync(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-kv-'))
  mkdirSync(join(dir, 'state'))
  writeFileSync(join(dir, 'state/today_briefing.md'), BRIEFING)
  const out = join(dir, 'puts.json')
  const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't', CF_KV_NAMESPACE_ID: 'n',
      RECIPIENT_COUNT: '7', BRIEFING_DATE_ISO: '2026-10-25',
      FAKE_KV_SEED: JSON.stringify(seed), FAKE_KV_PUTS: out,
    },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(readFileSync(out, 'utf8'))
}

test('sync-kv never writes usage_stats; counters go to briefing_stats seeded from the old blob', () => {
  const old = { briefings_sent: 4, last_briefing_at: '2026-10-24', briefing_history: [{ date: '2026-10-24', recipients: 5 }], last_seen: { 111: '2026-10-24' } }
  const { puts, store } = runSync({ usage_stats: JSON.stringify(old) })
  assert.ok(!puts.includes('usage_stats'), 'CI must not write usage_stats')
  const stats = JSON.parse(store.briefing_stats)
  assert.equal(stats.briefings_sent, 5)
  assert.equal(stats.last_briefing_at, '2026-10-25')
  assert.deepEqual(stats.briefing_history.at(-1), { date: '2026-10-25', recipients: 7 })
  assert.ok(!('last_seen' in stats), 'no per-user data in the CI-owned key')
  assert.equal(store.usage_stats, JSON.stringify(old), 'usage_stats untouched')
})

test('sync-kv continues from briefing_stats once it exists', () => {
  const { store } = runSync({ briefing_stats: JSON.stringify({ briefings_sent: 9, last_briefing_at: '2026-10-24', briefing_history: [] }), usage_stats: JSON.stringify({ briefings_sent: 1 }) })
  assert.equal(JSON.parse(store.briefing_stats).briefings_sent, 10)
})
