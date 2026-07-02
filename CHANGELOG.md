# Changelog

## 2026-07-03

### Clear the last audit findings: BUG-4 (broadcast at scale) + L6 (chunking)

- **BUG-4** — `/broadcast` delivery moved off the Worker onto the Actions runner.
  The Worker now validates the owner + message and fires a `broadcast`
  `repository_dispatch`; the new `broadcast.yml` workflow runs
  `scripts/broadcast.mjs`, which fans the message out to every subscriber
  (paced + retried, de-duped at send time via the shared `sendTextToMany`) and
  reports delivery back to the owner. This removes the Worker's per-invocation
  subrequest ceiling that silently dropped recipients past ~45 — including the
  multi-chunk case the earlier `MAX_USERS=30` cap didn't cover. The message and
  owner id travel as `client_payload` and are read as env vars (never
  interpolated into a shell), so a message with shell metacharacters is inert.
- **L6** — `chunk()` is now tag-aware: it prefers a newline, then a space, and
  never splits inside an HTML tag or across an `<a>…</a>` pair, so a single
  >3500-char line of links no longer produces chunks Telegram would reject.
- **SEC-1** — already documented (least-privilege scope table + rotation
  checklist in the README); the remaining step is the one-time manual rotation
  of the live `GITHUB_TOKEN` Worker secret to a fine-grained, this-repo-only
  `Contents: write` PAT.

Behavioral tests updated for the dispatch-based broadcast; new shared tests for
`sendTextToMany` (plain-text verbatim delivery + blocked-recipient resilience).
Full suite 86/86 green.

## 2026-07-02

### Phase 14 regression + consolidated audit status

Full-suite regression after the Phase 9–13 audit and the UX fixes:
`docs/qa/2026-07-02-phase14-regression.md`. All sources parse; `main` 75/75 and
the integrated `fix/phase13-ux-polish` tip 77/77, both green — the UX work added
two tests and regressed nothing, and the six `KNOWN BUG`/`L6` markers still pass
(open by design). The report also consolidates every phase's open findings into
one register with a priority block. Verdict: regression PASS, release GO for the
current private single-operator deployment; before opening enrollment past
~30–50 subscribers, do the priority cluster (a shared resilient send helper
closes REL-1/PERF-3/CQ-2 and hosts PERF-1's runner-side fan-out; a one-line
`getJSON` guard closes SEC-4). Phase coverage 1–14 complete. Report-only.

### Phase 13 UX review

Walked every user-facing reply and the onboarding/approval flow across all
three roles: `docs/qa/2026-07-02-phase13-ux.md`. Core conversational UX is
strong — no dead-ends, self-service identity in every unapproved reply,
immediate async acknowledgement, ungated privacy commands. No blocker. Polish
findings: UX-1 (medium) — commands are case-sensitive, so mobile
autocapitalization breaks `/Start`/`/Briefing` (one-line `.toLowerCase()` fix);
UX-2 (low–med) — `/help` omits `/newbriefing` even though the menu lists it;
UX-3 (low) — four admin id replies render literal backticks (Markdown without
`parse_mode`); UX-4 (low) — denied applicants get no notification; UX-5 (low) —
"Paired" wording is a leftover from the removed pairing-code model. Report-only,
no code changes.

### Phase 14 regression + consolidated audit status

Full-suite regression after the Phase 9–13 audit and the UX fixes:
`docs/qa/2026-07-02-phase14-regression.md`. All sources parse; `main` 75/75 and
the integrated `fix/phase13-ux-polish` tip 77/77, both green — the UX work added
two tests and regressed nothing, and the six `KNOWN BUG`/`L6` markers still pass
(open by design). The report also consolidates every phase's open findings into
one register with a priority block. Verdict: regression PASS, release GO for the
current private single-operator deployment; before opening enrollment past
~30–50 subscribers, do the priority cluster (a shared resilient send helper
closes REL-1/PERF-3/CQ-2 and hosts PERF-1's runner-side fan-out; a one-line
`getJSON` guard closes SEC-4). Phase coverage 1–14 complete. Report-only.

### Phase 13 UX review

Walked every user-facing reply and the onboarding/approval flow across all
three roles: `docs/qa/2026-07-02-phase13-ux.md`. Core conversational UX is
strong — no dead-ends, self-service identity in every unapproved reply,
immediate async acknowledgement, ungated privacy commands. No blocker. Polish
findings: UX-1 (medium) — commands are case-sensitive, so mobile
autocapitalization breaks `/Start`/`/Briefing` (one-line `.toLowerCase()` fix);
UX-2 (low–med) — `/help` omits `/newbriefing` even though the menu lists it;
UX-3 (low) — four admin id replies render literal backticks (Markdown without
`parse_mode`); UX-4 (low) — denied applicants get no notification; UX-5 (low) —
"Paired" wording is a leftover from the removed pairing-code model. Report-only,
no code changes.

