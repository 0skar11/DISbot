import { PermissionFlagsBits } from 'discord.js';
import { getCommandPrefix } from '../config/bot.js';
import { isServerOwner, isTrustManager } from '../config/serverOwners.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { ModerationService } from '../services/moderation/moderationService.js';
import { WarningService } from '../services/moderation/warningService.js';
import { scheduleNoPermissionDelete } from './noPermissionReply.js';
import { handlePurgeMessage } from '../services/moderation/channelPurgeService.js';
import { refreshTrustedBoard } from '../services/trustedBoardService.js';
import { mayChangeRole } from '../services/moderation/staffRoleGuard.js';
import { issueWarning, warningCard } from '../services/moderation/warnEscalation.js';
import { moderationCard, cardReason, formatDurationMs, NO_REASON } from './moderationCard.js';
import { unbanDmLine } from '../services/moderation/punishmentDm.js';
import {
  assertCanActOn, hierarchyRuleApplies, lookupMember, HIERARCHY_REFUSAL, LOOKUP_FAILED_MESSAGE,
} from '../services/moderation/memberHierarchy.js';
import { withInvoker } from '../services/moderation/commandInvoker.js';

const COMMANDS = new Set([
  'وارن', 'وارنات', 'تايم', 'انتايم', 'بان', 'انبان', 'كلير', 'ان', 'شيل', 'ر', 'رول', 'ب', 'رتبة', 'ازالةرتبة', 'purge', 'تراست', 'انتراست', 'trusted', 'trustedlist', 'warn', 'warnings', 'timeout', 'untimeout', 'ban', 'unban', 'clear', 'remove', 'role', 'roll', 'lock', 'unlock', 'سحب', 'pull',
].map((value) => value.toLowerCase()));
const ADD_ROLE_COMMANDS = new Set(['ر', 'رول', 'ان', 'رتبة', 'role', 'roll', 'addrole']);
const REMOVE_ROLE_COMMANDS = new Set(['ب', 'شيل', 'ازالةرتبة', 'remove', 'unrole', 'removerole']);
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

function parseDuration(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const durationMs = Number(match[1]) * multipliers[match[2]];
  return durationMs > 0 && durationMs <= MAX_TIMEOUT_MS ? durationMs : null;
}

function stripPrefix(content, prefixes) {
  const value = String(content || '').trim();
  const prefix = prefixes.filter(Boolean).sort((a, b) => b.length - a.length)
    .find(candidate => value.toLowerCase().startsWith(candidate.toLowerCase()));
  return prefix ? value.slice(prefix.length).trim() : value;
}

function tokenize(content, prefixes = []) {
  const value = stripPrefix(content, prefixes);
  const parts = value.split(/\s+/u).filter(Boolean);
  if (!parts.length) return null;
  let command = parts[0].toLowerCase();
  let body = parts.slice(1).join(' ');
  if (!COMMANDS.has(command)) {
    const last = parts.at(-1)?.toLowerCase();
    if (!COMMANDS.has(last)) return null;
    command = last;
    body = parts.slice(0, -1).join(' ');
  }
  const mention = body.match(/<@!?(\d+)>/u);
  const id = body.match(/(?:^|\s)(\d{17,20})(?:\s|$)/u);
  const targetId = mention?.[1] || id?.[1] || null;
  const tail = body.replace(/<@!?\d+>/u, '').replace(/(?:^|\s)\d{17,20}(?=\s|$)/u, '').trim();
  return { command, targetId, tail };
}

const ROLE_BY_ID = /^(?:<@&(\d{17,20})>|(\d{17,20}))$/u;

/** The role a shortcut names: a role mention or ID (`ر @member 1234…`), else its name (exact, then start, then part). */
function roleFor(guild, roleName) {
  const value = String(roleName || '').trim();
  const byId = value.match(ROLE_BY_ID);
  if (byId) {
    const role = guild.roles.cache.get(byId[1] || byId[2]);
    return role && !role.managed && role.id !== guild.id ? role : null;
  }
  const normalized = value.toLowerCase();
  if (!normalized) return null;
  const roles = [...guild.roles.cache.values()].filter(role => !role.managed && role.id !== guild.id);
  return roles.find(role => role.name.toLowerCase() === normalized)
    || roles.find(role => role.name.toLowerCase().startsWith(normalized))
    || roles.find(role => role.name.toLowerCase().includes(normalized));
}

