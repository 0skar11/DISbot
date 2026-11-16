import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import { EXECUTOR_LABEL, executorText, takeInvoker } from '../services/moderation/commandInvoker.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageBulkDelete,
  once: false,

  async execute(messages, channel) {
    try {
      if (!channel?.guild) return;

      const count = messages?.size || 0;
      const metaLines = [
        formatLogLine('Channel', channel ? `${channel.name} ${channel.toString()}` : 'Unknown'),
        formatLogLine('Messages deleted', String(count)),
      ];
      // `clear`/`purge` run through the bot name the member who ran it; one entry per bulk delete (commandInvoker.js).
      const invoker = takeInvoker(channel.guild.id, 'bulkDelete', channel.id);
      if (invoker) metaLines.push(formatLogLine(EXECUTOR_LABEL, executorText({ invoker })));

      await logEvent({
        client: channel.client,
        guildId: channel.guild.id,
        eventType: EVENT_TYPES.MESSAGE_BULK_DELETE,
        data: {
          title: 'Messages bulk deleted',
          lines: metaLines,
          quoted: true,
          channelId: channel.id,
        },
      });
    } catch (error) {
      logger.error('Error in messageBulkDelete event:', error);
    }
  },
};
