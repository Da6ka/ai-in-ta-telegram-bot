// The wiki's raw-source layer: wiki/sources/YYYY-MM.jsonl.
//
// This is NOT state/recent_stories.json. That file is the dedup feed injected
// into the generation prompt, so it's pruned at 14 days and capped at 20
// bullets -- both load-bearing for --max-budget-usd. This layer is append-only,
// never pruned, and never injected into any prompt. See docs/wiki-design.md.
//
// Shared by scripts/backfill-wiki-sources.mjs (mines git history),
// scripts/append-wiki-sources.mjs (records each sent edition), and
// scripts/wiki-pending.mjs (feeds the ingest).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { bulletUrlKey } from './telegram.mjs'

export const SOURCES_DIR = 'wiki/sources'
export const INGEST_STATE = 'wiki/ingest-state.json'

// Bullet shape (briefing-prompt.md): "- **Headline**, prose ... ([Link
// title](https://url)) (16 July 2026)". Every field is best-effort: a bullet
// that drifts from the format still gets archived, just with nulls. Losing the
// record entirely is worse than losing its headline -- and ~1/3 of the
// backfilled corpus genuinely has no bold span (an earlier editorial style),
// so nulls here are normal, not a parse failure.
export function parseBullet(bullet) {
  const headline = String(bullet ?? '').match(/\*\*(.+?)\*\*/)?.[1] ?? null
  const link = String(bullet ?? '').match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/)
  const url = link?.[2] ?? null
  let domain = null
  if (url) {
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      domain = null
    }
  }
  return { headline, source_title: link?.[1] ?? null, url, domain }
}

// Identity of a source record: the (date, story) pair. Uses bulletUrlKey (host
// + path, query/hash dropped) rather than the bullet text, because a re-run can
// restate the same story with different wording -- the same reason
// update-recent-stories.mjs dedupes by URL. Falls back to the raw text for a
// bullet with no parseable URL.
export function sourceRecordId(record) {
  const key = bulletUrlKey(record?.bullet) ?? record?.bullet ?? ''
  return `${record?.date ?? ''}|${key}`
}

export function monthFileFor(dateISO) {
  return `${SOURCES_DIR}/${String(dateISO).slice(0, 7)}.jsonl`
}

export function buildRecords(dateISO, bullets, provenance) {
  return (bullets ?? []).map((bullet) => {
    const { headline, source_title, url, domain } = parseBullet(bullet)
    return { date: dateISO, headline, url, domain, source_title, bullet, recovered_from: provenance }
  })
}

// Keep-first on id, matching dedupeBullets' semantics: the earliest wording of
// a given (date, story) wins over a later same-day restate.
export function mergeRecords(existing, incoming) {
  const out = []
  const seen = new Set()
  for (const r of [...(existing ?? []), ...(incoming ?? [])]) {
    const id = sourceRecordId(r)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out
}

export function readSourceFile(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

export function writeSourceFile(file, records) {
  mkdirSync(SOURCES_DIR, { recursive: true })
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

export function readAllSources() {
  if (!existsSync(SOURCES_DIR)) return []
  return readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readSourceFile(`${SOURCES_DIR}/${f}`))
}

export function readIngestState() {
  if (!existsSync(INGEST_STATE)) return { ingested: [] }
  try {
    const parsed = JSON.parse(readFileSync(INGEST_STATE, 'utf8'))
    return { ingested: parsed.ingested ?? [] }
  } catch {
    return { ingested: [] }
  }
}

// How many records one ingest run will fold in. A backlog bigger than this
// drains over several runs instead of failing forever: without a cap, a
// backlog large enough to blow --max-budget-usd would fail the step, leave
// every record pending, and hand the NEXT run the same too-big batch plus a
// day's new stories -- a permanently wedged ingest. The 2026-07-08..10 outage
// (three days, ~20 stories) is the shape this has to survive; the cold-start
// backfill (91 records) is the extreme case.
export const INGEST_BATCH_LIMIT = 25

// Records the ingest hasn't folded into the wiki yet, oldest first, capped at
// `limit`.
//
// Tracked by explicit id, not a high-water-mark date: on-demand editions can
// append records for a date the daily ingest has already processed (up to 3
// /newbriefing runs a day), and a date-based watermark would silently skip
// them. Id-based also means a multi-day outage self-heals -- the next ingest
// picks up every missed day rather than only "today".
export function pendingRecords(records, state, limit = INGEST_BATCH_LIMIT) {
  const done = new Set(state?.ingested ?? [])
  const pending = (records ?? []).filter((r) => !done.has(sourceRecordId(r)))
  return limit > 0 ? pending.slice(0, limit) : pending
}

// Total outstanding, ignoring the batch cap -- so the workflow can log the
// backlog rather than silently reporting only what fits in one run.
export function pendingCount(records, state) {
  return pendingRecords(records, state, 0).length
}
