// Auto-fills the scriptable columns of the Phase 16 re-benchmark scorecard
// (docs/qa/phase16-rebench-template.md) from a composed briefing file.
//
// Usage:
//   node scripts/score-briefing.mjs [path/to/today_briefing.md] [--no-fetch]
//
// Defaults to state/today_briefing.md. Computes item count and gates G1, G2,
// G3, G4, G5, G7; prints a per-link resolution report and a ready-to-paste
// scorecard row. G6 (source tiering) and G8 (silent fallback) and the five
// editorial 1-10 scores are judgment calls — left blank for the human scorer.
import { readFileSync } from 'node:fs'
import { countBriefingItems, MIN_BRIEFING_ITEMS } from '../shared/telegram.mjs'

const TARGET_ITEMS = 4 // prompt's minimum-coverage loop target (G2)
const FRESH_HOURS = 48 // G3: bullets should reference the past ~48h

const args = process.argv.slice(2)
const noFetch = args.includes('--no-fetch')
const file = args.find((a) => !a.startsWith('--')) ?? 'state/today_briefing.md'

const md = readFileSync(file, 'utf8')
const today = new Date()

// Story bullets are markdown-link lines, same shape countBriefingItems() counts.
const bullets = (md.match(/^- .*\]\(https?:\/\/.*/gm) ?? [])
const items = countBriefingItems(md)

// Extract the URL from each bullet.
const urls = bullets
  .map((b) => b.match(/\]\((https?:\/\/[^)]+)\)/)?.[1])
  .filter(Boolean)

const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}
const domains = urls.map(domainOf)
const uniqueDomains = new Set(domains)
const dupDomains = domains.filter((d, i) => domains.indexOf(d) !== i)

// G3 heuristic: does each bullet carry a date token in the past ~48h? We can't
// robustly parse every phrasing, so we flag bullets with NO recognizable recent
// date for manual review rather than silently passing them.
const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const cutoff = new Date(today.getTime() - FRESH_HOURS * 3600 * 1000)
function bulletLooksDated(b) {
  const lower = b.toLowerCase()
  // ISO date within window
  const iso = b.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) {
    const d = new Date(iso[0])
    if (!Number.isNaN(+d) && d >= cutoff && d <= today) return true
  }
  // "Jul 2", "July 2", "2 July" near current month
  if (monthNames.some((m) => lower.includes(m))) return true
  // relative phrasing
  if (/\b(today|yesterday|this week|hours ago|announced (today|yesterday))\b/.test(lower)) return true
  return false
}
const undatedBullets = bullets.filter((b) => !bulletLooksDated(b))

const bottomLine = /\*\*bottom line:?\*\*/i.test(md)

// G4: resolve every link (unless --no-fetch). 403 is flagged, not failed —
// bot-blocking (e.g. Stanford) counts as a live link per the audit.
async function checkLink(u) {
  try {
    let res = await fetch(u, { method: 'HEAD', redirect: 'follow' })
    if (res.status === 405 || res.status === 501) {
      res = await fetch(u, { method: 'GET', redirect: 'follow' })
    }
    return { url: u, status: res.status }
  } catch (err) {
    return { url: u, status: 0, error: String(err.message ?? err) }
  }
}

const linkResults = noFetch ? [] : await Promise.all(urls.map(checkLink))
const dead = linkResults.filter((r) => r.status === 0 || (r.status >= 400 && r.status !== 403))
const botBlocked = linkResults.filter((r) => r.status === 403)

const pass = (b) => (b ? '✅' : '✗')
const g1 = items >= MIN_BRIEFING_ITEMS
const g2 = items >= TARGET_ITEMS
const g3 = undatedBullets.length === 0
const g4 = noFetch ? null : dead.length === 0
const g5 = uniqueDomains.size === urls.length
const g7 = bottomLine

console.log(`\nPhase 16 scoring — ${file}`)
console.log(`Generated (file mtime not read; stamp UTC + commit yourself)\n`)
console.log(`Items (linked stories): ${items}  [floor ${MIN_BRIEFING_ITEMS}, target ${TARGET_ITEMS}]`)
console.log(`Distinct domains: ${uniqueDomains.size}/${urls.length}${dupDomains.length ? `  DUPLICATES: ${[...new Set(dupDomains)].join(', ')}` : ''}`)
console.log(``)
console.log(`G1 floor reached (>=${MIN_BRIEFING_ITEMS})    ${pass(g1)}`)
console.log(`G2 target coverage (>=${TARGET_ITEMS})   ${g2 ? '✅' : '⚠️  ' + items + ' items'}`)
console.log(`G3 every bullet dated       ${pass(g3)}${undatedBullets.length ? `  (${undatedBullets.length} need manual review)` : ''}`)
console.log(`G4 links resolve            ${g4 === null ? '— (skipped, --no-fetch)' : pass(g4)}`)
console.log(`G5 distinct domains         ${pass(g5)}`)
console.log(`G6 source tiering           — MANUAL`)
console.log(`G7 Bottom line present      ${pass(g7)}`)
console.log(`G8 no silent fallback       — MANUAL (check the run's alert log)`)

if (undatedBullets.length) {
  console.log(`\nBullets with no recognizable recent date (review G3):`)
  undatedBullets.forEach((b) => console.log(`  · ${b.slice(0, 100)}`))
}
if (!noFetch) {
  console.log(`\nLink resolution:`)
  linkResults.forEach((r) => {
    const tag = r.status === 0 ? 'DEAD' : r.status === 403 ? 'bot-block?' : r.status >= 400 ? 'DEAD' : 'ok'
    console.log(`  [${r.status || 'ERR'}] ${tag.padEnd(10)} ${domainOf(r.url)}`)
  })
  if (botBlocked.length) console.log(`  (${botBlocked.length} × 403 — verify each is bot-blocking, not a dead link)`)
}

// Ready-to-paste scorecard row (scriptable columns filled; the rest blank).
const row = ['', '', '', items, pass(g1), g2 ? '✅' : '⚠️', pass(g3), g4 === null ? '?' : pass(g4), pass(g5), '?', pass(g7), '?', '', '', '', '', '']
console.log(`\nScorecard row (fill Date/Commit + G6/G8 + editorial scores):`)
console.log(`| N | ${row.slice(2).join(' | ')} |`)

const hardFail = g1 === false || g3 === false || g5 === false || g7 === false || g4 === false
process.exitCode = hardFail ? 1 : 0
