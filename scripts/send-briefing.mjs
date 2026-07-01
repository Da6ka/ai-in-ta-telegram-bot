// Sends state/today_briefing.md to every chat id in TELEGRAM_SUBSCRIBER_CHAT_IDS
// (comma-separated) via the Telegram Bot API. Run after the briefing has been
// generated and only if it's fresh for today, so a stale file from a skipped
// run (idempotency short-circuit) never gets re-sent.

import { readFileSync } from 'node:fs'
import { mdToHtml, chunk } from '../shared/telegram-markdown.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatIds = (process.env.TELEGRAM_SUBSCRIBER_CHAT_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (chatIds.length === 0) throw new Error('TELEGRAM_SUBSCRIBER_CHAT_IDS is empty')

const md = readFileSync('state/today_briefing.md', 'utf8')

const today = new Date().toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}).replace(/^(\d+) /, '$1 ')

if (!md.includes(today)) {
  console.log(`state/today_briefing.md does not contain today's date (${today}) — skipping send (nothing fresh was generated).`)
  process.exit(0)
}

const html = mdToHtml(md)

// Telegram caps messages at 4096 chars — chunk if needed.
const chunks = chunk(html, 4000)

for (const chatId of chatIds) {
  for (const part of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    })
    if (!res.ok) {
      console.error(`Failed to send to ${chatId}: ${res.status} ${await res.text()}`)
    }
  }
}

console.log(`Sent briefing to ${chatIds.length} subscriber(s).`)
