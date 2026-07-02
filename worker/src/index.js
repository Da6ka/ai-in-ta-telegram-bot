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
import { mdToHtml, chunk } from '../../shared/telegram-markdown.mjs'

// Each briefing generation is a paid GitHub Actions + Claude API run, and the
// result is shared (one today_briefing for everyone) — so the cooldown is
// global, with a per-user daily cap as a backstop against one user hammering
// /newbriefing every hour all day.
const DISPATCH_COOLDOWN_MS = 60 * 60 * 1000
const DAILY_DISPATCH_CAP = 3

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

  async addAllowedUser(id) {
    const access = await this.getAccess()
    const added = !access.allowFrom.includes(id)
    if (added) {
      access.allowFrom.push(id)
      await this.ctx.storage.put('access', access)
    }
    return { access, added }
  }

  async removeAllowedUser(id) {
    const access = await this.getAccess()
    const removed = access.allowFrom.includes(id)
    access.allowFrom = access.allowFrom.filter(x => x !== id)
    await this.ctx.storage.put('access', access)
    const subs = await this.getSubscribers()
    subs.subscribers = subs.subscribers.filter(x => x !== id)
    await this.ctx.storage.put('subscribers', subs)
    await this.mirrorSubscribers(subs)
    return { access, subs, removed }
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
      return { allowed: false, reason: 'cooldown', retryInMin: Math.ceil((DISPATCH_COOLDOWN_MS - elapsed) / 60000) }
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
  const v = await env.BOT_STATE.get(key, 'json')
  return v ?? fallback
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
        const retryAfter = Number(res.headers.get('retry-after')) || attempt + 1
        await new Promise(r => setTimeout(r, retryAfter * 300))
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
  stats.command_counts[name] = (stats.command_counts[name] ?? 0) + 1
  await putJSON(env, 'usage_stats', stats)
}

async function touchLastSeen(env, senderId) {
  const stats = await getJSON(env, 'usage_stats', DEFAULT_USAGE)
  stats.last_seen[senderId] = todayUTC()
  await putJSON(env, 'usage_stats', stats)
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

async function dispatchBriefing(env, chatId) {
  try {
    const res = await fetchWithRetry(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ai-in-ta-telegram-bot-worker',
      },
      body: JSON.stringify({
        event_type: 'newbriefing',
        client_payload: { chat_id: String(chatId) },
      }),
    }, { retries: 1 })
    if (!res.ok) {
      console.error('GitHub dispatch failed', res.status, await res.text())
      return false
    }
    return true
  } catch (err) {
    console.error('GitHub dispatch request failed', err)
    return false
  }
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
    await reply(env, senderId, 'A briefing is being generated right now — send /briefing in a couple of minutes to get it.')
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
        "Tap /briefing to get today's AI recruitment digest, or /subscribe to get it every morning automatically.")
      return
    }
    const from = message.from
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
      "/briefing — get today's briefing\n" +
      "/subscribe — get the daily briefing every morning\n" +
      "/unsubscribe — stop the daily briefing\n" +
      "/status — check your access status")
  },

  async status(env, message, gated) {
    const { senderId, isAllowed } = gated
    if (isAllowed) {
      const name = message.from.username ? `@${message.from.username}` : senderId
      await reply(env, senderId, `Paired as ${name}`)
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
      : "You're subscribed! You'll receive the daily AI recruitment briefing every morning at 9:00 AM UTC. Send /unsubscribe any time to stop.")
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
    const { added } = await stub.addAllowedUser(id)
    if (!added) {
      await reply(env, senderId, `User \`${id}\` is already on the allowlist.`)
      return
    }
    await reply(env, senderId, `User \`${id}\` added to the allowlist. They can now use the bot. They'll need to /subscribe for daily briefings.`)
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
    const { removed } = await stub.removeAllowedUser(id)
    if (!removed) {
      await reply(env, senderId, `User \`${id}\` not found.`)
      return
    }
    await reply(env, senderId, `User \`${id}\` removed from the allowlist and unsubscribed.`)
  },

  async broadcast(env, message, gated, args, rawText) {
    const { access, senderId, stub } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const msg = rawText.replace(/^\/broadcast(@\S+)?\s*/, '')
    if (!msg) {
      await reply(env, senderId, 'Usage: /broadcast <message>')
      return
    }
    const subs = await stub.getSubscribers()
    await reply(env, senderId, `Broadcasting to ${subs.subscribers.length} subscribers...`)
    const parts = chunk(msg, 4000)
    let failedRecipients = 0
    for (const chatId of subs.subscribers) {
      let recipientOk = true
      for (const part of parts) {
        const res = await reply(env, chatId, part)
        if (!res.ok) recipientOk = false
      }
      if (!recipientOk) failedRecipients++
    }
    await reply(env, senderId, failedRecipients === 0
      ? `Done. Message sent to ${subs.subscribers.length} subscribers.`
      : `Done, but delivery failed for ${failedRecipients} of ${subs.subscribers.length} subscriber(s) — check Worker logs for details.`)
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
    await stub.addAllowedUser(targetId)
    await stub.removePending(targetId)
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Approved' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nApproved` })
    await reply(env, targetId, 'Paired! Send /briefing or /subscribe to get started.')
  } else {
    await stub.removePending(targetId)
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Denied' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nDenied` })
  }
}

async function handleMessage(env, stub, message) {
  const text = message.text
  if (!text || !text.startsWith('/')) return // commands-only scope
  const m = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return
  const [, cmd, argStr] = m
  const handler = COMMAND_HANDLERS[cmd]
  if (!handler) return

  const gated = await dmCommandGate(stub, message)
  if (!gated) return

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
