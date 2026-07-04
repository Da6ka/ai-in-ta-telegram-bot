# Changelog

## [Unreleased]

### Cross-day story dedup (no more repeat "news")

The Claude Sonnet 5 launch (30 June) ran in both the 2026-07-03 and
2026-07-04 daily editions, cited via a different source domain each time.
Root cause: `briefing-prompt.md`'s freshness filter is a rolling "published
in the past 7 days" window, and nothing tracked what a prior edition had
already reported — "never cite the same domain twice" only dedupes within a
single day's edition. Added `state/recent_stories.json`, written by
`scripts/update-recent-stories.mjs` after a real, sent edition (gated the
same as usage-stats/KV updates) and pruned to the last
`RECENT_STORIES_WINDOW_DAYS` (14, matching the on-demand prompt's wider
freshness fallback). `scripts/build-recency-note.mjs` reads it back and
injects a "stories already covered, do not repeat" list into the generation
prompt in both `daily-briefing.yml` and `on-demand-briefing.yml`. Both
prompt files now document the rule explicitly.

Verified live post-merge with two back-to-back `/newbriefing` runs: the
first had nothing to dedupe against yet (the day's only prior edition ran
before this fix merged) and re-cited the Sonnet 5 launch; the second, now
reading real history from `recent_stories.json`, produced two entirely new
stories (Claude Enterprise admin controls, Claude GA on Microsoft Foundry)
with no repeats.

### Pinned the Claude Code CLI version

Both briefing workflows ran `npm install -g @anthropic-ai/claude-code` with
no version pin, so every run installed whatever was newest at the time. The
likely explanation for generation suddenly exceeding the `--max-budget-usd 1`
cap the day after that cap was tuned (see below) is a CLI update changing
cost-relevant behavior (model default, WebSearch/verification depth, token
accounting) — nothing in this repo's prompt or scoring logic changed in that
window. Pinned to `@anthropic-ai/claude-code@2.1.201` in both workflows so a
future CLI release can't silently shift generation cost or behavior; bump the
pin deliberately when upgrading.

### Surfaced briefing generation errors; bumped budget cap (#18, #19)

Today's briefing runs failed with no useful detail in the Actions log — both
`daily-briefing.yml` and `on-demand-briefing.yml` redirected `claude`'s
stdout straight into `state/today_briefing.md` on each retry and logged only
"Generation attempt N failed.", so the actual cause was invisible. Root
causes turned out to be two distinct, sequential issues: an Anthropic API
rate limit (resolved by adding funds), then the `--max-budget-usd 1` ceiling
from 1.1.0 being too tight for a successful generation. Now both workflows
capture and print `claude`'s stdout and stderr on a failed attempt (#18), and
the budget cap is raised from `1` to `2` (#19). `state/briefing_stderr.log`
is gitignored so it never pollutes the state commit on success.

### Documented the release policy

There was no written rule for when a changelog entry graduates from
`[Unreleased]` into a tagged version. Added a "Releasing" section to
`README.md`: SemVer bump rules (patch/minor/major) and a per-batch (not
per-PR) cadence for cutting a release. Docs-only, no code change.

### Daily briefing watchdog (#17)

`daily-briefing.yml`'s 09:00 UTC `schedule` trigger fired ~2.5h late two days
running (2026-07-02, 2026-07-03) — GitHub documents `schedule` as best-effort,
and on 07-03 it initially looked like it hadn't fired at all until a later,
very-delayed run showed up. Added `daily-briefing-watchdog.yml`: runs at
10:30 UTC, checks whether `last_briefing_at` has advanced to today, and if not,
dispatches a fallback `daily-briefing.yml` run and alerts the owner. Safe
against a race with the delayed native schedule trigger — the existing
idempotency check and shared `briefing-generation` concurrency group make
whichever run loses the race a no-op.

## [1.1.0] - 2026-07-03

### Bound the briefing generation step (LLM10 / ASI02)

The `claude -p` WebSearch-driven generation step in both `daily-briefing.yml`
and `on-demand-briefing.yml` had no wall-clock or cost ceiling — a stuck or
pathological WebSearch loop could run to GitHub Actions' default multi-hour
job timeout with no circuit breaker. Added `timeout-minutes: 10` on the step
and `--max-budget-usd 1` on the `claude -p` call in both workflows. Found via
an OWASP-aligned security pass over the briefing generation flow
(`agent-security-skill`, installed project-locally under `.claude/skills/`).

### `TELEGRAM_WEBHOOK_SECRET` rotated

Generated a fresh secret, set it on the production Worker (`wrangler secret put`),
and re-pointed Telegram's webhook at it via `setWebhook`. Routine rotation, not
a response to a leak — the old value simply wasn't recoverable (Cloudflare
Worker secrets are write-only), so a rotation was the practical path forward.
Confirmed via `getWebhookInfo` (`pending_update_count: 0` — no updates lost
during cutover).

### Clarify `/briefing` vs `/newbriefing` in `/help` copy

A user couldn't tell the two commands apart from the help text and had to ask
a colleague what `/newbriefing` actually does. Reworded both lines to say what
each one does differently, not just restate the command name.

### Point new users to `/help` in the `/start` greeting

Recruiters weren't discovering `/admin`, `/subscribe`, etc. beyond `/briefing`.
The greeting now tells approved users `/help` exists.

## [1.0.0] - 2026-07-03

