// geminiText.js — text helpers for the Gemini room: what goes to Gemini (no member IDs or names) and what
// comes back to Discord (no pings, at most 2000 characters a message).

/** Gemini's answer for Discord: no member or role mentions, and @everyone / @here written without the @. */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/<@[!&]?\d{1,25}>/gu, '')
    .replace(/@(everyone|here)\b/giu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/ +\n/gu, '\n')
    .trim();
}

/**
 * A member's text for Gemini: member mentions become @member (the bot @bot), roles @role, channels their name
 * in this server (#channel when it is not one of this server's), custom emojis :name:. No IDs are left in.
 */
export function anonymizeForPrompt(text, { guild = null, botId = null } = {}) {
  return String(text ?? '')
    .replace(/<@!?(\d{1,25})>/gu, (_match, id) => (botId && id === String(botId) ? '@bot' : '@member'))
    .replace(/<@&\d{1,25}>/gu, '@role')
    .replace(/<#(\d{1,25})>/gu, (_match, id) => {
      const name = guild?.channels?.cache?.get?.(id)?.name;
      return name ? `#${name}` : '#channel';
    })
    .replace(/<a?:(\w{1,32}):\d{1,25}>/gu, ':$1:')
    .replace(/@(everyone|here)\b/giu, '$1');
}

// A cut between the two halves of an emoji would leave half a character.
const isHighSurrogate = (text, index) => {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
};

/** Cuts `text` to `max` characters (an ellipsis at the end when cut). */
export function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  let end = Math.max(0, max - 1);
  if (isHighSurrogate(value, end - 1)) end -= 1;
  return `${value.slice(0, end)}…`;
}

/** Splits `text` into Discord messages of at most `max` characters, at a line or a space when it can. */
export function splitMessage(text, { max = 2000, maxParts = 3 } = {}) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest && parts.length < maxParts) {
    if (rest.length <= max) {
      parts.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    if (isHighSurrogate(rest, cut - 1)) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest && parts.length) parts[parts.length - 1] = clip(`${parts[parts.length - 1]}…`, max);
  return parts.filter(Boolean);
}
