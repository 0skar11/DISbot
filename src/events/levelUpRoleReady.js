import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { runLevelUpBackfill } from '../services/levelUpRoleService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        for (const guild of client.guilds.cache.values()) {
            try {
                const result = await runLevelUpBackfill(guild);
                if (!result.skipped) startupLog(`Level-up role given to ${result.given} members in ${guild.name}`);
            } catch (error) {
                logger.error(`Level-up role backfill failed in ${guild.name}:`, error);
            }
        }
    },
};
