// Sends state/today_briefing.md to a single chat id (the requester of an
// on-demand /newbriefing or /briefing), as opposed to send-briefing.mjs which
// broadcasts to every subscriber for the daily cron.
import { readFileSync } from 'node:fs'
import { mdToHtml, chunk } from '../shared/telegram-markdown.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!chatId) throw new Error('CHAT_ID is not set')

const md = readFileSync('state/today_briefing.md', 'utf8')

const html = mdToHtml(md)
const chunks = chunk(html, 4000)

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

console.log(`Sent briefing to ${chatId}.`)
