# AI-in-TA Telegram Bot — Technical Specification

Version: 1.9.0 · Status: describes the deployed system as of 2026-09-02

> This is the interface/requirements-level companion to [`design.md`](./design.md).
> `design.md` explains _why_ the system is shaped the way it is (narrative,
> rationale, history); this document specifies _what_ it must do — scope,
> contracts, data model, limits, and acceptance criteria — in a form you can
> check an implementation against.

---

## 1. Purpose & scope

### 1.1 Purpose

A private Telegram bot that researches and delivers a **daily briefing on AI in
recruitment** (news, tools, research from the last 48 hours), plus on-demand
retrieval, subscription management, and owner/admin tooling.

### 1.2 In scope

- Scheduled daily generation and delivery of one briefing to all subscribers.
- On-demand briefing retrieval (cached and freshly generated).
- Allowlist-gated access with a request/approve flow.
- Subscription management (opt in / out of the daily send).
- Owner + delegated-admin tooling (stats, user management, broadcast).
- Data-subject rights (view / erase stored personal data).

### 1.3 Out of scope (non-goals)

- Free-form chat with Claude; group-chat operation.
- Multi-tenant / public access — single operator, hard-capped at 30 users.
- Real-time news — the briefing window is a once-daily 48-hour lookback.

---

## 2. System context

Two independent runtimes divide responsibility along a **latency boundary**:

| Runtime                                       | Owns                                                                     | Why here                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Cloudflare Worker** (`worker/src/index.js`) | Telegram webhook, all live commands, daily cron trigger                  | Must answer Telegram in milliseconds; always-on, no local machine                     |
| **GitHub Actions** (`.github/workflows/`)     | Briefing generation (`claude -p` + WebSearch), fan-out delivery, KV sync | Generation runs tens of seconds to minutes — a poor fit for a request/response Worker |

```
Telegram  ──webhook──▶  Cloudflare Worker ──repository_dispatch──▶  GitHub Actions
   ▲                        │  │                                        │
   │                        │  └─ BOT_DO (Durable Object) ── source of truth
   └──── delivery ──────────┘     BOT_STATE (KV) ── read mirror ◀─sync-kv─┘
        (send-briefing / broadcast on the runner)
```

State authority: the **`BotState` Durable Object is the source of truth**;
Cloudflare KV is a read-optimized mirror; `state/*` in git is the
generation-side record. `scripts/sync-kv.mjs` is the one-way bridge
(generation → KV).

---

## 3. External interfaces

### 3.1 Telegram webhook (inbound)

- **Transport:** HTTPS POST from Telegram to the Worker URL.
- **Auth:** every request MUST carry `X-Telegram-Bot-Api-Secret-Token`
  matching `TELEGRAM_WEBHOOK_SECRET`. Mismatches are rejected without side
  effects.
- **Payload:** standard Telegram `Update` (message commands + callback queries
  for inline approve/deny buttons).

### 3.2 Command contract

| Command                                                       | Access         | Handler path     | Effect                                                                              |
| ------------------------------------------------------------- | -------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `/start`                                                      | anyone         | Worker → DO      | Add sender to `pending`; enforce `MAX_USERS`                                        |
| `/briefing`                                                   | allowlisted    | Worker → KV      | Serve cached `today_briefing_md`, no generation                                     |
| `/newbriefing`                                                | allowlisted    | Worker → Actions | `repository_dispatch` → `on-demand-briefing.yml`; subject to dispatch limits (§6.2) |
| `/ask <question>`                                             | allowlisted    | Worker → Actions | Validate + rate-limit, then `repository_dispatch` → `ask.yml`; read-only query over `wiki/` (own `ask_rate` limits) |
| `/subscribe`, `/unsubscribe`                                  | allowlisted    | Worker → DO      | Mutate `subscribers`                                                                |
| `/status`, `/help`                                            | allowlisted    | Worker           | Read-only                                                                           |
| `/privacy`, `/mydata`, `/forgetme`                            | allowlisted    | Worker → DO      | Data-subject rights over DO-held data                                               |
| `/admin`, `/pending`, `/listusers`, `/adduser`, `/removeuser` | owner or admin | Worker → DO      | Read/mutate allowlist                                                               |
| `/broadcast <msg>`                                            | owner or admin | Worker → Actions | Validate, then `repository_dispatch` → `broadcast.yml`                              |
| `/pause [msg]`, `/resume [msg]`                               | owner or admin | Worker → KV/DO   | Set/clear the `maintenance` flag; optional `msg` fanned out over the broadcast path (§5.5) |
| `/addadmin <id>`, `/removeadmin <id>`                         | **owner only** | Worker → DO      | Delegate/revoke admin; target must already be allowlisted                           |

