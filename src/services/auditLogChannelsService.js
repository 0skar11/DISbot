import { ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { detectAuditRooms, getEnvAuditChannels } from './logging/auditRooms.js';
import { logger } from '../utils/logger.js';

export const AUDIT_LOG_CATEGORY_ID = '1547320311626731562';

/**
 * Runs auto-detection and validation of audit log channels for every guild.
 * Persists newly detected rooms without overwriting manual settings.
 */
export async function ensureAuditLogChannels(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const envChannels = getEnvAuditChannels(guild.id);
      const config = await getGuildConfig(client, guild.id).catch(() => null);
      const existing = { ...(config?.auditChannels || {}) };

      // Apply env override for channels not manually defined
      if (envChannels) {
        for (const [key, channelId] of Object.entries(envChannels)) {
          if (channelId && !existing[key]) {
            existing[key] = channelId;
          }
        }
      }

      // Auto-detect inside any category named Radar (case-insensitive)
      const detected = detectAuditRooms(guild);
      const toPersist = {};
      for (const [key, channelId] of Object.entries(detected)) {
        if (!existing[key] && channelId) {
          existing[key] = channelId;
          toPersist[key] = channelId;
        }
      }

      if (Object.keys(toPersist).length > 0) {
        await updateGuildConfig(client, guild.id, {
          auditChannels: existing,
        }).catch((err) => logger.warn(`Failed to persist audit log channels in ${guild.name}:`, err));
      }

      for (const [key, channelId] of Object.entries(existing)) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId)
          || (await guild.channels.fetch?.(channelId).catch(() => null));
        if (!channel || (channel.type !== ChannelType.GuildText && !channel.isTextBased?.())) {
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
