// Unit tests for the resilient Telegram send helpers (shared/telegram.mjs).
// fetch is mocked; paceMs/baseDelayMs are set to 0 so the suite stays fast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tgRequest, sendHtml, sendHtmlToMany, sendTextToMany, isValidBriefing, countBriefingItems, MIN_BRIEFING_ITEMS, extractBriefingBullets, pruneRecentStories, RECENT_STORIES_WINDOW_DAYS } from './telegram.mjs'

const realFetch = globalThis.fetch
function mockFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null })
    return handler(calls.length, { url: String(url), opts })
  }
  return calls
}
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const tg = (n) => new Response('x', { status: n })

test('tgRequest retries 429 honoring Retry-After (seconds), then succeeds', async () => {
  const calls = mockFetch((n) => n === 1
    ? new Response('rate', { status: 429, headers: { 'retry-after': '0' } })
    : ok())
  try {
    const res = await tgRequest('T', 'sendMessage', { chat_id: 1, text: 'hi' }, { baseDelayMs: 0 })
    assert.equal(res.status, 200)
    assert.equal(calls.length, 2, 'one retry')
  } finally { globalThis.fetch = realFetch }
})

test('tgRequest retries 5xx then gives up returning the last response', async () => {
  const calls = mockFetch(() => tg(500))
  try {
    const res = await tgRequest('T', 'sendMessage', {}, { retries: 2, baseDelayMs: 0 })
    assert.equal(res.status, 500)
    assert.equal(calls.length, 3, 'initial + 2 retries')
  } finally { globalThis.fetch = realFetch }
})

test('tgRequest does not retry a 4xx (other than 429)', async () => {
  const calls = mockFetch(() => tg(403))
  try {
    const res = await tgRequest('T', 'sendMessage', {}, { retries: 3, baseDelayMs: 0 })
    assert.equal(res.status, 403)
    assert.equal(calls.length, 1, 'no retry on 403')
  } finally { globalThis.fetch = realFetch }
})

test('tgRequest retries a thrown network error then rethrows', async () => {
  let n = 0
  globalThis.fetch = async () => { n++; throw new TypeError('connection reset') }
  try {
    await assert.rejects(() => tgRequest('T', 'sendMessage', {}, { retries: 1, baseDelayMs: 0 }))
    assert.equal(n, 2, 'initial + 1 retry')
  } finally { globalThis.fetch = realFetch }
})

test('sendHtml chunks a long message into multiple valid sends', async () => {
  const calls = mockFetch(() => ok())
  try {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const okAll = await sendHtml('T', 42, long, { retries: 0 })
    assert.ok(okAll)
    assert.ok(calls.length >= 2, 'chunked into ' + calls.length)
    for (const c of calls) {
      assert.equal(c.body.parse_mode, 'HTML')
      assert.ok(c.body.text.length <= 4000)
    }
  } finally { globalThis.fetch = realFetch }
})

// NEW-1 regression: the guard that stops a garbage generation from being
// synced into the shared KV cache (and served to every user's /briefing).
test('isValidBriefing accepts a real briefing and rejects garbage generations', () => {
  const good = '# Daily AI Recruitment Briefing — 2 July 2026\n\n- [Story](https://ex.com)'
  assert.equal(isValidBriefing(good), true, 'valid dated header accepted')
  // A preamble before the header is still fine — the header line exists.
  assert.equal(isValidBriefing('Here you go!\n\n' + good), true)

  // The exact failure modes that poisoned the cache (all zero-exit):
  assert.equal(isValidBriefing("I'm sorry, but I can't complete that request."), false, 'LLM refusal rejected')
  assert.equal(isValidBriefing(''), false, 'empty generation rejected')
  assert.equal(isValidBriefing('# Some Other Title\n\ncontent'), false, 'wrong header rejected')
  assert.equal(isValidBriefing('# Daily AI Recruitment Briefing —\n'), false, 'header with no title text rejected')
  assert.equal(isValidBriefing(null), false, 'null rejected, no throw')
  assert.equal(isValidBriefing(undefined), false, 'undefined rejected, no throw')
})

