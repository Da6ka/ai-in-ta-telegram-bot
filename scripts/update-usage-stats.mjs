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

// BRIEFING_DATE_ISO is set once per job by the workflow's "Pin today's date"
// step, so last_briefing_at can't disagree with the title date or
// recent_stories.json's key for the same edition (#25). Falls back to
// computing fresh for standalone/manual runs outside the workflow.
const today = process.env.BRIEFING_DATE_ISO || new Date().toISOString().slice(0, 10)
// Set by the send step (scripts/send-briefing.mjs writes it to GITHUB_OUTPUT
// after fetching the live subscriber list from KV).
const recipients = Number(process.env.RECIPIENT_COUNT ?? 0)

existing.briefings_sent = (existing.briefings_sent ?? 0) + 1
existing.last_briefing_at = today
existing.briefing_history = [...(existing.briefing_history ?? []), { date: today, recipients }].slice(-30)

writeFileSync(path, JSON.stringify(existing, null, 2) + '\n')
console.log(`Updated usage_stats.json: briefings_sent=${existing.briefings_sent}, recipients=${recipients}`)
