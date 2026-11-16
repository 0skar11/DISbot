import { Events, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix } from '../config/bot.js';
import { isTrustManager } from '../config/serverOwners.js';
import { refreshTrustedBoard, TRUSTED_BOARD_CHANNEL_ID, isTrustedBoardChannel } from '../services/trustedBoardService.js';
import { resolveMemberByName } from '../utils/memberNameResolver.js';
import {
  askNameConfirmation, candidatesOf, handleUnresolvedName, nameTargetsEnabled, pressMessage, replyNotFound,
} from '../services/moderation/nameConfirmation.js';

const TRUST_COMMANDS = new Set(['trust', 'untrust', 'تراست', 'انتراست']);
const TRUST_MARKER = '__titanbot_trust_handled__';
const BOARD_REPLY_DELETE_MS = 3_000;

function parseTrust(content) {
  const parts = String(content || '').trim().split(/\s+/u).filter(Boolean);
  if (!TRUST_COMMANDS.has(parts[0]?.toLowerCase())) return null;
  const rest = parts.slice(1).join(' ');
  const role = rest.match(/<@&(\d+)>/u);
  // Drop role mentions first so a role's ID is not also picked up as a user ID.
  const withoutRoles = rest.replace(/<@&\d+>/gu, ' ');
  const user = withoutRoles.match(/<@!?(\d+)>/u) || withoutRoles.match(/\b(\d{17,20})\b/u);
  return {
    command: parts[0].toLowerCase(),
    roleId: role?.[1] || null,
    userId: user?.[1] || null,
    // The words after the command without role mentions: a member's name (our server).
    nameText: withoutRoles.replace(/\s+/gu, ' ').trim(),
    content: String(content || '').trim(),
  };
}

const isAdding = (command) => command === 'trust' || command === 'تراست';

// In the trusted board channel the board itself is the answer, so replies there clean up after themselves.
async function send(message, text) {
  const reply = await message.channel.send({ content: `❌ ${text}`, allowedMentions: { parse: [] } }).catch(() => null);
  if (reply && isTrustedBoardChannel(message.channelId)) {
    setTimeout(() => {
      reply.delete().catch(() => {});
      message.delete().catch(() => {});
    }, BOARD_REPLY_DELETE_MS);
  }
}

async function handleTrust(message, client) {
  const parsed = parseTrust(message.content);
  if (!parsed) return false;
  message.content = TRUST_MARKER;

  if (!isTrustManager(message.author.id)) {
    // The protected channel guard already deletes the message and warns the author there.
    if (message.channelId !== TRUSTED_BOARD_CHANNEL_ID) await message.channel.send('🚫 Owner Only').catch(() => {});
    return true;
  }

  if (!parsed.roleId && !parsed.userId) {
    if (await trustByName(message, client, parsed)) return true;
    await send(message, '⚠️ تراست @user أو تراست @role');
    return true;
  }
  if (parsed.roleId && parsed.userId) {
    await send(message, 'Mention One User Or Role Only');
    return true;
  }
  return applyTrust(message, client, { adding: isAdding(parsed.command), roleId: parsed.roleId, userId: parsed.userId });
}

/**
 * Our server: `تراست محمد` / `انتراست محمد`, the member by name (memberNameResolver.js). Trust is a security
 * setting, so it never happens at once: `هل تقصد @member؟` with ✅ / ❌ (or a button for each member with the
 * name), and a press runs applyTrust as the presser (nameConfirmation.js). The command is typed without a
 * prefix, so a name nobody has gets no answer (owner's rule: no noise on chat); a failed search is answered.
 * Returns false when the words name nobody at all (the usage is shown).
 */
async function trustByName(message, client, parsed) {
  if (!nameTargetsEnabled(message.guild) || !parsed.nameText) return false;
  const found = await resolveMemberByName(message.guild, parsed.nameText);
  if (await handleUnresolvedName(message, found, parsed.command, false)) return true;
  if (found.status === 'none') return false;
  const adding = isAdding(parsed.command);
  await askNameConfirmation(message, {
    candidates: candidatesOf(found),
    truncated: found.truncated,
    command: parsed.content,
    run: ({ candidate, member, user }) => applyTrust(pressMessage(message, member, user), client, { adding, userId: candidate.member.id }),
  });
  return true;
}

/** Trusts (or untrusts) the member `userId` or the role `roleId`, for a trust manager only. */
async function applyTrust(message, client, { adding, roleId = null, userId = null }) {
  // Checked again for a confirmed name: the presser's rights as they are now.
  if (!isTrustManager(message.author.id)) {
    if (message.channelId !== TRUSTED_BOARD_CHANNEL_ID) await message.channel.send('🚫 Owner Only').catch(() => {});
    return true;
  }
  const parsed = { roleId, userId };
  const config = await getGuildConfig(client, message.guild.id).catch(() => null);
  const key = parsed.roleId ? 'antiNukeTrustedRoles' : 'antiNukeTrustedUsers';
  const id = parsed.roleId || parsed.userId;

  if (parsed.roleId) {
    const role = await message.guild.roles.fetch(id).catch(() => null);
    if (!role) return send(message, 'Role Not Found');
    if (role.managed || role.id === message.guild.id) return send(message, 'Can\'t Trust Managed Or @everyone Role');
  } else {
    const member = await message.guild.members.fetch(id).catch(() => null);
    // A mention or ID nobody in the server has: in our server the answer deletes itself after 8 seconds.
    if (!member) return nameTargetsEnabled(message.guild) && !isTrustedBoardChannel(message.channelId) ? replyNotFound(message) : send(message, 'Member Not Found');
  }

  const current = new Set(Array.isArray(config?.[key]) ? config[key] : []);
  if (adding) current.add(id);
  else current.delete(id);
  await updateGuildConfig(client, message.guild.id, { [key]: [...current] });
  await refreshTrustedBoard(client, message.guild.id);
  if (isTrustedBoardChannel(message.channelId)) {
    await message.delete().catch(() => {});
    return true;
  }
  await message.channel.send({ content: `${adding ? '🛡️' : '➖'} ${parsed.roleId ? `<@&${id}>` : `<@${id}>`} ${adding ? 'Trusted' : 'Untrusted'}`, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

export default {
  name: Events.MessageCreate,
  once: false,
  async execute(message, client) {
    if (!message?.guild || message.author?.bot) return;
    if (message.content === TRUST_MARKER) return;
    await handleTrust(message, client);
  },
};
