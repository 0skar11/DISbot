import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { giveJoinRole } from '../services/joinRoleService.js';

export default {
    name: Events.GuildMemberAdd,
    once: false,
    async execute(member) {
        await giveJoinRole(member).catch((error) => logger.warn(`Join role failed for ${member.id}: ${error.message}`));
    },
};
