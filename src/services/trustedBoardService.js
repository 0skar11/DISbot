import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { findBoardMessage, rememberBoardMessage } from '../utils/boardMessage.js';
import { getGuildConfig } from './config/guildConfig.js';

export const TRUSTED_BOARD_CHANNEL_ID = '1155236383464628325';
// The trusted board's room of each other server (Zenith: #bot-status).
const GUILD_TRUSTED_CHANNELS = { '1569932761471524874': '1571078435927887952' };
export const trustedBoardChannelFor = (guildId) => GUILD_TRUSTED_CHANNELS[String(guildId)] || TRUSTED_BOARD_CHANNEL_ID;
/** Whether `channelId` is a server's trusted board room. */
export const isTrustedBoardChannel = (channelId) => channelId === TRUSTED_BOARD_CHANNEL_ID || Object.values(GUILD_TRUSTED_CHANNELS).includes(channelId);
const TRUSTED_BOARD_TITLE = '🛡️ قائمة الـ Trusted';
const BOARD_KEY = 'trusted';
// Discord caps a field value at 1024 characters, an embed at 25 fields and 6000 characters in total.
const FIELD_LIMIT = 1024;
const EMBED_FIELD_LIMIT = 25;
const EMBED_TOTAL_LIMIT = 6000;
const EMPTY_SECTION = '> *لا يوجد*';

const PERMISSION_NAMES = [
  [PermissionFlagsBits.ViewChannel, 'ViewChannel'],
  [PermissionFlagsBits.SendMessages, 'SendMessages'],
  [PermissionFlagsBits.EmbedLinks, 'EmbedLinks'],
  [PermissionFlagsBits.ReadMessageHistory, 'ReadMessageHistory'],
];

let queue = Promise.resolve();

