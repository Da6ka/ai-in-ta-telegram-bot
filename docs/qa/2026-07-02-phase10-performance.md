# Phase 10 — Performance & Stress Audit

**Date:** 2 July 2026 · **Scope:** Cloudflare Worker + singleton Durable Object + KV, and the Actions delivery path
**Method:** the real worker source (`worker/src/index.js`) driven under the behavioral suite's CF mock (in-memory KV, singleton `BotState` DO with serialized RPC, instrumented `fetch`). Network is stubbed, so measured CPU/wall is the **pure JS cost** that maps to Cloudflare's per-request CPU budget, and the `fetch` count **is** the subrequest count — the real production ceiling. Stress run at 10 / 50 / 100 / 500 / 1000 users. Harness: `perf-stress.mjs` (QA scratchpad).

> **Reading the numbers.** Absolute milliseconds below are inflated by Node's JIT + ESM-reparse overhead; Cloudflare V8 isolates run this materially faster. Trust the **ratios, scaling curves, subrequest counts, and complexity classes** — those transfer to production; the raw ms do not.

---

## Executive summary

CPU, memory, and state footprint are **non-issues at every tested scale** — the bot is I/O-bound, not compute-bound. Every command costs <0.3 ms CPU and the whole system holds a few KB of state per thousand users. Performance is governed entirely by **external-call fan-out**, and there are exactly three ceilings, in the order you hit them as the subscriber list grows:

1. **PERF-1 — `/broadcast` subrequest cap:** ~48 subscribers on the Workers free plan, ~998 on paid. (Quantifies the release-gate's BUG-4.)
2. **PERF-3 — daily-send Telegram rate limit:** past ~30 subscribers the un-throttled sender starts eating 429s and silently drops recipients.
3. **PERF-2 — O(N²) subscriber mutation on the singleton DO:** every subscribe/unsubscribe re-clones and re-serializes the *entire* list; a burst of 1000 signups is ~240 ms of serialized DO CPU. Not fatal at current scale, but it is the long-term growth ceiling.

**Verdict: GO at current scale** (2 accounts, both the owner's). The measured headroom is enormous for the private user base. **NO-GO for open enrollment past ~30–50 subscribers** until PERF-1 and PERF-3 are addressed (both already have the right fix: move fan-out delivery to the Actions runner and add throttle/retry). PERF-2 is a refactor to schedule before four-digit subscriber counts, not an emergency.

---

## A. Startup

| Metric | Measured | Production reading |
|---|---|---|
| Worker module import + eval | ~60 ms (Node) | One-time isolate cold start; single ~800-line file. On CF V8 this is ~a few ms. Negligible. |
| Cold first request (DO migrates `access` from KV) | ~43 ms (Node, JIT-warmup-inflated) | First touch of the singleton DO runs the KV→DO migration once, then it's hydrated for the isolate's life. One-time. |
| Warm request | 0.40 ms | Steady state. |

Startup is not a concern. The DO's KV-migration-on-first-touch (`worker/src/index.js:83-92`) runs once per DO lifetime, not per request. **The real "startup" latency users feel is briefing *generation* — a `claude -p` run of ~1–3 min on the Actions runner — which is independent of user count and covered under API usage.**

## B. Per-command latency & CPU (median of 200 warm runs, network stubbed)

| Command | Wall (ms) | CPU (ms) | Subrequests |
|---|---|---|---|
| `/status` | 0.076 | 0.116 | 1 |
| `/start` (new user, notifies owner) | 0.219 | 0.293 | 1 |
| `/subscribe` (+`/unsubscribe`) | 0.135 | 0.138 | 2 |
| `/briefing` (cached, 5-story md) | 0.057 | 0.058 | 1 |
| `/admin` (owner panel) | 0.052 | 0.053 | 1 |

Every handler is **~2 orders of magnitude under the 10 ms free-plan CPU limit**. The markdown pipeline (`mdToHtml`/`chunk`/`escapeHtml`) does not register. **Real user-perceived latency is network:** one DO RPC round-trip (~1–5 ms) plus each Telegram `sendMessage` (~50–150 ms). CPU is never the bottleneck.

## C. `/broadcast` fan-out @ scale — the subrequest ceiling

One `/broadcast` = **N+2** Telegram `sendMessage` calls in a *single* Worker invocation. Cloudflare caps subrequests at **50 (free) / 1000 (paid)**.

| Users | Subrequests | Wall (ms) | CPU (ms) | Peak heap (MB) | Verdict |
|---|---|---|---|---|---|
| 10 | 12 | 0.5 | 1.8 | 7.3 | OK |
| 50 | 52 | 0.8 | 2.0 | 7.8 | **OVER free cap** |
| 100 | 102 | 1.3 | 2.5 | 8.4 | OVER free cap |
| 500 | 502 | 6.0 | 7.5 | 9.6 | OVER free cap |
| 1000 | 1002 | 11.5 | 13.8 | 8.2 | **OVER free cap + OVER paid cap** |

- **PERF-1 (confirmed):** crosses the free cap at **48 subscribers** (48+2=50) and the paid cap at **998**. Past the cap the Worker is killed mid-loop and later recipients are silently skipped — this is BUG-4 from the release gate, now quantified. Fix (already recommended): deliver broadcasts from the Actions runner like the daily send, or paginate via a DO alarm.
- Heap stays flat (~8 MB) and CPU trivial — the cap bites long before compute does.

## D. Concurrent-command throughput — singleton DO serialization

N distinct users hitting `/subscribe` simultaneously, all serialized through the one `singleton` DO instance:

| Users | Total (ms) | ms/op | ops/sec |
|---|---|---|---|
| 10 | 0.6 | 0.057 | 17,635 |
| 50 | 2.8 | 0.056 | 17,754 |
| 100 | 6.5 | 0.065 | 15,310 |
| 500 | 80.1 | 0.160 | 6,245 |
| 1000 | 238.1 | 0.238 | 4,200 |

- **PERF-2 (confirmed — O(N²)):** per-op cost rises from 0.057 ms → 0.238 ms and total wall grows **super-linearly** (10× users → ~37× time). Root cause: every `subscribe`/`unsubscribe` calls `getSubscribers` (clones the whole array), scans it with `includes` (O(N)), `put`s it back (clones again), then `mirrorSubscribers` `JSON.stringify`s the entire list for the KV mirror (`worker/src/index.js:148-177`). That's O(N) per mutation × N mutations = **O(N²)**, all on the single serialized DO. At 1000 concurrent signups the DO is compute-blocked ~240 ms.
- Harmless at today's scale; the fix (a `Set`-backed membership check, or storing subscribers keyed rather than as one re-serialized array) matters only before four-digit lists. Note this is *compute* serialization — separate from, and much cheaper than, the subrequest cap in §C.

## E. State / memory footprint

| Users | `subscribers` JSON | `usage_stats.last_seen` JSON | DO in-mem array |
|---|---|---|---|
| 10 | 121 B | 235 B | 0.1 KB |
| 50 | 481 B | 1.1 KB | 0.4 KB |
| 100 | 931 B | 2.2 KB | 0.8 KB |
| 500 | 4.5 KB | 11 KB | 3.9 KB |
| 1000 | 9.0 KB | 22 KB | 7.8 KB |

Memory is a **non-issue**: 1000 users = ~9 KB of subscriber state and ~22 KB of activity log, both far under KV's 25 MB value limit and the DO's storage limits; Worker isolate heap stayed ~8 MB throughout §C. The `seen_updates` ring is hard-capped at 200 (`worker/src/index.js:221`), and `last_seen` is pruned to 90 days (`:308`), so neither grows unbounded.

## F. API usage per operation

| Operation | Claude | GitHub | Telegram | Constraint |
|---|---|---|---|---|
| Daily briefing (cron) | 1 `claude -p` gen | — | N `sendMessage` | Runner: no subrequest cap; bound by Telegram ~30 msg/s |
| `/newbriefing` | 1 gen (on runner) | 1 `repository_dispatch` (Worker) | 1 send | 60-min global cooldown + 3/day/user cap |
| `/briefing` (cached) | 0 | 0 | ⌈html/3500⌉ sends | Subrequest cap (few chunks) |
| `/broadcast` | 0 | 0 | N+2 sends (one invocation) | **Subrequest cap (§C)** |

**Daily-send wall time under Telegram's ~30 msg/s limit** (`scripts/send-briefing.mjs`, bare `fetch`, no throttle/retry):

| Users | Send duration | Note |
|---|---|---|
| 10 | ~0.3 s | fine |
| 50 | ~1.7 s | starts brushing the rate limit |
| 100 | ~3.3 s | 429s likely; **dropped recipients silently skipped** |
| 500 | ~16.7 s | many drops |
| 1000 | ~33.3 s | many drops |

- **PERF-3:** `send-briefing.mjs:59-75` fires `sendMessage` in a tight loop with no delay and no retry on 429; on a `!res.ok` it only `console.error`s. Past ~30 subscribers Telegram will 429 and those recipients **miss the briefing with no retry**. Fix: add a ~30 msg/s pacer and honor `retry-after` (the Worker already has `fetchWithRetry` — the scripts don't).

---

## Findings summary

| ID | Sev | Finding | Bites at | Fix |
|---|---|---|---|---|
| PERF-1 | Med@scale | `/broadcast` = N+2 subrequests in one invocation; exceeds Cloudflare cap | 48 (free) / 998 (paid) subscribers | Move broadcast to Actions runner or DO-alarm pagination |
| PERF-2 | Low | O(N²) subscriber mutation on singleton DO (whole-array clone+stringify per op) | ~1000s of subscribers / signup bursts | Set-backed membership; avoid re-serializing full list |
| PERF-3 | Med@scale | Daily-send has no throttle/retry; silent 429 drops | ~30+ subscribers | ~30 msg/s pacer + honor retry-after |

**Non-issues (verified with headroom):** startup, per-command CPU (<0.3 ms vs 10 ms cap), memory (~8 MB heap, <25 KB state @ 1000), state growth (ring-capped + 90-day pruned).

**Net:** the architecture is correctly I/O-bound and the compute/memory budgets are nowhere near their limits. Everything that breaks at scale is **outbound-message fan-out** — the subrequest cap (PERF-1) and the Telegram rate limit (PERF-3) — both of which the codebase already knows how to solve (the daily *generation* path proves the runner pattern; the Worker's `fetchWithRetry` proves the backoff pattern). Apply those two patterns to the two delivery paths before opening enrollment.
