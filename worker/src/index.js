// Cloudflare Worker — Telegram webhook receiver for the ai-in-ta bot.
//
// Scope: fixed commands only (start/help/status/subscribe/unsubscribe/briefing/
// newbriefing/admin/listusers/adduser/removeuser/broadcast/pending). Free-form
// chat with Claude is intentionally NOT replicated here — that still needs the
// local server.ts + an interactive Claude Code session. Group chats are not
// supported (the bot has only ever been used in DMs).
//
// State:
//   - `access` and `subscribers` live in the BOT_DO Durable Object (single
//     "singleton" instance). These are mutated by concurrent users (adduser,
//     subscribe, approve/deny, ...) and a plain KV read-modify-write here lost
//     the vast majority of writes under real concurrency (measured: 15
//     concurrent /subscribe calls -> only 2 landed). Durable Object storage
//     serializes access to a single instance, so these are safe now.
//     The subscriber list is additionally mirrored into the `subscribers` KV
//     key after every change, so the daily-briefing pipeline
//     (scripts/send-briefing.mjs) reads the live list instead of a
//     hand-maintained TELEGRAM_SUBSCRIBER_CHAT_IDS repo secret.
//   - `usage_stats` stays in the BOT_STATE KV namespace as before. It's also
//     written directly by the GitHub Actions pipeline (scripts/sync-kv.mjs),
//     which can't be made to go through the Durable Object -- that
//     Worker-vs-CI race on the KV blob is a known, accepted limitation
//     (slightly-off admin stats at worst). recordCommand/purgeUsageStats are
//     DO methods (below) serialized via an explicit in-memory mutex
//     (withUsageLock), so the Worker-vs-Worker race is closed: a real erasure
//     (/forgetme, /removeuser) can no longer be silently undone by a
//     concurrent command's recordCommand write.
//   - `today_briefing_md` / `today_briefing_date` stay in KV: only the CI
//     pipeline ever writes them, so there's no concurrent-writer race.

import { DurableObject } from 'cloudflare:workers'
import { mdToHtml, chunk, escapeHtml } from '../../shared/telegram-markdown.mjs'

// Each briefing generation is a paid GitHub Actions + Claude API run, and the
// result is shared (one today_briefing for everyone) — so the cooldown is
// global, with a per-user daily cap as a backstop against one user hammering
// /newbriefing every hour all day.
const DISPATCH_COOLDOWN_MS = 60 * 60 * 1000
// The owner gets a much shorter cooldown so on-demand refreshes aren't blocked
// for an hour. The per-user daily cap (below) still applies to the owner as a
// cost backstop, since every run is a paid generation.
const OWNER_DISPATCH_COOLDOWN_MS = 5 * 60 * 1000
const DAILY_DISPATCH_CAP = 3

// A generation run (install + claude -p web search + send + KV sync) finishes
// well within this window. Used only for message wording: if the last dispatch
// was within it, a run is plausibly still in flight ("being generated"); if it
// was longer ago and there's still no fresh cache (e.g. a cooldown carried
// across the UTC-midnight boundary from the prior evening's run, before the
// 09:00 daily), nothing is generating — say so instead of claiming it is.
const GENERATION_IN_FLIGHT_MIN = 10

// The Worker's second cron trigger (worker/wrangler.toml) is an external
// heartbeat, fired ~3h after the 09:05 daily dispatch -- long past generation
// (~10 min) and the 10:30 GitHub watchdog -- so a healthy day has always synced
// today_briefing_date to KV by the time it runs. See briefingHeartbeat.
const HEARTBEAT_CRON = '0 12 * * *'

// Capacity cap for the current private, single-operator deployment. The daily
// send stays comfortably under Telegram's rate limit at this size, and (on the
// Workers free plan) /broadcast is subrequest-capped around here too. The
// (MAX_USERS+1)th person to request access is told the bot is full rather than
// queued. Raise this once broadcast delivery moves to the Actions runner.
const MAX_USERS = 30

// Independent cap on unapproved /start requests. MAX_USERS alone only turns
// people away once the allowlist itself is full -- it does nothing while
// allowFrom is nowhere near capacity, so a flood of /start from distinct
// senders (the bot is publicly discoverable on Telegram) could otherwise grow
// `access.pending` without bound and send the owner one new-request
// notification per sender with no rate limit. Set comfortably above
// MAX_USERS so normal approval churn (a backlog of legitimate requests
// waiting on the owner) never trips it.
const MAX_PENDING = 50

// Storage-limitation retention: the per-user last_seen activity log is pruned
// to entries from the last RETENTION_DAYS. Access/subscription state is kept
// as long as the user is a user (erased on /forgetme or owner /removeuser).
const RETENTION_DAYS = 90

const PRIVACY_TEXT =
  "<b>Privacy notice — AI in TA News</b>\n\n" +
  "<b>What we store</b>\n" +
  "- Your Telegram user ID — to control access and deliver the briefing\n" +
  "- Your name and @username — shown to the owner when you request access\n" +
  "- The date you last used the bot — an activity log, auto-deleted after 90 days\n\n" +
  "We never read or store your ordinary messages — only slash commands are processed.\n\n" +
  "<b>Why</b>\n" +
  "To run the private allowlist and send the daily AI-recruitment briefing you asked for. Legal basis is your consent, which you can withdraw any time.\n\n" +
  "<b>Where</b>\n" +
  "On Cloudflare infrastructure, which may process data outside your country. Telegram also handles your messages under its own privacy policy.\n\n" +
  "<b>Your rights</b>\n" +
  "- /mydata — see everything stored about you\n" +
  "- /unsubscribe — stop the daily briefing\n" +
  "- /forgetme — erase all your data from the bot\n\n" +
  "Questions? Contact the bot owner."

const DEFAULT_ACCESS = { dmPolicy: 'allowlist', allowFrom: [], ownerChatId: '', adminIds: [], pending: {} }
const DEFAULT_SUBSCRIBERS = { subscribers: [], owner: '' }
const DEFAULT_USAGE = {
  briefings_sent: 0,
  last_briefing_at: null,
  briefing_history: [],
  command_counts: {},
  last_seen: {},
}

