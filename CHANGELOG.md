# Changelog

## [Unreleased]

### Global daily cap on briefing generation

The three generation limits were doing two jobs, not three: the global 60-minute
cooldown and the per-user 3/day cap both existed, but neither bounded total
spend. The per-user cap bounds *hogging* -- each allowlisted user gets their own
3/day, so cost scaled with the allowlist -- which left the cooldown as the only
real ceiling, at ~24 dispatches/day and $4 of paid Actions + Claude run apiece.

Adds `GLOBAL_DAILY_DISPATCH_CAP` (**5/day across everyone**, UTC-reset) as an
independent third limit, tracked in `briefing_rate.total`. The per-user cap is
deliberately kept: making the cap global *instead* would let any single
allowlisted user burn the shared quota and lock everyone else out for the day,
including the owner. A user refused by the shared cap is served the cached
edition, and the daily scheduled send -- which never goes through
`reserveBriefingDispatch` -- is unaffected.

Rollback refunds the shared slot along with the per-user one, so a dispatch
GitHub never accepted doesn't consume quota. Rate records written before this
cap existed have no `total` and default to 0 rather than NaN-comparing into
refusing every dispatch. Tests 139 -> 142 (F12b/F12c/F12d), each verified to
fail without the change.

### Corrected the technical spec against the code

`docs/technical-spec.md` had drifted from the deployed system on several
enforced values, which matters for a document whose whole purpose is being
checkable against an implementation:

- Per-run LLM spend was documented as `--max-budget-usd 2`; both workflows
  actually pass **4**, so the stated cost ceiling was half the real one.
- The dispatch cooldown was documented as a flat 60 min, omitting the owner's
  5-min window, and the note below the limits table claimed the cooldown and cap
  are "global, not per-user" -- wrong about the cap, which is per-user by design.
  Replaced with §6.2, explaining how the three limits compose and what each one
  actually bounds.
- §5.1 omitted the freshness/content gate entirely (dated-today +
  `MIN_BRIEFING_ITEMS`), including the part that matters most: a rejected
  edition leaves `last_briefing_at` un-advanced so the day stays retryable.
- Added `MAX_PENDING` (50) to the limits table, and `briefing_rate` /
  `seen_updates` to the §4.1 DO field list.
- §3.2 and §5.3 both cross-referenced a "§6.2" that did not exist; the new
  subsection resolves the dangling reference.

### Unit-tested the delivery scripts' embedded logic

Extracted the three pieces of consequential pure logic that lived inline in the
GitHub Actions delivery scripts into `shared/telegram.mjs`, where CI can reach
them, and added unit tests (133 -> 139):

- `isLowBalanceError()` (from `check-credit-balance.mjs`) -- the classifier that
  decides whether a failed Anthropic pre-flight blocks the multi-dollar
  generation run; only the low-credit body blocks, every other error passes so
  a transient failure can't silently skip the day's briefing.
- `applyBriefingToUsageStats()` + `USAGE_HISTORY_LIMIT` (from
  `update-usage-stats.mjs`) -- the daily increment / date-stamp / 30-edition
  history-cap bookkeeping, now covered for the cap, fresh-seed, and no-mutation
  cases.
- `briefingDomain()` and `bulletLooksDated()` (from `score-briefing.mjs`) -- the
  G5 distinct-domain and G3 recent-date scorecard heuristics.

Behavior is unchanged: the scripts now import these instead of defining them
inline. Closes the repo's remaining untested-logic gap; the rest of `scripts/`
is thin Telegram/GitHub/KV `fetch` wrappers left as integration-only.

## [1.5.3] - 2026-07-15

### Fixed the owner-can't-unsubscribe guard checking a field nothing writes

