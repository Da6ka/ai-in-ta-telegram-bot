// Delivers an owner /broadcast to every subscriber, run on the GitHub Actions
// runner (triggered by the Worker via a `broadcast` repository_dispatch). This
// replaces the old in-Worker send loop, whose per-invocation subrequest cap
// silently dropped recipients past ~45 on the Workers free plan (BUG-4). The
// runner has no such cap and reuses the shared paced/retried sender.
//
// The message is passed as an env var (not interpolated into the shell), so a
// message containing shell metacharacters can't do anything. The recipient list
// is the live `subscribers` KV key the bot maintains — same source as the daily
// send — so /unsubscribe and /removeuser take effect immediately.
import { sendTextToMany, tgRequest } from '../shared/telegram.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const message = process.env.MESSAGE
const owner = process.env.OWNER_CHAT_ID
const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID } = process.env

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!message) throw new Error('MESSAGE is empty — nothing to broadcast')
if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) {
  throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID must be set')
}

const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/subscribers`
const kvRes = await fetch(kvUrl, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } })
let chatIds = []
if (kvRes.status === 404) {
  console.log('No `subscribers` key in KV — nobody to broadcast to.')
} else if (!kvRes.ok) {
  throw new Error(`KV get subscribers failed: ${kvRes.status} ${await kvRes.text()}`)
} else {
  // De-dupe at send time so a doubled-up subscriber id can't get the message twice.
  chatIds = [...new Set((JSON.parse(await kvRes.text()).subscribers ?? []).map(String).filter(Boolean))]
}

async function reportToOwner(text) {
  if (!owner) return
  try {
    await tgRequest(token, 'sendMessage', { chat_id: owner, text, link_preview_options: { is_disabled: true } })
  } catch (err) {
    console.error('Failed to send delivery report to owner:', err)
  }
}

if (chatIds.length === 0) {
  console.log('Subscriber list is empty — nothing to send.')
  await reportToOwner('Broadcast: there are no subscribers, so nothing was sent.')
  process.exit(0)
}

const { total, failed } = await sendTextToMany(token, chatIds, message, {
  onError: async (chatId, res) => console.error(`Failed to send to ${chatId}: ${res.status} ${await res.text()}`),
})

const summary = failed === 0
  ? `Broadcast delivered to all ${total} subscriber(s).`
  : `Broadcast delivered to ${total - failed}/${total} subscriber(s); ${failed} failed (see workflow logs).`
console.log(summary)
await reportToOwner(summary)
