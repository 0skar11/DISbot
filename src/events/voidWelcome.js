import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getWelcomeEmoji } from '../services/welcomeEmojiService.js';
import { memberJoinInvite } from '../services/inviteTrackerService.js';
import { welcomeInviteNote } from '../services/welcomeInviteNote.js';
import { CHAOS_GUILD_ID, escapeGuildName, welcomeChannelSetting } from '../config/welcome.js';

const TEXT_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

export function canWelcomeIn(channel, me) {
  if (!channel) return false;
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return false;
  if (channel.type !== undefined && !TEXT_CHANNELS.has(channel.type)) return false;
  if (!me) return true;
  if (typeof channel.permissionsFor === 'function') {
    const permissions = channel.permissionsFor(me);
    if (permissions && typeof permissions.has === 'function') {
      return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    }
  }
  return true;
}

function welcomeName(name) {
  const letters = String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (letters === 'welcome') return 2;
  return letters.includes('welcome') ? 1 : 0;
}

export async function resolveWelcomeChannel(guild, { env = process.env } = {}) {
  if (!guild) return null;
  const me = guild.members?.me ?? null;
  const setting = welcomeChannelSetting(guild.id, env);
  if (setting === 'off') return null;

  if (setting) {
    const channel = guild.channels?.cache?.get?.(setting)
      || await Promise.resolve().then(() => guild.channels?.fetch?.(setting)).catch(() => null);
    if (canWelcomeIn(channel, me)) return channel;
  }

  const system = guild.systemChannel ?? (guild.systemChannelId ? guild.channels?.cache?.get?.(guild.systemChannelId) : null);
  if (canWelcomeIn(system, me)) return system;

  const named = [...(guild.channels?.cache?.values?.() ?? [])]
    .map((channel) => ({ channel, rank: (channel.type === undefined || TEXT_CHANNELS.has(channel.type)) ? welcomeName(channel.name) : 0 }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || (a.channel.rawPosition ?? a.channel.position ?? 0) - (b.channel.rawPosition ?? b.channel.position ?? 0));
  for (const { channel } of named) {
    if (canWelcomeIn(channel, me)) return channel;
  }
  return null;
}

/**
 * The one welcome message (GH #329): `welcome to <server> @member 👋`, and under it who invited the member and the
 * CC bot's invite gift when known (services/welcomeInviteNote.js). Only the member and the inviter can be pinged.
 */
export function welcomePayload(member, note = null) {
  const guildName = member.guild.name || (member.guild.id === CHAOS_GUILD_ID ? 'chaos' : '');
  const welcome = `welcome to ${escapeGuildName(guildName)} <@${member.id}> ${getWelcomeEmoji(member.client)}`;
  const users = [...new Set([String(member.id), ...(note?.text && note.inviterId ? [String(note.inviterId)] : [])])];
  return {
    content: note?.text ? `${welcome}\n${note.text}` : welcome,
    allowedMentions: { users },
  };
}

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      if (!member?.guild || member.user?.bot) return;

      // The invite the member used, read once with the join log (events/inviteLogger.js): started at once.
      const detected = Promise.resolve().then(() => memberJoinInvite(member)).catch(() => null);
      const channel = await resolveWelcomeChannel(member.guild);
      if (!channel) return;

      const note = await welcomeInviteNote(member, detected).catch(() => null);
      await channel.send(welcomePayload(member, note));
      logger.info(`Sent welcome for ${member.user?.tag || member.id} in channel ${channel.id}${note ? ` (invited by ${note.inviterId}${note.gift ? ', CC gift told' : ''})` : ''}.`);
    } catch (error) {
      logger.error('Failed to send welcome message:', error);
    }
  },
};
