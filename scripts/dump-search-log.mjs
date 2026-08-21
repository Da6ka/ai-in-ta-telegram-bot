// Prints what the model actually searched for and what came back, from the
// per-turn dumps scripts/generate-briefing.mjs writes when BRIEFING_DEBUG_DIR
// is set.
//
// Usage:
//   node scripts/dump-search-log.mjs [dir]   # default state/candidate_debug
//
// It exists because the first two direct-API candidate runs (2026-08-21) both
// produced the prompt's "nothing usable" fallback, and there was no way to
// tell whether the searches came back empty, came back and were rejected, or
// came back stripped of the publish dates the prompt requires. Scores say how
// bad an edition is; this says why.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const dir = process.argv[2] || 'state/candidate_debug'
if (!existsSync(dir)) {
  console.log(`No debug dump at ${dir} — generation was not run with BRIEFING_DEBUG_DIR set.`)
  process.exit(0)
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()

for (const file of files) {
  let dump
  try {
    dump = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'))
  } catch (err) {
    console.log(`${file}: could not be read (${err.message})`)
    continue
  }
  console.log(`\n## ${file} — stop_reason: ${dump.stop_reason}`)
  for (const block of dump.blocks ?? []) {
    if (block.type === 'server_tool_use') {
      console.log(`\nquery: ${block.input?.query ?? JSON.stringify(block.input)}`)
    }
    if (block.type === 'web_search_tool_result') {
      // A successful result is a list; an error is a single object. Branching
      // on that is the difference between "the search failed" and "the search
      // worked and the model threw the results away".
      if (!Array.isArray(block.content)) {
        console.log(`  SEARCH ERROR: ${JSON.stringify(block.content)}`)
        continue
      }
      if (block.content.length === 0) console.log('  (no results)')
      for (const result of block.content) {
        console.log(`  [${result.page_age ?? 'no page_age'}] ${result.title} — ${result.url}`)
      }
    }
  }
}
