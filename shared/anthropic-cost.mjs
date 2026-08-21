// What a generation run actually cost, computed from the API's own usage
// numbers.
//
// The `claude -p` path could not answer this: it printed the briefing and
// nothing else, so per-run spend was only ever inferred from the monthly
// Console total and from which --max-budget-usd ceiling a run had blown
// through (raised 1 -> 2 -> 4 over three incidents, each time after a failure
// rather than after a measurement). Every direct API response carries `usage`,
// so the number is exact and lands in state/cost_log.jsonl next to the edition
// it paid for.
//
// Prices are per million tokens, from the published Claude API rates. They are
// a hardcoded table on purpose: there is no pricing endpoint, and a wrong
// number here is a wrong number in a log nobody re-derives later. Check them
// against https://claude.com/platform/api when adding a model.

export const MODEL_PRICES_USD_PER_MTOK = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

// Server-side web search is billed per search on top of tokens: $10 per 1,000.
// Errored searches are not billed, and the usage counter only counts billed
// ones, so this needs no error accounting of its own.
export const WEB_SEARCH_USD_PER_CALL = 0.01

// Cache reads bill at a tenth of the input rate; cache writes at 1.25x. The
// briefing makes a single request with no reusable prefix, so both are
// normally zero -- they are here so the same helper stays honest if a caller
// ever does cache (e.g. /ask over the wiki corpus).
const CACHE_READ_MULTIPLIER = 0.1
const CACHE_WRITE_MULTIPLIER = 1.25

export function webSearchCount(usage) {
  return usage?.server_tool_use?.web_search_requests ?? 0
}

// Returns null for a model that isn't in the table rather than guessing a
// price. A null in the cost log reads as "unknown"; a fabricated number reads
// as fact and quietly poisons every later comparison.
export function estimateCostUsd(model, usage = {}) {
  const price = MODEL_PRICES_USD_PER_MTOK[model]
  if (!price) return null
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const tokenCost =
    (input * price.input +
      cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * price.input * CACHE_READ_MULTIPLIER +
      output * price.output) /
    1_000_000
  const searchCost = webSearchCount(usage) * WEB_SEARCH_USD_PER_CALL
  return Math.round((tokenCost + searchCost) * 1e6) / 1e6
}

// A turn paused by the server (stop_reason: 'pause_turn') is continued with a
// second request, and each request reports only its own usage. Totals for the
// edition therefore have to be accumulated across turns, or a paused run
// silently logs a fraction of what it cost.
export function sumUsage(a = {}, b = {}) {
  const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
  const out = {}
  for (const k of keys) {
    const total = (a[k] ?? 0) + (b[k] ?? 0)
    if (total > 0 || k in a || k in b) out[k] = total
  }
  const searches = webSearchCount(a) + webSearchCount(b)
  if (searches > 0) out.server_tool_use = { web_search_requests: searches }
  return out
}