// Durable Object: single source of truth for access/subscribers/dedup so
// concurrent requests can't race on a KV read-modify-write. All mutation
// methods here read+write via this.ctx.storage without an intervening await
// on external I/O, so Cloudflare's per-instance request serialization keeps
// each one atomic.
export class BotState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.env = env
    this._usageLock = Promise.resolve()
  }

  // In-memory mutex for the usage_stats KV read-modify-write methods below.
  // ctx.storage calls are automatically serialized per-instance by Cloudflare's
  // input/output gating, but KV access via fetch() is not -- without this, two
  // overlapping calls (e.g. /forgetme's purgeUsageStats racing a concurrent
  // command's recordCommand) could interleave their get/put and silently
  // un-erase a just-purged entry. Safe as plain in-memory state because a DO's
  // JS execution is single-threaded/cooperative: concurrent calls only
  // interleave at await points, which is exactly what this queues through
  // serially.
  async withUsageLock(fn) {
    const prev = this._usageLock
    let release
    this._usageLock = new Promise((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async getAccess() {
    let access = await this.ctx.storage.get('access')
    if (access === undefined) {
      // First touch: migrate whatever's already in KV (real production data)
      // into the Durable Object so cutover doesn't lose the existing allowlist.
      access = (await this.env.BOT_STATE.get('access', 'json')) ?? DEFAULT_ACCESS
      await this.ctx.storage.put('access', access)
    }
    // Normalize every return over DEFAULT_ACCESS so `adminIds`, `allowFrom`,
    // and `pending` are always present — records written before a field
    // existed (e.g. adminIds) would otherwise force `?? []` / `if (!...)`
    // defensive-init at every call site.
    return { ...DEFAULT_ACCESS, ...access }
  }

  async getSubscribers() {
    let subs = await this.ctx.storage.get('subscribers')
    if (subs === undefined) {
      subs = (await this.env.BOT_STATE.get('subscribers', 'json')) ?? DEFAULT_SUBSCRIBERS
      await this.ctx.storage.put('subscribers', subs)
    }
    return subs
  }

  // Enforced here (not in the handlers) so the capacity check + the write are
  // one atomic DO operation — two concurrent approvals can't both slip past a
  // handler-side length check and overshoot MAX_USERS.
  async addAllowedUser(id) {
    const access = await this.getAccess()
    if (access.allowFrom.includes(id)) return { access, added: false, atCapacity: false }
    if (access.allowFrom.length >= MAX_USERS) return { access, added: false, atCapacity: true }
    access.allowFrom.push(id)
    // Approving via any path (owner callback or /adduser <id>) clears the
    // pending request atomically — otherwise the person lingers in /pending
    // forever and their name/username stay stored, contradicting the privacy
    // model where approval deletes that info (BUG-7).
    delete access.pending[id]
    await this.ctx.storage.put('access', access)
    return { access, added: true, atCapacity: false }
  }

  // Delegated admin roles: an adminId gets the same command permissions as
  // the owner (see isOwnerOrAdmin below), except managing admins themselves
  // -- only the true owner can promote/revoke, so an admin can't grant
  // themselves further privilege or lock the owner out. Promotion requires
  // the id to already be on the allowlist (an admin is a trusted existing
  // user, not a shortcut around /adduser).
  async addAdmin(id) {
    const access = await this.getAccess()
    if (id === access.ownerChatId) return { access, ok: false, reason: 'already_owner' }
    if (!access.allowFrom.includes(id)) return { access, ok: false, reason: 'not_allowed' }
    if (access.adminIds.includes(id)) return { access, ok: false, reason: 'already_admin' }
    access.adminIds.push(id)
    await this.ctx.storage.put('access', access)
    return { access, ok: true }
  }

  async removeAdmin(id) {
    const access = await this.getAccess()
    if (!access.adminIds.includes(id)) return { access, ok: false }
    access.adminIds = access.adminIds.filter(x => x !== id)
    await this.ctx.storage.put('access', access)
    return { access, ok: true }
  }

  // Full erasure of one user's identifying state (right to be forgotten):
  // allowlist entry, subscription, and any pending request. The per-user
  // last_seen log lives in KV, so the Worker purges that separately.
  async forgetUser(id) {
    const access = await this.getAccess()
    const wasAllowed = access.allowFrom.includes(id)
    const wasPending = Boolean(access.pending[id])
    const wasAdmin = access.adminIds.includes(id)
    access.allowFrom = access.allowFrom.filter(x => x !== id)
    access.adminIds = access.adminIds.filter(x => x !== id)
    delete access.pending[id]
    const subs = await this.getSubscribers()
    const wasSubscribed = subs.subscribers.includes(id)
    subs.subscribers = subs.subscribers.filter(x => x !== id)
    // Mirror to KV *before* committing DO storage (REL-2): a kill/eviction
    // between the two must not leave an erased user still on the KV list
    // scripts/send-briefing.mjs reads, since that would keep sending them the
    // briefing after erasure with no signal for the owner to retry. A stale DO
    // write here self-heals on the user's next command; a stale KV mirror
    // wouldn't, since nothing else re-checks it.
    await this.mirrorSubscribers(subs)
    await this.ctx.storage.put('access', access)
    await this.ctx.storage.put('subscribers', subs)
    return { wasAllowed, wasPending, wasSubscribed, wasAdmin }
  }

  // Capacity check + write happen in one atomic DO operation (same pattern as
  // addAllowedUser above) so two near-simultaneous /start calls can't both
  // slip past a handler-side length check and overshoot MAX_PENDING.
  async addPending(id, info) {
    const access = await this.getAccess()
    const alreadyPending = Boolean(access.pending[id])
    if (alreadyPending) return { access, alreadyPending: true, atCapacity: false }
    if (Object.keys(access.pending).length >= MAX_PENDING) {
      return { access, alreadyPending: false, atCapacity: true }
    }
    access.pending[id] = info
    await this.ctx.storage.put('access', access)
    return { access, alreadyPending: false, atCapacity: false }
  }

  async removePending(id) {
    const access = await this.getAccess()
    delete access.pending[id]
    await this.ctx.storage.put('access', access)
    return access
  }

  async subscribe(id) {
    const subs = await this.getSubscribers()
    const already = subs.subscribers.includes(id)
    if (!already) {
      subs.subscribers.push(id)
      await this.ctx.storage.put('subscribers', subs)
    }
    await this.mirrorSubscribers(subs)
    return { subs, already }
  }

  async unsubscribe(id) {
    const subs = await this.getSubscribers()
    const wasSubscribed = subs.subscribers.includes(id)
    if (wasSubscribed) subs.subscribers = subs.subscribers.filter(x => x !== id)
    // Mirror before the DO commit (REL-2) -- same reasoning as forgetUser:
    // a removal must reach the KV read-side before it's durable in the DO.
    await this.mirrorSubscribers(subs)
    if (wasSubscribed) await this.ctx.storage.put('subscribers', subs)
    return { subs, wasSubscribed }
  }

  // Mirror the live subscriber list into KV so the daily-briefing pipeline
  // (scripts/send-briefing.mjs, via the KV REST API) sends to exactly the
  // people the bot considers subscribed. Runs even on no-op subscribe/
  // unsubscribe calls, so the owner can force a refresh of the mirror by
  // tapping /subscribe once (useful right after deploying this change).
  async mirrorSubscribers(subs) {
    await this.env.BOT_STATE.put('subscribers', JSON.stringify(subs))
  }

  // Rewrite the KV mirror from the DO source of truth, with no membership
  // change. Called by the daily `scheduled` handler so the list the send
  // pipeline reads (scripts/send-briefing.mjs, scripts/broadcast.mjs) can't
  // stay drifted from the DO (#49): mirrorSubscribers otherwise only fires on
  // a subscribe/unsubscribe, so if KV is ever reset/re-pointed/left stale by a
  // failed put, a still-subscribed user is silently dropped from delivery --
  // no error, no `Failed to send` line -- until someone happens to toggle a
  // subscription. Re-mirroring before every daily send makes that self-heal.
  async remirrorSubscribers() {
    const subs = await this.getSubscribers()
    await this.mirrorSubscribers(subs)
    return subs.subscribers.length
  }

  // Rate limiting for briefing generation. Check + record happen in one
  // method so two concurrent requests can't both pass the check and
  // double-dispatch.
  async reserveBriefingDispatch(senderId, isOwner = false) {
    const now = Date.now()
    const today = todayUTC()
    const rl = (await this.ctx.storage.get('briefing_rate')) ?? { lastDispatchAt: 0, date: today, counts: {} }
    if (rl.date !== today) {
      rl.date = today
      rl.counts = {}
    }
    if ((rl.counts[senderId] ?? 0) >= DAILY_DISPATCH_CAP) {
      return { allowed: false, reason: 'daily_cap' }
    }
    const cooldownMs = isOwner ? OWNER_DISPATCH_COOLDOWN_MS : DISPATCH_COOLDOWN_MS
    const elapsed = now - rl.lastDispatchAt
    if (elapsed < cooldownMs) {
      return {
        allowed: false,
        reason: 'cooldown',
        retryInMin: Math.ceil((cooldownMs - elapsed) / 60000),
        sinceLastMin: Math.floor(elapsed / 60000),
      }
    }
    const prevLastDispatchAt = rl.lastDispatchAt
    rl.lastDispatchAt = now
    rl.counts[senderId] = (rl.counts[senderId] ?? 0) + 1
    await this.ctx.storage.put('briefing_rate', rl)
    return { allowed: true, prevLastDispatchAt }
  }

  // Roll back a reservation whose GitHub dispatch failed, so a transient
  // dispatch error doesn't lock everyone out for a full cooldown window.
  async rollbackBriefingDispatch(senderId, prevLastDispatchAt) {
    const rl = await this.ctx.storage.get('briefing_rate')
    if (!rl) return
    rl.lastDispatchAt = prevLastDispatchAt ?? 0
    if (rl.counts[senderId]) rl.counts[senderId] -= 1
    await this.ctx.storage.put('briefing_rate', rl)
  }

  // Telegram redelivers updates it thinks weren't acknowledged. Keep a
  // capped ring of recently-seen update_ids so a redelivery is a no-op
  // instead of re-running a non-idempotent command like /broadcast.
  async recordSeenUpdate(updateId) {
    const seen = (await this.ctx.storage.get('seen_updates')) ?? []
    if (seen.includes(updateId)) return false
    seen.push(updateId)
    while (seen.length > 200) seen.shift()
    await this.ctx.storage.put('seen_updates', seen)
    return true
  }

  // usage_stats lives in KV (not DO storage -- see the top-of-file note: the
  // CI pipeline's scripts/sync-kv.mjs writes it directly via the REST API, so
  // it can never be fully race-free). Routing every Worker-side writer
  // through this singleton DO closes the Worker-vs-Worker race, but only
  // because of withUsageLock() below -- Cloudflare's automatic input/output
  // gating serializes ctx.storage calls, not the KV access these methods make
  // via fetch(), so without an explicit in-memory lock, record/purge calls
  // that land concurrently (e.g. /forgetme's erasure racing a concurrent
  // /briefing's recordCommand) could still interleave their get/put and
  // silently un-erase a just-purged entry.
  //
  // One command touches two fields of the same blob (command_counts and
  // last_seen), so both updates share a single read-modify-write here rather
  // than two — halving the per-command KV round-trips and removing the window
  // where a bump and a touch could interleave against each other.
  async recordCommand(senderId, name) {
    return this.withUsageLock(async () => {
      const stats = await getJSON(this.env, 'usage_stats', DEFAULT_USAGE)
      const prev = Object.hasOwn(stats.command_counts, name) ? stats.command_counts[name] : 0
      stats.command_counts[name] = prev + 1
      stats.last_seen[senderId] = todayUTC()
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10)
      for (const [id, date] of Object.entries(stats.last_seen)) {
        if (typeof date === 'string' && date < cutoff) delete stats.last_seen[id]
      }
      await putJSON(this.env, 'usage_stats', stats)
    })
  }

  // Right-to-erasure counterpart to recordCommand above -- must go through
  // this same DO and withUsageLock() for the serialization to actually
  // protect it.
  async purgeUsageStats(id) {
    return this.withUsageLock(async () => {
      const stats = await getJSON(this.env, 'usage_stats', DEFAULT_USAGE)
      if (stats.last_seen && id in stats.last_seen) {
        delete stats.last_seen[id]
        await putJSON(this.env, 'usage_stats', stats)
        return true
      }
      return false
    })
  }
}

async function getJSON(env, key, fallback) {
  // A corrupt value (invalid JSON) would otherwise throw here, bubble up, be
  // swallowed by the top-level handler catch, and leave the user with no reply
  // for EVERY command. Degrade to the fallback instead (SEC-4 / BUG-8).
  try {
    const v = await env.BOT_STATE.get(key, 'json')
    return v ?? fallback
  } catch {
    return fallback
  }
}
async function putJSON(env, key, value) {
  await env.BOT_STATE.put(key, JSON.stringify(value))
}

// Retries transient failures (429/5xx/network) with a short backoff; gives
// up immediately on other 4xx since retrying won't help. Callers still get
// back whatever final Response (or thrown error) resulted.
async function fetchWithRetry(url, options, { retries = 2 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.ok || res.status < 429 || attempt === retries) return res
      if (res.status === 429 || res.status >= 500) {
        // Honor Retry-After in seconds (its real unit); fall back to a short
        // linear backoff when the header is absent. Previously multiplied by
        // 300ms, so a 5s ask retried in 1.5s and drew a second 429 (SEC-2).
        const retryAfter = Number(res.headers.get('retry-after'))
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 300
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 300))
        continue
      }
    }
  }
  throw lastErr
}

