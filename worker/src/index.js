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
//     so fully fixing its concurrency would mean giving that pipeline a way
//     to call into the Durable Object too. Command_counts/last_seen can still
//     race against each other Worker-side, but the impact is cosmetic
//     (slightly-off admin stats), unlike losing a real subscription or
//     allowlist entry — left as a known, accepted limitation.
//   - `today_briefing_md` / `today_briefing_date` stay in KV: only the CI
//     pipeline ever writes them, so there's no concurrent-writer race.

import { DurableObject } from 'cloudflare:workers'
import { mdToHtml, chunk, escapeHtml } from '../../shared/telegram-markdown.mjs'

// Each briefing generation is a paid GitHub Actions + Claude API run, and the
// result is shared (one today_briefing for everyone) — so the cooldown is
// global, with a per-user daily cap as a backstop against one user hammering
// /newbriefing every hour all day.
const DISPATCH_COOLDOWN_MS = 60 * 60 * 1000
const DAILY_DISPATCH_CAP = 3

// A generation run (install + claude -p web search + send + KV sync) finishes
// well within this window. Used only for message wording: if the last dispatch
// was within it, a run is plausibly still in flight ("being generated"); if it
// was longer ago and there's still no fresh cache (e.g. a cooldown carried
// across the UTC-midnight boundary from the prior evening's run, before the
// 09:00 daily), nothing is generating — say so instead of claiming it is.
const GENERATION_IN_FLIGHT_MIN = 10

// Capacity cap for the current private, single-operator deployment. The daily
// send stays comfortably under Telegram's rate limit at this size, and (on the
// Workers free plan) /broadcast is subrequest-capped around here too. The
// (MAX_USERS+1)th person to request access is told the bot is full rather than
// queued. Raise this once broadcast delivery moves to the Actions runner.
const MAX_USERS = 30

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

