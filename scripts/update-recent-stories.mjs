// Records today's briefing bullets in state/recent_stories.json so the next
// generation's prompt can be told not to repeat them, even though they'd
// still pass the prompt's own freshness filter (briefing-prompt.md /
// briefing-prompt-ondemand.md allow stories up to 7-14 days old). Without
// this, a real story stays "fresh" -- and gets re-reported under a
// different source domain -- for up to two weeks straight. Caught live: the
// Claude Sonnet 5 launch (30 June) ran in both the 2026-07-03 and
// 2026-07-04 editions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { extractBriefingBullets, pruneRecentStories } from '../shared/telegram.mjs'

const path = 'state/recent_stories.json'
const today = new Date().toISOString().slice(0, 10)
const briefing = readFileSync('state/today_briefing.md', 'utf8')
const bullets = extractBriefingBullets(briefing)

const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { entries: [] }
// Merge into today's entry rather than replacing it -- multiple editions can
// land the same day (a daily run plus one or more /newbriefing on-demand
// runs), and each one's stories must stay remembered. Replacing lost earlier
// same-day stories entirely (caught live, 2026-07-04: a run repeated a story
// two runs earlier had already covered, same day). Dedupe by exact bullet
// text since the same run can't produce the same bullet twice.
const todayEntry = (existing.entries ?? []).find((e) => e.date === today)
const mergedBullets = [...new Set([...(todayEntry?.bullets ?? []), ...bullets])]
const withoutToday = (existing.entries ?? []).filter((e) => e.date !== today)
const entries = pruneRecentStories([...withoutToday, { date: today, bullets: mergedBullets }], today)

writeFileSync(path, JSON.stringify({ entries }, null, 2) + '\n')
console.log(`Recorded ${bullets.length} bullet(s) from this run (${mergedBullets.length} total for ${today}); ${entries.length} day(s) retained in recent_stories.json.`)
