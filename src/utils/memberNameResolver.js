// memberNameResolver.js — the member a typed command names by name (owner's request, our server only).
//
// `بان محمد`, `تايم احمد 10m`, `ر محمد رول`: the words after the command are matched against each member's
// username, global display name and server nickname, all normalised (case, tashkeel and tatweel removed,
// the alef / ya / ta-marbuta forms unified, spaces collapsed, a leading @ ignored). A command with a tail
// (a reason, a duration, a role, a nickname) tries the first word, then the first two, then the first three.
//
// The member cache is looked at first; Discord is asked (`guild.members.search`, short timeout) when the
// cache found nobody or holds fewer members than the server has. Only members of the guild are ever found.
//
// Matching: an exact full match on any of the names wins; otherwise (when `allowPrefix`) a unique prefix of
// at least 3 characters. Two members with the same name are `many`: the caller never guesses. Bots match but
// are flagged (`bot: true`). A duration (`10m`, `2h`, `1d`), a number, a mention or an ID is never a name.
//
// resolveMemberByName(guild, text, options) resolves to one of:
//   { status: 'one', member, usedWords, bot }      exactly one member; `usedWords` words of `text` named them
//   { status: 'many', candidates: [{ member, usedWords, bot }] }
//   { status: 'none', reason: 'no_name' }          the text starts with no word that could be a name
//   { status: 'none', reason: 'not_found' }        name words, but nobody has that name

export const NAME_SEARCH_TIMEOUT_MS = 2_500;
export const NAME_SEARCH_LIMIT = 10;
export const MIN_PREFIX_LENGTH = 3;

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/gu;
const TATWEEL = /ـ/gu;
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const ARABIC_DIGITS = /[٠-٩۰-۹]/gu;
const LEADING_AT = /^\s*@+\s*/u;

// Never part of a name: a duration (timeout's units, Latin or Arabic), a number, a user / role / channel
// mention, a plain ID.
const DURATION = /^\d+\s*(?:s|m|h|d|w|sec|min|ث|د|س|ي)$/iu;
const NUMBER = /^[-+]?\d+(?:[.,]\d+)?%?$/u;
const MENTION = /^<(?:@[!&]?|#)\d+>$/u;

const toWesternDigits = (value) => value.replace(ARABIC_DIGITS, (digit) => String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) % 10));

/** A name as it is compared: NFKC, no tashkeel / tatweel / invisible marks, one alef / ya / ha, lower case, single spaces, no leading @. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/[ىی]/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^@+\s*/u, '')
    .trim();
}

/** Whether `word` may be (part of) a name: not a duration, a number, a mention or an ID, and not empty. */
export function isNameWord(word) {
  const value = toWesternDigits(String(word ?? '').trim());
  if (!value) return false;
  if (DURATION.test(value) || NUMBER.test(value) || MENTION.test(value)) return false;
  return Boolean(normalizeName(value));
}

/** The words of `text` (a leading @ dropped), as the resolver counts them. */
export function wordsOf(text) {
  return String(text ?? '').replace(LEADING_AT, '').split(/\s+/u).filter(Boolean);
}

/** What is left of `text` after its first `usedWords` words (the reason, the duration, the role...). */
export function remainingText(text, usedWords) {
  return wordsOf(text).slice(Math.max(0, usedWords)).join(' ');
}

/**
 * The leading words of `text` that may be a name. With `wholeText`, every word must be one (at most
 * `maxWords`), else none; otherwise up to `maxWords` from the start, stopping at the first word that is not
 * a name and leaving at least `minTailWords` words for the tail.
 */
export function nameWordsOf(text, { maxWords = 3, minTailWords = 0, wholeText = false } = {}) {
  const words = wordsOf(text);
  if (wholeText) return words.length <= maxWords && words.every(isNameWord) ? words : [];
  const limit = Math.min(maxWords, words.length - Math.max(0, minTailWords));
  const names = [];
  for (const word of words.slice(0, Math.max(0, limit))) {
    if (!isNameWord(word)) break;
    names.push(word);
  }
  return names;
}

