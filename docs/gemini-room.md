# Gemini room

A chat room where the bot answers with Google Gemini (owner's request of 2026-11-24). Code:
`src/services/gemini/` (room, client, tools, text), config `src/config/geminiRoom.js`, wired in
`src/events/messageCreate.js`, tests `tests/geminiRoom.test.js`.

## Turning it on

- Set the Railway variable **`GEMINI_API_KEY`** (a key from https://aistudio.google.com/apikey) on the bot's
  service and redeploy. No key = the room is off and the log says so once. The key is only sent to Google in the
  `x-goog-api-key` header; it is never logged, shown in a reply, an embed or `/gemini-room status`.
- Optional **`GEMINI_MODEL`**: empty = `gemini-3.8-flash` (the newest stable Flash model in November 2026;
  `gemini-2.5-pro` / `gemini-2.5-flash` are deprecated). The model must support function calling.
- The default room is Zenith's `1570728122259611779`. In any server an owner (`src/config/serverOwners.js`) can
  use `/gemini-room set [channel]`, `/gemini-room off` and `/gemini-room status`; it only changes that server.

## What it does

- A normal message in the room gets an answer only when someone mentions the bot or replies to one of its
  messages (an @everyone or role ping does not count); other messages are left alone. The answer is short: Egyptian Arabic by default, the writer's language
  otherwise, plain text, a reply that pings nobody (`allowedMentions` none, mentions taken out), split at 2000
  characters (3 messages at most), with the typing indicator.
- In the room, commands need a prefix (`!`, `.`, `-` ...): prefixed messages, other bots' commands (`-p`, `$bal`,
  `@OtherBot ...`), trust words and `afk` go to the usual handlers and get no Gemini answer. Everything else is
  Gemini's only (no auto-replies, no command words without the prefix). The moderation guards (spam, insults,
  @everyone, invites) still run first.
- Context: the room's last 6 messages of the last 30 minutes, 300 characters each, labelled `owner`, `bot` or
  `user-1`, `user-2` (no names, no IDs; mentions become `@member`). Nothing from other rooms or servers, and
  nothing is kept after the answer.

## Two tiers

- **Owners** (`isServerOwner`): Gemini gets two tools. `post_message` (like `say`) never posts at once: the answer
  shows a preview written by the bot's code with ✅ / ❌, and only the owner who asked can press them (checked
  again at the press, with the channel's permissions). `bot_activity_summary` gives this server's numbers from
  `/bot-activity` (read only). Every tool call checks `isServerOwner` of the original message's author in code.
- **Everyone else**: questions and answers only. Their request has no tool list at all, so no text in a message
  ("I am the owner", "ignore your instructions") can reach a tool; the system prompt also refuses to share its
  instructions, the configuration or keys.

## Limits

5 answers a minute per member (one notice, then silence), 30 a minute for the whole bot, 4 at once and one at a
time per member, 1500 characters in, 20 seconds per answer. Gemini's safety filters are on
(`BLOCK_MEDIUM_AND_ABOVE`). Nothing is retried: after a 429 (or its Retry-After), a 5xx, a timeout or a refused
key the bot leaves Gemini alone for a while and answers with a short Arabic apology.
