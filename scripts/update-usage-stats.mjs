// Deterministically updates state/usage_stats.json after a successful daily
// briefing generation. This bookkeeping used to be delegated to the LLM
// itself (read-modify-write the JSON file as an instruction in the prompt),
// which required giving it broad file Write access. Moving it here means the
// agent only needs web search, not arbitrary file writes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const path = 'state/usage_stats.json'
const existing = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { briefings_sent: 0, last_briefing_at: null, briefing_history: [], command_counts: {}, last_seen: {} }

const today = new Date().toISOString().slice(0, 10)
const recipients = (process.env.TELEGRAM_SUBSCRIBER_CHAT_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean).length

existing.briefings_sent = (existing.briefings_sent ?? 0) + 1
existing.last_briefing_at = today
existing.briefing_history = [...(existing.briefing_history ?? []), { date: today, recipients }].slice(-30)

writeFileSync(path, JSON.stringify(existing, null, 2) + '\n')
console.log(`Updated usage_stats.json: briefings_sent=${existing.briefings_sent}, recipients=${recipients}`)
