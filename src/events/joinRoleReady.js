import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { runJoinRoleBackfill } from '../services/joinRoleService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        for (const guild of client.guilds.cache.values()) {
            try {
                const result = await runJoinRoleBackfill(client, guild);
                if (!result.skipped) startupLog(`Join role given to ${result.given} members in ${guild.name}`);
            } catch (error) {
                logger.error(`Join role backfill failed in ${guild.name}:`, error);
            }
        }
    },
};