`/unsubscribe` gated the owner-refusal on `subscribers.owner`, but no code
path ever writes that field — it stays `''` from `DEFAULT_SUBSCRIBERS` — so
the guard never fired and the bot owner could unsubscribe from their own daily
briefing (they'd then miss it until re-subscribing). The guard now keys off
`access.ownerChatId`, the same source of truth `/forgetme` already uses.

The `F8` test passed only because its fixture hand-seeded
`subscribers: { owner: OWNER }`, a shape the running Worker never produces.
Dropped that field from the test fixtures so `F8` now exercises the real
`access.ownerChatId` path and fails if the guard regresses.

## [1.5.2] - 2026-07-15

### Added a regression test for en dash/hyphen title tolerance

The 1.5.1 dash-tolerance fix taught `isValidBriefing()` to accept em dash, en
dash, or a plain hyphen in the briefing title separator, but shipped without a
test. Added one asserting all three separators are accepted, so a future
narrowing of `TITLE_DASH` can't silently reintroduce the rejection of
otherwise-valid briefings. (#57)

### Fixed the same Stop-hook outage on the /newbriefing path

The 1.5.1 fix applied `--setting-sources user` and `--debug-file` to
`daily-briefing.yml`'s `claude -p` call only. The identical call in
`on-demand-briefing.yml` (the `/newbriefing` command) was missed, leaving it
exposed to the same silent-empty-output failure mode the outage was caused
by. Mirrored both flags there, plus the debug-log dump on a rejected
generation.

### Aligned Claude Code CLI pin across workflows

`on-demand-briefing.yml` was still pinned to `2.1.201` while `daily-briefing.yml`
had moved to `2.1.209`. Both run the same generation logic, so left on
different versions they risked silently drifting into "works in one
workflow, not the other" bugs. Both now pin `2.1.209`.

## [1.5.1] - 2026-07-14

### Fixed the project's Stop hook silently blocking headless briefing generation

`/briefing` served a stale 11 July edition for three straight days (2026-07-12
through -14) with no diagnosable failure signal: every `daily-briefing.yml` run
exited 0 (once it instead hit the step's 10-minute timeout) while `claude -p`
produced completely empty stdout/stderr. Root cause, found via `--debug-file`:
this repo's `.claude/settings.json` Stop hook (added 2026-07-13 — an `npm test`
gate meant to guard interactive coding sessions) also fires on this headless,
content-generation-only `claude -p` call. Its `npm test` failed inside the CI
checkout specifically (`node --test "shared/**/*.test.mjs"` matched nothing
there, though the identical command passes locally and in the separate
`ci.yml` workflow), so the hook blocked every completion attempt in a loop —
the model never got to actually finish, and no real error ever reached
stdout/stderr for the existing failure-dump steps to print.

Fixed with `--setting-sources user` on the `claude -p` invocation, which
excludes the "project" settings source (where the hook lives) without
disabling anything else. `--bare` was tried first since it also skips hooks,
but it disables tool search along with them, which silently broke WebSearch
too — the model fell back to raw `curl`/`wget` via Bash (denied, since only
`WebSearch` is allowlisted) and gave up with the prompt's own "no content
available" fallback instead of a real briefing.

Also added `--debug-file state/briefing_debug.log`, dumped (last 200 lines)
alongside stdout/stderr on freshness-gate rejection, so a repeat of this
failure mode is diagnosable from the Actions log instead of requiring live
reproduction. Bumped the pinned CLI (`2.1.201` → `2.1.209`) while
investigating — turned out not to be the actual cause, but harmless to keep.

Recovered the live outage manually while diagnosing: synced a validated 14
July edition straight to Cloudflare KV (`wrangler kv key put`) so `/briefing`
had current content throughout the investigation, ahead of the CI fix
landing.

### Tolerate en dash/hyphen in briefing title separator

`isValidBriefing()` and `BRIEFING_TITLE_RE` only matched an exact em dash (—)
between the title and date. A model drifting onto a visually similar en dash
or hyphen produced a perfectly usable briefing that still got rejected
identically to a genuinely malformed one — indistinguishable in the logs from
a real generation failure. `shared/telegram.mjs` now accepts em dash, en
dash, or a plain hyphen via a shared `TITLE_DASH` character class.

### Serve the last saved edition when an on-demand briefing fails

When `/briefing` or `/newbriefing` generation exited 0 but the freshness/content
gate rejected it (the "no content" fallback, or an undated/malformed title), the
requester was only told to run `/briefing` themselves — leaving them to issue a
second command to get anything. The on-demand workflow's stale branch now serves
the last saved edition directly, the same thing `/briefing` returns, via new
`scripts/send-stale-to-chat.mjs` (reads `today_briefing_md` / `today_briefing_date`
from Cloudflare KV, mirroring the Worker's `serveStaleBriefing`). Best-effort:
never throws, always exits 0, and falls back to the previous alert text if KV has
no saved edition or can't be reached, so the requester is never left in silence.

### Dump generation output when the briefing freshness gate rejects

Both briefing workflows have a content/freshness gate that rejects a generation
which exits 0 but produces the "no content" fallback (zero linked stories) or an
undated/malformed title — the requester/owner then sees "didn't come out right
this time" with no diagnosis, because the generate step only dumps stdout/stderr
on a *non-zero* exit. The reject path in `daily-briefing.yml` and
`on-demand-briefing.yml` now dumps `head -40 state/today_briefing.md` and
`state/briefing_stderr.log` to the run log, so the next occurrence is
attributable (empty fallback vs. truncation vs. bad title vs. a WebSearch/upstream
error captured on stderr). Diagnostics only — no behaviour change.

## [1.5.0] - 2026-07-14

### Hardened briefing prompt against model reasoning leakage

`briefing-prompt.md` already required markdown-only output, but the model still occasionally returned internal selection rationale before the briefing title. A live 2026-07-13 edition started with:

> "I have three solid, date-verified items across distinct beats..."

instead of the actual briefing, exposing research notes and editorial decisions to subscribers. Strengthened the prompt with explicit output guards: the response must start with `# Daily AI Recruitment Briefing`, and research notes, selection rationale, status updates, apologies, and phrases such as "I found", "I have", "I searched", or "I omitted" are forbidden. The briefing generator output is now constrained to the saved Markdown artifact only.

### External briefing heartbeat (Cloudflare-side)

Added a second Worker cron (12:00 UTC) that alerts the owner via Telegram if a
day's briefing never landed. Every prior guard runs *inside* GitHub Actions --
the workflow's own retries and the 10:30 UTC watchdog -- so all are blind to the
failure mode that took the briefing down Jul 8-10 2026: an account-wide Actions
block (billing hold / outage) makes every run `startup_failure` before a step
executes, watchdog included. `briefingHeartbeat` runs on Cloudflare, independent
of GitHub, reads `today_briefing_date` from KV (written only by a successful
generation), and pings the owner if it isn't today's. Requires `wrangler deploy`
to register the new cron. Covered by 3 unit tests.

### Strip model preamble before the briefing title

`briefing-prompt.md` forbids preamble ("Output ONLY the composed briefing
markdown ... no commentary before or after it"), but the model occasionally
ignores it and opens with reasoning before the `# Daily AI Recruitment
Briefing` title (seen live 2026-07-13: an edition led with "I have three solid,
date-verified items ..."). Nothing downstream stripped it, so on those days the
commentary rendered at the top of every subscriber's briefing. Added
`normalizeBriefing` (shared/telegram.mjs) — a deterministic transform that drops
anything before the first title line, then forces the title date — and rewired
`scripts/force-briefing-date.mjs` (run right after generation, before the
freshness gate) to use it. Covered by 5 unit tests; a missing title still
returns unchanged so the freshness gate rejects it rather than guessing.

### Shorter briefing-generation cooldown for the owner

The 60-minute global dispatch cooldown blocked the owner from refreshing
on demand (`/newbriefing` fell back to the last saved edition with a "a fresh
one can be generated in ~X min" note). The owner now gets a **5-minute**
cooldown instead of 60; the per-user daily cap of 3 still applies to the owner
as a cost backstop, since every generation is a paid GitHub Actions + Claude
run. `reserveBriefingDispatch` takes an `isOwner` flag threaded from the
`/briefing` and `/newbriefing` handlers via `requestGeneration`; non-owner
behaviour is unchanged. All 132 unit tests pass.

### Refactored the command layer (code review follow-up)

Maintainability cleanup of `worker/src/index.js`, no behavioural change to any
existing command (all 123 unit tests pass unchanged):

- **Declarative role gate.** The owner/admin authorization check was a 4-line
  `if (!isOwnerOrAdmin(...))` block copy-pasted into eight handlers. Replaced
  with a `COMMAND_ROLES` map (`'admin'` / `'owner'`) checked once in
  `handleMessage` before dispatch. The refusal messages are unchanged; the
  point is that a newly-added privileged command can no longer ship *ungated*
  by forgetting to paste the block -- authorization is now data, not a
  per-handler code path. The check runs before usage is recorded, so refused
  attempts no longer count toward command stats.
- **Merged the two usage-stats writers.** `touchLastSeen` and
  `bumpCommandCount` each did a full locked read-modify-write of the same
  `usage_stats` KV blob on every command (4 KV round-trips). Combined into one
  `recordCommand` doing a single read-modify-write (2 round-trips), which also
  removes the window where a bump and a touch could interleave.
- **Fixed misleading "extra argument" copy.** `/adduser 5 6` (and
  `/removeuser`, `/addadmin`, `/removeadmin`) aborts without acting, but the
  reply read as though it had proceeded with the first id. Reworded to state
  plainly that nothing was changed.
- **Normalized `access` on read.** `getAccess` now spreads over
  `DEFAULT_ACCESS`, so `adminIds`/`allowFrom`/`pending` are always present and
  the ~7 scattered `adminIds ?? []` / `if (!adminIds)` guards are gone.
- Admin panel command-usage list is derived from `COMMAND_HANDLERS` keys
  instead of a hand-maintained list (can't drift); `reserveBriefingDispatch`
  reuses `todayUTC()`; dropped now-unused `access` destructures.

### Fixed corrupted YAML in `daily-briefing.yml`

Two manual edits (`af1c8d0`, `ae65632`) had dropped the newline between three
steps' `if:` line and the following `env:`/`run:` key, merging them onto one
physical line (e.g. `if: ... == 'true'        env:`). That's invalid YAML --
every trigger of this workflow (cron, `daily-briefing-trigger` dispatch,
manual) failed before a single step could run, and CI's `actionlint` step
caught it on every subsequent push/PR. Restored the newlines/indentation only;
the conditions themselves (including the `steps.send.outcome == 'success'`
guard on "Record covered stories") are unchanged. Verified with `actionlint`
and a plain YAML parse.

### Capped `access.pending` independent of `MAX_USERS` (PR #48)

`MAX_USERS` only refuses new `/start` requests once the allowlist itself is
full -- it does nothing while `allowFrom` is nowhere near capacity. Since the
bot is publicly discoverable on Telegram, a flood of `/start` from distinct
senders could grow `access.pending` in the `BotState` DO without bound and
send the owner one "New access request" notification per sender, with no rate
limit. Added `MAX_PENDING` (50), enforced atomically inside `addPending` (same
check-then-write-in-one-DO-call pattern as `addAllowedUser`), so a flood past
the cap is refused before it's added to `pending` or notifies the owner.

### Added a technical specification doc (`docs/technical-spec.md`)

An interface/requirements-level companion to `docs/design.md`: scope and
non-goals, the full command contract with authorization invariants, the
`BotState` DO / KV / git-`state` data model, hard limits (`MAX_USERS`,
dispatch cooldown/cap, per-run LLM budget), NFRs, the three-layer daily
trigger, secrets/config, environments, and the test strategy. Where
`design.md` explains *why* the system is shaped the way it is, this specifies
*what* it must do so an implementation can be checked against it. Grounded in
the current code (v1.4.0); the two docs cross-link at the top.

### Pinned actionlint to a checksum-verified release in CI (PR #46)

The lint step in `.github/workflows/ci.yml` fetched the actionlint installer
from the upstream `main` branch and piped it straight into `bash` on every push
and PR -- unpinned and unverified, so a tampered or MITM'd upstream would run
arbitrary code in CI (highest blast radius on push to `main`, where the job
runs with the repo token in context). Replaced with a pinned release
(`v1.7.12`) downloaded from its tagged release URL and checked against the
published SHA256 (`sha256sum -c -`) before execution, so a swapped binary
aborts the job. Version bumps are now explicit edits to `ACTIONLINT_VERSION` +
`ACTIONLINT_SHA256`.

## [1.4.0] - 2026-07-13

### Serialized usage_stats DO methods with an explicit in-memory mutex (PR #44)

`bumpCommandCount`/`touchLastSeen`/`purgeUsageStats` read-modify-write the
`usage_stats` KV blob via `env.BOT_STATE` (`fetch()`), which Cloudflare's
automatic input/output gating does not serialize -- that gating only covers
`ctx.storage` calls. Two overlapping calls (e.g. `/forgetme`'s purge racing a
concurrent command's `touchLastSeen`) could interleave their get/put and
silently un-erase a just-purged entry. `withUsageLock` (a plain in-memory
promise chain, safe because a DO's JS execution is single-threaded) closes
that gap.

### Repo tooling

- Excluded markdown, then JS/MJS, from Prettier (`.prettierignore`) -- neither
  was ever prettier-clean, and Prettier's emphasis-style rewrites were
  churning docs. Added `.prettierrc` so the local formatting config is
  shared, and shared the project's Claude Code Stop hook (`npm test` gate)
  via `.claude/settings.json`.
- Silenced a shellcheck SC2016 false positive in `daily-briefing.yml` (#45).
- Committed the Worker Cron Trigger validation log (`docs/qa/`, PR #41).

### Addressed four open items from the design doc's limitations section

- **Delegated admin roles.** `/addadmin <id>` / `/removeadmin <id>` (owner-only,
  target must already be allowlisted) let the owner grant/revoke admin
  status. Admins get every owner-gated command (`/admin`, `/listusers`,
  `/adduser`, `/removeuser`, `/broadcast`, `/pending`, approve/deny
  callbacks) except managing admins themselves. Removing a user via
  `/removeuser` also revokes their admin status if they had it.
- **Corrected a doc inaccuracy, not a code gap.** The design doc claimed the
  30-user cap (`MAX_USERS`) wasn't enforced in code. On inspection it already
  was -- atomically in `BotState.addAllowedUser`, plus independently in
  `/start` and the callback-approval path -- and already covered by a test
  ("capacity cap holds"). No code change; corrected the doc.
- **Added `actionlint` to CI** (`.github/workflows/ci.yml`) to catch
  YAML/schema errors and shellcheck-level issues in workflow `run:` blocks,
  closing part of the "no automated coverage for the GitHub Actions
  workflows" gap. Execution-path testing of a full workflow run stays
  manual -- not worth chasing at this scale.
- **Generalized the Phase 16 re-benchmark mechanism** into a reusable one:
  `docs/qa/rebench-template.md` (was hardcoded to a single past change, named
  `PHASE16_BENCH`/"Phase 16 re-benchmark"). Renamed the trigger variable to
  `REBENCH` and the tracking issue to "Prompt re-benchmark — 5-run log" so it
  can be run after any future prompt change, not just growth pushes. The
  original `docs/qa/phase16-rebench-template.md` is kept as a historical
  record and now points to the new one.

### Added a system design doc

`docs/design.md` documents the deployed architecture as a reference for
future changes: the Worker/Actions split, the `BotState` Durable Object + KV
state model, command reference, secrets scoping, staging setup, and the
three-layer daily-trigger reliability mechanism (Cron Trigger primary,
GitHub schedule + watchdog as backups).

### Added a Cloudflare Cron Trigger as the primary daily-briefing trigger (issue #17)

GitHub Actions' `schedule` trigger for `daily-briefing.yml` (09:00 UTC) has
proven unreliable in practice: measured across every scheduled run from
2026-07-02 through 2026-07-13, actual fire time was 1h15m-3h49m late every
single time it fired at all, and it silently skipped firing entirely on
2026-07-08, 07-09, and 07-10. The watchdog (`daily-briefing-watchdog.yml`,
added after #17) has the identical failure mode -- also late 1-3.6h and also
silently skipped several of the same days -- since it relies on the same
`schedule` event. This matches GitHub's documented behavior: `schedule`
events are best-effort and specifically degrade under load at the top of
the hour.

The Worker already had a proven `repository_dispatch` path (`dispatchEvent`,
used by `/newbriefing` and `/broadcast`), so it gets a `scheduled` handler
that fires a `daily-briefing-trigger` dispatch, driven by a new Cloudflare
Cron Trigger (`worker/wrangler.toml`, 09:05 UTC -- Cloudflare's cron isn't
subject to GitHub's congestion). `daily-briefing.yml` now also listens for
`repository_dispatch: types: [daily-briefing-trigger]`. GitHub's own
`schedule` trigger and the watchdog's fallback dispatch stay in place as
redundant backups; the workflow's existing `last_briefing_at` idempotency
check makes it safe for more than one of the three to fire on the same day.

### Pinned briefing generation to Sonnet, then reverted back to Opus same day

`claude -p` calls in `daily-briefing.yml` and `on-demand-briefing.yml` never
passed `--model`, so generation silently ran on whatever the pinned Claude
Code CLI version's own default happened to be (Opus-tier) -- not a deliberate
choice, just an unset flag. Added `--model claude-sonnet-5` to both, for
lower cost per generation.

Same day, reverted both back to `--model claude-opus-4-8`: the first real
production run of `daily-briefing.yml` under Sonnet returned only 1 story
(vs. a typical 2-5), and a local side-by-side rerun of the identical
prompt/inputs on Opus returned 6 stories across all three sections. Two data
points in the same direction was enough to treat this as a real coverage
regression rather than noise, so `on-demand-briefing.yml` was reverted too
rather than leaving the two workflows on different models.

## [1.3.0] - 2026-07-11

### Re-tuned the daily briefing search fan-out after Phase 16 re-benchmark FAIL

The 5-run Phase 16 editorial re-benchmark (issue #15) came back FAIL: 2 of 5
real editions (2026-07-04, 2026-07-05) landed at only 2 items against the
prompt's own 4-item target, both stuck in the same narrow beat (AI
models/agents or a single labor-market trend). Root cause: `briefing-prompt.md`
only ran 4 generic searches up front and treated beat-diversifying queries
(funding/M&A, vendor/ATS product, workforce platforms) as an optional
last-resort fallback ("run up to 3 additional searches") that the model could
skip once it judged it had "enough." Two changes: (1) moved the two most
reliably orthogonal beats (funding round, ATS vendor product) into the
mandatory primary search set, run every time rather than only on shortfall;
(2) replaced the "up to 3" fallback cap with "run all of the following" plus a
richer category list (borrowed from `briefing-prompt-ondemand.md`'s existing,
more thorough fallback), and added explicit beat-diversity-over-volume
guidance so two items on the same underlying story no longer count as
covering two beats. Closed issue #15 and re-armed `PHASE16_BENCH` for a fresh
5-run window against the retuned prompt.

### Added a low-credit-balance precheck to catch a drained API key before generation runs

The daily briefing silently failed for several days (2026-07-06 through
2026-07-10) because `ANTHROPIC_API_KEY` ran out of credits -- nobody
noticed until asked to check the Actions tab. There's no Anthropic endpoint
to inspect remaining credit balance, so `scripts/check-credit-balance.mjs`
makes the cheapest possible real request (Haiku, `max_tokens: 1`) before
the multi-dollar WebSearch generation in both `daily-briefing.yml` and
`on-demand-briefing.yml`. On the specific "credit balance is too low"
error it sends one immediate, specific Telegram alert (owner, and the
requester too for on-demand) and fails the job right away instead of
burning the 2-attempt retry loop and 10-minute timeout on a call already
known to fail. The existing generic failure alerts skip this case so only
one message goes out per incident. This doesn't give advance warning
before the balance hits zero (no such signal exists via the API) -- it
converts a multi-day silent failure into a same-run alert.

### Fixed REL-2: subscriber-mirror write ordering could un-erase a removed user's send-list entry

`BotState.forgetUser`/`unsubscribe` committed the removal to Durable Object
storage, then mirrored the new subscriber list to KV as a separate write --
scripts/send-briefing.mjs reads only that KV mirror. A kill/eviction between
the two left an erased or unsubscribed user still on the KV list, with no
signal for the owner to retry, so they'd keep getting the daily briefing
after `/forgetme` promised otherwise. Reordered both methods to mirror to KV
*before* the DO storage commit -- a stale DO write self-heals on the user's
next command; a stale KV mirror wouldn't have, since nothing else re-checks
it. `subscribe()` is unaffected (a lagging mirror there just delays receiving
tomorrow's briefing, not a privacy issue). Added a call-order regression test
(verified it fails against the old ordering). Originally flagged as REL-2 in
`docs/qa/2026-07-02-phase9-reliability.md`, filed below.

### Filed four QA audit reports that were completed but never merged (Phase 9-12)

Found while cleaning up stale branches: `qa/phase9-reliability`,
`qa/phase10-performance` (plus its `test/perf-stress.mjs` harness),
`qa/phase11-security`, and `qa/phase12-code-quality` were written and
CI-passing back on 2026-07-02 but their branches were never merged. Phases
10-12's named findings (PERF-1/3, SEC-1/4) already got fixed independently by
later work under different issue numbers, so those three are filed as
historical record. Phase 9's REL-2 was still open -- fixed above.

## [1.2.0] - 2026-07-04

### Fixed usage_stats erasure race, story dedup, arg validation, and briefing header check (#29, #30, #31, #32)

Four more findings from the edge-case review. `purgeUsageStats`,
`bumpCommandCount`, and `touchLastSeen` are now `BotState` Durable Object
methods instead of free functions hitting KV directly, so all three
serialize through the singleton stub -- a concurrent command's
`touchLastSeen` write can no longer race a `/forgetme`/`/removeuser`
erasure and silently restore the just-purged entry (#31; the Worker-vs-CI
race against `scripts/sync-kv.mjs`'s direct KV write stays a known,
accepted limitation, same as before). Same-day story merges in
`update-recent-stories.mjs` now dedupe by normalized URL (`bulletUrlKey`/
`dedupeBullets`) instead of exact bullet text, so a reworded restate or a
second source domain for the same story collapses to one entry instead of
two (#30). `/adduser` and `/removeuser` now warn and no-op on extra
arguments instead of silently dropping them (#29). `isValidBriefing` only
accepts the header on the first non-empty line, closing the gap where a
refusal quoting the expected title format later in its text would pass
validation (#32).

### Added dispatch idempotency so a retried repository_dispatch can't double-fire (#28)

Another edge-case-review finding: `fetchWithRetry` retries the GitHub
`dispatches` POST on a 429/5xx/network error, but if GitHub actually
accepted the original request and only the response was lost, the retry
fired a second, distinct `repository_dispatch` for the same logical
action -- every subscriber getting a `/broadcast` message twice, or a
second $2 LLM generation for the same `/newbriefing` request. `dispatchEvent`
now stamps a `dispatch_id` (generated once per call, so retries of the same
call share it) into `client_payload`; both `broadcast.yml` and
`on-demand-briefing.yml` check it against KV before doing any real work and
skip a detected duplicate. Known limitation: `broadcast.yml` has no
concurrency group by design (AUD-3), so this isn't atomic against two
truly simultaneous duplicate runs -- it closes the realistic retry-after-
backoff case, not a sub-second race window.

### Fixed chunk() truncating or hanging on oversized/awkward HTML tags (#27, #37)

Two more findings from the edge-case review, both in the message-splitting
`chunk()` used before every Telegram send. (#27) The tag-balance backup only
backed the cut up before an unclosed tag when that tag started partway
through the slice; if a single tag's own content exceeded the chunk limit
(e.g. one bullet with an unusually long bold span or link), the tag started
at index 0 with nowhere earlier to back up to, and the naive cut could land
mid-tag. Now extends forward past the full close instead, even if that
pushes the one chunk past `limit` (still comfortably under Telegram's real
4096-char ceiling). (#37) Fixing that surfaced a related, more serious bug:
if a *dangling, not-yet-closed* tag-opening syntax (e.g. `<a href=`) sat at
index 0 -- possible when the tag's own attribute syntax holds the only
whitespace before the limit -- nothing corrected the cut at all, risking a
near-zero-progress slice that could hang the chunking loop. Restructured the
tag-safety check into two explicit phases (complete the tag syntax, then
close any open element) to cover both cases. Added regression tests for
each.

### Fixed link parser truncating URLs with parens (#26)

Another finding from the edge-case review: the Markdown link regex's URL
class was `[^\s)]+`, so any source URL containing a literal paren -- a
common shape for Wikipedia-style links, e.g. `.../wiki/Foo_(bar)` -- stopped
matching at the first `)`, truncating the href and leaving the rest as
stray literal text outside the closed anchor. Replaced the URL class with
alternating runs of "no space/paren" and one balanced `(...)` group, so a
single level of nested parens is captured as part of the URL -- covers every
real URL shape seen so far.

### Pin one run date per job to prevent UTC-midnight desync (#25)

The same edge-case review found that "today" was recomputed independently in
~7 places per job (`force-briefing-date.mjs`, `update-recent-stories.mjs`,
`build-recency-note.mjs`, `sync-kv.mjs`, `update-usage-stats.mjs`,
`send-briefing.mjs`, plus several `date -u` calls in the workflow YAMLs). A
generation run can take 10+ minutes, so a job straddling UTC midnight could
stamp the briefing title with one date while recording it in
`state/recent_stories.json` under a different one, silently breaking the
"don't repeat this story" guard. Both workflows now compute
`BRIEFING_DATE_ISO`/`BRIEFING_DATE_HUMAN` once at job start via `GITHUB_ENV`,
and every step/script reads that instead of calling `date -u`/`new Date()`
on its own (each script still falls back to computing fresh when run
standalone, so manual invocations are unaffected).

### Retry the state commit/push on rebase conflict or transient failure (#24)

A subagent edge-case review flagged that the "Commit updated state" step in
`daily-briefing.yml`/`on-demand-briefing.yml` had no retry around `git pull
--rebase && git push`: a rebase conflict or transient push failure aborted
the job *after* the briefing/on-demand response had already been delivered,
silently dropping that run's recent-stories/usage-stats update with no
recovery path. Both steps now retry the pull-rebase+push up to 3 times with
backoff, using `-X theirs` (safe here since the commit only ever touches
`state/`, so it's fine to always keep our freshly-generated data over
whatever a conflicting upstream commit did to the same lines — note
`rebase`'s `theirs`/`ours` meaning is the reverse of `merge`'s). If all
retries are exhausted, the step now exits with an explicit `::error::`
instead of a bare git failure, so the existing failure-alert steps correctly
notify that delivery succeeded but state wasn't persisted.

### Fixed two gaps in the story-dedup fix (same-day loss + cold start)

The user reported "Claude Tag" and a Microsoft Teams story repeating from a
2026-07-03 edition, even after the dedup fix (see above) merged. Two bugs:
(1) `scripts/update-recent-stories.mjs` *replaced* today's entry on every
run instead of merging, so multiple same-day editions (a daily run plus
on-demand runs) lost each other's stories from memory — fixed to merge
(dedupe by exact bullet text). (2) `state/recent_stories.json` only started
existing when the dedup PR merged, so it had zero memory of anything from
before that moment — backfilled it from the full git history of
`state/today_briefing.md` (2026-07-01 through today), unioning bullets per
calendar day. That backfill also surfaced a real cost risk: a single
heavy-testing day merged 60 bullets into one entry, and injecting that
unbounded into every future prompt would be thousands of extra tokens per
run — enough to risk re-triggering the `--max-budget-usd` overrun from
earlier today. Added `recentStoryBullets()` (shared/telegram.mjs), capping
the prompt-injected list to `MAX_RECENT_STORY_BULLETS` (20), keeping the
most recent ones; storage itself stays bounded only by the 14-day window and
will settle down naturally as today's heavy-testing entries age out.

### Fixed nested *italic* inside **bold** breaking Telegram formatting

A live send on 2026-07-04 reached Telegram with raw, unconverted Markdown
in one bullet — literal `**`/`*` characters instead of bold/italic. Cause:
`shared/telegram-markdown.mjs`'s bold regex (`\*\*([^*]+)\*\*`) required the
bold span to contain zero asterisks, so a case name italicized *inside* a
bold sentence (`**...the claims in *Mobley v. Workday* proceed**`, a real
generation) made the whole bold match fail and fall through as literal text.
Rewrote the tokenizer to match bold non-greedily up to the next `**` and to
recurse into its contents, so nested `*italic*` now renders as `<i>` instead
of breaking the enclosing `<b>`. `chunk()`'s tag-balance scan already handled
nesting correctly (it's a real stack, despite its comment claiming otherwise
— comment corrected) so no change was needed there.

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
