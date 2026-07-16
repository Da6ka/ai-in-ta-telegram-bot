// Unit tests for the wiki raw-source layer (shared/wiki-sources.mjs).
// Pure functions only -- the fs-touching helpers are exercised end-to-end by
// scripts/backfill-wiki-sources.mjs, whose output is verified against the
// committed corpus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBullet, sourceRecordId, monthFileFor, buildRecords, mergeRecords, pendingRecords, pendingCount, INGEST_BATCH_LIMIT } from './wiki-sources.mjs'

const bullet = (url, headline = 'Thing happened') =>
  `- **${headline}**, some prose about it. ([Source Title](${url})) (16 July 2026)`

test('parseBullet pulls headline, link title, url and bare domain', () => {
  const r = parseBullet(bullet('https://www.prweb.com/releases/clearco-agents'))
  assert.equal(r.headline, 'Thing happened')
  assert.equal(r.source_title, 'Source Title')
  assert.equal(r.url, 'https://www.prweb.com/releases/clearco-agents')
  assert.equal(r.domain, 'prweb.com') // www. stripped
})

test('parseBullet returns null headline for a bullet with no bold span', () => {
  // ~1/3 of the backfilled corpus looks like this (earlier editorial style).
  // The record must still be archived -- bullet text is the source of truth.
  const r = parseBullet('- Skills-based hiring is displacing resumes ([SHRM](https://www.shrm.org/x))')
  assert.equal(r.headline, null)
  assert.equal(r.url, 'https://www.shrm.org/x')
  assert.equal(r.domain, 'shrm.org')
})

test('parseBullet survives a bullet with no link at all', () => {
  const r = parseBullet('- **Orphan** with no source.')
  assert.deepEqual(r, { headline: 'Orphan', source_title: null, url: null, domain: null })
})

test('parseBullet takes the first link when a bullet cites several', () => {
  const r = parseBullet('- **X** ([A](https://a.com/1)) and ([B](https://b.com/2))')
  assert.equal(r.url, 'https://a.com/1')
  assert.equal(r.domain, 'a.com')
})

test('sourceRecordId ignores query/hash so a restated URL is one story', () => {
  const a = { date: '2026-07-16', bullet: bullet('https://a.com/story?utm_source=x#top') }
  const b = { date: '2026-07-16', bullet: bullet('https://a.com/story', 'Reworded entirely') }
  assert.equal(sourceRecordId(a), sourceRecordId(b))
})

test('sourceRecordId separates the same story on different dates', () => {
  // Cross-day restates are two records on purpose -- the raw layer records
  // what was published, collapsing them is the wiki layer's job.
  const a = { date: '2026-07-16', bullet: bullet('https://a.com/story') }
  const b = { date: '2026-07-17', bullet: bullet('https://a.com/story') }
  assert.notEqual(sourceRecordId(a), sourceRecordId(b))
})

test('sourceRecordId falls back to bullet text when there is no URL', () => {
  const a = { date: '2026-07-16', bullet: '- **No link** here.' }
  assert.equal(sourceRecordId(a), '2026-07-16|- **No link** here.')
})

test('monthFileFor buckets by month', () => {
  assert.equal(monthFileFor('2026-07-16'), 'wiki/sources/2026-07.jsonl')
  assert.equal(monthFileFor('2026-12-01'), 'wiki/sources/2026-12.jsonl')
})

test('buildRecords stamps date and provenance on every record', () => {
  const recs = buildRecords('2026-07-16', [bullet('https://a.com/1'), bullet('https://b.com/2')], 'workflow')
  assert.equal(recs.length, 2)
  assert.ok(recs.every((r) => r.date === '2026-07-16' && r.recovered_from === 'workflow'))
  assert.equal(recs[0].domain, 'a.com')
})