async function tg(env, method, body) {
  try {
    const res = await fetchWithRetry(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (!json.ok) console.error(`Telegram API error on ${method}:`, json.description)
    return json
  } catch (err) {
    console.error(`Telegram API request failed on ${method}:`, err)
    return { ok: false, description: String(err) }
  }
}

function reply(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, ...extra })
}

async function sendHtml(env, chatId, html) {
  let allOk = true
  for (const part of chunk(html, 3500)) {
    const res = await reply(env, chatId, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    if (!res.ok) allOk = false
  }
  return allOk
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

// Delegated admin roles: an admin gets every owner-gated command except
// managing admins (addadmin/removeadmin) and the handful of protections
// tied specifically to the singleton owner (can't be removed, can't
// unsubscribe/erase themselves) -- those stay keyed to ownerChatId alone.
function isOwnerOrAdmin(access, id) {
  return id === access.ownerChatId || access.adminIds.includes(id)
}

// recordCommand/purgeUsageStats now live as BotState DO methods above, so
// both usage_stats writers serialize through the singleton stub instead of
// racing each other's KV read-modify-write.

// Like the old dmCommandGate(): DM only, dmPolicy check. No pairing-code
// machinery here — /start's approve/deny buttons are the only approval path
// in the commands-only scope.
async function dmCommandGate(stub, message) {
  if (message.chat?.type !== 'private') return null
  if (!message.from) return null
  const senderId = String(message.from.id)
  const access = await stub.getAccess()
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) {
    // Still let /start through so unapproved users can request access.
    return { access, stub, senderId, isAllowed: false }
  }
  return { access, stub, senderId, isAllowed: access.allowFrom.includes(senderId) }
}

// Fire a repository_dispatch so a GitHub Actions workflow does the heavy/slow
// work (briefing generation, broadcast fan-out) outside the Worker's request
// lifetime and subrequest cap. Returns true iff GitHub accepted the dispatch.
//
// dispatch_id lets the workflow (scripts/check-dispatch-once.mjs) detect a
// duplicate: fetchWithRetry can retry this POST on a 429/5xx/network error
// even when GitHub already accepted the original request and only the
// response was lost, which would otherwise fire a second, distinct
// repository_dispatch for the same logical broadcast/newbriefing (#28).
// Generated once per call (outside fetchWithRetry's loop), so every retry
// attempt of the same call carries the same id.
async function dispatchEvent(env, eventType, clientPayload, { retries = 1 } = {}) {
  try {
    const payload = { ...clientPayload, dispatch_id: crypto.randomUUID() }
    const res = await fetchWithRetry(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ai-in-ta-telegram-bot-worker',
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    }, { retries })
    if (!res.ok) {
      console.error(`GitHub dispatch failed (${eventType})`, res.status, await res.text())
      return false
    }
    return true
  } catch (err) {
    console.error(`GitHub dispatch request failed (${eventType})`, err)
    return false
  }
}

