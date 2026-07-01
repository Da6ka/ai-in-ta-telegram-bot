// Pushes the freshly generated briefing into Cloudflare KV so the Worker's
// /briefing command can serve it from cache without re-triggering generation.
import { readFileSync } from 'node:fs'

const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID, RECIPIENT_COUNT } = process.env
if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) {
  throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID must be set')
}

const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`

async function kvGet(key) {
  const res = await fetch(`${base}/values/${key}`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`KV get ${key} failed: ${res.status} ${await res.text()}`)
  return res.text()
}

async function kvPut(key, value) {
  const res = await fetch(`${base}/values/${key}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'text/plain' },
    body: value,
  })
  if (!res.ok) throw new Error(`KV put ${key} failed: ${res.status} ${await res.text()}`)
}

const md = readFileSync('state/today_briefing.md', 'utf8')
const today = new Date().toISOString().slice(0, 10)

await kvPut('today_briefing_md', md)
await kvPut('today_briefing_date', today)

const existingRaw = await kvGet('usage_stats')
const existing = existingRaw
  ? JSON.parse(existingRaw)
  : { briefings_sent: 0, last_briefing_at: null, briefing_history: [], command_counts: {}, last_seen: {} }
existing.briefings_sent = (existing.briefings_sent ?? 0) + 1
existing.last_briefing_at = today
existing.briefing_history = [
  ...(existing.briefing_history ?? []),
  { date: today, recipients: Number(RECIPIENT_COUNT ?? 0) },
].slice(-30)
await kvPut('usage_stats', JSON.stringify(existing))

console.log('Synced briefing to Cloudflare KV.')
