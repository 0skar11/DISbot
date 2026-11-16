// nameConfirmation.js — typed admin commands that name a member by NAME (owner's request, our server only).
//
// `بان محمد`, `تايم احمد 10m`, `خطر محمد`: the member is found by memberNameResolver.js. What happens next:
//   • a command that punishes or is security sensitive (ban, kick, timeout, untimeout, warn, the danger list,
//     trust / untrust) never acts at once: the bot asks `هل تقصد <@member>؟` with ✅ تأكيد / ❌ إلغاء, or,
//     when several members have that name, lists them (up to 5) with a button for each and ❌ إلغاء;
//   • only the member who typed the command may press (anyone else gets a short private answer), within
//     30 seconds (then the buttons go and the message says it expired). A press runs the SAME command with
//     the SAME words through its normal path, with the presser's roles and permissions as they are at that
//     moment: the permission and role hierarchy checks run again then, and the logs name the presser;
//   • the pending commands live in memory (at most 200, oldest dropped first): after a restart, or once
//     expired, a press gets a polite private answer and nothing runs;
//   • roles, pull and clearing warnings act at once only on a certain match (one member, full name, a search
//     that was not cut: isCertainMatch); a prefix match asks like above. `نك` asks before renaming anyone
//     else. Several full-name matches are listed and nothing is done; viewing warnings acts directly;
//   • a name nobody has (owner's rule): without the prefix nothing is answered (`خطر جدا`, `بان عليه التعب`
//     are chat); with the prefix it is `❌ Member Not Found`, deleted after 8 seconds, only to a member allowed
//     to use the command. When the server could not be searched (incomplete cache, Discord's search failed),
//     the answer is LOOKUP_FAILED_TEXT, for the full command words (FULL_NAME_COMMAND_WORDS) or the prefix.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { isHomeGuild } from '../../config/homeGuild.js';
import { scheduleNoPermissionDelete } from '../../utils/noPermissionReply.js';
import { LOOKUP_FAILED_MESSAGE } from './memberHierarchy.js';
import { logger } from '../../utils/logger.js';

export const NAME_CONFIRM_PREFIX = 'nm';
export const MEMBER_NOT_FOUND = '❌ Member Not Found';
export const LOOKUP_FAILED_TEXT = '❌ تعذر البحث عن العضو، استخدم المنشن أو الـ id';
export const MAX_CANDIDATES_SHOWN = 5;
/** Timings and limits (tests shorten them). */
export const NAME_CONFIRM_SETTINGS = {
  ttlMs: 30_000,
  maxPending: 200,
  notFoundDeleteMs: 8_000,
  candidatesDeleteMs: 20_000,
  closedDeleteMs: 5_000,
};

export const EXPIRED_TEXT = '⌛ انتهت مهلة التأكيد، اكتب الأمر تاني.';
export const STALE_TEXT = '⌛ التأكيد ده خلص (أو البوت اتعمله ريستارت)، اكتب الأمر تاني.';
export const CANCELLED_TEXT = '❎ اتلغى.';

/**
 * The full command words: they look a name up without the prefix too (other alias words only with it), and a
 * failed lookup is answered for them. The short words that are everyday Arabic too (ب، ر، ان، رول، رتبة،
 * شيل، م، ف، ق) are not here.
 */
export const FULL_NAME_COMMAND_WORDS = new Set([
  'بان', 'تايم', 'انتايم', 'وارن', 'وارنات', 'سحب', 'نك', 'مسح تحذيرات', 'تراست', 'انتراست', 'خطر', 'كيك',
  'ban', 'timeout', 'untimeout', 'warn', 'kick', 'pull', 'trust', 'untrust',
]);

/** Whether names are resolved in this server (new feature: our server only). */
export function nameTargetsEnabled(guild) {
  return isHomeGuild(guild?.id);
}

/** Whether a resolver result names words nobody could be matched to (not found, or the search failed). */
export function isUnresolvedName(found) {
  return found?.status === 'none' && (found.reason === 'not_found' || found.reason === 'lookup_failed');
}