function dispatchBriefing(env, chatId) {
  return dispatchEvent(env, 'newbriefing', { chat_id: String(chatId) })
}

// Last-resort fallback for /briefing and /newbriefing: when a *fresh*
// (today's) briefing can't be produced or served right now -- cooldown with
// nothing generating, daily cap reached, or a failed dispatch -- send the
// most recent saved edition with a dated note instead of leaving the user
// with nothing. today_briefing_md holds the last successfully-synced
// briefing and today_briefing_date the day it was for. Returns true iff a
// stale edition was sent -- false when the cache is empty, or is already
// today's (that case is served by the caller's fresh path, not here).
async function serveStaleBriefing(env, senderId) {
  const date = await env.BOT_STATE.get('today_briefing_date')
  if (date === todayUTC()) return false
  const md = await env.BOT_STATE.get('today_briefing_md')
  if (!md) return false
  await reply(env, senderId, `Couldn't get a fresh briefing just now, so here's the last saved edition${date ? ` (from ${date})` : ''}:`)
  const ok = await sendHtml(env, senderId, mdToHtml(md))
  if (!ok) await reply(env, senderId, 'Something went wrong sending the saved briefing — please try /briefing again in a moment.')
  return true
}

// Shared by /newbriefing and /briefing's stale-cache path: rate-limit check,
// then dispatch generation, rolling back the reservation if dispatch fails.
// During the cooldown the user still gets something — the cached briefing if
// today's exists, otherwise a "being generated" note (a run is likely in
// flight, since the cooldown started less than an hour ago).
async function requestGeneration(env, stub, senderId, generatingMsg, isOwner = false) {
  const r = await stub.reserveBriefingDispatch(senderId, isOwner)
  if (!r.allowed) {
    if (r.reason === 'daily_cap') {
      if (await serveStaleBriefing(env, senderId)) return
      await reply(env, senderId, "You've reached today's limit for fresh briefings — /briefing will still get you the latest one.")
      return
    }
    const date = await env.BOT_STATE.get('today_briefing_date')
    if (date === todayUTC()) {
      const md = await env.BOT_STATE.get('today_briefing_md')
      if (md) {
        await reply(env, senderId, `The briefing was refreshed less than an hour ago — here it is. A new one can be generated in ~${r.retryInMin} min.`)
        await sendHtml(env, senderId, mdToHtml(md))
        return
      }
    }
    // Cooldown active with no fresh cache. If the last dispatch was recent, a
    // run is plausibly still generating -- say so and let it arrive. Otherwise
    // nothing is running (a cooldown carried over from last night, or a
    // generation that already failed), so fall back to the last saved edition
    // rather than leaving the user with nothing.
    if (r.sinceLastMin <= GENERATION_IN_FLIGHT_MIN) {
      await reply(env, senderId, 'A briefing is being generated right now — send /briefing in a couple of minutes to get it.')
      return
    }
    if (await serveStaleBriefing(env, senderId)) return
    await reply(env, senderId, `Couldn't refresh the briefing just now — a fresh one can be generated in ~${r.retryInMin} min. You'll also get today's automatically with the daily update.`)
    return
  }
  await reply(env, senderId, generatingMsg)
  const dispatched = await dispatchBriefing(env, senderId)
  if (!dispatched) {
    await stub.rollbackBriefingDispatch(senderId, r.prevLastDispatchAt)
    if (await serveStaleBriefing(env, senderId)) return
    await reply(env, senderId, "Couldn't start briefing generation right now — please try again shortly, or contact the bot owner if this keeps happening.")
  }
}

