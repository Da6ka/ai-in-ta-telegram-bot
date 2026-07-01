// Cloudflare Worker — Telegram webhook receiver for the ai-in-ta bot.
//
// Scope: fixed commands only (start/help/status/subscribe/unsubscribe/briefing/
// newbriefing/admin/listusers/adduser/removeuser/broadcast/pending). Free-form
// chat with Claude is intentionally NOT replicated here — that still needs the
// local server.ts + an interactive Claude Code session. Group chats are not
// supported (the bot has only ever been used in DMs).
//
// State lives in the BOT_STATE KV namespace (mirrors what access.json /
// subscribers.json / usage_stats.json are locally):
//   access          {dmPolicy, allowFrom: string[], ownerChatId, pending: {}}
//   subscribers     {subscribers: string[], owner: string}
//   usage_stats     {briefings_sent, last_briefing_at, briefing_history, command_counts, last_seen}
//   today_briefing_md    raw markdown of the last generated briefing
//   today_briefing_date  UTC YYYY-MM-DD it was generated on

const DEFAULT_ACCESS = { dmPolicy: 'allowlist', allowFrom: [], ownerChatId: '', pending: {} }
const DEFAULT_SUBSCRIBERS = { subscribers: [], owner: '' }
const DEFAULT_USAGE = {
  briefings_sent: 0,
  last_briefing_at: null,
  briefing_history: [],
  command_counts: {},
  last_seen: {},
}

async function getJSON(env, key, fallback) {
  const v = await env.BOT_STATE.get(key, 'json')
  return v ?? fallback
}
async function putJSON(env, key, value) {
  await env.BOT_STATE.put(key, JSON.stringify(value))
}

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function reply(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, ...extra })
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mdToHtml(md) {
  const out = []
  for (const line of md.split('\n')) {
    const hm = /^#{1,6}\s+(.+)$/.exec(line)
    if (hm) {
      out.push(`<b>${escapeHtml(hm[1])}</b>`)
      continue
    }
    const parts = []
    let last = 0
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
    let m
    while ((m = linkRe.exec(line))) {
      parts.push(escapeHtml(line.slice(last, m.index)))
      parts.push(`<a href="${m[2]}">${escapeHtml(m[1])}</a>`)
      last = m.index + m[0].length
    }
    parts.push(escapeHtml(line.slice(last)))
    out.push(parts.join(''))
  }
  return out.join('\n')
}

function chunk(text, limit) {
  const parts = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  parts.push(rest)
  return parts
}

async function sendHtml(env, chatId, html) {
  for (const part of chunk(html, 3500)) {
    await reply(env, chatId, part, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
  }
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
async function dmCommandGate(env, message) {
  if (message.chat?.type !== 'private') return null
  if (!message.from) return null
  const senderId = String(message.from.id)
  const access = await getJSON(env, 'access', DEFAULT_ACCESS)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) {
    // Still let /start through so unapproved users can request access.
    return { access, senderId, isAllowed: false }
  }
  return { access, senderId, isAllowed: access.allowFrom.includes(senderId) }
}

async function dispatchBriefing(env, chatId) {
  await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
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
  })
}