/**
 * Whether an unresolved name (isUnresolvedName) is answered, to a member who may use the command: nobody
 * found only with the prefix (owner's rule: no noise on chat); a failed search also for a full command word.
 */
export function answersUnresolved(found, commandWord, prefixed = false) {
  if (!isUnresolvedName(found)) return false;
  if (prefixed) return true;
  return found.reason === 'lookup_failed' && FULL_NAME_COMMAND_WORDS.has(String(commandWord ?? '').toLowerCase());
}

const pending = new Map(); // id -> entry, oldest first

/** Calls `target[method](payload)`; resolves to its result, or null when it is missing, throws or rejects. */
const attempt = (target, method, payload) => Promise.resolve()
  .then(() => (typeof target?.[method] === 'function' ? target[method](payload) : null))
  .catch(() => null);

/** Sends `content` without pinging anyone and deletes it after `ms`. */
export async function sendTemporary(channel, content, ms) {
  const sent = await attempt(channel, 'send', { content, allowedMentions: { parse: [] } });
  if (sent?.delete) {
    const timer = setTimeout(() => attempt(sent, 'delete'), ms);
    timer.unref?.();
  }
  return sent;
}

/** `❌ Member Not Found`, deleted after 8 seconds. */
export function replyNotFound(message) {
  return sendTemporary(message.channel, MEMBER_NOT_FOUND, NAME_CONFIRM_SETTINGS.notFoundDeleteMs);
}

/** The answer to an unresolved name: not found, or the search failed. Deleted after 8 seconds. */
export function replyUnresolved(message, found) {
  const content = found?.reason === 'lookup_failed' ? LOOKUP_FAILED_TEXT : MEMBER_NOT_FOUND;
  return sendTemporary(message.channel, content, NAME_CONFIRM_SETTINGS.notFoundDeleteMs);
}

/**
 * Answers an unresolved name when answersUnresolved allows it. Resolves to `'answered'`, `'silent'` (unresolved,
 * not answered: chat) or false (`found` is not an unresolved name).
 */
export async function handleUnresolvedName(message, found, commandWord, prefixed = false) {
  if (!isUnresolvedName(found)) return false;
  if (!answersUnresolved(found, commandWord, prefixed)) return 'silent';
  await replyUnresolved(message, found);
  return 'answered';
}

/** A 🚫 refusal (the role hierarchy), deleted after a few seconds like every typed refusal. */
export async function replyRefusal(message, content) {
  scheduleNoPermissionDelete(await attempt(message.channel, 'send', { content, allowedMentions: { parse: [] } }));
  return true;
}

const userOf = (member) => member?.user || member || {};
const tagOf = (member) => userOf(member).tag || userOf(member).username || member?.displayName || member?.id;

/** `<@id> — tag ・ id`, with 🤖 for a bot. */
export function candidateLine(candidate) {
  const member = candidate.member;
  return `<@${member.id}> — ${tagOf(member)} ・ ${member.id}${candidate.bot ? ' 🤖' : ''}`;
}

export const TRUNCATED_HINT = '⚠️ فيه أعضاء كتير اسمهم بيبدأ كده، ممكن اللي تقصده مش في القايمة: اكتب الاسم كامل أو منشن العضو.';

function candidatesText(candidates, truncated = false) {
  const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN);
  const more = candidates.length - shown.length;
  return [
    ...shown.map((candidate, index) => `**${index + 1}.** ${candidateLine(candidate)}`),
    ...(more > 0 ? [`… و ${more} كمان، اكتب الاسم كامل أو منشن العضو.`] : []),
    ...(truncated ? [TRUNCATED_HINT] : []),
  ];
}

/**
 * Several members have the name and the command does not act on a guess: the list, deleted after 20 seconds.
 * `truncated`: Discord's search was cut, others may share the name's start.
 */
