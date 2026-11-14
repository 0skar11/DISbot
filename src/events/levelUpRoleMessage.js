import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleLevelUpMessage } from '../services/levelUpRoleService.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        try {
            await handleLevelUpMessage(message);
        } catch (error) {
            logger.warn(`Level-up role failed: ${error.message}`);
        }
    },
};
