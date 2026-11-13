import { AuditLogEvent, Events } from 'discord.js';
import { postAuditRoom, fetchAuditEntry, formatExecutor } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

const changed = (before, after) => typeof before === 'boolean' && typeof after === 'boolean' && before !== after;

export default {
  name: Events.VoiceStateUpdate,
  once: false,

  async execute(oldState, newState) {
    try {
      const member = newState.member || oldState.member;
      if (!member || member.user?.bot || !member.guild) return;

      const { guild } = member;
      const voiceChannel = newState.channel || oldState.channel;

      let title = '🔊 Voice Log';
      let action = 'voice state updated';
      let color = 0x5865F2;
      let executor = null;

      if (!oldState.channel && newState.channel) {
        title = '🔊 دخول روم صوتي';
        action = `انضم إلى الروم الصوتي ${newState.channel}`;
        color = 0x57f287;
      } else if (oldState.channel && !newState.channel) {
        title = '🔊 خروج من روم صوتي';
        action = `غادر الروم الصوتي ${oldState.channel}`;
        color = 0xed4245;
      } else if (oldState.channelId !== newState.channelId) {
        title = '🔊 انتقال بين الرومات';
        action = `انتقل من ${oldState.channel} إلى ${newState.channel}`;
        color = 0x3498db;
      } else if (changed(oldState.serverMute, newState.serverMute)) {
        title = newState.serverMute ? '🔇 سيرفر ميوت' : '🔊 فك سيرفر ميوت';
        action = newState.serverMute ? 'تم كتمه صوتياً (Server Mute)' : 'تم فك الكتم الصوتي عنه (Server Unmute)';
        color = newState.serverMute ? 0xed4245 : 0x57f287;
        const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, member.id,
          (item) => item.changes?.some((change) => change.key === 'mute' && change.new === newState.serverMute));
        executor = entry?.executor || null;
      } else if (changed(oldState.serverDeaf, newState.serverDeaf)) {
        title = newState.serverDeaf ? '🔕 سيرفر ديفن' : '🔔 فك سيرفر ديفن';
        action = newState.serverDeaf ? 'تم تصميمه (Server Deafen)' : 'تم فك التصميم عنه (Server Undeafen)';
        color = newState.serverDeaf ? 0xed4245 : 0x57f287;
        const entry = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, member.id,
          (item) => item.changes?.some((change) => change.key === 'deaf' && change.new === newState.serverDeaf));
        executor = entry?.executor || null;
      } else {
        return;
      }

      const lines = [
        `👤 **العضو:** ${member} (${member.user?.tag || member.user?.username || member.id} - ${member.id})`,
        `⚡ **الحدث:** ${action}`,
        voiceChannel ? `📁 **الروم:** ${voiceChannel}` : null,
        executor ? `👮 **بواسطة:** ${formatExecutor(executor)}` : null,
        `⏱️ **الوقت:** <t:${Math.floor(Date.now() / 1000)}:F>`,
      ].filter(Boolean);

      await postAuditRoom(guild, 'voice', {
        title,
        description: lines.join('\n'),
        color,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in dedicated voice audit log:', error);
    }
  },
};
