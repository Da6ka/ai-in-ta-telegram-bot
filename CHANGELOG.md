# Changelog

## [Unreleased]

### A pause switch that spares the briefing

Two admin commands, `/pause` and `/resume`, and a maintenance flag in
`BOT_STATE` behind them. `/pause [message]` sets the flag; while it's on, every
non-admin command returns a short notice instead of running — except
`/briefing`, `/newbriefing`, and the GDPR commands (`/privacy`, `/mydata`,
`/forgetme`, `/unsubscribe`), which stay reachable so a pause can never trap
someone's data. Owner and delegated admins bypass the flag entirely, so
`/resume` always works.

The daily briefing is deliberately outside the gate. It runs in the Worker's
`scheduled` handler; the flag only guards `handleMessage`, so the 09:05-UTC run
and the 12:00-UTC heartbeat fire regardless of whether the command surface is
paused. The optional message on either command is fanned out to subscribers over
the same runner path as `/broadcast` — the pause announcement and the all-clear.

Both commands are admin-gated like `/broadcast`; the flag read is skipped for
admins and for the exempt commands, so the common paths take no extra KV read.
`/admin` shows the current pause state. Covered by `test/worker.behavior.test.mjs`
(P1-P7).

### The briefing kept its sources in a channel we were discarding

`/newbriefing` at 02:47 UTC on 2026-08-28 composed a good edition — five
well-formed items, correct date, every date inside the window — and the
requester was served the previous day's briefing. The workflow reported
success.

The cause is in how the Messages API returns sources. Citations are always on
for web search: each cited span comes back with its source attached to the text
block as structured data (`citations: [{url, title, cited_text}]`). Whether the
model *also* writes the markdown link into the prose is a separate matter, and
it varies. Captured from `state/candidate_debug` the same day:

| Run | Model wrote its own links | Linked bullets |
|---|---|---|
| 00:37 | yes, in a block right after each cited span | 4 |
| 02:47 | no | 0 |

`generate-briefing.mjs` read `block.text` and dropped `block.citations`, so in
the second case every URL was thrown away by our own code. Every downstream
gate counts *linked* bullets, so the edition scored zero items and the
freshness gate fell back. `claude -p` never exposed this: the CLI rendered
citations into the text before we saw it.

`shared/briefing-citations.mjs` now composes the edition and, only when the
result carries no linked bullets at all, rebuilds them from the citations. The
repair is all-or-nothing on purpose: a citation and the model's own link live
in *different* blocks, so neither can see the other locally, and repairing
per-block would double-cite every well-behaved run. Anthropic's terms also
require citations to be shown when API output is displayed to end users, which
a briefing is.

Two details the block dump settled, both of which would have been wrong
otherwise. Blocks split mid-sentence — one ends `...an AI services firm`, the
next opens ` For TA leaders` — so they are joined with no separator. And a
block does not end where its sentence does: it runs on into the next bullet's
`\n- `, so a link appended to the raw end lands at the *start* of the following
bullet, leaving the cited one bare and the next one mis-sourced.

If there is nothing to rebuild from, the generator now exits non-zero instead
of exiting 0 with an edition every gate will discard. That hands the run to the
retry both briefing workflows already have, and makes a second failure an alert
rather than a silent fallback.

### The model's narration no longer runs into the title

Same run, second defect: `...round out coverage.# Daily AI Recruitment Briefing
— 28 August 2026`, all one line. `normalizeBriefing` exists to strip exactly
this and could not, because its title pattern was anchored to the start of a
line. The anchor is gone.

The block dump also ruled out the fix that looked obvious. Joining text blocks
per turn does not help — the narration and the title are in the *same* turn —
and inserting a separator between turns would have cut sentences in half, since
blocks run on across those boundaries too.

### A rejected briefing keeps its evidence

Both briefing workflows now upload `state/briefing_debug/` when the gate
rejects a run. The existing dump renders what the searches returned; this keeps
which text block carried which citation. Answering why the 02:47 edition had no
links meant reconstructing block shapes from a different run, because these
files are gitignored and never left the runner.

### The news search moves out of the model, behind an A/B flag

Anthropic's server-side web search has no recency filter, and the briefing's
hardest rule is "published in the past 7 days". On 2026-08-21 the model's own
search returned 85 results across ten queries with **one** inside that window —
a listicle the prompt bans. The same beats through Firecrawl's news source with
a `qdr:w` filter returned ten of ten inside it.

Cost follows from the same change rather than being a separate goal. The ~250k
input tokens an edition bills are not the writing; they are raw search results
the model pulled into its own context. Handing it a formatted list of
candidates instead — one metadata line and a trimmed snippet each — is a few
thousand tokens.

Not switched on: `compare-generators.yml` gains a `source` input
(`firecrawl` | `web_search`) so the two can be measured against each other on
the same day, and `generate-briefing.mjs` gains `BRIEFING_SEARCH_MODE=none`,
which sends no search tool at all because the stories are already in the
prompt. The daily send is untouched until a run says which is better.

The queries move from prose in `briefing-prompt.md` into `shared/news-queries.mjs`,
where they can be tested. All ten now run every time: a Firecrawl search is
cheap and costs no model context, so the prompt's old "escalate to four more
beats if the first six came up thin" has nothing left to trade off.
`briefing-prompt-curated.md` composes from the supplied list and treats every
title, snippet and URL as untrusted data rather than instructions.

One failed query is survivable and the run continues with what the others
returned; every query failing exits non-zero, so the workflow alerts instead of
composing an empty briefing.

### Actions bumped off the deprecated Node 20 runtime

Every workflow run was printing a deprecation notice: `actions/checkout@v4`
and `actions/setup-node@v4` target Node 20, which GitHub now force-runs on a
newer Node. A warning nobody can act on is a warning everyone learns to scroll
past, and this one sat on top of the deploy runs that are supposed to be read.

All three actions go to their current majors — checkout v7, setup-node v7,
upload-artifact v7, 18 references across nine workflows. The intervening major
bumps are almost entirely the Node 24 runtime move plus a minimum hosted-runner
version, which `ubuntu-latest` satisfies on its own. The one consumer-facing
breaking change, setup-node v6 limiting automatic caching to npm, does not
apply: no workflow here passes `cache:`.

Not included, deliberately: six workflows still pin `node-version: '20'` while
ci.yml and deploy-worker.yml test on 22, so CI does not run what the briefing
pipeline runs. That is worth fixing, but not on the night before the first
production run of the direct-API generator — one variable at a time.

### The Worker ships from CI, and says which commit it is running

Everything else in this repo deploys itself. The Worker did not: `wrangler
deploy` was a manual step, so a merged change and a live change were separate
events with nothing joining them. A cap edit could sit in `main` for days while
the bot enforced the previous bundle, and the failure is invisible — code that
was never deployed looks exactly like code that does not work.

Two pieces:

- **`GET /status`** on the Worker returns `gitSha` plus the caps, cooldowns,
  heartbeat cron and retention window it is actually enforcing. The numbers are
  read from the same constants the request path uses, not a copy: a
  hand-maintained version string that someone forgot to bump reads as a passing
  check while production runs something else, which is the exact failure this
  is meant to catch. Public and unauthenticated — everything it prints is
  already in the open repo and in `docs/technical-spec.md` — with a test
  asserting the response carries no ids, allowlist, KV contents or secrets, and
  that adding a top-level field to it breaks that test on purpose.
- **`deploy-worker.yml`** runs on pushes to `main` touching `worker/**` or
  `shared/**`. It re-runs the suite (ci.yml runs alongside this workflow, not
  before it), deploys with the commit SHA passed through as `GIT_SHA`, then
  polls `/status` until the live Worker reports that SHA. `wrangler deploy`
  exiting 0 only means Cloudflare accepted an upload; the poll is what turns
  the run green.

A local `wrangler deploy` passes no `GIT_SHA` and leaves `/status` reporting
`unknown`. That is the honest answer rather than a gap: it says the Worker was
last written from outside CI.

Staging still deploys by hand (`--env staging`). It has no webhook pointed at
`main`, so there is nothing for CI to keep in sync.

The first run shipped correctly and reported a failure anyway, which is worth
recording because the shape recurs. The verify step runs under `bash -e`, and
during propagation the previous bundle was still answering `/status` with the
bare `ok` it falls through to — so `jq` exited non-zero on a parse error, the
assignment failed, and the step aborted on attempt 1. The retry loop written
for exactly that window never got a second iteration. Both reads are now
guarded (`|| true`), so a miss advances instead of ending the step. The general
form: a retry loop under `errexit` is not a retry loop unless every command
inside it is allowed to fail.

The README's release checklist still carried the old step 4 ("Deploy the
Worker — this is a separate, manual step. There is no CI/CD deploy"), which is
now the opposite of what happens. Replaced with what to check instead.

That replacement said to compare `gitSha` against `origin/main`, which is
wrong, and wrong in the direction that matters — it reports a problem when
there is none. The deploy is path-scoped, so a docs or `state/` commit ships
nothing and leaves `gitSha` behind `main` correctly; the briefing pushes
`state/` every weekday, so that is the normal case, not the rare one. A check
that cries wolf on most days is worse than no check.

`scripts/check-deployed.mjs` now does the comparison — against the last commit
that could have triggered a deploy — and prints the caps alongside it.

It reads the deploy paths out of the workflow rather than keeping a copy.
GitHub evaluates `paths:` as literal YAML at trigger time, so the workflow
cannot read them from anywhere else; it has to be the source, which leaves
deriving them the only way to end up with one. The copy was the hazard worth
removing: a drifted list does not fail, it keeps printing a confident verdict
computed from the wrong set, at the moment someone is debugging something else
and is least able to question it. A parse the script cannot trust exits 2
rather than guessing.

### On-demand generation caps drop from 5/day to 2

`GLOBAL_DAILY_DISPATCH_CAP` was 5 and `DAILY_DISPATCH_CAP` 3. At the measured
~$1.5 a generation, a day that spent the shared cap cost $7.50 in
`/newbriefing` alone — more than the daily send it sits on top of, and the
largest single item of unbudgeted tail risk in the project.

The Actions log says 5 was calibrated on the wrong period: 41 on-demand runs
in July, bunched into the fortnight the pipeline was being built and touching
5–6 on several days, then one run in all of August. Steady-state use is a
re-run when an edition comes out thin. Two covers that and caps the tail near
$3/day. Raise it temporarily when iterating on the prompt.

The per-user cap comes down to 2 with it. Left at 3 it would have been a dead
constant — the shared ceiling always trips first — and a solo user who spent
both slots would be told about a "shared daily limit" they were the only party
to. Level caps keep the per-user check meaningful: it runs first, so a repeat
user gets the accurate message, and the global cap goes back to doing its real
job of bounding two different users.

### Sonnet 5 was priced 50% too high in the cost log

`shared/anthropic-cost.mjs` carried `claude-sonnet-5` at $3/$15 per MTok. The
real rate is $2/$10: that was announced as introductory pricing through 31
August 2026, which is where the wrong number came from, and Anthropic has
since made it standard and cancelled the September increase. Only `/ask` runs
on Sonnet, so the error overstated that one line and never touched the
briefing figure — but the whole point of the log is that nobody re-derives it
later.

### The daily send runs on the direct-API generator

`scripts/generate-briefing.mjs` shipped alongside `claude -p` rather than
replacing it, on the reasonable grounds that nothing had been measured yet.
Now it has been. The 2026-08-28 A/B produced a four-item edition for **$1.47**
— 247,580 input tokens, 10 billed searches, one turn — and it passed every
scriptable gate: item floor, target coverage, every bullet dated, four
distinct domains, bottom line present. The edition `claude -p` sent that
morning carried two items and missed target coverage. Different news days, so
that is not a like-for-like quality win; what it does establish is that the
cheaper path is not a regression.

Both generation paths move together — `daily-briefing.yml` and
`on-demand-briefing.yml`. Running `/newbriefing` on a different engine than
the morning send would mean the path with better instrumentation never gets
exercised by the requests most likely to hit an edge case.

