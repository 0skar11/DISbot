import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getWelcomeEmoji } from '../services/welcomeEmojiService.js';
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

export default {
  name: Events.GuildMemberAdd,
  once: false,

  async execute(member) {
    try {
      if (!member?.guild || member.user?.bot) return;

      const channel = await resolveWelcomeChannel(member.guild);
      if (!channel) return;

      const guildName = member.guild.name || (member.guild.id === CHAOS_GUILD_ID ? 'chaos' : '');
      const content = `welcome to ${escapeGuildName(guildName)} <@${member.id}> ${getWelcomeEmoji(member.client)}`;

      await channel.send({
        content,
        allowedMentions: { users: [member.id] },
      });
      logger.info(`Sent welcome for ${member.user?.tag || member.id} in channel ${channel.id}.`);
    } catch (error) {
      logger.error('Failed to send welcome message:', error);
    }
  },
};
