// Resilient Telegram send helpers for the GitHub Actions delivery scripts
// (scripts/send-briefing.mjs, scripts/send-to-chat.mjs). Previously each script
// fired `sendMessage` in a bare loop with no retry and no pacing, so at scale
// Telegram's ~30 msg/s rate limit produced 429s and those recipients silently
// missed the briefing (PERF-3). This module adds retry-with-backoff (honoring
// Retry-After, in seconds) and inter-message pacing, in one shared place
// (the Worker keeps its own fetchWithRetry — this is for the runner scripts).

import { chunk } from './telegram-markdown.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A generated briefing is only valid if it carries the canonical title line
// (force-briefing-date.mjs keys off the same header, and the daily workflow's
// freshness grep depends on the dated title). A zero-exit "garbage" generation
// — an LLM refusal, a preamble-only response, or a malformed title — lacks it.
// Used to gate the KV cache write so one bad on-demand /newbriefing can't
// overwrite the shared today_briefing_md that every user's /briefing serves.
export function isValidBriefing(md) {
  const firstLine = (md ?? '').trimStart().split('\n', 1)[0]
  return /^# Daily AI Recruitment Briefing — .+/.test(firstLine)
}

// A qualifying story is a top-level bullet carrying a Markdown link — the
// shape every real item has per the briefing prompt. The "no content
// available" fallback has zero; the degenerate single-story generation
// observed in prod (2026-07-02 21:32 UTC) had one. Anything below
// MIN_BRIEFING_ITEMS must not replace the shared today_briefing cache or be
// pushed to all subscribers as the day's edition (AUD-1) — 2+ linked stories
// is the floor for a plausibly real quiet news day, while the prompt itself
// aims for 4+ via its minimum-coverage search loop.
export const MIN_BRIEFING_ITEMS = 2

// Returns whole bullet lines, not just the truncated `match()` hit (a plain
// global-regex match() here would cut each result off right after the
// "https://" it matched on, since the pattern has no end anchor).
export function extractBriefingBullets(md) {
  return String(md ?? '').split('\n').filter((line) => /^- .*\]\(https?:\/\//.test(line))
}

export function countBriefingItems(md) {
  return extractBriefingBullets(md).length
}

// The generation prompt forbids preamble (briefing-prompt.md: "Output ONLY the
// composed briefing markdown ... no commentary before or after it"), but the
// model occasionally ignores it and emits reasoning before the title anyway
// (seen live 2026-07-13: an edition opened with "I have three solid,
// date-verified items ..." above the "# Daily AI Recruitment Briefing" line).
// Nothing downstream strips it, so that commentary would render at the top of
// every subscriber's briefing. normalizeBriefing deterministically drops
// anything before the first title line, then forces the title's date to
// `today` (the date is load-bearing -- the freshness gates grep for it). With
// no title line at all it returns the content unchanged: an untitled/undated
// edition is rejected by the freshness gate rather than guessed at here.
export const BRIEFING_TITLE_PREFIX = '# Daily AI Recruitment Briefing — '
const BRIEFING_TITLE_RE = /^# Daily AI Recruitment Briefing — .*$/m

export function normalizeBriefing(content, today) {
  const src = String(content ?? '')
  const match = src.match(BRIEFING_TITLE_RE)
  if (!match) return { content: src, preambleStripped: false, dateChanged: false }
  const titleIndex = src.indexOf(match[0])
  const preambleStripped = src.slice(0, titleIndex).trim().length > 0
  const forcedTitle = `${BRIEFING_TITLE_PREFIX}${today}`
  const dateChanged = match[0] !== forcedTitle
  return { content: forcedTitle + src.slice(titleIndex + match[0].length), preambleStripped, dateChanged }
}

// Same-day merges (update-recent-stories.mjs) must dedupe by the underlying
// story, not the bullet's exact wording -- the LLM can phrase a re-run of the
// same story differently, or cite it from a second source domain, and an
// exact-text Set misses both. Normalizing to host+path (dropping query/hash
// and a trailing slash) catches same-URL restates; cross-domain restates of
// the same story still need the prompt's own freshness filter.
export function bulletUrlKey(line) {
  const m = String(line ?? '').match(/\]\((https?:\/\/[^)]+)\)/)
  if (!m) return null
  try {
    const u = new URL(m[1])
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase()
  } catch {
    return m[1]
  }
}

// Dedupe bullets by bulletUrlKey (falling back to exact text for a bullet
// with no parseable URL), keeping the first occurrence of each key.
export function dedupeBullets(bullets) {
  const seen = new Set()
  const out = []
  for (const b of bullets ?? []) {
    const key = bulletUrlKey(b) ?? b
    if (seen.has(key)) continue
    seen.add(key)
    out.push(b)
  }
  return out
}