**Authorization rules (invariants):**

- Owner-gated commands pass `isOwnerOrAdmin()`: sender id == `access.ownerChatId`
  **or** sender id ∈ `access.adminIds`.
- Admin management (`/addadmin`, `/removeadmin`) is keyed to `ownerChatId`
  **alone** — an admin cannot escalate their own privilege or demote a peer.
- The owner cannot be removed (`/removeuser`), cannot unsubscribe, and cannot
  erase their own data — these check `ownerChatId` directly.
- Removing a user (`/removeuser` or their own `/forgetme`) also revokes any
  admin status they held.
- **Maintenance flag (`/pause`):** while `maintenance` is set, every paid path
  is withheld for **everyone, admins included** — `/newbriefing`, `/ask`, and
  `/briefing`'s generate-fallback short-circuit through the single guard in
  `requestGeneration()`, and `scheduled()` dispatches no daily briefing and runs
  no heartbeat, so a pause means zero Anthropic spend. Non-admins get a notice
  for every command except `/briefing` (serves the last saved edition) and the
  data-subject-rights commands, which stay reachable. `/resume` clears the flag.
  The flag cannot reach GitHub's own backup `schedule` on `daily-briefing.yml`;
  fully stopping the digest also requires disabling that workflow.

### 3.3 Anthropic API

Always from Actions, never from the Worker. Three invocations with
deliberately different models, tools, and budgets — the tool allowlist is the
enforcement, not just the prompt:

| Job | Model | How | Tools | Cost ceiling |
| --- | --- | --- | --- | --- |
| Briefing generation | `claude-opus-4-8` | `scripts/generate-briefing.mjs` (Messages API) | server-side `web_search` | pre-emptive: `BRIEFING_MAX_SEARCHES`, `max_tokens`, paused-turn budget check |
| Wiki ingest (daily only) | `claude-haiku-4-5-20251001` | `claude -p` | `Read Write Edit Glob Grep` | `--max-budget-usd 1` |
| `/ask` answer | `claude-sonnet-5` | `claude -p` | `Read Grep Glob` | `--max-budget-usd 1` |

Generation moved off `claude -p` on 2026-08-28. The agent loop carried every
web-search result forward in full through every later turn, so input tokens
grew with the square of the research — around 90% of what the bot cost to run.
One direct request does the same research inside a single server-side turn.
The two ceilings are not interchangeable: `--max-budget-usd` was enforced by
the CLI *during* a run, while the generator's limits are set before it starts
and its final total only warns, because by the time a completed response can
be priced the money is already spent. Every run appends what it cost to
`state/cost_log.jsonl`.

- Prompts: [`briefing-prompt-curated.md`](../briefing-prompt-curated.md)
  (daily — stories supplied, no search tool),
  [`briefing-prompt.md`](../briefing-prompt.md) (the model-searches variant,
  now A/B only),
  [`briefing-prompt-ondemand.md`](../briefing-prompt-ondemand.md) (on-demand),
  [`wiki-ingest-prompt.md`](../wiki-ingest-prompt.md) (ingest),
  [`ask-prompt.md`](../ask-prompt.md) (`/ask`). Editorial rules (sourcing, no
  repeated domains, news-not-evergreen, 48-hour window) live in those prompts
  by design.