### Clear remaining Worker findings: SEC-2, BUG-5, BUG-6, BUG-7

Low-severity / hardening fixes from the Phase 15 release-gate audit, all in
`worker/src/index.js`:

- **SEC-2** — `fetchWithRetry` now honors `Retry-After` in seconds (its real
  unit) instead of multiplying by 300ms. A 5s ask previously retried in 1.5s and
  drew a second 429; it now waits the full interval, with a short linear backoff
  when the header is absent.
- **BUG-5** — `/broadcast` strips its command prefix from the *trimmed* text, so
  a message sent with leading whitespace (`"  /broadcast hi"`) no longer ships
  the literal `/broadcast` prefix out to every subscriber.
- **BUG-6** — a stale Approve button no longer silently re-adds a user who was
  removed (or already handled) since the card was sent; the owner gets a
  "No longer pending" answer instead.
- **BUG-7** — approving via `/adduser <id>` now clears the matching pending
  request atomically (folded into the DO's `addAllowedUser`), so the person no
  longer lingers in `/pending` with their name/username still stored.

The three "KNOWN BUG" behavioral tests were flipped to assert the corrected
behavior; full suite 84/84 green.

### Fix NEW-1 (High): on-demand generation could poison the shared briefing cache

Phase 15 re-audit found the daily workflow's BUG-1 freshness gate was never
ported to the on-demand path. A zero-exit garbage generation (LLM refusal /
preamble-only / malformed title) from `/newbriefing` was synced to Cloudflare
KV unconditionally, so every user's `/briefing` then served that garbage from
cache until the next successful generation. Reproduced against the real Worker.

- **`on-demand-briefing.yml`** — added a `Check freshness` step; `Send to
  requester`, `Sync to Cloudflare KV`, and `Commit` now gate on `fresh == 'true'`.
  A new `Notify requester on stale generation` step closes the loop when
  generation exits 0 but produces nothing dated today (`failure()` doesn't fire).
- **`scripts/sync-kv.mjs`** — defense-in-depth `isValidBriefing(md)` guard so no
  caller can overwrite the shared cache with a headerless generation.
- **`shared/telegram.mjs`** — new shared `isValidBriefing()` helper.
- **Tests** — regression test for the guard; full suite 84/84 green.

### Operational resilience: failure alerts, retries, observability, tighter scopes

Addresses the production-readiness review (secret scopes, failure handling,
observability, webhook cutover risk):

- **Failure alerting** — new `scripts/send-alert.mjs` (best-effort, never throws,
  reuses the runner's `tgRequest`). `daily-briefing.yml` now pings the owner on
  `failure()` and on a stale-but-non-fresh generation (previously silent:
  subscribers got nothing and nobody knew). `on-demand-briefing.yml` notifies the
  waiting requester on failure instead of leaving them hanging. Requires a new
  `OWNER_CHAT_ID` repo variable.
- **Generation retry** — the `claude -p` step in both workflows retries once
  before failing, so a transient web-search/API hiccup doesn't cost the run.
- **Workers observability** — `[observability] enabled = true` in `wrangler.toml`,
  so the Worker's `console.error` calls persist as queryable logs.
- **Least-privilege secrets** — README gains a scope table + rotation checklist;
  `GITHUB_TOKEN` guidance switched from classic `repo` scope to a fine-grained,
  this-repo-only `Contents: write` PAT. Retired the obsolete
  `TELEGRAM_SUBSCRIBER_CHAT_IDS` repo secret (subscribers live in KV now).
- **Staging env** — optional `[env.staging]` block (separate Worker + KV + bot)
  for dry-running command changes before touching the live webhook; ignored by
  the default `wrangler deploy`.

### UX polish fixes (Phase 13 findings)

Fixed all five findings from the Phase 13 UX review:

- **UX-1** — commands are now case-insensitive: the dispatcher lowercases the
  command name before lookup, so mobile autocapitalization (`/Start`,
  `/Briefing`) resolves to the handler instead of the "I only understand
  commands" nudge. Also consolidates command-count stats across cases. The
  `/broadcast` prefix strip was made case-insensitive too, so a capitalized
  `/Broadcast` (now reachable) doesn't ship the literal command to subscribers.
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
