import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getAuditLogChannelId } from './auditLogChannelsService.js';
import { postAuditRoom } from './logging/auditRooms.js';
import { logger } from '../utils/logger.js';

// Works out which invite a new member used by comparing invite use counts before and after the join
// and posts it to the `invites` log channel. Log only: invite rewards are paid by CC-bot, so this file
// must never register joins or pay rewards (that would pay twice). Needs Manage Server to read invites.
// The welcome (events/voidWelcome.js) reads the same result (memberJoinInvite) to say who invited the member.
export const VANITY = 'vanity';
const cache = new Map(); // guildId -> Map<code, { uses, maxUses, inviterId, inviterBot }>
const queues = new Map(); // guildId -> Promise, so joins that land together are compared one at a time
const joins = new Map(); // guildId:memberId:joinedAt -> { detected, done }, shared by every caller

function canReadInvites(guild) {
  return Boolean(guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

const inviteEntry = (invite) => ({
  uses: invite.uses ?? 0,
  maxUses: invite.maxUses ?? 0,
  inviterId: invite.inviter?.id || invite.inviterId || null,
  inviterBot: Boolean(invite.inviter?.bot),
});

async function snapshot(guild) {
  const invites = await guild.invites.fetch({ cache: false });
  const map = new Map([...invites.values()].map((invite) => [invite.code, inviteEntry(invite)]));
  if (guild.vanityURLCode) {
    const vanity = await guild.fetchVanityData().catch(() => null);
    if (vanity) map.set(VANITY, { uses: vanity.uses ?? 0, maxUses: 0, inviterId: null, vanityCode: vanity.code });
  }
  return map;
}

export async function cacheGuildInvites(guild) {
  if (!canReadInvites(guild)) return false;
  cache.set(guild.id, await snapshot(guild));
  return true;
}

// Deleted invites stay in the cache on purpose: one that hit its max uses is deleted right as the
// member joins, and findUsedInvite needs the old entry to spot it.
export function rememberInvite(invite) {
  const invites = cache.get(invite.guild?.id);
  invites?.set(invite.code, inviteEntry(invite));
}

/** Compares two snapshots and returns the code + details of the invite that was used, or null. */
export function findUsedInvite(before, after) {
  for (const [code, now] of after) {
    const old = before.get(code);
    if (now.uses > (old?.uses ?? 0)) return { code, ...now, uses: now.uses };
  }
  // A limited invite that reached its last use is deleted, so it is missing from `after`.
  for (const [code, old] of before) {
    if (!after.has(code) && old.maxUses && old.uses + 1 >= old.maxUses) return { code, ...old, uses: old.uses + 1 };
  }
  return null;
}

/**
 * Whether `used` (findUsedInvite) is the invite without any doubt, the way the CC bot decides who gets the invite gift
 * (CC-bot src/services/cc/inviteTracker.js findUsedInvite): the one invite whose count went up; or, no count up, the
 * only invite gone since the last count, used exactly once short of its max, in a server with no vanity link.
 * Two counts up at once (two joins that landed together) is not sure: findUsedInvite's first pick may be wrong.
 */
export function isCertainInvite(before, after, used, { vanity = false } = {}) {
  if (!before || !after || !used) return false;
  const grown = [...after].filter(([code, now]) => now.uses > (before.get(code)?.uses ?? 0));
  if (grown.length) return grown.length === 1 && grown[0][0] === used.code;
  const gone = [...before.keys()].filter((code) => !after.has(code));
  const old = before.get(used.code);
  return !vanity && gone.length === 1 && gone[0] === used.code && old?.maxUses > 0 && old.uses + 1 === old.maxUses;
}

export function countInvitesBy(invites, inviterId) {
  let total = 0;
  for (const invite of invites.values()) if (invite.inviterId === inviterId) total += invite.uses;
  return total;
}

async function processJoin(member, onDetected = () => {}) {
  const { guild } = member;
  if (!canReadInvites(guild)) return null;

  const before = cache.get(guild.id);
  const after = await snapshot(guild);
  cache.set(guild.id, after);
  // Without an earlier snapshot (Manage Server granted after startup) any used invite would look new,
  // so this join is logged as unknown and the snapshot just taken is the baseline for the next one.
  const used = before ? findUsedInvite(before, after) : null;
  const result = { used, certain: isCertainInvite(before, after, used, { vanity: Boolean(guild.vanityURLCode) }) };
  // The welcome needs only the invite: it doesn't wait for the log below.
  onDetected(result);

  await logJoin(member, used, after)
    .catch((error) => logger.error(`Invite log failed for ${member.user?.tag} in ${guild.name}:`, error));
  return result;
}

async function logJoin(member, used, after) {
  const { guild } = member;

  let inviteLine = '**الدعوة:** غير معروفة';
  let inviterLine = '**دعاه:** غير معروف';
  if (used?.code === VANITY) {
    inviteLine = `**الدعوة:** رابط السيرفر (discord.gg/${used.vanityCode || guild.vanityURLCode})`;
    inviterLine = '**دعاه:** رابط السيرفر';
  } else if (used) {
    inviteLine = `**الدعوة:** \`${used.code}\` (${used.uses} استخدام)`;
    inviterLine = used.inviterId
      ? `**دعاه:** <@${used.inviterId}> (${used.inviterId}) — عنده ${countInvitesBy(after, used.inviterId)} دعوة`
      : '**دعاه:** غير معروف';
  }

  await postAuditRoom(guild, 'invites', {
    title: '📨 عضو دخل',
    color: 0x57f287,
    thumbnail: { url: member.user?.displayAvatarURL?.() },
    description: [
      `**العضو:** ${member} (${member.user?.tag || member.id} - ${member.id})`,
      inviterLine,
      inviteLine,
      `**عمر الحساب:** <t:${Math.floor((member.user?.createdTimestamp || Date.now()) / 1000)}:R>`,
      `**عدد الأعضاء:** ${guild.memberCount}`,
    ].join('\n'),
    timestamp: new Date().toISOString(),
  });
}

/** A member's join, read once however many listeners ask: `detected` once the invite is known, `done` once logged. */
function trackJoin(member) {
  const key = `${member.guild.id}:${member.id}:${member.joinedTimestamp}`;
  const known = joins.get(key);
  if (known) return known;
  let detect;
  const detected = new Promise((resolve) => { detect = resolve; });
  const previous = queues.get(member.guild.id) || Promise.resolve();
  const done = previous
    .then(() => processJoin(member, detect))
    .catch((error) => {
      logger.error(`Invite tracking failed for ${member.user?.tag} in ${member.guild.name}:`, error);
      return null;
    })
    .then((result) => {
      detect(result);
      return result;
    });
  queues.set(member.guild.id, done);
  const entry = { detected, done };
  joins.set(key, entry);
  setTimeout(() => joins.delete(key), 60_000).unref?.();
  return entry;
}

/**
 * Handles a member's join once, however many listeners ask, and logs it.
 * Resolves to `{ used, certain }` (the invite used, or null when unknown; certain: see isCertainInvite), or null
 * when invites can't be read.
 */
export function handleMemberJoinInvite(member) {
  return trackJoin(member).done;
}

/** The same result as handleMemberJoinInvite, as soon as the invite is known (it doesn't wait for the log). */
export function memberJoinInvite(member) {
  return trackJoin(member).detected;
}
