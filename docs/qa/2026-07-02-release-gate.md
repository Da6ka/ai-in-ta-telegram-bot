# Release Gate Report — ai-in-ta-telegram-bot

> **Post-audit status:** BUG-1, BUG-2 and BUG-3 were fixed in commit `d2f647d`
> (same session, full regression re-run: 9/9 unit + behavioral suite green,
> only the intentional BUG-5 probe failing). Remaining findings are open.
>
> **2026-07-02 re-audit (Phase 15 re-run):** BUG-1/2/3/8 verified fixed in the
> current tree; full suite now 84/84 green. One **new High (NEW-1)** found and
> fixed the same session — see below. Follow-up commit then cleared **SEC-2,
> BUG-5, BUG-6, BUG-7** (all Worker-side; "KNOWN BUG" tests flipped to assert
> correct behavior). Still open: **BUG-4** (multi-chunk broadcast at scale),
> **L6** (tag-aware chunking), **SEC-1** (fine-grained GitHub token) — none
> release-blocking at the current private scale.

---

## Re-audit findings (2026-07-02, Phase 15)

### NEW-1 (High, content integrity) — On-demand generation poisoned the shared briefing cache — **FIXED this session**
- **Repro:** `/newbriefing` → `claude -p` exits 0 but outputs content without the
  `# Daily AI Recruitment Briefing — <today>` header (refusal / preamble-only /
  malformed title). `force-briefing-date.mjs` can't rewrite a missing header;
  `on-demand-briefing.yml` then ran `Send to requester` + `Sync to Cloudflare KV`
  **unconditionally**. `sync-kv.mjs` overwrote `today_briefing_md` +
  `today_briefing_date=today`. Any other user's `/briefing` then saw
  `date === todayUTC()`, served the garbage from cache, and did **not**
  regenerate. Reproduced against the real Worker (poison E2E test: user 222
  served the refusal text verbatim, no GitHub dispatch).
- **Root cause:** the daily workflow's BUG-1 freshness gate was never ported to
  the on-demand workflow; `sync-kv.mjs` trusted its input.
- **Fix:** (1) added a `Check freshness` step to `on-demand-briefing.yml` and
  gated `Send to requester` / `Sync to Cloudflare KV` / `Commit` on
  `fresh == 'true'`, with a `Notify requester on stale generation` step for the
  zero-exit-garbage case; (2) defense-in-depth `isValidBriefing(md)` guard in
  `scripts/sync-kv.mjs` (shared helper in `shared/telegram.mjs`) so no caller can
  overwrite the cache with a headerless generation. Regression test added
  (`shared/telegram.test.mjs`). Files: `.github/workflows/on-demand-briefing.yml`,
  `scripts/sync-kv.mjs`, `shared/telegram.mjs`, `shared/telegram.test.mjs`.

### BUG-4 refinement — `/broadcast` mitigation is single-chunk only
- The `MAX_USERS=30` cap bounds fan-out under 50 subrequests **only** for a
  single-chunk broadcast. A message >4000 chars → `30 × chunks + 2` subrequests
  (e.g. 62 for 2 chunks) still exceeds the free-plan cap and drops later
  recipients. The `BUG-4 mitigated` regression test asserts the user-count bound
  only, not chunk count. Open. Fix: move broadcast to the Actions runner or cap
  broadcast length to one chunk.

**Date:** 2 July 2026 · **Scope:** Cloudflare Worker (webhook bot) + GitHub Actions briefing pipeline + shared markdown module
**Method:** full static architecture review, then 57 behavioral scenarios executed against the *real* worker code under a mocked Cloudflare runtime (KV / Durable Object with serialized RPC / fetch), Telegram failure injection, live link validation, and editorial review of today's actual briefing. Existing unit suite: 9/9 pass. Behavioral suite: 57 scenarios, 8 confirmed defects/risks total across all phases.

Harness: 57-scenario behavioral suite driving the worker code verbatim (only the `cloudflare:workers` import stubbed) under mocked KV/DO/fetch. Lives in the QA session scratchpad; porting it into `test/` is an open follow-up.

---

## Executive summary

The Worker is genuinely solid where Telegram bots usually fail: webhook auth fails closed, the allowlist/admin gating held against every bypass attempt (forged callbacks, chat/from-id confusion, group leakage, injection payloads, prototype tricks aimed at auth), redelivery dedup makes `/broadcast` safe, rate-limit reserve/rollback is correct, and HTML escaping survived hostile names and content. **No critical or security-high issues found.**

What actually breaks is the product promise (the briefing arriving) and content quality:

1. A garbage LLM generation silently marks the day "done" and blocks all retries (BUG-1).
2. Broadcast dies mid-loop past ~45 subscribers on the Workers free plan (BUG-4).
3. Today's real briefing contains a factual error and is mostly evergreen SEO content, not news (ED-1/ED-2).

**Quality score: 7.5/10** · **Production readiness: 82%** (at current scale; ~60% at 50+ subscribers)
**Verdict: CONDITIONAL GO** — ship for the current private user base after fixing BUG-1, BUG-2, BUG-3. NO-GO for open/scaled enrollment until BUG-4 and the delivery-throttling gap are addressed.

