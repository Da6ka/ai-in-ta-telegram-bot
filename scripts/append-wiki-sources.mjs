// Records the edition that just went out into the wiki's raw layer
// (wiki/sources/YYYY-MM.jsonl), so it survives recent_stories.json's 14-day
// prune. Runs in BOTH daily-briefing.yml and on-demand-briefing.yml, gated
// identically to "Record covered stories" -- an on-demand edition reaches a
// real subscriber, so leaving it out would reopen the same hole the backfill
// just closed.
//
// Deterministic and LLM-free: this only appends what was already published.
// Folding records into wiki pages is the ingest's job (wiki-ingest, daily only).
import { readFileSync } from 'node:fs'
import { extractBriefingBullets } from '../shared/telegram.mjs'
import { buildRecords, mergeRecords, monthFileFor, readSourceFile, writeSourceFile } from '../shared/wiki-sources.mjs'

// BRIEFING_DATE_ISO is pinned once per job by the workflow's "Pin today's date"
// step, so this can't disagree with the date stamped on the title even if the
// job straddles UTC midnight (#25).
const today = process.env.BRIEFING_DATE_ISO || new Date().toISOString().slice(0, 10)
const briefing = readFileSync('state/today_briefing.md', 'utf8')
const bullets = extractBriefingBullets(briefing)

const file = monthFileFor(today)
const existing = readSourceFile(file)
const incoming = buildRecords(today, bullets, process.env.WIKI_PROVENANCE || 'workflow')
const merged = mergeRecords(existing, incoming)
const added = merged.length - existing.length

writeSourceFile(file, merged)
console.log(
  `${file}: ${added} new record(s) from ${bullets.length} bullet(s) (${merged.length} total). ` +
    `${bullets.length - added} already archived for ${today}.`
)
