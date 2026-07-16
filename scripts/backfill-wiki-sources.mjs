// Rebuilds wiki/sources/YYYY-MM.jsonl -- the wiki's raw-source layer -- from
// every git revision of state/recent_stories.json.
//
// Why this exists: recent_stories.json is NOT an archive. It's the dedup feed
// for the generation prompt, so pruneRecentStories() drops anything older than
// RECENT_STORIES_WINDOW_DAYS (14) and MAX_RECENT_STORY_BULLETS caps what's
// injected -- both load-bearing for the --max-budget-usd ceiling (the
// 2026-07-04 budget incident). Widening that window to keep history would walk
// straight back into it. So history lives in a separate append-only file that
// never touches the prompt, and the only surviving copy of already-pruned days
// is the daily "Update briefing state" commits. This script mines them.
//
// Idempotent: derives everything from git history + the working file, so it can
// be re-run after a schema change to regenerate the corpus from scratch.
//
// One record per (date, url): faithful to what actually went out. A story
// re-reported on a later date is two records, deliberately -- collapsing
// restates is the wiki layer's job, the raw layer stays dumb. See
// docs/wiki-design.md.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { bulletUrlKey } from '../shared/telegram.mjs'

const PATH = 'state/recent_stories.json'

function git(args) {
  // `git log --format=%H` emits CRLF under this repo's config; unstripped, the
  // \r lands inside the `sha:path` revision argument and git rejects it.
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r/g, '')
}

function parseEntries(json) {
  try {
    return JSON.parse(json).entries ?? []
  } catch {
    return []
  }
}

// Bullet shape (briefing-prompt.md): "- **Headline**, prose ... ([Link
// title](https://url)) (16 July 2026)". Every field is best-effort: a bullet
// that drifts from the format still gets archived, just with nulls, because
// losing the record entirely is worse than losing its title.
function parseBullet(bullet) {
  const headline = bullet.match(/\*\*(.+?)\*\*/)?.[1] ?? null
  const link = bullet.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/)
  const url = link?.[2] ?? null
  let domain = null
  if (url) {
    try {
      domain = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      domain = null
    }
  }
  return { headline, source_title: link?.[1] ?? null, url, domain, key: bulletUrlKey(bullet) }
}

const shas = git(['log', '--format=%H', '--', PATH]).trim().split('\n').filter(Boolean)

// date -> Map(urlKey -> record). Oldest revision first so the earliest wording
// of a given (date, story) wins over later same-day restates, matching
// dedupeBullets' keep-first semantics.
const byDate = new Map()
let revisions = 0

function absorb(entries, provenance) {
  for (const entry of entries) {
    if (!entry?.date) continue
    if (!byDate.has(entry.date)) byDate.set(entry.date, new Map())
    const bucket = byDate.get(entry.date)
    for (const bullet of entry.bullets ?? []) {
      const parsed = parseBullet(bullet)
      const key = parsed.key ?? bullet
      if (bucket.has(key)) continue
      bucket.set(key, {
        date: entry.date,
        headline: parsed.headline,
        url: parsed.url,
        domain: parsed.domain,
        source_title: parsed.source_title,
        bullet,
        recovered_from: provenance,
      })
    }
  }
}

for (const sha of [...shas].reverse()) {
  let blob
  try {
    blob = git(['show', `${sha}:${PATH}`])
  } catch {
    continue // revision predates the file, or it was renamed
  }
  revisions++
  absorb(parseEntries(blob), `git:${sha.slice(0, 8)}`)
}

// The working copy last: it holds the current unpruned window, and for dates
// still inside it this is the authoritative text.
if (existsSync(PATH)) absorb(parseEntries(readFileSync(PATH, 'utf8')), 'working-tree')

const all = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
const byMonth = new Map()
for (const [date, bucket] of all) {
  const month = date.slice(0, 7)
  if (!byMonth.has(month)) byMonth.set(month, [])
  byMonth.get(month).push(...bucket.values())
}

mkdirSync('wiki/sources', { recursive: true })
let total = 0
for (const [month, records] of byMonth) {
  const file = `wiki/sources/${month}.jsonl`
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  total += records.length
  console.log(`${file}: ${records.length} record(s)`)
}

const dates = all.map(([d]) => d)
console.log(
  `\nScanned ${revisions} revision(s) of ${PATH}. ` +
    `Archived ${total} record(s) across ${dates.length} day(s): ${dates[0]} -> ${dates[dates.length - 1]}.`
)
const live = existsSync(PATH) ? parseEntries(readFileSync(PATH, 'utf8')).map((e) => e.date) : []
const recovered = dates.filter((d) => !live.includes(d))
console.log(`Recovered ${recovered.length} day(s) absent from the live file: ${recovered.join(', ') || '(none)'}`)
