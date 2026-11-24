// welcomeInviteNote.js — the lines under `welcome to <server> @member` (events/voidWelcome.js, GH #329): who invited
// the new member and, where the CC bot pays the invite gift, what the inviter gets. Before GH #329 the CC bot posted
// this as a second message; now it all comes in Aether's one welcome message:
//
//   welcome to <server> @member 👋
//   -# 📨 دعاه @inviter
//   -# 🎁 @inviter هياخد **5,000** 🌀 CC لما @member يوصل لفل 5 ويكتب 50 رسالة
//
// - The inviter: the invite the join log found (services/inviteTrackerService.js), only when it is sure (one invite
//   count went up). Nothing for an unknown join, the vanity link, the member's own invite or an invite made by a bot.
//   Every server gets this line (Aether needs Manage Server there to read the invites).
// - The gift line: only where the CC bot tracks the gift (config/ccInviteGift.js: CC_INVITE_GIFT_ENABLED, the server
//   holds one of its level rooms) and the CC bot is in the server with Manage Server (it reads the invites itself). It
//   follows the CC bot's own rules (CC-bot src/services/cc/inviteTracker.js joinRecord): a member who was in the server
//   before (Discord's DidRejoin flag) or an account younger than 7 days gets "the invite doesn't count" instead.
// - The welcome waits at most NOTE_WAIT_MS for all this; past that it goes out without the lines.

import { GuildMemberFlags, PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import {
  CC_INVITE_GIFT, ccBotId, ccLevelChannelIds, formatGiftAmount, inviteGiftConditions, inviteGiftEnabled,
} from '../config/ccInviteGift.js';
import { VANITY } from './inviteTrackerService.js';

export const NOTE_WAIT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const snowflake = /^\d{17,20}$/u;
const WARNING = String.fromCharCode(0x26a0, 0xfe0f);

/** Whether Discord marks the member as one who left and came back (GuildMemberFlags.DidRejoin). */
export function didRejoin(member) {
  const flags = member?.flags;
  if (typeof flags?.has === 'function') return flags.has(GuildMemberFlags.DidRejoin);
  const bits = Number(flags?.bitfield ?? flags);
  return Number.isFinite(bits) && (bits & GuildMemberFlags.DidRejoin) !== 0;
}

/** When the member's account was made (its ID tells it when the user object doesn't), or null. */
export function accountCreatedAt(member) {
  const at = member?.user?.createdTimestamp;
  if (Number.isFinite(at)) return at;
  try { return SnowflakeUtil.timestampFrom(String(member?.id ?? member?.user?.id ?? '')); } catch { return null; }
}

/** Whether a user ID is a bot's, from the invite or the caches. */
function isBot(member, userId, used) {
  if (used?.inviterBot) return true;
  const guild = member?.guild;
  return Boolean(guild?.members?.cache?.get?.(userId)?.user?.bot || member?.client?.users?.cache?.get?.(userId)?.bot);
}

/**
 * Who invited the member and whether the CC bot's gift can count, from the join log's result (`join`:
 * `{ used, certain }`): `{ inviterId, reason }` with reason null (it counts), 'rejoin' or 'fake'; or null when nobody
 * is surely known to have invited them (unknown, two invites at once, vanity link, their own invite, a bot's).
 */
export function inviteVerdict(member, join, { now = Date.now() } = {}) {
  const used = join?.used;
  if (!used || join.certain !== true || used.code === VANITY) return null;
  const inviterId = String(used.inviterId ?? '');
  const memberId = String(member?.id ?? '');
  if (!snowflake.test(inviterId) || inviterId === memberId) return null;
  if (isBot(member, inviterId, used)) return null;
  if (didRejoin(member)) return { inviterId, reason: 'rejoin' };
  const createdAt = accountCreatedAt(member);
  if (Number.isFinite(createdAt) && now - createdAt < CC_INVITE_GIFT.minAccountAgeDays * DAY_MS) return { inviterId, reason: 'fake' };
  return { inviterId, reason: null };
}

/** Whether the server holds one of the CC bot's level rooms (the servers where it tracks the invite gift). */
export function holdsCcLevelRoom(guild, env = process.env) {
  if (!guild?.id) return false;
  for (const id of ccLevelChannelIds(env)) {
    if (guild.channels?.cache?.get?.(id)) return true;
    const seen = guild.client?.channels?.cache?.get?.(id);
    if (seen && String(seen.guildId ?? seen.guild?.id ?? '') === String(guild.id)) return true;
  }
  return false;
}

/**
 * Whether the CC bot pays its invite gift in this server: switched on here (CC_INVITE_GIFT_ENABLED), the server holds
 * one of its level rooms, and the CC bot is a member with Manage Server (without it, it can't read the invites and
 * pays nothing). Never throws.
 */
export async function ccInviteGiftTracked(guild, { env = process.env } = {}) {
  try {
    if (!inviteGiftEnabled(env) || !guild?.id || !holdsCcLevelRoom(guild, env)) return false;
    const id = ccBotId(env);
    const cc = guild.members?.cache?.get?.(id)
      ?? await Promise.resolve().then(() => guild.members?.fetch?.(id)).catch(() => null);
    if (!cc || String(cc.id ?? cc.user?.id ?? '') !== id) return false;
    return Boolean(cc.permissions?.has?.(PermissionFlagsBits.ManageGuild));
  } catch {
    return false;
  }
}

/**
 * The lines under the welcome for `verdict` (inviteVerdict), or null. `gift`: the CC bot pays the gift in this
 * server (ccInviteGiftTracked); without it only who invited the member is said.
 */
export function inviteNoteText(memberId, verdict, { gift = false } = {}) {
  if (!verdict?.inviterId) return null;
  const { inviterId, reason } = verdict;
  const lines = [`-# 📨 دعاه <@${inviterId}>`];
  if (gift && reason === null) {
    lines.push(`-# 🎁 <@${inviterId}> هياخد ${formatGiftAmount()} لما <@${memberId}> ${inviteGiftConditions()}`);
  } else if (gift && reason === 'fake') {
    lines.push(`-# ${WARNING} الدعوة دي مش محسوبة: الحساب عمره أقل من ${CC_INVITE_GIFT.minAccountAgeDays} أيام`);
  } else if (gift && reason === 'rejoin') {
    lines.push(`-# ${WARNING} الدعوة دي مش محسوبة: <@${memberId}> كان في السيرفر قبل كده`);
  }
  return lines.join('\n');
}

/** `promise`'s value, or null once `ms` passed first (or it failed). */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => null), late]).finally(() => clearTimeout(timer));
}

/**
 * The note for a joining member: `{ inviterId, text }`, or null (nobody surely known, or not ready within `waitMs`).
 * `detected`: the join log's result (memberJoinInvite). Never throws.
 */
export async function welcomeInviteNote(member, detected, { env = process.env, now = Date.now(), waitMs = NOTE_WAIT_MS } = {}) {
  const work = (async () => {
    const verdict = inviteVerdict(member, await detected, { now });
    if (!verdict) return null;
    const gift = await ccInviteGiftTracked(member.guild, { env });
    return { inviterId: verdict.inviterId, gift, text: inviteNoteText(String(member.id), verdict, { gift }) };
  })();
  return within(work, waitMs);
}