export function replyCandidates(message, candidates, { truncated = false } = {}) {
  const content = ['🔎 فيه أكتر من عضو بالاسم ده، اكتب الاسم كامل أو منشن العضو:', ...candidatesText(candidates, truncated)].join('\n');
  return sendTemporary(message.channel, content, NAME_CONFIRM_SETTINGS.candidatesDeleteMs);
}

/** The candidates of a resolver result (`one` or `many`) for askNameConfirmation. */
export function candidatesOf(found) {
  return found?.status === 'one' ? [found] : found?.candidates || [];
}

const quoted = (text) => `\`${String(text ?? '').replace(/`/gu, 'ˋ').slice(0, 180)}\``;

/** The question with its buttons (one candidate: ✅ / ❌; several: a button for each and ❌). */
export function confirmationPayload(entry) {
  const single = entry.candidates.length === 1;
  const lines = single
    ? [`هل تقصد <@${entry.candidates[0].member.id}>؟`, `${tagOf(entry.candidates[0].member)} ・ ${entry.candidates[0].member.id}${entry.candidates[0].bot ? ' 🤖' : ''}`]
    : ['🔎 فيه أكتر من عضو بالاسم ده، تقصد مين؟', ...candidatesText(entry.allCandidates, entry.truncated)];
  if (single && entry.truncated) lines.push(TRUNCATED_HINT);
  if (entry.command) lines.push(`⚙️ ${quoted(entry.command)}`);
  const cancel = new ButtonBuilder().setCustomId(`${NAME_CONFIRM_PREFIX}:cancel:${entry.id}`).setLabel('❌ إلغاء').setStyle(ButtonStyle.Danger);
  const rows = single
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${NAME_CONFIRM_PREFIX}:confirm:${entry.id}`).setLabel('✅ تأكيد').setStyle(ButtonStyle.Success),
      cancel,
    )]
    : [
      new ActionRowBuilder().addComponents(entry.candidates.map((candidate, index) => new ButtonBuilder()
        .setCustomId(`${NAME_CONFIRM_PREFIX}:pick:${entry.id}:${index}`)
        .setLabel(`${index + 1}. ${String(candidate.member.displayName || tagOf(candidate.member))}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary))),
      new ActionRowBuilder().addComponents(cancel),
    ];
  return { content: lines.join('\n'), components: rows, allowedMentions: { parse: [] } };
}

function drop(id) {
  const entry = pending.get(id);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pending.delete(id);
  return entry;
}

function closePrompt(prompt, content) {
  return attempt(prompt, 'edit', { content, components: [], allowedMentions: { parse: [] } });
}

function deleteLater(prompt) {
  if (!prompt?.delete) return;
  const timer = setTimeout(() => attempt(prompt, 'delete'), NAME_CONFIRM_SETTINGS.closedDeleteMs);
  timer.unref?.();
}

/** Ends a pending confirmation that nobody answered in time: the buttons go, the message says it expired. */
export async function expireNameConfirmation(id) {
  const entry = drop(id);
  if (entry) await closePrompt(entry.prompt, EXPIRED_TEXT);
  return Boolean(entry);
}

function sweep(now) {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) expireNameConfirmation(id);
  }
  while (pending.size >= NAME_CONFIRM_SETTINGS.maxPending) expireNameConfirmation(pending.keys().next().value);
}

/**
 * Asks the member who typed `message` to confirm the member (or pick one of `candidates`, each
 * `{ member, usedWords, bot }`). `run({ candidate, member, user, interaction })` is called on a press with the
 * presser's member as it is at that moment; it must run the command's normal path (permission and hierarchy
 * checks included). `command` is shown under the question; `truncated` adds a warning that Discord's search
 * was cut. Resolves to whether the question was sent.
 */