// External heartbeat: alert the owner when a whole day's briefing never lands.
// Every in-Actions guard (the workflow's own retries, the 10:30 UTC watchdog) is
// useless when GitHub Actions is blocked account-wide -- a billing hold or
// outage makes those runs `startup_failure`, so they never execute (seen live
// Jul 8-10 2026). This runs on Cloudflare, independent of GitHub, and reads
// today_briefing_date -- written to KV only by a successful generation's
// sync-kv.mjs -- so a value that isn't today means nothing was delivered.
async function briefingHeartbeat(env) {
  const today = todayUTC()
  const date = await env.BOT_STATE.get('today_briefing_date')
  if (date === today) return // healthy: today's edition synced to KV
  const stub = env.BOT_DO.get(env.BOT_DO.idFromName('singleton'))
  const owner = (await stub.getAccess()).ownerChatId
  if (!owner) return
  const repo = env.GITHUB_REPO || 'Da6ka/ai-in-ta-telegram-bot'
  await reply(
    env,
    owner,
    `[ai-in-ta] Today's briefing (${today}) hasn't landed by 12:00 UTC — nothing was delivered. ` +
      `This heartbeat runs on Cloudflare, so it fires even when GitHub Actions is blocked account-wide ` +
      `(billing hold / outage) — the failure mode the in-Actions watchdog can't catch. ` +
      `Last saved edition: ${date || 'none'}. Check https://github.com/${repo}/actions`,
  )
}

// Access role required to run each command, checked once in handleMessage
// before dispatch (see the note there). 'owner' = the singleton owner only
// (delegating admin can't itself be delegated); 'admin' = owner or a
// delegated admin. Any command not listed is reachable by any gated sender
// (those handlers still do their own isAllowed check where relevant). Keeping
// this as data — rather than a copy-pasted gate block in each handler — means
// a newly-added privileged command can't accidentally ship ungated.
const COMMAND_ROLES = {
  admin: 'admin',
  listusers: 'admin',
  adduser: 'admin',
  removeuser: 'admin',
  broadcast: 'admin',
  pending: 'admin',
  addadmin: 'owner',
  removeadmin: 'owner',
}

