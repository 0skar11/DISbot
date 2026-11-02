import { Events } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getAuditLogChannelId } from '../services/auditLogChannelsService.js';
import { isHomeGuild } from '../config/homeGuild.js';
import { logger } from '../utils/logger.js';

// When each member joined their current voice channel, so a switch or leave can show how long they stayed.
const joinedAt = new Map();

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h}h` : '', h || m ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
}

const user = (member) => `${member}\n(\`${member.id}\`)`;
const room = (channel) => `${channel}\n(\`${channel.id}\`)`;

/** The card for a join, switch or leave in our server; null when the update is none of those. */
export function buildVoiceEmbed(oldState, newState, now = Date.now()) {
  const member = newState.member || oldState.member;
  const key = `${member.guild.id}:${member.id}`;
  const stayed = joinedAt.has(key) ? formatDuration(now - joinedAt.get(key)) : null;
  const base = {
    author: { name: member.user.username, icon_url: member.displayAvatarURL?.() },
    timestamp: new Date(now).toISOString(),
  };

  if (!oldState.channel && newState.channel) {
    joinedAt.set(key, now);
    return {
      ...base, color: 0x57f287, title: '🎙️ Joined Voice Channel',
      fields: [
        { name: 'User', value: user(member), inline: true },
        { name: 'Channel', value: room(newState.channel), inline: true },
        { name: 'Members In Channel', value: String(newState.channel.members?.size ?? 1), inline: true },
      ],
      footer: { text: `Voice Join • User ID: ${member.id}` },
    };
  }
  if (oldState.channel && !newState.channel) {
    joinedAt.delete(key);
    return {
      ...base, color: 0xed4245, title: '🚪 Left Voice Channel',
      fields: [
        { name: 'User', value: user(member), inline: true },
        { name: 'Channel', value: room(oldState.channel), inline: true },
        ...(stayed ? [{ name: 'Duration in Channel', value: `\`${stayed}\`` }] : []),
      ],
      footer: { text: `Voice Leave • User ID: ${member.id}` },
    };
  }
  if (oldState.channelId !== newState.channelId) {
    joinedAt.set(key, now);
    return {
      ...base, color: 0x3498db, title: '🔀 Switched Voice Channels',
      fields: [
        { name: 'User', value: user(member), inline: true },
        { name: 'From', value: room(oldState.channel), inline: true },
        { name: 'To', value: room(newState.channel), inline: true },
        ...(stayed ? [{ name: 'Duration in Previous Channel', value: `\`${stayed}\`` }] : []),
      ],
      footer: { text: `Voice Switch • User ID: ${member.id}` },
    };
  }
  return null;
}

export default {
  name: Events.VoiceStateUpdate,
  once: false,
  async execute(oldState, newState) {
    try {
      const member = newState.member || oldState.member;
      if (!member || member.user?.bot || !member.guild) return;

      const config = await getGuildConfig(member.client, member.guild.id);
      const channelId = getAuditLogChannelId(config, 'voice');
      const channel = channelId ? member.guild.channels.cache.get(channelId) : null;
      const permissions = channel && member.guild.members.me ? channel.permissionsFor(member.guild.members.me) : null;
      if (!channel || !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return;

      // Our server gets the new cards for join / switch / leave; other servers keep the old text log.
      if (isHomeGuild(member.guild.id)) {
        const embed = buildVoiceEmbed(oldState, newState);
        if (embed) return void await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      }

      let action = 'voice state updated';
      if (!oldState.channel && newState.channel) action = `joined ${newState.channel}`;
      else if (oldState.channel && !newState.channel) action = `left ${oldState.channel}`;
      else if (oldState.channelId !== newState.channelId) action = `moved from ${oldState.channel} to ${newState.channel}`;
      else if (oldState.serverMute !== newState.serverMute) action = newState.serverMute ? 'was server muted' : 'was server unmuted';
      else if (oldState.serverDeaf !== newState.serverDeaf) action = newState.serverDeaf ? 'was server deafened' : 'was server undeafened';

      await channel.send({
        embeds: [{
          title: '🔊 Voice Log',
          description: `**User:** ${member}\n**Action:** ${action}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`,
          color: 0x5865F2,
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (error) {
      logger.error('Error in dedicated voice audit log:', error);
    }
  },
};
