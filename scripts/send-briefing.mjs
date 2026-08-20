// Sends state/today_briefing.md to every subscriber via the Telegram Bot API.
// The recipient list is the live one the bot maintains (/subscribe,
// /unsubscribe, /removeuser): the Worker mirrors it into the `subscribers`
// KV key, and this script reads that key via the KV REST API — no more
// hand-maintained TELEGRAM_SUBSCRIBER_CHAT_IDS secret. Run after the briefing
// has been generated and only if it's fresh for today, so a stale file from
// a skipped run (idempotency short-circuit) never gets re-sent.

import { readFileSync, appendFileSync } from 'node:fs'
import { mdToHtml } from '../shared/telegram-markdown.mjs'
import { sendHtmlToMany } from '../shared/telegram.mjs'
import { isPermanentlyUnreachable, recordBlocked } from '../shared/blocked-subscribers.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID } = process.env

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) {
  throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID must be set')
}

// Expose the recipient count to later workflow steps (usage stats, KV sync).
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/subscribers`
const kvRes = await fetch(kvUrl, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } })
let chatIds = []
if (kvRes.status === 404) {
  console.log('No `subscribers` key in KV yet — nobody has subscribed.')
} else if (!kvRes.ok) {
  throw new Error(`KV get subscribers failed: ${kvRes.status} ${await kvRes.text()}`)
} else {
  chatIds = (JSON.parse(await kvRes.text()).subscribers ?? []).map(String).filter(Boolean)
}

setOutput('recipient_count', chatIds.length)

if (chatIds.length === 0) {
  console.log('Subscriber list is empty — nothing to send.')
  process.exit(0)
}

const md = readFileSync('state/today_briefing.md', 'utf8')

// BRIEFING_DATE_HUMAN is set once per job by the workflow's "Pin today's
// date" step, so this freshness re-check can't disagree with the date
// force-briefing-date.mjs already stamped on the title (#25). Falls back to
// computing fresh for standalone/manual runs outside the workflow.
const today = process.env.BRIEFING_DATE_HUMAN || new Date().toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

if (!md.includes(today)) {
  console.log(`state/today_briefing.md does not contain today's date (${today}) — skipping send (nothing fresh was generated).`)
  process.exit(0)
}

// sendHtmlToMany chunks each message, retries 429/5xx (honoring Retry-After),
// and paces sends under Telegram's ~30 msg/s ceiling so large subscriber lists
// don't silently drop recipients to rate limiting.
const blocked = []
const { total, failed } = await sendHtmlToMany(token, chatIds, mdToHtml(md), {
  onError: async (chatId, res) => {
    // Read the body once: res is consumed here, so capture status first.
    const status = res.status
    console.error(`Failed to send to ${chatId}: ${status} ${await res.text()}`)
    // A 403 means blocked/deactivated -- permanent, not worth retrying tomorrow.
    if (isPermanentlyUnreachable(status)) blocked.push(chatId)
  },
})

// Queue them for the Worker to unsubscribe (see shared/blocked-subscribers.mjs
// for why the runner cannot do it directly). Never fail the send over this --
// the briefing already reached everyone reachable.
if (blocked.length > 0) {
  try {
    await recordBlocked(blocked, { accountId: CF_ACCOUNT_ID, apiToken: CF_API_TOKEN, namespaceId: CF_KV_NAMESPACE_ID })
    console.log(`Queued ${blocked.length} blocked subscriber(s) for unsubscribe: ${blocked.join(', ')}`)
  } catch (err) {
    console.error('Failed to queue blocked subscribers (they stay on the list for now):', err)
  }
}

console.log(failed === 0
  ? `Sent briefing to ${total} subscriber(s).`
  : `Sent briefing to ${total - failed}/${total} subscriber(s); ${failed} had delivery failures (see above).`)
