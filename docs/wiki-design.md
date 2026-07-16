# AI-in-TA Wiki — Design Doc

Status: **proposal, partially built (2026-07-16).** Stage 1 — the raw-source
layer and its backfill — is live; stages 2 and 3 are not. Unlike
`docs/design.md`, which documents what's deployed, this describes a target and
its rationale.

---

Context and motivation
---

**Problem.** The briefing is a firehose with no memory. Each edition researches
the last 48 hours, sends, and moves on. Nothing accumulates, so questions the
corpus _should_ be able to answer can't be:

- "What has ClearCo shipped in the last six months?"
- "When did agentic sourcing stop being a demo and start being GA?"
- "Which vendors keep showing up, and which were one-week noise?"

That's ~6 stories/day of curated, TA-relevant, already-summarized material
going straight to write-only.

**Solution.** The LLM-wiki pattern (Karpathy, gist 442a6bf5): an LLM reads new
sources, folds them into a persistent markdown wiki, and maintains the
cross-references. Humans curate sources and ask questions; the model does the
bookkeeping that makes people abandon wikis.

**Goals**

- Every sent story lands in a durable, greppable corpus — no silent expiry.
- Entity-level views (vendor, theme) that compound instead of resetting daily.
- Zero added risk to delivery: the briefing is the product, the wiki is not.

**Non-goals**

- Replacing `state/recent_stories.json`. It stays exactly as it is.
- A second research pass. The wiki only ever ingests what already went out.
- Bot-facing queries, for now — see "Query" below.

---

