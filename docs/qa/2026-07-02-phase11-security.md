# Phase 11 — Security Review

**Date:** 2 July 2026 · **Scope:** Worker (`worker/src/index.js`), delivery/utility scripts, shared markdown module, GitHub Actions workflows, `wrangler.toml`, tracked state, git history
**Method:** static review + targeted greps against the nine requested classes — hardcoded secrets, exposed tokens, prompt leaks, path traversal, command injection, unsafe parsing, DoS, race conditions, sensitive logging. Cross-checked against the release-gate SEC-1..3 to confirm what's still open.

---

## Executive summary

**No critical or high-severity vulnerability found.** The design closes the big classes by construction: the webhook is secret-gated and the check runs *before* any body parsing (fails closed when the secret is unset); the repo is **private** and its committed state is aggregate-only (no chat IDs); generation runs on an isolated runner with `--allowedTools "WebSearch"` (no Bash/Write → no key exfiltration or file write from an injected page); and all mutable auth/subscriber state is serialized through a single Durable Object. HTML output is correctly escaped, the markdown parser has no catastrophic backtracking, and there are no `eval`/`child_process`/filesystem sinks in the Worker.

Residual findings are **medium-to-low**: an unguarded `JSON.parse` that can silently brick every command (SEC-4, was BUG-8), the `Retry-After` under-wait (SEC-2, still open), the over-privileged deploy PAT (SEC-1, deployment-side), and a couple of defense-in-depth hardening gaps. **Verdict: GO** for the current private deployment; address SEC-4 and SEC-1 as the two that matter most.

---

## Findings by category

### 1. Hardcoded secrets — CLEAN ✅
`git grep` and a full-history blob scan (`git log -p --all`) for token shapes (`ghp_`, `github_pat_`, `sk-ant-`, `<botid>:AA…`) return **nothing** in tracked files or history. All secrets are injected at runtime: GitHub Actions secrets (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `CF_*`) and Worker bindings / `.dev.vars`. `.gitignore` excludes `.wrangler/` and `.dev.vars`; the `.wrangler` account cache is **not** tracked. `wrangler.toml` contains only a KV namespace **id** (an identifier, not a credential) and the public `GITHUB_REPO` var — both fine to commit.

