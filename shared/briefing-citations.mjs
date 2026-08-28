// Turning the API's text blocks back into a briefing, including the case where
// the source URLs never made it into the prose.
//
// Citations are always on for web search. The API returns each cited span's
// source as structured data on the text block — `citations: [{url, title,
// cited_text, ...}]` — and it is a separate question whether the model *also*
// writes the markdown link into the text. Both happen:
//
//   2026-08-28 00:37  the model wrote its own links, in a block immediately
//                     after each cited span ("... signal. ([GlobeNewswire](…))")
//   2026-08-28 02:47  same code, equivalent prompt, five well-formed items,
//                     not one link anywhere
//
// Reading only `block.text` throws the URLs away in the second case. Every
// downstream gate counts *linked* bullets (extractBriefingBullets), so that
// edition scored zero items and subscribers were served the previous day's
// briefing while the workflow reported success.
//
// Anthropic's web search terms also require citations to be shown when API
// output is displayed to end users, which a briefing to subscribers is.
import { countBriefingItems } from './telegram.mjs'

// Blocks are concatenated with no separator on purpose. They split
// mid-sentence — one ends "...an AI services firm" and the next opens " For TA
// leaders" — so any separator between them shreds the prose. This is also why
// the model's own link, sitting in the block *after* the cited one, cannot be
// seen from inside the cited block: the two only meet once joined.
export function joinBlocks(blocks) {
  return (blocks ?? []).map(block => block?.text ?? '').join('')
}

// Appends each block's citations to the end of that block's text. Citations
// attach to the span they support, so this lands the link at the end of the
// sentence it belongs to — the same place the model puts it when it writes one
// itself, and inside the same line as the bullet's `- `, which is what
// extractBriefingBullets needs.
export function renderWithCitations(blocks) {
  return (blocks ?? [])
    .map(block => {
      const text = block?.text ?? ''
      const cites = block?.citations ?? []
      if (!cites.length) return text
      const seen = new Set()
      const links = []
      for (const cite of cites) {
        if (!cite?.url || seen.has(cite.url)) continue
        seen.add(cite.url)
        // Brackets in a title would terminate the markdown link early.
        const label = String(cite.title || cite.url).replace(/[[\]]/g, '')
        links.push(`[${label}](${cite.url})`)
      }
      if (!links.length) return text
      // A block does not end where its sentence ends. It routinely runs on
      // into the next bullet's opening -- "...(26 August 2026)\n- " -- so
      // appending to the raw end puts the link at the *start* of the following
      // bullet, leaving the cited one bare and the next one mis-sourced.
      // Split off the trailing whitespace and list marker, append inside, put
      // the structure back.
      const [, tail = ''] = text.match(/(\s*(?:[-*+]\s+|\d+\.\s+)?)$/) ?? []
      const body = tail ? text.slice(0, text.length - tail.length) : text
      if (!body.trim()) return text
      return `${body} (${links.join(', ')})${tail}`
    })
    .join('')
}

// Compose, and repair only if the result carries no linked bullets at all.
//
// The repair is deliberately all-or-nothing rather than per-block. A block that
// holds a citation and a block that holds the model's own link are different
// blocks, so neither can tell locally whether the other exists — rendering
// citations per-block would double-cite every run where the model behaved.
// Whether the whole composed edition has any links is the one question that
// can be answered reliably.
export function composeBriefingText(blocks) {
  const text = joinBlocks(blocks).trim()
  if (!text || countBriefingItems(text) > 0) return { text, citationsRendered: false }

  const repaired = renderWithCitations(blocks).trim()
  if (countBriefingItems(repaired) === 0) return { text, citationsRendered: false }
  return { text: repaired, citationsRendered: true }
}
