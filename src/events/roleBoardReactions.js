import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { loadGuildBoards, registerRoleBoardReactions, removeRolesFromBoards, rolesCacheReady } from '../services/roleBoardService.js';

// GH #326: emoji reaction-role boards read reactions from raw gateway packets (so they keep working after a
// restart without message partials). This only starts listening; it never posts or edits anything.
export default {
  name: Events.ClientReady,
  once: true,

  async execute(readyClient, client) {
    const botClient = client || readyClient;
    registerRoleBoardReactions(botClient);

    // Roles deleted while the bot was offline leave the boards at startup (GH #326). Only edits boards that
    // already exist; it never posts a new one.
    for (const guild of botClient.guilds?.cache?.values?.() || []) {
      try {
        if (!rolesCacheReady(guild)) continue;
        const boards = await loadGuildBoards(botClient, guild.id);
        const gone = new Set();
        for (const board of Object.values(boards)) {
          for (const entry of board.entries) if (!guild.roles.cache.has(entry.roleId)) gone.add(entry.roleId);
        }
        if (gone.size) await removeRolesFromBoards(botClient, guild, [...gone]);
      } catch (error) {
        logger.warn(`Role boards startup cleanup failed in guild ${guild.id}: ${error.message}`);
      }
    }
  },
};
