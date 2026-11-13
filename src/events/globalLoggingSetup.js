import { Events } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { detectAuditRooms, getEnvAuditChannels } from '../services/logging/auditRooms.js';
import { logger, startupLog } from '../utils/logger.js';

const GLOBAL_LOG_CHANNEL_ID = '1550564287129456810';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    let configured = 0;

    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(client, guild.id);
        const hasConfiguredAuditRooms = Boolean(
          config?.auditChannels && Object.values(config.auditChannels).some(Boolean)
        );
        const hasEnvAuditRooms = Boolean(
          getEnvAuditChannels(guild.id) && Object.values(getEnvAuditChannels(guild.id)).some(Boolean)
        );
        const detectedRooms = detectAuditRooms(guild);
        const hasRadarRooms = Object.keys(detectedRooms).length > 0;

        const hasAuditRooms = hasConfiguredAuditRooms || hasEnvAuditRooms || hasRadarRooms;

        if (hasAuditRooms) {
          // Stop forcing everything off for guilds that have audit rooms; keep antiNukeLogChannelId
          await updateGuildConfig(client, guild.id, {
            antiNukeLogChannelId: GLOBAL_LOG_CHANNEL_ID,
          });
        } else {
          await updateGuildConfig(client, guild.id, {
            antiNukeLogChannelId: GLOBAL_LOG_CHANNEL_ID,
            // Keep general application/moderation logging disabled for guilds without audit rooms.
            logging: {
              ...(config?.logging || {}),
              enabled: false,
              channels: {
                ...(config?.logging?.channels || {}),
                audit: null,
                applications: null,
                reports: null,
              },
            },
          });
        }
        configured += 1;
      } catch (error) {
        logger.error(`Failed to configure Anti-Raid/Anti-Nuke logging in ${guild.name}:`, error);
      }
    }

    startupLog(`Anti-Raid/Anti-Nuke logging configured for ${configured} guild(s)`);
  },
};
