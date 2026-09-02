// Domains the briefing's web search is allowed to return.
//
// Why this exists: on 2026-08-21 three candidate runs of the direct-API
// generator produced the prompt's "nothing usable" fallback. The search log
// showed why -- 85 results across ten searches, of which exactly one was
// inside the seven-day window, and that one was a "trends" listicle the prompt
// bans. The rest were evergreen SEO ("the complete 2026 guide"), vendor
// landing pages, and outright noise. The API's web search does not rank these
// queries by recency, so the freshness rules in briefing-prompt.md were doing
// their job on a pile of results that could never pass them.
//
// briefing-prompt.md already says to prefer primary sources and named trade
// press. An allowlist makes that structural instead of advisory: junk cannot
// be filtered out after the fact if it crowded the real story out of the
// results in the first place.
//
// The list is evidence-based, not guessed. It starts from every domain the
// archive has actually cited across 39 editions (180 links, 73 domains --
// re-derive with the link extraction in scripts/dump-search-log.mjs's sibling
// analysis, or by grepping wiki/ and state/recent_stories.json), keeps those
// cited more than once, and adds outlets briefing-prompt.md names but the
// archive has not happened to use yet, plus the two regulators the compliance
// beat turns on.
//
// Maintenance: a story from a good source outside this list is invisible, so
// treat a thin week as a reason to check what got excluded. The web search
// tool rejects an over-long filter list outright (`request_too_large`), so
// prefer replacing a dead entry over appending forever.
export const SOURCE_ALLOWLIST = [
  // Newswires — where vendor and funding announcements land first. The
  // archive's two most-cited domains by a wide margin.
  'prnewswire.com',
  'globenewswire.com',
  'businesswire.com',
  'einpresswire.com',

  // Anthropic and Claude, for the briefing's first section.
  'anthropic.com',
  'claude.com',
  'releasebot.io',

  // TA and HR trade press. ere.net, hr-brew.com, hrexecutive.com and
  // unleash.ai are named in the prompt or cover the beat directly.
  'staffingindustry.com',
  'hrdive.com',
  'shrm.org',
  'hrexecutive.com',
  'hr-brew.com',
  'ere.net',
  'unleash.ai',
  'hrkatha.com',
  'joshbersin.com',
  'worldatwork.org',

  // Tech and business press, for launches, funding and M&A.
  'techcrunch.com',
  'bloomberg.com',
  'fortune.com',
  'cnbc.com',
  'forbes.com',
  'sifted.eu',
  'infoworld.com',

  // Regulation and litigation.
  'natlawreview.com',
  'bloomberglaw.com',
  'eeoc.gov',
  'dol.gov',

  // Vendor newsrooms — primary sources for product news. Each already cited
  // by the archive. The prompt's ban on vendor landing pages still applies;
  // being allowed to search a domain is not permission to cite its homepage.
  'bullhorn.com',
  'icims.com',
  'eightfold.ai',
  'ibm.com',
  'cognizant.com',
]

// Domains dropped from the candidate list outright.
//
// The allowlist above was enforced by the API: it went out as the web search
// tool's `allowed_domains`, so a story from anywhere else could not reach the
// model. Moving the search to Firecrawl on 2026-09-02 removed that enforcement
// -- Firecrawl has no equivalent filter -- and the first live run showed what
// that costs: of 50 candidates, exactly one (cnbc.com) was on the allowlist,
// and the pool was led by stock-analysis and PR-aggregator domains.
//
// Re-applying the allowlist as a filter is not an option: it would have left
// one story out of fifty. This is the inverse, and deliberately narrow. Every
// entry is the "stock-analysis" tier the composition prompts already tell the
// model to avoid, so this enforces an existing editorial rule rather than
// inventing one -- these outlets rewrite someone else's reporting for an
// investor audience, so the story is always available from its actual source.
// A domain that merely looks low-rent does not belong here; that judgment is
// the manual G6 gate's, not this list's.
export const SOURCE_DENYLIST = [
  'investing.com',
  'finance.yahoo.com',
  'stocktitan.net',
  'benzinga.com',
  'zacks.com',
  'marketbeat.com',
  'insidermonkey.com',
  'simplywall.st',
  'fool.com',
  'tracxn.com',
  'biggo.com',
]

function hostOf(url) {
  try {
    return new URL(String(url)).host.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

// Matches a domain and its subdomains, so 'finance.yahoo.com' covers itself
// and 'biggo.com' covers 'finance.biggo.com'.
function matches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

// 'denied' -- drop it before the model ever sees it. 'preferred' -- on the
// curated source list, which the candidate block marks so the prompts' "prefer
// strong sources" rule has something concrete to read. 'other' -- allowed, and
// judged on its merits like anything else.
export function sourceTier(url) {
  const host = hostOf(url)
  if (!host) return 'other'
  if (SOURCE_DENYLIST.some((d) => matches(host, d))) return 'denied'
  if (SOURCE_ALLOWLIST.some((d) => matches(host, d))) return 'preferred'
  return 'other'
}

// reuters.com is deliberately absent: it blocks Anthropic's crawler, and the
// API rejects the whole request with a 400 naming it rather than skipping it,
// so one such entry takes the day's briefing down. Anything added here should
// be checked the same way -- a run that 400s on a domain is cheap (it fails
// before any tokens are spent), but it fails.
//
// The 400's message lists the offending domains, which is enough to recover
// from automatically. scripts/generate-briefing.mjs drops them and retries;
// this parses the list out of the message.
export function parseInaccessibleDomains(message) {
  const match = /domains are not accessible to our user agent:\s*\[([^\]]*)\]/i.exec(String(message ?? ''))
  if (!match) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
}
