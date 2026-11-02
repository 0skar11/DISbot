import { ChannelType } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

export const AUDIT_LOG_CATEGORY_ID = '1547320311626731562';

// Startup only checks explicitly configured rooms. Deleted rooms must stay deleted,
// and renamed or moved rooms keep their saved IDs without any server/config edits.
export async function ensureAuditLogChannels(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(client, guild.id);
      for (const [key, channelId] of Object.entries(config.auditChannels || {})) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId)
          || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          logger.warn(`Configured audit log channel ${key} (${channelId}) is unavailable in ${guild.name}.`);
        }
      }
    } catch (error) {
      logger.error(`Failed to check log channels in ${guild.name}:`, error);
    }
  }
}

export function getAuditLogChannelId(config, key) {
  return config?.auditChannels?.[key] || null;
}