const COMMAND_HANDLERS = {
  async start(env, message, gated) {
    const { access, senderId, isAllowed } = gated
    if (isAllowed) {
      await reply(env, senderId,
        "Welcome to AI in TA News!\n\n" +
        "Tap /briefing to get today's AI recruitment digest, or /subscribe to get it every morning automatically.")
      return
    }
    const from = message.from
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
    const username = from.username ? `@${from.username}` : 'no username'
    if (access.ownerChatId) {
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
      `Welcome to AI in TA News!\n\nThis is a private bot. Your access request has been sent to the owner.\n\n` +
      `Your Telegram ID: <code>${from.id}</code>\n\nYou'll be able to use /briefing and /subscribe once approved.`,
      { parse_mode: 'HTML' })
  },

  async help(env, message, gated) {
    await reply(env, gated.senderId,
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
    const { access, senderId, isAllowed } = gated
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
    const { senderId, isAllowed } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first. Send /start to request access.')
      return
    }
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
    if (subs.subscribers.includes(senderId)) {
      await reply(env, senderId, "You're already subscribed to the daily AI recruitment briefing. You'll receive it every morning at 9:00 AM UTC.")
      return
    }
    subs.subscribers.push(senderId)
    await putJSON(env, 'subscribers', subs)
    await reply(env, senderId, "You're subscribed! You'll receive the daily AI recruitment briefing every morning at 9:00 AM UTC. Send /unsubscribe any time to stop.")
  },

  async unsubscribe(env, message, gated) {
    const { senderId } = gated
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
    if (subs.owner && senderId === subs.owner) {
      await reply(env, senderId, "You're the bot owner — you can't unsubscribe from your own briefing.")
      return
    }
    if (!subs.subscribers.includes(senderId)) {
      await reply(env, senderId, "You're not currently subscribed.")
      return
    }
    subs.subscribers = subs.subscribers.filter(id => id !== senderId)
    await putJSON(env, 'subscribers', subs)
    await reply(env, senderId, "You've been unsubscribed. Send /subscribe any time to start receiving the briefing again.")
  },

  async briefing(env, message, gated) {
    const { senderId, isAllowed } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first — send /start to request access.')
      return
    }
    const date = await getJSON(env, 'today_briefing_date', null)
    if (date === todayUTC()) {
      const md = await env.BOT_STATE.get('today_briefing_md')
      if (md) {
        await sendHtml(env, senderId, mdToHtml(md))
        return
      }
    }
    await reply(env, senderId, "Generating today's briefing, one moment...")
    await dispatchBriefing(env, senderId)
  },

  async newbriefing(env, message, gated) {
    const { senderId, isAllowed } = gated
    if (!isAllowed) {
      await reply(env, senderId, 'You need to be approved first — send /start to request access.')
      return
    }
    await reply(env, senderId, 'Generating a fresh briefing, this will take a minute...')
    await dispatchBriefing(env, senderId)
  },

  async admin(env, message, gated) {
    const { access, senderId } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
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
    const { access, senderId } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
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
    const { access, senderId } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const id = args[0]
    if (!id) {
      await reply(env, senderId, 'Usage: /adduser <chat_id>')
      return
    }
    if (access.allowFrom.includes(id)) {
      await reply(env, senderId, `User \`${id}\` is already on the allowlist.`)
      return
    }
    access.allowFrom.push(id)
    await putJSON(env, 'access', access)
    await reply(env, senderId, `User \`${id}\` added to the allowlist. They can now use the bot. They'll need to /subscribe for daily briefings.`)
  },

  async removeuser(env, message, gated, args) {
    const { access, senderId } = gated
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
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
    if (!access.allowFrom.includes(id) && !subs.subscribers.includes(id)) {
      await reply(env, senderId, `User \`${id}\` not found.`)
      return
    }
    access.allowFrom = access.allowFrom.filter(x => x !== id)
    subs.subscribers = subs.subscribers.filter(x => x !== id)
    await putJSON(env, 'access', access)
    await putJSON(env, 'subscribers', subs)
    await reply(env, senderId, `User \`${id}\` removed from the allowlist and unsubscribed.`)
  },

  async broadcast(env, message, gated, args, rawText) {
    const { access, senderId } = gated
    if (senderId !== access.ownerChatId) {
      await reply(env, senderId, 'This command is only available to the bot owner.')
      return
    }
    const msg = rawText.replace(/^\/broadcast(@\S+)?\s*/, '')
    if (!msg) {
      await reply(env, senderId, 'Usage: /broadcast <message>')
      return
    }
    const subs = await getJSON(env, 'subscribers', DEFAULT_SUBSCRIBERS)
    await reply(env, senderId, `Broadcasting to ${subs.subscribers.length} subscribers...`)
    for (const chatId of subs.subscribers) {
      await reply(env, chatId, msg)
    }
    await reply(env, senderId, `Done. Message sent to ${subs.subscribers.length} subscribers.`)
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
    const lines = entries.map(([, p]) => `${p.chatId ?? p.senderId} — requested ${p.createdAt ? new Date(p.createdAt).toISOString() : ''}`)
    await reply(env, senderId, `Pending pairings (${entries.length})\n\n${lines.join('\n')}\n\nUse /adduser <id> to approve or ignore to deny.`)
  },
}

async function handleCallbackQuery(env, callbackQuery) {
  const data = callbackQuery.data ?? ''
  const am = /^acc:([YN]):(\d+)$/.exec(data)
  if (!am) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id })
    return
  }
  const access = await getJSON(env, 'access', DEFAULT_ACCESS)
  const senderId = String(callbackQuery.from.id)
  if (!access.ownerChatId || senderId !== access.ownerChatId) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Not authorized.' })
    return
  }
  const [, decision, targetId] = am
  const msg = callbackQuery.message
  if (decision === 'Y') {
    if (!access.allowFrom.includes(targetId)) {
      access.allowFrom.push(targetId)
      await putJSON(env, 'access', access)
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Approved' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nApproved` })
    await reply(env, targetId, 'Paired! Send /briefing or /subscribe to get started.')
  } else {
    await tg(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Denied' })
    if (msg?.text) await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: `${msg.text}\n\nDenied` })
  }
}

async function handleMessage(env, message) {
  const text = message.text
  if (!text || !text.startsWith('/')) return // commands-only scope
  const m = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s.exec(text.trim())
  if (!m) return
  const [, cmd, argStr] = m
  const handler = COMMAND_HANDLERS[cmd]
  if (!handler) return

  const gated = await dmCommandGate(env, message)
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

    try {
      if (update.callback_query) await handleCallbackQuery(env, update.callback_query)
      else if (update.message) await handleMessage(env, update.message)
    } catch (err) {
      console.error('handler error', err)
    }

    return new Response('ok')
  },
}
