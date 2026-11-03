import { readdir } from 'fs/promises';
import { Guild } from 'discord.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { isBourseGuild } from '../../config/bourseGuild.js';

// The bourse-only server gets none of the bot's other events (logging, roles, anti-raid, welcome...).
// Only the two main files (messageCreate.js, interactionCreate.js) are let through: they run just the bourse
// there. The other listeners on the same events (Arabic moderation, anti-raid, anti-nuke...) are dropped.
const BOURSE_GUILD_FILES = new Set(['messageCreate.js', 'interactionCreate.js']);

function eventGuildId(args) {
    for (const arg of args.slice(0, 2)) {
        // Some events pass the Guild itself (guildAuditLogEntryCreate(entry, guild)).
        const id = arg instanceof Guild ? arg.id : (arg?.guild?.id ?? arg?.guildId);
        if (id) return id;
    }
    return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function loadEvents(client) {
    const eventsPath = join(__dirname, '../../events');
    const eventFiles = await readdir(eventsPath).then(files => files.filter(file => file.endsWith('.js')));

    logger.info(`Found ${eventFiles.length} event files to load`);

    for (const file of eventFiles) {
        const filePath = join(eventsPath, file);
        try {
            const { default: event } = await import(`file://${filePath}`);

            if (!event?.name || typeof event.execute !== 'function') {
                logger.warn(`Event ${file} is missing required "name" or "execute" properties.`);
                continue;
            }

            const safeExecute = async (...args) => {
                try {
                    if (!BOURSE_GUILD_FILES.has(file) && isBourseGuild(eventGuildId(args))) return;
                    await event.execute(...args, client);
                } catch (error) {
                    logger.error(`Error executing event ${event.name}:`, error);
                }
            };

            if (event.once) {
                client.once(event.name, safeExecute);
                logger.info(`✅ Registered once event: ${event.name}`);
            } else {
                client.on(event.name, safeExecute);
                logger.info(`✅ Registered event: ${event.name}`);
            }
        } catch (error) {
            logger.error(`Error loading event ${file}:`, error);
        }
    }
}