What already exists (and what it isn't)
---

`state/recent_stories.json` looks like an archive and isn't one. It's the
**dedup feed for the generation prompt**: `build-recency-note.mjs` injects it
so a story doesn't get re-reported under a different source domain for two
weeks straight (the Claude Sonnet 5 launch ran in both the 07-03 and 07-04
editions — that's the bug it fixes).

Two properties make it hostile to archival use, and both are load-bearing:

- `pruneRecentStories()` drops entries older than `RECENT_STORIES_WINDOW_DAYS`
  (14). Deliberately: remembering a story past the prompts' own freshness
  window is pointless for dedup.
- `MAX_RECENT_STORY_BULLETS` (20) caps injection regardless of the window,
  because everything in this file is **tokens on every future generation**.

So the obvious move — widen the window, keep everything — is the wrong one. It
walks straight back into the 2026-07-04 `--max-budget-usd` incident, and pays
for history with the thing that actually earns money (generation quality under
a $4 cap).

**The wiki's raw layer is therefore a separate, append-only file that never
touches the prompt.** `recent_stories.json` keeps being a 14-day scratchpad.

---

Architecture: three layers
---

Mapping Karpathy's pattern onto this repo:

```
  Layer 1  raw sources    wiki/sources/YYYY-MM.jsonl   append-only, never pruned
  Layer 2  the wiki       wiki/{index,log}.md          LLM-written markdown
                          wiki/vendors/<slug>.md
                          wiki/themes/<slug>.md
  Layer 3  the schema     wiki/CLAUDE.md               rules the ingest reads
```

**Why the repo, not KV.** KV is the Worker's live state: no diffs, no history,
no browsing, and reads cost a binding round-trip. The wiki wants exactly what
git already gives free — versioning, blame, and a diff per ingest showing what
the model changed. The daily workflow already commits `state/`; the wiki rides
along in the same commit (`git add state/ wiki/`).

Two incidental facts make this cheap: `.prettierignore` already excludes
`*.md`, so the formatter can't churn wiki pages, and `ci.yml` only
syntax-checks `scripts|shared|worker` + actionlint + `npm test` — new markdown
is invisible to CI.

---

Layer 1: raw sources
---

`wiki/sources/YYYY-MM.jsonl`, one JSON object per line, one record per
**(date, url)**:

```json
{
  "date": "2026-07-16",
  "headline": "ClearCo puts its Talent Agents into general availability",
  "url": "https://www.prweb.com/releases/clearco-unveils-agent-platform...",
  "domain": "prweb.com",
  "source_title": "ClearCo Unveils Agent Platform for the Talent Lifecycle",
  "bullet": "- **ClearCo (formerly ClearCompany) puts its Talent Agents...",
  "recovered_from": "git:f6d0de29"
}
```

Design rules:

- **One record per (date, url), not per story.** A story re-reported a week
  later is two records, on purpose. This layer records _what was published_;
  collapsing restates is the wiki layer's job. Raw stays dumb.
- **`bullet` is the source of truth.** Every other field is a best-effort
  parse. `headline` is null for ~1/3 of the backfilled corpus — those bullets
  simply have no bold span (an earlier editorial style). Nothing is lost: the
  full text is there and the ingest can derive a title.
- **Append-only.** No pruning, ever. Monthly files keep any single file
  reviewable.
- `recovered_from` marks provenance — `git:<sha>` for days mined out of
  history, `working-tree` for the live window.

Written by `scripts/backfill-wiki-sources.mjs` (idempotent — rebuilds the
whole corpus from git history, so it can be re-run after a schema change).
Stage 2 adds a small append-on-send path for new editions.

---

Backfill result (2026-07-16)
---

Scanned 20 revisions of `state/recent_stories.json`; recovered **91 records
across 11 briefing days, 2026-07-01 → 2026-07-16** (76 unique URLs — the
15-record gap is cross-day restates, which is itself a measurement of how often
the dedup feed gets beaten).

Two days (07-01, 07-02) existed **only** in git history — already pruned out of
the live file. That's the mechanism working as designed, and the reason this
layer exists.

The corpus has real gaps: no editions on 07-06 → 07-09 or 07-12. 07-08 → 07-10
is the known outage (a funding lapse drained Anthropic credits and put GitHub
Actions into account-wide `startup_failure`) — the same incident the v1.5.0
heartbeat was built for. Anything before 07-01 predates the file and is
unrecoverable.

Note for future archaeology: `git log --format=%H` emits CRLF under this
repo's config. Unstripped, the `\r` lands inside the `sha:path` revision
argument and git rejects it with a confusing "ambiguous argument" error.

---

Layer 2: the wiki (stage 2, not built)
---

**Ingest hook.** A new step in `daily-briefing.yml`, immediately after "Record
covered stories" and before "Commit updated state", gated identically:

```yaml
if: steps.idempotency.outputs.should_run == 'true'
  && steps.freshness.outputs.ok == 'true'
  && steps.send.outcome == 'success'
```

Only editions that actually reached subscribers enter the wiki. A rejected or
thin generation must not.

Three constraints inherited from things that already went wrong here:

- **`--setting-sources user`.** Without it, this repo's `.claude/settings.json`
  Stop hook runs `npm test` and blocks completion — on 2026-07-14 that silently
  ate three runs' worth of output and budget with no error. (`--bare` also
  skips hooks but disables tool search with them.)
- **`continue-on-error: true`.** Delivery is the product; the wiki is
  telemetry. A failed ingest must never fail the job or fire the owner alert —
  same posture as the re-benchmark step.
- **Haiku, not Opus, with a ~$1 cap.** This is bookkeeping over text that's
  already written and verified, not the WebSearch agent loop. Opus is priced
  for the part that needs judgment.

**Pages.** `vendors/<slug>.md` per company (ClearCo, HireVue, Workday);
`themes/<slug>.md` per durable topic (agentic sourcing, AI regulation, campus
hiring). `index.md` catalogs; `log.md` records each ingest. `[[wikilinks]]`
between pages, matching the convention already used in the operator's personal
memory dir. Exact page contract lives in `wiki/CLAUDE.md`.

---

Query and lint
---

**Deliberately deferred.** An empty wiki has nothing to answer, and a `/wiki`
command in the Worker means teaching it to read the corpus out of GitHub or KV
— real work that only pays off once there's substance.

Until then the query surface is Claude Code against the local clone: the wiki
is just markdown in a repo on disk. Karpathy's third operation (lint —
contradictions, stale claims, orphan pages) is a monthly manual pass for the
same reason: nothing to lint yet.

Revisit the bot-facing `/wiki` at ~3 months of corpus.

---

Stages
---

1. **Raw layer + backfill.** `wiki/CLAUDE.md`, `wiki/sources/`,
   `scripts/backfill-wiki-sources.mjs`. **Done 2026-07-16** — 91 records, 11
   days.
2. **Ingest step.** Append-on-send + the Haiku ingest into `wiki/`. Watch a
   week: are pages growing sensibly, or is it generating slop?
3. **`/wiki` in the bot.** Only at ~3 months of corpus, only if stage 2's
   pages are actually worth querying.
