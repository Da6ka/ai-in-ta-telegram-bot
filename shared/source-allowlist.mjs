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
  'reuters.com',
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
