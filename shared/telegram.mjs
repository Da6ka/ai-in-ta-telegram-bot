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
  return /^# Daily AI Recruitment Briefing — .+/m.test(md ?? '')
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

export function countBriefingItems(md) {
  return (String(md ?? '').match(/^- .*\]\(https?:\/\//gm) ?? []).length
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
