# AI-in-TA Telegram Bot

[![CI](https://github.com/Da6ka/ai-in-ta-telegram-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Da6ka/ai-in-ta-telegram-bot/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Da6ka/ai-in-ta-telegram-bot)](https://github.com/Da6ka/ai-in-ta-telegram-bot/releases)

A Telegram bot that sends a **daily briefing on AI in recruitment** — the latest news, tools, and research from the past 48 hours, researched and written by Claude Code and delivered straight to your chat.

Subscribers tap `/subscribe` and get the briefing every morning at **09:00 UTC / 12:00 MSK**. No app to install, no laptop to keep awake — everything runs on GitHub Actions and a Cloudflare Worker.

---

## Contents

- [What it does](#what-it-does)
- [Example briefing](#example-briefing)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Cloudflare Worker (on-demand commands)](#cloudflare-worker-on-demand-commands)
- [Staging environment](#staging-environment-optional)
- [Secrets, scopes & rotation](#secrets-scopes--rotation)
- [Releasing](#releasing)

---

## What it does

- 📰 **Daily briefing** — every morning, Claude searches the web for what's new in AI-for-recruitment, writes a concise briefing, and sends it to every subscriber.
- 🤖 **On-demand** — subscribers can pull a fresh or cached briefing any time with a command, no waiting for the morning run.
- 📣 **Owner tools** — broadcast a message to everyone, manage the subscriber list, check who's on it.
- 🔒 **Runs itself** — GitHub Actions handles the schedule and the heavy lifting; a Cloudflare Worker handles live commands. Nothing depends on a personal machine being online.

This is a **private, allowlist-gated bot** (single operator, capped at 30 users). New people tap `/start` to request access; the owner approves them. There's **no hand-maintained recipient list** — once in, whoever taps `/subscribe` gets the daily briefing and `/unsubscribe` stops it. The subscriber list lives in Durable Object storage, mirrored to Cloudflare KV and read fresh at send time.

## Example briefing

A real edition, sent via `/briefing`:

> **Daily AI Recruitment Briefing — 3 July 2026**
>
> **Claude & Anthropic in TA**
> Anthropic shipped Claude Sonnet 5, now the default model on Free and Pro plans — pitched as its "most agentic Sonnet yet" for coding and professional work. For TA teams running Claude-based sourcing, screening, or analytics workflows, this is a capability (and cost/latency) shift worth re-benchmarking your prompts against. *([Introducing Claude Sonnet 5 — Anthropic](https://www.anthropic.com/news/claude-sonnet-5))* (30 June)
>
> **AI in Recruitment — What's New**
> Colorado's landmark AI Act reached its effective date but in narrowed form: the original Act was set to take effect 30 June 2026, after Colorado signed a replacement bill in May to scale back the broader framework governing high-risk automated employment decisions. Employers using AI hiring tools with Colorado applicants should confirm which obligations (notice, human review, bias auditing) actually survived. *([National Law Review](https://natlawreview.com/article/federal-government-quietly-removed-its-ai-hiring-guidance-four-states-are-writing))* (took effect 30 June)
>
> **Worth Reading**
> "AI Didn't Break Hiring. It Scaled the Bias We Already Chose." — Forbes argues the problem isn't that algorithms invented bias but that they industrialize the flawed proxies organizations already encoded, making visible human oversight and audited criteria non-negotiable. *([Forbes](https://www.forbes.com/sites/aparnarae/2026/06/29/ai-didnt-break-hiring-it-scaled-the-bias-we-already-chose/))* (29 June)
>
> **Bottom line:** More capable models are arriving faster than the compliance and fairness guardrails around them — pair any new AI hiring capability with documented human review and a live read on your states' shifting rules before you scale it.

Every item is sourced (clickable, dated, no bare URLs), never repeats a domain, and skips evergreen "guide"/"trends" content in favor of actual news from the past 7 days — see `briefing-prompt.md` for the exact editorial rules.

## Commands

**Everyday**

| Command | What it does |
| --- | --- |
| `/start` | Request access / see what the bot is |
| `/briefing` | Get today's briefing (cached copy, instant) |
| `/newbriefing` | Generate a fresh briefing right now |
| `/subscribe` | Get the daily briefing every morning |
| `/unsubscribe` | Stop the daily briefing |
| `/status` | Check your access status |
| `/help` | List available commands |

**Privacy**

| Command | What it does |
| --- | --- |
| `/privacy` | How your data is handled |
| `/mydata` | See everything stored about you |
| `/forgetme` | Erase all your data from the bot |

**Owner-only**

| Command | What it does |
| --- | --- |
| `/admin` | Admin panel / usage stats |
| `/pending` | Review and approve access requests |
| `/adduser` · `/removeuser` | Add or remove someone directly |
| `/listusers` | List everyone the bot knows |
| `/broadcast` | Send a one-off message to every subscriber |

> Free-form chat with Claude and group chats are **not** supported — this bot is briefing delivery only.

## How it works

```
GitHub Actions (schedule)          Cloudflare Worker (webhook)
   │                                   │
   │ 1. claude -p reads                │ receives Telegram commands
   │    briefing-prompt.md,            │ 24/7, independent of any
   │    searches web, writes           │ local machine
   │    state/today_briefing.md        │
   │                                   │ /newbriefing, /broadcast →
   │ 2. send-briefing.mjs sends        │ dispatches back to Actions
   │    to every subscriber            │
   │                                   │ /briefing → serves cached
   │ 3. commits state/ back to repo    │ copy straight from KV
   ▼                                   ▼
        Telegram subscribers  ◀────────
```

**The daily run:**

1. `briefing-prompt.md` is handed to `claude -p`, which searches the web, composes the briefing, and writes it to `state/today_briefing.md` (plus `state/usage_stats.json` for an idempotency check, in case the workflow is also triggered manually the same day).
2. `scripts/send-briefing.mjs` sends the result to every subscriber in the bot's live list (the `subscribers` KV key).
3. The workflow commits the updated `state/` files back to the repo.

Trigger a run manually any time from the **Actions** tab ("Run workflow"), or:

```bash
gh workflow run daily-briefing.yml --repo <owner>/ai-in-ta-telegram-bot
```

## Quickstart

Want the daily briefing running under your own bot? Three things to set up:

1. **A Telegram bot** — create one with [@BotFather](https://t.me/BotFather) and grab its token.
2. **Repo secrets & variables** — the credentials the workflows need (below).
3. **A Cloudflare Worker** — for on-demand commands ([full setup here](#cloudflare-worker-on-demand-commands)).

### Repo secrets

| Secret | What it is |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic Console API key (pay-as-you-go, separate from any claude.ai subscription) |
| `TELEGRAM_BOT_TOKEN` | The bot's token from @BotFather |
| `CF_ACCOUNT_ID` | Cloudflare account id |
| `CF_API_TOKEN` | Cloudflare token — **Workers KV Storage: Edit** only |
| `CF_KV_NAMESPACE_ID` | The `BOT_STATE` KV namespace id |

Plus one repo **variable** (not a secret — it's the owner's own Telegram id, which isn't sensitive):

| Variable | What it is |
| --- | --- |
| `OWNER_CHAT_ID` | Where the daily workflow sends failure / stale-generation alerts |

Set them with:

```bash
gh secret set ANTHROPIC_API_KEY --repo <owner>/ai-in-ta-telegram-bot
gh secret set TELEGRAM_BOT_TOKEN --repo <owner>/ai-in-ta-telegram-bot
gh variable set OWNER_CHAT_ID --repo <owner>/ai-in-ta-telegram-bot   # your numeric Telegram id
```

> **Finding your Telegram id:** message [@userinfobot](https://t.me/userinfobot) (or [@getmyid_bot](https://t.me/getmyid_bot)) — it replies with your numeric id. Alternatively, `/start` your own bot and read the id it logs. It's just a number like `123456789`, not sensitive, which is why `OWNER_CHAT_ID` is a repo *variable* rather than a secret.

> See [Secrets, scopes & rotation](#secrets-scopes--rotation) for the least-privilege scope each token needs and a rotation checklist.

## Cloudflare Worker (on-demand commands)

Live commands like `/newbriefing`, `/briefing`, `/admin`, and `/subscribe` are handled by a **Cloudflare Worker** (`worker/`) that receives Telegram's webhook directly — so they work 24/7, independent of any local Mac or Claude Code session.

State (`access`, `subscribers`, `usage_stats`, `today_briefing_md`, `today_briefing_date`) lives in a Cloudflare KV namespace bound as `BOT_STATE`. Briefing *generation* is still delegated to GitHub Actions (`on-demand-briefing.yml`, triggered via `repository_dispatch`), which writes the result back into KV via `scripts/sync-kv.mjs` so `/briefing` can serve a cached copy without re-generating.

`/broadcast` delivery is likewise delegated to Actions (`broadcast.yml`, also triggered via `repository_dispatch`): the Worker validates the owner + message and dispatches it, then `scripts/broadcast.mjs` fans the message out to every subscriber (paced + retried) and sends the owner a delivery report. Running the fan-out on the runner instead of in the Worker avoids the Worker's per-invocation subrequest cap, which silently dropped recipients past ~45.

### One-time setup

1. **Cloudflare account** — free tier, no credit card needed.
2. Install and log in:
   ```bash
   npm install -g wrangler
   wrangler login   # opens a browser to authorize
   ```
3. Create the KV namespace and paste the returned id into `worker/wrangler.toml`:
   ```bash
   cd worker
   npx wrangler kv namespace create BOT_STATE
   ```
4. **Seed KV** with the current allowlist / subscribers / usage so existing users aren't dropped. Ask Claude to do this — it can read the local `~/.claude/channels/telegram/*.json` files and write the equivalent `wrangler kv key put` commands without ever printing the bot token.
5. Set the Worker secrets:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string you generate
   npx wrangler secret put GITHUB_TOKEN              # fine-grained PAT, see below
   ```
   Use a **fine-grained** GitHub PAT scoped to *only* this repo with **Contents: write** — that's all `repository_dispatch` needs. Avoid a classic `repo`-scope token, which grants access to every repo you own.
6. **Deploy:**
   ```bash
   npx wrangler deploy   # from worker/ — note the *.workers.dev URL it prints
   ```
7. Add the **repo secrets** for `scripts/sync-kv.mjs` (run from GitHub Actions):
   ```bash
   gh secret set CF_ACCOUNT_ID --repo <owner>/ai-in-ta-telegram-bot
   gh secret set CF_API_TOKEN --repo <owner>/ai-in-ta-telegram-bot       # needs Workers KV Storage: Edit
   gh secret set CF_KV_NAMESPACE_ID --repo <owner>/ai-in-ta-telegram-bot # same id as step 3
   ```
8. **Test before cutover** ⚠️ — send fake Telegram updates straight to the deployed Worker URL with curl (including the `X-Telegram-Bot-Api-Secret-Token` header) and confirm the replies and KV state look right. Do this **before** touching the live webhook — once set, Telegram stops delivering to the old long-polling `server.ts` for *all* commands, not just `/newbriefing`.
9. **Cutover** (only once step 8 checks out):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-worker>.workers.dev" \
     -d "secret_token=<same value as TELEGRAM_WEBHOOK_SECRET>"
   ```
   To roll back: `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"` and restart the local `bun server.ts` poller.

## Staging environment (optional)

A misconfigured live webhook is a silent full outage, so `wrangler.toml` defines a `staging` environment — a separate Worker (`ai-in-ta-telegram-bot-staging`) backed by its own bot and its own KV namespace, so you can exercise command changes end-to-end without touching production. One-time setup is documented inline in `worker/wrangler.toml`; once done:

```bash
cd worker
npx wrangler deploy --env staging
# point the staging bot's webhook at the *-staging.workers.dev URL, then message that bot
```

The default `npx wrangler deploy` continues to target production and ignores the staging block.

## Secrets, scopes & rotation

Least-privilege scope for each credential:

| Credential | Where | Scope it actually needs |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | repo secret | a workspace/key you can cap with a monthly spend limit |
| `TELEGRAM_BOT_TOKEN` | repo secret + Worker secret | n/a (full bot control — rotate via @BotFather if leaked) |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret | any random string; must match the `setWebhook` `secret_token` |
| `GITHUB_TOKEN` | Worker secret | fine-grained PAT, **this repo only**, `Contents: write` |
| `CF_API_TOKEN` | repo secret | Cloudflare API token, **Workers KV Storage: Edit** only |
| `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` | repo secret | identifiers, not secrets — kept as secrets for convenience |
| `OWNER_CHAT_ID` | repo **variable** | not sensitive (owner's own Telegram id) |

> **Status (2026-07-03):** the `GITHUB_TOKEN` migration off a classic full-`repo`
> PAT to a fine-grained, this-repo-only `Contents: write` token is complete — the
> classic token has been deleted.

**Rotation checklist** (do this on any suspected leak, and at least once a year):

1. **Telegram bot token** — `/revoke` in @BotFather, then update both the `TELEGRAM_BOT_TOKEN` repo secret and the Worker secret, and re-run `setWebhook` with the new token.
2. **Anthropic key** — roll in the Anthropic Console, update the repo secret.
3. **GitHub PAT** — regenerate the fine-grained token, `npx wrangler secret put GITHUB_TOKEN`.
4. **Cloudflare API token** — roll in the Cloudflare dashboard, update the `CF_API_TOKEN` repo secret.
5. Trigger `daily-briefing.yml` manually afterward to confirm generation, send, and KV sync all still pass with the rotated credentials.

## Releasing

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/). Every merged change gets an entry under `[Unreleased]` right away — documenting the change and deciding when to release it are separate steps.

**When to cut a version bump:**

- **Patch (x.y.Z)** — a single bug fix or hardening change with no behavior change for users.
- **Minor (x.Y.0)** — a batch of related fixes/features, or a new user-facing capability (new command, new workflow) that doesn't break existing usage.
- **Major (X.0.0)** — a breaking change: an existing command's behavior changes incompatibly, a secret/config gets renamed, or something an operator or subscriber depends on now works differently.

**When to actually release:**

- Release per batch, not per PR. Let entries accumulate under `[Unreleased]` and cut a version once a cluster of related work is stable and complete, not after every individual merge.
- To cut a release: rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD`, open a fresh empty `[Unreleased]` above it, then tag it (`git tag vX.Y.Z && git push --tags`, or `gh release create vX.Y.Z`).