const COMMAND_HANDLERS = {
  async start(env, message, gated) {
    const { access, senderId, isAllowed, stub } = gated
    if (isAllowed) {
      await reply(env, senderId,
        "Welcome to AI in TA News!\n\n" +
        "Tap /briefing to get today's AI recruitment digest, or /subscribe to get it every morning automatically.\n\n" +
        "Send /help anytime to see everything the bot can do.")
      return
    }
    const from = message.from
    // Capacity cap: don't queue a request the owner has no room to approve.
    // An already-pending user still falls through to their "still waiting"
    // status below — only brand-new requests are turned away.
    if (!access.pending[senderId] && access.allowFrom.length >= MAX_USERS) {
      await reply(env, senderId,
        "Thanks for your interest in AI in TA News! The bot is currently at capacity, so new access requests are paused for now. Please check back later.")
      return
    }
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
    const username = from.username ? `@${from.username}` : 'no username'
    const { alreadyPending, atCapacity } = await stub.addPending(senderId, { displayName, username, createdAt: Date.now() })
    // Distinct-sender flood guard: MAX_USERS above only bites once the
    // allowlist is full, so without this a flood of /start from many
    // different accounts could grow access.pending without bound and send
    // the owner one new-request notification per sender. Not added to
    // pending, so no owner notification and no state growth for this one.
    if (atCapacity) {
      await reply(env, senderId,
        'Thanks for your interest in AI in TA News! There are a lot of pending requests right now, so new ones are paused briefly. Please try again later.')
      return
    }
    if (!alreadyPending && access.ownerChatId) {
      await tg(env, 'sendMessage', {
        chat_id: access.ownerChatId,
        text: `New access request\n\nName: ${displayName}\nUsername: ${username}\nID: ${from.id}`,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `acc:Y:${from.id}` },
            { text: 'Deny', callback_data: `acc:N:${from.id}` },
          ]],
        },
      })
    }
    await reply(env, senderId,
      alreadyPending
        ? `Your access request is still waiting on the owner — no need to send /start again.\n\nYour Telegram ID: <code>${from.id}</code>`
        : `Welcome to AI in TA News!\n\nThis is a private bot. Your access request has been sent to the owner.\n\n` +
          `Your Telegram ID: <code>${from.id}</code>\n\nYou'll be able to use /briefing and /subscribe once approved.`,
      { parse_mode: 'HTML' })
  },

  async help(env, message, gated) {
    const { senderId, isAllowed } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first. Send /start to request access.')
      return
    }
    await reply(env, senderId,
      "This is AI in TA News — a curated digest of AI in talent acquisition.\n\n" +
      "Here you'll find:\n" +
      "- How recruiters are using Claude & Anthropic tools\n" +
      "- Latest AI hiring trends, tools, and best practices\n" +
      "- Must-read articles and resources\n\n" +
      "Just tap /briefing anytime to get the latest edition.\n\n" +
      "/briefing — get today's briefing (or resend it if you already have it)\n" +
      "/newbriefing — search for more news beyond what /briefing already sent\n" +
      "/subscribe — get the daily briefing every morning\n" +
      "/unsubscribe — stop the daily briefing\n" +
      "/status — check your access status\n" +
      "/privacy — how your data is handled\n" +
      "/mydata — see what's stored about you\n" +
      "/forgetme — erase your data")
  },

  async status(env, message, gated) {
    const { senderId, isAllowed } = gated
    if (isAllowed) {
      const name = message.from.username ? `@${message.from.username}` : senderId
      await reply(env, senderId, `Approved as ${name}`)
      return
    }
    await reply(env, senderId,
      `You don't have access yet.\n\nSend /start to request access. Your Telegram ID: <code>${senderId}</code>`,
      { parse_mode: 'HTML' })
  },

  async subscribe(env, message, gated) {
    const { senderId, isAllowed, stub } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first. Send /start to request access.')
      return
    }
    const { already } = await stub.subscribe(senderId)
    await reply(env, senderId, already
      ? "You're already subscribed to the daily AI recruitment briefing. You'll receive it every morning at 9:00 AM UTC."
      : "You're subscribed! You'll receive the daily AI recruitment briefing every morning at 9:00 AM UTC.\n\n" +
        "By subscribing you consent to the bot storing your Telegram ID to deliver it. See /privacy for details. Send /unsubscribe to stop, or /forgetme to erase your data.")
  },

  async unsubscribe(env, message, gated) {
    const { senderId, stub } = gated
    const subsBefore = await stub.getSubscribers()
    if (subsBefore.owner && senderId === subsBefore.owner) {
      await reply(env, senderId, "You're the bot owner — you can't unsubscribe from your own briefing.")
      return
    }
    const { wasSubscribed } = await stub.unsubscribe(senderId)
    await reply(env, senderId, wasSubscribed
      ? "You've been unsubscribed. Send /subscribe any time to start receiving the briefing again."
      : "You're not currently subscribed.")
  },

  // Available to anyone, approved or not — a privacy notice you can't read
  // until you're approved isn't much of a notice.
  async privacy(env, message, gated) {
    await reply(env, gated.senderId, PRIVACY_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  },

  // Subject access request: shows the sender exactly what the bot holds about
  // them. Ungated on purpose — even a pending/unapproved user can see (and via
  // /forgetme erase) their own data.
  async mydata(env, message, gated) {
    const { senderId, access, stub } = gated
    const subs = await stub.getSubscribers()
    const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
    const pending = access.pending[senderId]
    const lines = [
      '<b>Your data on file</b>\n',
      `Telegram ID: <code>${senderId}</code>`,
    ]
    if (pending) {
      lines.push(`Name on file: ${escapeHtml(pending.displayName || '—')}`)
      lines.push(`Username on file: ${escapeHtml(pending.username || '—')}`)
      lines.push(`Access requested: ${pending.createdAt ? new Date(pending.createdAt).toISOString().slice(0, 10) : '—'}`)
    }
    lines.push(`Allowlisted: ${access.allowFrom.includes(senderId) ? 'yes' : 'no'}`)
    lines.push(`Subscribed to daily briefing: ${subs.subscribers.includes(senderId) ? 'yes' : 'no'}`)
    lines.push(`Last active: ${stats.last_seen?.[senderId] ?? '—'}`)
    lines.push('\nTo erase all of this, send /forgetme. See /privacy for how it\'s used.')
    await reply(env, senderId, lines.join('\n'), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  },

  // Right to erasure. The owner can't erase themselves (it would break the
  // bot); they'd remove the deployment instead.
  async forgetme(env, message, gated) {
    const { senderId, access, stub } = gated
    if (senderId === access.ownerChatId) {
      await reply(env, senderId, "You're the bot owner — your data can't be erased while you run the bot.")
      return
    }
    const r = await stub.forgetUser(senderId)
    const purged = await stub.purgeUsageStats(senderId)
    const hadData = r.wasAllowed || r.wasSubscribed || r.wasPending || purged
    await reply(env, senderId, hadData
      ? "Done — everything the bot stored about you has been erased: allowlist access, subscription, any pending request, and your activity log. Send /start if you ever want to come back."
      : "There's nothing on file to erase. Send /start if you'd like to request access.")
  },

  async briefing(env, message, gated) {
    const { senderId, isAllowed, stub, access } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first — send /start to request access.')
      return
    }
    // Stored as a plain "YYYY-MM-DD" string by scripts/sync-kv.mjs, not JSON
    // -- reading it with the 'json' KV type throws (unquoted text isn't
    // valid JSON), which silently broke /briefing with no reply at all.
    const date = await env.BOT_STATE.get('today_briefing_date')
    if (date === todayUTC()) {
      const md = await env.BOT_STATE.get('today_briefing_md')
      if (md) {
        const ok = await sendHtml(env, senderId, mdToHtml(md))
        if (!ok) await reply(env, senderId, "Something went wrong sending today's briefing — please try /briefing again in a moment.")
        return
      }
    }
    await requestGeneration(env, stub, senderId, "Generating today's briefing, one moment...", senderId === access.ownerChatId)
  },

  async newbriefing(env, message, gated) {
    const { senderId, isAllowed, stub, access } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first — send /start to request access.')
      return
    }
    await requestGeneration(env, stub, senderId, 'Generating a fresh briefing, this will take a minute...', senderId === access.ownerChatId)
  },

  async admin(env, message, gated) {
    const { access, senderId, stub } = gated
    const subs = await stub.getSubscribers()
    const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
    const c = stats.command_counts
    await reply(env, senderId,
      `Bot Admin Panel\n\n` +
      `Users\n` +
      `- Allowlisted: ${access.allowFrom.length}\n` +
      `- Subscribed: ${subs.subscribers.length}\n` +
      `- Admins: ${access.adminIds.length}\n` +
      `- Pending pairings: ${Object.keys(access.pending).length}\n\n` +
      `Briefings\n` +
      `- Total sent: ${stats.briefings_sent}\n` +
      `- Last sent: ${stats.last_briefing_at ?? 'never'}\n\n` +
      `Command usage\n` +
      // Derived from the handler map so a newly-added command is counted here
      // automatically instead of silently missing from a hand-maintained list.
      Object.keys(COMMAND_HANDLERS).sort().map(name => `- /${name}: ${c[name] ?? 0}`).join('\n') + `\n\n` +
      `Use /listusers, /pending, /adduser <id>, /removeuser <id>, /broadcast <msg>\n` +
      `Owner only: /addadmin <id>, /removeadmin <id>`)
  },

  async listusers(env, message, gated) {
    const { access, senderId, stub } = gated
    const subs = await stub.getSubscribers()
    const lines = access.allowFrom.map(id => {
      const tags = []
      if (id === access.ownerChatId) tags.push('[owner]')
      if (access.adminIds.includes(id)) tags.push('[admin]')
      if (subs.subscribers.includes(id)) tags.push('[subscribed]')
      if (tags.length === 0) tags.push('[allowed]')
      return `${id} — ${tags.join('')}`
    })
    await reply(env, senderId,
      `Users (${access.allowFrom.length})\n\n${lines.join('\n')}\n\n/adduser <id> to add · /removeuser <id> to remove`)
  },

  async adduser(env, message, gated, args) {
    const { senderId, stub } = gated
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /adduser <chat_id>')
      return
    }
    if (!/^-?\d+$/.test(id)) {
      await reply(env, senderId, `"${id}" doesn't look like a Telegram chat id (should be numeric). Usage: /adduser <chat_id>`)
      return
    }
    if (args.length > 1) {
      await reply(env, senderId, `/adduser takes exactly one chat id — I didn't add anyone (ignoring extra argument(s): ${args.slice(1).join(' ')}). Send: /adduser <chat_id>`)
      return
    }
    const { added, atCapacity } = await stub.addAllowedUser(id)
    if (atCapacity) {
      await reply(env, senderId, `Can't add <code>${escapeHtml(id)}</code> — the bot is at capacity (${MAX_USERS} users). Remove someone with /removeuser first, or raise the limit.`, { parse_mode: 'HTML' })
      return
    }
    if (!added) {
      await reply(env, senderId, `User <code>${escapeHtml(id)}</code> is already on the allowlist.`, { parse_mode: 'HTML' })
      return
    }
    await reply(env, senderId, `User <code>${escapeHtml(id)}</code> added to the allowlist. They can now use the bot. They'll need to /subscribe for daily briefings.`, { parse_mode: 'HTML' })
  },

  async removeuser(env, message, gated, args) {
    const { access, senderId, stub } = gated
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /removeuser <chat_id>')
      return
    }
    if (args.length > 1) {
      await reply(env, senderId, `/removeuser takes exactly one chat id — I didn't remove anyone (ignoring extra argument(s): ${args.slice(1).join(' ')}). Send: /removeuser <chat_id>`)
      return
    }
    if (id === access.ownerChatId) {
      await reply(env, senderId, "You can't remove the bot owner.")
      return
    }
    const r = await stub.forgetUser(id)
    const purged = await stub.purgeUsageStats(id)
    if (!r.wasAllowed && !r.wasSubscribed && !r.wasPending && !purged) {
      await reply(env, senderId, `User <code>${escapeHtml(id)}</code> not found.`, { parse_mode: 'HTML' })
      return
    }
    const adminNote = r.wasAdmin ? ' They were also a delegated admin — that status is revoked too.' : ''
    await reply(env, senderId, `User <code>${escapeHtml(id)}</code> removed and all their data erased (allowlist, subscription, pending request, activity log).${adminNote}`, { parse_mode: 'HTML' })
  },

  // Delegating admin is owner-only (not admin-gated like the other admin
  // commands) -- an admin promoting peers or demoting the owner's other
  // admins would erode the point of keeping this one decision with the
  // owner. Requires the target to already be an approved user (/adduser
  // first) so admin status is a promotion, not a backdoor around the
  // allowlist.
  async addadmin(env, message, gated, args) {
    const { senderId, stub } = gated
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /addadmin <chat_id>')
      return
    }
    if (args.length > 1) {
      await reply(env, senderId, `/addadmin takes exactly one chat id — no change made (ignoring extra argument(s): ${args.slice(1).join(' ')}). Send: /addadmin <chat_id>`)
      return
    }
    const { ok, reason } = await stub.addAdmin(id)
    if (!ok) {
      const msg = {
        already_owner: "The owner doesn't need admin status — already has full access.",
        not_allowed: `User <code>${escapeHtml(id)}</code> isn't on the allowlist yet — /adduser them first.`,
        already_admin: `User <code>${escapeHtml(id)}</code> is already an admin.`,
      }[reason] ?? `Couldn't add <code>${escapeHtml(id)}</code> as admin.`
      await reply(env, senderId, msg, { parse_mode: 'HTML' })
      return
    }
    await reply(env, senderId, `User <code>${escapeHtml(id)}</code> is now a delegated admin — they can use every owner-gated command except /addadmin and /removeadmin.`, { parse_mode: 'HTML' })
  },

  async removeadmin(env, message, gated, args) {
    const { senderId, stub } = gated
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /removeadmin <chat_id>')
      return
    }
    if (args.length > 1) {
      await reply(env, senderId, `/removeadmin takes exactly one chat id — no change made (ignoring extra argument(s): ${args.slice(1).join(' ')}). Send: /removeadmin <chat_id>`)
      return
    }
    const { ok } = await stub.removeAdmin(id)
    await reply(env, senderId, ok
      ? `User <code>${escapeHtml(id)}</code> is no longer an admin. They keep regular allowlist access.`
      : `User <code>${escapeHtml(id)}</code> wasn't an admin.`, { parse_mode: 'HTML' })
  },

  async broadcast(env, message, gated, args, rawText) {
    const { senderId, stub } = gated
    // Strip on the trimmed text: the command regex matched on trimmed input, so
    // "  /broadcast hi" would otherwise fail the ^-anchored strip and ship the
    // literal command prefix out to every subscriber (BUG-5).
    const msg = (rawText ?? '').trim().replace(/^\/broadcast(@\S+)?\s*/i, '')
    if (!msg) {
      await reply(env, senderId, 'Usage: /broadcast <message>')
      return
    }
    const subs = await stub.getSubscribers()
    if (subs.subscribers.length === 0) {
      await reply(env, senderId, 'There are no subscribers to broadcast to.')
      return
    }
    // Delivery runs on the Actions runner (scripts/broadcast.mjs), not in this
    // Worker: looping sendMessage here hit the per-invocation subrequest cap and
    // silently dropped recipients past ~45 (BUG-4). We dispatch the message and
    // the owner gets an async delivery report from the runner.
    const dispatched = await dispatchEvent(env, 'broadcast', { message: msg, owner: senderId })
    await reply(env, senderId, dispatched
      ? `Broadcasting to ${subs.subscribers.length} subscriber(s) — I'll send you a delivery report when it finishes.`
      : "Couldn't start the broadcast right now — please try again shortly, or check the Worker logs if this keeps happening.")
  },

  async pending(env, message, gated) {
    const { access, senderId } = gated
    const entries = Object.entries(access.pending)
    if (entries.length === 0) {
      await reply(env, senderId, 'No pending pairing requests.')
      return
    }
    const lines = entries.map(([id, p]) =>
      `${id} — ${p.displayName || 'unknown'} (${p.username || 'no username'}), requested ${p.createdAt ? new Date(p.createdAt).toISOString() : ''}`)
    await reply(env, senderId, `Pending pairings (${entries.length})\n\n${lines.join('\n')}\n\nUse /adduser <id> to approve or ignore to deny.`)
  },
}

