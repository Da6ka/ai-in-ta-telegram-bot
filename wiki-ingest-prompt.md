You are maintaining the AI-in-TA wiki in this repository. Fold the newly
published briefing stories into it.

## Do this first

1. Read `wiki/CLAUDE.md`. It is the schema and it is binding — page types,
   creation thresholds, the page template, the no-invention rule, formatting.
2. Read `wiki/.pending.json`. These are the source records to ingest: stories
   the bot has already published and that no earlier ingest has folded in.
3. Read `wiki/index.md` (if it exists) to see what pages already exist, and
   glob `wiki/vendors/` and `wiki/themes/`.

## Then, for each pending record

Decide which existing page it belongs on. Prefer editing an existing page over
creating a new one. Create a page only when `wiki/CLAUDE.md`'s threshold is
met — a vendor needs a second independent mention, a theme needs three or more
clustered stories. Judge those thresholds against the whole corpus, not just
this batch: `wiki/sources/*.jsonl` holds everything ever published, so grep it
before concluding a vendor is a first-timer.

A record that fits no page and meets no threshold goes nowhere. That is a
correct outcome, not a miss. Do not create a page per story.

For each page you touch:

- Update the standing summary if this story changes the picture. It is a
  standing description, not a changelog — rewrite it, don't append to it.
- Add a timeline entry: date, what happened, the TA implication, source link.
- Add `[[wikilinks]]` to related pages.

## Finally

- Update `wiki/index.md` so it catalogues every page that exists.
- Append one line per this run to `wiki/log.md`, in the format `wiki/CLAUDE.md`
  specifies.

## Hard constraints

- **Never invent.** Every claim must trace to a `bullet` in the pending records
  or in `wiki/sources/*.jsonl`. You have no web access here and must not
  reason from outside knowledge. If the bullets don't say it, it doesn't go on
  a page.
- **Never edit `wiki/sources/*.jsonl`, `wiki/ingest-state.json`, or anything
  outside `wiki/`.** Those are written by scripts. You write only `.md` pages
  under `wiki/`.
- **Never touch `state/`, `scripts/`, `shared/`, `worker/`, or `.github/`.**
- Restates are not new facts: a story republished on a later date is one event,
  recorded once at its first-seen date.
- Vendor press releases are claims by that vendor, not established fact. Write
  "announced" / "says", and prefer independent reporting where the corpus has
  both.

Work directly on the files. Your stdout is not used for anything.
