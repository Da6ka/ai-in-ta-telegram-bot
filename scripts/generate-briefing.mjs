// Generates one edition by calling the Messages API directly, as a replacement
// for the `claude -p` agent loop the workflows have used since day one.
//
// Usage:
//   node scripts/generate-briefing.mjs <prompt-file> [note] > state/today_briefing.md
//
// Same contract as the call it replaces: the composed briefing markdown goes to
// stdout, diagnostics to stderr, and nothing else is written except an append
// to the cost log. Post-processing (preamble stripping, date forcing) stays
// where it already lives, in scripts/force-briefing-date.mjs.
//
// Why this exists at all: `claude -p` runs an agent loop that carries every
// web-search result forward in full through every subsequent turn, so a
// six-search edition re-sends the accumulated results five more times. Input
// tokens grow with the square of the research, which is where the bot's money
// went. One direct request with `web_search_20260318` does the same research
// inside a single server-side turn, and dynamic filtering runs the results
// through code before they reach the context window, so only what survives the
// filter is billed. `response_inclusion: 'excluded'` then keeps the raw result
// blocks out of the response, since nothing downstream reads them.
//
// Cost control differs from the old path and is worth understanding before
// changing it. `--max-budget-usd` was a ceiling the CLI enforced mid-run; here
// the pre-emptive limits are BRIEFING_MAX_SEARCHES (searches are billed
// per call) and max_tokens, plus the budget check in the continuation loop
// below. The final total is checked too, but only warns: by the time a
// completed response can be priced, the money is already spent, and failing
// then would throw away an edition that was paid for and is probably fine.
import Anthropic from '@anthropic-ai/sdk'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { estimateCostUsd, sumUsage, webSearchCount } from '../shared/anthropic-cost.mjs'
import { SOURCE_ALLOWLIST, parseInaccessibleDomains } from '../shared/source-allowlist.mjs'
import { countBriefingItems } from '../shared/telegram.mjs'
import { composeBriefingText } from '../shared/briefing-citations.mjs'

const [promptPath, note = ''] = process.argv.slice(2)
if (!promptPath) {
  console.error('usage: node scripts/generate-briefing.mjs <prompt-file> [note]')
  process.exit(2)
}

const MODEL = process.env.BRIEFING_MODEL || 'claude-opus-4-8'
const EFFORT = process.env.BRIEFING_EFFORT || 'medium'
// 12 until the daily send moved to SEARCH_MODE 'none' (below): the prompt
// plans six searches, and the spare six were a thin-day allowance every
// edition paid for -- billed per call, and again as results in context.
// Nothing on the 'none' path reads this; it is the ceiling for whoever takes
// the 'direct' path deliberately.
const MAX_SEARCHES = Number(process.env.BRIEFING_MAX_SEARCHES || 6)
const MAX_TOKENS = Number(process.env.BRIEFING_MAX_TOKENS || 16_000)
const MAX_USD = Number(process.env.BRIEFING_MAX_USD || 4)
const COST_LOG = process.env.BRIEFING_COST_LOG || 'state/cost_log.jsonl'
// 'direct' puts full search results (url, title, page_age) into the model's
// context, the way the CLI's WebSearch tool did. 'filtered' is the cheaper
// dynamic-filtering path, where the model writes code that filters results
// before they reach context. Filtered ran twice on 2026-08-21 and produced the
// prompt's "nothing usable" fallback both times, at both medium and xhigh
// effort, with all ten searches billed and succeeding -- so the results
// arrived and were judged unusable. The prompt drops any story whose publish
// date it cannot verify, which is exactly what would happen if page_age does
// not survive filtering. Default is 'direct' until that is settled.
// 'none' sends no search tool at all: the candidate stories are already in the
// prompt, put there by scripts/fetch-news.mjs. That is the cheap path -- the
// ~250k input tokens an edition costs are raw search results the model pulled
// into its own context, not the writing.
const SEARCH_MODE = process.env.BRIEFING_SEARCH_MODE || 'direct'
// When set, each turn's response blocks are dumped here (minus the multi-KB
// encrypted_content, which is unreadable and not the point). This exists
// because the first two failures were undiagnosable: with results excluded
// from the response there was no way to see what the model was given.
const DEBUG_DIR = process.env.BRIEFING_DEBUG_DIR || ''
// Restricts search to shared/source-allowlist.mjs. 'none' searches the open
// web, which is what the first three candidate runs did: 85 results, one
// inside the freshness window, and that one a banned listicle. A
// comma-separated value overrides the list for a one-off experiment.
const DOMAINS = process.env.BRIEFING_ALLOWED_DOMAINS ?? 'allow'
let allowedDomains =
  DOMAINS === 'none' ? null : DOMAINS === 'allow' ? SOURCE_ALLOWLIST : DOMAINS.split(',').map((d) => d.trim()).filter(Boolean)
