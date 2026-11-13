import { Events } from 'discord.js';
import { postAuditRoom } from '../services/logging/auditRooms.js';
import { logger } from '../utils/logger.js';

function formatAutoModAction(action) {
  if (!action) return 'غير محدد';
  switch (action.type) {
    case 1:
      return '🚫 منع إرسال الرسالة (Block Message)';
    case 2:
      return '🚨 إرسال تنبيه (Send Alert)';
    case 3:
      return `⏳ تايم اوت (${action.metadata?.durationSeconds || 0} ثانية)`;
    default:
      return `إجراء نوع ${action.type}`;
  }
}

export default {
  name: Events.AutoModerationActionExecution,
  once: false,

  async execute(actionExecution) {
    try {
      if (!actionExecution?.guild) return;

      const lines = [
        `👤 **العضو:** <@${actionExecution.userId}> [${actionExecution.userId}]`,
        `💬 **الروم:** <#${actionExecution.channelId}>`,
        `⚖️ **الإجراء:** ${formatAutoModAction(actionExecution.action)}`,
        actionExecution.matchedKeyword ? `🔍 **الكلمة المطابقة:** \`${actionExecution.matchedKeyword}\`` : null,
        actionExecution.content ? `📝 **المحتوى:** ${actionExecution.content.slice(0, 1000)}` : null,
      ].filter(Boolean);

      await postAuditRoom(actionExecution.guild, 'automode', {
        color: 0xe74c3c,
        title: '🛡️ أوتومود ديسكورد (AutoMod Execution)',
        description: lines.join('\n'),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Error in autoModerationActionExecution event:', error);
    }
  },
};
