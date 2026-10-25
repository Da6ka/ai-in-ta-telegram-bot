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

// Not news: The Hero (Super Recruiter's newsletter on beehiiv) is read from its
// archive page, not searched. Checked live on 2026-10-25: Firecrawl's web
// search over the domain returns no date at all, answers an empty list under any
// qdr filter, and surfaced only older issues, never the two newest. The archive
// page lists every recent issue with its publication date.
export const NEWSLETTER_ARCHIVE_URL = 'https://thehero.beehiiv.com/'

// The only URLs the archive may contribute. The page also links tag and author
// pages; only /p/ posts are issues.
const NEWSLETTER_ISSUE_URL = /^https:\/\/thehero\.beehiiv\.com\/p\//

export function isNewsletterIssue(url) {
  return NEWSLETTER_ISSUE_URL.test(String(url ?? ''))
}

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

const WINDOW_DAYS = { 'qdr:d': 1, 'qdr:w': 7, 'qdr:m': 31 }

// True when the article's own URL dates it outside the search window. The
// window filter goes by the news index's date, which a re-indexed page resets:
// in August 2026 the briefing carried an HR Dive survey published 22 Aug 2025
// as new. Firecrawl's `date` field is relative ("3 days ago") and already what the
// filter used, so the URL is the one independent signal. A month-only path
// counts from the month's last day, and one day of slack covers time zones.
// simplification: only /YYYY/MM/ and /YYYY/MM/DD/ paths are read. HR Dive's
// URLs carry no date, so that exact case still gets through; reading the
// article's published date means scraping it.
export function urlDateTooOld(url, tbs, todayISO) {
  const days = WINDOW_DAYS[tbs]
  if (!days) return false
  let path
  try {
    path = new URL(String(url)).pathname
  } catch {
    return false
  }
  const m = path.match(/\/(20\d\d)\/(0?[1-9]|1[0-2])(?:\/(0?[1-9]|[12]\d|3[01]))?(?=\/|$)/)
  if (!m) return false
  const [, year, month, day] = m.map(Number)
  const published = day ? Date.UTC(year, month - 1, day) : Date.UTC(year, month, 0)
  const today = Date.parse(`${todayISO}T00:00:00Z`)
  return today - published > (days + 1) * 86400000
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const ARCHIVE_DATE = /^([A-Z][a-z]{2}) (\d{1,2}), (20\d\d)$/

// Reads the archive page's markdown into issues. Each card is the issue link
// (repeated several times by the theme), a "Mon D, YYYY" line, a "### title"
// heading and a one-line blurb; a card's date therefore belongs to the last /p/
// link above it. Cards without a date or a title are skipped rather than
// guessed at. The date is returned as ISO so the model reads it unambiguously.
// Depends on beehiiv's theme: if the layout changes this returns [] and the
// caller reports it, it does not invent dates.
export function parseNewsletterArchive(markdown) {
  const lines = String(markdown ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const issues = []
  let url = null
  for (let i = 0; i < lines.length; i++) {
    const link = lines[i].match(/\]\((https:\/\/thehero\.beehiiv\.com\/p\/[^)\s]+)\)/g)
    if (link) url = link[link.length - 1].slice(2, -1)
    const d = lines[i].match(ARCHIVE_DATE)
    if (!d || !url) continue
    const month = MONTHS.indexOf(d[1].toLowerCase())
    if (month === -1) continue
    const rest = lines.slice(i + 1)
    const at = rest.slice(0, 6).findIndex((l) => l.startsWith('### '))
    if (at === -1) continue
    const heading = rest[at]
    const blurb = rest.slice(at + 1).find((l) => !l.startsWith('!['))
    issues.push({
      title: heading.slice(4).replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim(),
      url,
      date: `${d[3]}-${String(month + 1).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`,
      snippet: blurb,
    })
    url = null
  }
  return dedupeStories(issues)
}

// True when an issue's ISO publication date falls inside the search window,
// with the same one day of slack as urlDateTooOld. An unknown window keeps it.
export function issueInWindow(issue, tbs, todayISO) {
  const days = WINDOW_DAYS[tbs]
  const published = Date.parse(`${issue?.date}T00:00:00Z`)
  if (!days || Number.isNaN(published)) return !days
  return Date.parse(`${todayISO}T00:00:00Z`) - published <= (days + 1) * 86400000
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

// Firecrawl sometimes returns a page's markdown as the snippet. Left raw, image
// and link URLs eat the 400-character budget: on 2026-10-24 an ERE story reached
// the model as its title, one subtitle and two category links. Keep the words,
// drop the markup. simplification: link text survives, so site chrome such as
// share buttons still costs a few dozen characters; scraping the chosen
// articles is the upgrade if summaries stay thin.
function snippetText(snippet) {
  return String(snippet)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|[-*+])\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The block appended to the composition prompt. One line of metadata per story
// plus its snippet: enough for the model to judge relevance, recency and beat,
// and small enough that a whole day's candidates cost a few thousand tokens
// instead of the ~250k that raw in-context search results cost.
export function formatStories(stories) {
  if (!stories?.length) return 'No candidate stories were returned by the news search.'
  const lines = stories.map((story, i) => {
    const date = story.date ? ` (${story.date})` : ''
    const snippet = story.snippet ? `\n   ${snippetText(story.snippet).slice(0, 400)}` : ''
    // The marker is the only thing that survives of the API-enforced source
    // allowlist (shared/source-allowlist.mjs): the prompts' "prefer strong
    // sources" rule is advisory, and this is what it reads.
    const tier = sourceTier(story.url) === 'preferred' ? ' [preferred source]' : ''
    // Issues are marked, not filtered: most are guides, and which of them is
    // worth a bullet is the prompt rule's call (see "newsletter issue").
    const issue = isNewsletterIssue(story.url) ? ' [newsletter issue]' : ''
    return `${i + 1}. ${story.title}${date}${tier}${issue}\n   ${story.url}${snippet}`
  })
  return `Candidate stories from today's news search, newest first within each query. These are the only stories you may use:\n\n${lines.join('\n\n')}`
}