/** The names a member is known by, normalised and de-duplicated: username, global name, nickname, display name. */
export function memberNames(member) {
  const user = member?.user || {};
  return [...new Set([user.username, user.globalName, member?.nickname, member?.displayName, user.displayName]
    .map(normalizeName)
    .filter(Boolean))];
}

const valuesOf = (collection) => {
  if (!collection) return [];
  if (typeof collection.values === 'function') return [...collection.values()];
  return Array.isArray(collection) ? collection : [];
};

/** The members whose names `queries` (longest first) match: the exact tier, else the prefix tier. */
function matchMembers(members, queries, allowPrefix) {
  const exact = new Map();
  const prefix = new Map();
  for (const member of members) {
    if (!member?.id) continue;
    const names = memberNames(member);
    if (!names.length) continue;
    for (const { query, words } of queries) {
      if (!exact.has(member.id) && names.includes(query)) exact.set(member.id, { member, usedWords: words });
      if (allowPrefix && !prefix.has(member.id) && [...query].length >= MIN_PREFIX_LENGTH && names.some((name) => name.startsWith(query))) {
        prefix.set(member.id, { member, usedWords: words });
      }
    }
  }
  const tier = exact.size ? exact : prefix;
  const found = [...tier.values()].map((entry) => ({ ...entry, bot: Boolean(entry.member.user?.bot) }));
  if (found.length === 1) return { status: 'one', ...found[0] };
  if (found.length > 1) return { status: 'many', candidates: found };
  return { status: 'none', reason: 'not_found' };
}

/** Discord's member search (prefix of username or nickname), or [] when it fails or takes longer than `timeoutMs`. */
async function searchMembers(guild, query, timeoutMs) {
  if (typeof guild?.members?.search !== 'function' || !query) return [];
  let timer = null;
  // Not unref'd: the answer is awaited, so the timer must be able to fire (it is cleared right after).
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const found = await Promise.race([
      Promise.resolve().then(() => guild.members.search({ query, limit: NAME_SEARCH_LIMIT })).catch(() => null),
      timedOut,
    ]);
    return valuesOf(found);
  } finally {
    clearTimeout(timer);
  }
}

function cacheIsIncomplete(guild, cache) {
  if (!cache) return true;
  const total = Number(guild?.memberCount);
  return Number.isFinite(total) && total > (cache.size ?? valuesOf(cache).length);
}

/**
 * Finds the member `text` names (see the top of this file). Options: `maxWords` (3), `allowPrefix` (true;
 * false = exact names only), `minTailWords` (words that must stay for the tail), `wholeText` (the whole text
 * is the name), `timeoutMs` (Discord search).
 */
export async function resolveMemberByName(guild, text, {
  maxWords = 3, allowPrefix = true, minTailWords = 0, wholeText = false, timeoutMs = NAME_SEARCH_TIMEOUT_MS,
} = {}) {
  const words = nameWordsOf(text, { maxWords, minTailWords, wholeText });
  if (!words.length) return { status: 'none', reason: 'no_name' };
  const counts = wholeText ? [words.length] : words.map((_, index) => words.length - index);
  const queries = counts
    .map((count) => ({ query: normalizeName(words.slice(0, count).join(' ')), words: count }))
    .filter((entry) => entry.query);
  if (!queries.length) return { status: 'none', reason: 'no_name' };

  const cache = guild?.members?.cache;
  const cached = valuesOf(cache);
  const fromCache = matchMembers(cached, queries, allowPrefix);
  if (fromCache.status !== 'none' && !cacheIsIncomplete(guild, cache)) return fromCache;

  // Discord matches the start of usernames and nicknames: the first word finds every longer name too.
  const searchQuery = words[0].replace(/^@+/u, '');
  const searched = await searchMembers(guild, searchQuery, timeoutMs);
  if (!searched.length) return fromCache;
  const merged = new Map(cached.filter((member) => member?.id).map((member) => [member.id, member]));
  for (const member of searched) if (member?.id) merged.set(member.id, member);
  return matchMembers([...merged.values()], queries, allowPrefix);
}
