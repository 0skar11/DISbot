import { AuditLogEvent, Events } from 'discord.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

function checkOverwritesChanged(oldChannel, newChannel) {
  const oldOverwrites = oldChannel.permissionOverwrites?.cache;
  const newOverwrites = newChannel.permissionOverwrites?.cache;
  if (!oldOverwrites || !newOverwrites) return false;
  if (oldOverwrites.size !== newOverwrites.size) return true;

  for (const [id, oldOw] of oldOverwrites) {
    const newOw = newOverwrites.get(id);
    if (!newOw) return true;
    if (oldOw.allow?.bitfield !== newOw.allow?.bitfield || oldOw.deny?.bitfield !== newOw.deny?.bitfield) {
      return true;
    }
  }
  return false;
}

export default {
  name: Events.ChannelUpdate,
  once: false,

  async execute(oldChannel, newChannel) {
    try {
      if (!newChannel?.guild) return;

      const lines = [];
      if (oldChannel.name !== newChannel.name) {
        lines.push(`✏️ **الاسم:** **${oldChannel.name}** ← **${newChannel.name}**`);
      }
      if (oldChannel.topic !== newChannel.topic) {
        lines.push(`📝 **الوصف:** ${oldChannel.topic || 'بدون'} ← ${newChannel.topic || 'بدون'}`);
      }
      if (oldChannel.parentId !== newChannel.parentId) {
        lines.push(`📂 **القسم:** ${oldChannel.parent?.name || 'بدون'} ← ${newChannel.parent?.name || 'بدون'}`);
      }
      if (oldChannel.nsfw !== newChannel.nsfw) {
        lines.push(`🔞 **NSFW:** ${newChannel.nsfw ? 'مفعل' : 'معطل'}`);
      }
      if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        lines.push(`⏱️ **وضع بطيء (Slowmode):** ${oldChannel.rateLimitPerUser || 0}s ← ${newChannel.rateLimitPerUser || 0}s`);
      }
      if (checkOverwritesChanged(oldChannel, newChannel)) {
        lines.push(`🔒 **الصلاحيات:** تم تعديل صلاحيات الروم`);
      }

      if (!lines.length) return;

      const entry = await fetchAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);

      const description = [
        `🏷️ **الروم:** <#${newChannel.id}> (${newChannel.name})`,
        ...lines,
        `👮 **بواسطة:** ${formatExecutor(entry?.executor)}`,
      ].join('\n');

      await postAuditRoom(newChannel.guild, 'channels', {
        color: 0x3498db,
        title: '🛠️ روم اتعدلت',
        description,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in channelUpdate event:', error);
    }
  },
};
