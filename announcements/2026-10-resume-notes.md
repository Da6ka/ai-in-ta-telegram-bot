# Notes behind the resume broadcast

## Dates
- Pause: 2026-09-02. Release 1.9.0 added /pause and /resume that day. The last
  wiki ingest entry is 2026-08-29 and cost_log.jsonl has no generation between
  2026-08-29 and 2026-10-24.
- Back: 2026-10-24. Release 1.10.0 and the first generation after the pause
  (cost_log.jsonl, on-demand run, 2026-10-24). The first Monday edition was
  2026-10-26. Confirm "24 October" is the date you want to give.

## Claims in the draft and where they come from (CHANGELOG)
- Live news search, past week: 1.10.0, "The daily briefing stopped paying the
  model to search".
- Summaries from article text, no generic takeaways: 1.10.1.
- Weekdays only: 1.10.2 (Worker crons ran Sun-Thu; weekend guard added).
- Cap 50: 1.10.0, MAX_USERS 30 -> 50.
- Dates and summaries corrected in the archive: 1.10.1 wiki lint passes.
- Erasure cannot be undone by a background job: 1.10.2, CI no longer writes
  usage_stats.
- /newbriefing limits: worker/src/index.js DAILY_DISPATCH_CAP = 2 per person,
  GLOBAL_DAILY_DISPATCH_CAP = 2 across everyone.

## Decision: the /newbriefing limits (1 per person, 2 across everyone)
The per-person cap (2) equals the global cap (2), so one person can use up the
whole day's allowance and the per-person number tells readers nothing. The caps
were sized when a run cost about $1.5 to $3. A run now costs about $0.11 to
$0.15 (cost_log.jsonl, October). The binding limit has moved to Firecrawl
credits: about 21 per run, about 460 a month of weekday editions, free plan 1,000.
That leaves room for roughly 25 on-demand runs a month, about one a day.