---

## Confirmed defects

### Must fix

**BUG-1 (High, reliability) — Failed generation poisons the daily idempotency check.** — **FIXED in `d2f647d`**
- Repro: `claude -p` exits 0 but outputs content without the `# Daily AI Recruitment Briefing —` header (refusal, preamble, partial). `force-briefing-date.mjs` can't rewrite the title, `send-briefing.mjs` correctly skips — but `update-usage-stats.mjs` runs unconditionally and sets `last_briefing_at = today`.
- Expected: failed day is retryable. Actual: subscribers get nothing; manual re-run skips ("already generated today").
- Root cause: stats step not gated on send/freshness. Fix: move `Update usage stats` after `Check freshness` and gate on `fresh == 'true'` (same as the KV sync step). File: `.github/workflows/daily-briefing.yml:67-71`.

**BUG-2 (Medium, reliability) — Daily and on-demand workflows can run concurrently.** — **FIXED in `d2f647d`**
- Repro: `/newbriefing` at 08:59 UTC overlaps the 09:00 cron. Both write `state/today_briefing.md`, both `git push` (loser fails non-fast-forward), KV writes interleave.
- Fix: same `concurrency.group` in both workflows; add `git pull --rebase` before push. Files: both workflow YAMLs.

**BUG-3 (Medium, correctness) — Prototype command names bypass the handler check: silent dead end + KV pollution.** *(harness C8, confirmed)* — **FIXED in `d2f647d`**
- Repro: send `/constructor` → `COMMAND_HANDLERS['constructor']` resolves to `Object.prototype.constructor` (truthy) → treated as a handler → no nudge, no reply at all. Worse, `bumpCommandCount` then stores `"function Object() { [native code] }1"` into `usage_stats.command_counts.constructor` in KV. `/toString`, `/valueOf`, `/hasOwnProperty`, `/__proto__` similar (silence via thrown-and-swallowed errors).
- Impact: no auth or data exposure (verified), but any user can silently corrupt stats and gets a dead-end UX.
- Fix: `const handler = m && Object.hasOwn(COMMAND_HANDLERS, m[1]) ? COMMAND_HANDLERS[m[1]] : null`, and same `Object.hasOwn` guard in `bumpCommandCount`. File: `worker/src/index.js:749,296`.

### Should fix

**BUG-4 (Medium at scale) — `/broadcast` exceeds the 50-subrequest cap on the Workers free plan.** *(harness S5)* 60 subscribers = 62 sequential `sendMessage` calls in one invocation; the Worker dies mid-loop past ~45–48, later recipients silently skipped (also applies to multi-chunk sends and to `/briefing`-during-broadcast retry inflation). Fix: move broadcast delivery to the Actions pipeline (like the daily send), or paginate via queues/alarm in the DO.

**BUG-5 (Low) — `/broadcast` with leading whitespace ships the command prefix to subscribers.** *(harness C10, confirmed: subscribers received `"  /broadcast payday"`)* The command regex matches on trimmed text but the strip regex runs on the raw text with `^` anchor. Fix: run the strip on the trimmed string. File: `worker/src/index.js:671`.

**BUG-6 (Low) — Stale Approve button re-adds a removed user.** *(harness F4c, confirmed)* Callback doesn't verify the target is still pending. Fix: in `handleCallbackQuery`, ignore `acc:Y:` when `!access.pending[targetId]`. File: `worker/src/index.js:725`.

**BUG-7 (Low) — `/adduser` doesn't clear the matching pending entry.** *(harness F15b, confirmed)* User approved by id lingers in `/pending` forever, and their name/username stay stored — contradicts the privacy model where approval deletes that info. Fix: call `removePending(id)` inside `addAllowedUser` or the handler.

**BUG-8 (Low) — Corrupted `usage_stats` KV bricks every command silently.** *(harness S3, confirmed)* `getJSON` throws on invalid JSON → error swallowed → user gets no reply for *all* commands. Only-JSON-writers make corruption unlikely, but the failure mode is total and invisible. Fix: try/catch in `getJSON` returning the fallback.

**Hardening / ops (from Phase 11):**
- **SEC-1:** Worker's `GITHUB_TOKEN` is a classic PAT with full `repo` scope; it only needs `repository_dispatch` on one repo. Compromise = push access everywhere. Use a fine-grained token (this repo, contents: read/write).
- **SEC-2:** `retry-after` honored at 0.3× (`retryAfter * 300` ms) — a 5s ask retries in 1.5s, guaranteeing a second 429. `worker/src/index.js:245`.
- **SEC-3:** No alerting — handler errors are `console.error` only; a dead bot looks identical to a quiet day. Consider a failure ping to the owner chat.
- Verified clean: no hardcoded secrets, no token leakage in logs, `.wrangler/` gitignored, webhook fails closed when secret unset, HTML injection blocked (hostile display names escaped in `/mydata`), owner gating on all 6 admin commands + callbacks, no confused-deputy via chat/from mismatch, SQL/shell/prompt-injection payloads inert, 100KB messages and zalgo/RTL handled.

