# Final Release Audit — 2026-07-03

**Scope:** full repo at `6280fcc` — Worker (`worker/src/index.js`), shared send/markdown modules, all 4 GitHub Actions workflows, all 8 runner scripts, wrangler config, test suite, and a live end-to-end generation with the production on-demand prompt (output kept local, sent to no one).

**Method:** adversarial static review of every source file; full test suite executed (86/86 pass); targeted unit probes against gaps the suite doesn't cover; live `claude -p` dry-run of `briefing-prompt-ondemand.md` with WebSearch; HTTP validation of the generated links; editorial benchmark of the last three committed briefings plus the fresh one.

---

## Verdict: **GO** (conditional pass) for the current deployment — private, allowlist-gated, ≤30 users

- No Critical findings. No High findings. All previously reported Highs (NEW-1 cache poisoning, BUG-1..8, SEC-2, L6) are verified fixed in the current tree, with regression tests present and green.
- The security posture is genuinely strong for a Telegram bot: webhook secret fails closed (A1–A3 verified), all admin/owner gating held in tests including forged callbacks and prototype-pollution command names, broadcast payloads never touch a shell, HTML output is escaped everywhere user-controlled strings appear, and the update-dedup ring makes redelivered `/broadcast` safe.
- The reliability layer is real: DO-serialized state (no KV read-modify-write races on anything that matters), reserve/rollback rate limiting, retries honoring Retry-After, paced fan-out on the runner, freshness gates on both briefing workflows, cache-poisoning guard in `sync-kv.mjs`, and owner alerting on failure and stale generation.

Conditions / fast-follows below (1 Medium, 3 Low). None blocks release at this scale.

---

## New findings (this audit)

### AUD-1 (Medium, product/reliability) — No minimum-content gate: thin or empty briefings are cached and lock out retries
- **Evidence:** the briefing currently in prod (`state/today_briefing.md`, commit `5c1e9f3`, generated 21:32 UTC with the *hardened* prompt) contains exactly **one story**. It passed `isValidBriefing` (header present), passed the freshness grep (dated today), was synced to KV, and is served to every `/briefing` until the next run.
- Worse case: the prompt's sanctioned "No briefing available today" fallback **also** passes both gates (verified: `isValidBriefing(fallback) === true`, and its title contains today's date so `fresh=true`). On the daily path that sends the fallback to all subscribers, advances `last_briefing_at`, and the idempotency check then blocks every retry for the rest of the day — with no owner alert, because nothing "failed".
- **Fix (implemented same session):** `countBriefingItems()` counts linked story bullets; `MIN_BRIEFING_ITEMS = 2` is the floor. Daily: the content check now runs *before* the send and requires dated-today AND ≥ 2 items, else skip send/stats/KV and fire the stale-or-thin alert (day not marked done, so a re-run can deliver). On-demand: a zero-story generation is treated as stale; a 1-story one still goes to the requester but `sync-kv.mjs` refuses to cache anything under the floor. The prompts additionally aim for ≥ 4 items via a minimum-coverage search loop.

### AUD-2 (Low, delivery) — `chunk()` protects `<a>` pairs but not `<b>` pairs
- **Repro (executed):** a single line >3500 chars whose chunk boundary lands inside a `<b>…</b>` span with internal spaces yields two chunks with unbalanced `<b>` — Telegram rejects both ("can't parse entities"), so that part of the briefing silently fails for the recipient.
- **Likelihood:** low — bullets are 1–2 sentences and headers are short lines — but it's the same class as the already-fixed L6.
- **Fix:** generalize the existing anchor-balance check in `shared/telegram-markdown.mjs` to `<b>` (and any future tag) by backing the cut up to the last unclosed open tag.

### AUD-3 (Low, delivery) — A queued broadcast can be silently replaced under GitHub's concurrency rules
- With `concurrency: group: broadcast` and `cancel-in-progress: false`, GitHub keeps only the **latest pending** run: broadcast #1 running, #2 queued, #3 arrives → #2 is cancelled. Cancelled ≠ `failure()`, so the "Notify owner on failure" step never fires — the owner was told "Broadcasting to N…" for #2 but it never went out.
- **Likelihood:** requires three `/broadcast`s inside ~a minute, owner-only. The briefing group is effectively immune (the 1-hour cooldown prevents a second queued run).
- **Fix (implemented same session):** removed the concurrency group from `broadcast.yml`. Serialization was protecting against nothing real — each run is paced under the Telegram rate limit and retries 429s honoring Retry-After, so overlapping runs deliver slightly slower but never drop a message, whereas the group could silently drop a whole broadcast.

