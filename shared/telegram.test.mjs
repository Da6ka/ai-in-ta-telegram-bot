// Unit tests for the resilient Telegram send helpers (shared/telegram.mjs).
// fetch is mocked; paceMs/baseDelayMs are set to 0 so the suite stays fast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tgRequest, sendHtml, sendHtmlToMany, sendTextToMany, isValidBriefing, countBriefingItems, MIN_BRIEFING_ITEMS, extractBriefingBullets, pruneRecentStories, RECENT_STORIES_WINDOW_DAYS, recentStoryBullets, MAX_RECENT_STORY_BULLETS, bulletUrlKey, dedupeBullets, normalizeBriefing, isLowBalanceError, applyBriefingToUsageStats, briefingDomain, bulletLooksDated } from './telegram.mjs'

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
  // Leading/trailing whitespace around the header line is still fine.
  assert.equal(isValidBriefing('\n\n' + good), true)

  // The exact failure modes that poisoned the cache (all zero-exit):
  assert.equal(isValidBriefing("I'm sorry, but I can't complete that request."), false, 'LLM refusal rejected')
  assert.equal(isValidBriefing(''), false, 'empty generation rejected')
  assert.equal(isValidBriefing('# Some Other Title\n\ncontent'), false, 'wrong header rejected')
  assert.equal(isValidBriefing('# Daily AI Recruitment Briefing —\n'), false, 'header with no title text rejected')
  assert.equal(isValidBriefing(null), false, 'null rejected, no throw')
  assert.equal(isValidBriefing(undefined), false, 'undefined rejected, no throw')
  // The prompt requires no preamble (see briefing-prompt.md) -- a refusal that
  // quotes the expected title format as an example further down the document
  // must not pass just because the string matches somewhere in the body.
  assert.equal(
    isValidBriefing('I cannot generate this. Example format:\n\n' + good),
    false,
    'header only valid on the first line, not quoted later in a refusal',
  )
})

