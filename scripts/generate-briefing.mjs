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
import { appendFileSync, readFileSync } from 'node:fs'
import { estimateCostUsd, sumUsage, webSearchCount } from '../shared/anthropic-cost.mjs'

const [promptPath, note = ''] = process.argv.slice(2)
if (!promptPath) {
  console.error('usage: node scripts/generate-briefing.mjs <prompt-file> [note]')
  process.exit(2)
}

const MODEL = process.env.BRIEFING_MODEL || 'claude-opus-4-8'
const EFFORT = process.env.BRIEFING_EFFORT || 'medium'
const MAX_SEARCHES = Number(process.env.BRIEFING_MAX_SEARCHES || 12)
const MAX_TOKENS = Number(process.env.BRIEFING_MAX_TOKENS || 16_000)
const MAX_USD = Number(process.env.BRIEFING_MAX_USD || 4)
const COST_LOG = process.env.BRIEFING_COST_LOG || 'state/cost_log.jsonl'
const ENGINE = 'api'

// A paused turn is resumed by sending the assistant message back unchanged.
// Bounded so a pathological pause loop can't run the step into its timeout:
// the prompt's own search plan is six searches, ten on a thin day, which fits
// well inside one turn plus a couple of continuations.
const MAX_CONTINUATIONS = 4

const prompt = readFileSync(promptPath, 'utf8')
const userContent = note ? `${prompt}\n\n${note}` : prompt

const client = new Anthropic() // reads ANTHROPIC_API_KEY

const messages = [{ role: 'user', content: userContent }]
const textParts = []
let usage = {}
let response = null
let turns = 0
const startedAt = Date.now()

for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
  turns = i + 1
  // Streaming, not a plain create: a research turn with a dozen searches runs
  // for minutes, which is exactly the shape that trips request timeouts.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    tools: [
      {
        type: 'web_search_20260318',
        name: 'web_search',
        max_uses: MAX_SEARCHES,
        response_inclusion: 'excluded',
      },
    ],
    messages,
  })
  response = await stream.finalMessage()
  usage = sumUsage(usage, response.usage)

  for (const block of response.content) {
    if (block.type === 'text' && block.text) textParts.push(block.text)
  }

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
const text = textParts.join('').trim()

// Log before any failure exit: a run that produced nothing still spent money,
// and that is precisely the run worth having a record of.
const record = {
  ts: new Date().toISOString(),
  date: process.env.BRIEFING_DATE_ISO || null,
  engine: ENGINE,
  model: MODEL,
  effort: EFFORT,
  stop_reason: response?.stop_reason ?? null,
  turns,
  duration_ms: durationMs,
  input_tokens: usage.input_tokens ?? 0,
  output_tokens: usage.output_tokens ?? 0,
  web_searches: webSearchCount(usage),
  cost_usd: costUsd,
  briefing_chars: text.length,
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
if (costUsd !== null && costUsd > MAX_USD) {
  console.error(`Run cost ${costLabel}, over the $${MAX_USD} ceiling. Content kept (already paid for); tune BRIEFING_MAX_SEARCHES or effort.`)
}

process.stdout.write(`${text}\n`)
