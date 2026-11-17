import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { cacheGuildInvites } from '../services/inviteTrackerService.js';

// Remembers every invite's use count at startup so the invite logger can tell which one a new member used.
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    // Disabled: invite tracking moved to CC-bot
  },
};
