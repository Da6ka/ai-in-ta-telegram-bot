// Guards on the search allowlist (shared/source-allowlist.mjs). A malformed
// entry here does not fail loudly -- it silently makes a source invisible to
// every future briefing, which reads as a thin news day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_ALLOWLIST } from './source-allowlist.mjs'

test('entries are bare domains: no scheme, no www, no trailing slash', () => {
  for (const entry of SOURCE_ALLOWLIST) {
    assert.doesNotMatch(entry, /^https?:\/\//, `${entry} carries a scheme`)
    assert.doesNotMatch(entry, /^www\./, `${entry} carries a www prefix`)
    assert.doesNotMatch(entry, /\/$/, `${entry} has a trailing slash`)
    assert.equal(entry, entry.toLowerCase(), `${entry} is not lowercase`)
    assert.match(entry, /^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/, `${entry} is not a plain domain`)
  }
})

test('no duplicates', () => {
  assert.equal(new Set(SOURCE_ALLOWLIST).size, SOURCE_ALLOWLIST.length)
})

test('the list stays short enough for the search tool to accept', () => {
  // The web search tool rejects an over-long domain filter outright
  // (request_too_large). Well under any plausible limit, and a nudge to
  // replace dead entries rather than append forever.
  assert.ok(SOURCE_ALLOWLIST.length <= 50, `${SOURCE_ALLOWLIST.length} entries is getting long`)
  assert.ok(SOURCE_ALLOWLIST.length >= 10, 'a list this short would starve the briefing')
})

test('the beats the prompt requires each have at least one source', () => {
  const has = (d) => SOURCE_ALLOWLIST.includes(d)
  assert.ok(has('anthropic.com') || has('claude.com'), 'the Claude & Anthropic section needs a primary source')
  assert.ok(has('prnewswire.com') || has('businesswire.com'), 'funding and vendor news land on the wires')
  assert.ok(has('shrm.org') || has('hrdive.com') || has('ere.net'), 'the TA trade press is the core beat')
  assert.ok(has('eeoc.gov') || has('natlawreview.com'), 'the regulation beat needs a source')
})
