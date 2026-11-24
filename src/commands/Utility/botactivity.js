import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { getBotActivityStats, guildActivityStats, postActivitySummary } from '../../services/botUpdatesRoom.js';
import { REPLIED_USERS_DB_KEY } from '../../services/birthdayGreetingService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('bot-activity')
    .setDescription('Owner/Admin: view bot activity stats and optionally post an update card to #bot-updates')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addBooleanOption((option) =>
      option
        .setName('post_card')
        .setDescription('Post the activity summary card into the #bot-updates channel')
        .setRequired(false),
    ),

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

    const postCard = interaction.options.getBoolean('post_card') || false;
    const stats = await getBotActivityStats(interaction.client);
    const here = guildActivityStats(stats, interaction.guildId);
    const repliedList = (await interaction.client.db?.get?.(REPLIED_USERS_DB_KEY, [])?.catch?.(() => [])) || [];
    const repliedCount = Array.isArray(repliedList) ? repliedList.length : 0;

    const totalDms = Math.max(stats.dmsSent || 0, repliedCount);
    const birthdayDms = Math.max(stats.birthdayDmsSent || 0, repliedCount);

    if (postCard) {
      await postActivitySummary(interaction.client, interaction.guild).catch(() => {});
    }

    const content = [
      '📊 **إحصائيات نشاط وعمليات البوت الحالية:**',
      `• 📬 إجمالي رسائل الخاص (DMs): **${totalDms}**`,
      `• 🎂 رسائل التهنئة بعيد الميلاد المستلمة: **${birthdayDms}**`,
      `• ⚙️ الأوامر المنفذة: **${stats.commandsExecuted || 0}**`,
      `• 🛡️ الإجراءات والعمليات المنفذة: **${stats.actionsPerformed || 0}**`,
      `• 🏠 في السيرفر ده: **${here.commandsExecuted}** أمر، **${here.actionsPerformed}** إجراء، **${here.dmsSent}** رسالة خاص`,
      postCard ? '✅ تم نشر كارت التحديث في روم **#bot-updates** بنجاح.' : '💡 يمكنك تمرير `post_card: True` لنشر الكارت في روم **#bot-updates**.',
    ].join('\n');

    if (interaction.deferred) {
      return interaction.editReply({ content });
    }
    return interaction.reply({ content, ephemeral: true });
  },
};
