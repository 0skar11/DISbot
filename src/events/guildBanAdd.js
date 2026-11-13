import { AuditLogEvent, Events } from 'discord.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildBanAdd,
  once: false,

  async execute(ban) {
    try {
      if (!ban?.guild) return;

      const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user?.id);
      const reason = ban.reason || entry?.reason || 'بدون سبب';
      const lines = [
        `👤 **العضو:** <@${ban.user.id}> (${ban.user.tag || ban.user.username || ban.user.id} - ${ban.user.id})`,
        `👮 **المشرف:** ${formatExecutor(entry?.executor)}`,
        `📄 **السبب:** ${reason}`,
      ];

      await postAuditRoom(ban.guild, 'ban', {
        color: 0x721919,
        title: '🔨 حظر عضو (Ban)',
        description: lines.join('\n'),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in guildBanAdd event:', error);
    }
  },
};