### 2. Exposed tokens — CLEAN ✅
The Telegram bot token lives in the API URL path (unavoidable — that's the Bot API), but **no code logs the URL or the request**. `tg()` logs only the method name + Telegram's `description`; `fetchWithRetry` logs nothing. No `Authorization` header is ever logged. Committed `state/usage_stats.json` is aggregate-only (`briefings_sent`, `last_briefing_at`, `briefing_history`) — the per-user `last_seen`/`command_counts` with real chat IDs live only in KV, never in the repo. Repo confirmed **private**.

### 3. Prompt leaks — CLEAN ✅
The Worker is **commands-only**: no user text is ever fed to an LLM, so there is no system-prompt-extraction or jailbreak surface in the bot itself. The only model invocation is briefing *generation* on the runner, from a repo-committed prompt (not secret) plus `WebSearch`, with **no user input in the prompt**. Injected web content can bias the briefing's wording (accepted residual, Phase 7) but — because the agent is restricted to `WebSearch` with no Bash/Write — it **cannot exfiltrate `ANTHROPIC_API_KEY` or write files**. The prompt-injection→secret-exfil path from the pre-release audit stays closed.

### 4. Path traversal — CLEAN ✅
No user-controlled value ever reaches a filesystem path. Every script reads/writes fixed literals (`state/today_briefing.md`, `state/usage_stats.json`). The Worker has no filesystem. `client_payload.chat_id` flows only into a Telegram `chat_id` JSON field, never a path.

### 5. Command injection — CLEAN, with a defense-in-depth note ✅ / SEC-5
- Workflow shell steps interpolate only trusted values: `$(cat briefing-prompt*.md)` (repo files) and `$NOTE` (derived from `date`). No untrusted data in any inline `run:` `${{ }}`.
- The one attacker-influenced value, `client_payload.chat_id`, is passed via the **`env:` block** (`CHAT_ID: ${{ github.event.client_payload.chat_id }}`), not inline in a shell script, and is consumed by Node as `process.env.CHAT_ID` — so even a metacharacter-laden value is an inert string, never shell-evaluated. This is the GitHub-recommended safe pattern. No injection.
- **SEC-5 (Low, defense-in-depth):** the Worker builds that payload as `chat_id: String(message.from.id)` with **no numeric validation** (`worker/src/index.js:355`, `dispatchBriefing`). Telegram guarantees a numeric `from.id`, and reaching this path already requires the webhook secret, so it's not exploitable today — but validating `^-?\d+$` at the Worker boundary (as `/adduser` already does) would harden the trust boundary and avoid wasted Actions runs on a malformed id.

### 6. Unsafe parsing — SEC-4 (Medium) ⚠️
- `request.json()` **is** guarded (try/catch → 400), and the secret check runs before it, so unauthenticated/malformed bodies are cheap to reject. ✅
- **SEC-4 (Medium, availability) — unguarded `JSON.parse` bricks every command** *(was BUG-8, still open).* `getJSON()` (`worker/src/index.js:227-230`) calls `env.BOT_STATE.get(key, 'json')` with no try/catch. A single corrupt `usage_stats` value throws, the error is swallowed by the top-level handler catch (`:792`), and the user gets **no reply at all — for every command**, since `bumpCommandCount`/`touchLastSeen` run on the common path. Only JSON writers touch the key so corruption is unlikely, but the failure mode is total and invisible (a self-inflicted DoS). Fix: try/catch in `getJSON` returning `fallback`.
- Scripts' `JSON.parse` (`sync-kv`, `send-briefing`, `set-commands`, `resolveOwnerId`) are on controlled/KV inputs; a corrupt value throws and fails the step **safe** (e.g. `send-briefing` aborts rather than mis-sending). Acceptable.

### 7. DoS — LOW ✅
- The webhook secret is checked **first**, so unauthenticated traffic is rejected before any parse or state I/O — external flooding requires the secret. ✅
- Amplification via ungated `/start` is bounded: `addPending` and the owner notification are both idempotent (`alreadyPending` guard, `worker/src/index.js:413`), so repeat `/start` is a fixed cheap reply.
- Markdown parser has **no ReDoS**: `mdToHtml`'s regexes use only linear negated classes (`[^\]]+`, `[^\s)]+`, `[^*]+`) — no nested quantifiers; `chunk()` is linear. ✅
- Generation is rate-limited (60-min global cooldown + 3/day/user, atomic in the DO). ✅
- The realistic self-DoS is SEC-4 (corrupt stats) and, at scale, the fan-out ceilings documented in Phase 10 — not an external attack.

### 8. Race conditions — LOW, mostly by-design ✅
- All security-relevant state (allowlist, subscribers, pending, rate-limit reservation, dedup ring) is mutated **only** inside the singleton `BotState` DO, whose methods complete their `ctx.storage` writes before external I/O — Cloudflare serializes per-instance, so no lost-update on auth/subscription (this replaced a KV read-modify-write that lost the majority of concurrent writes). Reserve/rollback for briefing dispatch is a single atomic DO method. ✅
- **Known/accepted:** `bumpCommandCount` and `touchLastSeen` are two separate KV read-modify-writes per command (`:294`,`:301`) and can race → **cosmetic** stat drift only (documented in the source header). The DO→KV subscriber **mirror** is a non-atomic second write (tracked as Phase 9 REL-2, incl. the erasure edge). Neither is an auth bypass.

### 9. Sensitive logging — CLEAN ✅
Every `console.*` was reviewed: no token, URL, `Authorization` header, or API key is logged anywhere. Error logs carry only method names, HTTP status codes, Telegram/GitHub error *descriptions* (which don't echo credentials), and JS error objects. GitHub's own secret masking covers the Actions side. No sensitive logging found. *(Ops gap SEC-3 stands: there is **no** alerting — a dead bot is silent — but that's absence-of-logging, not leakage.)*

---

## Carry-forward (deployment-side, from the release gate)

- **SEC-1 (Medium, hardening) — over-privileged deploy token.** The Worker's `GITHUB_TOKEN` is a classic PAT with full `repo` scope; it only needs `repository_dispatch` on this one repo. A Worker-secret compromise = push access everywhere the PAT can reach. Switch to a fine-grained token scoped to this repo (contents: read/write, or just the dispatch). *(Can't verify token type from code — deployment action.)*
- **SEC-2 (Low) — `Retry-After` under-waited 3.3×.** `fetchWithRetry` waits `retryAfter * 300` ms (`worker/src/index.js:246`), so a `Retry-After: 5` retries after 1.5 s — guaranteeing a second 429/rate-limit hit. Use `retryAfter * 1000`.

## Hardening nice-to-haves
- Webhook secret compare is a plain `!==` (`:773`) — not constant-time. Marginal over the network with a high-entropy secret, but a constant-time compare removes the theoretical timing side-channel.
- `/removeuser` doesn't validate the id is numeric (unlike `/adduser`) — harmless (it just filters arrays) but inconsistent.

---

## Verdict

| Class | Result |
|---|---|
| Hardcoded secrets | Clean (tree + history) |
| Exposed tokens | Clean (private repo, no token logging, aggregate-only state) |
| Prompt leaks | Clean (commands-only bot; WebSearch-only isolated generation) |
| Path traversal | Clean (no user-controlled paths) |
| Command injection | Clean (env-block pattern; SEC-5 numeric-validation hardening) |
| Unsafe parsing | **SEC-4 medium** (unguarded `getJSON` → silent total brick) |
| DoS | Low (secret-gated; no ReDoS; rate-limited) |
| Race conditions | Low (DO-serialized; residuals cosmetic) |
| Sensitive logging | Clean |

**GO** for the current private deployment. Priority fixes: **SEC-4** (one try/catch, removes a silent-total-outage mode) and **SEC-1** (scope down the deploy PAT). SEC-2/SEC-5 and the hardening notes are cheap follow-ups. No finding blocks release at the current trust boundary (private repo, secret-gated webhook, single trusted operator).
