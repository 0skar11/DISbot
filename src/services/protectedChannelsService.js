import { TRUSTED_BOARD_CHANNEL_ID } from './trustedBoardService.js';
import { MODERATION_COMMANDS_CHANNEL_ID, EXTRA_COMMANDS_CHANNEL_IDS } from './moderationCommandsBoardService.js';
import { isServerOwner } from '../config/serverOwners.js';

// Board channels where only the owners and this bot may write.
const PROTECTED_CHANNEL_IDS = new Set([TRUSTED_BOARD_CHANNEL_ID, MODERATION_COMMANDS_CHANNEL_ID, ...EXTRA_COMMANDS_CHANNEL_IDS, '1571076213705809941']);
const BLOCKED_NOTICE_DELETE_MS = 3_000;
const SERVERS_BOARD_BOTS = new Set(['1550544520423415928', '1567561044472103103', '1567865213540241519']);
const SERVERS_BOARD_FOOTER = '🔄 بيتحدث تلقائي كل 5 دقايق • آخر تحديث';

/**
 * Deletes anything posted in a protected channel by someone other than an owner or this bot,
 * and tells human authors that writing there is not allowed (the notice goes away after 3 seconds).
 * Returns true when the message was blocked.
 */
export async function handleProtectedChannelMessage(message) {
  if (!PROTECTED_CHANNEL_IDS.has(message.channelId) || !message.guild) return false;
  if (isServerOwner(message.author?.id) || message.author?.id === message.client.user?.id) return false;
  const [embed] = message.embeds || [];
  if (message.channelId === TRUSTED_BOARD_CHANNEL_ID && message.author?.bot
      && SERVERS_BOARD_BOTS.has(message.author.id) && !message.webhookId
      && !message.content && !message.attachments?.size && !message.components?.length
      && message.embeds?.length === 1 && /^🌐 البوت في \d+ سيرفر$/u.test(embed?.title || '')
      && embed.footer?.text === SERVERS_BOARD_FOOTER) return false;

  await message.delete().catch(() => {});
  if (message.author?.bot || message.webhookId) return true;
  const notice = await message.channel.send({
    content: `🚫 <@${message.author.id}> ممنوع الكتابة هنا.`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), BLOCKED_NOTICE_DELETE_MS);
  return true;
}