export async function askNameConfirmation(message, { candidates, run, command = message.content, truncated = false }) {
  if (!candidates?.length || typeof run !== 'function') return false;
  const now = Date.now();
  sweep(now);
  const id = randomBytes(6).toString('hex');
  const entry = {
    id,
    guildId: message.guild?.id,
    authorId: message.author?.id,
    candidates: candidates.slice(0, MAX_CANDIDATES_SHOWN),
    allCandidates: candidates,
    command,
    truncated: Boolean(truncated),
    run,
    expiresAt: now + NAME_CONFIRM_SETTINGS.ttlMs,
    prompt: null,
    timer: null,
  };
  pending.set(id, entry);
  entry.timer = setTimeout(() => expireNameConfirmation(id), NAME_CONFIRM_SETTINGS.ttlMs);
  entry.timer.unref?.();
  const prompt = await attempt(message.channel, 'send', confirmationPayload(entry));
  if (!prompt) {
    drop(id);
    return false;
  }
  entry.prompt = prompt;
  // Expired while the question was being sent.
  if (!pending.has(id)) await closePrompt(prompt, EXPIRED_TEXT);
  return true;
}

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});

/** The presser as the server sees them now (fresh roles and permissions); null when Discord can't say. */
async function presserMember(interaction) {
  const fetched = await Promise.resolve()
    .then(() => interaction.guild?.members?.fetch?.({ user: interaction.user.id, force: true }))
    .catch(() => null);
  if (fetched?.id === interaction.user.id && fetched.roles?.highest) return fetched;
  const member = interaction.member;
  return member?.id === interaction.user.id && member.roles?.highest && member.permissions ? member : null;
}

/** The ✅ / ❌ / candidate buttons (`nm:confirm:<id>`, `nm:cancel:<id>`, `nm:pick:<id>:<index>`). */
export async function handleNameConfirmButton(interaction, _client, [action, id, index] = []) {
  const entry = pending.get(id);
  if (!entry || entry.expiresAt <= Date.now() || entry.guildId !== interaction.guildId) {
    if (entry && entry.expiresAt <= Date.now()) await expireNameConfirmation(id);
    return ephemeral(interaction, STALE_TEXT);
  }
  if (interaction.user?.id !== entry.authorId) return ephemeral(interaction, `🚫 الأزرار دي لـ <@${entry.authorId}> بس.`);

  if (action === 'cancel') {
    drop(id);
    await interaction.update({ content: CANCELLED_TEXT, components: [], allowedMentions: { parse: [] } }).catch(() => {});
    deleteLater(entry.prompt);
    return true;
  }
  const candidate = action === 'confirm' && entry.candidates.length === 1 ? entry.candidates[0]
    : action === 'pick' && /^\d+$/u.test(String(index ?? '')) ? entry.candidates[Number(index)] : null;
  if (!candidate) return ephemeral(interaction, '❌ الزرار ده مش صالح.');

  // One press only: the entry is gone before anything runs, so a double click can not run it twice.
  drop(id);
  await interaction.update({ content: `✅ <@${candidate.member.id}>`, components: [], allowedMentions: { parse: [] } }).catch(() => {});
  deleteLater(entry.prompt);
  const member = await presserMember(interaction);
  if (!member) {
    await attempt(interaction, 'followUp', { content: LOOKUP_FAILED_MESSAGE, flags: MessageFlags.Ephemeral });
    return true;
  }
  try {
    await entry.run({ candidate, member, user: interaction.user, interaction });
  } catch (error) {
    logger.error('Name confirmation run failed:', error);
    await attempt(interaction.channel, 'send', { content: `❌ ${error?.userMessage || error?.message || 'Something went wrong'}`, allowedMentions: { parse: [] } });
  }
  return true;
}

/**
 * The typed message as the presser sends it now: the same message (content, channel, reply...) with the
 * presser's current member and user, so the command's checks and its logs use them.
 */
export function pressMessage(original, member, user) {
  return Object.create(original, {
    member: { value: member, writable: true, enumerable: true, configurable: true },
    author: { value: user, writable: true, enumerable: true, configurable: true },
  });
}

/** How many confirmations are waiting (tests). */
export function pendingNameConfirmations() {
  return pending.size;
}

/** Forgets every pending confirmation, as a restart does (tests). */
export function clearNameConfirmations() {
  for (const id of [...pending.keys()]) drop(id);
}
