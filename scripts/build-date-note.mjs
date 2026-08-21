// Prints the date note injected after the generation prompt in
// daily-briefing.yml and on-demand-briefing.yml. It carries two things the
// prompt file itself cannot know: today's date (so the title is right and the
// model can judge what "recent" means) and how far back the freshness window
// reaches.
//
// The window is derived, not fixed: since the schedule went Mon-Fri
// (2026-08-21) a Monday run has to cover Friday-through-Sunday, and a run after
// any other gap (outage, paused schedule) has the same problem. See
// recencyWindowHours in shared/telegram.mjs.
//
// Both workflows used to inline this string with a hardcoded "past 24-48
// hours", in two copies that had to be kept in step by hand.
import { readFileSync, existsSync } from 'node:fs'
import { recencyWindowHours } from '../shared/telegram.mjs'

// BRIEFING_DATE_ISO/HUMAN are pinned once per job by the workflow's "Pin
// today's date" step, so this agrees with every other step even if the run
// straddles UTC midnight (#25). Falls back to computing fresh for standalone
// or manual runs outside the workflow.
const todayISO = process.env.BRIEFING_DATE_ISO || new Date().toISOString().slice(0, 10)
const human =
  process.env.BRIEFING_DATE_HUMAN ||
  new Date(`${todayISO}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

const statsPath = 'state/usage_stats.json'
let lastBriefingISO = ''
if (existsSync(statsPath)) {
  try {
    lastBriefingISO = JSON.parse(readFileSync(statsPath, 'utf8')).last_briefing_at || ''
  } catch {
    // A corrupt stats file must not take the day's briefing down with it --
    // the window just falls back to its floor.
    lastBriefingISO = ''
  }
}

const hours = recencyWindowHours(todayISO, lastBriefingISO)

console.log(
  `Today's date (UTC) is ${human}. Use this exact date in the title, and use it to judge which search results are genuinely from the past ${hours} hours.`,
)
