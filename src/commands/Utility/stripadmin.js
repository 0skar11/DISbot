import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { isServerOwner } from '../../config/serverOwners.js';
import { demoteAdministratorsBelowAdmin } from '../../services/staffRoleHierarchyService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stripadmin')
    .setDescription('Owner only: keep Administrator for top 3 roles only, remove from lower roles (Report #302)')
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

    const result = await demoteAdministratorsBelowAdmin(interaction.guild, { force: true });
    const changed = result.changed?.length ? result.changed.join(', ') : 'لا يوجد';
    const failed = result.failed?.length ? `\n⚠️ تعذر تعديل: ${result.failed.join(', ')}` : '';
    const content = `✅ تم الإبقاء على صلاحية Administrator للرتب حتى سايكو (أو أول 3 رتب)، وإزالتها من الرتب الأقل مع تفعيل كافة الصلاحيات الأخرى:\n• الرتب المعدلة: ${changed}${failed}`;

    if (interaction.deferred) {
      return interaction.editReply({ content });
    }
    return interaction.reply({ content, ephemeral: true });
  },
};