const DEFAULT_ACCESS = { dmPolicy: 'allowlist', allowFrom: [], ownerChatId: '', pending: {} }
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
  }

  async getAccess() {
    let access = await this.ctx.storage.get('access')
    if (access === undefined) {
      // First touch: migrate whatever's already in KV (real production data)
      // into the Durable Object so cutover doesn't lose the existing allowlist.
      access = (await this.env.BOT_STATE.get('access', 'json')) ?? DEFAULT_ACCESS
      await this.ctx.storage.put('access', access)
    }
    return access
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

  // Full erasure of one user's identifying state (right to be forgotten):
  // allowlist entry, subscription, and any pending request. The per-user
  // last_seen log lives in KV, so the Worker purges that separately.
  async forgetUser(id) {
    const access = await this.getAccess()
    const wasAllowed = access.allowFrom.includes(id)
    const wasPending = Boolean(access.pending[id])
    access.allowFrom = access.allowFrom.filter(x => x !== id)
    delete access.pending[id]
    await this.ctx.storage.put('access', access)
    const subs = await this.getSubscribers()
    const wasSubscribed = subs.subscribers.includes(id)
    subs.subscribers = subs.subscribers.filter(x => x !== id)
    await this.ctx.storage.put('subscribers', subs)
    await this.mirrorSubscribers(subs)
    return { wasAllowed, wasPending, wasSubscribed }
  }

  async addPending(id, info) {
    const access = await this.getAccess()
    const alreadyPending = Boolean(access.pending[id])
    if (!alreadyPending) {
      access.pending[id] = info
      await this.ctx.storage.put('access', access)
    }
    return { access, alreadyPending }
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
    if (wasSubscribed) {
      subs.subscribers = subs.subscribers.filter(x => x !== id)
      await this.ctx.storage.put('subscribers', subs)
    }
    await this.mirrorSubscribers(subs)
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

  // Rate limiting for briefing generation. Check + record happen in one
  // method so two concurrent requests can't both pass the check and
  // double-dispatch.
  async reserveBriefingDispatch(senderId) {
    const now = Date.now()
    const today = new Date(now).toISOString().slice(0, 10)
    const rl = (await this.ctx.storage.get('briefing_rate')) ?? { lastDispatchAt: 0, date: today, counts: {} }
    if (rl.date !== today) {
      rl.date = today
      rl.counts = {}
    }
    if ((rl.counts[senderId] ?? 0) >= DAILY_DISPATCH_CAP) {
      return { allowed: false, reason: 'daily_cap' }
    }
    const elapsed = now - rl.lastDispatchAt
    if (elapsed < DISPATCH_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: 'cooldown',
        retryInMin: Math.ceil((DISPATCH_COOLDOWN_MS - elapsed) / 60000),
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

async function bumpCommandCount(env, name) {
  const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
  const prev = Object.hasOwn(stats.command_counts, name) ? stats.command_counts[name] : 0
  stats.command_counts[name] = prev + 1
  await putJSON(env, 'usage_stats', stats)
}

async function touchLastSeen(env, senderId) {
  const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
  stats.last_seen[senderId] = todayUTC()
  // Retention sweep: drop activity entries older than RETENTION_DAYS. Runs on
  // every command, so inactive users' stale entries get cleaned up over time
  // even though they never trigger this themselves. YYYY-MM-DD compares
  // lexicographically, so a string < is a valid date comparison here.
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10)
  for (const [id, date] of Object.entries(stats.last_seen)) {
    if (typeof date === 'string' && date < cutoff) delete stats.last_seen[id]
  }
  await putJSON(env, 'usage_stats', stats)
}

// Remove one user's per-user entry from the usage_stats activity log (KV).
// command_counts is aggregate-by-command, not per-user, so there's nothing
// personal to purge there.
async function purgeUsageStats(env, id) {
  const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
  if (stats.last_seen && id in stats.last_seen) {
    delete stats.last_seen[id]
    await putJSON(env, 'usage_stats', stats)
    return true
  }
  return false
}

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

// Shared by /newbriefing and /briefing's stale-cache path: rate-limit check,
// then dispatch generation, rolling back the reservation if dispatch fails.
// During the cooldown the user still gets something — the cached briefing if
// today's exists, otherwise a "being generated" note (a run is likely in
// flight, since the cooldown started less than an hour ago).
async function requestGeneration(env, stub, senderId, generatingMsg) {
  const r = await stub.reserveBriefingDispatch(senderId)
  if (!r.allowed) {
    if (r.reason === 'daily_cap') {
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
    // run is plausibly still generating; if it was a while ago (e.g. a cooldown
    // carried over from last night, before today's daily), nothing is running —
    // don't claim it is.
    await reply(env, senderId, r.sinceLastMin <= GENERATION_IN_FLIGHT_MIN
      ? 'A briefing is being generated right now — send /briefing in a couple of minutes to get it.'
      : `Couldn't refresh the briefing just now — a fresh one can be generated in ~${r.retryInMin} min. You'll also get today's automatically with the daily update.`)
    return
  }
  await reply(env, senderId, generatingMsg)
  const dispatched = await dispatchBriefing(env, senderId)
  if (!dispatched) {
    await stub.rollbackBriefingDispatch(senderId, r.prevLastDispatchAt)
    await reply(env, senderId, "Couldn't start briefing generation right now — please try again shortly, or contact the bot owner if this keeps happening.")
  }
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
    const { alreadyPending } = await stub.addPending(senderId, { displayName, username, createdAt: Date.now() })
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
    const purged = await purgeUsageStats(env, senderId)
    const hadData = r.wasAllowed || r.wasSubscribed || r.wasPending || purged
    await reply(env, senderId, hadData
      ? "Done — everything the bot stored about you has been erased: allowlist access, subscription, any pending request, and your activity log. Send /start if you ever want to come back."
      : "There's nothing on file to erase. Send /start if you'd like to request access.")
  },

  async briefing(env, message, gated) {
    const { senderId, isAllowed, stub } = gated
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
    await requestGeneration(env, stub, senderId, "Generating today's briefing, one moment...")
  },

  async newbriefing(env, message, gated) {
    const { senderId, isAllowed, stub } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first — send /start to request access.')
      return
    }
    await requestGeneration(env, stub, senderId, 'Generating a fresh briefing, this will take a minute...')
  },

  async admin(env, message, gated) {
    const { access, senderId, stub } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const subs = await stub.getSubscribers()
    const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
    const c = stats.command_counts
    await reply(env, senderId,
      `Bot Admin Panel\n\n` +
      `Users\n` +
      `- Allowlisted: ${access.allowFrom.length}\n` +
      `- Subscribed: ${subs.subscribers.length}\n` +
      `- Pending pairings: ${Object.keys(access.pending).length}\n\n` +
      `Briefings\n` +
      `- Total sent: ${stats.briefings_sent}\n` +
      `- Last sent: ${stats.last_briefing_at ?? 'never'}\n\n` +
      `Command usage\n` +
      `- /briefing: ${c.briefing ?? 0}\n` +
      `- /newbriefing: ${c.newbriefing ?? 0}\n` +
      `- /subscribe: ${c.subscribe ?? 0}\n` +
      `- /unsubscribe: ${c.unsubscribe ?? 0}\n` +
      `- /broadcast: ${c.broadcast ?? 0}\n` +
      `- /adduser: ${c.adduser ?? 0}\n` +
      `- /removeuser: ${c.removeuser ?? 0}\n` +
      `- /listusers: ${c.listusers ?? 0}\n` +
      `- /pending: ${c.pending ?? 0}\n\n` +
      `Use /listusers, /pending, /adduser <id>, /removeuser <id>, /broadcast <msg>`)
  },

  async listusers(env, message, gated) {
    const { access, senderId, stub } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const subs = await stub.getSubscribers()
    const lines = access.allowFrom.map(id => {
      const tags = []
      if (id === access.ownerChatId) tags.push('[owner]')
      if (subs.subscribers.includes(id)) tags.push('[subscribed]')
      if (tags.length === 0) tags.push('[allowed]')
      return `${id} — ${tags.join('')}`
    })
    await reply(env, senderId,
      `Users (${access.allowFrom.length})\n\n${lines.join('\n')}\n\n/adduser <id> to add · /removeuser <id> to remove`)
  },

  async adduser(env, message, gated, args) {
    const { access, senderId, stub } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /adduser <chat_id>')
      return
    }
    if (!/^-?\d+$/.test(id)) {
      await reply(env, senderId, `"${id}" doesn't look like a Telegram chat id (should be numeric). Usage: /adduser <chat_id>`)
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
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /removeuser <chat_id>')
      return
    }
    if (id === access.ownerChatId) {
      await reply(env, senderId, "You can't remove the bot owner.")
      return
    }
    const r = await stub.forgetUser(id)
    const purged = await purgeUsageStats(env, id)
    if (!r.wasAllowed && !r.wasSubscribed && !r.wasPending && !purged) {
      await reply(env, senderId, `User <code>${escapeHtml(id)}</code> not found.`, { parse_mode: 'HTML' })
      return
    }
    await reply(env, senderId, `User <code>${escapeHtml(id)}</code> removed and all their data erased (allowlist, subscription, pending request, activity log).`, { parse_mode: 'HTML' })
  },

  async broadcast(env, message, gated, args, rawText) {
    const { access, senderId, stub } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
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
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
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
  if (!access.ownerChatId || senderId !== access.ownerChatId) {
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

  const argStr = m[2]
  await touchLastSeen(env, gated.senderId)
  await bumpCommandCount(env, cmd)

  const args = (argStr ?? '').split(/\s+/).filter(Boolean)
  await handler(env, message, gated, args, text)
}

export default {
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
