import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { reconcileDeletedBirthdayGreetings } from '../../services/birthdayGreetingService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('reply-birthday')
    .setDescription('Owner only: send DM replies to members whose birthday messages were deleted')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.inGuild?.()) {
      return interaction.reply({ content: '❌ الأمر ده داخل السيرفر بس.', ephemeral: true });
    }
    if (!isServerOwner(interaction.user.id) && interaction.guild?.ownerId !== interaction.user.id) {
      return interaction.reply({ content: '❌ الأمر ده للأونر بس.', ephemeral: true });
    }

    if (typeof interaction.deferReply === 'function' && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
    }

    // A manual run reports failed DMs to #bot-updates too (the startup run only reports sent ones).
    const stats = await reconcileDeletedBirthdayGreetings(interaction.client, { reportFailures: true });
    const sentList = stats.users?.length
      ? `\n• الأعضاء اللي تم إرسال الرد لهم الآن:\n${stats.users.map((u) => `- <@${u.id}> (${u.tag})`).join('\n')}`
      : '';
    const logged = stats.sent + stats.failed > 0 ? `\n• اتسجل في روم **#bot-updates** (وصلت ${stats.sent}، فشلت ${stats.failed}).` : '';
    const content = `✅ **تم فحص سجل الرسائل المحذوفة بنجاح:**\n• رسايل جديدة أُرسلت الآن: **${stats.sent}**\n• إجمالي الأعضاء الذين وصلتهم الرسالة: **${stats.totalReplied ?? stats.sent}**${logged}${sentList}`;

    if (interaction.deferred) {
      return interaction.editReply({ content });
    }
    return interaction.reply({ content, ephemeral: true });
  },
};
