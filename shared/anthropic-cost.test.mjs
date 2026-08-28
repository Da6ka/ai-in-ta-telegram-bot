// Unit tests for the cost arithmetic (shared/anthropic-cost.mjs). The numbers
// this produces are the whole basis for deciding whether a generation engine
// is cheaper, so a silent arithmetic error here would be worse than no log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateCostUsd,
  sumUsage,
  webSearchCount,
  MODEL_PRICES_USD_PER_MTOK,
  WEB_SEARCH_USD_PER_CALL,
} from './anthropic-cost.mjs'

test('estimateCostUsd: tokens priced per million, per model rate', () => {
  // 1M input + 1M output on Opus 4.8 = $5 + $25.
  assert.equal(estimateCostUsd('claude-opus-4-8', { input_tokens: 1e6, output_tokens: 1e6 }), 30)
  assert.equal(estimateCostUsd('claude-sonnet-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12)
})

test('estimateCostUsd: web searches bill on top of tokens', () => {
  const withSearches = estimateCostUsd('claude-opus-4-8', {
    input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 10 },
  })
  assert.equal(withSearches, 10 * WEB_SEARCH_USD_PER_CALL)
})

test('estimateCostUsd: cache reads are a tenth of input, writes 1.25x', () => {
  const rate = MODEL_PRICES_USD_PER_MTOK['claude-opus-4-8'].input
  assert.equal(estimateCostUsd('claude-opus-4-8', { cache_read_input_tokens: 1e6 }), rate * 0.1)
  assert.equal(estimateCostUsd('claude-opus-4-8', { cache_creation_input_tokens: 1e6 }), rate * 1.25)
})

test('estimateCostUsd: a realistic run lands in cents, not dollars', () => {
  const cost = estimateCostUsd('claude-opus-4-8', {
    input_tokens: 45_000,
    output_tokens: 6_000,
    server_tool_use: { web_search_requests: 8 },
  })
  // 45k in ($0.225) + 6k out ($0.15) + 8 searches ($0.08).
  assert.equal(cost, 0.455)
})

test('estimateCostUsd: an unknown model reports null, never a made-up price', () => {
  assert.equal(estimateCostUsd('claude-some-future-model', { input_tokens: 1e6 }), null)
})

test('estimateCostUsd: missing usage fields count as zero', () => {
  assert.equal(estimateCostUsd('claude-opus-4-8', {}), 0)
  assert.equal(estimateCostUsd('claude-opus-4-8'), 0)
})

test('sumUsage: accumulates tokens and searches across paused turns', () => {
  const a = { input_tokens: 10, output_tokens: 2, server_tool_use: { web_search_requests: 3 } }
  const b = { input_tokens: 5, output_tokens: 1, server_tool_use: { web_search_requests: 4 } }
  const total = sumUsage(a, b)
  assert.equal(total.input_tokens, 15)
  assert.equal(total.output_tokens, 3)
  assert.equal(webSearchCount(total), 7)
})

test('sumUsage: an empty accumulator is a valid starting point', () => {
  const total = sumUsage({}, { input_tokens: 7, output_tokens: 1 })
  assert.equal(total.input_tokens, 7)
  assert.equal(webSearchCount(total), 0)
  assert.equal(estimateCostUsd('claude-opus-4-8', total), 0.00006)
})
