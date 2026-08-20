// Sends the /ask answer (state/ask-answer.md) to the single requester. Mirrors
// scripts/send-to-chat.mjs, which does the same for an on-demand briefing:
// sendHtml chunks past Telegram's 4096-char limit and retries 429/5xx honoring
// Retry-After, so a long answer needs no special handling here.
import { readFileSync } from 'node:fs'
import { mdToHtml } from '../shared/telegram-markdown.mjs'
import { sendHtml } from '../shared/telegram.mjs'

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.CHAT_ID

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set')
if (!chatId) throw new Error('CHAT_ID is not set')

const md = readFileSync('state/ask-answer.md', 'utf8')

const ok = await sendHtml(token, chatId, mdToHtml(md), {
  onError: async (cid, res) => console.error(`Failed to send to ${cid}: ${res.status} ${await res.text()}`),
})

console.log(ok ? `Sent answer to ${chatId}.` : `Delivery to ${chatId} had failures (see above).`)