const ENGINE = 'api'

// A paused turn is resumed by sending the assistant message back unchanged.
// Bounded so a pathological pause loop can't run the step into its timeout:
// the prompt's own search plan is six searches, which fits well inside one
// turn plus a couple of continuations.
const MAX_CONTINUATIONS = 4

const prompt = readFileSync(promptPath, 'utf8')
const userContent = note ? `${prompt}\n\n${note}` : prompt

const client = new Anthropic() // reads ANTHROPIC_API_KEY

// Search results carry an encrypted_content blob of several KB that has to be
// echoed back verbatim on later turns but says nothing to a human reading the
// dump. Everything else -- the queries, and each result's url, title and
// page_age -- is what a "why did it reject all of this" question needs.
function dumpTurn(dir, turn, message) {
  try {
    mkdirSync(dir, { recursive: true })
    const blocks = message.content.map((block) => {
      if (block.type !== 'web_search_tool_result') return block
      const content = Array.isArray(block.content)
        ? block.content.map(({ encrypted_content, ...rest }) => rest)
        : block.content
      return { ...block, content }
    })
    writeFileSync(`${dir}/turn-${turn}.json`, JSON.stringify({ stop_reason: message.stop_reason, usage: message.usage, blocks }, null, 2))
  } catch (err) {
    console.error(`Could not write the debug dump: ${err.message}`)
  }
}

// response_inclusion 'excluded' only pays off on the filtered path, where the
// raw blocks are consumed by code execution and nothing downstream reads them.
// On the direct path those same blocks are the only record of what the model
// saw, so they stay in.
// Rebuilt per attempt, because a retry can narrow allowedDomains.
function buildSearchTool() {
  return {
    type: 'web_search_20260318',
    name: 'web_search',
    max_uses: MAX_SEARCHES,
    // allowed_domains and blocked_domains cannot both be sent (400), and an
    // over-long list is rejected as request_too_large -- hence one curated
    // list rather than a growing blocklist of SEO farms.
    ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    ...(SEARCH_MODE === 'filtered' ? { response_inclusion: 'excluded' } : { allowed_callers: ['direct'] }),
  }
}

// A domain that blocks Anthropic's crawler is rejected with a 400 naming it,
// and the API refuses the whole request rather than skipping the entry -- so
// without this, one newspaper changing its robots policy silently becomes "no
// briefing today". Dropping the named domains and retrying costs nothing: the
// request fails before any tokens are billed.
async function requestWithDomainRecovery(params, attemptsLeft = 2) {
  try {
    const tools = SEARCH_MODE === 'none' ? {} : { tools: [buildSearchTool()] }
    return await client.messages.stream({ ...params, ...tools }).finalMessage()
  } catch (err) {
    const blocked = err?.status === 400 ? parseInaccessibleDomains(err?.error?.error?.message ?? err?.message) : []
    if (!blocked.length || !attemptsLeft || !allowedDomains) throw err
    allowedDomains = allowedDomains.filter((d) => !blocked.includes(d))
    console.error(`Dropped ${blocked.join(', ')} from the search allowlist (not accessible to the crawler) and retrying.`)
    if (!allowedDomains.length) allowedDomains = null
    return requestWithDomainRecovery(params, attemptsLeft - 1)
  }
}

const messages = [{ role: 'user', content: userContent }]
const textBlocks = []
let usage = {}
let response = null
let turns = 0
const startedAt = Date.now()

