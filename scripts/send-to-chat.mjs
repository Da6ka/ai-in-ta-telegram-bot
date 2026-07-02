// Sends state/today_briefing.md to a single chat id (the requester of an
// on-demand /newbriefing or /briefing), as opposed to send-briefing.mjs which
// broadcasts to every subscriber for the daily cron.
import { readFileSync } from 'node:fs'
import { mdToHtml } from '../shared/telegram-markdown.mjs'
import { sendHtml } from '../shared/telegram.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!chatId) throw new Error('CHAT_ID is not set')

const md = readFileSync('state/today_briefing.md', 'utf8')

// sendHtml chunks the message and retries 429/5xx (honoring Retry-After).
const ok = await sendHtml(token, chatId, mdToHtml(md), {
  onError: async (cid, res) => console.error(`Failed to send to ${cid}: ${res.status} ${await res.text()}`),
})

console.log(ok ? `Sent briefing to ${chatId}.` : `Delivery to ${chatId} had failures (see above).`)