/**
 * `@member role`, `ID role`, `@member <roleId>`, `ID <roleId>`: the member comes first (a mention, else the first
 * ID), the rest is the role. Returns `{ targetId, roleQuery }`; targetId is null when no member is written.
 */
function parseMemberAndRole(guild, body) {
  const mention = body.match(/<@!?(\d{17,20})>/u);
  if (mention) return { targetId: mention[1], roleQuery: body.replace(mention[0], ' ').replace(/\s+/gu, ' ').trim() };
  const id = body.match(/(?:^|\s)(\d{17,20})(?=\s|$)/u);
  // A lone role ID (`ر 1234…` as a reply) is the role, not the member.
  if (!id || guild.roles?.cache?.has?.(id[1])) return { targetId: null, roleQuery: body.trim() };
  return { targetId: id[1], roleQuery: body.replace(id[0], ' ').replace(/\s+/gu, ' ').trim() };
}

function hasPermission(member, permission) {
  return Boolean(member?.permissions?.has(permission) || member?.guild?.ownerId === member?.id);
}

// Typed shortcuts stay silent for members without the permission (owner's request): nothing is answered.
async function reply(message, content) {
  if (/No Permission|ليس لديك صلاحية/u.test(content)) return;
  await message.channel.send({ content, allowedMentions: { parse: [] } }).then(scheduleNoPermissionDelete).catch(() => {});
}

async function sendCard(message, card) {
  await message.channel.send(moderationCard(card)).catch(() => {});
  return true;
}

/** An error's reply: a 🚫 refusal (the role hierarchy, memberHierarchy.js) is shown as it is, anything else after ❌. */
function errorText(error) {
  const text = error?.userMessage || error?.message || 'حدث خطأ أثناء تنفيذ الأمر.';
  return text.startsWith('🚫') ? text : `❌ ${text}`;
}

/** The answer when Discord couldn't say whether the member is in the server: our servers refuse (fail-closed). */
function lookupFailedText(message) {
  return hierarchyRuleApplies(message.guild, message.member) ? HIERARCHY_REFUSAL : LOOKUP_FAILED_MESSAGE;
}

/** Replies with the refusal and returns true when the member may not act on `target` (memberHierarchy.js). */
async function refusedByHierarchy(message, target, options) {
  const check = await assertCanActOn(message.guild, message.member, target, options);
  if (check.ok) return false;
  await reply(message, check.message);
  return true;
}

async function getReplyTargetId(message) {
  if (!message.reference?.messageId) return null;
  const referencedMessage = await message.fetchReference().catch(() => null);
  return referencedMessage?.author?.bot ? null : referencedMessage?.author?.id || null;
}

async function handleTrustedList(message) {
  if (!isTrustManager(message.author.id)) return reply(message, '❌ أمر Trust متاح للمالك فقط.');
  const config = await getGuildConfig(message.client, message.guild.id);
  const trustedUserIds = Array.isArray(config?.antiNukeTrustedUsers) ? config.antiNukeTrustedUsers : [];
  const trustedRoleIds = Array.isArray(config?.antiNukeTrustedRoles) ? config.antiNukeTrustedRoles : [];
  const users = [];
  const bots = [];
  for (const userId of [...new Set(trustedUserIds)]) {
    const member = await message.guild.members.fetch(userId).catch(() => null);
    const user = member?.user || await message.client.users.fetch(userId).catch(() => null);
    const mention = `<@${userId}>`;
    if (user?.bot || member?.user?.bot) bots.push(`${mention} (${user?.tag || user?.username || userId})`);
    else users.push(`${mention} (${user?.tag || user?.username || userId})`);
  }
  const roles = [];
  for (const roleId of [...new Set(trustedRoleIds)]) {
    const role = await message.guild.roles.fetch(roleId).catch(() => null);
    roles.push(role ? `${role} (${role.name})` : `<@&${roleId}> (رتبة غير موجودة)`);
  }
  return reply(message, ['🛡️ **قائمة Trusted في هذا السيرفر**', '', `**الأعضاء (${users.length}):**`, users.length ? users.join('\n') : 'لا يوجد', '', `**البوتات (${bots.length}):**`, bots.length ? bots.join('\n') : 'لا يوجد', '', `**الرتب (${roles.length}):**`, roles.length ? roles.join('\n') : 'لا يوجد'].join('\n'));
}

