// Unit tests for the news-search helpers (shared/news-queries.mjs). The fetch
// itself is exercised by running scripts/fetch-news.mjs; what is testable here
// is the part that decides which stories reach the model and how they read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEWS_QUERIES, dedupeStories, formatStories, recencyTbs, storyKey } from './news-queries.mjs'

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

test('formatStories says so plainly when the search came back empty', () => {
  // The model must be able to tell "nothing was found" from "here is a list",
  // or it will compose a briefing out of an empty section header.
  assert.match(formatStories([]), /No candidate stories/)
})
