// levelUpRoleService.js — Zenith: when the leveling bot (greed) announces "Congratulations @member, you reached
// level N!" in #xp, a member who reached level 5 or more gets the pic perms role (the media role). On startup the
// last announcements are read once more, so members who reached level 5 while the bot was down still get it.
import { logger } from '../utils/logger.js';
import { findMediaRole } from './mediaRoleService.js';

export const LEVEL_ROLE_RULES = {
    '1569932761471524874': { channelId: '1569951185522401392', botId: '1149535834756874250', minLevel: 5, roleName: /pic\s*perm/iu },
};
const LEVEL = /\blevel\s+(\d{1,4})\b/iu;
const MENTION = /<@!?(\d{17,20})>/u;

export const levelRuleFor = (guildId) => LEVEL_ROLE_RULES[String(guildId)] || null;

async function findRole(guild, rule) {
    const roles = await guild.roles.fetch();
    return roles.find((role) => !role.managed && rule.roleName.test(role.name)) || await findMediaRole(guild).catch(() => null);
}

/** Reads one announcement: { userId, level } or null when it is not a level-up message from the leveling bot. */
export function parseLevelUp(message, rule) {
    if (message.author?.id !== rule.botId || message.channelId !== rule.channelId) return null;
    const text = [message.content, ...(message.embeds || []).map((embed) => `${embed.title || ''} ${embed.description || ''}`)].join(' ');
    const level = Number(LEVEL.exec(text)?.[1]);
    const userId = message.mentions?.users?.first?.()?.id || MENTION.exec(text)?.[1];
    return level && userId ? { userId, level } : null;
}

/** Gives the role when the announcement says level >= minLevel. Returns 'given' | 'has' | 'low' | 'ignored' | 'no-member' | 'no-role'. */
export async function handleLevelUpMessage(message) {
    const rule = message.guild ? levelRuleFor(message.guild.id) : null;
    if (!rule) return 'ignored';
    const parsed = parseLevelUp(message, rule);
    if (!parsed) return 'ignored';
    if (parsed.level < rule.minLevel) return 'low';
    const role = await findRole(message.guild, rule);
    if (!role) { logger.warn('Level-up role: the pic perms role was not found.'); return 'no-role'; }
    const member = await message.guild.members.fetch(parsed.userId).catch(() => null);
    if (!member || member.user.bot) return 'no-member';
    if (member.roles.cache.has(role.id)) return 'has';
    await member.roles.add(role, `Reached level ${parsed.level}`);
    return 'given';
}

/** Startup catch-up: the last 100 announcements. Returns how many members got the role. */
export async function runLevelUpBackfill(guild) {
    const rule = levelRuleFor(guild.id);
    if (!rule) return { skipped: true };
    const channel = guild.channels.cache.get(rule.channelId);
    if (!channel?.isTextBased?.()) return { skipped: true };
    const messages = await channel.messages.fetch({ limit: 100 });
    let given = 0;
    for (const message of messages.values()) {
        if (await handleLevelUpMessage(message).catch((error) => { logger.warn(`Level-up role failed: ${error.message}`); return 'error'; }) === 'given') given += 1;
    }
    return { skipped: false, given };
}