### Nice to have
- Line >3500 chars without newlines splits mid-`<a>` tag → Telegram rejects both chunks (harness R6; unlikely with current prompt but delivery-fatal when hit). Make `chunk()` tag-aware or split at spaces.
- Pre-09:00-UTC `/briefing` always burns a paid generation instead of serving yesterday's briefing with a note (1 unnecessary run/day for MSK users).
- `/HELP`/`/Briefing` (any uppercase) get the "I only understand commands" nudge — lowercase `m[1]` before lookup.
- `/help` doesn't mention `/newbriefing` — the command is undiscoverable.
- No send-time dedup of subscriber ids (harness S4) — DO insert-guard is the only protection.
- Forwarding someone's `/status` message executes it as your own command (harness T7) — harmless today, worth knowing.
- Broadcast/daily-send scripts use bare `fetch` with no throttle or retry — at ~30 msg/s Telegram 429s and those recipients silently miss the briefing.

---

## Editorial review (Phase 8.6 / 16) — today's live briefing

All 10 links resolve (HTTP 200, spot-checked with browser UA). But:

- **ED-1 (factual error):** "EU AI Act obligations for general-purpose AI **began in August 2026**" — GPAI obligations began **August 2025**; and "began" + a future date is internally inconsistent. Source cited is an SEO stats aggregator, not a primary source.
- **ED-2 (staleness):** ~7 of 10 items are evergreen vendor guides/listicles (HeroHunt guide, MSH trends report, Bullhorn tool roundup, Paychex guide, Disher blog) — exactly the "old content-marketing pages" the prompt forbids. Only the Anthropic item reads like news.
- **ED-3:** Metaview cited twice (repeated source); no publish dates shown, so the reader can't judge freshness.

**Scores:** Editorial 5/10 · Completeness 4/10 · Insight 6/10 (bullets do carry "so what" clauses — good) · Readability 8/10 · Executive value 5/10.

**Prompt/retrieval fixes:** (1) add "every bullet must cite a story published in the last 7 days; include the publish date in parentheses; if you cannot verify a date, drop the item — a 3-bullet briefing beats a padded one"; (2) blacklist listicle/tool-roundup URLs patterns; (3) "never cite the same domain twice"; (4) "verify regulatory dates against a primary source or omit"; (5) add 1-2 news-specific queries ("AI recruitment news this week", site-scoped to HR press) alongside the current evergreen-attracting queries.

---

## Phase coverage map

| Phase | Status | Evidence |
|---|---|---|
| 1 Architecture | Done | Static review, 3 medium + 7 low findings |
| 2 Functional (all commands) | Done | Harness F1–F21: pass |
| 3 Conversation/hostile input | Done | C1–C10: 2 bugs (BUG-3, BUG-5) |
| 4 Telegram protocol edges | Done | T1–T7: dedup, groups, edits, media, ordering all clean |
| 5 Subscription logic | Done | S1–S5: concurrent-safe (with real DO semantics), BUG-4/8 found |
| 6 Authentication | Done | A1–A5 + F4/F4b/T4: no bypass found |
| 7 Claude prompt injection | Static only | Guard instruction present but advisory; residual risk accepted. Manual repro: seed a page with injection text, run on-demand workflow, inspect output |
| 8/8.5 Search+Telegram failures | Partial | Telegram side fully injected (R1–R4); WebSearch side is prompt-level (fallback briefing defined). Can't execute `claude -p` without spend |
| 8.6/16 Editorial | Done | Live briefing: 10/10 links OK, ED-1..3 |
| 9 Reliability | Analytical | Worker stateless; DO storage transactional; workflow kill-points → BUG-1/2 |
| 10 Performance | Analytical | Singleton DO serializes all updates (fine at this scale); subrequest cap is the real limit (BUG-4); 1000-user stress meaningless in mock |
| 11 Security | Done | SEC-1..3; clean list above |
| 12 Code quality | Done | Shared module extraction good; tests cover markdown only — port harness to repo |
| 13 UX | Done | Uppercase commands, hidden /newbriefing, silent dead ends (BUG-3/8) |
| 14 Regression | Done | Full suite re-run after harness fixes: 56 pass + 1 intentional bug-probe fail |

## Go / No-Go checklist

- Commands ✅ · Authentication ✅ · Telegram handling ✅ · Claude pipeline ⚠️ (BUG-1/2, ED-1/2) · Scheduler ⚠️ (BUG-2) · Persistence ✅ (DO design validated) · Error handling ⚠️ (silent failure modes) · Security ✅ (with SEC-1 hardening) · Performance ⚠️ (BUG-4 at scale) · Recovery ⚠️ (BUG-1) · Logging ⚠️ (no alerting) · UX ✅ minor · Documentation ✅

**CONDITIONAL GO** — fix BUG-1, BUG-2, BUG-3 before the next release; BUG-4 + throttling before any growth push; adopt the editorial prompt changes to make the product worth subscribing to.
