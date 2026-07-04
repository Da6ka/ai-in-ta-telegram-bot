// Prints a prompt-injectable note listing stories already covered in recent
// editions (see scripts/update-recent-stories.mjs), so the generation step
// in daily-briefing.yml / on-demand-briefing.yml can tell the model not to
// repeat them. Prints nothing if there's no history yet, so callers can
// safely no-op on an empty result.
import { readFileSync, existsSync } from 'node:fs'
import { recentStoryBullets, RECENT_STORIES_WINDOW_DAYS } from '../shared/telegram.mjs'

const path = 'state/recent_stories.json'
const today = new Date().toISOString().slice(0, 10)
const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { entries: [] }
const bullets = recentStoryBullets(existing.entries, today)

if (bullets.length > 0) {
  console.log(
    `Stories already covered in the past ${RECENT_STORIES_WINDOW_DAYS} days -- do NOT repeat any of these, even under a different source or headline, even if they would still pass the freshness filter above:\n${bullets.join('\n')}`
  )
}