async function handleCallbackQuery(env, stub, callbackQuery) {
  const data = callbackQuery.data ?? ''
  const am = /^acc:([YN]):(\d+)$/.exec(data)
  if (!am) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id })
    return
  }
  const access = await stub.getAccess()
  const senderId = String(callbackQuery.from.id)
  if (!isOwnerOrAdmin(access, senderId)) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Not authorized.' })
    return
  }
  const [, decision, targetId] = am
  const msg = callbackQuery.message
  if (decision === 'Y') {
    // Stale-button guard: if the target is no longer pending (already handled,
    // or removed since this card was sent), don't silently re-add them (BUG-6).
    if (!access.pending[targetId]) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'No longer pending' })
      if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nNo longer pending — ignored.` })
      return
    }
    const { atCapacity } = await stub.addAllowedUser(targetId)
    if (atCapacity) {
      // Leave them pending so the owner can approve once a slot frees up.
      await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: `At capacity (${MAX_USERS})` })
      if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nNot approved — bot at capacity (${MAX_USERS}). Remove a user, then approve again.` })
      return
    }
    await stub.removePending(targetId)
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Approved' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nApproved` })
    await reply(env, targetId, "You're approved! Send /briefing or /subscribe to get started.")
  } else {
    await stub.removePending(targetId)
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Denied' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nDenied` })
    // Close the loop for the applicant instead of leaving them waiting in
    // silence. Neutral wording — doesn't invite argument or re-requests.
    await reply(env, targetId, "Your access request wasn't approved at this time.")
  }
}

