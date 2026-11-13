import { AuditLogEvent, Events } from 'discord.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

function formatChannelType(type) {
  switch (type) {
    case 0: return 'روم كتابي (Text)';
    case 2: return 'روم صوتي (Voice)';
    case 4: return 'قسم (Category)';
    case 5: return 'إعلانات (Announcement)';
    case 13: return 'منصة (Stage)';
    case 15: return 'منتدى (Forum)';
    default: return `نوع ${type}`;
  }
}

export default {
  name: Events.ChannelCreate,
  once: false,

  async execute(channel) {
    try {
      if (!channel?.guild) return;

      const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
      const lines = [
        `🏷️ **الروم:** ${channel.type === 4 ? `**${channel.name}**` : `<#${channel.id}> (${channel.name})`} [${channel.id}]`,
        `📁 **النوع:** ${formatChannelType(channel.type)}`,
        channel.parentId ? `📂 **القسم:** ${channel.parent?.name || channel.parentId}` : null,
        `👮 **بواسطة:** ${formatExecutor(entry?.executor)}`,
      ].filter(Boolean);

      await postAuditRoom(channel.guild, 'channels', {
        color: 0x2ecc71,
        title: '🆕 روم اتعملت',
        description: lines.join('\n'),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in channelCreate event:', error);
    }
  },
};
