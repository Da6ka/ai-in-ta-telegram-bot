# AI-in-TA Telegram Bot — Design Doc

Status: describes the system as deployed (2026-07-13). Not a proposal — this
documents what's live, as a reference for future changes.

---

Context and motivation
---

**Problem.** Dasha wants a low-effort way to stay current on AI-in-recruitment
news without manually searching every day.

**Solution.** A private Telegram bot that researches and writes a daily
briefing (via `claude -p` + web search) and pushes it to subscribers every
morning, plus on-demand commands for pulling a fresh copy, subscribing, and
basic admin.

**Goals**

- Zero-touch daily delivery — no laptop or long-running process required.
- Sub-second response for live commands (`/briefing`, `/subscribe`, etc.),
  independent of the (slow, `claude -p`-driven) generation step.
- Safe to leave running unattended: allowlist-gated, capped population,
  auditable secrets, alerting on failure.

**Non-goals**

- Free-form chat with Claude, or group chat support — briefing delivery only.
- Multi-tenant / public bot — single operator, hard cap of 30 users.
- Real-time news (briefing window is the last 48 hours, generated once daily).

---

Architecture overview
---

Two independent runtimes own different halves of the system:

```
GitHub Actions (scheduled + dispatched)       Cloudflare Worker (webhook + cron, 24/7)
   │                                              │
   │ daily-briefing.yml, triggered by:            │ scheduled() @ 09:05 UTC (PRIMARY)
   │  - Worker's Cron Trigger (primary, 09:05)     │  → repository_dispatch
   │  - GitHub schedule (backup, 09:00, often      │    'daily-briefing-trigger'
   │    late/skipped — issue #17)                 │
   │  - watchdog fallback (backup, 10:30)          │ fetch() — Telegram webhook
   │  1. claude -p + briefing-prompt.md            │  /briefing        → serve
   │     → state/today_briefing.md                │                      cached copy from KV
   │  2. send-briefing.mjs → all subscribers       │  /newbriefing,
   │  3. commit state/ back to repo                │  /broadcast       → repository_dispatch
   │                                                │                      to Actions
   │ daily-briefing-watchdog.yml (10:30 UTC cron)   │  everything else  → read/write
   │  checks state/usage_stats.json;                │                      BotState DO
   │  re-dispatches daily-briefing.yml if missed    │
   │                                                │
   │ on-demand-briefing.yml, broadcast.yml           │
   │  (repository_dispatch targets)                 │
   ▼                                                ▼
        state/ (committed to git)          BOT_STATE KV  ◀──sync-kv.mjs── Actions
                                            BotState Durable Object (source of truth)
                                                 │
                                                 ▼
                                          Telegram subscribers
```

Why two runtimes instead of one: briefing _generation_ needs `claude -p`
running for tens of seconds to minutes (web search + composition), which is a
poor fit for a Worker's request/response model. Live commands need to answer
Telegram's webhook in milliseconds, which is a poor fit for a GitHub Actions
job (cold start, queuing). Splitting them means a slow generation run can
never make `/briefing` feel slow, and a webhook hiccup can never affect the
scheduled send.

---

Components
---

**Cloudflare Worker** (`worker/src/index.js`, ~900 lines, single file)
Receives the Telegram webhook, validates `X-Telegram-Bot-Api-Secret-Token`,
parses the command, and either answers directly from state or kicks off a
`repository_dispatch` to GitHub Actions for anything that needs generation or
fan-out. Bound to:

- `BOT_STATE` (KV namespace) — read path for `/briefing`'s cached copy and
  fast lookups.
- `BOT_DO` (Durable Object, class `BotState`) — authoritative store for
  access list, subscriber list, usage stats; KV is a mirror of this, not the
  source of truth.

**Durable Object `BotState`**
Single instance holding: `access` (allowlist + pending requests), `subscribers`,
`usage_stats`, `today_briefing_md` / `today_briefing_date`. Chosen over KV-only
because it gives strongly-consistent read-modify-write for allowlist/subscribe
mutations (KV is eventually consistent, which would race under concurrent
`/subscribe` calls). State is mirrored out to KV so the Worker can serve cheap
reads without going through the DO on every request.

**GitHub Actions workflows** (`.github/workflows/`)

- `daily-briefing.yml` — has three ways to fire: the Worker's Cron Trigger
  (primary, via `repository_dispatch` at 09:05 UTC — added 2026-07-13, PR #43),
  GitHub's own `schedule` (backup, 09:00 UTC, kept despite being unreliable —
  see below), and the watchdog (backup, see next item). An idempotency check
  (below) makes it safe for more than one of these to fire the same day. Once
  running: `claude -p` against `briefing-prompt.md`, writes
  `state/today_briefing.md`, sends via `scripts/send-briefing.mjs`, commits
  `state/` back to the repo.
