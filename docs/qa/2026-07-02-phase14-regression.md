# Phase 14 — Regression & Consolidated Audit Status

**Date:** 2 July 2026 · **Scope:** full-suite regression after the Phase 9–13 audit and the Phase 13 UX fixes, plus a consolidated open-findings register across every phase.
**Method:** `node --check` on all sources + `npm test` on both the `main` baseline and the integrated `fix/phase13-ux-polish` tip; verified the `KNOWN BUG-n` markers still pass (they assert current buggy behavior on purpose, tracking open debt), and that the UX fixes introduced no regressions.

---

## Regression result

| State | Sources parse | Suite |
|---|---|---|
| `main` (pre-fix baseline) | ✅ all | **75 / 75 pass** |
| `fix/phase13-ux-polish` (UX-1…5 + broadcast-case) | ✅ all | **77 / 77 pass** |

- The UX fixes added **2 net tests** (F2c deny-notification, F17b capitalized `/Broadcast` strip) and **broke nothing** — every prior behavioral, auth, protocol, concurrency, and failure-injection scenario still passes.
- The previously-fixed release-gate bugs stay fixed: **BUG-3** (prototype-name dispatch) is still guarded (C8 green); **BUG-1/BUG-2** are workflow-level (freshness-gated stats, shared concurrency group) and unchanged.
- Newly caught *by* this cycle: making dispatch case-insensitive (UX-1) surfaced a latent case-sensitive `/broadcast` prefix strip that would have leaked the literal command to subscribers — fixed with the `i` flag + regression test before it could ship.
- The six intentional `KNOWN BUG` / `L6` tests still pass, i.e. those findings remain open by design (not silently regressed).

**No regressions. Suite green.**

---

## Consolidated open-findings register (all phases)

### Fixed this audit cycle ✅
- **UX-1** case-insensitive commands · **UX-2** `/help` lists `/newbriefing` · **UX-3** admin ids in `<code>` · **UX-4** denied users notified · **UX-5** "Approved" wording · **+** case-insensitive `/broadcast` strip. *(on `fix/phase13-ux-polish`)*
- Earlier same-session: **BUG-1/2/3** (release gate), editorial prompt overhaul (ED-1..3).

### Open — priority (address before opening enrollment / next release)
| ID | Sev | Finding | Cheapest fix |
|---|---|---|---|
| SEC-4 / BUG-8 | Med | Unguarded `getJSON` `JSON.parse` → one corrupt `usage_stats` silently bricks **every** command | one try/catch → fallback |
| REL-1 | Med | Partial send has no checkpoint → duplicate delivery on retry | per-run delivered cursor / idempotency marker |
| PERF-3 | Med | Daily-send has no throttle/retry → silent 429 drops past ~30 subs | ~30 msg/s pacer + honor `retry-after` |
| PERF-1 / BUG-4 | Med@scale | `/broadcast` = N+2 subrequests, exceeds CF cap at 48 (free)/998 (paid) | move fan-out to the Actions runner |
| REL-2 | Med | DO→KV subscriber mirror non-atomic; a kill can leave an **erased** user on the send list | reconcile send list against DO / retryable mirror |
| SEC-1 | Med | Deploy `GITHUB_TOKEN` is a full-`repo` classic PAT | fine-grained, single-repo token |

> Note the cluster: **REL-1 + PERF-3 + CQ-2** all resolve together by extracting one shared, resilient, tested Telegram-send helper (`shared/telegram.mjs`) and using it in the runner scripts. Single highest-leverage change.

### Open — lower priority
| ID | Sev | Finding |
|---|---|---|
| REL-3 | Med | Killed generation run doesn't release its cooldown/daily-cap reservation |
| REL-4 | Med | On-demand path lacks the daily path's freshness guard (`send-to-chat.mjs`) |
| PERF-2 | Low | O(N²) subscriber mutation on the singleton DO (whole-array re-serialize per op) |
| SEC-2 | Low | `Retry-After` under-waited 3.3× (`retryAfter * 300` ms) |
| SEC-5 | Low | `chat_id` not numeric-validated at the Worker boundary before dispatch |
| CQ-4 | Med | Delivery-pipeline scripts have **no** tests (where the real defects live) |
| CQ-1/CQ-3 | Low | `usage_stats` shape/increment + send loop duplicated across files |
| CQ-5 | Low | README describes the pre-Durable-Object state model |
| BUG-5 | Low | `/broadcast` with **leading whitespace** still ships the prefix (distinct from the case fix) |
| BUG-6 | Low | Stale Approve button re-adds a removed user |
| BUG-7 | Low | `/adduser` doesn't clear the matching pending entry |
| L6 | Low | A single line >3500 chars with markup splits mid-tag |
| SEC-3 | Low | No alerting — a dead bot looks like a quiet day |

---

## Final verdict

**Regression: PASS. Release: GO for the current private, single-operator deployment** (2 accounts, both the owner's).

No critical or high-severity defect exists at the current trust boundary, and nothing in the Phase 9–13 findings blocks release at this scale — they degrade gracefully to "one missed briefing," "a duplicate message," or "slightly-off admin stats," not data loss or auth bypass. The architecture's foundations are sound: secret-gated webhook that fails closed, DO-serialized auth/subscriber state, isolated WebSearch-only generation, private repo with aggregate-only committed state.

**Before opening enrollment beyond ~30–50 subscribers**, do the priority block above — in practice two changes cover most of it: (1) the shared resilient send helper (closes REL-1, PERF-3, and CQ-2 at once, and is where PERF-1's runner-side fan-out belongs), and (2) the one-line `getJSON` guard (SEC-4). Scope down the deploy PAT (SEC-1) whenever convenient.

**Phase coverage complete: 1–14.**