// How long a covered story is remembered and fed back into the generation
// prompt as "already covered, don't repeat". Set to the wider of the two
// prompts' own freshness windows (briefing-prompt-ondemand.md falls back to
// 14 days when fewer than 3 stories qualify at 7) — no point forgetting a
// story before it could still pass that filter and get re-reported under a
// different source domain, which is exactly what happened with the Claude
// Sonnet 5 launch appearing in both the 2026-07-03 and 2026-07-04 editions.
export const RECENT_STORIES_WINDOW_DAYS = 14

export function pruneRecentStories(entries, todayISO, windowDays = RECENT_STORIES_WINDOW_DAYS) {
  const today = new Date(`${todayISO}T00:00:00Z`)
  return (entries ?? []).filter((e) => {
    const ageDays = (today - new Date(`${e.date}T00:00:00Z`)) / 86_400_000
    return ageDays >= 0 && ageDays < windowDays
  })
}

// Caps how many bullets get injected into the generation prompt, independent
// of the date window. A single heavy-testing day (many /newbriefing runs)
// can produce dozens of merged bullets for one date -- unbounded, that's
// thousands of extra tokens on every future generation, risking blowing
// through --max-budget-usd again (see the 2026-07-04 budget-cap incident).
// Keeps the most recent bullets, since those are the most likely to still be
// "fresh" enough for the model to consider re-reporting.
export const MAX_RECENT_STORY_BULLETS = 20

export function recentStoryBullets(entries, todayISO) {
  const sorted = [...pruneRecentStories(entries, todayISO)].sort((a, b) => (a.date < b.date ? -1 : 1))
  return sorted.flatMap((e) => e.bullets).slice(-MAX_RECENT_STORY_BULLETS)
}

// Pace sends to stay under Telegram's ~30 msg/s ceiling. 40ms ≈ 25/s, leaving
// headroom for the API's own variability.
const DEFAULT_PACE_MS = 40

// POST one Telegram API call, retrying 429/5xx and network errors with backoff.
// Retry-After is respected in SECONDS (the header's unit) rather than the
// Worker's historical seconds×0.3 under-wait. Returns the final Response;
// throws only if every network attempt threw.
export async function tgRequest(token, method, body, { retries = 3, baseDelayMs = 500 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      lastErr = err
      if (attempt === retries) throw err
      await sleep(baseDelayMs * (attempt + 1))
      continue
    }
    if (res.ok || (res.status !== 429 && res.status < 500) || attempt === retries) return res
    const retryAfter = Number(res.headers.get('retry-after'))
    await sleep(retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * (attempt + 1))
  }
  throw lastErr
}

// Send one already-rendered HTML message to one chat, splitting into
// Telegram-sized chunks. Returns true iff every chunk was accepted; on a failed
// chunk it calls onError(chatId, res) so the caller can log/count.
export async function sendHtml(token, chatId, html, { onError, retries = 3 } = {}) {
  let allOk = true
  for (const part of chunk(html, 4000)) {
    const res = await tgRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: part,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }, { retries })
    if (!res.ok) {
      allOk = false
      if (onError) await onError(chatId, res)
    }
  }
  return allOk
}

// Broadcast one HTML message to many chats, paced under the rate limit.
// Returns { total, failed } where failed counts recipients with >=1 bad chunk.
export async function sendHtmlToMany(token, chatIds, html, { onError, paceMs = DEFAULT_PACE_MS, retries = 3 } = {}) {
  let failed = 0
  for (let i = 0; i < chatIds.length; i++) {
    const ok = await sendHtml(token, chatIds[i], html, { onError, retries })
    if (!ok) failed++
    if (i < chatIds.length - 1 && paceMs > 0) await sleep(paceMs)
  }
  return { total: chatIds.length, failed }
}

// Broadcast one PLAIN-TEXT message to many chats (no parse_mode, so the owner's
// message is delivered verbatim rather than interpreted as HTML), paced and
// retried. This is what /broadcast uses now that delivery runs on the Actions
// runner instead of in the Worker — the Worker's per-invocation subrequest cap
// bounded broadcast fan-out to ~45 recipients (BUG-4); the runner has no such
// cap. Returns { total, failed }.
export async function sendTextToMany(token, chatIds, text, { onError, paceMs = DEFAULT_PACE_MS, retries = 3 } = {}) {
  let failed = 0
  for (let i = 0; i < chatIds.length; i++) {
    let ok = true
    for (const part of chunk(text, 4000)) {
      const res = await tgRequest(token, 'sendMessage', {
        chat_id: chatIds[i],
        text: part,
        link_preview_options: { is_disabled: true },
      }, { retries })
      if (!res.ok) {
        ok = false
        if (onError) await onError(chatIds[i], res)
      }
    }
    if (!ok) failed++
    if (i < chatIds.length - 1 && paceMs > 0) await sleep(paceMs)
  }
  return { total: chatIds.length, failed }
}