test('mergeRecords keeps the first wording of a same-day restate', () => {
  const existing = buildRecords('2026-07-16', [bullet('https://a.com/1', 'Original')], 'workflow')
  const incoming = buildRecords('2026-07-16', [bullet('https://a.com/1', 'Reworded'), bullet('https://b.com/2')], 'workflow')
  const merged = mergeRecords(existing, incoming)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].headline, 'Original')
})

test('mergeRecords handles empty sides', () => {
  const incoming = buildRecords('2026-07-16', [bullet('https://a.com/1')], 'workflow')
  assert.equal(mergeRecords([], incoming).length, 1)
  assert.equal(mergeRecords(incoming, []).length, 1)
  assert.equal(mergeRecords(undefined, undefined).length, 0)
})

test('pendingRecords excludes ids already ingested', () => {
  const recs = buildRecords('2026-07-16', [bullet('https://a.com/1'), bullet('https://b.com/2')], 'workflow')
  const state = { ingested: [sourceRecordId(recs[0])] }
  const pending = pendingRecords(recs, state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].domain, 'b.com')
})

test('pendingRecords catches an on-demand story added after the day was ingested', () => {
  // The reason ingest tracks ids, not a high-water-mark date: /newbriefing can
  // append records for a date the daily ingest already processed. A date
  // watermark would silently skip them forever.
  const daily = buildRecords('2026-07-16', [bullet('https://a.com/1')], 'workflow')
  const state = { ingested: daily.map(sourceRecordId) }
  const later = buildRecords('2026-07-16', [bullet('https://late.com/9')], 'workflow')
  const pending = pendingRecords([...daily, ...later], state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].domain, 'late.com')
})

test('pendingRecords returns everything on a cold start', () => {
  const recs = buildRecords('2026-07-16', [bullet('https://a.com/1')], 'workflow')
  assert.equal(pendingRecords(recs, { ingested: [] }).length, 1)
  assert.equal(pendingRecords(recs, undefined).length, 1)
})

test('pendingRecords caps the batch, oldest first', () => {
  // A backlog too big for --max-budget-usd would fail the step, leave
  // everything pending, and hand the next run the same too-big batch forever.
  const recs = Array.from({ length: 40 }, (_, i) => ({ date: '2026-07-16', bullet: bullet(`https://a.com/${i}`) }))
  const pending = pendingRecords(recs, { ingested: [] }, 25)
  assert.equal(pending.length, 25)
  assert.equal(pending[0].bullet, recs[0].bullet) // oldest first
})

test('pendingRecords defaults to INGEST_BATCH_LIMIT', () => {
  const recs = Array.from({ length: INGEST_BATCH_LIMIT + 5 }, (_, i) => ({ date: '2026-07-16', bullet: bullet(`https://a.com/${i}`) }))
  assert.equal(pendingRecords(recs, { ingested: [] }).length, INGEST_BATCH_LIMIT)
})

test('pendingRecords with limit 0 returns the whole backlog', () => {
  const recs = Array.from({ length: 40 }, (_, i) => ({ date: '2026-07-16', bullet: bullet(`https://a.com/${i}`) }))
  assert.equal(pendingRecords(recs, { ingested: [] }, 0).length, 40)
})

test('pendingCount reports the backlog, ignoring the cap', () => {
  const recs = Array.from({ length: 40 }, (_, i) => ({ date: '2026-07-16', bullet: bullet(`https://a.com/${i}`) }))
  assert.equal(pendingCount(recs, { ingested: [] }), 40)
  assert.equal(pendingRecords(recs, { ingested: [] }, 25).length, 25)
})

test('a capped backlog drains across runs', () => {
  const recs = Array.from({ length: 30 }, (_, i) => ({ date: '2026-07-16', bullet: bullet(`https://a.com/${i}`) }))
  const first = pendingRecords(recs, { ingested: [] }, 25)
  const state = { ingested: first.map(sourceRecordId) }
  const second = pendingRecords(recs, state, 25)
  assert.equal(second.length, 5)
  assert.equal(pendingCount(recs, state), 5)
})
