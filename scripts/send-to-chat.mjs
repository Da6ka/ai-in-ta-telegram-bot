// Sends state/today_briefing.md to a single chat id (the requester of an
// on-demand /newbriefing or /briefing), as opposed to send-briefing.mjs which
// broadcasts to every subscriber for the daily cron.
import { readFileSync } from 'node:fs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!chatId) throw new Error('CHAT_ID is not set')

const md = readFileSync('state/today_briefing.md', 'utf8')

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mdToHtml(source) {
  return source
    .split('\n')
    .map(line => {
      const header = /^#{1,3}\s+(.*)/.exec(line)
      if (header) return `<b>${escapeHtml(header[1])}</b>`
      const parts = []
      let last = 0
      const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
      let m
      while ((m = linkRe.exec(line))) {
        parts.push(escapeHtml(line.slice(last, m.index)))
        parts.push(`<a href="${m[2]}">${escapeHtml(m[1])}</a>`)
        last = m.index + m[0].length
      }
      parts.push(escapeHtml(line.slice(last)))
      return parts.join('')
    })
    .join('\n')
}

const html = mdToHtml(md)

const LIMIT = 4000
const chunks = []
let rest = html
while (rest.length > LIMIT) {
  let cut = rest.lastIndexOf('\n\n', LIMIT)
  if (cut <= 0) cut = LIMIT
  chunks.push(rest.slice(0, cut))
  rest = rest.slice(cut)
}
chunks.push(rest)

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
