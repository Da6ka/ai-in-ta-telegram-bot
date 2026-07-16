// Writes the records the ingest hasn't folded into the wiki yet to
// wiki/.pending.json, and reports the count on stdout as a workflow output.
//
// Split out of the ingest step so the expensive `claude -p` call is skipped
// entirely when there's nothing pending -- and so the exact input the model saw
// is a real file, inspectable after the fact, rather than shell interpolation.
//
// wiki/.pending.json is scratch, not state: .gitignore'd, rewritten each run.
import { writeFileSync, appendFileSync } from 'node:fs'
import { readAllSources, readIngestState, pendingRecords, pendingCount, INGEST_BATCH_LIMIT } from '../shared/wiki-sources.mjs'

const limit = Number(process.env.WIKI_INGEST_BATCH || INGEST_BATCH_LIMIT)
const records = readAllSources()
const state = readIngestState()
const pending = pendingRecords(records, state, limit)
const backlog = pendingCount(records, state)
writeFileSync('wiki/.pending.json', JSON.stringify(pending, null, 2) + '\n')

const dates = [...new Set(pending.map((r) => r.date))].sort()
console.log(`${pending.length} record(s) this run across ${dates.length} day(s): ${dates.join(', ') || '(none)'}`)
// Never let a capped batch read as "everything is covered" -- say what's left.
if (backlog > pending.length) {
  const runs = Math.ceil(backlog / limit)
  console.log(`::notice::Backlog is ${backlog} record(s); capped at ${limit} per run, so it drains over ~${runs} run(s).`)
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `count=${pending.length}\n`)
}