What follows from the engine swap rather than being a separate decision:

- **The cost ceiling changes shape.** `--max-budget-usd` was enforced by the
  CLI mid-run, so the retry loop had to grep for "Exceeded USD budget" and bail
  out rather than burn another $4. The ceilings now are pre-emptive
  (`BRIEFING_MAX_SEARCHES`, `max_tokens`, a budget check before continuing a
  paused turn) and the final total only warns, so that grep is gone. The
  step-level `timeout-minutes` stays as the hard wall-clock bound.
- **Every run now prices itself in the workflow log.** The generator reports
  tokens, searches and dollars on stderr, and both workflows print it on
  success instead of only on failure — plus `state/cost_log.jsonl`, which the
  existing blanket `git add state/` commits. Per-run spend stops being
  something inferred from a monthly Console total.
- **Failure diagnosis moves from `--debug-file` to per-turn dumps.**
  `BRIEFING_DEBUG_DIR` collects what each search returned; the freshness gate's
  rejection dump reads it with `scripts/dump-search-log.mjs`, which is what
  separates "the searches failed" from "the searches worked and the model
  discarded every result". Those two look identical from outside and both read
  as a thin news day. Gitignored — several KB per turn, rewritten every run,
  and the commit step would otherwise carry them into git daily.
- **`npm ci` in both workflows.** Generation needs the lockfile now, not just
  CI. `on-demand-briefing.yml` stops installing the Claude Code CLI at all: the
  only remaining `claude -p` call in the repo's briefing path is the daily
  wiki ingest, which is Haiku bookkeeping and stays where it is.

### A blocked crawler no longer takes the briefing down

The first run against the new allowlist failed before spending a token:

    400 invalid_request_error
    The following domains are not accessible to our user agent: ['reuters.com']

Reuters blocks Anthropic's crawler. The API does not skip such an entry — it
rejects the entire request and names it, so one domain in the list is enough to
mean "no briefing today", and it would happen at 09:05 on whatever morning an
outlet changes its robots policy.

Reuters is out of the list, with a note saying why so it does not get added
back. More importantly the failure now self-heals: the 400's message lists the
offending domains, so generation parses them out, drops them from the
allowlist, and retries — twice at most, and falling back to an unrestricted
search rather than sending an empty list. A rejected request costs nothing,
which is what makes retrying the right move rather than a gamble.

### Search is restricted to a curated source list

The third candidate run finally said what was wrong, and it was not the engine.
Ten searches — all six mandatory ones plus all four from the prompt's
minimum-coverage escalation — returned 85 results. One was inside the
seven-day window, and that one was a "trends" listicle the prompt bans.
Twenty results carried no publish date at all. The model looked at that pile,
found nothing it could legally use, and emitted the fallback exactly as
instructed.

The decisive detail: the previous day's real edition was built on releasebot.io
(19 August), staffingindustry.com (18th) and businesswire.com (17th) — all
still inside the window. Two of those domains never came back to the candidate,
and staffingindustry.com returned a 2023 article about a funding round instead.
The API's web search does not rank these queries by recency; Claude Code's
WebSearch does. Effort, dynamic filtering and the model were never the
variable — three runs and $2.22 spent fixing the wrong thing.

`shared/source-allowlist.mjs` is the answer to that: 34 domains the search may
return, passed as `allowed_domains`. It is derived from the archive rather than
guessed — every domain the briefing has actually cited across 39 editions (180
links, 73 domains), kept where cited more than once, plus the outlets
`briefing-prompt.md` names but the archive has not used yet, plus the two
regulators the compliance beat turns on. The prompt already asked for primary
sources and named trade press; this makes it structural, because filtering junk
after the fact cannot recover a story the junk crowded out of the results.

`BRIEFING_ALLOWED_DOMAINS` takes `allow`, `none`, or a one-off list, and the
A/B workflow exposes it as an input. The tradeoff is real and worth stating: a
good story from a source outside the list is invisible, so a thin week is a
reason to check what got excluded rather than to assume the news was quiet.

### The command menu can be pushed from Actions

`scripts/set-commands.mjs` had no runner. It needs `TELEGRAM_BOT_TOKEN` and,
for the owner-scoped admin menu, three `CF_*` credentials to read
`ownerChatId` out of KV — so running it locally meant either keeping a fourth
copy of the bot token on a laptop, or running it without the CF credentials
and silently registering the public menu while skipping the admin one.

`set-bot-commands.yml` runs it where all four secrets already live. Manual
dispatch rather than on merge: the command set changes a few times a year, and
pushing a menu to every client is user-facing.

Found while shipping the Mon-Fri change, which edited the `/subscribe`
description and had no way to deliver it.


### Direct search by default, and a way to see why a run failed

Two A/B runs on 2026-08-21 both returned the prompt's "nothing usable"
fallback: zero items, at `medium` and again at `xhigh` effort, 10 billed
searches each time. Errored searches are not billed, so all twenty succeeded —
the results arrived and the model rejected every one of them. Effort was not
the variable; four times the output tokens reached the same conclusion.

The remaining suspect is dynamic filtering. It runs searches inside code
execution and the model sees what its own filter kept, and the prompt drops any
story whose publish date it cannot verify — so results reaching the model
without `page_age` would produce exactly this. `BRIEFING_SEARCH_MODE` now picks
between `direct` (full results in context, the way the CLI's WebSearch
behaved) and `filtered`, and defaults to direct until this is settled. Direct
costs more input tokens; being right comes first.

Neither failure was diagnosable, which was the real problem.
`response_inclusion: 'excluded'` had thrown away the only record of what the
model was given. Generation now takes `BRIEFING_DEBUG_DIR` and dumps each
turn's blocks there — minus the multi-KB `encrypted_content`, which has to be
echoed back verbatim but tells a human nothing — and
`scripts/dump-search-log.mjs` prints the queries with each result's title, url
and `page_age`. The A/B workflow always sets it, prints the log into the run
summary, and ships the dump in the artifact. A successful result is a list and
an error is a single object, so the log distinguishes "the search failed" from
"the search worked and the model discarded the results" instead of leaving both
looking like a thin news day.

### A direct-API generator, behind an A/B

`claude -p` runs an agent loop that carries every web-search result forward in
full through every later turn, so a six-search edition re-sends the accumulated
results five more times. Input tokens grow with the square of the research,
and that is where the bot's money goes — around 90% of what it costs to run.

`scripts/generate-briefing.mjs` does the same job in one request:
`web_search_20260318` runs the searches inside a single server-side turn, and
dynamic filtering puts the results through code before they reach the context
window, so only what survives is billed. `response_inclusion: 'excluded'` keeps
the raw result blocks out of the response, since nothing downstream reads them.
It streams (a dozen searches is exactly the shape that trips a request
timeout), continues a paused turn up to four times, and treats a refusal, an
empty response and a `max_tokens` truncation as three different outcomes rather
than one generic failure.

Nothing is switched over yet. The daily and on-demand sends still run
`claude -p`; this ships alongside it with `compare-generators.yml`, a manual
workflow that generates a candidate edition, scores it with the existing
`score-briefing.mjs`, and scores the edition that actually went out that
morning next to it. Since the real edition is already committed, the comparison
costs one generation rather than two. It sends nothing, writes no KV and
commits nothing. It also deliberately skips the recency note: that note tells
the model not to repeat recent editions, including the one being compared
against, which would push the candidate onto second-choice stories and make the
comparison meaningless.

Every run now prices itself. `shared/anthropic-cost.mjs` turns the API's own
`usage` into dollars and appends a line per edition to a cost log. This is the
thing the old path could never answer: per-run spend was only ever inferred
from a monthly total and from which `--max-budget-usd` ceiling a run had blown
through — raised 1 to 2 to 4 across three incidents, each time after a failure
rather than after a measurement. An unpriced model logs `null` instead of a
guess.

Cost control changes shape along with the engine. `--max-budget-usd` was
enforced by the CLI mid-run; the pre-emptive limits here are a ceiling on
billed searches and on `max_tokens`, plus a budget check before continuing a
paused turn. The final total only warns: once a completed response can be
priced the money is spent, and failing then would discard an edition that was
paid for and is probably fine.

First dependency in the repo's life (`@anthropic-ai/sdk`, pinned), so CI now
runs `npm ci` — with `ci`, not `install`, so a lockfile that has drifted fails
in CI rather than at 09:05.


### The briefing runs Mon-Fri

Weekend editions were about 28% of all generations and the single largest line
in what the bot costs to run — spent on the two days AI-recruitment news is
thinnest. The daily send is now Monday to Friday.

Four schedules had to move together, and one of them is a trap: the Worker
tells its two crons apart by string-comparing `event.cron` against
`HEARTBEAT_CRON`, so editing `wrangler.toml` without the constant would not
error, it would quietly turn the 12:00 heartbeat into a second briefing
dispatch every day. There is now a test asserting the two stay equal. The
watchdog moved to weekdays for the same reason the heartbeat did: on a Saturday
it would report a missed run that was never scheduled, and dispatch a fallback
generation — the exact spend the pause exists to avoid.

Monday's edition would otherwise lose the weekend. The prompt's freshness
window was a hardcoded "past 24-48 hours", inlined in two workflows; it is now
derived from the gap since the last edition (`scripts/build-date-note.mjs`,
48h floor, 96h ceiling), so Monday reaches back 72 hours and a gap left by an
outage widens the same way instead of silently dropping the days it spans.

`/newbriefing` still works every day — nothing about on-demand generation
changed. Subscribers are told "every weekday morning" at `/subscribe`, `/start`
and `/help`, and in the command list; README, both design docs and the live
one-pager say Mon-Fri.

### Blocked subscribers now unsubscribe themselves

A subscriber blocked the bot on 2026-07-12. Telegram answers every later send
to that chat with `403 Forbidden: bot was blocked by the user`, and nothing
acted on it — so the id stayed on the list and the morning send reported
"4/5 subscriber(s)" every day for five weeks, a permanent failure line that
reads like noise.

The send scripts now recognise a 403 as terminal rather than transient and
queue the id; the Worker's daily `scheduled` handler unsubscribes them through
the Durable Object just before the next send.

Splitting it across the two runtimes is the point, not an accident. The runner
is the only place that sees Telegram's 403, but it can only write KV — and
`scheduled` re-mirrors KV from the DO before every send, so a prune written by
the runner would be overwritten the next morning. The DO is the only writer
whose change survives, and the runner is the only observer, so the observation
travels through KV and the decision happens in the Worker.

It unsubscribes and nothing more: blocking the bot stops delivery but is not a
request to erase an account, so allowlist access is kept and `/subscribe` still
works if they unblock. The owner gets a message naming who was pruned, because
a subscriber quietly disappearing from the daily count should not be
discoverable only by reading logs.

### Spec masthead names both user-facing models

The one-pager's masthead read `model claude-opus-4-8` — true of the briefing,
but the page documents three `claude -p` invocations now, so its most prominent
claim implied one model runs everything. Split into `briefing opus-4-8` and
`/ask sonnet-5`. The ingest's Haiku stays out: it's internal bookkeeping nobody
interacts with, and §3.3 carries all three with their tool allowlists and
budgets.

A seventh chip doesn't fit the 1080px column, so `runtimes Worker + Actions`
wraps to its own line. Kept rather than dropping a chip for spacing — `.chips`
sets `flex-wrap`, so the layout was built for it. README covers re-rendered
from the same file, and the live page redeployed to match.

## [1.8.1] - 2026-08-20

### Plain text now points at `/ask`

A user sent the bot a question as ordinary text and was told the bot only
takes `/help` and `/briefing`. That is what the catch-all nudge said, and
shipping `/ask` never updated it — so `/start` invited people to "ask about
anything covered in past briefings" and the very next message contradicted it.

The nudge now leads with `/ask` and shows the prefix in place, for allowlisted
users only (advertising it to someone still awaiting approval would just be
noise). It stays a fixed string: the user's text is never echoed back, because
`/privacy` promises ordinary messages aren't processed and the reply shouldn't
quietly break that.