Baseline release: Cloudflare Worker command bot + GitHub Actions briefing
delivery, tagged retroactively at the commit preceding the work above.
Everything below predates versioning.

### Phase 16 re-benchmark harness — editorial consistency scorer + scorecard (#14)

Tooling for the pre-growth editorial re-benchmark the final release audit gated
behind raising `MAX_USERS` / public enrollment. `docs/qa/phase16-rebench-template.md`
defines 8 binary hard gates (encoding the AUD-1 floor and the prompt's hard
filters) plus the original 5-dimension editorial rubric, with a fill-in scorecard
for 5 consecutive daily runs; its verdict rule scores the **floor (worst day),
not the average**, because AUD-1 was a consistency defect. `scripts/score-briefing.mjs`
auto-fills the scriptable columns (item count, gates G1–G5/G7, live link
resolution, domain dedup) from a composed `state/today_briefing.md`, reusing
`countBriefingItems()` / `MIN_BRIEFING_ITEMS` so the floor stays single-sourced.
QA-only — no runtime/worker change. The daily workflow gained an opt-in scoring
step (gated on the `PHASE16_BENCH` repo variable, `continue-on-error`) that posts
each edition's scorecard row to a "Phase 16 re-benchmark — 5-run log" tracking
issue while the benchmark window is on.

### SEC-1 closed — GitHub PAT rotated to a fine-grained, repo-scoped token

The last open audit item is done. The Worker's `GITHUB_TOKEN` no longer uses a
classic full-`repo` PAT (which granted push access to every repo on the account
if leaked). It now runs on a **fine-grained, this-repo-only `Contents: write`**
token — the exact scope `repository_dispatch` needs — and the old classic token
has been **deleted**. Docs updated (README rotation-status note + both QA status
docs mark SEC-1 resolved). No open findings remain across the whole audit.

### Fix misleading "being generated" message during a stale cooldown (UX-6)

Observed live: the first `/briefing` early on a new UTC day (before the 09:00
daily) replied "A briefing is being generated right now — send /briefing in a
couple of minutes" when nothing was generating — the global 1-hour dispatch
cooldown had simply carried over from the previous evening's on-demand run, and
that run produced *yesterday's* dated briefing, so there was no fresh cache to
serve either. `reserveBriefingDispatch` now also returns `sinceLastMin`, and
`requestGeneration` uses a `GENERATION_IN_FLIGHT_MIN = 10` window: within it a
run is plausibly still syncing (keep the "being generated" wording); past it,
say "Couldn't refresh the briefing just now — a fresh one can be generated in
~N min. You'll also get today's automatically with the daily update." New
behavioral test F13b covers both branches. Full suite 90/90 green.

### Improved AI news briefing quality (#9, #10)

- Improved the freshness, relevance, and reliability of AI recruitment news briefings.
- Reduced stale or repeated content by strengthening WebSearch and source selection.
- Enhanced article verification and fallback logic for more consistent daily briefings.

### Final release audit (GO) + fixes for AUD-1 (thin-briefing gate) and AUD-2 (bold-safe chunking)

Full audit report: `docs/qa/2026-07-03-final-release-audit.md`. Verdict: **GO**
for the current private ≤30-user deployment — no Critical/High open; a live
dry-run generation with the production prompt scored 7.5/7/6.5/8.5/7 on the
Phase 16 editorial rubric. Two findings fixed in the same session:

- **AUD-1 (Medium)** — no minimum-content gate: the briefing cached in prod was
  a single story, and even the dated "no content available" fallback passed
  both the `isValidBriefing` and freshness gates — on the daily path it would
  go to every subscriber, advance `last_briefing_at`, and silently block
  retries for the rest of the day. Now `countBriefingItems()` counts linked
  story bullets with a `MIN_BRIEFING_ITEMS = 2` floor: the daily workflow's
  check runs *before* the send and requires dated-today AND ≥ 2 items (else
  the stale-or-thin alert fires and the day stays retryable); on-demand treats
  a zero-story generation as stale; and `sync-kv.mjs` refuses to cache anything
  under the floor regardless of caller. Both prompts gained a minimum-coverage
  loop (run more-specific searches when < 4 items pass the filters), an
  impact-ordering rule, a source-tier preference, and a closing
  "**Bottom line:**" synthesis sentence.
- **AUD-2 (Low)** — `chunk()` protected `<a>…</a>` pairs (L6) but not
  `<b>…</b>`: a single line > 3500 chars whose space-preferring cut landed
  inside a bold span produced two chunks Telegram rejects. The balance check is
  now a general tag-stack scan that backs the cut up to the first unclosed tag
  of any kind.

- **AUD-3 (Low)** — a third rapid `/broadcast` silently replaced a *queued*
  one: GitHub keeps only the latest pending run per concurrency group, and a
  cancelled run doesn't fire the `failure()` alert. The group is removed from
  `broadcast.yml` — overlapping runs are safe (paced + 429-retried, worst case
  slightly slower delivery), while the group could drop a whole broadcast.

New regression tests for AUD-1/AUD-2 (thin-briefing counting incl. the
fallback and the observed 1-story case; bold-span chunk balance + anchor
non-regression). Full suite 89/89 green. Remaining manual item: confirm the
one-time SEC-1 PAT rotation of the live Worker `GITHUB_TOKEN` secret.

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

### 2026-07-02

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
