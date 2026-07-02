# Changelog

## 2026-07-02

### UX polish fixes (Phase 13 findings)

Fixed all five findings from the Phase 13 UX review:

- **UX-1** — commands are now case-insensitive: the dispatcher lowercases the
  command name before lookup, so mobile autocapitalization (`/Start`,
  `/Briefing`) resolves to the handler instead of the "I only understand
  commands" nudge. Also consolidates command-count stats across cases.
- **UX-2** — `/help` now lists `/newbriefing`, matching the client command menu.
- **UX-3** — the four `/adduser` / `/removeuser` id replies now render the id in
  `<code>` (HTML) instead of showing literal Markdown backticks; the id is
  HTML-escaped.
- **UX-4** — denied applicants now get a neutral "your request wasn't approved"
  reply instead of being left in silence.
- **UX-5** — "Paired"/"Paired as" reworded to "You're approved"/"Approved as",
  matching the allowlist model (the pairing-code machinery was already removed).

Tests updated to assert the new behavior, plus a new deny-notification test
(76/76 green).

### Command menu registration (setMyCommands)

Added `scripts/set-commands.mjs`. The Worker handles commands but never
registered them with Telegram, so clients showed no "/" autocomplete or Menu
button. The script sets a public command list for everyone (default scope)
and an extended list including the admin commands scoped to the owner's chat
only. Run once after deploy and whenever the command set changes.

### Editorial prompt overhaul + behavioral test suite in-repo

Follow-ups from the release-gate audit:

- Both briefing prompts rewritten against the editorial findings (ED-1..3):
  news-phrased search queries instead of trends/guide bait, hard 7-day
  publish-date filter with the date shown per bullet, drop-if-unverifiable,
  no evergreen guides/listicles, no repeated domains, and regulatory dates/
  stats only from primary or authoritative sources. Sections shrink or
  disappear rather than get padded.
- The audit's 57-scenario behavioral harness now lives in
  `test/worker.behavior.test.mjs` and runs in CI via `npm test`. It drives
  the real Worker source (a `node:module` hook stubs only the
  `cloudflare:workers` import) against mocked KV/DO/fetch, covering auth,
  pairing, rate limiting, admin commands, hostile input, Telegram protocol
  edges, concurrency, and failure injection. Tests named `KNOWN BUG-n`
  intentionally assert current buggy behavior to track open findings.

### Release-gate QA audit + three must-fix bugs fixed

Full QA/security audit (57 behavioral scenarios against the worker code under
a mocked CF runtime, Telegram failure injection, link + editorial review of
the live briefing): `docs/qa/2026-07-02-release-gate.md`. Verdict:
conditional GO, no security-critical findings. Fixed the three must-fix bugs:

- Daily workflow: usage-stats step now gated on the freshness check, so a
  garbage generation can't mark the day done and block retries (BUG-1).
- Daily + on-demand workflows share one concurrency group and rebase before
  push, so they can no longer run concurrently and clobber state (BUG-2).
- Worker: `Object.hasOwn` guards in command dispatch and stats counting —
  `/constructor`-style messages now get the normal nudge instead of silence
  plus garbage in the `usage_stats` KV key (BUG-3).

Open findings (broadcast subrequest cap at ~45 subscribers, stale approve
button, `/adduser` pending leftover, editorial staleness, etc.) are tracked
in the report.


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

### Release-audit fixes (security, reliability, correctness)

Findings from a full pre-release audit of the Worker and CI pipeline.

- CI no longer runs Claude Code with `--dangerously-skip-permissions`; the
  briefing job is restricted to `--allowedTools "WebSearch"`, and file saving,
  idempotency, and stats bookkeeping moved out of the LLM into deterministic
  scripts. Closes a prompt-injection → secret-exfiltration path.
- `access` and `subscribers` moved into a `BotState` Durable Object.
  Concurrent /subscribe and /adduser calls were losing the majority of writes
  under a plain KV read-modify-write (measured: 15 concurrent /subscribe → 2
  landed; now all 15).
- Link `href`s are escaped in `mdToHtml` (shared module used by the Worker and
  both send scripts), so a stray quote in a URL can't break Telegram's HTML
  parser or inject markup.
- Telegram and GitHub API calls now check responses and retry 429/5xx with
  backoff instead of silently swallowing failures. /broadcast chunks to the
  4096-char limit and reports real delivery failures.
- `access.pending` is now populated from /start and shown by /pending (was
  dead code); duplicate Telegram `update_id`s are de-duped so a redelivery
  can't re-run /broadcast; /help respects the allowlist gate; /adduser
  validates the chat id is numeric; on-demand-briefing.yml got a concurrency
  group.

### /briefing crash and formatting fixes

Found by live testing against the deployed bot.

- /briefing no longer crashes reading `today_briefing_date`: it's a plain
  `YYYY-MM-DD` string, so reading it with KV's `json` type threw and produced
  no reply at all when a cached briefing existed.
- `mdToHtml` now renders inline `**bold**` instead of leaving literal
  asterisks in the message.
- The briefing title date is passed into the prompt and force-corrected
  post-generation (`scripts/force-briefing-date.mjs`), so it can't drift — the
  date is load-bearing for the freshness check.

### Privacy features (GDPR/LGPD baseline)

For opening the bot beyond invite-only use.

- `/privacy` — notice covering what's stored, why, where, retention, and
  rights; readable by anyone, approved or not.
- `/mydata` — subject access request; shows a user everything on file.
- `/forgetme` — right to erasure; wipes allowlist entry, subscription, pending
  request, and activity log (owner can't erase self).
- Owner-initiated /removeuser now fully erases the target's data too (was
  leaving `usage_stats` residue).
- /subscribe captures informed consent, pointing to /privacy.
- The per-user `last_seen` activity log auto-expires after 90 days via a prune
  sweep on every command.

### Guide unrecognized input instead of silence

- Plain text, typo'd commands, and non-text messages (stickers, photos, voice)
  in a private chat now get a short pointer to the available commands —
  /briefing + /help if approved, /start if not. Group chats and sender-less
  posts stay silent; message content is neither stored nor echoed.

### Webhook cutover

- Cut over from the local long-polling `server.ts` to the deployed Worker
  webhook. To avoid a token conflict with the Claude-via-Telegram plugin
  (whose poller auto-cleared the webhook on restart), the bot moved to its own
  dedicated token/bot (@AIinTANewsBot). Webhook secret rotated.
