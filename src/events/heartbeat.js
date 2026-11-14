import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { startHeartbeat } from '../services/heartbeatService.js';

// DISbot and the CC bot watch each other in Zenith's #bot-status room (services/heartbeatService.js).
export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        startHeartbeat(client, { selfName: 'DISbot', peer: { id: '1567561044472103103', name: 'CC bot' }, log: logger });
    },
};