for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
  turns = i + 1
  // Streaming, not a plain create: a research turn with a dozen searches runs
  // for minutes, which is exactly the shape that trips request timeouts.
  response = await requestWithDomainRecovery({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    messages,
  })
  usage = sumUsage(usage, response.usage)

  // Keep whole blocks, not just their text: block.citations is where the
  // source URLs live, and composeText below needs them for the repair path.
  for (const block of response.content) {
    if (block.type === 'text' && block.text) textBlocks.push(block)
  }

  if (DEBUG_DIR) dumpTurn(DEBUG_DIR, i + 1, response)

  if (response.stop_reason !== 'pause_turn') break

  messages.push({ role: 'assistant', content: response.content })
  const spent = estimateCostUsd(MODEL, usage)
  if (spent !== null && spent >= MAX_USD) {
    console.error(`Budget ceiling reached mid-run ($${spent.toFixed(2)} >= $${MAX_USD}) — not continuing the paused turn.`)
    break
  }
  if (i === MAX_CONTINUATIONS) {
    console.error(`Turn still paused after ${MAX_CONTINUATIONS} continuations — giving up on further research.`)
  }
}

const costUsd = estimateCostUsd(MODEL, usage)
const durationMs = Date.now() - startedAt
const { text, citationsRendered } = composeBriefingText(textBlocks)
if (citationsRendered) {
  console.error(`Model wrote no markdown links; rebuilt ${countBriefingItems(text)} from the response's citations.`)
}

// Log before any failure exit: a run that produced nothing still spent money,
// and that is precisely the run worth having a record of.
const record = {
  ts: new Date().toISOString(),
  date: process.env.BRIEFING_DATE_ISO || null,
  engine: ENGINE,
  model: MODEL,
  effort: EFFORT,
  search_mode: SEARCH_MODE,
  allowed_domains: allowedDomains?.length ?? 0,
  stop_reason: response?.stop_reason ?? null,
  turns,
  duration_ms: durationMs,
  input_tokens: usage.input_tokens ?? 0,
  output_tokens: usage.output_tokens ?? 0,
  web_searches: webSearchCount(usage),
  cost_usd: costUsd,
  briefing_chars: text.length,
  citations_rendered: citationsRendered,
}
try {
  appendFileSync(COST_LOG, `${JSON.stringify(record)}\n`)
} catch (err) {
  // A log write must never be the thing that loses an edition.
  console.error(`Could not append to ${COST_LOG}: ${err.message}`)
}

const costLabel = costUsd === null ? 'unknown (unpriced model)' : `$${costUsd.toFixed(3)}`
console.error(
  `Generated in ${(durationMs / 1000).toFixed(0)}s over ${turns} turn(s): ` +
    `${record.input_tokens} in / ${record.output_tokens} out, ${record.web_searches} searches, ${costLabel}.`,
)

if (response?.stop_reason === 'refusal') {
  console.error(`Model declined the request (${response.stop_details?.category ?? 'no category'}).`)
  process.exit(1)
}
if (response?.stop_reason === 'max_tokens') {
  console.error(`Hit max_tokens (${MAX_TOKENS}) — the edition below is truncated.`)
}
if (!text) {
  console.error('Model returned no text content.')
  process.exit(1)
}
// A briefing whose bullets carry no markdown link is not a thin edition, it is
// an unusable one: every downstream gate counts linked bullets, so this exits 0
// and is then silently rejected -- the requester gets yesterday's edition and
// the run is green. Seen live 2026-08-28: five well-formed, correctly dated
// items, not one link, workflow success, subscriber served a stale briefing.
// Failing here instead hands it to the workflow's existing retry, and a second
// failure alerts rather than pretending nothing happened.
if (countBriefingItems(text) === 0) {
  console.error('Composed a briefing with no linked bullets and no citations to rebuild them from — every downstream gate counts links, so this would be discarded. Failing so the retry fires.')
  process.exit(1)
}
if (costUsd !== null && costUsd > MAX_USD) {
  console.error(`Run cost ${costLabel}, over the $${MAX_USD} ceiling. Content kept (already paid for); tune BRIEFING_MAX_SEARCHES or effort.`)
}

process.stdout.write(`${text}\n`)