The same pass fixes the other two places a user meets `/ask` for the first
time. Bare `/ask` suggested a question about Workday specifically — a page with
three timeline entries — where the honest answer is one line and reads as a
broken feature; it now asks about the legal picture for AI hiring, backed by 27
entries. And `/help` listed `/ask` by name only. That works for every other
command, because the command *is* the whole action; `/ask` is the one that
takes an argument, and a bare name doesn't convey that it wants a natural
sentence rather than a keyword. It now carries a worked example.

## [1.8.0] - 2026-08-20

### `/ask` — question the archive

The wiki has held a persistent corpus since v1.7.0, but nothing could query it
from Telegram. `/ask <question>` closes that: the Worker validates and
rate-limits the question, then `repository_dispatch`es it to a new `ask.yml`,
where a read-only Sonnet `claude -p` reads `wiki/` and answers with dated,
linked citations. No web access, so an answer can only contain what the bot has
published; a question the corpus doesn't cover gets an explicit "not in the
archive" rather than an invented one.

`/start` now introduces `/ask` with a worked example rather than leaving users
to find it in `/help`: a new command nobody knows about is a command nobody
uses, and the welcome message previously named only `/briefing` and
`/subscribe`. The example question is aimed at the deepest part of the corpus
(interview cheating spans three pages), since a first answer drawn from a thin
page reads as a broken feature even when the bot is correctly reporting a gap.
Pending users now see `/ask` listed among what approval unlocks.

The model landed on Sonnet the hard way: it shipped on Haiku, following the
wiki ingest's precedent, and the first two live answers read thin. Folding a
bullet onto the right page is bookkeeping; answering a question across months
of pages is synthesis, and the tiers differ exactly there. At this corpus size
the cost difference is immaterial — a run stays far inside the same $1 ceiling.

No vector store — the whole corpus is ~64k tokens and grep over `wiki/` inside
the checkout beats embeddings at this size. `/ask` gets its own rate-limit
counter (`ask_rate`: 10/user/day, 40/day global, 30s cooldown) so questions and
briefings never draw down each other's allowance, and its own concurrency group
so an ask never queues behind a briefing generation.

Privacy: the bot never stores a question's text. The Worker logs a one-way hash
and length only; the copy in the dispatch payload ages out on GitHub's Actions
retention. The untrusted question reaches CI via the runner's event file
(`GITHUB_EVENT_PATH`) — never shell-interpolated, and never step `env:` either,
since Actions prints step env blocks into the run log (the first live run
leaked the plaintext that way; caught in staging testing, fixed before
release). The answer job's tools are read-only with no `WebSearch`. Full
design and threat model in `docs/ask-design.md`.

Ships the command handler and `ask_rate` limiter (`worker/src/index.js`),
`ask.yml`, `ask-prompt.md`, `scripts/build-ask-prompt.mjs`,
`scripts/send-answer.mjs`, the `/ask` menu entry, and `/privacy` copy covering
question handling. Deploy needs `npx wrangler deploy` (Worker) and a re-run of
`scripts/set-commands.mjs` to surface `/ask` in the menu.

## [1.7.1] - 2026-08-17

### README now documents the self-filling wiki, and the @handle roster

The daily/on-demand corpus (`wiki/sources/` + the Haiku ingest into
`wiki/vendors/` and `wiki/themes/`) shipped in v1.7.0 but was absent from the
README's "How it works" — the one behavior with no user-facing surface was also
the one with no docs. Adds a short "self-filling wiki" note covering the
append, the daily-only ingest, its `continue-on-error`/send-gated safety, the
25-record cap, and that a bot-facing `/wiki` is deliberately unbuilt. Also
updates the `/listusers` command row to say it now renders each stored `@handle`
next to its id. Docs only.

## [1.7.0] - 2026-08-17

### The repo is now MIT licensed

Public with no LICENSE file means "all rights reserved": people could read the
code but had no right to fork, run, or adapt it -- which is the opposite of
what a repo with a full setup guide and a public spec page is for. MIT grants
those rights and carries the warranty disclaimer, which matters here because
the quickstart invites strangers to deploy their own Worker against their own
Anthropic and Telegram credentials.

The license covers this repo's code, not the bot's output: a briefing is
assembled from third-party news, and those stories stay with their publishers.
That distinction is stated in the README's License section so nobody reads the
MIT grant as covering the editions.

### The bot now remembers each user's @username

Telegram's Bot API has no id-to-username lookup: once someone is approved, the
handle from their access request is discarded and only the numeric id remains,
so the owner is left staring at a list of ids with no way to tell who is who.
The bot now captures `from.username` on every command it handles and stores it
in `usage_stats.usernames`, alongside the existing `last_seen` activity log.
`/listusers` now renders each stored `@handle` inline next to its id, so the
owner reads the roster as people instead of bare numbers, and `/mydata` shows
an approved user their own stored handle. A handle only appears once that user
has run a command since this shipped — the map starts empty on deploy.

It's held to the same privacy contract as the rest of the activity log: the
`/privacy` notice now names the stored @username explicitly, it's pruned on the
same 90-day inactivity cutoff as `last_seen` (a handle can never outlive its
activity entry), it's erased by `/forgetme`, and a user who has since cleared
their Telegram username has the stale handle dropped rather than kept.

### The wiki now fills itself from each sent edition

Stage 1 gave the corpus a home (`wiki/sources/`) but no writer and no reader --
the backfill ran once and nothing has touched it since. This adds the writer.

Every edition that reaches a subscriber is now appended to the raw layer by
`scripts/append-wiki-sources.mjs`, from **both** the daily and on-demand
workflows: an on-demand edition reaches a real subscriber, so excluding it
would reopen the hole the backfill just closed. Then, daily only, a Haiku
`claude -p` pass folds the pending records into `wiki/vendors/` and
`wiki/themes/` pages per the schema in `wiki/CLAUDE.md`. On-demand appends but
never ingests, so a burst of `/newbriefing` can't trigger a burst of ingests.

Delivery cannot regress: the ingest is `continue-on-error`, gated behind the
existing send/freshness checks, and carries the `--setting-sources user` fix
that the 2026-07-14 Stop-hook outage taught us. It has no WebSearch -- the wiki
may only ever contain what the bot published, and the tool allowlist is what
enforces that, not the prompt.

Pending work is tracked by record id rather than a date watermark, so an
on-demand story added after a date was ingested still gets picked up and a
multi-day outage self-heals. Batches are capped at 25 records per run: without
a cap, a backlog large enough to blow `--max-budget-usd` would fail, stay
pending, and hand the next run the same too-big batch forever. Marking records
ingested is a separate step gated on the ingest's `.outcome` (not
`.conclusion`, which `continue-on-error` forces to `success`), so a
half-finished ingest never marks its own work done.

