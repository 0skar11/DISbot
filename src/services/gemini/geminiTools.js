// geminiTools.js — what Gemini may do for an owner in the Gemini room: a short whitelist of the bot's existing
// owner actions, for the room's own server only. Nothing here deletes, bans or changes a setting.
//
// - post_message: the `say` command's job (a plain message in a text channel of this server), with the same
//   checks (a text or announcement channel, the owner and the bot may both send there). It never posts at once:
//   the answer shows a preview written by this code (not by Gemini) with ✅ / ❌ buttons, and only the owner who
//   asked can press them. The message never pings anyone (allowedMentions none, mentions taken out), and like
//   `say` it goes into this server's moderation log ("Bot Message Sent").
// - bot_activity_summary: /bot-activity's numbers for this server only (read only).
//
// Members never get tools: their request to Gemini has no tool list at all. Every tool call is checked again
// here against the author of the ORIGINAL message (isServerOwner), and every button press against the presser;
// nothing Gemini writes decides who may do what.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ComponentType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { GEMINI_LIMITS } from '../../config/geminiRoom.js';
import { getBotActivityStats, guildActivityStats } from '../botActivityStats.js';
import { logger } from '../../utils/logger.js';
import { logEvent } from '../../utils/moderation.js';
import { clip, stripMentions } from './geminiText.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const MAX_POST_CHARS = 2000;
const CONFIRM_PREFIX = 'gemini_post_yes_';
const CANCEL_PREFIX = 'gemini_post_no_';
const DONE_PREFIX = 'gemini_post_done_';

export const GEMINI_TOOL_DECLARATIONS = Object.freeze([
  {
    name: 'post_message',
    description: 'Prepare a plain-text message for the bot to post in a text channel of this server. '
      + 'Nothing is posted until the owner presses the confirm button.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'The target channel as the owner wrote it: its name (general or #general) or its ID.' },
        text: { type: 'string', description: 'The exact message to post, at most 2000 characters, without mentions.' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'bot_activity_summary',
    description: "This server's bot activity numbers (commands run, automatic actions, DMs sent), as in /bot-activity. Read only.",
  },
]);

export const GEMINI_TOOL_NAMES = new Set(GEMINI_TOOL_DECLARATIONS.map((tool) => tool.name));

const quietly = async (run) => {
  try {
    return await run();
  } catch {
    return null;
  }
};

const looseName = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A text or announcement channel of `guild` (and only of it) by mention, ID or name. */
export function resolveGuildTextChannel(guild, raw) {
  const value = String(raw ?? '').trim();
  const cache = guild?.channels?.cache;
  if (!value || !cache) return { error: 'channel_not_found' };
  const isText = (channel) => Boolean(channel) && TEXT_CHANNEL_TYPES.includes(channel.type)
    && String(channel.guildId ?? guild.id) === String(guild.id);
  const id = value.match(/^<#(\d{17,20})>$/u)?.[1] || value.match(/^(\d{17,20})$/u)?.[1];
  if (id) {
    const channel = cache.get(id);
    return isText(channel) ? { channel } : { error: 'channel_not_found' };
  }
  const name = value.replace(/^#/u, '').trim().toLowerCase();
  const channels = [...cache.values()].filter(isText);
  let matches = channels.filter((channel) => String(channel.name ?? '').toLowerCase() === name);
  // `📢・announcements` written as `announcements`.
  if (!matches.length && looseName(name)) matches = channels.filter((channel) => looseName(channel.name) === looseName(name));
  if (matches.length === 1) return { channel: matches[0] };
  return { error: matches.length ? 'ambiguous_channel' : 'channel_not_found' };
}

/** The channel, when both the author of `message` and the bot may view it and send there. */
async function checkPostTarget(message, raw) {
  const found = resolveGuildTextChannel(message.guild, raw);
  if (found.error) return found;
  const member = message.member || await quietly(() => message.guild.members.fetch(message.author.id));
  const me = message.guild.members?.me;
  if (!member || !found.channel.permissionsFor?.(member)?.has?.(POST_PERMISSIONS)) return { error: 'owner_cannot_post_there' };
  if (!me || !found.channel.permissionsFor?.(me)?.has?.(POST_PERMISSIONS)) return { error: 'bot_cannot_post_there' };
  return found;
}

/** The text to post: no control characters (new lines stay), no mentions, at most 2000 characters. */
export function cleanPostText(raw) {
  const text = String(raw ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '');
  return clip(stripMentions(text), MAX_POST_CHARS).trim();
}

async function preparePost(args, context) {
  if (context.pending) return { error: 'one_message_at_a_time' };
  const text = cleanPostText(args.text);
  if (!text) return { error: 'empty_text' };
  const target = await checkPostTarget(context.message, args.channel);
  if (target.error) return { error: target.error };
  context.pending = { channelId: target.channel.id, text, state: 'waiting' };
  return { status: 'waiting_for_owner_confirmation', channel: `#${target.channel.name}`, characters: text.length };
}

async function activitySummary({ message, client }) {
  const here = guildActivityStats(await getBotActivityStats(client), message.guild.id);
  return {
    server: message.guild.name || 'this server',
    commandsExecuted: here.commandsExecuted,
    actionsPerformed: here.actionsPerformed,
    dmsSent: here.dmsSent,
    birthdayDmsSent: here.birthdayDmsSent,
  };
}

/**
 * Runs one function call from Gemini for `context.message` (the original message) and resolves to the result
 * sent back to Gemini. Never throws. A post only fills `context.pending`: the owner confirms it with a button.
 */
export async function runGeminiTool(call, context) {
  const message = context?.message;
  // Checked again on every call, against the author of the original message, whatever Gemini asked for.
  if (!message?.guild || !message.author || !isServerOwner(message.author.id)) return { error: 'not_allowed' };
  const name = String(call?.name ?? '');
  if (!GEMINI_TOOL_NAMES.has(name)) return { error: 'unknown_tool' };
  const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
  try {
    return name === 'post_message' ? await preparePost(args, context) : await activitySummary(context);
  } catch (error) {
    logger.warn(`Gemini room: the ${name} tool failed: ${error?.message}`);
    return { error: 'tool_failed' };
  }
}

export function confirmationRow(nonce) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${nonce}`).setLabel('✅ ابعت').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CANCEL_PREFIX}${nonce}`).setLabel('❌ إلغاء').setStyle(ButtonStyle.Secondary),
  );
}

function doneRow(nonce, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${DONE_PREFIX}${nonce}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(true),
  );
}

