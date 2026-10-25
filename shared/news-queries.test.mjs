// Unit tests for the news-search helpers (shared/news-queries.mjs). The fetch
// itself is exercised by running scripts/fetch-news.mjs; what is testable here
// is the part that decides which stories reach the model and how they read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEWS_QUERIES, dedupeStories, formatStories, recencyTbs, storyKey, urlDateTooOld, widerWindow } from './news-queries.mjs'

test('the query set covers every beat the prompt asks for', () => {
  assert.ok(NEWS_QUERIES.length >= 8, 'thin query sets produce thin briefings')
  const all = NEWS_QUERIES.join(' | ').toLowerCase()
  for (const beat of ['claude', 'regulation', 'funding', 'ats', 'lawsuit']) {
    assert.ok(all.includes(beat), `no query covers the ${beat} beat`)
  }
  assert.equal(new Set(NEWS_QUERIES).size, NEWS_QUERIES.length, 'a duplicated query is a wasted search')
})

test('recencyTbs: a day window only for a same-day rerun, otherwise a week', () => {
  assert.equal(recencyTbs(24), 'qdr:d')
  assert.equal(recencyTbs(48), 'qdr:w')
  assert.equal(recencyTbs(96), 'qdr:w')
})

test('widerWindow climbs the ladder once and then stops', () => {
  assert.equal(widerWindow('qdr:d'), 'qdr:w')
  assert.equal(widerWindow('qdr:w'), 'qdr:m')
  // A month is the last rung: without a null here the on-demand path would
  // sweep a second time at the same window and pay for it twice.
  assert.equal(widerWindow('qdr:m'), null)
  assert.equal(widerWindow('qdr:y'), null, 'an unknown window has no known next step')
  assert.equal(widerWindow(undefined), null)
})

test('storyKey ignores www, query strings and trailing slashes', () => {
  assert.equal(storyKey('https://www.example.com/a/'), storyKey('https://example.com/a?utm_source=x'))
  assert.notEqual(storyKey('https://example.com/a'), storyKey('https://example.com/b'))
})

test('storyKey survives a malformed url instead of throwing', () => {
  assert.equal(storyKey('not a url'), 'not a url')
  assert.equal(storyKey(undefined), '')
})

test('dedupeStories keeps first occurrence and drops incomplete entries', () => {
  const out = dedupeStories([
    { title: 'A', url: 'https://example.com/a' },
    { title: 'A again', url: 'https://www.example.com/a?ref=2' },
    { title: 'B', url: 'https://other.com/b' },
    { title: 'no url' },
    { url: 'https://example.com/no-title' },
  ])
  assert.deepEqual(
    out.map((s) => s.title),
    ['A', 'B'],
  )
})

test('dedupeStories respects the cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ title: `S${i}`, url: `https://e.com/${i}` }))
  assert.equal(dedupeStories(many, 3).length, 3)
})

test('formatStories renders a numbered, dated, linked list', () => {
  const block = formatStories([{ title: 'Headline', url: 'https://e.com/x', date: '2 days ago', snippet: 'Body  text' }])
  assert.match(block, /1\. Headline \(2 days ago\)/)
  assert.match(block, /https:\/\/e\.com\/x/)
  assert.match(block, /Body text/, 'whitespace in snippets is collapsed')
})

test('formatStories strips markdown so the snippet budget goes to text', () => {
  // Shape of the ERE result Firecrawl returned for the 2026-10-24 edition.
  const snippet =
    '# Inside Anthropic\n## Employees shift to managing agents, hiring managers prioritize judgment over expertise.\n' +
    '- [Artificial Intelligence](https://www.ere.net/categories/artificial-intelligence)\n\n' +
    '![Article main image](https://www.ere.net/_next/image?url=https%3A%2F%2Fapi.eremedia.com%2Fa.jpg&w=3840&q=75)\n\n' +
    'By [David Manaster](https://www.ere.net/authors/david-manaster)\n\nThe report is a **marketing document**.'
  const block = formatStories([{ title: 'Inside Anthropic', url: 'https://www.ere.net/a', snippet }])
  assert.doesNotMatch(block, /\]\(|!\[|^\s*#/m, 'no link, image or heading markup left')
  assert.match(block, /judgment over expertise\. Artificial Intelligence By David Manaster The report is a marketing document\./)
})

test('formatStories says so plainly when the search came back empty', () => {
  // The model must be able to tell "nothing was found" from "here is a list",
  // or it will compose a briefing out of an empty section header.
  assert.match(formatStories([]), /No candidate stories/)
})

test('urlDateTooOld drops a story whose own URL dates it outside the window', () => {
  const today = '2026-10-25'
  assert.equal(urlDateTooOld('https://e.com/2025/08/22/survey/', 'qdr:w', today), true, 'a year-old article')
  assert.equal(urlDateTooOld('https://e.com/2026/10/10/x', 'qdr:w', today), true)
  assert.equal(urlDateTooOld('https://e.com/2026/10/10/x', 'qdr:m', today), false, 'the widened window allows it')
  assert.equal(urlDateTooOld('https://e.com/2026/10/18/x', 'qdr:w', today), false, 'seven days back plus slack')
  assert.equal(urlDateTooOld('https://e.com/2026/09/story', 'qdr:w', today), true, 'month-only, counted from 30 Sep')
  assert.equal(urlDateTooOld('https://e.com/2026/10/story', 'qdr:w', today), false, 'month-only, this month')
  assert.equal(urlDateTooOld('https://www.hrdive.com/news/ai-survey/', 'qdr:w', today), false, 'no date in the URL')
  assert.equal(urlDateTooOld('https://e.com/products/2025-model', 'qdr:w', today), false)
  assert.equal(urlDateTooOld('not a url', 'qdr:w', today), false)
})
