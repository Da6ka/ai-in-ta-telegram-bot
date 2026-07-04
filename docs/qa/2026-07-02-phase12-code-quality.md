# Phase 12 — Code Quality Review

**Date:** 2 July 2026 · **Scope:** `worker/src/index.js`, `scripts/*.mjs`, `shared/*.mjs`, `test/*`, workflows, README
**Method:** static read of all 1201 LOC of source, duplication grep, test-coverage mapping, and doc-accuracy check against the current (post-Durable-Object) architecture. Baseline: `npm test` 75/75 green.

---

## Executive summary

The code is **well above average for a solo project**: the shared markdown module is properly extracted and unit-tested, the Durable Object methods are small and single-purpose, error handling follows one consistent swallow-log-and-continue idiom, naming is clear, and the "why" comments are genuinely load-bearing (the `Object.hasOwn` rationale, the content-before-pointer KV ordering, the DO-serialization argument). The behavioral suite drives the *real* Worker source rather than a reimplementation, and honest `KNOWN BUG-n` tests track debt instead of hiding it.

The findings are all **low-to-medium maintainability** issues, and they cluster on one theme: **the delivery-pipeline scripts are second-class citizens** — duplicated logic, no shared resilience with the Worker, and no tests. That's also why the real defects in Phases 9–11 (no send throttle/retry, no checkpoint, freshness inconsistency) live in exactly those scripts. Fixing CQ-2 and CQ-4 would retire a chunk of that cross-phase debt at once.

**No release-blocking quality issue.**

---

## Findings

### CQ-4 (Medium) — Delivery-pipeline scripts have zero test coverage
The 66-scenario behavioral suite thoroughly covers the Worker, and `shared/telegram-markdown` has its own tests — but **six scripts have no tests at all**: `send-briefing.mjs`, `send-to-chat.mjs`, `sync-kv.mjs`, `update-usage-stats.mjs`, `force-briefing-date.mjs`, `set-commands.mjs`. These are precisely where the Phase 9/10/11 defects live (no send checkpoint, no throttle/retry, on-demand freshness gap, unguarded parses). The pure logic is eminently testable with a mocked `fetch`/`fs`: the freshness gate (`send-briefing.mjs:49`), the date-forcing regex (`force-briefing-date.mjs:15`), the stats increment, the KV write ordering. **Highest-value quality fix** — it would have caught most of the earlier findings.

### CQ-2 (Low–Medium) — Three divergent Telegram-call implementations; scripts don't share the Worker's resilience
There are three separate ways the codebase calls the Telegram API:
- Worker `tg()` → `fetchWithRetry` with 429/5xx backoff + chunking (`worker/src/index.js:238-288`)
- `set-commands.mjs` → its own `tg()` (`:44-53`), throws on failure
- `send-briefing.mjs` / `send-to-chat.mjs` → inline bare `fetch`, **no retry**, `console.error` only

This isn't just duplication — it's the **root cause** of PERF-3 and the Phase 9 send-reliability gaps: the hardened send path already exists in the Worker but was never shared with the runner scripts, so the daily/on-demand sends silently drop on 429. Fix: a `shared/telegram.mjs` exporting `tgCall(method, body, {retries})` + `sendMessageChunked(...)` with the backoff, imported by the Worker and all scripts. One implementation, one place to fix rate-limit handling.

### CQ-1 (Low) — `usage_stats` shape and increment logic duplicated across three files
The default shape `{ briefings_sent: 0, last_briefing_at: null, briefing_history: [], command_counts: {}, last_seen: {} }` is hardcoded in `worker/src/index.js:64-70` (`DEFAULT_USAGE`), `scripts/sync-kv.mjs:37`, and `scripts/update-usage-stats.mjs:11`. The increment (`briefings_sent + 1`, set `last_briefing_at`, `briefing_history.slice(-30)`) is copy-pasted between `sync-kv.mjs:38-43` and `update-usage-stats.mjs:18-20` — and **both run in the same daily workflow**, applying the identical mutation to two stores (file + KV). A change to one (e.g. `slice(-30)` → `slice(-60)`) silently drifts the two representations. Fix: extract `shared/usage-stats.mjs` with `defaultUsage()` and `recordBriefing(stats, {date, recipients})`.

### CQ-3 (Low) — `send-briefing.mjs` and `send-to-chat.mjs` duplicate the send loop
Both files contain the same chunk → `fetch(sendMessage)` → error-log loop, differing only in "every subscriber" vs "one chat" (`send-briefing.mjs:59-75` vs `send-to-chat.mjs:18-32`). Collapses cleanly into the `sendMessageChunked` helper proposed in CQ-2.

### CQ-5 (Low) — README documents the pre-Durable-Object architecture
`README.md:50` states `access`, `subscribers`, `usage_stats`, … all "live in a Cloudflare KV namespace bound as `BOT_STATE`". Since the DO refactor, `access` and `subscribers` are owned by the `BotState` Durable Object and only *mirrored* to KV — the file's own header comment (`worker/src/index.js:9-19`) is the correct description. Update the README to match, so the next reader doesn't reason about concurrency from the stale model. (Line 72's "`GITHUB_TOKEN` needs `repo` scope" also reinforces the over-privileged PAT flagged as SEC-1 — worth softening to the fine-grained scope.)

---

## Strengths (verified, worth preserving)

- **Shared module done right:** `shared/telegram-markdown.mjs` is imported by both the Worker and the scripts and has its own test file — the correct pattern that CQ-1/CQ-2/CQ-3 should follow for the remaining duplication.
- **Cohesive Durable Object:** each `BotState` method does one thing and completes its storage writes before external I/O — the design comment explaining *why* that's atomic is exactly the kind of comment that should exist.
- **Consistent error idiom:** the Worker's "check response, log, degrade gracefully, never throw to the user" pattern is applied uniformly.
- **Tests over the real thing:** the suite runs the actual Worker source (only the `cloudflare:workers` import is stubbed), so it catches real regressions, and `KNOWN BUG-n` tests document open debt honestly.
- **Comment quality:** the non-obvious decisions (prototype-pollution guard, content-before-pointer ordering, rate-limit reserve/rollback, retention sweep) are all explained at the point of use.

---

## Summary

| ID | Sev | Finding | Fix |
|---|---|---|---|
| CQ-4 | Medium | Delivery scripts have no tests (where the real defects live) | Unit-test the pure logic with mocked fetch/fs |
| CQ-2 | Low–Med | 3 divergent Telegram-call impls; scripts lack the Worker's retry/backoff | `shared/telegram.mjs` used everywhere |
| CQ-1 | Low | `usage_stats` shape + increment duplicated in 3 files | `shared/usage-stats.mjs` |
| CQ-3 | Low | Send loop duplicated across the two send scripts | Fold into the CQ-2 helper |
| CQ-5 | Low | README describes pre-DO architecture | Update state-ownership description |

**Net:** the Worker is clean, well-commented, and well-tested; the maintainability debt is concentrated in the delivery scripts, where duplication and a coverage gap coincide with the reliability/perf findings from the earlier phases. The single highest-leverage move is CQ-2 + CQ-4 together — extract one resilient, shared, *tested* Telegram-send helper — which simultaneously reduces duplication (CQ-1/CQ-3), closes the coverage hole (CQ-4), and gives PERF-3 / the Phase 9 send gaps a natural home to be fixed. No blocker to release.
