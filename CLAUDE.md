# Notes for Claude

## Changes apply to every server (owner's rule, replaces the old "home server only" rule)

The owner's rule, literally: **from now on every change is for everything, no exceptions.** New features,
changes to existing ones, commands, boards, timers and settings all apply to **every server the bot is in**,
in this repo and in the CC bot (`0skar11/CC-bot`).

- Do not gate new work behind `isHomeGuild(guildId)` (`src/config/homeGuild.js`) and do not keep a separate old
  behaviour for other servers. Existing home-server-only code stays as it is until the owner asks to change it.
- Tests cover the change in more than one server where that makes sense (see `tests/hotKeyCache.test.js`).
- Which servers the CC bot answers in is a deployment setting (`BOURSE_GUILD_IDS`, `ECONOMY_SCOPE_ID`; see
  `PUBLIC-MODE.md` in that repo), not something the code decides.

The bot's own server is still **1155236281706627173** (`HOME_GUILD_ID`): the shared CC balance and the bourse
data are saved under its keys (`src/config/sharedEconomy.js`).
