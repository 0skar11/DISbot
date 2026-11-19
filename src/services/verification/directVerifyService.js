// directVerifyService.js: `.توثيق @العضو` / `!توثيق @العضو` and `/verify` (Report #307)
// Instantly grants the female verified role to the target member.
// Allowed for female verifiers (role 1572977938092134410 in Zenith, 1552416342278414376 in CHAOS),
// server owners, and administrators.

import { PermissionFlagsBits } from 'discord.js';
import { getVerifiedRoleId, getSectionRoleIds } from '../tickets/homeTickets.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { logger } from '../../utils/logger.js';

export const VERIFY_WORDS = new Set(['توثيق', 'verify']);
const USER_ID_PATTERN = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/u;

export const TEXT = {
  noPermission: '❌ عذراً، هذا الأمر مخصص لمسؤولات التوثيق فقط.',
  noTarget: '✍️ حددي العضوة اللي عايزة توثقيها: `.توثيق @العضو` أو اعملي ريبلاي على رسالتها.',
  notFound: '❌ لم يتم العثور على هذا العضو في السيرفر.',
  noRole: '❌ لم يتم العثور على رول التوثيق في هذا السيرفر.',
  alreadyVerified: (userId) => `⚠️ <@${userId}> حاصلة على رول التوثيق بالفعل.`,
  success: (userId) => `✅ تم توثيق <@${userId}> ومنحها رتبة التوثيق بنجاح! 🎀`,
  failed: '❌ تعذر إعطاء الرول، تأكدي من صلاحيات البوت وموقع رتبته.',
};

/** Checks if a member has permission to verify members. */
export function canMemberVerify(member) {
  if (!member || !member.guild) return false;
  if (isServerOwner(member.id)) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  const sectionRoles = getSectionRoleIds(member.guild.id);
  const verifyRoleId = sectionRoles?.verify;
  if (verifyRoleId && member.roles?.cache?.has(verifyRoleId)) return true;

  return false;
}

/** Whether the parsed typed command is a verify command (.توثيق, !verify, etc.) */
export function isVerifyCommand(parsed) {
  if (!parsed?.commandName) return false;
  const name = parsed.commandName.toLowerCase();
  return VERIFY_WORDS.has(name);
}

/** Extracts target member from args or replied-to message */
export async function resolveTargetMember(message, args = []) {
  if (!message?.guild) return null;

  // 1. First argument mention or ID
  const firstArg = args[0];
  const match = firstArg && USER_ID_PATTERN.exec(firstArg.trim());
  const targetId = match ? (match[1] || match[2]) : null;
  if (targetId) {
    const member = await message.guild.members.fetch(targetId).catch(() => null);
    if (member) return member;
  }

  // 2. Replied message author
  if (message.reference?.messageId) {
    const replied = await message.fetchReference().catch(() => null);
    if (replied?.author?.id) {
      const member = await message.guild.members.fetch(replied.author.id).catch(() => null);
      if (member) return member;
    }
  }

  // 3. Mentions in message
  const mentioned = message.mentions?.members?.first();
  if (mentioned) return mentioned;

  return null;
}

/** Core verification execution function. */
export async function executeVerification({ guild, executorMember, targetMember, respond }) {
  if (!canMemberVerify(executorMember)) {
    return respond({ content: TEXT.noPermission });
  }

  if (!targetMember) {
    return respond({ content: TEXT.noTarget });
  }

  const roleId = getVerifiedRoleId(guild.id);
  if (!roleId) {
    return respond({ content: TEXT.noRole });
  }

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    return respond({ content: TEXT.noRole });
  }

  if (targetMember.roles.cache.has(roleId)) {
    return respond({
      content: TEXT.alreadyVerified(targetMember.id),
      allowedMentions: { users: [targetMember.id] },
    });
  }

  try {
    await targetMember.roles.add(role, `Verified by ${executorMember.id} (${executorMember.user?.tag || executorMember.id})`);
    return respond({
      content: TEXT.success(targetMember.id),
      allowedMentions: { users: [targetMember.id] },
    });
  } catch (err) {
    logger.warn(`[DIRECT_VERIFY] Failed to add role ${roleId} to member ${targetMember.id}: ${err.message}`);
    return respond({ content: TEXT.failed });
  }
}

/** Handles typed message command: `.توثيق @member` */
export async function handleVerifyCommand(message, args = []) {
  if (!message.guild) return false;

  const targetMember = await resolveTargetMember(message, args);

  const respond = async (payload) => {
    const full = { ...payload, allowedMentions: { parse: [], repliedUser: false, ...(payload.allowedMentions || {}) } };
    await message.reply(full).catch(() => message.channel?.send?.(full)).catch(() => {});
    return payload;
  };

  await executeVerification({
    guild: message.guild,
    executorMember: message.member,
    targetMember,
    respond,
  });

  return true;
}
