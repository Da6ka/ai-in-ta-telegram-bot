// A subscriber who blocks the bot is unreachable forever, not temporarily:
// Telegram answers every later send with 403 until they unblock. Nothing used
// to act on that, so a blocked id stayed on the list and every daily send
// reported a failure for it — @sofia_b did exactly this on 2026-07-12 and the
// morning send read "4/5 subscriber(s)" for five weeks running.
//
// The obvious fix — have the send script drop the id from KV — does not work.
// The Worker's `scheduled` handler calls remirrorSubscribers() before every
// daily send, rewriting the KV mirror from the Durable Object, which is the
// source of truth (#49). A prune written by the runner survives until the next
// morning and is then overwritten by the DO's unchanged list.
//
// So the runner records blocked ids into KV and the *Worker* does the pruning:
// `scheduled` drains this key through the DO's unsubscribe() before it
// re-mirrors, which is both the correct writer and the right moment (just
// before the send that would otherwise fail again).

export const BLOCKED_PENDING_KEY = 'blocked_pending'

// Telegram returns 403 for "bot was blocked by the user" and for "user is
// deactivated". Both are permanent: no amount of retrying reaches that chat
// again, and tgRequest already declines to retry them. 400 ("chat not found")
// is also terminal but is left alone deliberately — it shows up for
// never-started chats and typo'd ids too, and silently unsubscribing on a 400
// would be a wider net than the problem needs.
export function isPermanentlyUnreachable(status) {
  return status === 403
}

// Merge ids into the pending-prune key. Merges rather than overwrites: the
// daily send and a broadcast can both hit the same blocked user before the
// Worker next drains it, and a plain PUT would drop whichever wrote first.
export async function recordBlocked(ids, { accountId, apiToken, namespaceId, fetchImpl = fetch } = {}) {
  const unique = [...new Set(ids.map(String).filter(Boolean))]
  if (unique.length === 0) return { recorded: [] }
  if (!accountId || !apiToken || !namespaceId) {
    console.error('recordBlocked: CF credentials missing — not recording', unique.join(', '))
    return { recorded: [] }
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${BLOCKED_PENDING_KEY}`
  const auth = { Authorization: `Bearer ${apiToken}` }

  let existing = []
  const res = await fetchImpl(url, { headers: auth })
  if (res.ok) {
    try {
      const parsed = JSON.parse(await res.text())
      if (Array.isArray(parsed)) existing = parsed.map(String)
    } catch {
      // A corrupt value must not strand the prune: start clean rather than throw.
      console.error('recordBlocked: existing value was not a JSON array — replacing it')
    }
  } else if (res.status !== 404) {
    throw new Error(`KV get ${BLOCKED_PENDING_KEY} failed: ${res.status} ${await res.text()}`)
  }

  const merged = [...new Set([...existing, ...unique])]
  const put = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'text/plain' },
    body: JSON.stringify(merged),
  })
  if (!put.ok) throw new Error(`KV put ${BLOCKED_PENDING_KEY} failed: ${put.status} ${await put.text()}`)
  return { recorded: unique, pending: merged }
}
