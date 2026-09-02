// The searches that feed a briefing, and the helpers for turning their results
// into something the composition prompt can read.
//
// These queries used to live in briefing-prompt.md as instructions to the
// model. They are code now because the search itself moved out of the model:
// Firecrawl's news source takes a time filter, which is the one thing
// server-side web search could not do. On 2026-08-21 the model's own search
// returned 85 results across ten queries with exactly one inside the seven-day
// window; the same beat through Firecrawl's news source with `qdr:w` returned
// ten of ten inside it.
//
// Keep these in step with briefing-prompt.md's beat list. The first six are
// the mandatory sweep; the last four were the prompt's "minimum coverage"
// escalation, run only when the first six came up thin. There is no reason to
// hold them back now -- a Firecrawl search is cheap and does not consume model
// context, so all ten run every time and the model picks from the union.
import { sourceTier } from './source-allowlist.mjs'

export const NEWS_QUERIES = [
  'Claude AI talent acquisition news',
  'AI recruitment news',
  'AI hiring tool launch announcement',
  'AI recruiting regulation news',
  'recruiting technology funding round',
  'ATS vendor product announcement',
  'enterprise HR AI deployment announcement',
  'AI hiring lawsuit OR EEOC OR regulator action',
  'LinkedIn Workday Greenhouse SmartRecruiters AI feature',
  'HR tech vendor funding OR acquisition',
]

// Firecrawl's time filter. The briefing's hard rule is "published in the past 7
// days", so a week window is the honest default; a day window exists for a
// same-day rerun that should only surface what is genuinely new.
export function recencyTbs(windowHours) {
  return Number(windowHours) <= 24 ? 'qdr:d' : 'qdr:w'
}

// The next wider window on Firecrawl's ladder, or null when there is nowhere
// left to widen. Only the on-demand path uses it: /newbriefing can land minutes
// after the morning edition has already taken every fresh story, and its prompt
// is allowed to reach back further rather than tell the requester there is no
// news. The daily never widens -- its seven-day rule is hard, and a thin day is
// supposed to produce a thin briefing.
export function widerWindow(tbs) {
  const ladder = ['qdr:d', 'qdr:w', 'qdr:m']
  const i = ladder.indexOf(String(tbs))
  return i === -1 || i === ladder.length - 1 ? null : ladder[i + 1]
}

// Two searches returning the same story is the norm, not the exception -- the
// beats overlap by design. Dedupe on host + path so a tracking query string or
// a trailing slash doesn't smuggle the same article in twice and burn one of
// the model's slots. Mirrors bulletUrlKey in shared/telegram.mjs, which does
// the same job for already-published bullets.
export function storyKey(url) {
  try {
    const parsed = new URL(String(url))
    return `${parsed.host.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`.toLowerCase()
  } catch {
    return String(url ?? '').trim().toLowerCase()
  }
}

export function dedupeStories(stories, limit = Infinity) {
  const seen = new Set()
  const out = []
  for (const story of stories ?? []) {
    if (!story?.url || !story?.title) continue
    const key = storyKey(story.url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(story)
    if (out.length >= limit) break
  }
  return out
}

// The block appended to the composition prompt. One line of metadata per story
// plus its snippet: enough for the model to judge relevance, recency and beat,
// and small enough that a whole day's candidates cost a few thousand tokens
// instead of the ~250k that raw in-context search results cost.
export function formatStories(stories) {
  if (!stories?.length) return 'No candidate stories were returned by the news search.'
  const lines = stories.map((story, i) => {
    const date = story.date ? ` (${story.date})` : ''
    const snippet = story.snippet ? `\n   ${String(story.snippet).replace(/\s+/g, ' ').trim().slice(0, 400)}` : ''
    // The marker is the only thing that survives of the API-enforced source
    // allowlist (shared/source-allowlist.mjs): the prompts' "prefer strong
    // sources" rule is advisory, and this is what it reads.
    const tier = sourceTier(story.url) === 'preferred' ? ' [preferred source]' : ''
    return `${i + 1}. ${story.title}${date}${tier}\n   ${story.url}${snippet}`
  })
  return `Candidate stories from today's news search, newest first within each query. These are the only stories you may use:\n\n${lines.join('\n\n')}`
}
