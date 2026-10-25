// Fetches the day's candidate stories from Firecrawl and prints them as the
// block that gets appended to briefing-prompt-curated.md (daily) or
// briefing-prompt-ondemand-curated.md (/newbriefing).
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
import { NEWSLETTER_ARCHIVE_URL, NEWS_QUERIES, dedupeStories, formatStories, isNewsletterIssue, issueInWindow, parseNewsletterArchive, recencyTbs, urlDateTooOld, widerWindow } from '../shared/news-queries.mjs'
import { sourceTier } from '../shared/source-allowlist.mjs'
import { recencyWindowHours } from '../shared/telegram.mjs'
import { existsSync, readFileSync } from 'node:fs'

const API_KEY = process.env.FIRECRAWL_API_KEY
if (!API_KEY) throw new Error('FIRECRAWL_API_KEY is not set')

const PER_QUERY = Number(process.env.NEWS_LIMIT_PER_QUERY || 8)
const MAX_ITEMS = Number(process.env.NEWS_MAX_ITEMS || 40)
// Newsletter issues get their own slots on top of MAX_ITEMS: appended after a
// full news list they would be cut by the cap every day.
const MAX_NEWSLETTER = 3
const COUNTRY = process.env.NEWS_COUNTRY || 'US'
// Below this many distinct stories, sweep again at the next wider window and
// merge. 0 (the default, and what the daily uses) disables it entirely.
const MIN_STORIES = Number(process.env.NEWS_MIN_STORIES || 0)
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

async function search(query, window, sources = [{ type: 'news' }]) {
  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: PER_QUERY,
      sources,
      tbs: window,
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

// The Hero is read from its archive page, one scrape (about 1 credit): search
// over the domain carries no dates and misses the newest issues. Rejection is
// survivable, as it was for the newsletter query -- the source is optional.
async function fetchArchive() {
  try {
    const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: NEWSLETTER_ARCHIVE_URL, formats: ['markdown'] }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = await res.json()
    if (!body.success || body.data?.metadata?.statusCode !== 200) {
      throw new Error(`scrape failed: ${JSON.stringify(body).slice(0, 300)}`)
    }
    const issues = parseNewsletterArchive(body.data.markdown)
    if (!issues.length) console.error('The Hero archive parsed to zero issues -- has the page layout changed?')
    return issues
  } catch (err) {
    console.error(`The Hero archive failed: ${err?.message ?? err}`)
    return []
  }
}

// One pass of all ten news queries at a given window. Rejections are reported
// and tolerated here; whether "all of them failed" is fatal is the caller's
// call. Each query costs about 2 Firecrawl credits, so a pass is ~20 -- see the
// README's note on the plan's monthly ceiling before adding queries or passes.
async function sweep(window) {
  const settled = await Promise.allSettled(NEWS_QUERIES.map((query) => search(query, window)))
  for (const [i, result] of settled.entries()) {
    if (result.status === 'rejected') {
      console.error(`Query "${NEWS_QUERIES[i]}" failed (window ${window}): ${result.reason?.message ?? result.reason}`)
    }
  }
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
  // Dropped here rather than left for the prompt to reject: a denied domain
  // that stays on the list still occupies one of the model's slots, and a
  // stock-analysis rewrite of a real story crowds out the story itself.
  const kept = all.filter((story) => sourceTier(story.url) !== 'denied')
  if (kept.length < all.length) {
    console.error(`Dropped ${all.length - kept.length} result(s) from denylisted domains.`)
  }
  const dated = kept.filter((story) => !urlDateTooOld(story.url, window, todayISO))
  for (const story of kept.filter((s) => !dated.includes(s))) {
    console.error(`Dropped ${story.url}: its URL dates it outside the ${window} window.`)
  }
  return {
    // A beehiiv result from the news queries is not an issue: issues come from
    // the archive only, with a real date.
    stories: dated.filter((s) => !isNewsletterIssue(s.url)),
    ok: settled.filter((s) => s.status === 'fulfilled').length,
    total: NEWS_QUERIES.length,
  }
}

// Issues are kept apart from the news stories so one neither takes a slot from
// MAX_ITEMS nor hides a thin news day from NEWS_MIN_STORIES.
const archive = await fetchArchive()
const issuesIn = (window) => archive.filter((issue) => issueInWindow(issue, window, todayISO))

const first = await sweep(tbs)
if (!first.ok) {
  console.error('Every news query failed — not composing a briefing from nothing.')
  process.exit(1)
}

let stories = dedupeStories(first.stories, MAX_ITEMS)
let issues = dedupeStories(issuesIn(tbs), MAX_NEWSLETTER)
console.error(`Fetched ${stories.length} distinct stories from ${first.ok}/${first.total} queries and ${issues.length} newsletter issue(s) (window ${tbs}).`)

if (MIN_STORIES && stories.length < MIN_STORIES) {
  const wider = widerWindow(tbs)
  if (!wider) {
    console.error(`Only ${stories.length} distinct stories (want ${MIN_STORIES}), and no window wider than ${tbs} to try.`)
  } else {
    console.error(`Only ${stories.length} distinct stories (want ${MIN_STORIES}) — sweeping again at ${wider}.`)
    const second = await sweep(wider)
    // First-pass stories keep their slots: dedupeStories preserves input order,
    // so widening can only add older items below the fresh ones, never displace
    // them. Dropping the composition prompt's date filter is not this script's
    // job -- the wider list still carries every story's date, and the prompt
    // still refuses anything outside its own window.
    stories = dedupeStories([...first.stories, ...second.stories], MAX_ITEMS)
    issues = dedupeStories(issuesIn(wider), MAX_NEWSLETTER)
    console.error(`Now ${stories.length} distinct stories after widening to ${wider} (${second.ok}/${second.total} queries).`)
  }
}

const out = [...stories, ...issues]
process.stdout.write(asJson ? `${JSON.stringify(out, null, 2)}\n` : `${formatStories(out)}\n`)