async function handleTrust(message, targetId) {
  if (!isTrustManager(message.author.id)) return reply(message, '❌ أمر Trust متاح للمالك فقط.');
  const resolvedTargetId = targetId || await getReplyTargetId(message);
  if (!resolvedTargetId) return true;
  const member = await message.guild.members.fetch(resolvedTargetId).catch(() => null);
  if (!member) return reply(message, '❌ Member Not Found');
  const config = await getGuildConfig(message.client, message.guild.id);
  const trustedUsers = new Set(Array.isArray(config?.antiNukeTrustedUsers) ? config.antiNukeTrustedUsers : []);
  const alreadyTrusted = trustedUsers.has(member.id);
  trustedUsers.add(member.id);
  await updateGuildConfig(message.client, message.guild.id, { antiNukeTrustedUsers: [...trustedUsers] });
  if (!alreadyTrusted) await refreshTrustedBoard(message.client, message.guild.id);
  return reply(message, alreadyTrusted ? `ℹ️ ${member} محمي بالفعل من نظام Anti-Raid.` : `🛡️ تم إعطاء ${member} حماية من نظام Anti-Raid.`);
}

async function lockChannel(message) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageChannels)) return reply(message, '❌ ليس لديك صلاحية إدارة الرومات.');
  if (!message.channel?.permissionOverwrites?.edit) return reply(message, '❌ هذا الأمر يعمل داخل روم قابلة للقفل فقط.');
  const everyoneRole = message.guild.roles.everyone;
  if (message.channel.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.SendMessages) === false) return reply(message, '⚠️ الروم مقفولة بالفعل.');
  await message.channel.permissionOverwrites.edit(everyoneRole, { SendMessages: false }, { reason: `Channel locked by ${message.author.tag}` });
  return sendCard(message, { emoji: '🔒', title: 'CHANNEL LOCKED', fields: [['Channel', `${message.channel}`]], moderatorId: message.author.id });
}

/** Gives (`add`) or takes `roleOrName` (a role, or its name / mention / ID) to or from `targetMember`. */
async function changeRole(message, targetMember, roleOrName, add) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageRoles)) return reply(message, '🚫 No Permission');
  if (!targetMember || !roleOrName) return true;
  if (await refusedByHierarchy(message, targetMember)) return true;
  const role = typeof roleOrName === 'string' ? roleFor(message.guild, roleOrName) : roleOrName;
  const botRole = message.guild.members.me?.roles.highest;
  const actor = message.member;
  if (!role) return reply(message, `❌ Role ${roleOrName} Not Found`);
  if (role.managed || !botRole || role.position >= botRole.position) return reply(message, '❌ Role Is Higher Than Mine');
  if (role.position >= actor.roles.highest.position && message.guild.ownerId !== actor.id) return reply(message, '❌ Role Is Higher Than Yours');
  if (!(await mayChangeRole(message.guild, actor.id, role))) return reply(message, '🚫 No Permission');
  // The roles log names the member who typed the shortcut, not the bot; a failed change leaves nothing
  // behind for the next role change (commandInvoker.js).
  const asInvoker = (action) => withInvoker(message.guild.id, 'roles', targetMember.id, message.author, action);
  if (add) {
    await asInvoker(() => targetMember.roles.add(role, `Role shortcut by ${message.author.tag}`));
    return sendCard(message, { emoji: '✅', title: 'ROLE ADDED', fields: [['User', `<@${targetMember.id}>`], ['Role', `${role}`]], moderatorId: message.author.id });
  }
  await asInvoker(() => targetMember.roles.remove(role, `Role shortcut by ${message.author.tag}`));
  return sendCard(message, { emoji: '➖', title: 'ROLE REMOVED', fields: [['User', `<@${targetMember.id}>`], ['Role', `${role}`]], moderatorId: message.author.id });
}

