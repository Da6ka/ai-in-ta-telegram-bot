// The briefing's title date is load-bearing (daily-briefing.yml's freshness
// check greps for it, and send-briefing.mjs's own freshness check does too),
// so don't rely on the LLM to always get "today" right -- force it
// deterministically after generation. Caught live: a real /newbriefing run
// titled itself "1 July 2026" a day after the fact.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'state/today_briefing.md'
const today = new Date().toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

let content = readFileSync(path, 'utf8')
const before = content
content = content.replace(/^(# Daily AI Recruitment Briefing — ).*$/m, `$1${today}`)
writeFileSync(path, content)
console.log(content === before
  ? `Briefing date already correct: ${today}`
  : `Forced briefing date to: ${today}`)
