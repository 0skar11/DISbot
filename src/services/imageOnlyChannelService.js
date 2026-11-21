import { isServerOwner } from '../config/serverOwners.js';
import { canLiftHardBan } from './moderation/hardBanService.js';

// Image-only channel: every message there needs at least one image (text with the image is fine).
// Anything else is deleted and the author gets a short notice (gone after 1 second).
// Owners and trusted members may write normally.
export const IMAGE_ONLY_CHANNEL_ID = '1547310561505837277';
// Reveal rooms (GH #318): same rule, but for everyone (owners and staff too) and the bot stays completely
// silent (no notice). Zenith's room by ID, and in every server any text room named "reveal" / "ريفيل".
export const SILENT_IMAGE_ONLY_CHANNEL_IDS = new Set(['1569932762125705323']);
const REVEAL_ROOM_NAME = /reveal|ريفيل|ريفل/iu;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/iu;
const BLOCKED_NOTICE_DELETE_MS = 1_000;

function isImageAttachment(attachment) {
  if (attachment?.contentType) return attachment.contentType.startsWith('image/');
  return IMAGE_EXTENSION.test(attachment?.name || '');
}

export function hasImage(message) {
  return [...(message.attachments?.values() || [])].some(isImageAttachment);
}

async function canWriteWithoutImage(message) {
  if (isServerOwner(message.author.id)) return true;
  return canLiftHardBan(message.guild, message.author.id);
}

/** Whether the message's channel is a reveal room (by ID, or by its name in any server). */
export function isRevealRoom(channel, channelId = channel?.id) {
  if (SILENT_IMAGE_ONLY_CHANNEL_IDS.has(String(channelId))) return true;
  // By name only for ordinary text rooms: never a thread, a forum post or a voice channel's chat.
  if (channel?.isThread?.() || channel?.isVoiceBased?.()) return false;
  return REVEAL_ROOM_NAME.test(channel?.name || '');
}

/** Returns true when the message was deleted for having no image in the image-only channel. */
export async function handleImageOnlyChannelMessage(message) {
  if (!message.guild) return false;
  const silent = isRevealRoom(message.channel, message.channelId);
  if (message.channelId !== IMAGE_ONLY_CHANNEL_ID && !silent) return false;
  if (hasImage(message)) return false;
  // Reveal rooms & image-only rooms let owners and trusted members write normally (GH #321).
  if (await canWriteWithoutImage(message)) return false;

  await message.delete().catch(() => {});
  if (silent) return true;
  const notice = await message.channel.send({
    content: `🚫 <@${message.author.id}> الروم دي للصور بس، ابعت صورة (ومعاها كلام لو حابب).`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), BLOCKED_NOTICE_DELETE_MS);
  return true;
}
