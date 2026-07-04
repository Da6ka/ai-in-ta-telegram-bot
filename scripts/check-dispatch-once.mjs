// Guards against a repository_dispatch being processed more than once. The
// Worker's fetchWithRetry (worker/src/index.js) retries a dispatch POST on
// 429/5xx/network error -- but if GitHub actually accepted the original
// request and only the response was lost, the retry fires a second, distinct
// repository_dispatch event for the same logical action. For `broadcast`
// that means every subscriber gets the message twice; for `newbriefing` it
// means a second $2 LLM generation for the same request (#28).
//
// Each dispatch carries a dispatch_id (crypto.randomUUID(), set once per
// dispatchEvent() call in the Worker, so retried attempts of the same call
// share one id). This records the id in KV with a short TTL and reports
// whether it's already been seen, via GITHUB_OUTPUT's `duplicate` flag, so
// the calling workflow can skip the expensive/visible work for a repeat.
import { appendFileSync } from 'node:fs'

const { DISPATCH_ID, CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID } = process.env

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

// No id -- e.g. a manually triggered `gh api .../dispatches` call predating
// this change, or made outside the Worker. Nothing to dedupe against, so
// treat as fresh rather than block a legitimate manual run.
if (!DISPATCH_ID) {
  console.log('No dispatch_id on this event -- treating as a fresh (non-deduped) dispatch.')
  setOutput('duplicate', 'false')
  process.exit(0)
}

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_KV_NAMESPACE_ID) {
  throw new Error('CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID must be set')
}

const key = `dispatch_seen:${DISPATCH_ID}`
const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${key}`

const getRes = await fetch(base, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } })
if (getRes.status === 200) {
  console.log(`Dispatch ${DISPATCH_ID} already processed -- skipping duplicate delivery.`)
  setOutput('duplicate', 'true')
  process.exit(0)
}
if (getRes.status !== 404) {
  throw new Error(`KV get ${key} failed: ${getRes.status} ${await getRes.text()}`)
}

// TTL only needs to comfortably outlast any realistic retry window (network
// retries happen within seconds to low minutes) -- this isn't meant to block
// someone intentionally re-running the same command later.
const putRes = await fetch(`${base}?expiration_ttl=3600`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'text/plain' },
  body: new Date().toISOString(),
})
if (!putRes.ok) throw new Error(`KV put ${key} failed: ${putRes.status} ${await putRes.text()}`)

console.log(`Dispatch ${DISPATCH_ID} recorded -- proceeding.`)
setOutput('duplicate', 'false')
