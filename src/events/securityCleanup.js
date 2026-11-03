import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { runSecurityCleanup } from '../services/securityCleanupService.js';
import { managedGuilds } from '../config/bourseGuild.js';

export default {
    name: Events.ClientReady,
    once: true,

    async execute(client) {
        for (const guild of managedGuilds(client)) {
            try {
                const result = await runSecurityCleanup(client, guild);
                if (!result.skipped) startupLog(`Security cleanup in ${guild.name}: ${result.invitesDeleted} invites deleted, ${result.users} users and ${result.roles} roles untrusted`);
            } catch (error) {
                logger.error(`Security cleanup failed in ${guild.name}:`, error);
            }
        }
    },
};
