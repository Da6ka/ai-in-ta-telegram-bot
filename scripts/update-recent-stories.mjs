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
// Drop any existing entry for today first so a same-day re-run (e.g. a
// daily run followed by an on-demand one) replaces rather than duplicates it.
const withoutToday = (existing.entries ?? []).filter((e) => e.date !== today)
const entries = pruneRecentStories([...withoutToday, { date: today, bullets }], today)

writeFileSync(path, JSON.stringify({ entries }, null, 2) + '\n')
console.log(`Recorded ${bullets.length} bullet(s) for ${today}; ${entries.length} day(s) retained in recent_stories.json.`)
