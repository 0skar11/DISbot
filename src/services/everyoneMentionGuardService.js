import { isServerOwner } from '../config/serverOwners.js';

// GH #320: only the owners (config/serverOwners.js), the server's owner and this bot (e.g. the rules post) may
// mention @everyone / @here. Staff, trusted members and Administrator roles are blocked too: Discord cannot take
// Mention Everyone off an Administrator role, so this guard is what stops them. Webhook messages are checked as well
// (staff with Manage Webhooks could post through one), except webhooks owned by this bot.
// Anyone else has the message deleted and gets a short notice (gone after 1 second).
const EVERYONE_MENTION = /@(?:everyone|here)\b/u;
const BLOCKED_NOTICE_DELETE_MS = 1_000;

export function canMentionEveryone(message) {
  const botId = message.client?.user?.id;
  if (botId && message.author?.id === botId) return true;
  if (message.webhookId) return Boolean(botId) && message.applicationId === botId;
  if (isServerOwner(message.author?.id)) return true;
  return Boolean(message.guild?.ownerId) && message.author?.id === message.guild.ownerId;
}

/** Returns true when the message was deleted for mentioning @everyone / @here. */
export async function handleEveryoneMention(message) {
  if (!message.mentions?.everyone && !EVERYONE_MENTION.test(message.content || '')) return false;
  if (canMentionEveryone(message)) return false;

  await message.delete().catch(() => {});
  // A webhook is not a member: nobody to tell.
  if (message.webhookId) return true;
  const notice = await message.channel.send({
    content: `🚫 <@${message.author.id}> منشن everyone للأونر بس.`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), BLOCKED_NOTICE_DELETE_MS);
  return true;
}
