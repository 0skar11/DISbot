import { PermissionFlagsBits } from 'discord.js';
import { scheduleNoPermissionDelete } from './noPermissionReply.js';
import { forgetInvoker, withInvoker } from '../services/moderation/commandInvoker.js';

// `م 10` deletes the last 10 messages. `م` is ordinary chat too, so (owner's request) only `م <number>` is the
// command, and a member without Manage Messages gets no answer: the message goes on as chat.
const SHORTCUT_PATTERN = /^م\s+([0-9٠-٩]+)$/u;
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 100;
const CONFIRMATION_DELETE_DELAY_MS = 4_000;

function toWesternDigits(value) {
  return value.replace(/[٠-٩]/gu, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

async function reply(message, content) {
  return message.channel.send({ content, allowedMentions: { parse: [] } }).then(scheduleNoPermissionDelete).catch(() => null);
}

export async function handleMessageDeleteShortcut(message) {
  const match = String(message?.content || '').trim().match(SHORTCUT_PATTERN);
  if (!match) return false;
  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return false;

  const amount = Number(toWesternDigits(match[1]));
  if (!Number.isInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    await reply(message, '⚠️ م 1-100');
    return true;
  }
  if (!message.channel?.isTextBased?.() || typeof message.channel.bulkDelete !== 'function') {
    await reply(message, '❌ Text Channels Only');
    return true;
  }

  try {
    const fetched = await message.channel.messages.fetch({ limit: amount });
    // The bulk delete log names the member who typed it, not the bot; a failed (or empty) delete leaves nothing
    // behind (commandInvoker.js).
    const deleted = await withInvoker(message.guild?.id, 'bulkDelete', message.channel.id, message.author, () => message.channel.bulkDelete(fetched, true));
    if (!deleted?.size) forgetInvoker(message.guild?.id, 'bulkDelete', message.channel.id, message.author);
    const confirmation = await reply(message, `🧹 Deleted ${deleted.size} Messages`);
    if (confirmation) setTimeout(() => confirmation.delete().catch(() => {}), CONFIRMATION_DELETE_DELAY_MS);
  } catch (error) {
    await reply(message, '❌ Can\'t Delete (Missing Permission Or Older Than 14 Days)');
  }
  return true;
}
