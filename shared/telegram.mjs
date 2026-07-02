// Resilient Telegram send helpers for the GitHub Actions delivery scripts
// (scripts/send-briefing.mjs, scripts/send-to-chat.mjs). Previously each script
// fired `sendMessage` in a bare loop with no retry and no pacing, so at scale
// Telegram's ~30 msg/s rate limit produced 429s and those recipients silently
// missed the briefing (PERF-3). This module adds retry-with-backoff (honoring
// Retry-After, in seconds) and inter-message pacing, in one shared place
// (the Worker keeps its own fetchWithRetry — this is for the runner scripts).

import { chunk } from './telegram-markdown.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