async function handleMessage(env, stub, message) {
  const gated = await dmCommandGate(stub, message)
  if (!gated) return // not a private chat, no sender, or DMs disabled — stay silent (no group replies)

  // Commands-only scope, but don't leave anything unanswered — plain text,
  // typo'd commands, and non-text messages (stickers/photos/voice) all get a
  // short guide instead of silence. Non-text yields no match below (empty
  // string), so it falls into the same nudge. We neither store nor echo the
  // content; the reply is a fixed string.
  const text = message.text
  const m = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s.exec((text ?? '').trim())
  // Telegram commands are case-insensitive by convention, and mobile keyboards
  // autocapitalize — normalize so /Start, /Briefing etc. resolve to the
  // handler instead of falling through to the nudge.
  const cmd = m ? m[1].toLowerCase() : null
  // Object.hasOwn: /constructor, /__proto__ etc. must not resolve to
  // Object.prototype members — they'd be treated as handlers and produce
  // silence instead of the nudge.
  const handler = cmd && Object.hasOwn(COMMAND_HANDLERS, cmd) ? COMMAND_HANDLERS[cmd] : null
  if (!handler) {
    await reply(env, gated.senderId, gated.isAllowed
      ? "I only understand commands. Tap /briefing for today's digest, or /help to see everything I can do."
      : "I only understand commands. Send /start to request access.")
    return
  }

  // Role gate lives here (data, not a per-handler code block) so a new
  // privileged command can't accidentally ship ungated: adding it to
  // COMMAND_ROLES is the single place that grants/withholds access. Checked
  // before recordCommand so a refused attempt isn't counted as usage.
  const role = COMMAND_ROLES[cmd]
  if (role) {
    const ok = role === 'owner'
      ? gated.senderId === gated.access.ownerChatId
      : isOwnerOrAdmin(gated.access, gated.senderId)
    if (!ok) {
      await reply(env, gated.senderId, role === 'owner'
        ? 'This command is only available to the bot owner.'
        : 'This command is only available to the bot owner or a delegated admin.')
      return
    }
  }

  const argStr = m[2]
  await stub.recordCommand(gated.senderId, cmd)

  const args = (argStr ?? '').split(/\s+/).filter(Boolean)
  await handler(env, message, gated, args, text)
}

export default {
  // Cloudflare Cron Trigger (see wrangler.toml's [triggers]) — a reliable
  // replacement for GitHub Actions' own `schedule` trigger, which has proven
  // to fire 1-4h late or not at all for daily-briefing.yml (issue #17).
  // daily-briefing.yml's last_briefing_at idempotency check makes this safe
  // to race with (or duplicate) GitHub's own schedule/watchdog firing.
  async scheduled(event, env, ctx) {
    // Two crons (worker/wrangler.toml): the 12:00 UTC one is an external
    // heartbeat (briefingHeartbeat); the 09:05 UTC one dispatches the daily
    // briefing. event.cron distinguishes them.
    if (event.cron === HEARTBEAT_CRON) {
      ctx.waitUntil(briefingHeartbeat(env))
      return
    }
    // Refresh the KV subscriber mirror from the DO source of truth before the
    // pipeline reads it (#49), so a KV list that has drifted from the DO can't
    // silently drop a still-subscribed user from the daily send. Best-effort:
    // a mirror failure is logged but must never block the dispatch (the send
    // then just uses whatever KV already holds, exactly as it does today).
    ctx.waitUntil((async () => {
      const stub = env.BOT_DO.get(env.BOT_DO.idFromName('singleton'))
      try {
        await stub.remirrorSubscribers()
      } catch (err) {
        console.error('scheduled: subscriber re-mirror failed', err)
      }
      await dispatchEvent(env, 'daily-briefing-trigger', {})
    })())
  },

  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('ok')
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('unauthorized', { status: 401 })

    let update
    try {
      update = await request.json()
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const stub = env.BOT_DO.get(env.BOT_DO.idFromName('singleton'))

    if (typeof update.update_id === 'number') {
      const isNew = await stub.recordSeenUpdate(update.update_id)
      if (!isNew) return new Response('ok') // Telegram redelivery of an update we already processed
    }

    try {
      if (update.callback_query) await handleCallbackQuery(env, stub, update.callback_query)
      else if (update.message) await handleMessage(env, stub, update.message)
    } catch (err) {
      console.error('handler error', err)
    }

    return new Response('ok')
  },
}