- **Only the briefing gets `WebSearch`.** The ingest and `/ask` are confined to
  what the bot has already published; withholding the tool is what makes that a
  guarantee rather than an instruction. `/ask` additionally gets no write tools,
  so a query can never mutate the wiki.

### 3.4 GitHub `repository_dispatch` (Worker → Actions)

- `daily-briefing-trigger` → `daily-briefing.yml`
- on-demand trigger → `on-demand-briefing.yml`
- broadcast trigger → `broadcast.yml`
- `ask` → `ask.yml` (payload carries `chat_id` **and the question text** — the
  job cannot answer a hashed question; see §7 for what that means for retention)
- Auth: fine-grained PAT (`GITHUB_TOKEN` Worker secret), this repo only,
  `Contents: write`.

---

## 4. Data model

### 4.1 `BotState` Durable Object (source of truth)

Single instance, DO storage only. These five keys and no others — the DO is the
authority for *access and coordination* state, not for briefing content, and
never for message or question text:

```
access:
  ownerChatId: <int>            # singleton owner
  adminIds:    [<int>, ...]     # delegated admins
  allowFrom:   [<int>, ...]     # allowlist (length ≤ MAX_USERS)
  pending:     { <id>: {info, requestedAt} }
subscribers:   [<int>, ...]     # always includes owner
briefing_rate:                  # generation rate limiting (§6.2)
  lastDispatchAt: <epoch_ms>    # global, drives the cooldown
  date:           <YYYY-MM-DD>  # UTC day the counters below belong to
  counts:         { <id>: <int> }  # per-user daily cap
  total:          <int>         # global daily cap
ask_rate:                       # /ask rate limiting (§6.3) -- same shape as
  lastDispatchAt: <epoch_ms>    # briefing_rate, deliberately separate counters
  date:           <YYYY-MM-DD>  # so questions and briefings never draw down
  counts:         { <id>: <int> }  # each other's allowance. No question text.
  total:          <int>
seen_updates:  [<int>, ...]     # capped ring of handled Telegram update_ids,
                                # so a Telegram redelivery can't re-run a
                                # non-idempotent command (e.g. /broadcast)
```

Consistency: mutations to `allowFrom` / `subscribers` / admin sets MUST be
strongly-consistent read-modify-write inside the DO (KV's eventual consistency
would race concurrent `/subscribe` / approvals). `addAllowedUser` enforces
`MAX_USERS` atomically.

### 4.2 KV namespace `BOT_STATE`

Two distinct roles, easily confused:

**Read mirror of DO state.** `access` and `subscribers` are mirrored here for
cheap Worker reads and for `send-briefing.mjs` / `broadcast.mjs` on the runner.
The DO remains the authority; these are re-mirrored before each daily send (#49).

**KV-resident state** (not in the DO — written by `sync-kv.mjs` from the
generation side, and by the DO's usage writers):

```
today_briefing_md:   <string>
today_briefing_date: <YYYY-MM-DD>  # an edition is CACHED (daily OR on-demand)
last_delivered_date: <YYYY-MM-DD>  # the daily send REACHED SUBSCRIBERS (§8)
usage_stats:
  command_counts: { <command>: <int> }
  briefings_sent: <int>
  last_briefing_at: <YYYY-MM-DD>
  last_seen: { <chat_id>: <YYYY-MM-DD> }
  usernames: { <chat_id>: <telegram handle, no @> }  # pruned in lockstep with last_seen
```

`today_briefing_date` and `last_delivered_date` are **not** interchangeable: an
on-demand `/newbriefing` writes the first while delivering to one requester, and
only the daily send writes the second. §8's heartbeat depends on that split.

Note `usage_stats.last_briefing_at` here is the KV copy, written by `sync-kv.mjs`
on **both** the daily and on-demand paths. It is not the idempotency marker —
that is the git-versioned copy in §4.3, which only the daily workflow advances.

**`blocked_pending`** — ids the send pipeline found permanently unreachable
(Telegram `403`), written by the runner and drained by the Worker's daily
`scheduled` handler through the DO's `unsubscribe()` before the re-mirror. It
exists because the two runtimes each hold half the problem: only the runner
sees the 403, only the DO can make a prune stick (§8).

### 4.3 Git-versioned `state/` (generation record)

`state/today_briefing.md`, `state/usage_stats.json`,
`state/recent_stories.json` — written by the generation workflow, committed to
`main`, useful for debugging what a given day produced. `last_briefing_at` here
is the idempotency marker.

---

## 5. Core flows & acceptance criteria

### 5.1 Daily scheduled send

1. Worker Cron Trigger (`5 9 * * 1-5`, 09:05 UTC Mon-Fri) fires `scheduled()` →
   `repository_dispatch: daily-briefing-trigger`.
2. `daily-briefing.yml`: idempotency check on `last_briefing_at`; if already
   today, **no-op**. Otherwise `fetch-news.mjs` → candidate stories →
   `generate-briefing.mjs briefing-prompt-curated.md` → write
   `state/today_briefing.md`.
3. **Freshness & content gate:** the edition MUST be dated today AND carry at
   least `MIN_BRIEFING_ITEMS` (**2**) linked stories. A rejected edition is not
   sent, does not bump `usage_stats`, and deliberately leaves `last_briefing_at`
   un-advanced so the day stays retryable; the owner is alerted instead.
4. `send-briefing.mjs` reads live subscribers from KV, sends to each; then
   `usage_stats` is bumped and covered stories recorded.
5. Workflow commits `state/` back to `main`.

**Accept:** exactly one briefing is delivered per calendar day even if two or
three triggers fire (Cron + GitHub schedule + watchdog). No subscriber receives
duplicates. A stale or thin edition is never delivered, and never marks the day
done.

### 5.2 On-demand `/briefing`

Serve `today_briefing_md` from KV directly. **Accept:** sub-second reply, no
generation, works while a generation run is in flight.

### 5.3 On-demand `/newbriefing`

`repository_dispatch` → `on-demand-briefing.yml` → generate →
`sync-kv.mjs` writes result to KV. **Accept:** respects dispatch cooldown +
daily cap (§6.2); during cooldown the user still gets the cached copy rather
than an error.

### 5.4 `/ask` (query the wiki)

`/ask <question>` → Worker validates (3–300 chars) and reserves an `ask_rate`
slot → `repository_dispatch` (`ask`) → `ask.yml` reads the question from the
runner's event file, builds the prompt, and runs a read-only `claude -p` over
`wiki/` → `send-answer.mjs` delivers to the requester alone. **Accept:** the
answer cites dated, linked claims from `wiki/` or says the corpus doesn't cover
it; never web content; never a broadcast; the wiki is not mutated; an ask is not
blocked by a briefing generation (separate concurrency group).

### 5.5 Broadcast

`/broadcast <msg>` (owner/admin) → Worker validates → `broadcast.yml` →
`broadcast.mjs` paces + retries delivery on the runner, then reports to owner.
**Accept:** fan-out happens on the Actions runner, not the Worker (avoids the
per-invocation subrequest cap that silently dropped recipients past ~45).

---

## 6. Constraints & limits

### 6.1 Enforced limits

| Limit                        | Value                                      | Enforced at                                                          |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `MAX_USERS`                  | **30**                                            | `BotState.addAllowedUser` (atomic), `/start`, callback-approval path |
| `MAX_PENDING`                | **50**                                            | Worker, on `/start` (capped independently of `MAX_USERS`)           |
| Generation dispatch cooldown | **60 min**, **5 min** for the owner               | Worker, before `/newbriefing` dispatch                              |
| Generation daily cap         | **2/day per user** (`DAILY_DISPATCH_CAP`)         | Worker (`briefing_rate.counts`)                                     |
| Generation daily cap, shared | **2/day total** (`GLOBAL_DAILY_DISPATCH_CAP`)     | Worker (`briefing_rate.total`)                                      |
| `/ask` cooldown              | **30 s** (`ASK_COOLDOWN_MS`)                      | Worker, before `ask` dispatch                                       |
| `/ask` daily cap             | **10/day per user** (`ASK_DAILY_CAP`)             | Worker (`ask_rate.counts`)                                          |
| `/ask` daily cap, shared     | **40/day total** (`ASK_GLOBAL_DAILY_CAP`)         | Worker (`ask_rate.total`)                                           |
| `/ask` question length       | **3–300 chars**                                   | Worker, before dispatch                                             |
| Per-run LLM spend            | briefing: pre-emptive caps, ~**$1.5** measured; **$1** ingest, **$1** `/ask` | Actions                                                 |
| Models                       | see §3.3                                          | Actions                                                             |
| Briefing window              | last 48 hours                                     | prompt                                                              |

### 6.2 How the generation limits compose

Three limits with three different jobs — they are independent, and the strictest
one wins:

- **Cooldown (global, role-dependent).** One `lastDispatchAt` shared by everyone,
  because the result is shared (one `today_briefing` for all). The owner's window
  is 5 min rather than 60 so on-demand refreshes aren't blocked for an hour.
- **Per-user daily cap.** Bounds *hogging*, not spend: it stops one user
  hammering `/newbriefing` all day. Each user has their own 3, so this alone does
  **not** bound total cost — it scales with the allowlist.
- **Global daily cap.** The actual cost ceiling, since every dispatch is a paid
  Actions + Claude run. Without it the only real bound was the cooldown, at ~24
  dispatches/day.

A user refused by any of the three is served the cached edition where one exists,
never a bare error, and the daily scheduled send is unaffected by all three.

### 6.3 Why `/ask` has its own counters

`ask_rate` deliberately mirrors `briefing_rate`'s shape while staying a separate
key. A briefing generation is a paid WebSearch agent loop under a $4 cap whose
output is *shared* — one `today_briefing` for everyone — which is why its
cooldown is global and its caps are tight. An ask is a grep over `wiki/` with a
private, single-recipient answer. Sharing one counter would let a few questions
consume a user's briefing allowance for the day: the wrong resource spent on the
wrong thing. Hence 10/day and 30 s rather than 3/day and 60 min, and no owner
cooldown exception — 30 s is already short enough that shaving it buys nothing.

Unlike the generation limits, a refused ask has no cached fallback to serve —
there is no such thing as a stale answer to a question nobody asked — so it
returns a message naming the limit and when it resets.

---

## 7. Non-functional requirements

- **Availability:** live commands independent of any personal machine; the
  daily send survives a single trigger failing (three-layer trigger, §8).
- **Latency:** `/briefing` and DO-backed commands answer in milliseconds;
  slow generation never blocks a live command.
- **Security:** allowlist-gated (no public access); webhook secret-token
  validated on every request; least-privilege per credential (§9);
  channel-message content is data, never authorization — access is enforced by
  `chat_id` checks and cannot be overridden by message text.
- **Privacy:** data-subject commands (`/privacy`, `/mydata`, `/forgetme`) are
  first-class. The allowlist holds real third-party personal data (Telegram id
  - access/subscription state) — as of 2026-07-16, 5 subscribed. Any future
    export/debug tooling must not dump raw user ids
    carelessly.
- **Question retention (`/ask`):** a question is the first free text a user
  writes that the bot has to move through its own machinery, and it is never
  persisted in readable form. The Worker logs `sha256(question)` truncated to
  16 hex plus the length — enough to correlate a failure report, useless as a
  record of what someone asked. Nothing question-shaped reaches KV or the DO,
  so `/mydata` has nothing to show and `/forgetme` has nothing extra to erase.
  The plaintext exists in exactly one place: the `repository_dispatch` payload
  in the run's event context, which ages out on GitHub's Actions retention.
  It reaches the job via `GITHUB_EVENT_PATH`, never as step `env:` — Actions
  prints every step's env block into the run log, which leaked a question once
  (run 32394955358) before this was tightened.
- **Observability:** Worker `console.log/error` persisted to Workers Logs
  (`[observability] enabled`), queryable via dashboard / `wrangler tail`.

---

## 8. Reliability & failure handling

- **Blocked subscribers self-prune:** a `403` from Telegram is permanent (the
  user blocked the bot, or deactivated). The send scripts queue those ids in
  KV's `blocked_pending`; the daily `scheduled` handler unsubscribes them via
  the DO, then clears the queue, then re-mirrors. Order matters: the re-mirror
  rewrites KV from the DO, so a prune applied to KV alone would be undone the
  next morning. Best-effort throughout — a failed prune logs and never blocks
  the dispatch. Unsubscribe only; allowlist access is retained, since a block
  is not an erasure request.
- **Idempotency:** `last_briefing_at` prevents a duplicate send when
  `daily-briefing.yml` fires more than once in a day.
- **Concurrency:** a shared `briefing-generation` concurrency group means a
  losing racer no-ops rather than double-sends.
- **Three-layer daily trigger:**
  1. Worker Cron Trigger, 09:05 UTC — **primary** (PR #43).
  2. GitHub `schedule`, 09:00 UTC — backup (documented best-effort; observed
     1–4h late or skipped, issue #17).
  3. `daily-briefing-watchdog.yml`, 10:30 UTC — re-dispatches + alerts owner
     (`send-alert.mjs`) if `last_briefing_at` ≠ today.

  All three run **Mon-Fri only** (2026-08-21). Saturday and Sunday were ~28% of
  all generations and the largest single line in running cost; the watchdog and
  the Worker heartbeat follow the same days, since on a day with no scheduled
  briefing they would report a miss that isn't one. On-demand `/newbriefing`
  is unaffected and still works every day.

  Layers 2 and 3 are both GitHub `schedule`, so they share its failure mode:
  a bad morning in GitHub's scheduler can take out the backup trigger and the
  watchdog meant to catch it. On 2026-07-16 layers 1 and 2 missed together
  (issue #61) — the Worker cron is best-effort too, so the redundancy is
  weaker than "primary + backup" implies.

- **Cloudflare-side heartbeat** (`briefingHeartbeat`, cron `0 12 * * *`):
  alerts the owner if KV's `last_delivered_date` ≠ today. It reads
  `last_delivered_date` and **not** `today_briefing_date`: the latter only means
  an edition is cached, which an on-demand `/newbriefing` sets while delivering
  to exactly one requester — reading it would silence the alert on a day when
  subscribers got nothing. `last_delivered_date` is written solely by
  `daily-briefing.yml`'s KV sync (`MARK_DELIVERED`), a step that is skipped
  unless the send succeeded. Detection only — it
  does **not** dispatch a run. Its purpose is the account-wide Actions failure
  (billing hold, outage) that every in-Actions guard above would miss, since it
  runs on Cloudflare. It is the only layer outside GitHub's scheduler.
- **Broadcast fan-out** runs on the runner to avoid the Worker subrequest cap.

### 8.1 Diagnosing a missed daily trigger

When no briefing has gone out and `state/usage_stats.json` still shows a
`last_briefing_at` earlier than today, the first question is which layer failed:
the Worker cron never fired, or it fired and its dispatch to Actions failed.
These two calls separate those cases. Both need the personal Cloudflare account
(`da6ka.iv@gmail.com`) — see §10; the Valiotti account is empty and will read as
a false "all clear". The bearer token below is the wrangler OAuth token from
`~/.wrangler/config/default.toml`.

**Is the live Worker running the commit you think it is?** No credentials
needed, and it is the cheapest question to answer first — a change that was
merged but never deployed looks exactly like a change that does not work:

```
node scripts/check-deployed.mjs
```

`GET /status` returns `gitSha` plus the caps, cooldowns, heartbeat cron and
retention window the running bundle is enforcing, read from the same constants
the request path uses. The script does the comparison, because the obvious one
is wrong: `deploy-worker.yml` is path-scoped, so a docs or `state/` commit
ships nothing and leaves `gitSha` behind `main` correctly — and `state/` is
pushed every weekday by the briefing, which makes that the normal case. The
right comparison is against the last commit touching the deploy paths, which
the script reads out of the workflow rather than keeping a copy of — GitHub
evaluates `paths:` as literal YAML at trigger time, so the workflow has to be
the source, and deriving from it is the only way to have exactly one.
`unknown` means the last deploy was manual rather than from CI.

**Are the crons still registered on the live Worker?** Confirms config, not
firing — a deploy that dropped `[triggers]` shows up here:

```
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/ai-in-ta-telegram-bot/schedules
```

Expect both `5 9 * * 1-5` (briefing dispatch) and `0 12 * * 1-5` (heartbeat).
`modified_on` tracks the last `wrangler deploy`, not the last fire.

**Did the cron actually fire?** This is the decisive one. A scheduled
invocation appears as a row at the cron's minute, so its _absence_ at 09:05 on a
weekday is positive evidence the Worker never ran (on a Saturday or Sunday the
absence is the schedule working as intended) — which rules out a failed dispatch,
an expired `GITHUB_TOKEN`, and anything else Worker-side:

```
POST https://api.cloudflare.com/client/v4/graphql

query {
  viewer {
    accounts(filter: {accountTag: "{account_id}"}) {
      workersInvocationsAdaptive(
        limit: 100,
        filter: {scriptName: "ai-in-ta-telegram-bot", datetime_geq: "YYYY-MM-DDT00:00:00Z"},
        orderBy: [datetimeMinute_DESC]
      ) {
        sum { requests errors }
        dimensions { datetimeMinute scriptName status }
      }
    }
  }
}
```

Compare the 09:05 row against the days either side; webhook traffic at other
minutes confirms the Worker itself is healthy and isolates the miss to the cron.

The dashboard's own observability query endpoint
(`/workers/observability/telemetry/query`) returns 403 under the wrangler OAuth
token, which is why the GraphQL dataset above is the practical route.

Recovery is `gh workflow run daily-briefing.yml`; the idempotency check and the
`briefing-generation` concurrency group make that safe even if a delayed trigger
lands mid-run. First seen 2026-07-16, when the Worker cron and the GitHub
`schedule` both missed the same morning (issue #61).

---

## 9. Configuration & secrets

| Credential                             | Held by                     | Least-privilege scope                               |
| -------------------------------------- | --------------------------- | --------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                   | repo secret + Worker secret | full bot control (rotate via @BotFather)            |
| `TELEGRAM_WEBHOOK_SECRET`              | Worker secret               | validates inbound webhook                           |
| `GITHUB_TOKEN` (Worker→Actions)        | Worker secret               | fine-grained PAT, this repo only, `Contents: write` |
| `ANTHROPIC_API_KEY`                    | repo secret                 | spend-capped workspace key                          |
| `CF_API_TOKEN`                         | repo secret                 | `Workers KV Storage: Edit` only                     |
| `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` | repo secret                 | identifiers (secrets for convenience)               |
| `OWNER_CHAT_ID`                        | repo **variable**           | not sensitive (owner's own Telegram id)             |

Bindings (`worker/wrangler.toml`): KV `BOT_STATE`
(`id 4d433b91…`), Durable Object `BOT_DO` → class `BotState` (migration `v1`),
var `GITHUB_REPO = Da6ka/ai-in-ta-telegram-bot`, crons `5 9 * * *` (briefing
dispatch) and `0 12 * * *` (heartbeat, §8).

Rotate on any suspected leak and at least annually; after rotation, trigger
`daily-briefing.yml` manually to confirm generate → send → KV sync still pass.

---

## 10. Environments

Production and **staging** are fully isolated: distinct Worker
(`ai-in-ta-telegram-bot` vs `-staging`), distinct bot, distinct KV namespace
(`5b93a48b…`), distinct webhook secret. Prod ships from CI (§11); a local
`wrangler deploy` still targets prod and `--env staging` is required for
staging. Staging has no CI path — deploy it by hand.

A manual deploy passes no `GIT_SHA`, so `/status` reports `unknown` afterwards.
That is deliberate: it means "something outside CI last wrote this Worker", and
the next push to `main` under `worker/**` puts it back.

**Known gotcha:** the staging DO migrates seed data from KV only on first
touch. Re-seeding requires a two-step migration (remove binding +
`deleted_classes`, redeploy, restore binding + `new_sqlite_classes` at a new
tag) because Cloudflare blocks deleting a DO class while its binding exists.
Staging is at migration tag **v3** for this reason; prod stays at **v1**.

---

## 11. Test & verification strategy

- **Unit:** `test/worker.behavior.test.mjs` (incl. "capacity cap holds"),
  `shared/*.test.mjs` (Telegram API wrapper, MarkdownV2 escaping).
- **Perf:** `test/perf-stress.mjs`.
- **CI:** `.github/workflows/ci.yml` runs the test suite + `actionlint`
  (pinned to a checksum-verified release) over every workflow file.
- **Deploy:** `.github/workflows/deploy-worker.yml` ships the Worker on every
  push to `main` under `worker/**` or `shared/**`. It re-runs the tests (ci.yml
  runs alongside it, not before it), deploys with the commit SHA passed in as
  `GIT_SHA`, then polls `GET /status` until the live Worker reports that SHA.
  A green run means main is serving, not that an upload was accepted.
- **Workflow execution paths** are manually verified (inherent GitHub Actions
  gap); the meaningful logic lives in `.mjs` scripts with their own unit tests.
- **Manual cutover gate:** send synthetic Telegram updates (with the secret
  header) to the deployed Worker and confirm replies + KV state **before**
  pointing the live webhook at it — `setWebhook` is a silent all-or-nothing
  switch.
- **Prompt re-benchmarking:** run `docs/qa/rebench-template.md` (gated by the
  `REBENCH` repo variable) after any change to the briefing prompts.

---

## 12. Open items / future considerations

- Approaching the 30-user cap: admin tooling (`/pending`, `/adduser`,
  `/listusers`) is now worth exercising rather than treating as speculative.
- If the user base grows further, owner/admin management may need to move from
  "read a Telegram list" to a lightweight admin web view.
- The daily and on-demand generation paths are near-duplicates
(`daily-briefing.yml` vs `on-demand-briefing.yml` + `sync-kv.mjs`); kept
separate today for simplicity, could converge if the prompts diverge further.
- `/ask` retrieval is grep over `wiki/` inside the Actions checkout, which is
  right while the corpus is ~64k tokens. Revisit at roughly 100k tokens (about
  two years at current volume) or ~100 pages — and revisit with a *measured*
  recall problem, not a thin answer, which at this size is a synthesis problem
  rather than a retrieval one. A vector store buys nothing before then.
- `/ask` answers are single-shot: no conversation state, so no follow-ups.
  That is a privacy choice as much as a scope one — threading means storing
  questions, which §7 rules out.
</content>

</invoke>