// AUD-1 regression: the thin-generation guard. A headered briefing with zero
// or one linked story (the "no content" fallback, or the degenerate 1-story
// run observed in prod on 2026-07-02) must count below MIN_BRIEFING_ITEMS so
// sync-kv.mjs refuses to replace the shared cache with it.
test('countBriefingItems counts only linked story bullets (AUD-1)', () => {
  const header = '# Daily AI Recruitment Briefing — 2 July 2026\n\n## Claude & Anthropic in TA\n'
  const story = (i) => `- **Story ${i}** something happened. [Src ${i}](https://ex${i}.com/a) (30 June)\n`

  const fallback = header.replace(/\n## .*\n$/, '\n') + 'No briefing available today — searches failed or returned nothing usable.\n'
  assert.equal(countBriefingItems(fallback), 0, 'fallback has zero items')
  assert.ok(countBriefingItems(fallback) < MIN_BRIEFING_ITEMS, 'fallback is below the floor')

  const oneStory = header + story(1)
  assert.equal(countBriefingItems(oneStory), 1)
  assert.ok(countBriefingItems(oneStory) < MIN_BRIEFING_ITEMS, '1-story generation is below the floor')

  const full = header + story(1) + story(2) + '\n## Worth Reading\n' + story(3)
  assert.equal(countBriefingItems(full), 3)
  assert.ok(countBriefingItems(full) >= MIN_BRIEFING_ITEMS)

  // Bullets without links (padding/filler) don't count as stories.
  assert.equal(countBriefingItems(header + '- a linkless bullet\n- another one\n'), 0)
  // Robust to non-string input like isValidBriefing.
  assert.equal(countBriefingItems(null), 0)
  assert.equal(countBriefingItems(undefined), 0)
})

test('extractBriefingBullets returns the raw linked bullet lines', () => {
  const md = '# Daily AI Recruitment Briefing — 4 July 2026\n\n## Claude & Anthropic in TA\n- **A** thing happened. [Src](https://ex1.com/a) (30 June)\n- a linkless bullet\n\n## Worth Reading\n- **B** thing happened. [Src2](https://ex2.com/b) (1 July)\n'
  assert.deepEqual(extractBriefingBullets(md), [
    '- **A** thing happened. [Src](https://ex1.com/a) (30 June)',
    '- **B** thing happened. [Src2](https://ex2.com/b) (1 July)',
  ])
  assert.deepEqual(extractBriefingBullets(null), [])
})

// Regression for the repeat-story bug: the Claude Sonnet 5 launch (30 June)
// ran in both the 2026-07-03 and 2026-07-04 editions because nothing tracked
// what a prior edition had already covered.
test('pruneRecentStories keeps entries within the window and drops older/future ones', () => {
  const entries = [
    { date: '2026-06-20', bullets: ['- too old'] },
    { date: '2026-06-25', bullets: ['- just inside the 14-day window'] },
    { date: '2026-07-04', bullets: ['- today'] },
    { date: '2026-07-05', bullets: ['- future, should never happen but must not crash'] },
  ]
  const kept = pruneRecentStories(entries, '2026-07-04', RECENT_STORIES_WINDOW_DAYS)
  assert.deepEqual(kept.map((e) => e.date), ['2026-06-25', '2026-07-04'])
})

test('sendTextToMany sends plain text (no parse_mode) so HTML is delivered verbatim', async () => {
  const calls = mockFetch(() => ok())
  try {
    await sendTextToMany('T', ['1', '2'], '<b>bold</b> & stuff', { paceMs: 0, retries: 0 })
    assert.equal(calls.length, 2)
    for (const c of calls) {
      assert.equal(c.body.parse_mode, undefined, 'plain text, not HTML')
      assert.equal(c.body.text, '<b>bold</b> & stuff', 'delivered verbatim')
    }
  } finally { globalThis.fetch = realFetch }
})

test('sendTextToMany continues past a blocked recipient and counts the failure (R4)', async () => {
  // Recipient "2" is a blocked bot (403); the fan-out must not stop there.
  const calls = mockFetch((_n, { opts }) => {
    const b = JSON.parse(opts.body)
    return String(b.chat_id) === '2' ? tg(403) : ok()
  })
  try {
    const errs = []
    const { total, failed } = await sendTextToMany('T', ['1', '2', '3'], 'hi', {
      paceMs: 0, retries: 0, onError: (id) => errs.push(id),
    })
    assert.equal(total, 3)
    assert.equal(failed, 1)
    assert.deepEqual(errs, ['2'])
    assert.equal(calls.length, 3, 'all three attempted despite the middle failure')
  } finally { globalThis.fetch = realFetch }
})

test('sendHtmlToMany paces all recipients and counts failures', async () => {
  // Recipient "2" fails; the loop must continue and report failed:1.
  const calls = mockFetch((_n, { opts }) => {
    const b = JSON.parse(opts.body)
    return String(b.chat_id) === '2' ? tg(403) : ok()
  })
  try {
    const errs = []
    const { total, failed } = await sendHtmlToMany('T', ['1', '2', '3'], 'short', {
      paceMs: 0, retries: 0, onError: (id) => errs.push(id),
    })
    assert.equal(total, 3)
    assert.equal(failed, 1)
    assert.deepEqual(errs, ['2'])
    assert.equal(calls.length, 3, 'all three attempted despite the middle failure')
  } finally { globalThis.fetch = realFetch }
})