- `daily-briefing-watchdog.yml` — 10:30 UTC cron. Checks whether
  `last_briefing_at` in `state/usage_stats.json` matches today; if not,
  re-dispatches `daily-briefing.yml` and alerts the owner via
  `scripts/send-alert.mjs`. Exists — and is still kept as a third layer even
  after the Cron Trigger fix — because GitHub's `schedule` trigger is
  documented best-effort and had fired 1–4h late or been silently skipped
  entirely (issue #17).
- `on-demand-briefing.yml` — `repository_dispatch` target for `/newbriefing`;
  generates, then `scripts/sync-kv.mjs` writes the result into KV so the
  Worker can serve it without re-generating.
- `broadcast.yml` — `repository_dispatch` target for `/broadcast`; the Worker
  only validates owner + message, then `scripts/broadcast.mjs` fans out
  (paced, retried) on the Actions runner, not in the Worker, because the
  Worker's per-invocation subrequest cap silently dropped recipients past
  ~45 subscribers when fan-out was tried in-Worker.

**Shared modules** (`shared/`)
`telegram.mjs` (Bot API wrapper) and `telegram-markdown.mjs` (MarkdownV2
escaping) are used by both the Worker and the Actions scripts, so message
formatting/escaping behaves identically regardless of which runtime sent it.

**State on disk vs. state in KV/DO** — two separate state stores that serve
different purposes: `state/*.json`/`.md` in the repo is what the _generation_
side reads/writes and is git-versioned (useful for debugging what a given day
produced); KV/DO is what the _live_ side reads/writes and reflects
right-now truth (who's subscribed, right now). `sync-kv.mjs` is the one-way
bridge from the former to the latter after a generation run.

---

Data flow
---

**Daily scheduled send**

1. The Worker's Cron Trigger fires `scheduled()` at 09:05 UTC, which
   dispatches `daily-briefing-trigger` to `daily-briefing.yml` (primary path).
   GitHub's own 09:00 UTC `schedule` trigger on the same workflow is a backup
   that may fire independently (often late or not at all — issue #17).
2. `claude -p briefing-prompt.md` searches the web (news from the past 48h)
   and writes `state/today_briefing.md` + updates `state/usage_stats.json`
   (idempotency marker, so a duplicate trigger the same day is a no-op).
3. `send-briefing.mjs` reads the live subscriber list from KV and sends to
   each.
4. Workflow commits updated `state/` back to `main`.
5. Watchdog checks 90 minutes later (10:30 UTC); re-dispatches + alerts owner
   if step 1 never happened via any of its three triggers.

**On-demand command** (e.g. `/briefing`, `/subscribe`)

1. Telegram POSTs the update to the Worker's webhook.
2. Worker validates the shared secret header, looks up the sender in the
   `BotState` DO (allowlist check).
3. `/briefing` → serve `today_briefing_md` straight from KV, no generation.
   `/newbriefing` → `repository_dispatch` to `on-demand-briefing.yml`, which
   generates and syncs the result back into KV via `sync-kv.mjs`.
   `/subscribe`, `/unsubscribe`, `/status` etc. → read/write the DO directly.

**Broadcast** (owner-only)

1. `/broadcast <text>` → Worker validates sender is owner, dispatches
   `broadcast.yml` with the message.
2. `broadcast.mjs` runs on the Actions runner, paces + retries delivery to
   every subscriber, and sends the owner a delivery report.

---

Command reference
---

| Command                                                       | Handler              | Notes                                             |
| ------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| `/start`                                                      | Worker               | Requests access; adds to `pending` in the DO      |
| `/briefing`                                                   | Worker               | Serves cached copy from KV, no generation         |
| `/newbriefing`                                                | Worker → Actions     | `repository_dispatch` to `on-demand-briefing.yml` |
| `/subscribe`, `/unsubscribe`                                  | Worker               | Mutates `subscribers` in the DO                   |
| `/status`, `/help`                                            | Worker               | Read-only                                         |
| `/privacy`, `/mydata`, `/forgetme`                            | Worker               | Data-subject rights over DO-held data             |
| `/admin`, `/pending`, `/adduser`, `/removeuser`, `/listusers` | Worker (owner-gated) | Reads/mutates the DO's allowlist                  |
| `/broadcast`                                                  | Worker → Actions     | Owner-gated; see Broadcast flow above             |

Owner-only commands are gated by comparing the sender's Telegram id against
the single hardcoded/DO-stored owner id — there is no role system beyond
owner vs. everyone-else.

---

Security & secrets model
---

Least-privilege scope per credential (full table in `README.md`):

| Credential                      | Held by                     | Scope                                               |
| ------------------------------- | --------------------------- | --------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | repo secret + Worker secret | full bot control                                    |
| `TELEGRAM_WEBHOOK_SECRET`       | Worker secret               | validates inbound webhook is really Telegram        |
| `GITHUB_TOKEN` (Worker→Actions) | Worker secret               | fine-grained PAT, this repo only, `Contents: write` |
| `ANTHROPIC_API_KEY`             | repo secret                 | spend-capped workspace key                          |
| `CF_API_TOKEN`                  | repo secret                 | `Workers KV Storage: Edit` only                     |
| `OWNER_CHAT_ID`                 | repo **variable**           | not sensitive, owner's own Telegram id              |

Notable hardening already done: the `GITHUB_TOKEN` migration off a classic
full-`repo`-scope PAT to a fine-grained, this-repo-only token is complete
(2026-07-03). Webhook requests are rejected unless the secret-token header
matches. `agent-security` (a local Claude Code skill in this repo) exists
specifically to review changes to this bot's AI/agent-facing code against
OWASP-style risks.

Privacy posture: allowlist-gated (no public access), data-subject commands
(`/privacy`, `/mydata`, `/forgetme`) are first-class, and as of last check the
subscriber list contained only Dasha's own two Telegram accounts — i.e.
currently no third-party personal data is actually held.

---

Environments
---

Production and staging are fully separate: distinct Worker
(`ai-in-ta-telegram-bot` vs. `ai-in-ta-telegram-bot-staging`), distinct
Telegram bot, distinct KV namespace, distinct webhook secret — so a staging
change can be exercised end-to-end without any chance of touching prod state
or prod subscribers. `wrangler deploy` targets prod by default; staging
requires `--env staging` explicitly.

Known gotcha: the staging DO only migrates seed data from KV on first touch.
Re-seeding after that requires a two-step migration dance (remove binding +
`deleted_classes`, redeploy, restore binding + `new_sqlite_classes` at a new
tag) because Cloudflare blocks deleting a DO class while its binding still
exists. Staging is currently at migration tag v3 for this reason; prod has
never needed a reset and stays at v1.

---

Reliability
---

- **Idempotency**: `state/usage_stats.json`'s `last_briefing_at` prevents a
  duplicate send if `daily-briefing.yml` is triggered twice the same day
  (manual trigger + watchdog fallback racing, for example).
- **Concurrency control**: a shared `briefing-generation` concurrency group
  means a losing racer no-ops instead of double-sending.
- **Three-layer daily trigger**: after GitHub's `schedule` trigger proved
  unreliable for `daily-briefing.yml` (1–4h late or silently skipped — issue
  #17), a Cloudflare Worker Cron Trigger was added (2026-07-13, PR #43) as the
  primary trigger, with GitHub's schedule and the watchdog kept as redundant
  backups rather than removed. The idempotency check makes it safe for two or
  three of these to fire the same day.
- **Watchdog**: the last-resort layer — re-dispatches `daily-briefing.yml` and
  alerts the owner if neither the Cron Trigger nor GitHub's schedule produced
  a briefing by 10:30 UTC.
- **Broadcast fan-out cap**: moved from Worker to Actions runner after
  silent drops past ~45 recipients from the Worker's per-invocation
  subrequest limit — not currently a risk at the 30-user cap, but the fix is
  in place regardless.

---

Current limitations / open items
---

- Single operator, single owner id — no delegated admin roles.
- 30-user cap is a design assumption, not an enforced limit anywhere
  specific to check if it's still just a comment vs. code-enforced.
- Real subscriber base is currently just Dasha's two accounts; the
  allowlist/admin tooling is built for a population that doesn't exist yet.
- No automated test coverage for the GitHub Actions workflows themselves
  (only `worker/` and `shared/` have `test/`), so workflow YAML changes are
  currently manually verified.
- Briefing quality/editorial rules live in prose (`briefing-prompt.md`,
  `briefing-prompt-ondemand.md`) rather than structured config — changing
  tone or source rules means editing prompt text and re-validating by eye
  (see `docs/qa/` for the process used through phases 9–16).

---

Future considerations
---

- If the user base grows past a handful, the owner-only admin commands
  (`/pending`, `/adduser`, etc.) will need to move from "one owner reads a
  Telegram list" to something more structured (e.g. a lightweight admin web
  view) — not needed yet at 2 real users.
- The daily/on-demand generation path could converge (on-demand currently
  reuses `on-demand-briefing.yml` + `sync-kv.mjs` as a near-duplicate of the
  daily flow) if the two prompts and idempotency logic ever need to diverge
  further, though duplicating them today keeps each path simple to reason
  about independently.