### AUD-4 (Info) — minor accepted behaviors, documented for the record
- `recordSeenUpdate` marks an update seen *before* handling: if the isolate dies mid-handling (exceptions are caught, so this is rare), Telegram's redelivery is dropped. Correct tradeoff vs. re-running non-idempotent commands — leave as is.
- If the KV mirror write inside `subscribe()` throws, the user is subscribed but gets no confirmation reply (top-level catch swallows it). Cosmetic.
- Daily workflow sends to subscribers before stats/KV sync; if sync fails, a manual same-day re-run re-sends to everyone (the failure alert does fire, so the owner decides). Acceptable.
- Webhook secret comparison is not constant-time. Not realistically exploitable over HTTPS with 401 + Telegram-source traffic; no action needed.
- `/help` and `/privacy` from unapproved users write `last_seen` — covered by the privacy notice's activity-log clause and the 90-day sweep. Consistent.

### Verified non-issues (attacked, held)
- Forged approve/deny callbacks, chat-id/from-id confusion, group leakage, `/constructor`-style handler resolution, HTML injection via display names, oversized (100KB) messages, duplicate `update_id` replay of `/broadcast`, concurrent subscribe storms (real DO serialization semantics), corrupt KV JSON, Telegram 429/5xx/network-throw storms — all covered by the 86-test suite and re-verified green.
- `fetchWithRetry` status-class handling is correct for every range (verified 4xx fast-fail, 429/5xx retry, Retry-After in seconds).
- Broadcast/briefing dispatch payloads reach workflows via `client_payload` → env vars, never shell interpolation.
- The one manual security item from the prior audit (SEC-1 fine-grained PAT rotation) is documented in the README; **confirm the rotation was actually performed** — it can't be verified from the repo.

---

## Phase 16 — Editorial benchmark

**Inputs:** the three committed briefings for 2 July (pre-hardening daily, mid-day on-demand, evening on-demand) plus a live dry-run generated during this audit with the production prompt.

**Trajectory:** the prompt hardening (`e390990`) demonstrably worked. The pre-hardening daily was ~70% evergreen listicles with a factual error (EU AI Act date) and duplicate domains — scored 5/4/6/8/5 in the prior audit. The post-hardening dry-run produced 5 genuine news items, every bullet dated, six distinct credible domains, zero evergreen content, and its links resolve (one 403 is Stanford's bot-blocking, not a dead link).

**Fresh dry-run scores:**

| Dimension | Score | Notes |
|---|---|---|
| Editorial quality | **7.5/10** | Real news, clean structure, no filler; one weak source (a stock-SEO site carrying the Upwork/Claude item) |
| Completeness | **7/10** | Anthropic launch, bias research, ATS vendor news, agent-traffic trend — the right beats; no funding/M&A or enterprise-deployment angle in the query set |
| Insight | **6.5/10** | Every bullet has a "so what" clause, but they're formulaic ("relevant for teams…") rather than a real take |
| Readability | **8.5/10** | Under 2 minutes, scannable, consistent format |
| Executive value | **7/10** | An HR leader would read it; the Stanford bias item and the ERE agent-traffic item are genuinely decision-relevant |

**Would I subscribe?** On the dry-run's evidence — yes, as one of two or three sources. The blocker is **consistency**, not ceiling: the same prompt produced a 1-story edition in prod the same evening (AUD-1). A subscriber judges the product by its worst day.

**Prompt/ranking/retrieval changes (ordered by impact):**
1. **Minimum-story loop:** "If fewer than 4 items pass all filters, run up to 3 additional, more specific searches (recruiting-tech funding, enterprise HR AI deployments, AI-hiring lawsuits/EEOC/regulator actions, ATS/HR-tech vendor announcements) before composing. Only output fewer than 4 items if those also fail." Pairs with the AUD-1 workflow gate.
2. **Impact ordering:** "Within each section, order by impact on a TA leader's decisions this quarter, not by search-result order."
3. **Source tiering:** "Prefer primary sources (vendor newsroom, regulator, research institution) and named trade press (ERE, SHRM, HR Brew, TechCrunch); avoid stock-analysis and SEO aggregator domains for claims about products."
4. **One synthesis line:** end with a single "**Bottom line:**" sentence connecting the day's items — the cheapest way to move Insight from summarizing to editorializing.
5. Keep the existing hard filters verbatim — they are what fixed ED-1..3.

---

## Release-gate checklist

| Gate | Status |
|---|---|
| No Critical open | ✅ |
| No High open | ✅ (AUD-1 is Medium; all prior Highs verified fixed) |
| Regression suite | ✅ 86/86 on `6280fcc` |
| Security | ✅ code-side; ⚠️ confirm the manual SEC-1 PAT rotation happened |
| Reliability/alerting | ✅ failure + stale alerts wired on all three delivery paths |
| Editorial | ⚠️ quality bar reached, consistency not guaranteed (AUD-1 + prompt fix #1) |

**Ship it** for the current private deployment. Before any growth push (raising `MAX_USERS`, public enrollment): land AUD-1 with the minimum-story prompt loop, AUD-2's generalized tag balancing, and re-run the editorial benchmark across 5 consecutive daily runs.