// TITLE_DASH regression: a model drifting onto a visually similar dash
// character (en dash, plain hyphen) instead of the prompt-specified em dash
// still produces a perfectly usable briefing and must not be rejected
// identically to a genuinely malformed title.
test('isValidBriefing tolerates en dash and hyphen title separators, not just em dash', () => {
  assert.equal(isValidBriefing('# Daily AI Recruitment Briefing \u2013 2 July 2026\n\n- [Story](https://ex.com)'), true, 'en dash accepted')
  assert.equal(isValidBriefing('# Daily AI Recruitment Briefing - 2 July 2026\n\n- [Story](https://ex.com)'), true, 'hyphen accepted')
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

// Regression: update-recent-stories.mjs must dedupe same-day reruns by story
// (URL), not exact bullet text -- a rephrasing or a second source domain for
// the same story used to produce two bullets in one day's entry.
test('bulletUrlKey normalizes to host+path, ignoring query/hash/trailing slash', () => {
  assert.equal(bulletUrlKey('- **A** thing. [Src](https://ex1.com/a?utm=x#y)'), 'ex1.com/a')
  assert.equal(bulletUrlKey('- **A** thing. [Src](https://ex1.com/a/)'), 'ex1.com/a')
  assert.equal(bulletUrlKey('- no link here'), null)
})

test('dedupeBullets collapses reruns of the same story (same URL, different wording) and keeps the first wording', () => {
  const first = '- **Claude launch** happened today. [Src](https://ex1.com/a)'
  const reworded = '- **Claude Sonnet 5 ships** — different phrasing. [Src](https://ex1.com/a)'
  const distinct = '- **Different story** entirely. [Src2](https://ex2.com/b)'
  assert.deepEqual(dedupeBullets([first, reworded, distinct]), [first, distinct])
  assert.deepEqual(dedupeBullets([]), [])
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

// Regression: a single heavy-testing day can merge dozens of bullets into
// one date entry (caught live, 2026-07-04: one day alone produced 60). Fed
// unbounded into the generation prompt, that's thousands of extra tokens on
// every future run -- risking the same --max-budget-usd overrun PR #19 just
// fixed. recentStoryBullets must cap the total regardless of how it's
// distributed across days, keeping the most recent ones.
test('recentStoryBullets caps the total and keeps the most recent bullets', () => {
  const entries = [
    { date: '2026-06-25', bullets: Array.from({ length: 30 }, (_, i) => `- old ${i}`) },
    { date: '2026-07-04', bullets: ['- newest 1', '- newest 2'] },
  ]
  const bullets = recentStoryBullets(entries, '2026-07-04')
  assert.equal(bullets.length, MAX_RECENT_STORY_BULLETS)
  assert.deepEqual(bullets.slice(-2), ['- newest 1', '- newest 2'], 'most recent day\'s bullets survive the cap')
})

test('recentStoryBullets returns everything when under the cap', () => {
  const entries = [{ date: '2026-07-04', bullets: ['- a', '- b'] }]
  assert.deepEqual(recentStoryBullets(entries, '2026-07-04'), ['- a', '- b'])
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


test('normalizeBriefing strips model preamble before the title', () => {
  const md = [
    "I have three solid, date-verified items across distinct beats, so I'm omitting the Claude section.",
    '',
    '# Daily AI Recruitment Briefing — 13 July 2026',
    '',
    "## AI in Recruitment — What's New",
    '- [Story](https://ex.com/a) something',
  ].join('\n')
  const { content, preambleStripped, dateChanged } = normalizeBriefing(md, '13 July 2026')
  assert.ok(content.startsWith('# Daily AI Recruitment Briefing — 13 July 2026'), 'title is first line')
  assert.ok(!content.includes('date-verified items'), 'preamble removed')
  assert.equal(preambleStripped, true)
  assert.equal(dateChanged, false)
})

test('normalizeBriefing forces a wrong title date to today', () => {
  const md = '# Daily AI Recruitment Briefing — 1 July 2026\n\n- [S](https://e.com/x) y'
  const { content, dateChanged, preambleStripped } = normalizeBriefing(md, '13 July 2026')
  assert.ok(content.startsWith('# Daily AI Recruitment Briefing — 13 July 2026'))
  assert.equal(dateChanged, true)
  assert.equal(preambleStripped, false)
})

test('normalizeBriefing strips preamble AND forces date together', () => {
  const md = 'here is your briefing:\n\n# Daily AI Recruitment Briefing — 12 July 2026\n\n- [S](https://e.com/x) y'
  const { content, preambleStripped, dateChanged } = normalizeBriefing(md, '13 July 2026')
  assert.ok(content.startsWith('# Daily AI Recruitment Briefing — 13 July 2026'))
  assert.ok(!content.includes('here is your briefing'))
  assert.equal(preambleStripped, true)
  assert.equal(dateChanged, true)
})

test('normalizeBriefing leaves a clean, correctly-dated briefing untouched', () => {
  const md = '# Daily AI Recruitment Briefing — 13 July 2026\n\n- [S](https://e.com/x) y\n'
  const { content, preambleStripped, dateChanged } = normalizeBriefing(md, '13 July 2026')
  assert.equal(content, md)
  assert.equal(preambleStripped, false)
  assert.equal(dateChanged, false)
})

test('normalizeBriefing returns untitled content unchanged (freshness gate rejects it)', () => {
  const md = 'Sorry, all three searches failed today.'
  const { content, preambleStripped, dateChanged } = normalizeBriefing(md, '13 July 2026')
  assert.equal(content, md)
  assert.equal(preambleStripped, false)
  assert.equal(dateChanged, false)
})


// --- Generation-pipeline helpers extracted from the delivery scripts ---

test('isLowBalanceError matches only the low-credit body, not unrelated errors', () => {
  assert.equal(isLowBalanceError('{"type":"error","error":{"message":"Your credit balance is too low to access the API."}}'), true)
  assert.equal(isLowBalanceError('CREDIT BALANCE IS TOO LOW'), true)
  assert.equal(isLowBalanceError('{"error":{"type":"rate_limit_error","message":"rate limit"}}'), false)
  assert.equal(isLowBalanceError('overloaded_error'), false)
  assert.equal(isLowBalanceError(''), false)
  assert.equal(isLowBalanceError(null), false)
})

test('applyBriefingToUsageStats increments, stamps the date, and preserves unmanaged fields', () => {
  const existing = {
    briefings_sent: 4,
    last_briefing_at: '2026-07-14',
    briefing_history: [{ date: '2026-07-14', recipients: 9 }],
    command_counts: { briefing: 3 },
    last_seen: { '1': '2026-07-14' },
  }
  const out = applyBriefingToUsageStats(existing, { today: '2026-07-15', recipients: 12 })
  assert.equal(out.briefings_sent, 5)
  assert.equal(out.last_briefing_at, '2026-07-15')
  assert.deepEqual(out.briefing_history.at(-1), { date: '2026-07-15', recipients: 12 })
  assert.deepEqual(out.command_counts, { briefing: 3 })
  assert.deepEqual(out.last_seen, { '1': '2026-07-14' })
  // input object is not mutated
  assert.equal(existing.briefings_sent, 4)
  assert.equal(existing.briefing_history.length, 1)
})

test('applyBriefingToUsageStats caps history at the last 30 editions', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, recipients: i }))
  const out = applyBriefingToUsageStats({ briefings_sent: 30, briefing_history: history }, { today: '2026-07-15', recipients: 1 })
  assert.equal(out.briefing_history.length, 30)
  assert.equal(out.briefing_history[0].date, 'd1') // oldest edition dropped
  assert.deepEqual(out.briefing_history.at(-1), { date: '2026-07-15', recipients: 1 })
})

test('applyBriefingToUsageStats seeds a fresh stats object from null/undefined', () => {
  const out = applyBriefingToUsageStats(undefined, { today: '2026-07-15' })
  assert.equal(out.briefings_sent, 1)
  assert.equal(out.last_briefing_at, '2026-07-15')
  assert.deepEqual(out.briefing_history, [{ date: '2026-07-15', recipients: 0 }])
  assert.deepEqual(out.command_counts, {})
  assert.deepEqual(out.last_seen, {})
})

test('briefingDomain strips a leading www and returns the host; non-URLs pass through', () => {
  assert.equal(briefingDomain('https://www.example.com/path?q=1#x'), 'example.com')
  assert.equal(briefingDomain('https://blog.openai.com/article'), 'blog.openai.com')
  assert.equal(briefingDomain('not a url'), 'not a url')
})

test('bulletLooksDated recognizes in-window ISO dates, month names, and relative phrasing', () => {
  const now = new Date('2026-07-15T12:00:00Z')
  assert.equal(bulletLooksDated('- [x](https://a.co) launched 2026-07-14', now), true) // ISO in window
  assert.equal(bulletLooksDated('- [x](https://a.co) back on 2026-01-01', now), false) // ISO out of window
  assert.equal(bulletLooksDated('- [x](https://a.co) announced in Jul', now), true) // month name
  assert.equal(bulletLooksDated('- [x](https://a.co) shipped today', now), true) // relative
  assert.equal(bulletLooksDated('- [x](https://a.co) with no recognizable signal', now), false)
})