/** Splits lines into field values that stay under Discord's field limit. */
function chunkLines(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > FIELD_LIMIT && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sectionFields(title, total, lines) {
  const chunks = lines.length ? chunkLines(lines) : [EMPTY_SECTION];
  return chunks.map((value, index) => ({ name: index === 0 ? `${title} — ${total}` : '\u200b', value }));
}

const fieldsLength = (fields) => fields.reduce((sum, { name, value }) => sum + name.length + value.length, 0);

/**
 * Builds a section's fields within the given budgets. When every line does not fit,
 * the list is cut and a last line says how many entries were left out.
 */
function fitSection({ title, lines }, charBudget, fieldBudget) {
  for (let shown = lines.length; shown >= 0; shown -= 1) {
    const visible = lines.slice(0, shown);
    if (shown < lines.length) visible.push(`> … و ${lines.length - shown} كمان`);
    const fields = sectionFields(title, lines.length, visible);
    if (fields.length <= fieldBudget && fieldsLength(fields) <= charBudget) return fields;
  }
  return [];
}

/**
 * Turns the board sections into embed fields that stay inside Discord's embed limits.
 * Smaller sections are placed first so the space they leave goes to the larger ones;
 * the fields come back in the original section order.
 */
export function buildTrustedBoardFields(sections, { charBudget, fieldBudget = EMBED_FIELD_LIMIT }) {
  const bySize = sections
    .map((section, index) => ({ section, index, size: fieldsLength(sectionFields(section.title, section.lines.length, section.lines)) }))
    .sort((a, b) => a.size - b.size);

  const results = new Array(sections.length);
  let charsLeft = charBudget;
  let fieldsLeft = fieldBudget;
  bySize.forEach(({ section, index }, position) => {
    const sectionsLeft = bySize.length - position;
    const fields = fitSection(section, Math.floor(charsLeft / sectionsLeft), Math.floor(fieldsLeft / sectionsLeft));
    charsLeft -= fieldsLength(fields);
    fieldsLeft -= fields.length;
    results[index] = fields;
  });
  return results.flat();
}

async function buildEmbed(guild) {
  const config = await getGuildConfig(guild.client, guild.id);
  const userIds = [...new Set(Array.isArray(config?.antiNukeTrustedUsers) ? config.antiNukeTrustedUsers : [])];
  const roleIds = [...new Set(Array.isArray(config?.antiNukeTrustedRoles) ? config.antiNukeTrustedRoles : [])];

  const members = [];
  const bots = [];
  for (const userId of userIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const user = member?.user || await guild.client.users.fetch(userId).catch(() => null);
    const line = `> <@${userId}> ・ \`${user?.username || userId}\``;
    (user?.bot ? bots : members).push(line);
  }

  const roles = [];
  for (const roleId of roleIds) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    roles.push(role
      ? `> <@&${role.id}>`
      : `> \`${roleId}\` ・ *رتبة محذوفة*`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(TRUSTED_BOARD_TITLE)
    .setDescription([
      'الأشخاص والبوتات والرتب دي مستثناة من نظام **Anti-Nuke / Anti-Raid**.',
      `👑 **صاحب السيرفر:** <@${guild.ownerId}>`,
    ].join('\n'))
    .setThumbnail(guild.iconURL({ size: 256 }) || null)
    .setFooter({ text: `الإجمالي: ${members.length + bots.length + roles.length} • آخر تحديث` })
    .setTimestamp();

  // The global embed patch (utils/embeds.js) strips emojis and drops footers it deems unimportant,
  // so measure what actually ended up on the embed.
  const { title, description, footer } = embed.data;
  const usedChars = (title?.length ?? 0) + (description?.length ?? 0) + (footer?.text?.length ?? 0);
  embed.addFields(buildTrustedBoardFields([
    { title: '👤 الأعضاء', lines: members },
    { title: '🤖 البوتات', lines: bots },
    { title: '🎭 الرتب', lines: roles },
  ], { charBudget: EMBED_TOTAL_LIMIT - usedChars }));
  return embed;
}

async function fetchBoardChannel(client, channelId = TRUSTED_BOARD_CHANNEL_ID) {
  const channel = await client.channels.fetch(channelId).catch((error) => {
    throw new Error(`Channel ${channelId} could not be fetched (is the bot in that server?): ${error.message}`);
  });
  if (!channel?.isTextBased?.() || !channel.messages?.fetch || !channel.guild) {
    throw new Error(`Channel ${channelId} is not a server text channel`);
  }

  const botMember = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null);
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const missing = PERMISSION_NAMES.filter(([flag]) => !permissions?.has(flag)).map(([, name]) => name);
  if (missing.length) {
    throw new Error(`Missing permissions in channel ${channelId}: ${missing.join(', ')}`);
  }
  return channel;
}

async function publish(client, allowSend, channelId = TRUSTED_BOARD_CHANNEL_ID) {
  const channel = await fetchBoardChannel(client, channelId);
  const embed = await buildEmbed(channel.guild);
  // The channel also holds the saved ideas post, so the board is the bot's embed titled "…Trusted"
  // (the emoji is stripped from EmbedBuilder titles, so match the words).
  const existing = await findBoardMessage(channel, BOARD_KEY, (message) => Boolean(message.embeds[0]?.title?.includes('Trusted')));
  if (existing) {
    await existing.edit({ content: '', embeds: [embed], allowedMentions: { parse: [] } });
    return { status: 'updated', channelId: channel.id };
  }
  if (!allowSend) {
    logger.warn(`Trusted board message not found in channel ${channelId}; use /publish-board trusted to post it`);
    return { status: 'missing', channelId: channel.id };
  }
  const sent = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  await rememberBoardMessage(channel, BOARD_KEY, sent.id);
  logger.info(`Published trusted board in channel ${channelId}`);
  return { status: 'sent', channelId: channel.id };
}

/**
 * Edits the existing trusted list post to match the current config.
 * A new post is only sent with `allowSend` (the /publish-board command); startup and trust changes never post.
 * Calls run one after another so quick trust/untrust changes never produce two posts.
 * Returns { status, channelId } where status is 'sent', 'updated' or 'missing'; throws on failure.
 */
export function publishTrustedBoard(client, { allowSend = false } = {}) {
  const run = queue.then(async () => {
    const result = await publish(client, allowSend);
    // The other servers' boards are posted once and then kept up to date (startup and the /publish-board command).
    for (const channelId of Object.values(GUILD_TRUSTED_CHANNELS)) {
      await publish(client, true, channelId).catch((error) => logger.warn(`Trusted board in ${channelId}: ${error.message}`));
    }
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

/** Refreshes the board after a trust change in `guildId`; failures are logged, never thrown. */
export async function refreshTrustedBoard(client, guildId) {
  const channelId = trustedBoardChannelFor(guildId);
  const channel = client.channels.cache.get(channelId);
  if (channel?.guild && channel.guild.id !== guildId) return;
  const run = queue.then(() => publish(client, channelId !== TRUSTED_BOARD_CHANNEL_ID, channelId));
  queue = run.catch(() => {});
  await run.catch((error) => logger.error('Failed to refresh trusted board:', error));
}
