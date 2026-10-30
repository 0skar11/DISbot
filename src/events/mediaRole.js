import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { findMediaRole } from '../services/mediaRoleService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const media = await findMediaRole(guild);
        startupLog(`Media role in ${guild.name}: ${media ? 'found' : 'missing'}`);
      } catch (error) {
        logger.error(`Failed to find the media role in ${guild.name}:`, error);
      }
    }
  },
};
