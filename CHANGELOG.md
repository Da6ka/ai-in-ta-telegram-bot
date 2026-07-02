# Changelog

## 2026-07-02

### Daily briefing now follows the bot's live subscriber list

Previously the daily 09:00 UTC send went to a hand-maintained
`TELEGRAM_SUBSCRIBER_CHAT_IDS` repo secret, so /subscribe and /unsubscribe in
the bot had no effect on actual delivery.

- The Worker's Durable Object now mirrors the subscriber list into the
  `subscribers` KV key on every /subscribe, /unsubscribe, and /removeuser.
- `scripts/send-briefing.mjs` reads that KV key via the KV REST API at send
  time (using the existing `CF_*` secrets) and reports `recipient_count` to
  later workflow steps via `GITHUB_OUTPUT`.
- `daily-briefing.yml` reordered: send runs first, then usage stats and KV
  sync consume its recipient count. The `TELEGRAM_SUBSCRIBER_CHAT_IDS` secret
  is no longer read anywhere and can be deleted.

### Rate limit on briefing generation

Each /newbriefing (or /briefing with a stale cache) triggers a paid GitHub
Actions + Claude API run, previously unbounded.

- Global 60-minute cooldown between generation dispatches, enforced
  atomically in the Durable Object (`reserveBriefingDispatch`), with rollback
  if the GitHub dispatch fails.
- During the cooldown users are served today's cached briefing if it exists,
  or told one is being generated.
- Per-user backstop: max 3 generation requests per day (UTC), reset at
  midnight.
