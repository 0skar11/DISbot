import { resolveAuditRoom } from './logging/auditRooms.js';
import { SERVER_OWNER_IDS } from '../config/serverOwners.js';
import { reportMassDm, recordBotAction } from './botUpdatesRoom.js';
import { logger } from '../utils/logger.js';

/**
 * Regex matching birthday and holiday greetings:
 * "كل سنه وانت طيب", "كل سنة وانت طيب يا اوسكار", "كل عام وانت بخير", "happy birthday", "hbd", etc.
 */
export const BIRTHDAY_GREETING_REGEX = /(?:كل\s*(?:سنة|سنه|عام)\s*و?\s*(?:انت|انتا|انتي|انتم|انتوا)?\s*(?:طيب|طيبة|طيبه|طيبين|بخير|سالم|بصحة|بصحه)|happy\s*birthday|\bhbd\b)/iu;

export function isBirthdayGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  return BIRTHDAY_GREETING_REGEX.test(text);
}

/**
 * Direct Message reply sent to users whose birthday greeting messages were deleted.
 */
export function formatBirthdayReplyDm() {
  return `❤️ **الرسالة وصلت متقلقش، وانت طيب وبألف خير يا رب!**\n\n*— by oskar ✨*`;
}

export const REPLIED_USERS_DB_KEY = 'birthday:replied_users';

/**
 * Scans the message audit log rooms in all guilds for messages that were ALREADY deleted
 * and contained birthday greetings, and sends a DM reply to each author directly.
 * Each server's #bot-updates gets its own count (only its own members are listed there): when DMs were sent, or,
 * with `reportFailures` (the /reply-birthday command), when they only failed. The startup run leaves out the
 * repeated failures of closed DMs, which would otherwise be posted again on every restart.
 */
export async function reconcileDeletedBirthdayGreetings(client, { maxPerRoom = 100, reportFailures = false } = {}) {
  const alreadyRepliedList = (await client.db?.get?.(REPLIED_USERS_DB_KEY, [])) || [];
  const alreadyReplied = new Set(Array.isArray(alreadyRepliedList) ? alreadyRepliedList : []);

  const stats = { scanned: 0, found: 0, sent: 0, failed: 0, users: [], byGuild: {} };

  for (const guild of client.guilds.cache.values()) {
    const here = { sent: 0, failed: 0, users: [] };
    stats.byGuild[guild.id] = here;
    try {
      const room = await resolveAuditRoom(guild, 'message');
      if (!room || !room.isTextBased?.()) continue;

      const messages = await room.messages.fetch({ limit: maxPerRoom }).catch((err) => {
        logger.warn(`Could not fetch messages from audit room ${room.id} in guild ${guild.id}: ${err.message}`);
        return null;
      });
      if (!messages) continue;

      for (const logMsg of messages.values()) {
        stats.scanned++;
        const embed = logMsg.embeds?.[0];
        if (!embed) continue;

        const title = String(embed.title || '').toLowerCase();
        // Only inspect message delete audit logs
        if (!title.includes('message') && !title.includes('delete') && !title.includes('حذف')) continue;

        const textToSearch = [
          embed.description || '',
          ...(embed.fields || []).map((f) => `${f.name} ${f.value}`),
        ].join('\n');

        if (!isBirthdayGreeting(textToSearch)) continue;

        // Extract author ID from description (e.g. "Message author: <@1159601661392715906>")
        const authorMatch = textToSearch.match(/Message author[:\s]+<@!?(\d{17,20})>/i)
          || textToSearch.match(/<@!?(\d{17,20})>/);
        if (!authorMatch) continue;

        const authorId = authorMatch[1];
        // Don't DM bots or owners
        if (authorId === client.user?.id || SERVER_OWNER_IDS.includes(authorId)) continue;

        stats.found++;
        if (alreadyReplied.has(authorId)) continue;

        try {
          const user = await client.users.fetch(authorId).catch(() => null);
          if (user && !user.bot) {
            await user.send({ content: formatBirthdayReplyDm() });
            alreadyReplied.add(authorId);
            stats.sent++;
            here.sent++;
            stats.users.push({ id: authorId, tag: user.tag || user.username });
            here.users.push({ id: authorId, tag: user.tag || user.username });
            logger.info(`[BIRTHDAY DM] Sent birthday reassurance to ${user.tag} (${authorId})`);
          } else {
            stats.failed++;
            here.failed++;
          }
        } catch (dmError) {
          logger.warn(`[BIRTHDAY DM] Could not send DM to ${authorId}: ${dmError.message}`);
          stats.failed++;
          here.failed++;
        }
      }
    } catch (guildError) {
      logger.warn(`Error scanning guild ${guild.id} for deleted birthday greetings: ${guildError.message}`);
    }
  }

  stats.totalReplied = alreadyReplied.size;

  if (client.db && stats.sent > 0) {
    await client.db.set(REPLIED_USERS_DB_KEY, [...alreadyReplied]).catch(() => {});
  }

  for (const [guildId, here] of Object.entries(stats.byGuild)) {
    if (here.sent > 0) await recordBotAction(client, 'birthday_dm', here.sent, guildId).catch(() => {});
    if (here.sent > 0 || (reportFailures && here.failed > 0)) {
      await reportMassDm(client, guildId, { what: 'ردود تهاني عيد الميلاد', ...here }).catch(() => {});
    }
  }

  return stats;
}
