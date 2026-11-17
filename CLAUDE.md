# Notes for Claude

## All servers (owner's rule of 2026-11-17)

The owner's rule, literally: **every change from now on applies to all servers the bot is in, not one
server only** ("اي تعديل بعد كده هيتعدل على كل السيرفرات مش سيرفر واحد بس"). This replaces the older rule
that new things were for the home server (`HOME_GUILD_ID` = 1155236281706627173) only.

- New features and changes work in every server: do not gate them on `isHomeGuild`. Per-server texts use the
  server's own name (for example the welcome says "welcome to <server name>").
- Owner-only commands stay limited to the owner ids (`src/config/serverOwners.js`) but work in every server.
- Older features that are still gated on `isHomeGuild` keep working as they are until they are touched;
  when you change one, make it work everywhere unless the owner says otherwise.
- Tests cover a second server too.
