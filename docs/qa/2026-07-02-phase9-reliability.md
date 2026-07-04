# Phase 9 — Reliability Audit (kill / interruption)

**Date:** 2 July 2026 · **Scope:** Cloudflare Worker + Durable Object + KV mirror + GitHub Actions briefing pipeline
**Method:** interruption-point analysis. There is no long-running daemon to `kill -9`: the runtime is a request-scoped Worker (DO storage guarded by Cloudflare's output gate) plus ephemeral Actions runners GitHub can cancel at any step. So "kill during X" is modelled as **process/isolate death at each `await` or workflow-step boundary**, and "graceful recovery" as: no persistent corruption, no lost truth, no duplicate/again-delivery on retry. Baseline: `npm test` 75/75 green (existing R1–R5 reliability set included).

> **Scope note — Firecrawl is not in the pipeline.** `grep -ri firecrawl` over the repo returns zero hits. Automated generation is `claude -p … --allowedTools WebSearch` (`daily-briefing.yml:50`, `on-demand-briefing.yml:35`). The Firecrawl path in project memory is the *interactive* hand-produced briefing, not the deployed bot. "Kill during Firecrawl request" is therefore N/A to the shipped system; the equivalent — kill during the web-search-backed Claude call — is covered by REL-5 (recovers cleanly).

---

## Executive summary

Single-operation and file-corruption kills recover cleanly — the ephemeral-runner + git-commit-boundary + content-before-pointer design is sound (REL-5..REL-8). The reliability debt lives at the **multi-recipient and cross-store boundaries**: no send checkpoint, a non-atomic DO→KV mirror, and no rollback for a killed generation.

**Verdict: CONDITIONAL GO** at the current 2-account private scale (both accounts the owner's) — the confirmed gaps degrade gracefully to "duplicate message" or "missed one briefing," not data loss or auth bypass. REL-1 and REL-3 should be fixed before any subscriber growth; REL-2 (erasure not reflected in the send list) is worth fixing sooner for its privacy angle.

---

## Confirmed gaps (recovery is *not* graceful)

### Should fix

**REL-1 (Medium, reliability) — Partial send has no checkpoint → duplicate delivery on retry.** *(not covered by BUG-4; that was the subrequest cap)*
- Repro: kill the daily runner mid-`for` loop in `scripts/send-briefing.mjs:59`, or the Worker mid-loop in `/broadcast` (`worker/src/index.js:681`). N recipients delivered, the rest not; no per-recipient progress is persisted.
- Why the daily case escalates: the `Send to Telegram` step runs **before** `Update usage stats` / `Sync to Cloudflare KV` / `Commit updated state` (`daily-briefing.yml:59-107`). A kill mid-send never advances `last_briefing_at`, so the idempotency probe (`daily-briefing.yml:35`) still reads the old value → a re-dispatch **regenerates and re-sends to the entire list**, duplicating for everyone already delivered.
- The `update_id` dedup (`worker/src/index.js:217`) does **not** protect this — a manual retry / `workflow_dispatch` / owner re-`/broadcast` is a new update_id. No idempotency key exists on outbound sends.
- Fix options: (a) persist a per-run "delivered" cursor (last index / set of chat_ids) and resume from it; or (b) accept duplicates but make regeneration idempotent by advancing a "sent for $DATE" marker the send step itself checks. At current scale this is low-impact (audience = 2); it becomes real spam at 50+.

**REL-2 (Medium, reliability + privacy) — DO→KV subscriber mirror is a second, ungated write; a kill can leave an erased user on the send list.**
- `subscribe()` / `unsubscribe()` / `forgetUser()` commit to DO storage (`worker/src/index.js:153`,`164`,`122-126`) **inside** the output gate, then call `mirrorSubscribers()` — a plain external KV `fetch` **outside** the gate (`worker/src/index.js:176`). A kill between the two commits the DO change but skips the KV mirror, and the daily pipeline reads only the KV mirror (`send-briefing.mjs:26-33`).
- Subscribe/unsubscribe self-heal on user retry — `mirrorSubscribers` runs even on the no-op path (intentional, `worker/src/index.js:170-177`).
- The sharp edge is **erasure**: `/forgetme` and owner `/removeuser` route through `forgetUser`, which removes from DO then mirrors (`worker/src/index.js:127`). A kill before the mirror leaves the erased / unsubscribed person **still in the KV `subscribers` key** → they keep receiving the daily briefing after erasure, and the owner has no signal to retry (the killed call sent no confirmation reply). Contradicts the right-to-erasure promise in `/privacy`.
- Fix: make the mirror self-healing on the read side — have `send-briefing.mjs` read the authoritative list from the DO (or reconcile KV against it) rather than trusting a mirror that can silently lag; or write DO+mirror atomically (e.g. mirror inside a DO alarm that retries until KV confirms).

**REL-3 (Medium, availability) — A killed generation run permanently burns the cooldown and a daily-cap slot.**
- `reserveBriefingDispatch` consumes the 60-min global cooldown and increments the per-user daily cap at **dispatch** time (`worker/src/index.js:197-200`). The rollback path (`worker/src/index.js:206-212`, called at `:396`) only fires when the GitHub `POST /dispatches` itself fails — **not** when the Actions run is killed after it started.
- Effect: a killed/cancelled generation locks `/newbriefing` for up to an hour **and** permanently consumes 1 of the user's 3 daily attempts, having produced nothing. `/briefing` meanwhile serves the previous cache or a "being generated" note that never arrives.
- Fix: have the Actions run signal terminal failure back (a small Worker endpoint the workflow calls on failure, or a DO alarm that expires an un-fulfilled reservation) so a dead run releases its reservation instead of holding it for the full window.

**REL-4 (Medium, correctness) — On-demand path lacks the daily path's freshness guard.**
- `send-to-chat.mjs` sends whatever is in `state/today_briefing.md` with **no `includes(today)` check** (`send-to-chat.mjs:13`), and `force-briefing-date.mjs` only rewrites the title when its regex matches, otherwise passing content through unchanged (`force-briefing-date.mjs:15-16`).
- So if the Claude call exits 0 with **truncated / malformed** output — a dropped connection rather than a clean kill — the on-demand requester receives a garbage briefing, and the subsequent `sync-kv` step then **caches it as today's** (`on-demand-briefing.yml:37-52`), poisoning `/briefing` for everyone until the next run.
- The daily path suppresses exactly this, twice: `send-briefing.mjs`'s own `md.includes(today)` self-check (`send-briefing.mjs:49`) and the workflow freshness gate on the stats/KV steps (`daily-briefing.yml:69-96`). The two paths are inconsistent.
- Fix: give `send-to-chat.mjs` the same `includes(today)` guard, and gate on-demand's `Sync to Cloudflare KV` on a freshness check as the daily workflow does.

---

## Points that *do* recover gracefully (verified)

- **REL-5 — Kill during Claude / generation (incl. the web-search step):** `claude -p … > state/today_briefing.md` truncates the file, but on an **ephemeral runner**; nothing is committed or pushed unless the run completes, and `last_briefing_at` only advances after freshness passes (`daily-briefing.yml:83-87`). A killed generation is safely retryable — no persistent corruption, no false "already generated today." ✅
- **REL-6 — `sync-kv` write ordering is kill-safe:** it writes `today_briefing_md` **before** `today_briefing_date` (`sync-kv.mjs:31-32`). A kill between them leaves the date pointer stale, so `/briefing` treats the cache as stale and regenerates — it never serves a half-written pointer as "today." Correct content-then-pointer discipline. ✅
- **REL-7 — Kill during file writes:** `writeFileSync` (`force-briefing-date.mjs:16`, `update-usage-stats.mjs:22`) is non-atomic, but the git-commit boundary plus the `JSON.parse`-in-`try/catch` idempotency probe (`daily-briefing.yml:35`) means a corrupt **uncommitted** file can't poison future runs; the next checkout restores the last good state. ✅
- **REL-8 — Kill during a single Telegram API call:** `fetchWithRetry` + `tg()` swallow throws and the webhook still ACKs (test R3); a 403 mid-broadcast continues the loop and reports failures to the owner (test R4). This is per-call resilience — distinct from the *partial-loop* gap in REL-1. ✅

---

## Coverage vs. the six named kill points

| Kill point | Finding | Recovery |
|---|---|---|
| Subscription | REL-2 | Self-heals for sub/unsub on retry; **erasure can leave user on KV send list** |
| Briefing generation | REL-3, REL-5 | State recovers cleanly (REL-5); **reservation/cap not released** (REL-3) |
| Telegram send | REL-1, REL-8 | Single call resilient (REL-8); **partial multi-recipient send → duplicates on retry** (REL-1) |
| Firecrawl request | N/A | Not in pipeline; equivalent web-search kill covered by REL-5 |
| Claude request | REL-4, REL-5 | Daily path guarded (REL-5); **on-demand path can deliver/cache partial output** (REL-4) |
| File writes | REL-7 | Non-atomic but ephemeral + git boundary = safe |

## Net
No critical or data-loss reliability defect at current scale. The design's strong points — ephemeral runners, git-commit as the durability boundary, content-before-pointer KV ordering, per-call retry/ACK — hold. The open work is at boundaries that span multiple recipients or two stores: REL-1 (send checkpoint / idempotency), REL-2 (DO↔KV mirror durability, esp. erasure), REL-3 (killed-generation reservation rollback), REL-4 (on-demand freshness guard).
