// Fixtures are real block shapes captured from state/candidate_debug on
// 2026-08-28, trimmed. The two runs are the whole point of this module: the
// same code and equivalent prompts, one where the model wrote its own markdown
// links and one where it wrote none and left the URLs entirely to the citation
// channel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinBlocks, renderWithCitations, composeBriefingText } from './briefing-citations.mjs'
import { countBriefingItems } from './telegram.mjs'

const SAPIA =
  'https://www.globenewswire.com/news-release/2026/08/26/3351491/0/en/pageup-and-sapia-ai-embed-intelligent-ai-interviewing-directly-into-enterprise-hiring-workflows.html'
const ESKILL =
  'http://www.prnewswire.com/news-releases/eskill-launches-linea-the-ai-powered-intelligence-layer-for-role-relevant-pre-hire-testing-302860203.html'

// 00:37 run: cited span, then a separate block carrying the model's own link.
// Note the blocks split mid-sentence — that is why they are joined with no
// separator.
const modelWroteLinks = [
  { type: 'text', text: '# Daily AI Recruitment Briefing — 28 August 2026\n\n## Claude & Anthropic in TA\n- ' },
  {
    type: 'text',
    text: "PageUp and Sapia.ai announced an enhanced partnership linking Sapia.ai's autonomous interviewing with PageUp's ATS",
    citations: [{ type: 'web_search_result_location', url: SAPIA, title: 'PageUp and Sapia.ai embed intelligent AI interviewing' }],
  },
  { type: 'text', text: ` — a useful defensibility signal. ([GlobeNewswire](${SAPIA})) (26 August)\n` },
]

// 02:47 run: the same cited spans, and no follow-up block. Five items reached
// the freshness gate as items=0.
const modelWroteNoLinks = [
  { type: 'text', text: '# Daily AI Recruitment Briefing — 28 August 2026\n\n## Claude & Anthropic in TA\n- ' },
  {
    type: 'text',
    text: '**eSkill launches Linea.** eSkill launched Linea, an AI-powered intelligence layer for pre-hire testing. (26 August 2026)\n- ',
    citations: [{ type: 'web_search_result_location', url: ESKILL, title: 'eSkill Launches Linea' }],
  },
  {
    type: 'text',
    text: "**PageUp and Sapia.ai deepen their partnership.** Sapia.ai's autonomous interviewing lands inside PageUp's ATS. (26 August 2026)\n",
    citations: [{ type: 'web_search_result_location', url: SAPIA, title: 'PageUp and Sapia.ai embed intelligent AI interviewing' }],
  },
]

test('joinBlocks uses no separator, because blocks split mid-sentence', () => {
  const joined = joinBlocks(modelWroteLinks)
  assert.ok(joined.includes("PageUp's ATS — a useful defensibility signal"), 'sentence survives the block boundary')
})

test('the model writing its own links is left completely alone', () => {
  const { text, citationsRendered } = composeBriefingText(modelWroteLinks)
  assert.equal(citationsRendered, false, 'no repair when links are already there')
  assert.equal(text, joinBlocks(modelWroteLinks).trim(), 'byte-identical to the plain join')
  // The failure mode this guards: rendering citations per-block would append a
  // link to the cited block AND leave the model's own link in the next one.
  assert.equal((text.match(/globenewswire/g) ?? []).length, 1, 'cited once, not twice')
})

test('a run with no links at all is rebuilt from its citations', () => {
  assert.equal(countBriefingItems(joinBlocks(modelWroteNoLinks)), 0, 'sanity: this is the 02:47 failure')
  const { text, citationsRendered } = composeBriefingText(modelWroteNoLinks)
  assert.equal(citationsRendered, true)
  assert.equal(countBriefingItems(text), 2, 'both bullets now count')
  // The link has to land on the bullet's own line: extractBriefingBullets
  // matches per line, so a link appended after the newline would not count.
  for (const line of text.split('\n').filter(l => l.startsWith('- '))) {
    assert.match(line, /\]\(https?:\/\//, `bullet carries its link: ${line.slice(0, 40)}`)
  }
})

test('a citation title containing brackets cannot break the markdown link', () => {
  const out = renderWithCitations([
    { type: 'text', text: '- A story', citations: [{ url: 'https://ex.com/a', title: 'Report [2026] out' }] },
  ])
  assert.equal(out, '- A story ([Report 2026 out](https://ex.com/a))')
  assert.equal(countBriefingItems(out), 1)
})

test('repeated citations of one source produce one link', () => {
  const out = renderWithCitations([
    {
      type: 'text',
      text: '- A story',
      citations: [
        { url: 'https://ex.com/a', title: 'Same' },
        { url: 'https://ex.com/a', title: 'Same' },
      ],
    },
  ])
  assert.equal(out, '- A story ([Same](https://ex.com/a))')
})

test('nothing to rebuild from is reported as such, not papered over', () => {
  const blocks = [{ type: 'text', text: '# Daily AI Recruitment Briefing — 28 August 2026\n\n- A bare claim, no source.' }]
  const { text, citationsRendered } = composeBriefingText(blocks)
  assert.equal(citationsRendered, false)
  assert.equal(countBriefingItems(text), 0, 'still zero, so the caller fails the run')
})

test('empty input does not throw', () => {
  assert.deepEqual(composeBriefingText([]), { text: '', citationsRendered: false })
  assert.deepEqual(composeBriefingText(undefined), { text: '', citationsRendered: false })
})
