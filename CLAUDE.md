# AI-in-TA Telegram bot

A Cloudflare Worker that sends a daily AI-recruitment briefing to an allowlisted
set of Telegram users. The Worker ships from CI on merge to `main`; the scripts
under `scripts/` are the generation and operations tooling around it.

## Rules for changes in this repo

1. Any change to bot behavior, a command, or a documented rule updates
   `README.md` and `CHANGELOG.md` in the same PR. Docs must never describe
   behavior the code no longer has.

2. Every change lands through a pull request against `main` with green CI. No
   direct pushes to main.

3. New or changed behavior in `worker/src/` or `shared/` is covered by a test in
   `test/`. A behavior change that touches no test needs an explicit reason in
   the PR body.

4. A deploy is only done once verified live against the running Worker — `GET
   /status`, or `scripts/check-deployed.mjs`. A green merge is not evidence of a
   deploy.

5. Secrets, bot tokens, and API keys never appear in source, logs, test
   fixtures, or committed state files. Redact to first and last 4 characters
   anywhere a value must be shown.

6. Reformatting is not a side effect. JS and MJS are excluded from prettier
   here, so a diff must not restyle lines the change does not touch.

7. No emoji in code, comments, commit messages, PR bodies, or generated docs.
   Prose uses spaces around em-dashes.

8. A change to admin gating, the allowlist, broadcast, or cost controls states
   explicitly who can invoke the command and what the effect is on the daily
   12:00 UTC run, preserves owner-only enforcement on admin commands, and does
   not silently raise spend caps.
