// Sends state/today_briefing.md to every chat id in TELEGRAM_SUBSCRIBER_CHAT_IDS
// (comma-separated) via the Telegram Bot API. Run after the briefing has been
// generated and only if it's fresh for today, so a stale file from a skipped
// run (idempotency short-circuit) never gets re-sent.

import { readFileSync } from 'node:fs'

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

// Minimal Markdown -> Telegram HTML: headers to bold lines, links to <a>, escape the rest.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mdToHtml(source) {
  return source
    .split('\n')
    .map(line => {
      const header = /^#{1,3}\s+(.*)/.exec(line)
      if (header) return `<b>${escapeHtml(header[1])}</b>`
      // [text](url) -> <a href="url">text</a>, escaping the surrounding text
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

// Telegram caps messages at 4096 chars — chunk on blank lines if needed.
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

for (const chatId of chatIds) {
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
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
