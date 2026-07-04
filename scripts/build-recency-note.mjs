// Prints a prompt-injectable note listing stories already covered in recent
// editions (see scripts/update-recent-stories.mjs), so the generation step
// in daily-briefing.yml / on-demand-briefing.yml can tell the model not to
// repeat them. Prints nothing if there's no history yet, so callers can
// safely no-op on an empty result.
import { readFileSync, existsSync } from 'node:fs'
import { recentStoryBullets, RECENT_STORIES_WINDOW_DAYS } from '../shared/telegram.mjs'

const path = 'state/recent_stories.json'
// BRIEFING_DATE_ISO is set once per job by the workflow's "Pin today's date"
// step, so the window this call computes stays in sync with the date the
// rest of the job uses (#25). Falls back to computing fresh for
// standalone/manual runs outside the workflow.
const today = process.env.BRIEFING_DATE_ISO || new Date().toISOString().slice(0, 10)
const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { entries: [] }
const bullets = recentStoryBullets(existing.entries, today)

if (bullets.length > 0) {
  console.log(
    `Stories already covered in the past ${RECENT_STORIES_WINDOW_DAYS} days -- do NOT repeat any of these, even under a different source or headline, even if they would still pass the freshness filter above:\n${bullets.join('\n')}`
  )
}