/**
 * `سحب @العضو` (or as a reply): moves the member to the voice room the staff member is in. Staff only (Move Members);
 * the owner and members of a higher or equal role can't be pulled by a lower one. Without the permission it stays silent.
 */
export async function pullToVoice(message, targetMember) {
  const staff = message.member;
  if (!hasPermission(staff, PermissionFlagsBits.MoveMembers)) return reply(message, '🚫 No Permission');
  if (!targetMember) return true;
  const room = staff.voice?.channel;
  if (!room) return reply(message, '❌ ادخل روم صوتي الأول.');
  if (!targetMember.voice?.channel) return reply(message, '❌ العضو مش في روم صوتي.');
  if (targetMember.voice.channelId === room.id) return reply(message, '⚠️ هو معاك في نفس الروم.');
  const isOwner = message.guild.ownerId === staff.id || isServerOwner(staff.id);
  // Our server and Zenith use the shared rule (memberHierarchy.js); other servers keep their own check.
  if (hierarchyRuleApplies(message.guild, staff)) {
    if (await refusedByHierarchy(message, targetMember)) return true;
  } else if (!isOwner && (message.guild.ownerId === targetMember.id || targetMember.roles.highest.position >= staff.roles.highest.position)) {
    return reply(message, '❌ ماتقدرش تسحب عضو رتبته أعلى منك أو زيك.');
  }
  // The bot does the move, so the staff member's own rights count on both rooms (a deny on a room is not bypassed).
  // The pulled member needs no right on the room (staff may bring anyone anywhere). Owners skip the staff check.
  const from = targetMember.voice.channel;
  const allowed = (channel, who, flags) => channel?.permissionsFor?.(who)?.has(flags) ?? true;
  if (!isOwner && !(allowed(from, staff, PermissionFlagsBits.MoveMembers) && allowed(room, staff, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]))) {
    return reply(message, '🚫 No Permission');
  }
  await withInvoker(message.guild.id, 'voice', targetMember.id, message.author, () => targetMember.voice.setChannel(room, `Pulled by ${message.author.tag}`));
  await message.channel.send({ content: `✅ تم سحب <@${targetMember.id}> إلى ${room}`, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

async function listWarnings(message, targetMember, guildId) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
  if (!targetMember) return true;
  const warnings = (await WarningService.getWarnings(guildId, targetMember.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!warnings.length) return reply(message, `📋 لا توجد تحذيرات على <@${targetMember.id}>.`);

  const lines = [`📋 **Warnings for <@${targetMember.id}>**`, ''];
  for (const [index, warning] of warnings.entries()) {
    const moderator = await message.guild.members.fetch(warning.moderatorId).catch(() => null);
    const timestamp = Math.floor((warning.timestamp || Date.now()) / 1000);
    lines.push(`**${index + 1}.** <t:${timestamp}:f> — ${warning.reason || NO_REASON} — بواسطة ${moderator ? `<@${moderator.id}>` : `<@${warning.moderatorId}>`}`);
  }

  let chunk = '';
  for (const line of lines) {
    if ((chunk + line + '\n').length > 1900) {
      await reply(message, chunk);
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk.trim()) await reply(message, chunk);
  return true;
}

const ARABIC_ADD_ROLE_COMMANDS = new Set(['ر', 'رول', 'ان', 'رتبة']);
const ARABIC_REMOVE_ROLE_COMMANDS = new Set(['ب', 'شيل', 'ازالةرتبة']);

/**
 * Arabic role shortcuts (`ر @member role` / `ب @member role`), with or without the prefix. The role is a name,
 * a role mention or a role ID (`ر @member 1234…`); the member is a mention, an ID, or the author of the
 * message replied to. Only Arabic names are handled here so English words such as `roll` keep their normal commands.
 *
 * These words are ordinary chat too (`ب`, `شيل ده`, `ان شاء الله`), so (owner's request) the shortcut stays out
 * of the way unless the message really is one: without a member, or replying with no role found, it returns
 * false and the message goes on as chat; a member without Manage Roles gets no answer at all.
 */
export async function handleArabicRoleShortcut(message, prefixes = []) {
  const parts = stripPrefix(message.content, prefixes).split(/\s+/u).filter(Boolean);
  const command = parts[0]?.toLowerCase();
  const add = ARABIC_ADD_ROLE_COMMANDS.has(command);
  if (!add && !ARABIC_REMOVE_ROLE_COMMANDS.has(command)) return false;

  const { targetId: writtenTargetId, roleQuery } = parseMemberAndRole(message.guild, parts.slice(1).join(' '));
  const targetId = writtenTargetId || await getReplyTargetId(message);
  if (!targetId) return false;
  if (!hasPermission(message.member, PermissionFlagsBits.ManageRoles)) return false;
  // A member written in the message makes it a command (wrong usage is answered); a bare reply is chat unless it names a role.
  const explicit = Boolean(writtenTargetId);
  if (!roleQuery) {
    if (!explicit) return false;
    await reply(message, `⚠️ ${command} @user role`);
    return true;
  }
  const role = roleFor(message.guild, roleQuery);
  if (!role && !explicit) return false;

  // Only Discord's Unknown Member is "not found"; a lookup Discord couldn't answer is refused (memberHierarchy.js).
  const lookup = await lookupMember(message.guild, targetId);
  const targetMember = lookup.member;
  if (!targetMember) {
    if (explicit) await reply(message, lookup.absent ? '❌ Member Not Found' : lookupFailedText(message));
    return explicit;
  }
  try {
    await changeRole(message, targetMember, role || roleQuery, add);
  } catch (error) {
    await reply(message, errorText(error));
  }
  return true;
}

/**
 * `سحب @member` / `pull @member` (or as a reply) typed in a channel: pulls the member to the staff member's voice room.
 * `سحب` is also an ordinary Arabic word, so without a mentioned, id'd or replied-to member it is left alone (false).
 */
export async function handlePullShortcut(message, args = []) {
  const body = args.join(' ');
  const mention = body.match(/<@!?(\d+)>/u);
  const id = body.match(/(?:^|\s)(\d{17,20})(?:\s|$)/u);
  const targetId = mention?.[1] || id?.[1] || await getReplyTargetId(message);
  if (!targetId) return false;
  const targetMember = await message.guild.members.fetch(targetId).catch(() => null);
  try {
    await pullToVoice(message, targetMember);
  } catch (error) {
    await reply(message, errorText(error));
  }
  return true;
}

/** `مسح تحذيرات @member` (or as a reply) — clears all of a member's warnings. */
export async function handleClearWarningsShortcut(message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
  const body = args.join(' ');
  const mention = body.match(/<@!?(\d+)>/u);
  const id = body.match(/(?:^|\s)(\d{17,20})(?:\s|$)/u);
  const targetId = mention?.[1] || id?.[1] || await getReplyTargetId(message);
  if (!targetId) return reply(message, '⚠️ مسح تحذيرات @user');
  const lookup = await lookupMember(message.guild, targetId);
  const targetMember = lookup.member;
  if (!targetMember) return reply(message, lookup.absent ? '❌ Member Not Found' : lookupFailedText(message));
  try {
    await ModerationService.assertModerationHierarchy(message.member, targetMember, 'warn');
    const result = await WarningService.clearWarnings(message.guild.id, targetId);
    return sendCard(message, { emoji: '🧹', title: 'WARNINGS CLEARED', fields: [['User', `<@${targetId}>`], ['Removed', `${result.count}`]], moderatorId: message.author.id });
  } catch (error) {
    return reply(message, errorText(error));
  }
}

export async function handleArabicModerationShortcut(message) {
  const guildConfig = await getGuildConfig(message.client, message.guild.id).catch(() => null);
  const parsed = tokenize(message.content, [guildConfig?.prefix, getCommandPrefix()]);
  if (!parsed) return false;
  if (parsed.command === 'purge') return handlePurgeMessage(message);
  if (parsed.command === 'ق') return lockChannel(message);

  const { command } = parsed;
  const targetId = parsed.targetId || await getReplyTargetId(message);
  if (!targetId) return true;
  const tail = parsed.tail;
  const guild = message.guild;
  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  const targetUser = targetMember?.user || await message.client.users.fetch(targetId).catch(() => null);

  try {
    if (command === 'وارنات' || command === 'warnings') return listWarnings(message, targetMember, guild.id);
    if (ADD_ROLE_COMMANDS.has(command) || REMOVE_ROLE_COMMANDS.has(command)) return changeRole(message, targetMember, tail, ADD_ROLE_COMMANDS.has(command));

    if (command === 'سحب' || command === 'pull') return pullToVoice(message, targetMember);

    if (command === 'وارن' || command === 'warn') {
      if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
      if (!targetMember) return true;
      await ModerationService.assertModerationHierarchy(message.member, targetMember, 'warn');
      const result = await issueWarning({ guild, member: targetMember, moderator: message.member, reason: tail });
      await message.channel.send(warningCard({ userId: targetId, moderatorId: message.member.id, result })).catch(() => {});
      return true;
    }

    if (command === 'تايم' || command === 'timeout') {
      if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
      if (!targetMember) return true;
      const [durationText, ...reasonParts] = tail.split(/\s+/u);
      const durationMs = parseDuration(durationText);
      const reason = reasonParts.join(' ') || NO_REASON;
      if (!durationMs) return reply(message, '❌ اكتب المدة هكذا: `تايم 5m السبب`.');
      await ModerationService.assertModerationHierarchy(message.member, targetMember, 'timeout');
      await ModerationService.timeoutUser({ guild, member: targetMember, moderator: message.member, durationMs, reason });
      return sendCard(message, {
        emoji: '⏳',
        title: 'TIMEOUT ISSUED',
        fields: [['User', `<@${targetId}>`], ['Reason', cardReason(reason)], ['Duration', `${formatDurationMs(durationMs)} (ends <t:${Math.floor((Date.now() + durationMs) / 1000)}:R>)`]],
        moderatorId: message.member.id,
      });
    }

    if (command === 'انتايم' || command === 'untimeout') {
      if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
      if (!targetMember) return true;
      await ModerationService.removeTimeoutUser({ guild, member: targetMember, moderator: message.member, reason: tail || NO_REASON });
      return sendCard(message, { emoji: '🔓', title: 'TIMEOUT REMOVED', fields: [['User', `<@${targetId}>`], ['Reason', cardReason(tail)]], moderatorId: message.member.id });
    }

    if (command === 'بان' || command === 'ban') {
      if (!hasPermission(message.member, PermissionFlagsBits.BanMembers)) return reply(message, '🚫 No Permission');
      if (!targetUser) return true;
      await ModerationService.banUser({ guild, user: targetUser, moderator: message.member, reason: tail || NO_REASON });
      return sendCard(message, { emoji: '🔨', title: 'BAN ISSUED', fields: [['User', `<@${targetId}>`], ['Reason', cardReason(tail)]], moderatorId: message.member.id });
    }

    if (command === 'انبان' || command === 'unban') {
      if (!hasPermission(message.member, PermissionFlagsBits.BanMembers)) return reply(message, '🚫 No Permission');
      if (!targetUser) return true;
      const result = await ModerationService.unbanUser({ guild, user: targetUser, moderator: message.member, reason: tail || NO_REASON });
      return sendCard(message, { emoji: '✅', title: 'BAN REMOVED', fields: [['User', `<@${targetId}>`], ['Reason', cardReason(tail)], ['DM', unbanDmLine(result.dmSent)]], moderatorId: message.member.id });
    }

    if (command === 'كلير' || command === 'clear') {
      if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, '🚫 No Permission');
      if (!targetMember) return true;
      if (await refusedByHierarchy(message, targetMember)) return true;
      const result = await WarningService.clearWarnings(guild.id, targetId);
      return sendCard(message, { emoji: '🧹', title: 'WARNINGS CLEARED', fields: [['User', `<@${targetId}>`], ['Reason', cardReason(tail)], ['Removed', `${result.count}`]], moderatorId: message.member.id });
    }
  } catch (error) {
    await reply(message, errorText(error));
  }
  return true;
}
