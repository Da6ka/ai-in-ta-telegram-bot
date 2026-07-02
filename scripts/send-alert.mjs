// Sends a one-line operational alert to a Telegram chat — used by the briefing
// workflows to surface silent failures (cron threw, or generation produced
// nothing fresh so subscribers got nothing). Without this, the only signal that
// the daily pipeline broke was "no briefing showed up," discovered by hand.
//
// Best-effort by design: it never throws and always exits 0, so a failed alert
// can't itself fail (or mask) the workflow. Reuses the runner's shared
// tgRequest (retry + Retry-After backoff). CHAT_ID is a plain id — for the
// daily cron it's the owner's own id (a repo *variable*, not a secret, and
// robust even when Cloudflare/KV is the thing that's down); for on-demand it's
// the requester who's left waiting.
import { tgRequest } from '../shared/telegram.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID
const text = process.env.ALERT_TEXT || 'ai-in-ta-telegram-bot: an alert fired with no message body.'

if (!token || !chatId) {
  console.error('send-alert: TELEGRAM_BOT_TOKEN and CHAT_ID must both be set — skipping alert.')
  process.exit(0)
}

try {
  const res = await tgRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  })
  if (!res.ok) console.error(`send-alert: Telegram returned ${res.status} ${await res.text()}`)
  else console.log(`send-alert: delivered to ${chatId}.`)
} catch (err) {
  console.error('send-alert: failed to deliver alert:', err)
}
