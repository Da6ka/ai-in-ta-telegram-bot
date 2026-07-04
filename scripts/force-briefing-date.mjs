// The briefing's title date is load-bearing (daily-briefing.yml's freshness
// check greps for it, and send-briefing.mjs's own freshness check does too),
// so don't rely on the LLM to always get "today" right -- force it
// deterministically after generation. Caught live: a real /newbriefing run
// titled itself "1 July 2026" a day after the fact.
//
// Uses BRIEFING_DATE_HUMAN (set once per job by the workflow's "Pin today's
// date" step) rather than computing its own `new Date()`, so this can't drift
// from the date the rest of the job's steps use -- a real generation run can
// take 10+ minutes, and a step recomputing "today" independently near UTC
// midnight could stamp a different day than e.g. update-recent-stories.mjs's
// own recording of the same edition (#25). Falls back to computing fresh for
// standalone/manual runs outside the workflow.
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'state/today_briefing.md'
const today = process.env.BRIEFING_DATE_HUMAN || new Date().toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

let content = readFileSync(path, 'utf8')
const before = content
content = content.replace(/^(# Daily AI Recruitment Briefing — ).*$/m, `$1${today}`)
writeFileSync(path, content)
console.log(content === before
  ? `Briefing date already correct: ${today}`
  : `Forced briefing date to: ${today}`)
