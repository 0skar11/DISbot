import { AuditLogEvent, Events } from 'discord.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanRemove,
  once: false,

  async execute(ban) {
    try {
      if (!ban?.guild) return;

      const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user?.id);
      const lines = [
        `👤 **العضو:** <@${ban.user.id}> (${ban.user.tag || ban.user.username || ban.user.id} - ${ban.user.id})`,
        `👮 **المشرف:** ${formatExecutor(entry?.executor)}`,
      ];

      await postAuditRoom(ban.guild, 'ban', {
        color: 0x3498db,
        title: '🔓 فك حظر عضو (Unban)',
        description: lines.join('\n'),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in guildBanRemove event:', error);
    }
  },
};
