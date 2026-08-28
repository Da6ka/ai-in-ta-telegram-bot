// Fetches the day's candidate stories from Firecrawl and prints them as the
// block that gets appended to briefing-prompt-curated.md.
//
// Usage:
//   node scripts/fetch-news.mjs            # prompt block on stdout
//   node scripts/fetch-news.mjs --json     # the raw deduped stories
//
// Why the search moved out of the model: Anthropic's server-side web search has
// no recency filter, and on 2026-08-21 it returned 85 results across ten
// queries with exactly one inside the seven-day window (a listicle the prompt
// bans). The same beat through Firecrawl's news source with a `qdr:w` filter
// returned ten of ten inside it. Cost follows from the same change -- the model
// no longer pulls raw search results into its context, which is where ~250k
// input tokens per edition were going.
//
// Failure policy: one failed query is survivable and the run continues with
// whatever the others returned; every query failing is not, and exits non-zero
// so the workflow's alerting fires instead of composing an empty briefing.
import { NEWS_QUERIES, dedupeStories, formatStories, recencyTbs } from '../shared/news-queries.mjs'
import { recencyWindowHours } from '../shared/telegram.mjs'
import { existsSync, readFileSync } from 'node:fs'

const API_KEY = process.env.FIRECRAWL_API_KEY
if (!API_KEY) throw new Error('FIRECRAWL_API_KEY is not set')

const PER_QUERY = Number(process.env.NEWS_LIMIT_PER_QUERY || 8)
const MAX_ITEMS = Number(process.env.NEWS_MAX_ITEMS || 40)
const COUNTRY = process.env.NEWS_COUNTRY || 'US'
const asJson = process.argv.includes('--json')

// Same window the date note tells the model about, so the search and the
// instructions cannot disagree about what "recent" means.
const todayISO = process.env.BRIEFING_DATE_ISO || new Date().toISOString().slice(0, 10)
let lastBriefingISO = ''
if (existsSync('state/usage_stats.json')) {
  try {
    lastBriefingISO = JSON.parse(readFileSync('state/usage_stats.json', 'utf8')).last_briefing_at || ''
  } catch {
    lastBriefingISO = ''
  }
}
const tbs = process.env.NEWS_TBS || recencyTbs(recencyWindowHours(todayISO, lastBriefingISO))

async function search(query) {
  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: PER_QUERY,
      sources: [{ type: 'news' }],
      tbs,
      country: COUNTRY,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const body = await res.json()
  if (!body.success) throw new Error(`search failed: ${JSON.stringify(body).slice(0, 300)}`)
  // Results arrive under data.news for a news source; be tolerant of the web
  // shape too so a source change doesn't silently yield zero stories.
  const news = body.data?.news ?? body.data?.web ?? []
  return news.map((r) => ({ title: r.title, url: r.url, date: r.date, snippet: r.snippet, query }))
}

const settled = await Promise.allSettled(NEWS_QUERIES.map(search))
const failures = settled.filter((s) => s.status === 'rejected')
for (const [i, result] of settled.entries()) {
  if (result.status === 'rejected') console.error(`Query "${NEWS_QUERIES[i]}" failed: ${result.reason?.message ?? result.reason}`)
}
if (failures.length === settled.length) {
  console.error('Every news query failed — not composing a briefing from nothing.')
  process.exit(1)
}

const stories = dedupeStories(
  settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])),
  MAX_ITEMS,
)

console.error(
  `Fetched ${stories.length} distinct stories from ${settled.length - failures.length}/${settled.length} queries (window ${tbs}).`,
)

process.stdout.write(asJson ? `${JSON.stringify(stories, null, 2)}\n` : `${formatStories(stories)}\n`)
