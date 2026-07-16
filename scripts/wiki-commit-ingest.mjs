// Marks the pending records as ingested, after the model has updated the wiki.
//
// Runs as a SEPARATE step, only when the ingest step actually succeeded: if it
// ran first, a failed/half-finished ingest would still mark the records done
// and they'd never be retried. Ids (not a date watermark) mean the next run
// picks up whatever this one missed -- see shared/wiki-sources.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import { sourceRecordId, readIngestState, INGEST_STATE } from '../shared/wiki-sources.mjs'

const pending = JSON.parse(readFileSync('wiki/.pending.json', 'utf8'))
const state = readIngestState()
const ingested = [...new Set([...state.ingested, ...pending.map(sourceRecordId)])]

writeFileSync(INGEST_STATE, JSON.stringify({ ingested }, null, 2) + '\n')
console.log(`Marked ${pending.length} record(s) ingested (${ingested.length} total).`)
