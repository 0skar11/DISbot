import { SERVER_OWNER_IDS } from '../config/serverOwners.js';
import { logger } from '../utils/logger.js';

/**
 * Regex matching birthday and holiday greetings to the owner:
 * "كل سنه وانت طيب", "كل سنة وانت طيب يا اوسكار", "كل عام وانت بخير", "happy birthday", "hbd", etc.
 */
export const BIRTHDAY_GREETING_REGEX = /(?:كل\s*(?:سنة|سنه|عام)\s*و?\s*(?:انت|انتا|انتي|انتم|انتوا)?\s*(?:طيب|طيبة|طيبه|طيبين|بخير|سالم|بصحة|بصحه)|happy\s*birthday|\bhbd\b)/iu;

export function isBirthdayGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  return BIRTHDAY_GREETING_REGEX.test(text);
}

export function formatBirthdayReply(userId) {
  return `❤️ <@${userId}> **الرسالة وصلت متقلقش، وانت طيب وبألف خير يا رب!**\n\n*— by oskar ✨*`;
}

// Track recently handled message IDs so messageCreate and messageDelete don't double-reply
const handledMessages = new Set();

/**
 * When a message containing a birthday greeting is deleted anywhere in the server,
 * replies to reassure the author that the message reached Oskar and wishes them well.
 * Also forwards the message details to the server owners so Oskar can read it.
 */
export async function handleBirthdayGreetingOnDelete(message) {
  if (!message?.channel || !message?.author || message.author.bot) return false;
  if (!isBirthdayGreeting(message.content)) return false;
  if (handledMessages.has(message.id)) return false;

  handledMessages.add(message.id);
  setTimeout(() => handledMessages.delete(message.id), 60_000).unref?.();

  const replyText = formatBirthdayReply(message.author.id);

  try {
    const sent = await message.channel.send({
      content: replyText,
      allowedMentions: { users: [message.author.id] },
    }).catch(() => null);

    // Keep visible for 25 seconds before removing so the member can read it
    if (sent) {
      setTimeout(() => sent.delete().catch(() => {}), 25_000).unref?.();
    }

    // Forward a copy of the greeting to the server owners (Oskar)
    await forwardGreetingToOwner(message).catch(() => {});

    return true;
  } catch (error) {
    logger.warn(`Failed to send birthday greeting reply: ${error.message}`);
    return false;
  }
}

async function forwardGreetingToOwner(message) {
  const content = message.content?.trim();
  const authorTag = message.author?.tag || message.author?.username || message.author?.id;
  const channelName = message.channel?.name ? `#${message.channel.name}` : `<#${message.channelId}>`;

  for (const ownerId of SERVER_OWNER_IDS) {
    const ownerUser = await message.client?.users?.fetch?.(ownerId).catch(() => null);
    if (ownerUser) {
      await ownerUser.send({
        content: `🎂 **تهنئة عيد ميلاد** من <@${message.author.id}> (${authorTag}) في ${channelName}:\n> ${content}`,
      }).catch(() => {});
    }
  }
}
