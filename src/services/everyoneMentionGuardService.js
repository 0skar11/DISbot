import { isServerOwner } from '../config/serverOwners.js';
import { isHomeGuild } from '../config/homeGuild.js';
import { isBourseGuild } from '../config/bourseGuild.js';
import { canLiftHardBan } from './moderation/hardBanService.js';
import { logger } from '../utils/logger.js';

// Only owners, trusted members and this bot (e.g. the rules post) may mention @everyone / @here.
// Anyone else has the message deleted and gets a short notice (gone after 1 second).
// In our server their roles are taken away too (report #247).
const EVERYONE_MENTION = /@(?:everyone|here)\b/u;
const BLOCKED_NOTICE_DELETE_MS = 1_000;

async function canMentionEveryone(message) {
  if (message.author.id === message.client?.user?.id) return true;
  if (isServerOwner(message.author.id)) return true;
  return canLiftHardBan(message.guild, message.author.id);
}

/** Takes the member's roles the bot can remove (not @everyone, not bot-managed, below the bot). Returns how many. */
export async function stripRoles(message) {
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const me = message.guild.members?.me;
  if (!member?.roles?.cache || !me?.roles?.highest) return 0;
  const removable = [...member.roles.cache.values()]
    .filter((role) => role.id !== message.guild.id && !role.managed && role.position < me.roles.highest.position);
  if (!removable.length) return 0;
  try {
    await member.roles.remove(removable, 'منشن everyone من غير ما يكون trusted');
    return removable.length;
  } catch (error) {
    logger.warn(`@everyone guard could not remove the roles of ${message.author.id}: ${error.message}`);
    return 0;
  }
}

/** Returns true when the message was deleted for mentioning @everyone / @here. */
export async function handleEveryoneMention(message) {
  // الحفرة (1472405236000751778): anyone may mention @everyone / @here there.
  if (isBourseGuild(message.guild?.id)) return false;
  if (!message.mentions?.everyone && !EVERYONE_MENTION.test(message.content || '')) return false;
  if (await canMentionEveryone(message)) return false;

  await message.delete().catch(() => {});
  const stripped = isHomeGuild(message.guild?.id) ? await stripRoles(message) : 0;
  const notice = await message.channel.send({
    content: `🚫 <@${message.author.id}> منشن everyone للـ trusted بس.${stripped ? ' ورولاتك اتشالت.' : ''}`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), BLOCKED_NOTICE_DELETE_MS);
  return true;
}