Stage 3 (a bot-facing `/wiki` query surface) remains deliberately unbuilt. (#76)

### Sent stories now survive past the 14-day dedup window

`state/recent_stories.json` looks like an archive but isn't one: it is the
dedup feed injected into the generation prompt, so `pruneRecentStories()` drops
anything older than 14 days and `MAX_RECENT_STORY_BULLETS` caps what goes in --
both load-bearing for the `--max-budget-usd` ceiling after the 2026-07-04
incident. Everything the bot has ever published was therefore expiring, and
widening the window to keep it would have paid for history with generation
quality.

History now lives in `wiki/sources/YYYY-MM.jsonl` -- append-only, never pruned,
and never injected into any prompt. `scripts/backfill-wiki-sources.mjs` mines
it out of the daily "Update briefing state" commits and is idempotent, so it
can be re-run after a schema change. First run recovered 91 records across 11
briefing days (2026-07-01 -> 2026-07-16); two of those days survived only in
git history, already pruned out of the live file.

This is stage 1 of the LLM-wiki design in `docs/wiki-design.md`. The raw layer
and its schema (`wiki/CLAUDE.md`) are inert on their own -- nothing reads them
yet, and the daily workflow is untouched. Stage 2 (the ingest step) and stage 3
(a bot-facing query surface) are deliberately not built. (#75)
### README now guides subscribers, and surfaces the /newbriefing limits

The README was written operator-first: the actual subscriber journey was only
implied in prose, and `/newbriefing`'s rate limits weren't documented anywhere,
so a user who hit the cooldown or a daily cap had no way to know it was expected
rather than broken.

Adds a **"Using the bot (subscribers)"** section covering the four-tap flow
(`/start` -> approval -> `/subscribe` -> briefing), plus stop/erase and the
data commands. Adds a note under the command table spelling out the
`/newbriefing` limits verified against `worker/src/index.js`: 60-min cooldown
(5 min for the owner), 3/day per user, 5/day across everyone, cached copy served
on refusal, daily send unaffected.

The note attributes each limit to its real reason rather than lumping them under
one: an on-demand briefing is delivered only to the requester (not broadcast),
but it overwrites the single shared cached edition `/briefing` serves everyone,
so the cooldown is global (the cache and cost are shared); the per-user cap is
an anti-hogging backstop; the global cap is the cost ceiling. Docs only.

### README drift: dead rollback path, briefing window, and the reliability story

Five README claims had gone stale against the deployed system:

- The Cloudflare Worker cutover steps still told operators the live webhook
  displaces "the old long-polling `server.ts`" and to roll back by restarting
  "the local `bun server.ts` poller" -- but that file no longer exists in the
  repo, so the rollback path was dead and misleading to anyone following the
  setup fresh. Cutover now describes `setWebhook` as all-or-nothing, and
  rollback as clearing the webhook with the explicit caveat that there's no
  poller to fall back to.
- The briefing window was described two ways: "past 48 hours" in the intro and
  "past 7 days" in the editorial note. The prompt's actual rule is *prefer
  24-48h, hard cap 7 days*, and the sample edition itself carries items 3-4
  days old. Reconciled to "the past day or two" (target) and "nothing older
  than a week" (cap).
- "No single point of failure" overstated the reliability design -- v1.6.0's
  spec walked this back after the Worker cron and GitHub schedule missed the
  same morning (#61). The section now says "defended in depth rather than by a
  single trigger" and adds the 12:00 UTC Cloudflare heartbeat (the Worker's
  second cron) as the only check outside GitHub's scheduler.
- Intro send time said 09:00 UTC; the primary Worker cron is 09:05 (as the
  diagram and reliability prose already said). Aligned to 09:05.

Docs only; no code or workflow change.

### Spec page HTML is now tracked, and its cover matches v1.6.0

The interactive one-pager at ai-in-ta-bot-spec.vercel.app was only ever a
direct upload to Vercel with a saved local copy -- nothing in the repo, so the
deployed page could drift from the source with no record of it. It is now
`docs/technical-spec.html`, version-controlled next to `technical-spec.md`.
Credential names stay redacted to generic labels (e.g. "CI dispatch token"),
since the page is public. Vercel still ships it by direct upload and Git stays
disconnected on that project -- a past auto-build served the repo root, 404'd,
and clobbered the upload -- so tracking the file changes nothing about how it
deploys.

The same change refreshes the README cover screenshots
(`docs/assets/spec-preview-{light,dark}.png`) to the v1.6.0 layout: the
per-user vs global dispatch caps, the `MAX_PENDING` tile, the $4 per-run
budget, the role-dependent cooldown, and the 12:00 UTC Cloudflare-side
heartbeat. The cover no longer shows the stale v1.4.0 page. (#70)

### Removed a scratch log that shipped in v1.6.0 by accident

`.worker-cron-validation-log.md` was an untracked scratch file written by a
scheduled monitoring task tracking PR #41. A `git add -A` in #63 swept it into
the repo and it shipped in v1.6.0. It was never meant to be tracked, and it was
already dead: #41 was closed on 2026-07-13 (superseded by #43's
repository_dispatch design), the file's own content reads DISCONTINUED, and the
task that maintained it has been deleted. The deliberate record of that
investigation lives in `docs/qa/worker-cron-trigger-validation-log.md`, which
stays. (#68)

### Release steps now bump the spec header

The spec header tracks the app version, but nothing automates it and nothing
fails when it's missed, so it drifted silently -- it sat at 1.4.0 through three
releases before v1.6.0 caught it. It is now release step 2 (the rest
renumbered): it is the line that tells a reader whether the spec describes
what's deployed, so drift there is worse than drift anywhere else. (#67)

## [1.6.0] - 2026-07-16

### Heartbeat now asks whether subscribers were served, not whether a copy exists

The 12:00 UTC Cloudflare heartbeat read `today_briefing_date` and treated
"equals today" as "the briefing landed". That key only means *an edition is
cached* -- the on-demand path writes it via the same `sync-kv.mjs` after
delivering to exactly one requester. So a single user's `/newbriefing` could
silence the heartbeat on a day when subscribers got nothing.

Adds `last_delivered_date`, written only by `daily-briefing.yml`'s KV sync
(`MARK_DELIVERED=true`) -- a step that is skipped unless its "Send to Telegram"
step succeeded, so the key means what the heartbeat is actually asking. The
on-demand workflow deliberately omits the flag. The alert text now says
"hasn't been delivered to subscribers" rather than "hasn't landed", since the
distinction is the whole point.

Narrow but real: the heartbeat's designed failure mode is an account-wide
Actions block, where an on-demand run couldn't have generated either, so
nothing would write the key and the alert fires correctly. The gap needed
on-demand to succeed *and* the daily triggers to miss *and* the watchdog to
miss -- two of which happened on 2026-07-16 (#61). Tests 144 -> 145.

Documenting the new key also surfaced that spec §4.1 listed `usage_stats`,
`today_briefing_md` and `today_briefing_date` as Durable Object fields. They
are KV-resident -- the DO holds only `access`, `subscribers`, `briefing_rate`
and `seen_updates`, as `worker/src/index.js`'s own top-of-file note says. §4.2
now carries the KV-resident state (separating it from the DO *mirror*, which is
a different role for the same namespace) and spells out that
`today_briefing_date` and `last_delivered_date` are not interchangeable.

### Rate-limit messages no longer point at a /briefing that has nothing to serve

Both cap messages ended with "/briefing will still get you the latest one".
That advice is only true when today's edition is actually cached. With nothing
cached it's a loop: /briefing finds no cache, routes back into
`requestGeneration`, hits the same cap, and prints the same advice again. The
wording predates the global cap -- the new message inherited the flaw by
copying the existing per-user one, so both are fixed here.

The tail is now conditional on `hasTodayCached()`, which mirrors the /briefing
handler's own cache condition rather than restating it. With no cached edition
the user is told there's nothing to fall back on, and that the daily briefing
isn't affected by the limit so today's should still arrive -- which is the
actually useful thing to know, and true whether or not they're subscribed.
Tests 142 -> 144.

### Global daily cap on briefing generation

The three generation limits were doing two jobs, not three: the global 60-minute
cooldown and the per-user 3/day cap both existed, but neither bounded total
spend. The per-user cap bounds *hogging* -- each allowlisted user gets their own
3/day, so cost scaled with the allowlist -- which left the cooldown as the only
real ceiling, at ~24 dispatches/day and $4 of paid Actions + Claude run apiece.

Adds `GLOBAL_DAILY_DISPATCH_CAP` (**5/day across everyone**, UTC-reset) as an
independent third limit, tracked in `briefing_rate.total`. The per-user cap is
deliberately kept: making the cap global *instead* would let any single
allowlisted user burn the shared quota and lock everyone else out for the day,
including the owner. A user refused by the shared cap is served the cached
edition, and the daily scheduled send -- which never goes through
`reserveBriefingDispatch` -- is unaffected.

Rollback refunds the shared slot along with the per-user one, so a dispatch
GitHub never accepted doesn't consume quota. Rate records written before this
cap existed have no `total` and default to 0 rather than NaN-comparing into
refusing every dispatch. Tests 139 -> 142 (F12b/F12c/F12d), each verified to
fail without the change.

### Corrected the technical spec against the code

`docs/technical-spec.md` had drifted from the deployed system on several
enforced values, which matters for a document whose whole purpose is being
checkable against an implementation:

- Per-run LLM spend was documented as `--max-budget-usd 2`; both workflows
  actually pass **4**, so the stated cost ceiling was half the real one.
- The dispatch cooldown was documented as a flat 60 min, omitting the owner's
  5-min window, and the note below the limits table claimed the cooldown and cap
  are "global, not per-user" -- wrong about the cap, which is per-user by design.
  Replaced with §6.2, explaining how the three limits compose and what each one
  actually bounds.
- §5.1 omitted the freshness/content gate entirely (dated-today +
  `MIN_BRIEFING_ITEMS`), including the part that matters most: a rejected
  edition leaves `last_briefing_at` un-advanced so the day stays retryable.
- Added `MAX_PENDING` (50) to the limits table, and `briefing_rate` /
  `seen_updates` to the §4.1 DO field list.
- §3.2 and §5.3 both cross-referenced a "§6.2" that did not exist; the new
  subsection resolves the dangling reference.

### Unit-tested the delivery scripts' embedded logic

Extracted the three pieces of consequential pure logic that lived inline in the
GitHub Actions delivery scripts into `shared/telegram.mjs`, where CI can reach
them, and added unit tests (133 -> 139):

- `isLowBalanceError()` (from `check-credit-balance.mjs`) -- the classifier that
  decides whether a failed Anthropic pre-flight blocks the multi-dollar
  generation run; only the low-credit body blocks, every other error passes so
  a transient failure can't silently skip the day's briefing.
- `applyBriefingToUsageStats()` + `USAGE_HISTORY_LIMIT` (from
  `update-usage-stats.mjs`) -- the daily increment / date-stamp / 30-edition
  history-cap bookkeeping, now covered for the cap, fresh-seed, and no-mutation
  cases.
- `briefingDomain()` and `bulletLooksDated()` (from `score-briefing.mjs`) -- the
  G5 distinct-domain and G3 recent-date scorecard heuristics.

Behavior is unchanged: the scripts now import these instead of defining them
inline. Closes the repo's remaining untested-logic gap; the rest of `scripts/`
is thin Telegram/GitHub/KV `fetch` wrappers left as integration-only.

## [1.5.3] - 2026-07-15

### Fixed the owner-can't-unsubscribe guard checking a field nothing writes

`/unsubscribe` gated the owner-refusal on `subscribers.owner`, but no code
path ever writes that field — it stays `''` from `DEFAULT_SUBSCRIBERS` — so
the guard never fired and the bot owner could unsubscribe from their own daily
briefing (they'd then miss it until re-subscribing). The guard now keys off
`access.ownerChatId`, the same source of truth `/forgetme` already uses.

The `F8` test passed only because its fixture hand-seeded
`subscribers: { owner: OWNER }`, a shape the running Worker never produces.
Dropped that field from the test fixtures so `F8` now exercises the real
`access.ownerChatId` path and fails if the guard regresses.

## [1.5.2] - 2026-07-15

### Added a regression test for en dash/hyphen title tolerance

The 1.5.1 dash-tolerance fix taught `isValidBriefing()` to accept em dash, en
dash, or a plain hyphen in the briefing title separator, but shipped without a
test. Added one asserting all three separators are accepted, so a future
narrowing of `TITLE_DASH` can't silently reintroduce the rejection of
otherwise-valid briefings. (#57)

### Fixed the same Stop-hook outage on the /newbriefing path

The 1.5.1 fix applied `--setting-sources user` and `--debug-file` to
`daily-briefing.yml`'s `claude -p` call only. The identical call in
`on-demand-briefing.yml` (the `/newbriefing` command) was missed, leaving it
exposed to the same silent-empty-output failure mode the outage was caused
by. Mirrored both flags there, plus the debug-log dump on a rejected
generation.

### Aligned Claude Code CLI pin across workflows

`on-demand-briefing.yml` was still pinned to `2.1.201` while `daily-briefing.yml`
had moved to `2.1.209`. Both run the same generation logic, so left on
different versions they risked silently drifting into "works in one
workflow, not the other" bugs. Both now pin `2.1.209`.

## [1.5.1] - 2026-07-14

### Fixed the project's Stop hook silently blocking headless briefing generation

`/briefing` served a stale 11 July edition for three straight days (2026-07-12
through -14) with no diagnosable failure signal: every `daily-briefing.yml` run
exited 0 (once it instead hit the step's 10-minute timeout) while `claude -p`
produced completely empty stdout/stderr. Root cause, found via `--debug-file`:
this repo's `.claude/settings.json` Stop hook (added 2026-07-13 — an `npm test`
gate meant to guard interactive coding sessions) also fires on this headless,
content-generation-only `claude -p` call. Its `npm test` failed inside the CI
checkout specifically (`node --test "shared/**/*.test.mjs"` matched nothing
there, though the identical command passes locally and in the separate
`ci.yml` workflow), so the hook blocked every completion attempt in a loop —
the model never got to actually finish, and no real error ever reached
stdout/stderr for the existing failure-dump steps to print.

Fixed with `--setting-sources user` on the `claude -p` invocation, which
excludes the "project" settings source (where the hook lives) without
disabling anything else. `--bare` was tried first since it also skips hooks,
but it disables tool search along with them, which silently broke WebSearch
too — the model fell back to raw `curl`/`wget` via Bash (denied, since only
`WebSearch` is allowlisted) and gave up with the prompt's own "no content
available" fallback instead of a real briefing.

Also added `--debug-file state/briefing_debug.log`, dumped (last 200 lines)
alongside stdout/stderr on freshness-gate rejection, so a repeat of this
failure mode is diagnosable from the Actions log instead of requiring live
reproduction. Bumped the pinned CLI (`2.1.201` → `2.1.209`) while
investigating — turned out not to be the actual cause, but harmless to keep.

Recovered the live outage manually while diagnosing: synced a validated 14
July edition straight to Cloudflare KV (`wrangler kv key put`) so `/briefing`
had current content throughout the investigation, ahead of the CI fix
landing.

### Tolerate en dash/hyphen in briefing title separator

`isValidBriefing()` and `BRIEFING_TITLE_RE` only matched an exact em dash (—)
between the title and date. A model drifting onto a visually similar en dash
or hyphen produced a perfectly usable briefing that still got rejected
identically to a genuinely malformed one — indistinguishable in the logs from
a real generation failure. `shared/telegram.mjs` now accepts em dash, en
dash, or a plain hyphen via a shared `TITLE_DASH` character class.

### Serve the last saved edition when an on-demand briefing fails

When `/briefing` or `/newbriefing` generation exited 0 but the freshness/content
gate rejected it (the "no content" fallback, or an undated/malformed title), the
requester was only told to run `/briefing` themselves — leaving them to issue a
second command to get anything. The on-demand workflow's stale branch now serves
the last saved edition directly, the same thing `/briefing` returns, via new
`scripts/send-stale-to-chat.mjs` (reads `today_briefing_md` / `today_briefing_date`
from Cloudflare KV, mirroring the Worker's `serveStaleBriefing`). Best-effort:
never throws, always exits 0, and falls back to the previous alert text if KV has
no saved edition or can't be reached, so the requester is never left in silence.

### Dump generation output when the briefing freshness gate rejects

Both briefing workflows have a content/freshness gate that rejects a generation
which exits 0 but produces the "no content" fallback (zero linked stories) or an
undated/malformed title — the requester/owner then sees "didn't come out right
this time" with no diagnosis, because the generate step only dumps stdout/stderr
on a *non-zero* exit. The reject path in `daily-briefing.yml` and
`on-demand-briefing.yml` now dumps `head -40 state/today_briefing.md` and
`state/briefing_stderr.log` to the run log, so the next occurrence is
attributable (empty fallback vs. truncation vs. bad title vs. a WebSearch/upstream
error captured on stderr). Diagnostics only — no behaviour change.

## [1.5.0] - 2026-07-14

### Hardened briefing prompt against model reasoning leakage

`briefing-prompt.md` already required markdown-only output, but the model still occasionally returned internal selection rationale before the briefing title. A live 2026-07-13 edition started with:

> "I have three solid, date-verified items across distinct beats..."

instead of the actual briefing, exposing research notes and editorial decisions to subscribers. Strengthened the prompt with explicit output guards: the response must start with `# Daily AI Recruitment Briefing`, and research notes, selection rationale, status updates, apologies, and phrases such as "I found", "I have", "I searched", or "I omitted" are forbidden. The briefing generator output is now constrained to the saved Markdown artifact only.

### External briefing heartbeat (Cloudflare-side)

Added a second Worker cron (12:00 UTC) that alerts the owner via Telegram if a
day's briefing never landed. Every prior guard runs *inside* GitHub Actions --
the workflow's own retries and the 10:30 UTC watchdog -- so all are blind to the
failure mode that took the briefing down Jul 8-10 2026: an account-wide Actions
block (billing hold / outage) makes every run `startup_failure` before a step
executes, watchdog included. `briefingHeartbeat` runs on Cloudflare, independent
of GitHub, reads `today_briefing_date` from KV (written only by a successful
generation), and pings the owner if it isn't today's. Requires `wrangler deploy`
to register the new cron. Covered by 3 unit tests.

### Strip model preamble before the briefing title

`briefing-prompt.md` forbids preamble ("Output ONLY the composed briefing
markdown ... no commentary before or after it"), but the model occasionally
ignores it and opens with reasoning before the `# Daily AI Recruitment
Briefing` title (seen live 2026-07-13: an edition led with "I have three solid,
date-verified items ..."). Nothing downstream stripped it, so on those days the
commentary rendered at the top of every subscriber's briefing. Added
`normalizeBriefing` (shared/telegram.mjs) — a deterministic transform that drops
anything before the first title line, then forces the title date — and rewired
`scripts/force-briefing-date.mjs` (run right after generation, before the
freshness gate) to use it. Covered by 5 unit tests; a missing title still
returns unchanged so the freshness gate rejects it rather than guessing.

### Shorter briefing-generation cooldown for the owner

The 60-minute global dispatch cooldown blocked the owner from refreshing
on demand (`/newbriefing` fell back to the last saved edition with a "a fresh
one can be generated in ~X min" note). The owner now gets a **5-minute**
cooldown instead of 60; the per-user daily cap of 3 still applies to the owner
as a cost backstop, since every generation is a paid GitHub Actions + Claude
run. `reserveBriefingDispatch` takes an `isOwner` flag threaded from the
`/briefing` and `/newbriefing` handlers via `requestGeneration`; non-owner
behaviour is unchanged. All 132 unit tests pass.

### Refactored the command layer (code review follow-up)

Maintainability cleanup of `worker/src/index.js`, no behavioural change to any
existing command (all 123 unit tests pass unchanged):

- **Declarative role gate.** The owner/admin authorization check was a 4-line
  `if (!isOwnerOrAdmin(...))` block copy-pasted into eight handlers. Replaced
  with a `COMMAND_ROLES` map (`'admin'` / `'owner'`) checked once in
  `handleMessage` before dispatch. The refusal messages are unchanged; the
  point is that a newly-added privileged command can no longer ship *ungated*
  by forgetting to paste the block -- authorization is now data, not a
  per-handler code path. The check runs before usage is recorded, so refused
  attempts no longer count toward command stats.
- **Merged the two usage-stats writers.** `touchLastSeen` and
  `bumpCommandCount` each did a full locked read-modify-write of the same
  `usage_stats` KV blob on every command (4 KV round-trips). Combined into one
  `recordCommand` doing a single read-modify-write (2 round-trips), which also
  removes the window where a bump and a touch could interleave.
- **Fixed misleading "extra argument" copy.** `/adduser 5 6` (and
  `/removeuser`, `/addadmin`, `/removeadmin`) aborts without acting, but the
  reply read as though it had proceeded with the first id. Reworded to state
  plainly that nothing was changed.
- **Normalized `access` on read.** `getAccess` now spreads over
  `DEFAULT_ACCESS`, so `adminIds`/`allowFrom`/`pending` are always present and
  the ~7 scattered `adminIds ?? []` / `if (!adminIds)` guards are gone.
- Admin panel command-usage list is derived from `COMMAND_HANDLERS` keys
  instead of a hand-maintained list (can't drift); `reserveBriefingDispatch`
  reuses `todayUTC()`; dropped now-unused `access` destructures.

### Fixed corrupted YAML in `daily-briefing.yml`

Two manual edits (`af1c8d0`, `ae65632`) had dropped the newline between three
steps' `if:` line and the following `env:`/`run:` key, merging them onto one
physical line (e.g. `if: ... == 'true'        env:`). That's invalid YAML --
every trigger of this workflow (cron, `daily-briefing-trigger` dispatch,
manual) failed before a single step could run, and CI's `actionlint` step
caught it on every subsequent push/PR. Restored the newlines/indentation only;
the conditions themselves (including the `steps.send.outcome == 'success'`
guard on "Record covered stories") are unchanged. Verified with `actionlint`
and a plain YAML parse.

### Capped `access.pending` independent of `MAX_USERS` (PR #48)

`MAX_USERS` only refuses new `/start` requests once the allowlist itself is
full -- it does nothing while `allowFrom` is nowhere near capacity. Since the
bot is publicly discoverable on Telegram, a flood of `/start` from distinct
senders could grow `access.pending` in the `BotState` DO without bound and
send the owner one "New access request" notification per sender, with no rate
limit. Added `MAX_PENDING` (50), enforced atomically inside `addPending` (same
check-then-write-in-one-DO-call pattern as `addAllowedUser`), so a flood past
the cap is refused before it's added to `pending` or notifies the owner.

### Added a technical specification doc (`docs/technical-spec.md`)

An interface/requirements-level companion to `docs/design.md`: scope and
non-goals, the full command contract with authorization invariants, the
`BotState` DO / KV / git-`state` data model, hard limits (`MAX_USERS`,
dispatch cooldown/cap, per-run LLM budget), NFRs, the three-layer daily
trigger, secrets/config, environments, and the test strategy. Where
`design.md` explains *why* the system is shaped the way it is, this specifies
*what* it must do so an implementation can be checked against it. Grounded in
the current code (v1.4.0); the two docs cross-link at the top.

### Pinned actionlint to a checksum-verified release in CI (PR #46)

The lint step in `.github/workflows/ci.yml` fetched the actionlint installer
from the upstream `main` branch and piped it straight into `bash` on every push
and PR -- unpinned and unverified, so a tampered or MITM'd upstream would run
arbitrary code in CI (highest blast radius on push to `main`, where the job
runs with the repo token in context). Replaced with a pinned release
(`v1.7.12`) downloaded from its tagged release URL and checked against the
published SHA256 (`sha256sum -c -`) before execution, so a swapped binary
aborts the job. Version bumps are now explicit edits to `ACTIONLINT_VERSION` +
`ACTIONLINT_SHA256`.

## [1.4.0] - 2026-07-13

### Serialized usage_stats DO methods with an explicit in-memory mutex (PR #44)

`bumpCommandCount`/`touchLastSeen`/`purgeUsageStats` read-modify-write the
`usage_stats` KV blob via `env.BOT_STATE` (`fetch()`), which Cloudflare's
automatic input/output gating does not serialize -- that gating only covers
`ctx.storage` calls. Two overlapping calls (e.g. `/forgetme`'s purge racing a
concurrent command's `touchLastSeen`) could interleave their get/put and
silently un-erase a just-purged entry. `withUsageLock` (a plain in-memory
promise chain, safe because a DO's JS execution is single-threaded) closes
that gap.

### Repo tooling

- Excluded markdown, then JS/MJS, from Prettier (`.prettierignore`) -- neither
  was ever prettier-clean, and Prettier's emphasis-style rewrites were
  churning docs. Added `.prettierrc` so the local formatting config is
  shared, and shared the project's Claude Code Stop hook (`npm test` gate)
  via `.claude/settings.json`.
- Silenced a shellcheck SC2016 false positive in `daily-briefing.yml` (#45).
- Committed the Worker Cron Trigger validation log (`docs/qa/`, PR #41).

### Addressed four open items from the design doc's limitations section

- **Delegated admin roles.** `/addadmin <id>` / `/removeadmin <id>` (owner-only,
  target must already be allowlisted) let the owner grant/revoke admin
  status. Admins get every owner-gated command (`/admin`, `/listusers`,
  `/adduser`, `/removeuser`, `/broadcast`, `/pending`, approve/deny
  callbacks) except managing admins themselves. Removing a user via
  `/removeuser` also revokes their admin status if they had it.
- **Corrected a doc inaccuracy, not a code gap.** The design doc claimed the
  30-user cap (`MAX_USERS`) wasn't enforced in code. On inspection it already
  was -- atomically in `BotState.addAllowedUser`, plus independently in
  `/start` and the callback-approval path -- and already covered by a test
  ("capacity cap holds"). No code change; corrected the doc.
- **Added `actionlint` to CI** (`.github/workflows/ci.yml`) to catch
  YAML/schema errors and shellcheck-level issues in workflow `run:` blocks,
  closing part of the "no automated coverage for the GitHub Actions
  workflows" gap. Execution-path testing of a full workflow run stays
  manual -- not worth chasing at this scale.
- **Generalized the Phase 16 re-benchmark mechanism** into a reusable one:
  `docs/qa/rebench-template.md` (was hardcoded to a single past change, named
  `PHASE16_BENCH`/"Phase 16 re-benchmark"). Renamed the trigger variable to
  `REBENCH` and the tracking issue to "Prompt re-benchmark — 5-run log" so it
  can be run after any future prompt change, not just growth pushes. The
  original `docs/qa/phase16-rebench-template.md` is kept as a historical
  record and now points to the new one.

### Added a system design doc

`docs/design.md` documents the deployed architecture as a reference for
future changes: the Worker/Actions split, the `BotState` Durable Object + KV
state model, command reference, secrets scoping, staging setup, and the
three-layer daily-trigger reliability mechanism (Cron Trigger primary,
GitHub schedule + watchdog as backups).

### Added a Cloudflare Cron Trigger as the primary daily-briefing trigger (issue #17)

GitHub Actions' `schedule` trigger for `daily-briefing.yml` (09:00 UTC) has
proven unreliable in practice: measured across every scheduled run from
2026-07-02 through 2026-07-13, actual fire time was 1h15m-3h49m late every
single time it fired at all, and it silently skipped firing entirely on
2026-07-08, 07-09, and 07-10. The watchdog (`daily-briefing-watchdog.yml`,
added after #17) has the identical failure mode -- also late 1-3.6h and also
silently skipped several of the same days -- since it relies on the same
`schedule` event. This matches GitHub's documented behavior: `schedule`
events are best-effort and specifically degrade under load at the top of
the hour.

The Worker already had a proven `repository_dispatch` path (`dispatchEvent`,
used by `/newbriefing` and `/broadcast`), so it gets a `scheduled` handler
that fires a `daily-briefing-trigger` dispatch, driven by a new Cloudflare
Cron Trigger (`worker/wrangler.toml`, 09:05 UTC -- Cloudflare's cron isn't
subject to GitHub's congestion). `daily-briefing.yml` now also listens for
`repository_dispatch: types: [daily-briefing-trigger]`. GitHub's own
`schedule` trigger and the watchdog's fallback dispatch stay in place as
redundant backups; the workflow's existing `last_briefing_at` idempotency
check makes it safe for more than one of the three to fire on the same day.

### Pinned briefing generation to Sonnet, then reverted back to Opus same day

`claude -p` calls in `daily-briefing.yml` and `on-demand-briefing.yml` never
passed `--model`, so generation silently ran on whatever the pinned Claude
Code CLI version's own default happened to be (Opus-tier) -- not a deliberate
choice, just an unset flag. Added `--model claude-sonnet-5` to both, for
lower cost per generation.

Same day, reverted both back to `--model claude-opus-4-8`: the first real
production run of `daily-briefing.yml` under Sonnet returned only 1 story
(vs. a typical 2-5), and a local side-by-side rerun of the identical
prompt/inputs on Opus returned 6 stories across all three sections. Two data
points in the same direction was enough to treat this as a real coverage
regression rather than noise, so `on-demand-briefing.yml` was reverted too
rather than leaving the two workflows on different models.

## [1.3.0] - 2026-07-11

### Re-tuned the daily briefing search fan-out after Phase 16 re-benchmark FAIL

The 5-run Phase 16 editorial re-benchmark (issue #15) came back FAIL: 2 of 5
real editions (2026-07-04, 2026-07-05) landed at only 2 items against the
prompt's own 4-item target, both stuck in the same narrow beat (AI
models/agents or a single labor-market trend). Root cause: `briefing-prompt.md`
only ran 4 generic searches up front and treated beat-diversifying queries
(funding/M&A, vendor/ATS product, workforce platforms) as an optional
last-resort fallback ("run up to 3 additional searches") that the model could
skip once it judged it had "enough." Two changes: (1) moved the two most
reliably orthogonal beats (funding round, ATS vendor product) into the
mandatory primary search set, run every time rather than only on shortfall;
(2) replaced the "up to 3" fallback cap with "run all of the following" plus a
richer category list (borrowed from `briefing-prompt-ondemand.md`'s existing,
more thorough fallback), and added explicit beat-diversity-over-volume
guidance so two items on the same underlying story no longer count as
covering two beats. Closed issue #15 and re-armed `PHASE16_BENCH` for a fresh
5-run window against the retuned prompt.

### Added a low-credit-balance precheck to catch a drained API key before generation runs

The daily briefing silently failed for several days (2026-07-06 through
2026-07-10) because `ANTHROPIC_API_KEY` ran out of credits -- nobody
noticed until asked to check the Actions tab. There's no Anthropic endpoint
to inspect remaining credit balance, so `scripts/check-credit-balance.mjs`
makes the cheapest possible real request (Haiku, `max_tokens: 1`) before
the multi-dollar WebSearch generation in both `daily-briefing.yml` and
`on-demand-briefing.yml`. On the specific "credit balance is too low"
error it sends one immediate, specific Telegram alert (owner, and the
requester too for on-demand) and fails the job right away instead of
burning the 2-attempt retry loop and 10-minute timeout on a call already
known to fail. The existing generic failure alerts skip this case so only
one message goes out per incident. This doesn't give advance warning
before the balance hits zero (no such signal exists via the API) -- it
converts a multi-day silent failure into a same-run alert.

### Fixed REL-2: subscriber-mirror write ordering could un-erase a removed user's send-list entry

`BotState.forgetUser`/`unsubscribe` committed the removal to Durable Object
storage, then mirrored the new subscriber list to KV as a separate write --
scripts/send-briefing.mjs reads only that KV mirror. A kill/eviction between
the two left an erased or unsubscribed user still on the KV list, with no
signal for the owner to retry, so they'd keep getting the daily briefing
after `/forgetme` promised otherwise. Reordered both methods to mirror to KV
*before* the DO storage commit -- a stale DO write self-heals on the user's
next command; a stale KV mirror wouldn't have, since nothing else re-checks
it. `subscribe()` is unaffected (a lagging mirror there just delays receiving
tomorrow's briefing, not a privacy issue). Added a call-order regression test
(verified it fails against the old ordering). Originally flagged as REL-2 in
`docs/qa/2026-07-02-phase9-reliability.md`, filed below.

### Filed four QA audit reports that were completed but never merged (Phase 9-12)

Found while cleaning up stale branches: `qa/phase9-reliability`,
`qa/phase10-performance` (plus its `test/perf-stress.mjs` harness),
`qa/phase11-security`, and `qa/phase12-code-quality` were written and
CI-passing back on 2026-07-02 but their branches were never merged. Phases
10-12's named findings (PERF-1/3, SEC-1/4) already got fixed independently by
later work under different issue numbers, so those three are filed as
historical record. Phase 9's REL-2 was still open -- fixed above.

## [1.2.0] - 2026-07-04

### Fixed usage_stats erasure race, story dedup, arg validation, and briefing header check (#29, #30, #31, #32)

Four more findings from the edge-case review. `purgeUsageStats`,
`bumpCommandCount`, and `touchLastSeen` are now `BotState` Durable Object
methods instead of free functions hitting KV directly, so all three
serialize through the singleton stub -- a concurrent command's
`touchLastSeen` write can no longer race a `/forgetme`/`/removeuser`
erasure and silently restore the just-purged entry (#31; the Worker-vs-CI
race against `scripts/sync-kv.mjs`'s direct KV write stays a known,
accepted limitation, same as before). Same-day story merges in
`update-recent-stories.mjs` now dedupe by normalized URL (`bulletUrlKey`/
`dedupeBullets`) instead of exact bullet text, so a reworded restate or a
second source domain for the same story collapses to one entry instead of
two (#30). `/adduser` and `/removeuser` now warn and no-op on extra
arguments instead of silently dropping them (#29). `isValidBriefing` only
accepts the header on the first non-empty line, closing the gap where a
refusal quoting the expected title format later in its text would pass
validation (#32).

### Added dispatch idempotency so a retried repository_dispatch can't double-fire (#28)

Another edge-case-review finding: `fetchWithRetry` retries the GitHub
`dispatches` POST on a 429/5xx/network error, but if GitHub actually
accepted the original request and only the response was lost, the retry
fired a second, distinct `repository_dispatch` for the same logical
action -- every subscriber getting a `/broadcast` message twice, or a
second $2 LLM generation for the same `/newbriefing` request. `dispatchEvent`
now stamps a `dispatch_id` (generated once per call, so retries of the same
call share it) into `client_payload`; both `broadcast.yml` and
`on-demand-briefing.yml` check it against KV before doing any real work and
skip a detected duplicate. Known limitation: `broadcast.yml` has no
concurrency group by design (AUD-3), so this isn't atomic against two
truly simultaneous duplicate runs -- it closes the realistic retry-after-
backoff case, not a sub-second race window.

### Fixed chunk() truncating or hanging on oversized/awkward HTML tags (#27, #37)

Two more findings from the edge-case review, both in the message-splitting
`chunk()` used before every Telegram send. (#27) The tag-balance backup only
backed the cut up before an unclosed tag when that tag started partway
through the slice; if a single tag's own content exceeded the chunk limit
(e.g. one bullet with an unusually long bold span or link), the tag started
at index 0 with nowhere earlier to back up to, and the naive cut could land
mid-tag. Now extends forward past the full close instead, even if that
pushes the one chunk past `limit` (still comfortably under Telegram's real
4096-char ceiling). (#37) Fixing that surfaced a related, more serious bug:
if a *dangling, not-yet-closed* tag-opening syntax (e.g. `<a href=`) sat at
index 0 -- possible when the tag's own attribute syntax holds the only
whitespace before the limit -- nothing corrected the cut at all, risking a
near-zero-progress slice that could hang the chunking loop. Restructured the
tag-safety check into two explicit phases (complete the tag syntax, then
close any open element) to cover both cases. Added regression tests for
each.

### Fixed link parser truncating URLs with parens (#26)

Another finding from the edge-case review: the Markdown link regex's URL
class was `[^\s)]+`, so any source URL containing a literal paren -- a
common shape for Wikipedia-style links, e.g. `.../wiki/Foo_(bar)` -- stopped
matching at the first `)`, truncating the href and leaving the rest as
stray literal text outside the closed anchor. Replaced the URL class with
alternating runs of "no space/paren" and one balanced `(...)` group, so a
single level of nested parens is captured as part of the URL -- covers every
real URL shape seen so far.

### Pin one run date per job to prevent UTC-midnight desync (#25)

The same edge-case review found that "today" was recomputed independently in
~7 places per job (`force-briefing-date.mjs`, `update-recent-stories.mjs`,
`build-recency-note.mjs`, `sync-kv.mjs`, `update-usage-stats.mjs`,
`send-briefing.mjs`, plus several `date -u` calls in the workflow YAMLs). A
generation run can take 10+ minutes, so a job straddling UTC midnight could
stamp the briefing title with one date while recording it in
`state/recent_stories.json` under a different one, silently breaking the
"don't repeat this story" guard. Both workflows now compute
`BRIEFING_DATE_ISO`/`BRIEFING_DATE_HUMAN` once at job start via `GITHUB_ENV`,
and every step/script reads that instead of calling `date -u`/`new Date()`
on its own (each script still falls back to computing fresh when run
standalone, so manual invocations are unaffected).

### Retry the state commit/push on rebase conflict or transient failure (#24)

A subagent edge-case review flagged that the "Commit updated state" step in
`daily-briefing.yml`/`on-demand-briefing.yml` had no retry around `git pull
--rebase && git push`: a rebase conflict or transient push failure aborted
the job *after* the briefing/on-demand response had already been delivered,
silently dropping that run's recent-stories/usage-stats update with no
recovery path. Both steps now retry the pull-rebase+push up to 3 times with
backoff, using `-X theirs` (safe here since the commit only ever touches
`state/`, so it's fine to always keep our freshly-generated data over
whatever a conflicting upstream commit did to the same lines — note
`rebase`'s `theirs`/`ours` meaning is the reverse of `merge`'s). If all
retries are exhausted, the step now exits with an explicit `::error::`
instead of a bare git failure, so the existing failure-alert steps correctly
notify that delivery succeeded but state wasn't persisted.

### Fixed two gaps in the story-dedup fix (same-day loss + cold start)

The user reported "Claude Tag" and a Microsoft Teams story repeating from a
2026-07-03 edition, even after the dedup fix (see above) merged. Two bugs:
(1) `scripts/update-recent-stories.mjs` *replaced* today's entry on every
run instead of merging, so multiple same-day editions (a daily run plus
on-demand runs) lost each other's stories from memory — fixed to merge
(dedupe by exact bullet text). (2) `state/recent_stories.json` only started
existing when the dedup PR merged, so it had zero memory of anything from
before that moment — backfilled it from the full git history of
`state/today_briefing.md` (2026-07-01 through today), unioning bullets per
calendar day. That backfill also surfaced a real cost risk: a single
heavy-testing day merged 60 bullets into one entry, and injecting that
unbounded into every future prompt would be thousands of extra tokens per
run — enough to risk re-triggering the `--max-budget-usd` overrun from
earlier today. Added `recentStoryBullets()` (shared/telegram.mjs), capping
the prompt-injected list to `MAX_RECENT_STORY_BULLETS` (20), keeping the
most recent ones; storage itself stays bounded only by the 14-day window and
will settle down naturally as today's heavy-testing entries age out.

### Fixed nested *italic* inside **bold** breaking Telegram formatting

A live send on 2026-07-04 reached Telegram with raw, unconverted Markdown
in one bullet — literal `**`/`*` characters instead of bold/italic. Cause:
`shared/telegram-markdown.mjs`'s bold regex (`\*\*([^*]+)\*\*`) required the
bold span to contain zero asterisks, so a case name italicized *inside* a
bold sentence (`**...the claims in *Mobley v. Workday* proceed**`, a real
generation) made the whole bold match fail and fall through as literal text.
Rewrote the tokenizer to match bold non-greedily up to the next `**` and to
recurse into its contents, so nested `*italic*` now renders as `<i>` instead
of breaking the enclosing `<b>`. `chunk()`'s tag-balance scan already handled
nesting correctly (it's a real stack, despite its comment claiming otherwise
— comment corrected) so no change was needed there.

### Cross-day story dedup (no more repeat "news")

The Claude Sonnet 5 launch (30 June) ran in both the 2026-07-03 and
2026-07-04 daily editions, cited via a different source domain each time.
Root cause: `briefing-prompt.md`'s freshness filter is a rolling "published
in the past 7 days" window, and nothing tracked what a prior edition had
already reported — "never cite the same domain twice" only dedupes within a
single day's edition. Added `state/recent_stories.json`, written by
`scripts/update-recent-stories.mjs` after a real, sent edition (gated the
same as usage-stats/KV updates) and pruned to the last
`RECENT_STORIES_WINDOW_DAYS` (14, matching the on-demand prompt's wider
freshness fallback). `scripts/build-recency-note.mjs` reads it back and
injects a "stories already covered, do not repeat" list into the generation
prompt in both `daily-briefing.yml` and `on-demand-briefing.yml`. Both
prompt files now document the rule explicitly.

Verified live post-merge with two back-to-back `/newbriefing` runs: the
first had nothing to dedupe against yet (the day's only prior edition ran
before this fix merged) and re-cited the Sonnet 5 launch; the second, now
reading real history from `recent_stories.json`, produced two entirely new
stories (Claude Enterprise admin controls, Claude GA on Microsoft Foundry)
with no repeats.

### Pinned the Claude Code CLI version

Both briefing workflows ran `npm install -g @anthropic-ai/claude-code` with
no version pin, so every run installed whatever was newest at the time. The
likely explanation for generation suddenly exceeding the `--max-budget-usd 1`
cap the day after that cap was tuned (see below) is a CLI update changing
cost-relevant behavior (model default, WebSearch/verification depth, token
accounting) — nothing in this repo's prompt or scoring logic changed in that
window. Pinned to `@anthropic-ai/claude-code@2.1.201` in both workflows so a
future CLI release can't silently shift generation cost or behavior; bump the
pin deliberately when upgrading.

### Surfaced briefing generation errors; bumped budget cap (#18, #19)

Today's briefing runs failed with no useful detail in the Actions log — both
`daily-briefing.yml` and `on-demand-briefing.yml` redirected `claude`'s
stdout straight into `state/today_briefing.md` on each retry and logged only
"Generation attempt N failed.", so the actual cause was invisible. Root
causes turned out to be two distinct, sequential issues: an Anthropic API
rate limit (resolved by adding funds), then the `--max-budget-usd 1` ceiling
from 1.1.0 being too tight for a successful generation. Now both workflows
capture and print `claude`'s stdout and stderr on a failed attempt (#18), and
the budget cap is raised from `1` to `2` (#19). `state/briefing_stderr.log`
is gitignored so it never pollutes the state commit on success.

### Documented the release policy

There was no written rule for when a changelog entry graduates from
`[Unreleased]` into a tagged version. Added a "Releasing" section to
`README.md`: SemVer bump rules (patch/minor/major) and a per-batch (not
per-PR) cadence for cutting a release. Docs-only, no code change.

### Daily briefing watchdog (#17)

`daily-briefing.yml`'s 09:00 UTC `schedule` trigger fired ~2.5h late two days
running (2026-07-02, 2026-07-03) — GitHub documents `schedule` as best-effort,
and on 07-03 it initially looked like it hadn't fired at all until a later,
very-delayed run showed up. Added `daily-briefing-watchdog.yml`: runs at
10:30 UTC, checks whether `last_briefing_at` has advanced to today, and if not,
dispatches a fallback `daily-briefing.yml` run and alerts the owner. Safe
against a race with the delayed native schedule trigger — the existing
idempotency check and shared `briefing-generation` concurrency group make
whichever run loses the race a no-op.

## [1.1.0] - 2026-07-03

### Bound the briefing generation step (LLM10 / ASI02)

The `claude -p` WebSearch-driven generation step in both `daily-briefing.yml`
and `on-demand-briefing.yml` had no wall-clock or cost ceiling — a stuck or
pathological WebSearch loop could run to GitHub Actions' default multi-hour
job timeout with no circuit breaker. Added `timeout-minutes: 10` on the step
and `--max-budget-usd 1` on the `claude -p` call in both workflows. Found via
an OWASP-aligned security pass over the briefing generation flow
(`agent-security-skill`, installed project-locally under `.claude/skills/`).

### `TELEGRAM_WEBHOOK_SECRET` rotated

Generated a fresh secret, set it on the production Worker (`wrangler secret put`),
and re-pointed Telegram's webhook at it via `setWebhook`. Routine rotation, not
a response to a leak — the old value simply wasn't recoverable (Cloudflare
Worker secrets are write-only), so a rotation was the practical path forward.
Confirmed via `getWebhookInfo` (`pending_update_count: 0` — no updates lost
during cutover).

### Clarify `/briefing` vs `/newbriefing` in `/help` copy

A user couldn't tell the two commands apart from the help text and had to ask
a colleague what `/newbriefing` actually does. Reworded both lines to say what
each one does differently, not just restate the command name.

### Point new users to `/help` in the `/start` greeting

Recruiters weren't discovering `/admin`, `/subscribe`, etc. beyond `/briefing`.
The greeting now tells approved users `/help` exists.

## [1.0.0] - 2026-07-03

Baseline release: Cloudflare Worker command bot + GitHub Actions briefing
delivery, tagged retroactively at the commit preceding the work above.
Everything below predates versioning.

### Phase 16 re-benchmark harness — editorial consistency scorer + scorecard (#14)

Tooling for the pre-growth editorial re-benchmark the final release audit gated
behind raising `MAX_USERS` / public enrollment. `docs/qa/phase16-rebench-template.md`
defines 8 binary hard gates (encoding the AUD-1 floor and the prompt's hard
filters) plus the original 5-dimension editorial rubric, with a fill-in scorecard
for 5 consecutive daily runs; its verdict rule scores the **floor (worst day),
not the average**, because AUD-1 was a consistency defect. `scripts/score-briefing.mjs`
auto-fills the scriptable columns (item count, gates G1–G5/G7, live link
resolution, domain dedup) from a composed `state/today_briefing.md`, reusing
`countBriefingItems()` / `MIN_BRIEFING_ITEMS` so the floor stays single-sourced.
QA-only — no runtime/worker change. The daily workflow gained an opt-in scoring
step (gated on the `PHASE16_BENCH` repo variable, `continue-on-error`) that posts
each edition's scorecard row to a "Phase 16 re-benchmark — 5-run log" tracking
issue while the benchmark window is on.

### SEC-1 closed — GitHub PAT rotated to a fine-grained, repo-scoped token

The last open audit item is done. The Worker's `GITHUB_TOKEN` no longer uses a
classic full-`repo` PAT (which granted push access to every repo on the account
if leaked). It now runs on a **fine-grained, this-repo-only `Contents: write`**
token — the exact scope `repository_dispatch` needs — and the old classic token
has been **deleted**. Docs updated (README rotation-status note + both QA status
docs mark SEC-1 resolved). No open findings remain across the whole audit.

### Fix misleading "being generated" message during a stale cooldown (UX-6)

Observed live: the first `/briefing` early on a new UTC day (before the 09:00
daily) replied "A briefing is being generated right now — send /briefing in a
couple of minutes" when nothing was generating — the global 1-hour dispatch
cooldown had simply carried over from the previous evening's on-demand run, and
that run produced *yesterday's* dated briefing, so there was no fresh cache to
serve either. `reserveBriefingDispatch` now also returns `sinceLastMin`, and
`requestGeneration` uses a `GENERATION_IN_FLIGHT_MIN = 10` window: within it a
run is plausibly still syncing (keep the "being generated" wording); past it,
say "Couldn't refresh the briefing just now — a fresh one can be generated in
~N min. You'll also get today's automatically with the daily update." New
behavioral test F13b covers both branches. Full suite 90/90 green.

### Improved AI news briefing quality (#9, #10)

- Improved the freshness, relevance, and reliability of AI recruitment news briefings.
- Reduced stale or repeated content by strengthening WebSearch and source selection.
- Enhanced article verification and fallback logic for more consistent daily briefings.

### Final release audit (GO) + fixes for AUD-1 (thin-briefing gate) and AUD-2 (bold-safe chunking)

Full audit report: `docs/qa/2026-07-03-final-release-audit.md`. Verdict: **GO**
for the current private ≤30-user deployment — no Critical/High open; a live
dry-run generation with the production prompt scored 7.5/7/6.5/8.5/7 on the
Phase 16 editorial rubric. Two findings fixed in the same session:

- **AUD-1 (Medium)** — no minimum-content gate: the briefing cached in prod was
  a single story, and even the dated "no content available" fallback passed
  both the `isValidBriefing` and freshness gates — on the daily path it would
  go to every subscriber, advance `last_briefing_at`, and silently block
  retries for the rest of the day. Now `countBriefingItems()` counts linked
  story bullets with a `MIN_BRIEFING_ITEMS = 2` floor: the daily workflow's
  check runs *before* the send and requires dated-today AND ≥ 2 items (else
  the stale-or-thin alert fires and the day stays retryable); on-demand treats
  a zero-story generation as stale; and `sync-kv.mjs` refuses to cache anything
  under the floor regardless of caller. Both prompts gained a minimum-coverage
  loop (run more-specific searches when < 4 items pass the filters), an
  impact-ordering rule, a source-tier preference, and a closing
  "**Bottom line:**" synthesis sentence.
- **AUD-2 (Low)** — `chunk()` protected `<a>…</a>` pairs (L6) but not
  `<b>…</b>`: a single line > 3500 chars whose space-preferring cut landed
  inside a bold span produced two chunks Telegram rejects. The balance check is
  now a general tag-stack scan that backs the cut up to the first unclosed tag
  of any kind.

- **AUD-3 (Low)** — a third rapid `/broadcast` silently replaced a *queued*
  one: GitHub keeps only the latest pending run per concurrency group, and a
  cancelled run doesn't fire the `failure()` alert. The group is removed from
  `broadcast.yml` — overlapping runs are safe (paced + 429-retried, worst case
  slightly slower delivery), while the group could drop a whole broadcast.

New regression tests for AUD-1/AUD-2 (thin-briefing counting incl. the
fallback and the observed 1-story case; bold-span chunk balance + anchor
non-regression). Full suite 89/89 green. Remaining manual item: confirm the
one-time SEC-1 PAT rotation of the live Worker `GITHUB_TOKEN` secret.

### Clear the last audit findings: BUG-4 (broadcast at scale) + L6 (chunking)

- **BUG-4** — `/broadcast` delivery moved off the Worker onto the Actions runner.
  The Worker now validates the owner + message and fires a `broadcast`
  `repository_dispatch`; the new `broadcast.yml` workflow runs
  `scripts/broadcast.mjs`, which fans the message out to every subscriber
  (paced + retried, de-duped at send time via the shared `sendTextToMany`) and
  reports delivery back to the owner. This removes the Worker's per-invocation
  subrequest ceiling that silently dropped recipients past ~45 — including the
  multi-chunk case the earlier `MAX_USERS=30` cap didn't cover. The message and
  owner id travel as `client_payload` and are read as env vars (never
  interpolated into a shell), so a message with shell metacharacters is inert.
- **L6** — `chunk()` is now tag-aware: it prefers a newline, then a space, and
  never splits inside an HTML tag or across an `<a>…</a>` pair, so a single
  >3500-char line of links no longer produces chunks Telegram would reject.
- **SEC-1** — already documented (least-privilege scope table + rotation
  checklist in the README); the remaining step is the one-time manual rotation
  of the live `GITHUB_TOKEN` Worker secret to a fine-grained, this-repo-only
  `Contents: write` PAT.

Behavioral tests updated for the dispatch-based broadcast; new shared tests for
`sendTextToMany` (plain-text verbatim delivery + blocked-recipient resilience).
Full suite 86/86 green.

### 2026-07-02

### Phase 14 regression + consolidated audit status

Full-suite regression after the Phase 9–13 audit and the UX fixes:
`docs/qa/2026-07-02-phase14-regression.md`. All sources parse; `main` 75/75 and
the integrated `fix/phase13-ux-polish` tip 77/77, both green — the UX work added
two tests and regressed nothing, and the six `KNOWN BUG`/`L6` markers still pass
(open by design). The report also consolidates every phase's open findings into
one register with a priority block. Verdict: regression PASS, release GO for the
current private single-operator deployment; before opening enrollment past
~30–50 subscribers, do the priority cluster (a shared resilient send helper
closes REL-1/PERF-3/CQ-2 and hosts PERF-1's runner-side fan-out; a one-line
`getJSON` guard closes SEC-4). Phase coverage 1–14 complete. Report-only.

### Phase 13 UX review

Walked every user-facing reply and the onboarding/approval flow across all
three roles: `docs/qa/2026-07-02-phase13-ux.md`. Core conversational UX is
strong — no dead-ends, self-service identity in every unapproved reply,
immediate async acknowledgement, ungated privacy commands. No blocker. Polish
findings: UX-1 (medium) — commands are case-sensitive, so mobile
autocapitalization breaks `/Start`/`/Briefing` (one-line `.toLowerCase()` fix);
UX-2 (low–med) — `/help` omits `/newbriefing` even though the menu lists it;
UX-3 (low) — four admin id replies render literal backticks (Markdown without
`parse_mode`); UX-4 (low) — denied applicants get no notification; UX-5 (low) —
"Paired" wording is a leftover from the removed pairing-code model. Report-only,
no code changes.

### Clear remaining Worker findings: SEC-2, BUG-5, BUG-6, BUG-7

Low-severity / hardening fixes from the Phase 15 release-gate audit, all in
`worker/src/index.js`:

- **SEC-2** — `fetchWithRetry` now honors `Retry-After` in seconds (its real
  unit) instead of multiplying by 300ms. A 5s ask previously retried in 1.5s and
  drew a second 429; it now waits the full interval, with a short linear backoff
  when the header is absent.
- **BUG-5** — `/broadcast` strips its command prefix from the *trimmed* text, so
  a message sent with leading whitespace (`"  /broadcast hi"`) no longer ships
  the literal `/broadcast` prefix out to every subscriber.
- **BUG-6** — a stale Approve button no longer silently re-adds a user who was
  removed (or already handled) since the card was sent; the owner gets a
  "No longer pending" answer instead.
- **BUG-7** — approving via `/adduser <id>` now clears the matching pending
  request atomically (folded into the DO's `addAllowedUser`), so the person no
  longer lingers in `/pending` with their name/username still stored.

The three "KNOWN BUG" behavioral tests were flipped to assert the corrected
behavior; full suite 84/84 green.

### Fix NEW-1 (High): on-demand generation could poison the shared briefing cache

Phase 15 re-audit found the daily workflow's BUG-1 freshness gate was never
ported to the on-demand path. A zero-exit garbage generation (LLM refusal /
preamble-only / malformed title) from `/newbriefing` was synced to Cloudflare
KV unconditionally, so every user's `/briefing` then served that garbage from
cache until the next successful generation. Reproduced against the real Worker.

- **`on-demand-briefing.yml`** — added a `Check freshness` step; `Send to
  requester`, `Sync to Cloudflare KV`, and `Commit` now gate on `fresh == 'true'`.
  A new `Notify requester on stale generation` step closes the loop when
  generation exits 0 but produces nothing dated today (`failure()` doesn't fire).
- **`scripts/sync-kv.mjs`** — defense-in-depth `isValidBriefing(md)` guard so no
  caller can overwrite the shared cache with a headerless generation.
- **`shared/telegram.mjs`** — new shared `isValidBriefing()` helper.
- **Tests** — regression test for the guard; full suite 84/84 green.

### Operational resilience: failure alerts, retries, observability, tighter scopes

Addresses the production-readiness review (secret scopes, failure handling,
observability, webhook cutover risk):

- **Failure alerting** — new `scripts/send-alert.mjs` (best-effort, never throws,
  reuses the runner's `tgRequest`). `daily-briefing.yml` now pings the owner on
  `failure()` and on a stale-but-non-fresh generation (previously silent:
  subscribers got nothing and nobody knew). `on-demand-briefing.yml` notifies the
  waiting requester on failure instead of leaving them hanging. Requires a new
  `OWNER_CHAT_ID` repo variable.
- **Generation retry** — the `claude -p` step in both workflows retries once
  before failing, so a transient web-search/API hiccup doesn't cost the run.
- **Workers observability** — `[observability] enabled = true` in `wrangler.toml`,
  so the Worker's `console.error` calls persist as queryable logs.
- **Least-privilege secrets** — README gains a scope table + rotation checklist;
  `GITHUB_TOKEN` guidance switched from classic `repo` scope to a fine-grained,
  this-repo-only `Contents: write` PAT. Retired the obsolete
  `TELEGRAM_SUBSCRIBER_CHAT_IDS` repo secret (subscribers live in KV now).
- **Staging env** — optional `[env.staging]` block (separate Worker + KV + bot)
  for dry-running command changes before touching the live webhook; ignored by
  the default `wrangler deploy`.

### UX polish fixes (Phase 13 findings)

Fixed all five findings from the Phase 13 UX review:

- **UX-1** — commands are now case-insensitive: the dispatcher lowercases the
  command name before lookup, so mobile autocapitalization (`/Start`,
  `/Briefing`) resolves to the handler instead of the "I only understand
  commands" nudge. Also consolidates command-count stats across cases. The
  `/broadcast` prefix strip was made case-insensitive too, so a capitalized
  `/Broadcast` (now reachable) doesn't ship the literal command to subscribers.
- **UX-2** — `/help` now lists `/newbriefing`, matching the client command menu.
- **UX-3** — the four `/adduser` / `/removeuser` id replies now render the id in
  `<code>` (HTML) instead of showing literal Markdown backticks; the id is
  HTML-escaped.
- **UX-4** — denied applicants now get a neutral "your request wasn't approved"
  reply instead of being left in silence.
- **UX-5** — "Paired"/"Paired as" reworded to "You're approved"/"Approved as",
  matching the allowlist model (the pairing-code machinery was already removed).

Tests updated to assert the new behavior, plus a new deny-notification test
(76/76 green).

### Command menu registration (setMyCommands)

Added `scripts/set-commands.mjs`. The Worker handles commands but never
registered them with Telegram, so clients showed no "/" autocomplete or Menu
button. The script sets a public command list for everyone (default scope)
and an extended list including the admin commands scoped to the owner's chat
only. Run once after deploy and whenever the command set changes.

### Editorial prompt overhaul + behavioral test suite in-repo

Follow-ups from the release-gate audit:

- Both briefing prompts rewritten against the editorial findings (ED-1..3):
  news-phrased search queries instead of trends/guide bait, hard 7-day
  publish-date filter with the date shown per bullet, drop-if-unverifiable,
  no evergreen guides/listicles, no repeated domains, and regulatory dates/
  stats only from primary or authoritative sources. Sections shrink or
  disappear rather than get padded.
- The audit's 57-scenario behavioral harness now lives in
  `test/worker.behavior.test.mjs` and runs in CI via `npm test`. It drives
  the real Worker source (a `node:module` hook stubs only the
  `cloudflare:workers` import) against mocked KV/DO/fetch, covering auth,
  pairing, rate limiting, admin commands, hostile input, Telegram protocol
  edges, concurrency, and failure injection. Tests named `KNOWN BUG-n`
  intentionally assert current buggy behavior to track open findings.

### Release-gate QA audit + three must-fix bugs fixed

Full QA/security audit (57 behavioral scenarios against the worker code under
a mocked CF runtime, Telegram failure injection, link + editorial review of
the live briefing): `docs/qa/2026-07-02-release-gate.md`. Verdict:
conditional GO, no security-critical findings. Fixed the three must-fix bugs:

- Daily workflow: usage-stats step now gated on the freshness check, so a
  garbage generation can't mark the day done and block retries (BUG-1).
- Daily + on-demand workflows share one concurrency group and rebase before
  push, so they can no longer run concurrently and clobber state (BUG-2).
- Worker: `Object.hasOwn` guards in command dispatch and stats counting —
  `/constructor`-style messages now get the normal nudge instead of silence
  plus garbage in the `usage_stats` KV key (BUG-3).

Open findings (broadcast subrequest cap at ~45 subscribers, stale approve
button, `/adduser` pending leftover, editorial staleness, etc.) are tracked
in the report.

### Daily briefing now follows the bot's live subscriber list

Previously the daily 09:00 UTC send went to a hand-maintained
`TELEGRAM_SUBSCRIBER_CHAT_IDS` repo secret, so /subscribe and /unsubscribe in
the bot had no effect on actual delivery.

- The Worker's Durable Object now mirrors the subscriber list into the
  `subscribers` KV key on every /subscribe, /unsubscribe, and /removeuser.
- `scripts/send-briefing.mjs` reads that KV key via the KV REST API at send
  time (using the existing `CF_*` secrets) and reports `recipient_count` to
  later workflow steps via `GITHUB_OUTPUT`.
- `daily-briefing.yml` reordered: send runs first, then usage stats and KV
  sync consume its recipient count. The `TELEGRAM_SUBSCRIBER_CHAT_IDS` secret
  is no longer read anywhere and can be deleted.

### Rate limit on briefing generation

Each /newbriefing (or /briefing with a stale cache) triggers a paid GitHub
Actions + Claude API run, previously unbounded.

- Global 60-minute cooldown between generation dispatches, enforced
  atomically in the Durable Object (`reserveBriefingDispatch`), with rollback
  if the GitHub dispatch fails.
- During the cooldown users are served today's cached briefing if it exists,
  or told one is being generated.
- Per-user backstop: max 3 generation requests per day (UTC), reset at
  midnight.

### Release-audit fixes (security, reliability, correctness)

Findings from a full pre-release audit of the Worker and CI pipeline.

- CI no longer runs Claude Code with `--dangerously-skip-permissions`; the
  briefing job is restricted to `--allowedTools "WebSearch"`, and file saving,
  idempotency, and stats bookkeeping moved out of the LLM into deterministic
  scripts. Closes a prompt-injection → secret-exfiltration path.
- `access` and `subscribers` moved into a `BotState` Durable Object.
  Concurrent /subscribe and /adduser calls were losing the majority of writes
  under a plain KV read-modify-write (measured: 15 concurrent /subscribe → 2
  landed; now all 15).
- Link `href`s are escaped in `mdToHtml` (shared module used by the Worker and
  both send scripts), so a stray quote in a URL can't break Telegram's HTML
  parser or inject markup.
- Telegram and GitHub API calls now check responses and retry 429/5xx with
  backoff instead of silently swallowing failures. /broadcast chunks to the
  4096-char limit and reports real delivery failures.
- `access.pending` is now populated from /start and shown by /pending (was
  dead code); duplicate Telegram `update_id`s are de-duped so a redelivery
  can't re-run /broadcast; /help respects the allowlist gate; /adduser
  validates the chat id is numeric; on-demand-briefing.yml got a concurrency
  group.

### /briefing crash and formatting fixes

Found by live testing against the deployed bot.

- /briefing no longer crashes reading `today_briefing_date`: it's a plain
  `YYYY-MM-DD` string, so reading it with KV's `json` type threw and produced
  no reply at all when a cached briefing existed.
- `mdToHtml` now renders inline `**bold**` instead of leaving literal
  asterisks in the message.
- The briefing title date is passed into the prompt and force-corrected
  post-generation (`scripts/force-briefing-date.mjs`), so it can't drift — the
  date is load-bearing for the freshness check.

### Privacy features (GDPR/LGPD baseline)

For opening the bot beyond invite-only use.

- `/privacy` — notice covering what's stored, why, where, retention, and
  rights; readable by anyone, approved or not.
- `/mydata` — subject access request; shows a user everything on file.
- `/forgetme` — right to erasure; wipes allowlist entry, subscription, pending
  request, and activity log (owner can't erase self).
- Owner-initiated /removeuser now fully erases the target's data too (was
  leaving `usage_stats` residue).
- /subscribe captures informed consent, pointing to /privacy.
- The per-user `last_seen` activity log auto-expires after 90 days via a prune
  sweep on every command.

### Guide unrecognized input instead of silence

- Plain text, typo'd commands, and non-text messages (stickers, photos, voice)
  in a private chat now get a short pointer to the available commands —
  /briefing + /help if approved, /start if not. Group chats and sender-less
  posts stay silent; message content is neither stored nor echoed.

### Webhook cutover

- Cut over from the local long-polling `server.ts` to the deployed Worker
  webhook. To avoid a token conflict with the Claude-via-Telegram plugin
  (whose poller auto-cleared the webhook on restart), the bot moved to its own
  dedicated token/bot (@AIinTANewsBot). Webhook secret rotated.
