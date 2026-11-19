# AGENTS.md — DISbot (Aether)

Node 22, ESM, discord.js v14, PostgreSQL. Deployed from the branch `codex/discord-command-registration` to Railway: a push there is a production deploy.

## Commands
- Install: `npm ci`
- Tests: `node --test` (no secrets needed; Discord is mocked)
- Syntax check a file: `node --check <file>`

There is no lint or build step.

## Layout
- `src/events/messageCreate.js`: typed-command pipeline (`handlePrefixCommand`); commands hidden or moved to the other bot: `src/config/commands/commandAvailability.js`.
- `src/services/moderation/**`: chat filter (`chatFilterRules.js`, `chatFilterService.js`), the owner `automod` command, role hierarchy (`memberHierarchy.js`), by-name member targets, moderation logs.
- `src/services/bugsReports*.js`, `reportIssueService.js`: staff bug reports become numbered GitHub issues (label `بلاغ`); closing an issue makes the bot announce it.
- `src/services/backgroundRemoval/**`: `.removebg` (onnxruntime-node in a worker thread).
- `src/config/serverOwners.js`: owner ids. `src/config/homeGuild.js` is legacy: new work applies to all servers.

## Rules
- No secrets in code, commits, PRs or logs. Everything applies to all servers (owner's rule of 2026-11-17).
- Moderation commands always check the role hierarchy (the actor must outrank the target) and re-check permissions on button presses.
- The chat filter never reacts to ordinary chat; owners and trusted staff are exempt.
- Keep each file's line endings (`git show HEAD:path`), no invisible characters, tests for every change. Bot replies: short Egyptian Arabic.
- Work on a feature branch and open a PR into `codex/discord-command-registration`.
- Bug reports from staff are GitHub issues in this repo (label `بلاغ`): close with `gh issue close N --reason completed` after the fix is merged.
