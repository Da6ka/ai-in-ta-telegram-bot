# Prompt Re-benchmark — Editorial Consistency (5 consecutive daily runs)

**When to use this:** any time you materially change `briefing-prompt.md` or `briefing-prompt-ondemand.md`'s editorial behavior (search fan-out, gating, tone, source rules) and want confidence the change didn't regress quality before it reaches subscribers unattended for another few weeks. Not limited to growth pushes (raising `MAX_USERS`, public enrollment) — run it after *any* prompt change worth re-validating, not just those.

This generalizes the original Phase 16 re-benchmark (`phase16-rebench-template.md`, 2026-07-03/07-11), which measured consistency after a specific search-fan-out fix. The mechanism (5-run window, hard gates, editorial scores, auto-logging) is reusable as-is — only the trigger and naming were specific to that one change.

**Why 5 runs, not 1:** a single dry-run proves nothing — the original Phase 16 issue (AUD-1) was a *consistency* defect where the same prompt produced a 7.5/10 dry-run and a 1-story prod edition the same evening. A subscriber judges the product by its worst day, so this benchmarks the *floor*, not the best sample.

**Inputs per run:** the composed `state/today_briefing.md` from a real daily workflow run (not a hand-triggered dry-run — you want the production path, including the content-freshness gate). Record the commit and UTC generation time.

---

## Hard gates — binary, checked every run

A run **fails the release** if any gate is ✗ on any of the 5 days. These are not judgment calls.

| # | Gate | Pass criterion |
|---|------|----------------|
| G1 | Reached the floor | `countBriefingItems()` ≥ `MIN_BRIEFING_ITEMS` (2). A thin run should have been *blocked* by the workflow — if a sub-floor edition reached subscribers, that's a gate failure, not a low score. |
| G2 | Target coverage | ≥ 4 linked story items (the prompt's minimum-coverage loop target). 2–3 is a pass on G1 but a ⚠️ to note. |
| G3 | Every bullet dated | Each story carries a date within the past ~48h. No evergreen/undated items. |
| G4 | Links resolve | Every link returns 2xx/3xx (bot-block 403s noted, not counted as dead — verify by fetch). |
| G5 | Distinct domains | No duplicate source domain across items; ≥ 4 distinct domains when ≥ 4 items. |
| G6 | Source tiering respected | No stock-analysis / SEO-aggregator domain used as the *primary* source for a product claim. |
| G7 | Bottom line present | Closing `**Bottom line:**` synthesis sentence exists and references the day's items. |
| G8 | No fallback served silently | If the "No briefing available today" fallback was produced, the stale-or-thin alert fired and the day stayed retryable. |

---

## Editorial scores — 1–10 per dimension, per run

Comparable to the original Phase 16 baseline (7.5 / 7 / 6.5 / 8.5 / 7), so scores stay comparable across benchmark windows over time.

| Dimension | What moves it up |
|-----------|------------------|
| Editorial quality | real news, clean structure, no filler, no weak sources |
| Completeness | right beats covered (launches, research, vendor/ATS, regulation, funding/M&A) |
| Insight | each "so what" is a real take, not formulaic ("relevant for teams…") |
| Readability | under 2 min, scannable, consistent format |
| Executive value | a TA/HR leader would act on or watch ≥ 1 item |

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

- **PASS:** all 8 hard gates ✗-free across all 5 runs **and** the *minimum* (not average) of each editorial dimension is ≥ 6. Report the floor, not the mean — e.g. "Insight 6–8, worst day 6."
- **CONDITIONAL:** gates all pass but one editorial dimension dips below 6 on a single day → note it, ship if the dip isn't Executive value or Completeness.
- **FAIL:** any hard gate fails on any day, or two+ runs land at 2–3 items (G2 ⚠️) → the minimum-coverage loop isn't holding; re-tune the prompt before re-running.

Log the completed table as `docs/qa/YYYY-MM-DD-rebench.md`, noting in the filename or a heading what change triggered this window (e.g. "rebench after tightening source-tiering rule").

---

## Automated row logging

The daily workflow can auto-log the scriptable columns so you don't run the scorer by hand each morning:

1. Turn it on once: `gh variable set REBENCH --body on`
2. Each of the **next 5 daily editions** posts its scorer output (item count, gates G1–G5/G7, domain dedup — G4 skipped in CI via `--no-fetch`) as a numbered `N/5` comment on the auto-created tracking issue **"Prompt re-benchmark — 5-run log"**. Thin/stale days are logged too (that's the worst-day case the floor scores).
3. **Logging is self-limiting** — the step counts rows already in the issue and stops after the 5th, posting a "5/5 complete" note. It never re-triggers, so leaving the variable on is harmless; unset it whenever you like.
4. Fill G6/G8 and the five editorial 1–10 scores on each comment by hand, apply the verdict rule, and commit the final table.

The step is `continue-on-error` — a logging hiccup never fails the briefing job or fires the owner alert. Because it counts *editions logged* rather than calendar days, a skipped run (idempotency/failure) just defers that slot to the next successful edition — you always get 5 real rows.

**Re-running for a new change:** if a tracking issue from a previous window is still open (all 5 rows logged, verdict applied, but never closed), close it before setting `REBENCH=on` again — the workflow searches for an *open* issue with this exact title and will keep appending to the old one otherwise.