/** What will be posted, as this code (not Gemini) shows it under the answer. */
export function confirmationPreview(pending) {
  return `📝 هبعت الرسالة دي في <#${pending.channelId}> لما تدوس ✅:\n>>> ${pending.text}`;
}

/**
 * A press on the ✅ / ❌ buttons of `message`'s answer. Only the owner who sent `message` may press them (checked
 * again now); ✅ checks the channel again and posts once. Resolves to 'refused', 'ignored', 'cancelled', 'posted'
 * or 'failed'.
 */
export async function handleConfirmationPress(button, { pending, message, client = message.client }) {
  const nonce = message.id;
  const presser = button?.user?.id;
  if (!presser || presser !== message.author?.id || !isServerOwner(presser)) {
    await quietly(() => button.reply({ content: '🚫 الزرار ده للأونر اللي طلب بس.', flags: MessageFlags.Ephemeral }));
    return 'refused';
  }
  if (pending.state !== 'waiting') {
    await quietly(() => button.deferUpdate());
    return 'ignored';
  }
  if (button.customId === `${CANCEL_PREFIX}${nonce}`) {
    pending.state = 'cancelled';
    await quietly(() => button.update({ components: [doneRow(nonce, '❌ اتلغت')] }));
    return 'cancelled';
  }
  if (button.customId !== `${CONFIRM_PREFIX}${nonce}`) return 'ignored';

  // Set before any wait, so a double press never posts twice.
  pending.state = 'posting';
  const target = await checkPostTarget(message, pending.channelId);
  const posted = !target.error
    && Boolean(await quietly(() => target.channel.send({ content: pending.text, allowedMentions: { parse: [] } })));
  pending.state = posted ? 'posted' : 'failed';
  await quietly(() => button.update({ components: [doneRow(nonce, posted ? '✅ اتبعتت' : '⚠️ مقدرتش أبعتها')] }));
  if (!posted) return 'failed';
  logger.info(`Gemini room: an owner's confirmed message was posted in channel ${target.channel.id} (server ${message.guild.id}).`);
  // Like `say`: this server's moderation log keeps who made the bot post (logEvent never throws).
  logEvent({
    client,
    guild: message.guild,
    event: {
      action: 'Bot Message Sent',
      target: `${target.channel} (${target.channel.id})`,
      executor: `${message.author.tag ?? message.author.id} (${message.author.id})`,
      reason: clip(`Gemini room: ${pending.text}`, 200),
      metadata: { channelId: target.channel.id, moderatorId: message.author.id, messageLength: pending.text.length },
    },
  }).catch(() => {});
  return 'posted';
}

/** Listens for the buttons on `sent` (the answer with the preview) until a press settles it or time runs out. */
export function armConfirmation(sent, { pending, message, client = message.client, timeMs = GEMINI_LIMITS.confirmMs }) {
  if (typeof sent?.createMessageComponentCollector !== 'function') return null;
  const nonce = message.id;
  const collector = sent.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: timeMs,
    filter: (button) => String(button?.customId ?? '').endsWith(`_${nonce}`),
  });
  collector.on('collect', async (button) => {
    const result = await handleConfirmationPress(button, { pending, message, client }).catch(() => 'failed');
    if (result === 'posted' || result === 'cancelled' || result === 'failed') collector.stop('done');
  });
  collector.on('end', () => {
    if (pending.state !== 'waiting') return;
    pending.state = 'expired';
    quietly(() => sent.edit({ components: [doneRow(nonce, '⌛ الوقت خلص')] }));
  });
  return collector;
}
