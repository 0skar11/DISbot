import { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { geminiApiKey, geminiModel } from '../../config/geminiRoom.js';
import { getGeminiRoom, setGeminiRoom } from '../../services/gemini/geminiRoomService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';

// `/gemini-room` (owners only, every server): set, turn off or show this server's Gemini room
// (docs/gemini-room.md). It only ever changes the server it is used in. The API key is never shown.

function keyLine() {
  return geminiApiKey() ? `🔑 المفتاح متسجل، والموديل \`${geminiModel()}\`.` : '⚠️ GEMINI_API_KEY مش متسجل، فالروم مقفولة لحد ما يتحط.';
}

export default {
  data: new SlashCommandBuilder()
    .setName('gemini-room')
    .setDescription('Owner only: the Gemini chat room of this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('set')
      .setDescription('Make a channel the Gemini room of this server')
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('The room (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)))
    .addSubcommand((sub) => sub.setName('off').setDescription('Turn the Gemini room off in this server'))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the Gemini room of this server')),
  slashOnly: true,

  async execute(interaction) {
    const reply = (content) => InteractionHelper.safeReply(interaction, { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.guild) return reply('❌ الأمر ده جوه السيرفر بس.');
    if (!isServerOwner(interaction.user?.id)) return reply('❌ الأمر ده للأونر بس.');

    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'set') {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) return reply('❌ اختار روم كتابة.');
        await setGeminiRoom(interaction.client, guildId, channel.id);
        return reply(`✅ روم Gemini في السيرفر ده بقت <#${channel.id}>.\n${keyLine()}`);
      }
      if (sub === 'off') {
        await setGeminiRoom(interaction.client, guildId, null);
        return reply('✅ قفلت روم Gemini في السيرفر ده.');
      }
      const room = await getGeminiRoom(interaction.client, guildId);
      return reply(`${room.channelId ? `🤖 روم Gemini في السيرفر ده: <#${room.channelId}>.` : '🤖 مفيش روم Gemini في السيرفر ده.'}\n${keyLine()}`);
    } catch (error) {
      logger.error(`gemini-room ${sub} failed: ${error?.message}`);
      return reply('❌ حصلت مشكلة، جرب تاني.');
    }
  },
};
