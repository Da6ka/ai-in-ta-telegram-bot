# AI-in-TA Telegram Bot — Technical Specification

Version: 1.4.0 · Status: describes the deployed system as of 2026-07-13

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
| `/subscribe`, `/unsubscribe`                                  | allowlisted    | Worker → DO      | Mutate `subscribers`                                                                |
| `/status`, `/help`                                            | allowlisted    | Worker           | Read-only                                                                           |
| `/privacy`, `/mydata`, `/forgetme`                            | allowlisted    | Worker → DO      | Data-subject rights over DO-held data                                               |
| `/admin`, `/pending`, `/listusers`, `/adduser`, `/removeuser` | owner or admin | Worker → DO      | Read/mutate allowlist                                                               |
| `/broadcast <msg>`                                            | owner or admin | Worker → Actions | Validate, then `repository_dispatch` → `broadcast.yml`                              |
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

### 3.3 Anthropic API (generation)

- Invoked as `claude -p <prompt>` from Actions, model **`claude-opus-4-8`**,
  `--allowedTools WebSearch`, `--max-budget-usd 2` per run.
- Prompts: [`briefing-prompt.md`](../briefing-prompt.md) (daily),
  [`briefing-prompt-ondemand.md`](../briefing-prompt-ondemand.md) (on-demand).
  Editorial rules (sourcing, no repeated domains, news-not-evergreen, 48-hour
  window) live in those prompts by design.

### 3.4 GitHub `repository_dispatch` (Worker → Actions)

- `daily-briefing-trigger` → `daily-briefing.yml`
- on-demand trigger → `on-demand-briefing.yml`
- broadcast trigger → `broadcast.yml`
- Auth: fine-grained PAT (`GITHUB_TOKEN` Worker secret), this repo only,
  `Contents: write`.

---

## 4. Data model

### 4.1 `BotState` Durable Object (source of truth)

Single instance. Logical fields:

```
access:
  ownerChatId: <int>            # singleton owner
  adminIds:    [<int>, ...]     # delegated admins
  allowFrom:   [<int>, ...]     # allowlist (length ≤ MAX_USERS)
  pending:     { <id>: {info, requestedAt} }
subscribers:   [<int>, ...]     # always includes owner
usage_stats:
  command_counts: { <command>: <int> }
  briefings_sent: <int>
  last_briefing_at: <YYYY-MM-DD>
  last_seen: { <chat_id>: <YYYY-MM-DD> }
today_briefing_md:   <string>
today_briefing_date: <YYYY-MM-DD>
```

Consistency: mutations to `allowFrom` / `subscribers` / admin sets MUST be
strongly-consistent read-modify-write inside the DO (KV's eventual consistency
would race concurrent `/subscribe` / approvals). `addAllowedUser` enforces
`MAX_USERS` atomically.

### 4.2 KV namespace `BOT_STATE` (read mirror)

Mirrors the fields above for cheap Worker reads (notably `/briefing`'s cached
copy and the subscriber list read by `send-briefing.mjs`). Written by the DO
and by `sync-kv.mjs`; never the authority.

### 4.3 Git-versioned `state/` (generation record)

`state/today_briefing.md`, `state/usage_stats.json`,
`state/recent_stories.json` — written by the generation workflow, committed to
`main`, useful for debugging what a given day produced. `last_briefing_at` here
is the idempotency marker.

---

## 5. Core flows & acceptance criteria

### 5.1 Daily scheduled send

1. Worker Cron Trigger (`5 9 * * *`, 09:05 UTC) fires `scheduled()` →
   `repository_dispatch: daily-briefing-trigger`.
2. `daily-briefing.yml`: idempotency check on `last_briefing_at`; if already
   today, **no-op**. Otherwise `claude -p briefing-prompt.md` → write
   `state/today_briefing.md`, bump `usage_stats`.
3. `send-briefing.mjs` reads live subscribers from KV, sends to each.
4. Workflow commits `state/` back to `main`.

**Accept:** exactly one briefing is delivered per calendar day even if two or
three triggers fire (Cron + GitHub schedule + watchdog). No subscriber receives
duplicates.

### 5.2 On-demand `/briefing`

Serve `today_briefing_md` from KV directly. **Accept:** sub-second reply, no
generation, works while a generation run is in flight.

### 5.3 On-demand `/newbriefing`

`repository_dispatch` → `on-demand-briefing.yml` → generate →
`sync-kv.mjs` writes result to KV. **Accept:** respects dispatch cooldown +
daily cap (§6.2); during cooldown the user still gets the cached copy rather
than an error.

### 5.4 Broadcast

`/broadcast <msg>` (owner/admin) → Worker validates → `broadcast.yml` →
`broadcast.mjs` paces + retries delivery on the runner, then reports to owner.
**Accept:** fan-out happens on the Actions runner, not the Worker (avoids the
per-invocation subrequest cap that silently dropped recipients past ~45).

---

## 6. Constraints & limits

| Limit                        | Value                                      | Enforced at                                                          |
| ---------------------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `MAX_USERS`                  | **30**                                     | `BotState.addAllowedUser` (atomic), `/start`, callback-approval path |
| Generation dispatch cooldown | **60 min** global (`DISPATCH_COOLDOWN_MS`) | Worker, before `/newbriefing` dispatch                               |
| Generation daily cap         | **3/day** (`DAILY_DISPATCH_CAP`)           | Worker                                                               |
| Per-run LLM spend            | **$2** (`--max-budget-usd`)                | Actions                                                              |
| Briefing model               | `claude-opus-4-8`                          | Actions                                                              |
| Briefing window              | last 48 hours                              | prompt                                                               |

The generation cooldown/cap are **global**, not per-user, because the result is
shared (one `today_briefing` for everyone).

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
  - access/subscription state) — as of 2026-07-13, 12 allowlisted / 4
    subscribed. Any future export/debug tooling must not dump raw user ids
    carelessly.
- **Observability:** Worker `console.log/error` persisted to Workers Logs
  (`[observability] enabled`), queryable via dashboard / `wrangler tail`.

---

## 8. Reliability & failure handling

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

  Layers 2 and 3 are both GitHub `schedule`, so they share its failure mode:
  a bad morning in GitHub's scheduler can take out the backup trigger and the
  watchdog meant to catch it. On 2026-07-16 layers 1 and 2 missed together
  (issue #61) — the Worker cron is best-effort too, so the redundancy is
  weaker than "primary + backup" implies.

- **Cloudflare-side heartbeat** (`briefingHeartbeat`, cron `0 12 * * *`):
  alerts the owner if KV's `today_briefing_date` ≠ today. Detection only — it
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

**Are the crons still registered on the live Worker?** Confirms config, not
firing — a deploy that dropped `[triggers]` shows up here:

```
GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/ai-in-ta-telegram-bot/schedules
```

Expect both `5 9 * * *` (briefing dispatch) and `0 12 * * *` (heartbeat).
`modified_on` tracks the last `wrangler deploy`, not the last fire.

**Did the cron actually fire?** This is the decisive one. A scheduled
invocation appears as a row at the cron's minute, so its _absence_ at 09:05 is
positive evidence the Worker never ran — which rules out a failed dispatch,
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
(`5b93a48b…`), distinct webhook secret. `wrangler deploy` targets prod;
`--env staging` is required for staging.

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
</content>

</invoke>
