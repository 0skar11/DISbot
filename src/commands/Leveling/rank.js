import { SlashCommandBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getUserLevelData, getLevelingConfig, getXpForLevel, getLeaderboard } from '../../services/leveling/leveling.js';
import { buildRankEmbed } from '../../services/leveling/levelUi.js';
import { getChatCounts } from '../../services/leveling/chatCounter.js';
import { getVoiceMinutes } from '../../services/leveling/voiceXp.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';

// `rank` / `لفل` / `لفل @member`: a member's level, place on the server, messages, voice time and progress to the next level.
export default {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription("Check your or another user's rank and level")
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('The user to check the rank of')
        .setRequired(false)
    )
    .setDMPermission(false),
  category: 'Leveling',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const levelingConfig = await getLevelingConfig(client, interaction.guildId);
    if (!levelingConfig?.enabled) {
      await InteractionHelper.safeEditReply(interaction, { content: '⚠️ نظام اللفلات مقفول في السيرفر ده.' });
      return;
    }

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      throw new TitanBotError(
        `User ${targetUser.id} not found in guild`,
        ErrorTypes.USER_INPUT,
        'Could not find the specified user in this server.'
      );
    }

    // The four reads don't depend on each other, so they go to the database together instead of one by one.
    const [userData, everyone, chatCounts, voiceMinutes] = await Promise.all([
      getUserLevelData(client, interaction.guildId, targetUser.id),
      Promise.resolve().then(() => getLeaderboard(client, interaction.guildId, 100)).catch(() => []),
      Promise.resolve().then(() => getChatCounts(client, interaction.guildId)).catch(() => ({})),
      Promise.resolve().then(() => getVoiceMinutes(client, interaction.guildId)).catch(() => ({})),
    ]);
    const level = userData?.level ?? 0;
    const entry = everyone.find((item) => item.userId === targetUser.id);

    const embed = buildRankEmbed(member, {
      level,
      xp: userData?.xp ?? 0,
      totalXp: userData?.totalXp ?? 0,
      // The XP system levels up at getXpForLevel(level), so that's what the bar fills towards.
      xpNeeded: getXpForLevel(level),
      position: entry?.rank ?? null,
      rankedCount: everyone.length,
      messages: chatCounts?.[targetUser.id] || 0,
      voiceMinutes: voiceMinutes?.[targetUser.id] || 0,
    });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
    logger.debug(`Rank checked for user ${targetUser.id} in guild ${interaction.guildId}`);
  }
};
