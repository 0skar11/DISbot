// bourseGuild.js — the bourse-only server. The owner's rule: this server has the bourse and what belongs
// to it (the CC balance and the CC board) and nothing else — no moderation or other admin
// commands, no roles, no boards, no timers. Everything else the bot does is switched off for it.
// The rest of the bot never looks at this list: it only asks `isBourseGuild(guildId)` and
// `managedGuilds(client)` (the servers a startup job or timer may work on).
export const BOURSE_GUILD_ID = '1472405236000751778';

/** Slash commands (and their typed forms) that run in the bourse server: the bourse and what it needs. */
export const BOURSE_GUILD_COMMANDS = new Set(['bourse', 'cc', 'cctop']);

/** Button handlers that work there: the bourse's buy / sell confirmations (`bourse:...`). */
export const BOURSE_GUILD_BUTTONS = new Set(['bourse']);

export const BOURSE_GUILD_NOTICE = '❌ الأمر ده مش متاح في السيرفر ده. هنا البورصة بس.';

export function isBourseGuild(guildId) {
    return String(guildId) === BOURSE_GUILD_ID;
}

export function isBourseGuildCommand(commandName) {
    return BOURSE_GUILD_COMMANDS.has(String(commandName || '').toLowerCase());
}

/**
 * The guilds a startup job, sweep or timer may touch: every guild the bot is in except the bourse
 * server, which gets no boards, roles, channels or syncs of its own.
 */
export function managedGuilds(client) {
    return [...client.guilds.cache.values()].filter((guild) => !isBourseGuild(guild.id));
}
