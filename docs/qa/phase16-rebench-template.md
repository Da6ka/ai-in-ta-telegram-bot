# Phase 16 Re-benchmark — Editorial Consistency (5 consecutive daily runs)

**Trigger:** run this before any growth push (raising `MAX_USERS`, public enrollment). Supersedes the single-dry-run Phase 16 in `2026-07-03-final-release-audit.md`, which measured ceiling, not consistency.

**Why 5 runs, not 1:** AUD-1 was a consistency defect — the same prompt produced a 7.5/10 dry-run and a 1-story prod edition the same evening. A subscriber judges the product by its worst day, so the benchmark scores the *floor*, not the best sample. One good run proves nothing.

**Inputs per run:** the composed `state/today_briefing.md` from a real daily workflow run (not a hand-triggered dry-run — we want the production path, including the AUD-1 gate). Record the commit and UTC generation time.

---

## Hard gates — binary, checked every run

A run **fails the release** if any gate is ✗ on any of the 5 days. These encode the AUD-1 fix and the prompt hard-filters; they are not judgment calls.

| # | Gate | Pass criterion |
|---|------|----------------|
| G1 | Reached the floor | `countBriefingItems()` ≥ `MIN_BRIEFING_ITEMS` (2). A thin run should have been *blocked* by the workflow — if a sub-floor edition reached subscribers, that's a gate failure, not a low score. |
| G2 | Target coverage | ≥ 4 linked story items (the prompt's minimum-coverage loop target). 2–3 is a pass on G1 but a ⚠️ to note. |
| G3 | Every bullet dated | Each story carries a date within the past ~48h. No evergreen/undated items. |
| G4 | Links resolve | Every link returns 2xx/3xx (bot-block 403s like Stanford noted, not counted as dead — verify by fetch). |
| G5 | Distinct domains | No duplicate source domain across items; ≥ 4 distinct domains when ≥ 4 items. |
| G6 | Source tiering respected | No stock-analysis / SEO-aggregator domain used as the *primary* source for a product claim (prompt #3). |
| G7 | Bottom line present | Closing `**Bottom line:**` synthesis sentence exists and references the day's items (prompt #4). |
| G8 | No fallback served silently | If the "No briefing available today" fallback was produced, the stale-or-thin alert fired and the day stayed retryable (AUD-1). |

---

## Editorial scores — 1–10 per dimension, per run

Same rubric as the original Phase 16 so scores are comparable to the 7.5 / 7 / 6.5 / 8.5 / 7 baseline.

| Dimension | What moves it up | Baseline (dry-run) |
|-----------|------------------|--------------------|
| Editorial quality | real news, clean structure, no filler, no weak sources | 7.5 |
| Completeness | right beats covered (launches, research, vendor/ATS, regulation, funding/M&A) | 7 |
| Insight | each "so what" is a real take, not formulaic ("relevant for teams…") | 6.5 |
| Readability | under 2 min, scannable, consistent format | 8.5 |
| Executive value | a TA/HR leader would act on or watch ≥ 1 item | 7 |

---

## Scorecard (fill in)

| Run | Date (UTC) | Commit | Items | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | Edit | Compl | Insight | Read | Exec |
|-----|-----------|--------|-------|----|----|----|----|----|----|----|----|------|-------|---------|------|------|
| 1 | | | | | | | | | | | | | | | | |
| 2 | | | | | | | | | | | | | | | | |
| 3 | | | | | | | | | | | | | | | | |
| 4 | | | | | | | | | | | | | | | | |
| 5 | | | | | | | | | | | | | | | | |

---

## Verdict rule

- **PASS (clear for growth):** all 8 hard gates ✗-free across all 5 runs **and** the *minimum* (not average) of each editorial dimension is ≥ 6. Report the floor, not the mean — e.g. "Insight 6–8, worst day 6."
- **CONDITIONAL:** gates all pass but one editorial dimension dips below 6 on a single day → note it, ship if the dip isn't Executive value or Completeness.
- **FAIL:** any hard gate fails on any day, or two+ runs land at 2–3 items (G2 ⚠️) → the minimum-coverage loop isn't holding; re-tune the prompt search fan-out before re-running.

Log the completed table as `docs/qa/YYYY-MM-DD-phase16-rebench.md` and link it from the release-gate checklist.
