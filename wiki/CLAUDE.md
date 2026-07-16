# Wiki schema

Rules for maintaining `wiki/`. Read this before any ingest, query, or lint
pass. Rationale and architecture live in `docs/wiki-design.md` — this file is
the operational contract.

## What this wiki is

A persistent, compounding view of the AI-in-recruitment news the bot has
already published. It exists to answer questions a single briefing can't:
what a vendor has shipped over months, when a theme went from demo to GA,
which names recur and which were noise.

## Layers

- `wiki/sources/YYYY-MM.jsonl` — **raw layer. Append-only. Never edit or
  prune it.** One record per (date, url). `bullet` is the source of truth.
- `wiki/vendors/*.md`, `wiki/themes/*.md` — the wiki proper. LLM-written.
- `wiki/index.md`, `wiki/log.md` — catalog and chronology.
- This file — the schema.

## Hard rules

1. **Never invent.** Every claim on a page must trace to a `bullet` in the raw
   layer. No outside knowledge, no web research, no inference presented as
   fact. If the bullets don't say it, it doesn't go on the page.
2. **Never edit `wiki/sources/`.** Ingest reads it and writes only to `.md`
   pages. Corrections go on the wiki page, not the source record.
3. **Every claim carries a date and a link.** Format: `— [source](url),
   D Month YYYY`. Undated claims rot invisibly; that's what lint hunts for.
4. **Restates are not new facts.** The same story re-reported later is one
   event. Record it once, at its first-seen date. Cross-day duplicates are
   expected in the raw layer — collapsing them is this layer's whole job.
5. **Report uncertainty as uncertainty.** A vendor press release is a claim by
   that vendor, not an established fact. Say "announced" / "says", and prefer
   independent reporting when the corpus has both.

## Page types

**Vendor** (`vendors/<slug>.md`) — a company that ships hiring/TA product.
Create on the second independent mention, not the first: one press release is
noise. Before then the story lives on a theme page.

**Theme** (`themes/<slug>.md`) — a durable topic that outlives any vendor:
agentic sourcing, AI regulation and compliance, candidate trust, campus
hiring, interview automation. Create when three or more stories cluster.

Slugs: lowercase, hyphenated, no dates — `clearco.md`, `agentic-sourcing.md`.
Vendor renames keep the original slug; note the rename in the page's first
line (ClearCo was ClearCompany).

## Page template

```markdown
# <Name>

<One-paragraph standing summary: what this is and why a TA lead cares.
Rewrite as understanding changes — this is not a changelog.>

## Timeline

- **D Month YYYY** — <what happened, one or two sentences with the TA
  implication> — [source](url)

## Open questions

- <Things the corpus raises but doesn't settle.>

Related: [[other-page]], [[another-page]]
```

## Operations

**Ingest.** For each new source record: decide which page(s) it touches,
update the standing summary if the story changes the picture, add a timeline
entry, add cross-links, then update `index.md` and append to `log.md`. A story
that fits no existing page and doesn't meet the creation bar above goes
nowhere — that's correct, not a miss. Prefer editing a page over creating one.

**Query.** Search the wiki first, then the raw layer for anything the pages
don't cover. If a query surfaces a durable insight the wiki lacks, file it as
a page edit — that's how the corpus compounds.

**Lint** (monthly, manual). Look for: contradictions between pages, claims
that later stories overtook, orphan pages nothing links to, timeline entries
with no link or date, vendor pages that never got a second mention (fold them
back into a theme), and themes grown big enough to split.

## Log format

`log.md`, newest last, one line per pass:

```
- 2026-07-16 — ingest — 6 record(s) → [[clearco]], [[campus-hiring]] (2 new pages)
```

## Conventions

- `[[wikilinks]]` between pages, matching the operator's personal memory dir.
- Spaces around em-dashes: ` — `, never `word—word`.
- No emoji.
- Prose over bullet soup on standing summaries; bullets are for timelines.
