import { AuditLogEvent, Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    try {
      if (!newMember?.guild) return;

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent({
          client: newMember.client,
          guildId: newMember.guild.id,
          eventType: EVENT_TYPES.MEMBER_NAME_CHANGE,
          data: {
            title: 'Nickname changed',
            lines: [
              `**User:** ${newMember.user.toString()} (${newMember.user.tag})`,
              `**ID:** \`${newMember.user.id}\``,
              `**Before:** ${oldMember.nickname || '*(no nickname)*'}`,
              `**After:** ${newMember.nickname || '*(no nickname)*'}`,
            ],
            thumbnail: newMember.user?.displayAvatarURL?.({ dynamic: true }),
            userId: newMember.user?.id,
          },
        });
      }

      const oldTimeout = oldMember.communicationDisabledUntilTimestamp || 0;
      const newTimeout = newMember.communicationDisabledUntilTimestamp || 0;

      if (oldTimeout !== newTimeout) {
        const isTimeoutSet = newTimeout > Date.now();
        const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
        const reason = entry?.reason || 'بدون سبب';

        if (isTimeoutSet) {
          const durationMs = newTimeout - Date.now();
          const durationSeconds = Math.round(durationMs / 1000);
          const durationText = durationSeconds >= 86400
            ? `${Math.round(durationSeconds / 86400)} يوم`
            : durationSeconds >= 3600
              ? `${Math.round(durationSeconds / 3600)} ساعة`
              : `${Math.round(durationSeconds / 60)} دقيقة`;

          const lines = [
            `👤 **العضو:** <@${newMember.id}> (${newMember.user?.tag || newMember.user?.username || newMember.id} - ${newMember.id})`,
            `👮 **المشرف:** ${formatExecutor(entry?.executor)}`,
            `⏱️ **المدة:** ${durationText} (<t:${Math.floor(newTimeout / 1000)}:R>)`,
            `📄 **السبب:** ${reason}`,
          ];

          await postAuditRoom(newMember.guild, 'timeout', {
            color: 0xF1C40F,
            title: '⏳ إعطاء تايم اوت (Timeout)',
            description: lines.join('\n'),
            timestamp: new Date().toISOString(),
          });
        } else if (oldTimeout > 0) {
          const lines = [
            `👤 **العضو:** <@${newMember.id}> (${newMember.user?.tag || newMember.user?.username || newMember.id} - ${newMember.id})`,
            `👮 **المشرف:** ${formatExecutor(entry?.executor)}`,
            `📄 **السبب:** ${reason}`,
          ];

          await postAuditRoom(newMember.guild, 'timeout', {
            color: 0x2ecc71,
            title: '✅ فك تايم اوت (Untimeout)',
            description: lines.join('\n'),
            timestamp: new Date().toISOString(),
          });
        }
      }

    } catch (error) {
      logger.error('Error in guildMemberUpdate event:', error);
    }
  },
};
