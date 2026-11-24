// `/publish-board role-boards` (GH #326): an owner posts or refreshes the emoji role boards of
// src/config/roleBoards.js in a channel. Owner-only, works in every server; nothing is posted without it.
import { ChannelType, MessageFlags } from 'discord.js';
import { isServerOwner } from '../../../config/serverOwners.js';
import { ROLE_BOARDS } from '../../../config/roleBoards.js';
import {
  publishRoleBoard,
  parseBoardMessageEntries,
  parseMessageReference,
  SKIP_REASONS,
} from '../../../services/roleBoardService.js';

const MAX_SKIPPED_LINES = 12;

export function addRoleBoardsSubcommand(sub) {
  return sub
    .setName('role-boards')
    .setDescription('Owner: post or refresh the emoji role boards (games, friends)')
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Channel for the boards')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('board')
      .setDescription('Which board (default: all)')
      .addChoices({ name: 'all', value: 'all' }, ...ROLE_BOARDS.map((board) => ({ name: board.key, value: board.key }))))
    .addStringOption((option) => option
      .setName('games_from')
      .setDescription('Link of the current games board: keep its roles and emojis (deleted roles are dropped)'));
}

/** Reads the emoji/role pairs of an existing board message in this server. Throws with an Arabic message. */
export async function readBoardToCopy(guild, reference, fallbackChannel) {
  const ref = parseMessageReference(reference);
  if (!ref) throw new Error('لينك رسالة البورد القديمة مش مظبوط.');
  if (ref.guildId && ref.guildId !== guild.id) throw new Error('البورد القديمة لازم تكون في نفس السيرفر.');

  const channel = ref.channelId
    ? guild.channels.cache.get(ref.channelId) || await guild.channels.fetch(ref.channelId).catch(() => null)
    : fallbackChannel;
  if (!channel?.messages?.fetch) throw new Error('مش لاقي روم البورد القديمة.');
  const message = await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!message) throw new Error('مش لاقي رسالة البورد القديمة.');

  const entries = parseBoardMessageEntries(message);
  if (!entries.length) throw new Error('مش لاقي رولات بإيموجي في البورد القديمة.');
  return entries;
}

const normalizeName = (name) => String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const SPARE_EMOJIS = ['🎲', '🕹️', '🏆', '🎳', '🧩', '🏁', '🎮', '🎰', '🛡️', '🚗'];

/**
 * A copied board may use custom emojis from a server the bot is not in, which the bot cannot react with.
 * Those get an emoji it can use: the default one of the same-named role in the config, else a spare one.
 */
export function withUsableEmojis(client, guild, entries, board = ROLE_BOARDS.find((item) => item.key === 'games')) {
  const visible = (emoji) => {
    const id = String(emoji ?? '').match(/^<a?:\w+:(\d+)>$/u)?.[1];
    return !id || Boolean(client?.emojis?.cache?.has?.(id));
  };
  const used = new Set(entries.filter((entry) => visible(entry.emoji)).map((entry) => entry.emoji));
  const spare = SPARE_EMOJIS.filter((emoji) => !used.has(emoji));
  return entries.map((entry) => {
    if (visible(entry.emoji)) return entry;
    const roleName = normalizeName(guild?.roles?.cache?.get(entry.roleId)?.name);
    const preset = board?.roles?.find((role) => role.name && normalizeName(role.name) === roleName
      || (roleName && role.name && roleName.includes(normalizeName(role.name))));
    let emoji = preset?.emoji && !used.has(preset.emoji) ? preset.emoji : spare.shift();
    if (!emoji) return entry;
    used.add(emoji);
    return { ...entry, emoji };
  });
}

function describeResult(board, result) {
  const count = `${result.entries.length} رول`;
  const head = {
    sent: `✅ **${board.title}**: اتبعتت في <#${result.channelId}> (${count})${result.url ? ` — ${result.url}` : ''}`,
    updated: `✅ **${board.title}**: اتحدّثت في <#${result.channelId}> (${count})`,
  }[result.status] || `⚠️ **${board.title}**: متبعتتش، مفيش ولا رول ينفع يتحط.`;

  const skipped = result.skipped.slice(0, MAX_SKIPPED_LINES).map(({ label, reason }) => `  • ${label}: ${SKIP_REASONS[reason] || reason}`);
  if (result.skipped.length > MAX_SKIPPED_LINES) skipped.push(`  • و ${result.skipped.length - MAX_SKIPPED_LINES} كمان`);
  return [head, ...(skipped.length ? ['  اتشالوا:', ...skipped] : [])].join('\n');
}

export async function executeRoleBoards(interaction) {
  if (!isServerOwner(interaction.user.id)) {
    return interaction.reply({ content: '❌ الأمر ده للأونر بس.', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.options.getChannel('channel', true);
  const which = interaction.options.getString('board') || 'all';
  const gamesFrom = interaction.options.getString('games_from');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!channel?.guild || channel.guild.id !== interaction.guild?.id) {
      throw new Error('الروم لازم تكون في السيرفر ده.');
    }
    const boards = which === 'all' ? ROLE_BOARDS : ROLE_BOARDS.filter((board) => board.key === which);
    const copied = gamesFrom && boards.some((board) => board.key === 'games')
      ? await readBoardToCopy(interaction.guild, gamesFrom, channel)
      : null;

    const lines = [];
    for (const board of boards) {
      const entries = board.key === 'games' && copied ? withUsableEmojis(interaction.client, interaction.guild, copied, board) : board.roles;
      if (!entries?.length) {
        lines.push(`ℹ️ **${board.title}**: لسه مفيش رولات متحطة ليها (src/config/roleBoards.js)، فمتبعتتش.`);
        continue;
      }
      try {
        const result = await publishRoleBoard(interaction.client, { channel, board, entries, actorId: interaction.user.id });
        lines.push(describeResult(board, result));
      } catch (error) {
        if (error.missingPermissions) throw error; // same for every board: one clear message
        lines.push(`❌ **${board.title}**: فشل: ${error.message}`);
      }
    }
    return interaction.editReply({ content: lines.join('\n').slice(0, 2000) || 'ℹ️ مفيش بوردات.' });
  } catch (error) {
    const content = error.missingPermissions
      ? `❌ البوت محتاج الصلاحيات دي في <#${channel?.id}>: ${error.missingPermissions.join(', ')}`
      : `❌ فشل: ${error.message}`;
    return interaction.editReply({ content: content.slice(0, 2000) });
  }
}
