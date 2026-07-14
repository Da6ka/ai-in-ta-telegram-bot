// When an on-demand generation exits 0 but the freshness/content gate rejects
// it (the "no content" fallback or an undated/malformed title), the requester
// was only told to run /briefing themselves. Instead, serve them the last
// saved edition straight away — the same thing /briefing would return — by
// reading today_briefing_md / today_briefing_date from Cloudflare KV. This
// mirrors the Worker's serveStaleBriefing (worker/src/index.js) for the
// in-Actions path.
//
// Best-effort by design: it never throws and always exits 0 (it runs on an
// already-degraded path and must not fail the job). If KV has no saved edition
// or can't be reached, it falls back to ALERT_TEXT so the requester is never
// left in silence.
import { mdToHtml } from '../shared/telegram-markdown.mjs'
import { sendHtml, tgRequest } from '../shared/telegram.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID
const fallbackText =
  process.env.ALERT_TEXT ||
  "Sorry — the fresh briefing didn't come out right this time. Please try /newbriefing again shortly, or /briefing for the last saved one."
const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID } = process.env

if (!token || !chatId) {
  console.error('send-stale-to-chat: TELEGRAM_BOT_TOKEN and CHAT_ID must both be set — skipping.')
  process.exit(0)
}

async function sendFallback() {
  try {
    const res = await tgRequest(token, 'sendMessage', {
      chat_id: chatId,
      text: fallbackText,
      link_preview_options: { is_disabled: true },
    })
    if (!res.ok) console.error(`send-stale-to-chat: fallback alert returned ${res.status} ${await res.text()}`)
  } catch (err) {
    console.error('send-stale-to-chat: failed to deliver fallback alert:', err)
  }
}

// Any failure reaching KV falls through to the plain alert rather than throwing.
let md = null
let date = null
try {
  if (CF_ACCOUNT_ID && CF_API_TOKEN && CF_KV_NAMESPACE_ID) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`
    const headers = { Authorization: `Bearer ${CF_API_TOKEN}` }
    const mdRes = await fetch(`${base}/today_briefing_md`, { headers })
    if (mdRes.ok) md = await mdRes.text()
    else if (mdRes.status !== 404)
      console.error(`send-stale-to-chat: KV get today_briefing_md returned ${mdRes.status}`)
    const dateRes = await fetch(`${base}/today_briefing_date`, { headers })
    if (dateRes.ok) date = await dateRes.text()
  } else {
    console.error('send-stale-to-chat: Cloudflare KV env not set — falling back to alert text.')
  }
} catch (err) {
  console.error('send-stale-to-chat: KV lookup failed — falling back to alert text:', err)
}

if (!md) {
  await sendFallback()
  console.log('send-stale-to-chat: no saved edition available — sent fallback alert.')
  process.exit(0)
}

// Prefix note mirrors the Worker's serveStaleBriefing wording.
try {
  await tgRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: `Couldn't get a fresh briefing just now, so here's the last saved edition${date ? ` (from ${date})` : ''}:`,
    link_preview_options: { is_disabled: true },
  })
} catch (err) {
  console.error('send-stale-to-chat: failed to send prefix note:', err)
}

const ok = await sendHtml(token, chatId, mdToHtml(md), {
  onError: async (cid, res) =>
    console.error(`send-stale-to-chat: failed to send saved edition to ${cid}: ${res.status} ${await res.text()}`),
})
if (!ok) await sendFallback()
console.log(
  ok
    ? `send-stale-to-chat: sent last saved edition to ${chatId}.`
    : `send-stale-to-chat: saved-edition send failed — sent fallback alert.`,
)
